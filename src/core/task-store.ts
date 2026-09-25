import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  Attempt,
  CheckResult,
  HandoffRecord,
  HandoffV1,
  ReviewResult,
  RouteDecision,
  StageRecord,
  StageRole,
  StageStatus,
  TaskEvent,
  TaskRecord,
  TaskStatus,
  TaskSubmission,
} from "../domain/types.js";
import { HANDOFF_V1_MAX_BYTES, parseHandoffV1 } from "../domain/handoff.js";

type Json = string | null;
type TaskRow = {
  id: string; status: TaskStatus; created_at: string; updated_at: string;
  payload: string; revision_count: number; lease_owner: string | null;
  lease_expires_at: string | null; heartbeat_at: string | null;
  failure_reason: string | null; active_attempt_id: string | null;
  retry_at?: string | null;
  recovery_reason?: string | null; recovery_evidence?: string | null;
  lease_protocol_version?: number | null;
  claim_generation_id?: string | null;
};
type StageRow = Record<string, unknown>;
type HandoffRow = { id: string; task_id: string; stage_id: string; attempt_id: string; schema_version: number; created_at: string; payload: string; payload_bytes: number };

export interface WorktreeCreationRecord {
  taskId: string;
  leaseOwner: string;
  status: "intent" | "created";
  plan: unknown;
  intentAt: string;
  observed?: unknown;
  fingerprint?: string;
  createdAt?: string;
}

export interface StartupGenerationAttestation {
  id: string;
  lockId?: string;
  predecessorDrained: boolean;
  evidenceKind: "guardian_startup_verified" | "guardian_startup_unverified" | "guardian_env_assertion" | "unguarded" | "rejected_lock_id" | "invalid_attestation";
}

export interface StartupGenerationRecord extends StartupGenerationAttestation {
  sequence: number;
  startedAt: string;
  predecessorGenerationId?: string;
}

export interface CheckRunSnapshot {
  baseCommit: string;
  preHead: string;
  treeId: string;
  fingerprint: string;
  diffHash: string;
  diff: string;
}

export interface CheckRunRecord {
  id: string;
  taskId: string;
  generationId: string;
  owner: string;
  executionAttemptId: string;
  executionStageId: string;
  routeAttemptId: string;
  route: RouteDecision;
  branchRef: string;
  snapshot: CheckRunSnapshot;
  checkDefinitionHash: string;
  expectedCheckIds: string[];
  status: "running" | "completed" | "failed" | "abandoned";
  createdAt: string;
  completedAt?: string;
  terminalReason?: string;
}

export interface ReviewPackageRecord {
  id: string;
  taskId: string;
  checkRunId: string;
  executionAttemptId: string;
  executionStageId: string;
  routeAttemptId: string;
  route: RouteDecision;
  branchRef: string;
  snapshot: CheckRunSnapshot;
  checkDefinitionHash: string;
  expectedCheckIds: string[];
  createdAt: string;
}

export interface StartCheckRunInput {
  taskId: string;
  owner: string;
  generationId: string;
  executionAttemptId: string;
  executionStageId: string;
  routeAttemptId: string;
  route: RouteDecision;
  branchRef: string;
  snapshot: CheckRunSnapshot;
  checkDefinitionHash: string;
  expectedCheckIds: string[];
}

export interface CheckRunGuard { owner: string; generationId: string; }

const MAX_REVIEW_DIFF_BYTES = 64 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const encode = (v: unknown): Json => v === undefined ? null : JSON.stringify(v);
const decode = <T>(v: string | null): T | undefined => v === null ? undefined : JSON.parse(v) as T;
const sameStringSet = (left: string[], right: string[]): boolean => left.length === right.length && new Set(left).size === left.length &&
  new Set(right).size === right.length && left.every(value => right.includes(value));
const sameSnapshot = (left: CheckRunSnapshot, right: CheckRunSnapshot): boolean =>
  left.baseCommit === right.baseCommit && left.preHead === right.preHead && left.treeId === right.treeId &&
  left.fingerprint === right.fingerprint && left.diffHash === right.diffHash && left.diff === right.diff;

/** @internal Set and verify the durability pragmas before a persistent store performs any writes. */
export function configureTaskStorePragmas(db: DatabaseSync, path: string): void {
  db.exec("PRAGMA busy_timeout = 5000;");
  if (path !== ":memory:") {
    const journalMode = db.prepare("PRAGMA journal_mode = WAL;").get() as { journal_mode?: unknown } | undefined;
    if (typeof journalMode?.journal_mode !== "string" || journalMode.journal_mode.toLowerCase() !== "wal") {
      throw new Error("SQLite failed to enable WAL mode for the persistent task store");
    }
    db.exec("PRAGMA synchronous = FULL;");
    const synchronous = db.prepare("PRAGMA synchronous;").get() as { synchronous?: unknown } | undefined;
    if (Number(synchronous?.synchronous) !== 2) {
      throw new Error("SQLite failed to enable FULL synchronous mode for the persistent task store");
    }
  }
  db.exec("PRAGMA foreign_keys = ON;");
}

/** SQLite-backed source of truth. Methods are synchronous and each state change is transactional. */
export class TaskStore {
  readonly #db: DatabaseSync;
  readonly #startupGeneration: StartupGenerationRecord;

  constructor(path = ":memory:", startupAttestation?: StartupGenerationAttestation) {
    this.#db = new DatabaseSync(path);
    configureTaskStorePragmas(this.#db, path);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        payload TEXT NOT NULL, revision_count INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT, lease_expires_at TEXT, heartbeat_at TEXT,
        failure_reason TEXT, active_attempt_id TEXT,
        recovery_reason TEXT, recovery_evidence TEXT, lease_protocol_version INTEGER,
        claim_generation_id TEXT REFERENCES startup_generations(id)
      );
      CREATE TABLE IF NOT EXISTS startup_generations (
        id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, lock_id TEXT, predecessor_drained INTEGER NOT NULL CHECK(predecessor_drained IN (0,1)),
        member_verified INTEGER NOT NULL DEFAULT 0 CHECK(member_verified IN (0,1)), evidence_kind TEXT NOT NULL,
        predecessor_generation_id TEXT REFERENCES startup_generations(id), started_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_status_created ON tasks(status, created_at);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
        type TEXT NOT NULL, at TEXT NOT NULL, payload TEXT
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), sequence INTEGER NOT NULL,
        role TEXT NOT NULL, status TEXT NOT NULL, harness TEXT, model TEXT, reasoning_effort TEXT,
        started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER, stdout_path TEXT,
        stderr_path TEXT, result_path TEXT, error TEXT, metadata TEXT,
        UNIQUE(task_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS stages (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), sequence INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('implement','revise','review','route')),
        status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','interrupted')),
        predecessor_stage_id TEXT REFERENCES stages(id), harness TEXT, harness_version TEXT, model TEXT, reasoning_effort TEXT,
        binding_version TEXT, config_hash TEXT, process_start_id TEXT NOT NULL, generation_id TEXT REFERENCES startup_generations(id),
        input_fingerprint TEXT, output_fingerprint TEXT, error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        UNIQUE(task_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS handoffs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), stage_id TEXT NOT NULL REFERENCES stages(id),
        attempt_id TEXT NOT NULL REFERENCES attempts(id), schema_version INTEGER NOT NULL CHECK(schema_version = 1),
        created_at TEXT NOT NULL, payload TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0 AND payload_bytes <= 65536),
        UNIQUE(stage_id, attempt_id)
      );
      CREATE INDEX IF NOT EXISTS stages_task_sequence ON stages(task_id, sequence);
      CREATE INDEX IF NOT EXISTS handoffs_task_created ON handoffs(task_id, created_at, id);
      CREATE TABLE IF NOT EXISTS routes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
        decided_at TEXT NOT NULL, decision TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
        attempt_id TEXT, check_id TEXT NOT NULL, at TEXT NOT NULL, result TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS check_runs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), generation_id TEXT NOT NULL,
        owner TEXT NOT NULL, execution_attempt_id TEXT NOT NULL REFERENCES attempts(id),
        execution_stage_id TEXT NOT NULL REFERENCES stages(id), route_attempt_id TEXT NOT NULL REFERENCES attempts(id),
        route TEXT NOT NULL, branch_ref TEXT NOT NULL, snapshot TEXT NOT NULL,
        check_definition_hash TEXT NOT NULL, expected_check_ids TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','completed','failed','abandoned')),
        created_at TEXT NOT NULL, completed_at TEXT, terminal_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS check_runs_task_created ON check_runs(task_id, created_at, id);
      CREATE TABLE IF NOT EXISTS check_run_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES check_runs(id),
        check_id TEXT NOT NULL, at TEXT NOT NULL, result TEXT NOT NULL, UNIQUE(run_id, check_id)
      );
      CREATE TABLE IF NOT EXISTS review_packages (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), check_run_id TEXT NOT NULL UNIQUE REFERENCES check_runs(id),
        execution_attempt_id TEXT NOT NULL REFERENCES attempts(id), execution_stage_id TEXT NOT NULL REFERENCES stages(id),
        route_attempt_id TEXT NOT NULL REFERENCES attempts(id), route TEXT NOT NULL, branch_ref TEXT NOT NULL,
        snapshot TEXT NOT NULL, check_definition_hash TEXT NOT NULL, expected_check_ids TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS review_packages_task_created ON review_packages(task_id, created_at, id);
      CREATE TRIGGER IF NOT EXISTS review_packages_no_update BEFORE UPDATE ON review_packages BEGIN SELECT RAISE(ABORT,'review packages are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS review_packages_no_delete BEFORE DELETE ON review_packages BEGIN SELECT RAISE(ABORT,'review packages are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS check_run_results_no_update BEFORE UPDATE ON check_run_results BEGIN SELECT RAISE(ABORT,'check results are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS check_run_results_no_delete BEFORE DELETE ON check_run_results BEGIN SELECT RAISE(ABORT,'check results are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS check_run_results_only_while_running BEFORE INSERT ON check_run_results
        WHEN (SELECT status FROM check_runs WHERE id=NEW.run_id)!='running'
        BEGIN SELECT RAISE(ABORT,'check run is not running'); END;
      CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
        attempt_id TEXT, at TEXT NOT NULL, result TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quota_pauses (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id), retry_at TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0, checkpoint TEXT NOT NULL, reason TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'fallback'
      );
      CREATE TABLE IF NOT EXISTS worktree_creations (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id), lease_owner TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('intent','created')), plan TEXT NOT NULL,
        intent_at TEXT NOT NULL, observed TEXT, fingerprint TEXT, created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS execution_recovery_checkpoints (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id), status TEXT NOT NULL
          CHECK(status IN ('claimed','quarantined','inspection_required','disabled','superseded')),
        payload TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    // Additive, idempotent migration: old attempts remain valid with a NULL stage_id.
    // Existing databases are not rebuilt or rewritten.
    const attemptColumns = this.#db.prepare("PRAGMA table_info(attempts)").all() as Array<{ name: string }>;
    if (!attemptColumns.some(column => column.name === "stage_id")) {
      this.#db.exec("ALTER TABLE attempts ADD COLUMN stage_id TEXT REFERENCES stages(id)");
    }
    const stageColumns = this.#db.prepare("PRAGMA table_info(stages)").all() as Array<{ name: string }>;
    if (!stageColumns.some(column => column.name === "error")) {
      this.#db.exec("ALTER TABLE stages ADD COLUMN error TEXT");
    }
    const taskColumns = this.#db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!taskColumns.some(column => column.name === "recovery_reason")) this.#db.exec("ALTER TABLE tasks ADD COLUMN recovery_reason TEXT");
    if (!taskColumns.some(column => column.name === "recovery_evidence")) this.#db.exec("ALTER TABLE tasks ADD COLUMN recovery_evidence TEXT");
    if (!taskColumns.some(column => column.name === "lease_protocol_version")) this.#db.exec("ALTER TABLE tasks ADD COLUMN lease_protocol_version INTEGER");
    if (!taskColumns.some(column => column.name === "claim_generation_id")) this.#db.exec("ALTER TABLE tasks ADD COLUMN claim_generation_id TEXT REFERENCES startup_generations(id)");
    const stageColumnsAfterMigration = this.#db.prepare("PRAGMA table_info(stages)").all() as Array<{ name: string }>;
    if (!stageColumnsAfterMigration.some(column => column.name === "generation_id")) this.#db.exec("ALTER TABLE stages ADD COLUMN generation_id TEXT REFERENCES startup_generations(id)");
    const generationColumns = this.#db.prepare("PRAGMA table_info(startup_generations)").all() as Array<{ name: string }>;
    if (!generationColumns.some(column => column.name === "sequence")) {
      this.#db.exec("ALTER TABLE startup_generations ADD COLUMN sequence INTEGER");
      this.#db.exec("UPDATE startup_generations SET sequence=rowid WHERE sequence IS NULL");
      this.#db.exec("CREATE UNIQUE INDEX IF NOT EXISTS startup_generations_sequence ON startup_generations(sequence)");
    }
    const currentGenerationColumns = this.#db.prepare("PRAGMA table_info(startup_generations)").all() as Array<{ name: string }>;
    if (!currentGenerationColumns.some(column => column.name === "member_verified")) {
      this.#db.exec("ALTER TABLE startup_generations ADD COLUMN member_verified INTEGER NOT NULL DEFAULT 0 CHECK(member_verified IN (0,1))");
    }
    this.#db.exec("CREATE INDEX IF NOT EXISTS attempts_stage_sequence ON attempts(stage_id, sequence)");
    const attestation = startupAttestation ?? { id: randomUUID(), predecessorDrained: false, evidenceKind: "unguarded" as const };
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(attestation.id) || typeof attestation.predecessorDrained !== "boolean" ||
        !["guardian_startup_verified", "guardian_startup_unverified", "guardian_env_assertion", "unguarded", "rejected_lock_id", "invalid_attestation"].includes(attestation.evidenceKind) ||
        (attestation.lockId !== undefined && !/^[a-f0-9]{64}$/.test(attestation.lockId))) {
      throw new Error("Invalid startup generation attestation");
    }
    if (attestation.predecessorDrained && (attestation.evidenceKind !== "guardian_startup_verified" || !/^[a-f0-9]{32}$/.test(attestation.id) || !/^[a-f0-9]{64}$/.test(attestation.lockId ?? ""))) {
      throw new Error("A drained predecessor requires a guardian startup proof, generation, and matching lock ID");
    }
    if (attestation.evidenceKind === "guardian_startup_verified" && (!attestation.predecessorDrained ||
        !/^[a-f0-9]{32}$/.test(attestation.id) || !/^[a-f0-9]{64}$/.test(attestation.lockId ?? ""))) {
      throw new Error("Guardian startup proofs require generation, lock, and a drained predecessor");
    }
    const startedAt = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const sequence = Number((this.#db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM startup_generations").get() as { n: number }).n);
      const previous = this.#db.prepare(`SELECT id,lock_id,evidence_kind FROM startup_generations
        ORDER BY sequence DESC LIMIT 1`).get() as { id: string; lock_id: string | null; evidence_kind: string } | undefined;
      const currentIsGuardianVerified = attestation.predecessorDrained === true &&
        attestation.evidenceKind === "guardian_startup_verified" && /^[a-f0-9]{64}$/.test(attestation.lockId ?? "");
      const predecessorGenerationId = currentIsGuardianVerified && previous &&
        previous.evidence_kind === "guardian_startup_verified" && previous.lock_id === attestation.lockId
        ? previous.id
        : undefined;
      this.#db.prepare(`INSERT INTO startup_generations(id,sequence,lock_id,predecessor_drained,member_verified,evidence_kind,predecessor_generation_id,started_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(attestation.id, sequence, attestation.lockId ?? null,
        attestation.predecessorDrained ? 1 : 0, 0, attestation.evidenceKind, predecessorGenerationId ?? null, startedAt);
      this.#db.exec("COMMIT");
      this.#startupGeneration = { ...attestation, sequence, predecessorGenerationId, startedAt };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  startupGeneration(): StartupGenerationRecord { return { ...this.#startupGeneration }; }

  /**
   * Returns true only when this startup's persisted guardian proof directly names the requested
   * generation as its predecessor. This is a SQLite lineage check, not protection from same-account edits.
   */
  currentStartupProvesGenerationDrained(generationId: string): boolean {
    if (!generationId) return false;
    const row = this.#db.prepare(`SELECT current.predecessor_drained AS current_predecessor_drained,
        current.evidence_kind AS current_evidence_kind,
        current.lock_id AS current_lock_id,
        current.predecessor_generation_id AS predecessor_generation_id,
        previous.id AS previous_id, previous.evidence_kind AS previous_evidence_kind, previous.lock_id AS previous_lock_id
      FROM startup_generations AS current
      LEFT JOIN startup_generations AS previous ON previous.id = current.predecessor_generation_id
      WHERE current.id = ?`).get(this.#startupGeneration.id) as {
        current_predecessor_drained: number; current_evidence_kind: string;
        current_lock_id: string | null; predecessor_generation_id: string | null; previous_id: string | null;
        previous_evidence_kind: string | null; previous_lock_id: string | null;
      } | undefined;
    return Boolean(row && row.current_predecessor_drained === 1 &&
      row.current_evidence_kind === "guardian_startup_verified" && row.current_lock_id &&
      row.predecessor_generation_id === generationId && row.previous_id === generationId &&
      row.previous_evidence_kind === "guardian_startup_verified" &&
      row.previous_lock_id === row.current_lock_id);
  }

  close(): void { this.#db.close(); }

  #transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.#db.exec("COMMIT"); return result; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  #stageTaskStatus(role: StageRole): TaskStatus {
    return role === "review" ? "reviewing" : "running";
  }

  #hasLiveStageLease(task: { status: TaskStatus; lease_owner: string | null; lease_expires_at: string | null }, owner: string, role: StageRole): boolean {
    const expiresAt = task.lease_expires_at ? Date.parse(task.lease_expires_at) : Number.NaN;
    return task.status === this.#stageTaskStatus(role) && task.lease_owner === owner && Number.isFinite(expiresAt) && expiresAt > Date.now();
  }

  #hasLiveTaskLease(task: { status: TaskStatus; lease_owner: string | null; lease_expires_at: string | null }, owner: string): boolean {
    const expiresAt = task.lease_expires_at ? Date.parse(task.lease_expires_at) : Number.NaN;
    return task.status === "running" && task.lease_owner === owner && Number.isFinite(expiresAt) && expiresAt > Date.now();
  }

  submit(submission: TaskSubmission, id: string = randomUUID()): TaskRecord {
    if (submission.executionStages !== undefined) {
      if (!Array.isArray(submission.executionStages) || submission.executionStages.length === 0 || submission.executionStages.length > 16) {
        throw new Error("executionStages must contain 1 to 16 execution stages");
      }
      for (const [index, stage] of submission.executionStages.entries()) {
        if (!stage || typeof stage !== "object" || Array.isArray(stage)) throw new Error(`executionStages[${index}] must be an object`);
        for (const [field, value] of Object.entries(stage)) {
          if (!["harness", "model", "reasoningEffort"].includes(field) || typeof value !== "string" || !value.trim() || value !== value.trim()) {
            throw new Error(`executionStages[${index}].${field} must be a non-empty supported selection field`);
          }
        }
      }
    }
    const now = new Date().toISOString();
    this.#transaction(() => {
      this.#db.prepare(`INSERT INTO tasks(id,status,created_at,updated_at,payload) VALUES(?, 'pending', ?, ?, ?)`)
        .run(id, now, now, JSON.stringify(submission));
      this.#event(id, "task.submitted", { submission }, now);
    });
    return this.get(id)!;
  }

  get(id: string): TaskRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as TaskRow | undefined;
    return row ? this.#task(row) : undefined;
  }

  list(status?: TaskStatus): TaskRecord[] {
    const rows = (status
      ? this.#db.prepare("SELECT * FROM tasks WHERE status=? ORDER BY created_at, id").all(status)
      : this.#db.prepare("SELECT * FROM tasks ORDER BY created_at, id").all()) as TaskRow[];
    return rows.map(row => this.#task(row));
  }

  /** Atomically leases the oldest pending task. Multiple workers may safely race this call. */
  claimNext(owner: string, leaseMs = 60_000, now = new Date()): TaskRecord | undefined {
    if (!owner || leaseMs <= 0) throw new Error("owner and positive leaseMs are required");
    const at = now.toISOString();
    const expires = new Date(now.getTime() + leaseMs).toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare(`SELECT id FROM tasks WHERE status='pending' OR (status='waiting' AND id IN
        (SELECT task_id FROM quota_pauses WHERE retry_at<=?)) ORDER BY created_at, id LIMIT 1`).get(at) as { id: string } | undefined;
      if (!row) { this.#db.exec("COMMIT"); return undefined; }
      const result = this.#db.prepare(`UPDATE tasks SET status='running', updated_at=?, lease_owner=?, lease_expires_at=?, heartbeat_at=?, lease_protocol_version=2, claim_generation_id=?
        WHERE id=? AND status IN ('pending','waiting')`).run(at, owner, expires, at, this.#startupGeneration.id, row.id);
      if (Number(result.changes) !== 1) { this.#db.exec("ROLLBACK"); return undefined; }
      this.#event(row.id, "task.claimed", { owner, leaseExpiresAt: expires, leaseProtocolVersion: 2, generationId: this.#startupGeneration.id }, at);
      this.#db.exec("COMMIT");
      return this.get(row.id);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  /** Store the exact planned Git identity before any worktree-creating Git command runs. */
  recordWorktreeCreationIntent(taskId: string, owner: string, plan: unknown): WorktreeCreationRecord {
    const at = new Date().toISOString();
    this.#transaction(() => {
      const task = this.#db.prepare("SELECT status,lease_owner,lease_expires_at FROM tasks WHERE id=?").get(taskId) as { status: TaskStatus; lease_owner: string | null; lease_expires_at: string | null } | undefined;
      if (!task || !this.#hasLiveTaskLease(task, owner)) throw new Error(`Task ${taskId} is not actively leased by ${owner}`);
      const existing = this.#db.prepare("SELECT task_id FROM worktree_creations WHERE task_id=?").get(taskId);
      if (existing) throw new Error(`Task ${taskId} already has a worktree creation record`);
      this.#db.prepare("INSERT INTO worktree_creations(task_id,lease_owner,status,plan,intent_at) VALUES(?,?,'intent',?,?)")
        .run(taskId, owner, encode(plan), at);
      this.#event(taskId, "worktree.creation_intent", { owner, plan }, at);
    });
    return this.getWorktreeCreation(taskId)!;
  }

  /** Persist observed identity only while the owner still holds the live task lease. */
  completeWorktreeCreation(taskId: string, owner: string, observed: unknown, fingerprint: string): WorktreeCreationRecord {
    if (!/^[a-f0-9]{64}$/i.test(fingerprint)) throw new Error("Invalid worktree creation fingerprint");
    const at = new Date().toISOString();
    this.#transaction(() => {
      const task = this.#db.prepare("SELECT status,lease_owner,lease_expires_at FROM tasks WHERE id=?").get(taskId) as { status: TaskStatus; lease_owner: string | null; lease_expires_at: string | null } | undefined;
      if (!task || !this.#hasLiveTaskLease(task, owner)) throw new Error(`Task ${taskId} is not actively leased by ${owner}`);
      const intent = this.#db.prepare("SELECT lease_owner,status FROM worktree_creations WHERE task_id=?").get(taskId) as { lease_owner: string; status: string } | undefined;
      if (!intent || intent.lease_owner !== owner || intent.status !== "intent") throw new Error(`Task ${taskId} has no pending creation intent for ${owner}`);
      const changed = this.#db.prepare("UPDATE worktree_creations SET status='created',observed=?,fingerprint=?,created_at=? WHERE task_id=? AND lease_owner=? AND status='intent'")
        .run(encode(observed), fingerprint, at, taskId, owner);
      if (Number(changed.changes) !== 1) throw new Error(`Task ${taskId} worktree creation intent changed before completion`);
      this.#event(taskId, "worktree.created", { owner, observed, fingerprint }, at);
    });
    return this.getWorktreeCreation(taskId)!;
  }

  /** Fail closed when a write after a creation intent has ambiguous external effects. */
  requireWorktreeRecovery(taskId: string, owner: string, reason: string, evidence?: unknown): TaskRecord {
    const at = new Date().toISOString();
    this.#transaction(() => {
      const task = this.#db.prepare("SELECT status,lease_owner,lease_expires_at FROM tasks WHERE id=?").get(taskId) as { status: TaskStatus; lease_owner: string | null; lease_expires_at: string | null } | undefined;
      if (!task || !this.#hasLiveTaskLease(task, owner)) throw new Error(`Task ${taskId} is not actively leased by ${owner}`);
      const intent = this.#db.prepare("SELECT lease_owner FROM worktree_creations WHERE task_id=?").get(taskId) as { lease_owner: string } | undefined;
      if (!intent || intent.lease_owner !== owner) throw new Error(`Task ${taskId} has no creation intent for ${owner}`);
      const recoveryEvidence = { kind: "worktree_creation", owner, reason, plan: this.getWorktreeCreation(taskId)?.plan, detail: evidence };
      const changed = this.#db.prepare(`UPDATE tasks SET status='recovery_required',updated_at=?,recovery_reason=?,recovery_evidence=?,
        lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=NULL WHERE id=? AND status='running' AND lease_owner=?`)
        .run(at, reason, encode(recoveryEvidence), taskId, owner);
      if (Number(changed.changes) !== 1) throw new Error(`Task ${taskId} could not enter recovery_required`);
      this.#event(taskId, "task.recovery_required", { reason, evidence: recoveryEvidence }, at);
    });
    return this.get(taskId)!;
  }

  getWorktreeCreation(taskId: string): WorktreeCreationRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM worktree_creations WHERE task_id=?").get(taskId) as {
      task_id: string; lease_owner: string; status: "intent" | "created"; plan: string; intent_at: string;
      observed: string | null; fingerprint: string | null; created_at: string | null;
    } | undefined;
    if (!row) return undefined;
    return { taskId: row.task_id, leaseOwner: row.lease_owner, status: row.status, plan: JSON.parse(row.plan), intentAt: row.intent_at,
      ...(row.observed === null ? {} : { observed: JSON.parse(row.observed) }), ...(row.fingerprint === null ? {} : { fingerprint: row.fingerprint }),
      ...(row.created_at === null ? {} : { createdAt: row.created_at }) };
  }

  transition(id: string, expected: TaskStatus | TaskStatus[], next: TaskStatus, options: {
    owner?: string; reason?: string; clearLease?: boolean; incrementRevision?: boolean;
  } = {}): TaskRecord {
    const expectedList = Array.isArray(expected) ? expected : [expected];
    if (!expectedList.length) throw new Error("expected state is required");
    const allowed: Record<TaskStatus, TaskStatus[]> = {
      pending: ["running", "failed"],
      waiting: ["running", "failed"],
      running: ["reviewing", "revision", "failed"],
      reviewing: ["done", "revision", "failed"],
      revision: ["running", "failed"],
      recovery_required: [],
      done: [], failed: [],
    };
    if (expectedList.some(source => !allowed[source].includes(next))) {
      throw new Error(`Illegal task state transition ${expectedList.join("|")} -> ${next}`);
    }
    const at = new Date().toISOString();
    const marks = expectedList.map(() => "?").join(",");
    const leaseClause = options.owner === undefined ? "" : " AND lease_owner=?";
    const args: (string | number)[] = [next, at, id, ...expectedList];
    const sql = `UPDATE tasks SET status=?, updated_at=?${options.incrementRevision ? ", revision_count=revision_count+1" : ""}${options.clearLease ? ", lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=NULL" : ""} WHERE id=? AND status IN (${marks})${leaseClause}`;
    if (options.owner !== undefined) args.push(options.owner);
    this.#transaction(() => {
      const changed = this.#db.prepare(sql).run(...args);
      if (Number(changed.changes) !== 1) throw new Error(`Task ${id} state transition rejected (expected ${expectedList.join("|")})`);
      if (next === "failed" && options.reason) this.#db.prepare("UPDATE tasks SET failure_reason=? WHERE id=?").run(options.reason, id);
      if (next === "done" || next === "failed") {
        this.#db.prepare("DELETE FROM quota_pauses WHERE task_id=?").run(id);
        this.#disableExecutionRecoveryCheckpoint(id, at, `terminal:${next}`);
      }
      this.#event(id, "task.transition", { from: expectedList, to: next, reason: options.reason }, at);
    });
    const task = this.get(id);
    if (!task) throw new Error(`Task ${id} disappeared`);
    return task;
  }

  /** List lease-expiry quarantines that may be eligible for the pre-write recovery gate. */
  listLeaseExpiryRecoveryCandidates(): TaskRecord[] {
    return this.list("recovery_required").filter(task => {
      if (task.recoveryEvidence?.kind !== "lease_expiry" || task.recoveryEvidence.claimProtocolVersion !== 2) return false;
      return !this.#hasPersistedWriteEvidence(task.id);
    });
  }

  /** Strict candidates for the first ordinary-crash resume path. No filesystem work is done here. */
  listExecutionRecoveryCandidates(): TaskRecord[] {
    return this.list("recovery_required").filter(task => this.#executionRecoveryEligibility(task.id));
  }

  #executionRecoveryEligibility(taskId: string): boolean {
    const row = this.#db.prepare(`SELECT t.status,t.revision_count,t.claim_generation_id,t.payload,t.recovery_evidence,t.lease_owner,t.lease_expires_at
      FROM tasks t WHERE t.id=?`).get(taskId) as {
        status: TaskStatus; revision_count: number; claim_generation_id: string | null; payload: string; recovery_evidence: string | null;
        lease_owner: string | null; lease_expires_at: string | null;
      } | undefined;
    if (!row || row.status !== "recovery_required" || row.lease_owner !== null || row.lease_expires_at !== null ||
        row.revision_count !== 0 || !row.recovery_evidence || !row.claim_generation_id) return false;
    let evidence: Record<string, unknown>;
    let payload: { executionStages?: unknown };
    try { evidence = JSON.parse(row.recovery_evidence) as Record<string, unknown>; payload = JSON.parse(row.payload) as { executionStages?: unknown }; }
    catch { return false; }
    if (evidence.kind !== "lease_expiry" || evidence.claimProtocolVersion !== 2 || evidence.previousStatus !== "running" ||
        evidence.claimGenerationId !== row.claim_generation_id || !this.currentStartupProvesGenerationDrained(row.claim_generation_id)) return false;
    if (payload.executionStages !== undefined && (!Array.isArray(payload.executionStages) || payload.executionStages.length > 1)) return false;
    if (this.#db.prepare("SELECT 1 FROM quota_pauses WHERE task_id=?").get(taskId)) return false;
    const checkpoint = this.#db.prepare("SELECT status,payload FROM execution_recovery_checkpoints WHERE task_id=?").get(taskId) as { status: string; payload: string } | undefined;
    if (checkpoint) {
      if (checkpoint.status !== "superseded") return false;
      const prior = JSON.parse(checkpoint.payload) as Record<string, unknown>;
      if (prior.claimedGenerationId !== row.claim_generation_id || prior.supersededBySourceGenerationId !== row.claim_generation_id) return false;
    }
    const worktree = this.#db.prepare("SELECT status,plan,observed,fingerprint FROM worktree_creations WHERE task_id=?").get(taskId) as {
      status: string; plan: string; observed: string | null; fingerprint: string | null;
    } | undefined;
    if (!worktree || worktree.status !== "created" || !worktree.plan || !worktree.observed || !worktree.fingerprint ||
        !/^[a-f0-9]{64}$/i.test(worktree.fingerprint)) return false;
    try {
      const plan = JSON.parse(worktree.plan) as Record<string, unknown>;
      const observed = JSON.parse(worktree.observed) as { info?: Record<string, unknown>; commonGitDir?: unknown; head?: unknown };
      if (!plan || Array.isArray(plan) || typeof plan !== "object" || plan.taskId !== taskId || !observed || Array.isArray(observed) || typeof observed !== "object" ||
          !observed.info || Array.isArray(observed.info) || typeof observed.info !== "object" ||
          !["repoPath", "path", "branch", "baseCommit"].every(key => plan[key] === observed.info![key]) ||
          plan.commonGitDir !== observed.commonGitDir || observed.head !== plan.baseCommit) return false;
    } catch { return false; }
    if (this.#db.prepare("SELECT 1 FROM attempts WHERE task_id=? AND role='review' LIMIT 1").get(taskId) ||
        this.#db.prepare("SELECT 1 FROM stages WHERE task_id=? AND role='review' LIMIT 1").get(taskId) ||
        this.#db.prepare("SELECT 1 FROM reviews WHERE task_id=? LIMIT 1").get(taskId) ||
        this.#db.prepare("SELECT 1 FROM events WHERE task_id=? AND (lower(type) LIKE '%review%' OR lower(type) LIKE '%report%' OR lower(type) LIKE '%commit%') LIMIT 1").get(taskId)) return false;
    return true;
  }

  /** Atomically claims a proven-drained ordinary execution and records its durable recovery boundary. */
  claimExecutionRecovery(taskId: string, owner: string, input: {
    leaseMs?: number; now?: Date; identity: { checkedAt: string; observed: unknown; fingerprint: string };
  }): TaskRecord | undefined {
    if (!owner || !input || !input.identity || !/^[a-f0-9]{64}$/i.test(input.identity.fingerprint)) throw new Error("owner and valid fresh worktree identity are required");
    const now = input.now ?? new Date();
    const leaseMs = input.leaseMs ?? 60_000;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("valid now and positive leaseMs are required");
    this.#assertFreshRecoveryCheck(input.identity.checkedAt, now);
    const observedJson = JSON.stringify(input.identity.observed);
    if (!observedJson || observedJson === "null" || Buffer.byteLength(observedJson) > 65_536) throw new Error("Fresh observed worktree identity must be non-empty and at most 64 KiB");
    const at = now.toISOString();
    const expires = new Date(now.getTime() + leaseMs).toISOString();
    let claimed = false;
    this.#transaction(() => {
      if (!this.#executionRecoveryEligibility(taskId)) return;
      const task = this.#db.prepare("SELECT recovery_reason,recovery_evidence,claim_generation_id,revision_count,payload FROM tasks WHERE id=?").get(taskId) as {
        recovery_reason: string | null; recovery_evidence: string; claim_generation_id: string; revision_count: number; payload: string;
      };
      const worktree = this.#db.prepare("SELECT * FROM worktree_creations WHERE task_id=?").get(taskId) as {
        task_id: string; lease_owner: string; status: string; plan: string; intent_at: string; observed: string; fingerprint: string; created_at: string;
      };
      const savedObserved = JSON.parse(worktree.observed) as { info?: Record<string, unknown>; commonGitDir?: unknown };
      const freshObserved = input.identity.observed as { info?: Record<string, unknown>; commonGitDir?: unknown; head?: unknown };
      const savedInfo = savedObserved.info;
      const freshInfo = freshObserved?.info;
      if (!savedInfo || !freshInfo || !["taskId", "repoPath", "path", "branch", "baseCommit"].every(key => savedInfo[key] === freshInfo[key]) ||
          savedObserved.commonGitDir !== freshObserved.commonGitDir || freshObserved.head !== freshInfo.baseCommit) {
        throw new Error("Fresh worktree identity does not match persisted creation identity or contains a commit");
      }
      const history = this.#db.prepare(`SELECT COALESCE(MAX(e.id),0) AS event_id,
          COALESCE((SELECT MAX(sequence) FROM attempts WHERE task_id=?),0) AS attempt_sequence,
          COALESCE((SELECT MAX(sequence) FROM stages WHERE task_id=?),0) AS stage_sequence,
          COALESCE((SELECT COUNT(*) FROM routes WHERE task_id=?),0) AS route_count,
          COALESCE((SELECT COUNT(*) FROM checks WHERE task_id=?),0) AS check_count,
          COALESCE((SELECT COUNT(*) FROM handoffs WHERE task_id=?),0) AS handoff_count
        FROM events e WHERE e.task_id=?`).get(taskId, taskId, taskId, taskId, taskId, taskId) as {
          event_id: number; attempt_sequence: number; stage_sequence: number; route_count: number; check_count: number; handoff_count: number;
        };
      const creationEvent = this.#db.prepare("SELECT id FROM events WHERE task_id=? AND type='worktree.created' ORDER BY id LIMIT 1").get(taskId) as { id: number } | undefined;
      const checkpointId = randomUUID();
      const source = {
        recoveryReason: task.recovery_reason, recoveryEvidence: JSON.parse(task.recovery_evidence),
        worktreeCreation: { taskId: worktree.task_id, leaseOwner: worktree.lease_owner, status: worktree.status,
          plan: JSON.parse(worktree.plan), intentAt: worktree.intent_at, observed: JSON.parse(worktree.observed),
          fingerprint: worktree.fingerprint, createdAt: worktree.created_at, sourceEventId: creationEvent?.id },
        historyBoundary: { throughEventId: history.event_id, attemptSequence: history.attempt_sequence,
          stageSequence: history.stage_sequence, routeCount: history.route_count, checkCount: history.check_count,
          handoffCount: history.handoff_count },
      };
      const checkpoint = { id: checkpointId, schemaVersion: 1, kind: "execution_recovery", sourceGenerationId: task.claim_generation_id,
        source, freshIdentity: { checkedAt: input.identity.checkedAt, observed: input.identity.observed, fingerprint: input.identity.fingerprint,
          creationFingerprint: worktree.fingerprint },
        claimedGenerationId: this.#startupGeneration.id, owner, leaseExpiresAt: expires, claimedAt: at };
      const checkpointJson = JSON.stringify(checkpoint);
      if (Buffer.byteLength(checkpointJson) > 65_536) throw new Error("Execution recovery checkpoint exceeds 64 KiB");
      const changed = this.#db.prepare(`UPDATE tasks SET status='running',updated_at=?,lease_owner=?,lease_expires_at=?,heartbeat_at=?,active_attempt_id=NULL,
        lease_protocol_version=2,claim_generation_id=?,recovery_reason=NULL,recovery_evidence=NULL
        WHERE id=? AND status='recovery_required' AND revision_count=0 AND claim_generation_id=?`)
        .run(at, owner, expires, at, this.#startupGeneration.id, taskId, task.claim_generation_id);
      if (Number(changed.changes) !== 1) return;
      this.#db.prepare(`UPDATE worktree_creations SET lease_owner=?,observed=?,fingerprint=?,created_at=? WHERE task_id=? AND status='created'`)
        .run(owner, observedJson, input.identity.fingerprint, at, taskId);
      this.#db.prepare(`INSERT INTO execution_recovery_checkpoints(task_id,status,payload,updated_at) VALUES(?,'claimed',?,?)
        ON CONFLICT(task_id) DO UPDATE SET status='claimed',payload=excluded.payload,updated_at=excluded.updated_at`).run(taskId, checkpointJson, at);
      this.#event(taskId, "task.execution_recovery_claimed", { checkpointId, sourceGenerationId: task.claim_generation_id,
        generationId: this.#startupGeneration.id, owner, claimedAt: at, fingerprint: input.identity.fingerprint,
        sourceHistoryThroughEventId: history.event_id, sourceWorktreeCreatedEventId: creationEvent?.id }, at);
      this.#event(taskId, "task.claimed", { owner, leaseExpiresAt: expires, leaseProtocolVersion: 2, generationId: this.#startupGeneration.id, recovery: true }, at);
      claimed = true;
    });
    return claimed ? this.get(taskId) : undefined;
  }

  /** After a claimed identity fails a second check, return to quarantine with the checkpoint intact. */
  quarantineClaimedExecutionRecovery(taskId: string, owner: string, reason: string): TaskRecord {
    if (!reason.trim()) throw new Error("recovery quarantine reason is required");
    const at = new Date().toISOString();
    this.#transaction(() => {
      const row = this.#db.prepare("SELECT status,lease_owner,recovery_evidence FROM tasks WHERE id=?").get(taskId) as {
        status: TaskStatus; lease_owner: string | null; recovery_evidence: string | null;
      } | undefined;
      const checkpoint = this.#db.prepare("SELECT payload,status FROM execution_recovery_checkpoints WHERE task_id=?").get(taskId) as { payload: string; status: string } | undefined;
      if (!row || row.status !== "running" || row.lease_owner !== owner || !checkpoint || checkpoint.status !== "claimed") throw new Error(`Task ${taskId} has no claimed execution recovery for ${owner}`);
      const checkpointPayload = JSON.parse(checkpoint.payload) as Record<string, unknown>;
      const source = checkpointPayload.source as Record<string, unknown>;
      const evidence = source.recoveryEvidence as Record<string, unknown>;
      const quarantine = { kind: "execution_recovery_quarantine", claimProtocolVersion: 2, previousStatus: "running",
        claimGenerationId: checkpointPayload.claimedGenerationId, sourceRecoveryEvidence: evidence, quarantineReason: reason,
        quarantinedAfterClaimAt: at, recoveryCheckpoint: "execution_recovery" };
      const changed = this.#db.prepare(`UPDATE tasks SET status='recovery_required',updated_at=?,lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
        recovery_reason=?,recovery_evidence=? WHERE id=? AND status='running' AND lease_owner=?`)
        .run(at, reason, JSON.stringify(quarantine), taskId, owner);
      if (Number(changed.changes) !== 1) throw new Error(`Task ${taskId} recovery quarantine was rejected`);
      this.#db.prepare("UPDATE execution_recovery_checkpoints SET status='quarantined',updated_at=? WHERE task_id=?").run(at, taskId);
      this.#event(taskId, "task.execution_recovery_quarantined", { reason, checkpointId: checkpointPayload.id,
        sourceGenerationId: checkpointPayload.sourceGenerationId, generationId: checkpointPayload.claimedGenerationId }, at);
    });
    return this.get(taskId)!;
  }

  /** Persist a single pre-claim exclusion for a durable identity mismatch; transient I/O failures must not call this. */
  rejectExecutionRecoveryInspection(taskId: string, reason: string, checkedAt: string): TaskRecord {
    if (!reason.trim()) throw new Error("inspection rejection reason is required");
    this.#assertFreshRecoveryCheck(checkedAt, new Date());
    const at = new Date().toISOString();
    this.#transaction(() => {
      if (!this.#executionRecoveryEligibility(taskId)) throw new Error(`Task ${taskId} is not an eligible lease-expiry execution recovery`);
      const row = this.#db.prepare("SELECT recovery_evidence,claim_generation_id FROM tasks WHERE id=?").get(taskId) as { recovery_evidence: string; claim_generation_id: string };
      const payload = { schemaVersion: 1, kind: "execution_recovery_inspection_rejected", sourceGenerationId: row.claim_generation_id,
        sourceRecoveryEvidence: JSON.parse(row.recovery_evidence), reason, checkedAt, recordedAt: at };
      this.#db.prepare("INSERT INTO execution_recovery_checkpoints(task_id,status,payload,updated_at) VALUES(?,'inspection_required',?,?)")
        .run(taskId, JSON.stringify(payload), at);
      this.#event(taskId, "task.execution_recovery_inspection_required", payload, at);
    });
    return this.get(taskId)!;
  }

  executionRecoveryCheckpoint(taskId: string): Record<string, unknown> | undefined {
    const row = this.#db.prepare(`SELECT c.payload,t.status,t.lease_owner,t.claim_generation_id FROM execution_recovery_checkpoints c
      JOIN tasks t ON t.id=c.task_id WHERE c.task_id=? AND c.status='claimed'`).get(taskId) as {
        payload: string; status: TaskStatus; lease_owner: string | null; claim_generation_id: string | null;
      } | undefined;
    if (!row || row.status !== "running" || !row.lease_owner || !row.claim_generation_id) return undefined;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    return payload.owner === row.lease_owner && payload.claimedGenerationId === row.claim_generation_id ? payload : undefined;
  }

  #assertFreshRecoveryCheck(checkedAt: string, now: Date): void {
    const checked = Date.parse(checkedAt);
    if (!Number.isFinite(checked) || checked > now.getTime() + 5_000 || now.getTime() - checked > 5_000) throw new Error("Fresh worktree identity evidence is required");
  }

  #disableExecutionRecoveryCheckpoint(taskId: string, at: string, reason: string): void {
    const row = this.#db.prepare("SELECT payload FROM execution_recovery_checkpoints WHERE task_id=?").get(taskId) as { payload: string } | undefined;
    if (!row) return;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    this.#db.prepare("UPDATE execution_recovery_checkpoints SET status='disabled',payload=?,updated_at=? WHERE task_id=?")
      .run(JSON.stringify({ ...payload, disabledAt: at, disabledReason: reason }), at, taskId);
  }

  #hasPersistedWriteEvidence(taskId: string): boolean {
    return Boolean(
      this.#db.prepare("SELECT 1 AS found FROM worktree_creations WHERE task_id=? LIMIT 1").get(taskId)
      || this.#db.prepare("SELECT 1 AS found FROM attempts WHERE task_id=? LIMIT 1").get(taskId)
      || this.#db.prepare("SELECT 1 AS found FROM stages WHERE task_id=? LIMIT 1").get(taskId)
      || this.#db.prepare("SELECT 1 AS found FROM routes WHERE task_id=? LIMIT 1").get(taskId)
      || this.#db.prepare("SELECT 1 AS found FROM checks WHERE task_id=? LIMIT 1").get(taskId)
      || this.#db.prepare("SELECT 1 AS found FROM reviews WHERE task_id=? LIMIT 1").get(taskId)
    );
  }

  /**
   * Requeue only a lease-expiry quarantine whose task has no persisted write intent or
   * execution evidence. The caller must have freshly established that the worktree
   * path is absent; all database facts are rechecked atomically here.
   */
  requeuePreWriteIntentLeaseExpiry(taskId: string, filesystemEvidence: { kind: "worktree_absent"; checkedAt: string }): TaskRecord {
    const checkedAt = filesystemEvidence?.kind === "worktree_absent" ? Date.parse(filesystemEvidence.checkedAt) : Number.NaN;
    const nowMs = Date.now();
    if (!Number.isFinite(checkedAt) || checkedAt > nowMs + 5_000 || nowMs - checkedAt > 5_000) {
      throw new Error("Fresh worktree absence evidence is required");
    }
    const at = new Date().toISOString();
    this.#transaction(() => {
      const task = this.#db.prepare("SELECT status,recovery_evidence FROM tasks WHERE id=?").get(taskId) as { status: TaskStatus; recovery_evidence: string | null } | undefined;
      const recoveryEvidence = task?.recovery_evidence ? JSON.parse(task.recovery_evidence) as Record<string, unknown> : undefined;
      if (!task || task.status !== "recovery_required" || recoveryEvidence?.kind !== "lease_expiry" || recoveryEvidence.claimProtocolVersion !== 2) {
        throw new Error(`Task ${taskId} is not an eligible lease-expiry recovery quarantine`);
      }
      if (this.#hasPersistedWriteEvidence(taskId)) {
        throw new Error(`Task ${taskId} has persisted work evidence and cannot be automatically requeued`);
      }
      const changed = this.#db.prepare(`UPDATE tasks SET status='pending',updated_at=?,recovery_reason=NULL,recovery_evidence=NULL,lease_protocol_version=NULL
        WHERE id=? AND status='recovery_required'`).run(at, taskId);
      if (Number(changed.changes) !== 1) throw new Error(`Task ${taskId} recovery requeue was rejected`);
      this.#event(taskId, "task.requeued_pre_write_intent", { recoveryEvidence, filesystemEvidence }, at);
    });
    return this.get(taskId)!;
  }

  fail(id: string, expected: TaskStatus | TaskStatus[], reason: string, owner?: string): TaskRecord {
    const task = this.transition(id, expected, "failed", { owner, clearLease: true, reason });
    return { ...task, failureReason: reason };
  }

  /** Persist a known provider-quota pause and release its lease. The checkpoint is the worker's explicit resume boundary. */
  pauseForQuota(taskId: string, owner: string, input: { retryAt: string; reason: string; checkpoint: Record<string, unknown>; source?: "provider_message" | "retry_after" | "fallback" }): TaskRecord {
    const retryAt = new Date(input.retryAt);
    if (!Number.isFinite(retryAt.getTime()) || retryAt.getTime() <= Date.now()) throw new Error("Quota retryAt must be a future timestamp");
    const at = new Date().toISOString();
    this.#transaction(() => {
      const row = this.#db.prepare("SELECT status,lease_owner FROM tasks WHERE id=?").get(taskId) as { status: TaskStatus; lease_owner: string | null } | undefined;
      if (!row || row.lease_owner !== owner || !["running", "reviewing", "revision"].includes(row.status)) throw new Error(`Task ${taskId} is not actively leased by ${owner}`);
      const previous = this.#db.prepare("SELECT retry_count FROM quota_pauses WHERE task_id=?").get(taskId) as { retry_count: number } | undefined;
      const count = (previous?.retry_count ?? 0) + 1;
      this.#db.prepare(`INSERT INTO quota_pauses(task_id,retry_at,retry_count,checkpoint,reason,source) VALUES(?,?,?,?,?,?)
        ON CONFLICT(task_id) DO UPDATE SET retry_at=excluded.retry_at,retry_count=excluded.retry_count,checkpoint=excluded.checkpoint,reason=excluded.reason,source=excluded.source`)
        .run(taskId, retryAt.toISOString(), count, JSON.stringify(input.checkpoint), input.reason, input.source ?? "fallback");
      this.#db.prepare(`UPDATE tasks SET status='waiting',updated_at=?,failure_reason=?,lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=NULL,active_attempt_id=NULL WHERE id=?`).run(at, input.reason, taskId);
      this.#disableExecutionRecoveryCheckpoint(taskId, at, "quota_waiting");
      this.#event(taskId, "task.quota_waiting", { retryAt: retryAt.toISOString(), retryCount: count, checkpoint: input.checkpoint, source: input.source ?? "fallback", reason: input.reason }, at);
    });
    return this.get(taskId)!;
  }

  quotaCheckpoint(taskId: string): Record<string, unknown> | undefined {
    const row = this.#db.prepare("SELECT checkpoint FROM quota_pauses WHERE task_id=?").get(taskId) as { checkpoint: string } | undefined;
    return row ? JSON.parse(row.checkpoint) as Record<string, unknown> : undefined;
  }

  quotaRetryCount(taskId: string): number {
    const row = this.#db.prepare("SELECT retry_count FROM quota_pauses WHERE task_id=?").get(taskId) as { retry_count: number } | undefined;
    return row?.retry_count ?? 0;
  }

  heartbeat(id: string, owner: string, leaseMs = 60_000, now = new Date()): boolean {
    const at = now.toISOString();
    const expires = new Date(now.getTime() + leaseMs).toISOString();
    return this.#transaction(() => {
      const changed = this.#db.prepare(`UPDATE tasks SET heartbeat_at=?, lease_expires_at=?, updated_at=?
        WHERE id=? AND lease_owner=? AND status IN ('running','reviewing','revision')`).run(at, expires, at, id, owner);
      if (Number(changed.changes)) this.#event(id, "task.heartbeat", { owner, leaseExpiresAt: expires }, at);
      return Number(changed.changes) === 1;
    });
  }

  /** Expired leases fail closed for manual inspection; lease expiry does not prove the old process stopped. */
  recoverExpired(now = new Date()): string[] {
    const at = now.toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.#db.prepare(`SELECT id,status,lease_owner,lease_expires_at,heartbeat_at,active_attempt_id,lease_protocol_version,claim_generation_id FROM tasks
        WHERE status IN ('running','reviewing','revision') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`).all(at) as Array<{
          id: string; status: TaskStatus; lease_owner: string | null; lease_expires_at: string; heartbeat_at: string | null; active_attempt_id: string | null; lease_protocol_version: number | null; claim_generation_id: string | null;
        }>;
      for (const row of rows) {
        const runningAttempts = this.#db.prepare("SELECT id FROM attempts WHERE task_id=? AND status='running'").all(row.id) as Array<{ id: string }>;
        const runningStages = this.#db.prepare("SELECT id,process_start_id,generation_id FROM stages WHERE task_id=? AND status='running'").all(row.id) as Array<{ id: string; process_start_id: string; generation_id: string | null }>;
        const reason = "Task lease expired while execution was active; inspect the worker process and task worktree before any retry.";
        let evidence: Record<string, unknown> = { kind: "lease_expiry", claimProtocolVersion: row.lease_protocol_version, previousStatus: row.status, leaseOwner: row.lease_owner, leaseExpiresAt: row.lease_expires_at,
          heartbeatAt: row.heartbeat_at, activeAttemptId: row.active_attempt_id, claimGenerationId: row.claim_generation_id,
          runningAttemptIds: runningAttempts.map(attempt => attempt.id),
          runningStages: runningStages.map(stage => ({ id: stage.id, processStartId: stage.process_start_id, generationId: stage.generation_id })) };
        const priorRecovery = this.#db.prepare("SELECT status,payload FROM execution_recovery_checkpoints WHERE task_id=?").get(row.id) as { status: string; payload: string } | undefined;
        if (priorRecovery?.status === "claimed") {
          const priorCheckpoint = JSON.parse(priorRecovery.payload) as Record<string, unknown>;
          if (priorCheckpoint.claimedGenerationId === row.claim_generation_id) {
            const archivedEvent = this.#db.prepare("SELECT id FROM events WHERE task_id=? AND type='task.execution_recovery_claimed' ORDER BY id DESC LIMIT 1").get(row.id) as { id: number } | undefined;
            evidence = { ...evidence, priorExecutionRecoveryCheckpoint: {
              checkpointId: priorCheckpoint.id,
              sourceGenerationId: priorCheckpoint.sourceGenerationId, claimedGenerationId: priorCheckpoint.claimedGenerationId,
              claimedAt: priorCheckpoint.claimedAt, archivedEventId: archivedEvent?.id,
            } };
            const superseded = { ...priorCheckpoint, supersededBySourceGenerationId: row.claim_generation_id, supersededAt: at };
            this.#db.prepare("UPDATE execution_recovery_checkpoints SET status='superseded',payload=?,updated_at=? WHERE task_id=? AND status='claimed'")
              .run(JSON.stringify(superseded), at, row.id);
          }
        }
        this.#db.prepare(`UPDATE tasks SET status='recovery_required', updated_at=?, lease_owner=NULL, lease_expires_at=NULL,
          heartbeat_at=NULL, active_attempt_id=NULL, recovery_reason=?, recovery_evidence=? WHERE id=?`)
          .run(at, reason, JSON.stringify(evidence), row.id);
        this.#db.prepare("UPDATE attempts SET status='interrupted',finished_at=?,error=COALESCE(error,'task lease expired') WHERE task_id=? AND status='running'")
          .run(at, row.id);
        for (const stage of runningStages) {
          const reason = "task lease expired; inspect process and worktree before resuming";
          this.#db.prepare("UPDATE stages SET status='interrupted',finished_at=?,error=? WHERE id=? AND status='running'").run(at, reason, stage.id);
          this.#event(row.id, "stage.finished", { stageId: stage.id, status: "interrupted", processStartId: stage.process_start_id, error: reason }, at);
        }
        this.#event(row.id, "task.lease_expired", { previousStatus: row.status, previousAttemptId: row.active_attempt_id, reason, evidence }, at);
        this.#event(row.id, "task.recovery_required", { reason, evidence }, at);
      }
      this.#db.exec("COMMIT");
      return rows.map(row => row.id);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  createStage(taskId: string, input: {
    role: StageRole;
    predecessorStageId?: string;
    harness?: string;
    harnessVersion?: string;
    model?: string;
    reasoningEffort?: string;
    bindingVersion?: string;
    configHash?: string;
    processStartId: string;
    inputFingerprint?: string;
  }): StageRecord {
    if (!this.get(taskId)) throw new Error(`Unknown task ${taskId}`);
    let stage!: StageRecord;
    this.#transaction(() => {
      if (input.predecessorStageId) {
        const predecessor = this.getStage(input.predecessorStageId);
        if (!predecessor || predecessor.taskId !== taskId) throw new Error("Predecessor stage must belong to the same task");
      }
      if (!input.processStartId.trim()) throw new Error("processStartId is required for a stage");
      const sequence = Number((this.#db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM stages WHERE task_id=?").get(taskId) as { n: number }).n);
      stage = {
        id: randomUUID(), taskId, sequence, role: input.role, status: "pending",
        predecessorStageId: input.predecessorStageId, harness: input.harness, harnessVersion: input.harnessVersion, model: input.model,
        reasoningEffort: input.reasoningEffort, bindingVersion: input.bindingVersion,
        configHash: input.configHash, processStartId: input.processStartId, inputFingerprint: input.inputFingerprint,
        createdAt: new Date().toISOString(),
      };
      this.#db.prepare(`INSERT INTO stages(id,task_id,sequence,role,status,predecessor_stage_id,harness,harness_version,model,reasoning_effort,binding_version,config_hash,process_start_id,input_fingerprint,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(stage.id, taskId, sequence, stage.role, stage.status,
        stage.predecessorStageId ?? null, stage.harness ?? null, stage.harnessVersion ?? null, stage.model ?? null, stage.reasoningEffort ?? null,
        stage.bindingVersion ?? null, stage.configHash ?? null, stage.processStartId ?? null,
        stage.inputFingerprint ?? null, stage.createdAt);
      this.#event(taskId, "stage.created", { stage }, stage.createdAt);
    });
    return stage;
  }

  getStage(stageId: string): StageRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM stages WHERE id=?").get(stageId) as StageRow | undefined;
    return row ? this.#stage(row) : undefined;
  }

  stages(taskId: string): StageRecord[] {
    return (this.#db.prepare("SELECT * FROM stages WHERE task_id=? ORDER BY sequence").all(taskId) as StageRow[]).map(row => this.#stage(row));
  }

  /**
   * Claims a stage under the task lease. Only one stage per task may be active;
   * failed/interrupted predecessors are terminal so a revision/recovery stage can follow.
   */
  startStage(stageId: string, owner: string, processStartId: string): StageRecord {
    return this.#transaction(() => {
      const stage = this.getStage(stageId);
      if (!stage) throw new Error(`Unknown stage ${stageId}`);
      const task = this.#db.prepare("SELECT status,lease_owner,lease_expires_at FROM tasks WHERE id=?").get(stage.taskId) as { status: TaskStatus; lease_owner: string | null; lease_expires_at: string | null } | undefined;
      if (!task || !this.#hasLiveStageLease(task, owner, stage.role)) throw new Error(`Task ${stage.taskId} is not leased by ${owner} for ${stage.role} (wrong state or expired lease)`);
      if (stage.processStartId !== processStartId) throw new Error(`Stage ${stageId} process generation does not match`);
      const activeStage = this.#db.prepare("SELECT id FROM stages WHERE task_id=? AND status='running' LIMIT 1").get(stage.taskId) as { id: string } | undefined;
      if (activeStage) throw new Error(`Task ${stage.taskId} already has a running stage ${activeStage.id}`);
      const activeAttempt = this.#db.prepare("SELECT id FROM attempts WHERE task_id=? AND status='running' LIMIT 1").get(stage.taskId) as { id: string } | undefined;
      if (activeAttempt) throw new Error(`Task ${stage.taskId} already has a running attempt ${activeAttempt.id}`);
      if (stage.predecessorStageId) {
        const predecessor = this.getStage(stage.predecessorStageId);
        if (!predecessor || predecessor.taskId !== stage.taskId || predecessor.status === "pending" || predecessor.status === "running") {
          throw new Error(`Predecessor stage ${stage.predecessorStageId} has not reached a terminal state`);
        }
      }
      const startedAt = new Date().toISOString();
      const claim = this.#db.prepare("SELECT claim_generation_id FROM tasks WHERE id=?").get(stage.taskId) as { claim_generation_id: string | null };
      const changed = this.#db.prepare("UPDATE stages SET status='running',started_at=?,generation_id=? WHERE id=? AND status='pending' AND process_start_id=?")
        .run(startedAt, claim.claim_generation_id, stageId, processStartId);
      if (Number(changed.changes) !== 1) throw new Error(`Stage ${stageId} is not pending`);
      this.#event(stage.taskId, "stage.started", { stageId, processStartId, generationId: claim.claim_generation_id ?? undefined }, startedAt);
      return this.getStage(stageId)!;
    });
  }

  finishStage(stageId: string, owner: string, processStartId: string, status: Extract<StageStatus, "succeeded" | "failed" | "interrupted">, outputFingerprint?: string): StageRecord {
    return this.#transaction(() => {
      const stage = this.getStage(stageId);
      if (!stage) throw new Error(`Unknown stage ${stageId}`);
      const task = this.#db.prepare("SELECT status,lease_owner,lease_expires_at FROM tasks WHERE id=?").get(stage.taskId) as { status: TaskStatus; lease_owner: string | null; lease_expires_at: string | null } | undefined;
      if (!task || !this.#hasLiveStageLease(task, owner, stage.role)) throw new Error(`Task ${stage.taskId} is not leased by ${owner} for ${stage.role} (wrong state or expired lease)`);
      if (stage.processStartId !== processStartId) throw new Error(`Stage ${stageId} process generation does not match`);
      const activeAttempt = this.#db.prepare("SELECT id FROM attempts WHERE stage_id=? AND status='running' LIMIT 1").get(stageId);
      if (activeAttempt) throw new Error(`Stage ${stageId} still has a running attempt`);
      if (status === "succeeded") {
        const counts = this.#db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded FROM attempts WHERE stage_id=?")
          .get(stageId) as { total: number; succeeded: number | null };
        if (Number(counts.total) === 0 || Number(counts.succeeded ?? 0) === 0) {
          throw new Error(`Stage ${stageId} cannot succeed without a succeeded attempt`);
        }
      }
      const finishedAt = new Date().toISOString();
      const changed = this.#db.prepare("UPDATE stages SET status=?,finished_at=?,output_fingerprint=?,error=? WHERE id=? AND status='running' AND process_start_id=?")
        .run(status, finishedAt, outputFingerprint ?? null, status === "succeeded" ? null : "stage completed without success", stageId, processStartId);
      if (Number(changed.changes) !== 1) throw new Error(`Stage ${stageId} is not running`);
      this.#event(stage.taskId, "stage.finished", { stageId, status, outputFingerprint, processStartId }, finishedAt);
      return this.getStage(stageId)!;
    });
  }

  saveHandoff(value: unknown): HandoffRecord {
    const handoff = parseHandoffV1(value);
    const payload = JSON.stringify(handoff);
    const byteLength = Buffer.byteLength(payload, "utf8");
    if (byteLength > HANDOFF_V1_MAX_BYTES) throw new Error(`handoff payload exceeds ${HANDOFF_V1_MAX_BYTES} bytes`);
    const id = randomUUID();
    this.#transaction(() => {
      const stage = this.getStage(handoff.stageId);
      if (!stage || stage.taskId !== handoff.taskId) throw new Error("Handoff stage must belong to the handoff task");
      if (!(stage.status === "succeeded" || stage.status === "failed" || stage.status === "interrupted")) {
        throw new Error("Handoff can only be saved after its stage reaches a terminal state");
      }
      const attempt = this.#db.prepare("SELECT task_id,stage_id,status,harness,model FROM attempts WHERE id=?")
        .get(handoff.source.attemptId) as { task_id: string; stage_id: string | null; status: Attempt["status"]; harness: string | null; model: string | null } | undefined;
      if (!attempt || attempt.task_id !== handoff.taskId || attempt.stage_id !== handoff.stageId) {
        throw new Error("Handoff source attempt must be linked to its stage and task");
      }
      if (attempt.status === "running") throw new Error("Handoff source attempt must be terminal");
      if (attempt.harness !== handoff.source.harness || attempt.model !== handoff.source.model) {
        throw new Error("Handoff source Harness/model must match the persisted attempt");
      }
      for (const key of ["harnessVersion", "bindingVersion", "configHash", "processStartId"] as const) {
        if (handoff.source[key] !== undefined && stage[key] !== undefined && handoff.source[key] !== stage[key]) {
          throw new Error(`Handoff source ${key} must match the persisted stage`);
        }
      }
      this.#db.prepare(`INSERT INTO handoffs(id,task_id,stage_id,attempt_id,schema_version,created_at,payload,payload_bytes)
        VALUES(?,?,?,?,1,?,?,?)`).run(id, handoff.taskId, handoff.stageId, handoff.source.attemptId,
        handoff.createdAt, payload, byteLength);
      this.#event(handoff.taskId, "handoff.saved", { handoffId: id, stageId: handoff.stageId, attemptId: handoff.source.attemptId, byteLength }, handoff.createdAt);
    });
    return { ...handoff, id, byteLength };
  }

  handoffs(taskId: string): HandoffRecord[] {
    const rows = this.#db.prepare("SELECT * FROM handoffs WHERE task_id=? ORDER BY created_at,id").all(taskId) as HandoffRow[];
    return rows.map(row => this.#handoff(row));
  }

  getHandoff(handoffId: string): HandoffRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM handoffs WHERE id=?").get(handoffId) as HandoffRow | undefined;
    return row ? this.#handoff(row) : undefined;
  }

  createAttempt(taskId: string, role: Attempt["role"], options: { owner?: string; stageId?: string; harness?: string; harnessVersion?: string; model?: string; reasoningEffort?: string; bindingVersion?: string; configHash?: string; metadata?: Record<string, unknown> } = {}): Attempt {
    const task = this.get(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    if (options.owner !== undefined && task.leaseOwner !== options.owner) throw new Error(`Task ${taskId} is not leased by ${options.owner}`);
    if (options.stageId) {
      const stage = this.getStage(options.stageId);
      if (!stage || stage.taskId !== taskId) throw new Error(`Stage ${options.stageId} does not belong to task ${taskId}`);
      if (stage.status !== "running") throw new Error(`Stage ${options.stageId} is not running`);
      if (!options.owner || !this.#hasLiveStageLease({ status: task.status, lease_owner: task.leaseOwner ?? null, lease_expires_at: task.leaseExpiresAt ?? null }, options.owner, stage.role)) throw new Error(`Task ${taskId} is not leased for a ${stage.role} stage attempt (wrong state or expired lease)`);
      if (stage.role !== role) throw new Error(`Attempt role ${role} does not match stage role ${stage.role}`);
      if (stage.harness !== undefined && stage.harness !== options.harness) throw new Error(`Attempt Harness does not match stage selection`);
      if (stage.model !== undefined && stage.model !== options.model) throw new Error(`Attempt model does not match stage selection`);
      if (stage.reasoningEffort !== undefined && stage.reasoningEffort !== options.reasoningEffort) throw new Error(`Attempt reasoning effort does not match stage selection`);
      if (stage.harnessVersion !== undefined && stage.harnessVersion !== options.harnessVersion) throw new Error(`Attempt Harness version does not match stage selection`);
      if (stage.bindingVersion !== undefined && stage.bindingVersion !== options.bindingVersion) throw new Error(`Attempt binding version does not match stage selection`);
      if (stage.configHash !== undefined && stage.configHash !== options.configHash) throw new Error(`Attempt config hash does not match stage selection`);
    }
    let attempt!: Attempt;
    this.#transaction(() => {
      if (options.stageId) {
        const currentTask = this.#db.prepare("SELECT status,lease_owner,lease_expires_at FROM tasks WHERE id=?").get(taskId) as { status: TaskStatus; lease_owner: string | null; lease_expires_at: string | null } | undefined;
        const currentStage = this.#db.prepare("SELECT role,status,harness,harness_version,model,reasoning_effort,binding_version,config_hash FROM stages WHERE id=? AND task_id=?")
          .get(options.stageId, taskId) as { role: StageRole; status: StageStatus; harness: string | null; harness_version: string | null; model: string | null; reasoning_effort: string | null; binding_version: string | null; config_hash: string | null } | undefined;
        if (!currentTask || !currentStage || !this.#hasLiveStageLease(currentTask, options.owner!, currentStage.role)) throw new Error(`Task ${taskId} is not leased for a ${role} stage attempt (wrong state or expired lease)`);
        if (!currentStage || currentStage.status !== "running" || currentStage.role !== role) throw new Error(`Stage ${options.stageId} changed before its attempt started`);
        for (const [name, expected, actual] of [
          ["Harness", currentStage.harness, options.harness], ["Harness version", currentStage.harness_version, options.harnessVersion],
          ["model", currentStage.model, options.model], ["reasoning effort", currentStage.reasoning_effort, options.reasoningEffort],
          ["binding version", currentStage.binding_version, options.bindingVersion], ["config hash", currentStage.config_hash, options.configHash],
        ] as Array<[string, string | null, string | undefined]>) {
          if (expected !== null && expected !== actual) throw new Error(`Attempt ${name} does not match stage selection`);
        }
      }
      const active = this.#db.prepare("SELECT id FROM attempts WHERE task_id=? AND status='running' LIMIT 1").get(taskId);
      if (active) throw new Error(`Task ${taskId} already has a running attempt`);
      const sequence = Number((this.#db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM attempts WHERE task_id=?").get(taskId) as { n: number }).n);
      attempt = { id: randomUUID(), taskId, stageId: options.stageId, sequence, role, status: "running", harness: options.harness,
        model: options.model, reasoningEffort: options.reasoningEffort, startedAt: new Date().toISOString(), metadata: options.metadata };
      this.#db.prepare(`INSERT INTO attempts(id,task_id,sequence,role,status,harness,model,reasoning_effort,started_at,metadata,stage_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(attempt.id, taskId, sequence, role, "running", attempt.harness ?? null,
        attempt.model ?? null, attempt.reasoningEffort ?? null, attempt.startedAt, encode(attempt.metadata), attempt.stageId ?? null);
      if (options.stageId) {
        this.#db.prepare(`UPDATE stages SET harness=COALESCE(harness,?),harness_version=COALESCE(harness_version,?),
          model=COALESCE(model,?),reasoning_effort=COALESCE(reasoning_effort,?),binding_version=COALESCE(binding_version,?),config_hash=COALESCE(config_hash,?)
          WHERE id=? AND status='running'`)
          .run(options.harness ?? null, options.harnessVersion ?? null, options.model ?? null, options.reasoningEffort ?? null,
            options.bindingVersion ?? null, options.configHash ?? null, options.stageId);
      }
      this.#db.prepare("UPDATE tasks SET active_attempt_id=? WHERE id=?").run(attempt.id, taskId);
      this.#event(taskId, "attempt.started", { attempt }, attempt.startedAt);
    });
    return attempt;
  }

  finishAttempt(id: string, result: Partial<Attempt> & { status: Attempt["status"] }, guard?: { owner: string; processStartId: string }): Attempt {
    return this.#transaction(() => {
      const existing = this.#db.prepare("SELECT * FROM attempts WHERE id=?").get(id) as Record<string, unknown> | undefined;
      if (!existing || existing.status !== "running") throw new Error(`Attempt ${id} is not running`);
      const stageId = existing.stage_id as string | null | undefined;
      if (stageId) {
        if (!guard?.owner || !guard.processStartId) throw new Error(`Stage-linked attempt ${id} requires owner and processStartId`);
        const stage = this.#db.prepare("SELECT task_id,role,status,process_start_id,harness,model,reasoning_effort FROM stages WHERE id=?")
          .get(stageId) as { task_id: string; role: StageRole; status: StageStatus; process_start_id: string; harness: string | null; model: string | null; reasoning_effort: string | null } | undefined;
        const task = this.#db.prepare("SELECT status,lease_owner,lease_expires_at FROM tasks WHERE id=?").get(String(existing.task_id)) as { status: TaskStatus; lease_owner: string | null; lease_expires_at: string | null } | undefined;
        if (!stage || stage.status !== "running" || stage.process_start_id !== guard.processStartId) throw new Error(`Attempt ${id} belongs to a stale stage generation`);
        if (!task || !this.#hasLiveStageLease(task, guard.owner, stage.role)) throw new Error(`Task ${String(existing.task_id)} is not leased by ${guard.owner} for ${stage.role} (wrong state or expired lease)`);
        for (const [name, expected, actual] of [
          ["Harness", stage.harness, result.harness], ["model", stage.model, result.model],
          ["reasoning effort", stage.reasoning_effort, result.reasoningEffort],
        ] as Array<[string, string | null, string | undefined]>) {
          if (actual !== undefined && expected !== null && actual !== expected) throw new Error(`Attempt result ${name} conflicts with its stage selection`);
        }
        for (const [name, expected, actual] of [
          ["Harness", existing.harness as string | null, result.harness],
          ["model", existing.model as string | null, result.model],
          ["reasoning effort", existing.reasoning_effort as string | null, result.reasoningEffort],
        ] as Array<[string, string | null, string | undefined]>) {
          if (actual !== undefined && expected !== null && actual !== expected) throw new Error(`Attempt result ${name} conflicts with the created attempt`);
        }
      }
      const changed = this.#db.prepare(`UPDATE attempts SET status=?, finished_at=?, exit_code=?, stdout_path=?, stderr_path=?,
      result_path=?, error=?, metadata=COALESCE(?,metadata), harness=COALESCE(?,harness), model=COALESCE(?,model),
      reasoning_effort=COALESCE(?,reasoning_effort) WHERE id=? AND status='running'`).run(result.status,
        result.finishedAt ?? new Date().toISOString(), result.exitCode ?? null, result.stdoutPath ?? null,
        result.stderrPath ?? null, result.resultPath ?? null, result.error ?? null, encode(result.metadata),
        result.harness ?? null, result.model ?? null, result.reasoningEffort ?? null, id);
      if (Number(changed.changes) !== 1) throw new Error(`Attempt ${id} is not running`);
      const row = this.#db.prepare("SELECT * FROM attempts WHERE id=?").get(id) as Record<string, unknown>;
      const attempt = this.#attempt(row);
      this.#db.prepare("UPDATE tasks SET active_attempt_id=NULL WHERE id=? AND active_attempt_id=?").run(attempt.taskId, id);
      this.#event(attempt.taskId, "attempt.finished", { attempt });
      return attempt;
    });
  }

  attempts(taskId: string): Attempt[] {
    return (this.#db.prepare("SELECT * FROM attempts WHERE task_id=? ORDER BY sequence").all(taskId) as Record<string, unknown>[]).map(row => this.#attempt(row));
  }

  saveRoute(decision: RouteDecision): void {
    this.#transaction(() => {
      this.#db.prepare("INSERT INTO routes(task_id,decided_at,decision) VALUES(?,?,?)").run(decision.taskId, decision.decidedAt, JSON.stringify(decision));
      this.#event(decision.taskId, "route.decided", { decision }, decision.decidedAt);
    });
  }

  getRoute(taskId: string): RouteDecision | undefined {
    const routeEvent = this.#db.prepare("SELECT id FROM events WHERE task_id=? AND type='route.decided' ORDER BY id DESC LIMIT 1").get(taskId) as { id: number } | undefined;
    const recoveryEvent = this.#db.prepare("SELECT id FROM events WHERE task_id=? AND type='task.execution_recovery_claimed' ORDER BY id DESC LIMIT 1").get(taskId) as { id: number } | undefined;
    if (recoveryEvent && (!routeEvent || recoveryEvent.id > routeEvent.id)) return undefined;
    const row = this.#db.prepare("SELECT decision FROM routes WHERE task_id=? ORDER BY id DESC LIMIT 1").get(taskId) as { decision: string } | undefined;
    return row ? JSON.parse(row.decision) as RouteDecision : undefined;
  }

  saveCheck(taskId: string, result: CheckResult, attemptId?: string): void {
    const at = new Date().toISOString();
    this.#transaction(() => {
      this.#db.prepare("INSERT INTO checks(task_id,attempt_id,check_id,at,result) VALUES(?,?,?,?,?)")
        .run(taskId, attemptId ?? null, result.id, at, JSON.stringify(result));
      this.#event(taskId, "check.finished", { attemptId, result }, at);
    });
  }

  checks(taskId: string): CheckResult[] {
    return (this.#db.prepare("SELECT result FROM checks WHERE task_id=? ORDER BY id").all(taskId) as { result: string }[]).map(row => JSON.parse(row.result) as CheckResult);
  }

  saveReview(taskId: string, result: ReviewResult, attemptId?: string): void {
    const at = new Date().toISOString();
    this.#transaction(() => {
      this.#db.prepare("INSERT INTO reviews(task_id,attempt_id,at,result) VALUES(?,?,?,?)")
        .run(taskId, attemptId ?? null, at, JSON.stringify(result));
      this.#event(taskId, "review.finished", { attemptId, result }, at);
    });
  }

  reviews(taskId: string): ReviewResult[] {
    return (this.#db.prepare("SELECT result FROM reviews WHERE task_id=? ORDER BY id").all(taskId) as { result: string }[]).map(row => JSON.parse(row.result) as ReviewResult);
  }

  /** Starts a durable check set tied to the live claim, successful execution attempt, and current route. */
  startCheckRun(input: StartCheckRunInput): CheckRunRecord {
    this.#validateReviewEvidence(input.snapshot, input.route, input.expectedCheckIds, input.checkDefinitionHash);
    if (input.route.taskId !== input.taskId) throw new Error("Route decision belongs to a different task");
    if (input.branchRef !== `refs/heads/zero/${input.taskId}`) throw new Error("Review branch ref must be the exact task branch ref");
    const diffBytes = Buffer.byteLength(input.snapshot.diff, "utf8");
    if (diffBytes > MAX_REVIEW_DIFF_BYTES) throw new Error(`Review diff exceeds ${MAX_REVIEW_DIFF_BYTES} bytes`);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.#transaction(() => {
      const task = this.#db.prepare("SELECT status,lease_owner,lease_expires_at,claim_generation_id,payload FROM tasks WHERE id=?")
        .get(input.taskId) as { status: TaskStatus; lease_owner: string | null; lease_expires_at: string | null; claim_generation_id: string | null; payload: string } | undefined;
      this.#assertReviewLease(task, input.owner, input.generationId);
      const submission = JSON.parse(task!.payload) as TaskSubmission;
      const definitions = submission.checks ?? [];
      const expectedDefinitionHash = createHash("sha256").update(JSON.stringify(definitions), "utf8").digest("hex");
      if (expectedDefinitionHash !== input.checkDefinitionHash) throw new Error("Check definition hash does not match the submitted task checks");
      if (!sameStringSet(definitions.map(check => check.id), input.expectedCheckIds)) throw new Error("Expected check IDs must exactly match the submitted check definitions");
      const currentRoute = this.getRoute(input.taskId);
      if (!currentRoute || JSON.stringify(currentRoute) !== JSON.stringify(input.route)) throw new Error("Route decision is not the current persisted route");
      const execution = this.#db.prepare("SELECT task_id,stage_id,status,role FROM attempts WHERE id=?")
        .get(input.executionAttemptId) as { task_id: string; stage_id: string | null; status: string; role: string } | undefined;
      const stage = this.#db.prepare("SELECT task_id,role,status,generation_id FROM stages WHERE id=?")
        .get(input.executionStageId) as { task_id: string; role: string; status: string; generation_id: string | null } | undefined;
      if (!execution || execution.task_id !== input.taskId || execution.stage_id !== input.executionStageId || execution.status !== "succeeded" || !["implement", "revise"].includes(execution.role)) {
        throw new Error("Check run requires a succeeded execution attempt linked to its stage");
      }
      if (!stage || stage.task_id !== input.taskId || !["implement", "revise"].includes(stage.role) || stage.status !== "running" || stage.generation_id !== input.generationId) {
        throw new Error("Check run requires the current running execution stage");
      }
      const routeAttempt = this.#db.prepare("SELECT task_id,role,status,metadata FROM attempts WHERE id=?")
        .get(input.routeAttemptId) as { task_id: string; role: string; status: string; metadata: string | null } | undefined;
      const routeMetadata = routeAttempt?.metadata ? JSON.parse(routeAttempt.metadata) as { decision?: RouteDecision } : undefined;
      if (!routeAttempt || routeAttempt.task_id !== input.taskId || routeAttempt.role !== "route" || routeAttempt.status !== "succeeded" ||
          !routeMetadata?.decision || JSON.stringify(routeMetadata.decision) !== JSON.stringify(input.route)) {
        throw new Error("Review package requires a succeeded route attempt matching the current route decision");
      }
      const routeJson = JSON.stringify(input.route);
      if (Buffer.byteLength(routeJson, "utf8") > 65_536 || Buffer.byteLength(JSON.stringify(input.expectedCheckIds), "utf8") > 65_536) {
        throw new Error("Review route or check ID evidence exceeds the persisted evidence limit");
      }
      this.#db.prepare(`INSERT INTO check_runs(id,task_id,generation_id,owner,execution_attempt_id,execution_stage_id,route_attempt_id,
        route,branch_ref,snapshot,check_definition_hash,expected_check_ids,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'running',?)`).run(id, input.taskId, input.generationId, input.owner,
        input.executionAttemptId, input.executionStageId, input.routeAttemptId, routeJson, input.branchRef,
        JSON.stringify(input.snapshot), input.checkDefinitionHash, JSON.stringify(input.expectedCheckIds), createdAt);
      this.#event(input.taskId, "check_run.started", { checkRunId: id, executionAttemptId: input.executionAttemptId,
        executionStageId: input.executionStageId, generationId: input.generationId, expectedCheckIds: input.expectedCheckIds }, createdAt);
    });
    return this.getCheckRun(id)!;
  }

  /** Appends one result only while the run's exact claim generation still owns a live lease. */
  recordCheckResult(runId: string, guard: CheckRunGuard, result: CheckResult): void {
    const at = new Date().toISOString();
    this.#transaction(() => {
      const run = this.#db.prepare("SELECT task_id,generation_id,owner,expected_check_ids,status,execution_stage_id FROM check_runs WHERE id=?")
        .get(runId) as { task_id: string; generation_id: string; owner: string; expected_check_ids: string; status: string; execution_stage_id: string } | undefined;
      if (!run || run.status !== "running") throw new Error(`Check run ${runId} is not running`);
      if (run.owner !== guard.owner || run.generation_id !== guard.generationId) throw new Error("Check result guard does not match the check run owner and generation");
      const task = this.#db.prepare("SELECT status,lease_owner,lease_expires_at,claim_generation_id FROM tasks WHERE id=?").get(run.task_id) as {
        status: TaskStatus; lease_owner: string | null; lease_expires_at: string | null; claim_generation_id: string | null;
      } | undefined;
      this.#assertReviewLease(task, guard.owner, guard.generationId);
      const stage = this.#db.prepare("SELECT status FROM stages WHERE id=? AND task_id=?").get(run.execution_stage_id, run.task_id) as { status: string } | undefined;
      if (!stage || stage.status !== "running") throw new Error("Check results can only be recorded while the execution stage is running");
      const expected = JSON.parse(run.expected_check_ids) as string[];
      if (!expected.includes(result.id)) throw new Error(`Unexpected check ID ${result.id}`);
      if (!result.id || !Array.isArray(result.argv) || !Number.isFinite(result.durationMs) || result.durationMs < 0) throw new Error("Invalid check result");
      try {
        this.#db.prepare("INSERT INTO check_run_results(run_id,check_id,at,result) VALUES(?,?,?,?)")
          .run(runId, result.id, at, JSON.stringify(result));
      } catch (error) {
        if (String(error).includes("UNIQUE constraint failed")) throw new Error(`Check ${result.id} already has a result in run ${runId}`);
        throw error;
      }
      this.#event(run.task_id, "check_run.result", { checkRunId: runId, result }, at);
    });
  }

  /** Closes an unsuccessful or superseded run while retaining all individual result rows. */
  finishCheckRun(runId: string, guard: CheckRunGuard, status: "failed" | "abandoned", reason: string): CheckRunRecord {
    if (!reason.trim()) throw new Error("A terminal check run requires a reason");
    const at = new Date().toISOString();
    this.#transaction(() => {
      const run = this.#db.prepare("SELECT task_id,generation_id,owner,status FROM check_runs WHERE id=?")
        .get(runId) as { task_id: string; generation_id: string; owner: string; status: string } | undefined;
      if (!run || run.status !== "running") throw new Error(`Check run ${runId} is not running`);
      if (run.owner !== guard.owner || run.generation_id !== guard.generationId) throw new Error("Check run guard does not match its owner and generation");
      const task = this.#db.prepare("SELECT status,lease_owner,lease_expires_at,claim_generation_id FROM tasks WHERE id=?").get(run.task_id) as {
        status: TaskStatus; lease_owner: string | null; lease_expires_at: string | null; claim_generation_id: string | null;
      } | undefined;
      this.#assertReviewLease(task, guard.owner, guard.generationId);
      const changed = this.#db.prepare("UPDATE check_runs SET status=?,terminal_reason=? WHERE id=? AND status='running'")
        .run(status, reason, runId);
      if (Number(changed.changes) !== 1) throw new Error(`Check run ${runId} changed before it was closed`);
      this.#event(run.task_id, "check_run.closed", { checkRunId: runId, status, reason }, at);
    });
    return this.getCheckRun(runId)!;
  }

  /** Atomically seals a complete passing run, creates its immutable review package, and enters reviewing. */
  completeCheckRun(runId: string, guard: CheckRunGuard, recheckedSnapshot: CheckRunSnapshot): { checkRun: CheckRunRecord; reviewPackage: ReviewPackageRecord } {
    let packageId = "";
    const completedAt = new Date().toISOString();
    this.#transaction(() => {
      const run = this.#db.prepare("SELECT * FROM check_runs WHERE id=?").get(runId) as Record<string, unknown> | undefined;
      if (!run || run.status !== "running") throw new Error(`Check run ${runId} is not running`);
      if (run.owner !== guard.owner || run.generation_id !== guard.generationId) throw new Error("Check run guard does not match its owner and generation");
      const task = this.#db.prepare("SELECT status,lease_owner,lease_expires_at,claim_generation_id,payload FROM tasks WHERE id=?").get(String(run.task_id)) as {
        status: TaskStatus; lease_owner: string | null; lease_expires_at: string | null; claim_generation_id: string | null; payload: string;
      } | undefined;
      this.#assertReviewLease(task, guard.owner, guard.generationId);
      const stage = this.#db.prepare("SELECT task_id,role,status,generation_id FROM stages WHERE id=?").get(String(run.execution_stage_id)) as {
        task_id: string; role: string; status: string; generation_id: string | null;
      } | undefined;
      if (!stage || stage.task_id !== run.task_id || !["implement", "revise"].includes(stage.role) || stage.status !== "succeeded" || stage.generation_id !== guard.generationId) {
        throw new Error("Check run can complete only after its linked execution stage succeeds in this generation");
      }
      const snapshot = JSON.parse(String(run.snapshot)) as CheckRunSnapshot;
      if (!sameSnapshot(snapshot, recheckedSnapshot)) throw new Error("Post-check snapshot does not match the check run snapshot");
      const submission = JSON.parse(task!.payload) as TaskSubmission;
      const expectedHash = createHash("sha256").update(JSON.stringify(submission.checks ?? []), "utf8").digest("hex");
      if (expectedHash !== run.check_definition_hash) throw new Error("Check definitions changed after the check run started");
      const expected = JSON.parse(String(run.expected_check_ids)) as string[];
      const rows = this.#db.prepare("SELECT check_id,result FROM check_run_results WHERE run_id=? ORDER BY id").all(runId) as { check_id: string; result: string }[];
      if (rows.length !== expected.length || !sameStringSet(rows.map(row => row.check_id), expected)) throw new Error("Check run does not have exactly one result for every expected check");
      const results = rows.map(row => JSON.parse(row.result) as CheckResult);
      if (results.some(result => result.status !== "passed")) throw new Error("Every expected check must pass before a review package can be created");
      packageId = randomUUID();
      const updated = this.#db.prepare("UPDATE check_runs SET status='completed',completed_at=? WHERE id=? AND status='running'").run(completedAt, runId);
      if (Number(updated.changes) !== 1) throw new Error("Check run changed before completion");
      this.#db.prepare(`INSERT INTO review_packages(id,task_id,check_run_id,execution_attempt_id,execution_stage_id,route_attempt_id,
        route,branch_ref,snapshot,check_definition_hash,expected_check_ids,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(packageId, String(run.task_id), runId, String(run.execution_attempt_id), String(run.execution_stage_id),
        String(run.route_attempt_id), String(run.route), String(run.branch_ref), String(run.snapshot), String(run.check_definition_hash), String(run.expected_check_ids), completedAt);
      const changed = this.#db.prepare(`UPDATE tasks SET status='reviewing',updated_at=?
        WHERE id=? AND status='running' AND lease_owner=? AND claim_generation_id=? AND lease_expires_at>?`)
        .run(completedAt, run.task_id, guard.owner, guard.generationId, completedAt);
      if (Number(changed.changes) !== 1) throw new Error("Task lease or generation changed before review package creation");
      this.#event(String(run.task_id), "check_run.completed", { checkRunId: runId, reviewPackageId: packageId, results }, completedAt);
      this.#event(String(run.task_id), "review_package.created", { reviewPackageId: packageId, checkRunId: runId }, completedAt);
      this.#event(String(run.task_id), "task.transition", { from: ["running"], to: "reviewing", reason: "checks completed with an immutable review package" }, completedAt);
    });
    return { checkRun: this.getCheckRun(runId)!, reviewPackage: this.getReviewPackage(packageId)! };
  }

  getCheckRun(runId: string): CheckRunRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM check_runs WHERE id=?").get(runId) as Record<string, unknown> | undefined;
    return row ? this.#checkRun(row) : undefined;
  }

  checkRuns(taskId: string): CheckRunRecord[] {
    return (this.#db.prepare("SELECT * FROM check_runs WHERE task_id=? ORDER BY created_at,id").all(taskId) as Record<string, unknown>[])
      .map(row => this.#checkRun(row));
  }

  checkRunResults(runId: string): CheckResult[] {
    return (this.#db.prepare("SELECT result FROM check_run_results WHERE run_id=? ORDER BY id").all(runId) as { result: string }[])
      .map(row => JSON.parse(row.result) as CheckResult);
  }

  getReviewPackage(packageId: string): ReviewPackageRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM review_packages WHERE id=?").get(packageId) as Record<string, unknown> | undefined;
    return row ? this.#reviewPackage(row) : undefined;
  }

  reviewPackages(taskId: string): ReviewPackageRecord[] {
    return (this.#db.prepare("SELECT * FROM review_packages WHERE task_id=? ORDER BY created_at,id").all(taskId) as Record<string, unknown>[])
      .map(row => this.#reviewPackage(row));
  }

  #validateReviewEvidence(snapshot: CheckRunSnapshot, route: RouteDecision, expectedCheckIds: string[], checkDefinitionHash: string): void {
    if (!snapshot || ![snapshot.baseCommit, snapshot.preHead, snapshot.treeId, snapshot.fingerprint].every(value => typeof value === "string" && value.length > 0)) {
      throw new Error("Review snapshot requires baseCommit, preHead, treeId, and fingerprint");
    }
    if (typeof snapshot.diff !== "string") throw new Error("Review snapshot diff must be a string");
    if (!SHA256_PATTERN.test(snapshot.diffHash) || createHash("sha256").update(snapshot.diff, "utf8").digest("hex") !== snapshot.diffHash) {
      throw new Error("Review diff hash does not match the persisted diff bytes");
    }
    if (!SHA256_PATTERN.test(checkDefinitionHash)) throw new Error("Check definition hash must be a SHA-256 digest");
    if (!Array.isArray(expectedCheckIds) || expectedCheckIds.some(id => typeof id !== "string" || !id.trim()) || new Set(expectedCheckIds).size !== expectedCheckIds.length) {
      throw new Error("Expected check IDs must be unique nonempty strings");
    }
    const routeBytes = Buffer.byteLength(JSON.stringify(route), "utf8");
    if (routeBytes > 65_536 || Buffer.byteLength(JSON.stringify(expectedCheckIds), "utf8") > 65_536) {
      throw new Error("Review route or check ID evidence exceeds the persisted evidence limit");
    }
    if (Buffer.byteLength(snapshot.diff, "utf8") > MAX_REVIEW_DIFF_BYTES) throw new Error(`Review diff exceeds ${MAX_REVIEW_DIFF_BYTES} bytes`);
  }

  #assertReviewLease(task: { status: TaskStatus; lease_owner: string | null; lease_expires_at: string | null; claim_generation_id: string | null } | undefined,
    owner: string, generationId: string): void {
    const expiresAt = task?.lease_expires_at ? Date.parse(task.lease_expires_at) : Number.NaN;
    if (!task || task.status !== "running" || task.lease_owner !== owner || task.claim_generation_id !== generationId || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error(`Task is not running under live owner ${owner} and generation ${generationId}`);
    }
  }

  #checkRun(row: Record<string, unknown>): CheckRunRecord {
    return { id: String(row.id), taskId: String(row.task_id), generationId: String(row.generation_id), owner: String(row.owner),
      executionAttemptId: String(row.execution_attempt_id), executionStageId: String(row.execution_stage_id), routeAttemptId: String(row.route_attempt_id),
      route: JSON.parse(String(row.route)) as RouteDecision, branchRef: String(row.branch_ref),
      snapshot: JSON.parse(String(row.snapshot)) as CheckRunSnapshot, checkDefinitionHash: String(row.check_definition_hash),
      expectedCheckIds: JSON.parse(String(row.expected_check_ids)) as string[], status: row.status as CheckRunRecord["status"],
      createdAt: String(row.created_at), completedAt: row.completed_at as string | null ?? undefined,
      terminalReason: row.terminal_reason as string | null ?? undefined };
  }

  #reviewPackage(row: Record<string, unknown>): ReviewPackageRecord {
    return { id: String(row.id), taskId: String(row.task_id), checkRunId: String(row.check_run_id),
      executionAttemptId: String(row.execution_attempt_id), executionStageId: String(row.execution_stage_id), routeAttemptId: String(row.route_attempt_id),
      route: JSON.parse(String(row.route)) as RouteDecision, branchRef: String(row.branch_ref),
      snapshot: JSON.parse(String(row.snapshot)) as CheckRunSnapshot, checkDefinitionHash: String(row.check_definition_hash),
      expectedCheckIds: JSON.parse(String(row.expected_check_ids)) as string[], createdAt: String(row.created_at) };
  }

  events(taskId: string): TaskEvent[] {
    return (this.#db.prepare("SELECT * FROM events WHERE task_id=? ORDER BY id").all(taskId) as { id: number; task_id: string; type: string; at: string; payload: string | null }[])
      .map(row => ({ id: row.id, taskId: row.task_id, type: row.type, at: row.at, payload: decode(row.payload) }));
  }

  #event(taskId: string, type: string, payload?: unknown, at = new Date().toISOString()): void {
    this.#db.prepare("INSERT INTO events(task_id,type,at,payload) VALUES(?,?,?,?)").run(taskId, type, at, encode(payload));
  }

  #task(row: TaskRow): TaskRecord {
    const quota = this.#db.prepare("SELECT retry_at,checkpoint,retry_count FROM quota_pauses WHERE task_id=?").get(row.id) as { retry_at: string; checkpoint: string; retry_count: number } | undefined;
    return { ...(JSON.parse(row.payload) as TaskSubmission), id: row.id, status: row.status, createdAt: row.created_at,
      updatedAt: row.updated_at, revisionCount: row.revision_count, leaseOwner: row.lease_owner ?? undefined,
      leaseExpiresAt: row.lease_expires_at ?? undefined, heartbeatAt: row.heartbeat_at ?? undefined,
      claimGenerationId: row.claim_generation_id ?? undefined,
      failureReason: row.failure_reason ?? undefined, activeAttemptId: row.active_attempt_id ?? undefined,
      recoveryReason: row.recovery_reason ?? undefined,
      recoveryEvidence: row.recovery_evidence ? JSON.parse(row.recovery_evidence) as Record<string, unknown> : undefined,
      ...(quota ? { retryAt: quota.retry_at, resumeCheckpoint: JSON.parse(quota.checkpoint) as Record<string, unknown>, quotaRetryCount: quota.retry_count,
        ...(typeof (JSON.parse(quota.checkpoint) as Record<string, unknown>).stage === "string" ? { resumeStage: (JSON.parse(quota.checkpoint) as Record<string, unknown>).stage as TaskRecord["resumeStage"] } : {}) } : {}),
      route: this.getRoute(row.id) };
  }

  #attempt(row: Record<string, unknown>): Attempt {
    return { id: String(row.id), taskId: String(row.task_id), sequence: Number(row.sequence), role: row.role as Attempt["role"],
      stageId: row.stage_id as string | null ?? undefined, status: row.status as Attempt["status"], harness: row.harness as string | null ?? undefined,
      model: row.model as string | null ?? undefined, reasoningEffort: row.reasoning_effort as string | null ?? undefined,
      startedAt: String(row.started_at), finishedAt: row.finished_at as string | null ?? undefined,
      exitCode: row.exit_code as number | null ?? undefined, stdoutPath: row.stdout_path as string | null ?? undefined,
      stderrPath: row.stderr_path as string | null ?? undefined, resultPath: row.result_path as string | null ?? undefined,
      error: row.error as string | null ?? undefined, metadata: decode(row.metadata as string | null) };
  }

  #stage(row: StageRow): StageRecord {
    return {
      id: String(row.id), taskId: String(row.task_id), sequence: Number(row.sequence),
      role: row.role as StageRole, status: row.status as StageStatus,
      predecessorStageId: row.predecessor_stage_id as string | null ?? undefined,
      harness: row.harness as string | null ?? undefined, harnessVersion: row.harness_version as string | null ?? undefined,
      model: row.model as string | null ?? undefined,
      reasoningEffort: row.reasoning_effort as string | null ?? undefined,
      bindingVersion: row.binding_version as string | null ?? undefined,
      configHash: row.config_hash as string | null ?? undefined,
      processStartId: String(row.process_start_id),
      generationId: row.generation_id as string | null ?? undefined,
      inputFingerprint: row.input_fingerprint as string | null ?? undefined,
      outputFingerprint: row.output_fingerprint as string | null ?? undefined,
      error: row.error as string | null ?? undefined,
      createdAt: String(row.created_at), startedAt: row.started_at as string | null ?? undefined,
      finishedAt: row.finished_at as string | null ?? undefined,
    };
  }

  #handoff(row: HandoffRow): HandoffRecord {
    if (row.schema_version !== 1) throw new Error(`Unsupported persisted handoff schema version ${row.schema_version}`);
    const handoff = parseHandoffV1(JSON.parse(row.payload) as unknown);
    if (handoff.taskId !== row.task_id || handoff.stageId !== row.stage_id || handoff.source.attemptId !== row.attempt_id) {
      throw new Error(`Persisted handoff ${row.id} provenance does not match its indexed columns`);
    }
    return { ...handoff, id: row.id, byteLength: row.payload_bytes };
  }
}

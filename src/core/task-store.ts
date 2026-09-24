import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  Attempt,
  CheckResult,
  ReviewResult,
  RouteDecision,
  TaskEvent,
  TaskRecord,
  TaskStatus,
  TaskSubmission,
} from "../domain/types.js";

type Json = string | null;
type TaskRow = {
  id: string; status: TaskStatus; created_at: string; updated_at: string;
  payload: string; revision_count: number; lease_owner: string | null;
  lease_expires_at: string | null; heartbeat_at: string | null;
  failure_reason: string | null; active_attempt_id: string | null;
  retry_at?: string | null;
};

const encode = (v: unknown): Json => v === undefined ? null : JSON.stringify(v);
const decode = <T>(v: string | null): T | undefined => v === null ? undefined : JSON.parse(v) as T;

/** SQLite-backed source of truth. Methods are synchronous and each state change is transactional. */
export class TaskStore {
  readonly #db: DatabaseSync;

  constructor(path = ":memory:") {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        payload TEXT NOT NULL, revision_count INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT, lease_expires_at TEXT, heartbeat_at TEXT,
        failure_reason TEXT, active_attempt_id TEXT
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
      CREATE TABLE IF NOT EXISTS routes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
        decided_at TEXT NOT NULL, decision TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
        attempt_id TEXT, check_id TEXT NOT NULL, at TEXT NOT NULL, result TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
        attempt_id TEXT, at TEXT NOT NULL, result TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quota_pauses (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id), retry_at TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0, checkpoint TEXT NOT NULL, reason TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'fallback'
      );
    `);
  }

  close(): void { this.#db.close(); }

  #transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.#db.exec("COMMIT"); return result; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  submit(submission: TaskSubmission, id: string = randomUUID()): TaskRecord {
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
      const result = this.#db.prepare(`UPDATE tasks SET status='running', updated_at=?, lease_owner=?, lease_expires_at=?, heartbeat_at=?
        WHERE id=? AND status IN ('pending','waiting')`).run(at, owner, expires, at, row.id);
      if (Number(result.changes) !== 1) { this.#db.exec("ROLLBACK"); return undefined; }
      this.#event(row.id, "task.claimed", { owner, leaseExpiresAt: expires }, at);
      this.#db.exec("COMMIT");
      return this.get(row.id);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
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
      if (next === "done" || next === "failed") this.#db.prepare("DELETE FROM quota_pauses WHERE task_id=?").run(id);
      this.#event(id, "task.transition", { from: expectedList, to: next, reason: options.reason }, at);
    });
    const task = this.get(id);
    if (!task) throw new Error(`Task ${id} disappeared`);
    return task;
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

  /** Expired leases are returned to pending; the orchestrator must inspect old processes and worktrees before retrying. */
  recoverExpired(now = new Date()): string[] {
    const at = now.toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.#db.prepare(`SELECT id, active_attempt_id FROM tasks
        WHERE status IN ('running','reviewing','revision') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`).all(at) as { id: string; active_attempt_id: string | null }[];
      for (const row of rows) {
        this.#db.prepare(`UPDATE tasks SET status='pending', updated_at=?, lease_owner=NULL, lease_expires_at=NULL,
          heartbeat_at=NULL, active_attempt_id=NULL WHERE id=?`).run(at, row.id);
        if (row.active_attempt_id) this.#db.prepare("UPDATE attempts SET status='interrupted', finished_at=?, error=COALESCE(error,'lease expired') WHERE id=? AND status='running'").run(at, row.active_attempt_id);
        this.#event(row.id, "task.lease_expired", { previousAttemptId: row.active_attempt_id }, at);
      }
      this.#db.exec("COMMIT");
      return rows.map(row => row.id);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  createAttempt(taskId: string, role: Attempt["role"], options: { owner?: string; harness?: string; model?: string; reasoningEffort?: string; metadata?: Record<string, unknown> } = {}): Attempt {
    const task = this.get(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    if (options.owner !== undefined && task.leaseOwner !== options.owner) throw new Error(`Task ${taskId} is not leased by ${options.owner}`);
    let attempt!: Attempt;
    this.#transaction(() => {
      const active = this.#db.prepare("SELECT id FROM attempts WHERE task_id=? AND status='running' LIMIT 1").get(taskId);
      if (active) throw new Error(`Task ${taskId} already has a running attempt`);
      const sequence = Number((this.#db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM attempts WHERE task_id=?").get(taskId) as { n: number }).n);
      attempt = { id: randomUUID(), taskId, sequence, role, status: "running", harness: options.harness,
        model: options.model, reasoningEffort: options.reasoningEffort, startedAt: new Date().toISOString(), metadata: options.metadata };
      this.#db.prepare(`INSERT INTO attempts(id,task_id,sequence,role,status,harness,model,reasoning_effort,started_at,metadata)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(attempt.id, taskId, sequence, role, "running", attempt.harness ?? null,
        attempt.model ?? null, attempt.reasoningEffort ?? null, attempt.startedAt, encode(attempt.metadata));
      this.#db.prepare("UPDATE tasks SET active_attempt_id=? WHERE id=?").run(attempt.id, taskId);
      this.#event(taskId, "attempt.started", { attempt }, attempt.startedAt);
    });
    return attempt;
  }

  finishAttempt(id: string, result: Partial<Attempt> & { status: Attempt["status"] }): Attempt {
    return this.#transaction(() => {
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
      failureReason: row.failure_reason ?? undefined, activeAttemptId: row.active_attempt_id ?? undefined,
      ...(quota ? { retryAt: quota.retry_at, resumeCheckpoint: JSON.parse(quota.checkpoint) as Record<string, unknown>, quotaRetryCount: quota.retry_count,
        ...(typeof (JSON.parse(quota.checkpoint) as Record<string, unknown>).stage === "string" ? { resumeStage: (JSON.parse(quota.checkpoint) as Record<string, unknown>).stage as TaskRecord["resumeStage"] } : {}) } : {}),
      route: this.getRoute(row.id) };
  }

  #attempt(row: Record<string, unknown>): Attempt {
    return { id: String(row.id), taskId: String(row.task_id), sequence: Number(row.sequence), role: row.role as Attempt["role"],
      status: row.status as Attempt["status"], harness: row.harness as string | null ?? undefined,
      model: row.model as string | null ?? undefined, reasoningEffort: row.reasoning_effort as string | null ?? undefined,
      startedAt: String(row.started_at), finishedAt: row.finished_at as string | null ?? undefined,
      exitCode: row.exit_code as number | null ?? undefined, stdoutPath: row.stdout_path as string | null ?? undefined,
      stderrPath: row.stderr_path as string | null ?? undefined, resultPath: row.result_path as string | null ?? undefined,
      error: row.error as string | null ?? undefined, metadata: decode(row.metadata as string | null) };
  }
}

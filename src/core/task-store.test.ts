import test from "node:test";
import assert from "node:assert/strict";
import { TaskStore } from "./task-store.js";
import type { TaskSubmission } from "../domain/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

test("expired active lease requires inspection and retains interrupted attempt evidence", () => {
  const store = new TaskStore();
  try {
    const task = store.submit({ repoPath: "C:/repo", baseRef: "main", prompt: "make a change" }, "queue_test");
    assert.equal(task.status, "pending");
    const now = new Date("2026-01-01T00:00:00.000Z");
    const claimed = store.claimNext("worker-a", 1000, now);
    assert.equal(claimed?.status, "running");
    assert.equal(store.claimNext("worker-b", 1000, now), undefined);
    const attempt = store.createAttempt(task.id, "implement", { owner: "worker-a" });
    assert.deepEqual(store.recoverExpired(new Date("2026-01-01T00:00:02.000Z")), [task.id]);
    assert.equal(store.get(task.id)?.status, "recovery_required");
    assert.equal(store.attempts(task.id)[0]?.status, "interrupted");
    assert.equal(store.get(task.id)?.activeAttemptId, undefined);
    assert.equal(store.get(task.id)?.recoveryEvidence?.kind, "lease_expiry");
    assert.ok(store.events(task.id).some(e => e.type === "task.lease_expired"));
    assert.equal(store.get(task.id)?.recoveryEvidence?.activeAttemptId, attempt.id);
    assert.match(store.get(task.id)?.recoveryReason ?? "", /lease expired/);
    assert.equal(store.claimNext("worker-c"), undefined);
    assert.throws(() => store.requeuePreWriteIntentLeaseExpiry(task.id, { kind: "worktree_absent", checkedAt: new Date().toISOString() }), /persisted work evidence/);
    assert.equal(attempt.id, store.attempts(task.id)[0]?.id);
  } finally { store.close(); }
});

test("lease expiry with no write intent can be requeued only through the guarded evidence path", () => {
  const store = new TaskStore();
  try {
    const task = store.submit({ repoPath: "C:/repo", baseRef: "main", prompt: "make a change" }, "prewrite_requeue");
    store.claimNext("worker-a", 1000, new Date("2026-01-01T00:00:00.000Z"));
    assert.deepEqual(store.recoverExpired(new Date("2026-01-01T00:00:02.000Z")), [task.id]);
    assert.equal(store.get(task.id)?.recoveryEvidence?.claimProtocolVersion, 2);
    assert.deepEqual(store.listLeaseExpiryRecoveryCandidates().map(candidate => candidate.id), [task.id]);
    assert.throws(() => store.transition(task.id, "recovery_required", "pending"), /Illegal task state transition/);
    assert.throws(() => store.requeuePreWriteIntentLeaseExpiry(task.id, { kind: "worktree_absent", checkedAt: new Date(Date.now() - 60_000).toISOString() }), /Fresh worktree absence/);
    const requeued = store.requeuePreWriteIntentLeaseExpiry(task.id, { kind: "worktree_absent", checkedAt: new Date().toISOString() });
    assert.equal(requeued.status, "pending");
    assert.equal(requeued.recoveryEvidence, undefined);
    assert.ok(store.events(task.id).some(event => event.type === "task.requeued_pre_write_intent"));
    assert.throws(() => store.recordWorktreeCreationIntent(task.id, "worker-a", { path: "C:/worktrees/prewrite_requeue" }), /not actively leased/);
    store.claimNext("worker-b");
    assert.throws(() => store.recordWorktreeCreationIntent(task.id, "worker-a", { path: "C:/worktrees/prewrite_requeue" }), /not actively leased/);
    assert.doesNotThrow(() => store.recordWorktreeCreationIntent(task.id, "worker-b", { path: "C:/worktrees/prewrite_requeue" }));
  } finally { store.close(); }
});

test("restart before lease expiry preserves active work and later scan quarantines it", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-recovery-store-"));
  const path = join(root, "tasks.sqlite");
  let store = new TaskStore(path);
  const task = store.submit({ repoPath: ".", baseRef: "main", prompt: "active task" }, "restart_before_expiry");
  const claimedAt = new Date("2026-01-01T00:00:00.000Z");
  store.claimNext("old-worker", 60_000, claimedAt);
  store.close();
  try {
    store = new TaskStore(path);
    assert.deepEqual(store.recoverExpired(new Date("2026-01-01T00:00:30.000Z")), []);
    assert.equal(store.get(task.id)?.status, "running");
    assert.deepEqual(store.recoverExpired(new Date("2026-01-01T00:01:01.000Z")), [task.id]);
    assert.equal(store.get(task.id)?.status, "recovery_required");
    assert.equal(store.claimNext("new-worker"), undefined);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("startup generation is attached to claims and stage starts without enabling replay", () => {
  const generationId = "0123456789abcdef0123456789abcdef";
  const store = new TaskStore(":memory:", { id: generationId, lockId: "a".repeat(64), predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    const task = store.submit({ repoPath: ".", baseRef: "main", prompt: "lineage" }, "generation_test");
    const claimed = store.claimNext("lineage-worker");
    assert.equal(claimed?.claimGenerationId, generationId);
    const claimEvent = store.events(task.id).find(event => event.type === "task.claimed");
    assert.equal((claimEvent?.payload as { generationId?: string } | undefined)?.generationId, generationId);
    const stage = store.createStage(task.id, { role: "implement", processStartId: "process-1" });
    const started = store.startStage(stage.id, "lineage-worker", "process-1");
    assert.equal(started.generationId, generationId);
    assert.equal(store.startupGeneration().predecessorDrained, true);
    assert.equal(store.get(task.id)?.status, "running");
  } finally { store.close(); }
});

test("startup generation cannot mark predecessor drained without guardian startup proof", () => {
  assert.throws(() => new TaskStore(":memory:", {
    id: "invalid-generation", lockId: "a".repeat(64), predecessorDrained: true, evidenceKind: "guardian_env_assertion",
  }), /drained predecessor requires a guardian startup proof/);
  const memberOnly = new TaskStore(":memory:", { id: "member-only", lockId: "a".repeat(64), predecessorDrained: false, evidenceKind: "guardian_env_assertion" });
  try {
    assert.equal(memberOnly.startupGeneration().predecessorDrained, false);
    assert.equal(memberOnly.currentStartupProvesGenerationDrained("member-only"), false);
  } finally { memberOnly.close(); }
  const store = new TaskStore(":memory:", { id: "unguarded-generation", predecessorDrained: false, evidenceKind: "unguarded" });
  try {
    assert.equal(store.startupGeneration().predecessorDrained, false);
    assert.equal(store.startupGeneration().evidenceKind, "unguarded");
  } finally { store.close(); }
});

test("startup generation lineage survives reopening an existing database", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-startup-generation-"));
  const path = join(root, "tasks.sqlite");
  const generationId = "abcdefabcdefabcdefabcdefabcdefab";
  let store = new TaskStore(path, { id: generationId, lockId: "b".repeat(64), predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  const task = store.submit({ repoPath: ".", baseRef: "main", prompt: "persist lineage" }, "generation_persist_test");
  store.claimNext("persist-worker");
  const stage = store.createStage(task.id, { role: "implement", processStartId: "persist-process" });
  store.startStage(stage.id, "persist-worker", "persist-process");
  store.close();
  try {
    store = new TaskStore(path);
    assert.equal(store.startupGeneration().sequence, 2);
    assert.equal(store.startupGeneration().predecessorGenerationId, undefined);
    assert.equal(store.get(task.id)?.claimGenerationId, generationId);
    assert.equal(store.stages(task.id)[0]?.generationId, generationId);
    assert.equal(store.events(task.id).find(event => event.type === "task.claimed")?.payload &&
      (store.events(task.id).find(event => event.type === "task.claimed")?.payload as { generationId?: string }).generationId, generationId);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a verified drained startup directly links only the immediately previous verified guardian generation", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-generation-direct-link-"));
  const path = join(root, "lineage.sqlite");
  const lockId = "d".repeat(64);
  const firstId = "11111111111111111111111111111111";
  const secondId = "22222222222222222222222222222222";
  let store = new TaskStore(path, { id: firstId, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    assert.equal(store.startupGeneration().predecessorGenerationId, undefined);
    assert.equal(store.currentStartupProvesGenerationDrained(firstId), false);
    store.close();
    store = new TaskStore(path, { id: secondId, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    assert.equal(store.startupGeneration().sequence, 2);
    assert.equal(store.startupGeneration().predecessorGenerationId, firstId);
    assert.equal(store.currentStartupProvesGenerationDrained(firstId), true);
    assert.equal(store.currentStartupProvesGenerationDrained(secondId), false);
    assert.equal(store.currentStartupProvesGenerationDrained("33333333333333333333333333333333"), false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("unguarded, unverified, empty and lock-mismatched startup generations never link", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-generation-reject-link-"));
  const path = join(root, "lineage.sqlite");
  const lockA = "a".repeat(64);
  const lockB = "b".repeat(64);
  const id = (digit: string) => digit.repeat(32);
  let store = new TaskStore(path, { id: id("1"), lockId: lockA, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    store.close();
    store = new TaskStore(path, { id: id("2"), lockId: lockB, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    assert.equal(store.startupGeneration().predecessorGenerationId, undefined);
    assert.equal(store.currentStartupProvesGenerationDrained(id("1")), false);
    store.close();
    store = new TaskStore(path);
    assert.equal(store.startupGeneration().predecessorGenerationId, undefined);
    assert.equal(store.currentStartupProvesGenerationDrained(id("2")), false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }

  const empty = new TaskStore(":memory:", { id: id("3"), lockId: lockA, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    assert.equal(empty.startupGeneration().sequence, 1);
    assert.equal(empty.startupGeneration().predecessorGenerationId, undefined);
    assert.equal(empty.currentStartupProvesGenerationDrained(id("1")), false);
  } finally { empty.close(); }
});

test("legacy generations default to unverified and cannot become a direct predecessor after migration", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-generation-migration-"));
  const path = join(root, "legacy.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE startup_generations (
    id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, lock_id TEXT, predecessor_drained INTEGER NOT NULL,
    member_verified INTEGER NOT NULL DEFAULT 0, evidence_kind TEXT NOT NULL, predecessor_generation_id TEXT, started_at TEXT NOT NULL
  )`);
  legacy.prepare(`INSERT INTO startup_generations(id,sequence,lock_id,predecessor_drained,member_verified,evidence_kind,started_at)
    VALUES(?,?,?,?,?,?,?)`).run("legacy-generation", 1, "c".repeat(64), 1, 1, "guardian_env_assertion", "2026-01-01T00:00:00.000Z");
  legacy.close();
  const currentId = "44444444444444444444444444444444";
  const store = new TaskStore(path, { id: currentId, lockId: "c".repeat(64), predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    const migrated = new DatabaseSync(path);
    try {
      const row = migrated.prepare("SELECT member_verified FROM startup_generations WHERE id='legacy-generation'").get() as { member_verified: number };
      assert.equal(row.member_verified, 1);
    } finally { migrated.close(); }
    assert.equal(store.startupGeneration().predecessorGenerationId, undefined);
    assert.equal(store.currentStartupProvesGenerationDrained("legacy-generation"), false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent guarded generation inserts serialize and link to the adjacent inserted generation", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-generation-concurrent-"));
  const path = join(root, "lineage.sqlite");
  const lockId = "e".repeat(64);
  const seedId = "55555555555555555555555555555555";
  const seed = new TaskStore(path, { id: seedId, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  seed.close();
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      try {
        const { TaskStore } = await import(workerData.moduleUrl);
        const store = new TaskStore(workerData.path, { id: workerData.id, lockId: workerData.lockId, predecessorDrained: true, evidenceKind: 'guardian_startup_verified' });
        parentPort.postMessage(store.startupGeneration());
        store.close();
      } catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
    })();
  `;
  const moduleUrl = new URL("./task-store.js", import.meta.url).href;
  const start = (generationId: string) => new Promise<{ id: string; sequence: number; predecessorGenerationId?: string }>((resolve, reject) => {
    const worker = new Worker(workerSource, { eval: true, workerData: { moduleUrl, path, id: generationId, lockId } });
    worker.once("message", value => {
      if (value?.error) reject(new Error(value.error));
      else resolve(value);
    });
    worker.once("error", reject);
    worker.once("exit", code => { if (code !== 0) reject(new Error(`generation worker exited with code ${code}`)); });
  });
  try {
    const [left, right] = await Promise.all([start("66666666666666666666666666666666"), start("77777777777777777777777777777777")]);
    const ordered = [left, right].sort((a, b) => a.sequence - b.sequence);
    assert.deepEqual(ordered.map(item => item.sequence), [2, 3]);
    assert.equal(ordered[0]?.predecessorGenerationId, seedId);
    assert.equal(ordered[1]?.predecessorGenerationId, ordered[0]?.id);
    const check = new TaskStore(path);
    try {
      assert.equal(check.startupGeneration().sequence, 4);
      assert.equal(check.startupGeneration().predecessorGenerationId, undefined);
      assert.equal(check.currentStartupProvesGenerationDrained(ordered[1]!.id), false);
    } finally { check.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("same-account SQLite edits can alter lineage assertions; this API is not an anti-tamper boundary", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-generation-tamper-boundary-"));
  const path = join(root, "lineage.sqlite");
  const lockId = "f".repeat(64);
  const oldId = "88888888888888888888888888888888";
  const currentId = "99999999999999999999999999999999";
  let store = new TaskStore(path, { id: oldId, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  store.close();
  store = new TaskStore(path, { id: currentId, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    assert.equal(store.currentStartupProvesGenerationDrained(oldId), true);
    const editor = new DatabaseSync(path);
    try { editor.prepare("UPDATE startup_generations SET predecessor_drained=0 WHERE id=?").run(currentId); }
    finally { editor.close(); }
    assert.equal(store.currentStartupProvesGenerationDrained(oldId), false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("migration keeps legacy guardian generations unverified by default", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-generation-migration-"));
  const path = join(root, "legacy.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE startup_generations (
    id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, lock_id TEXT, predecessor_drained INTEGER NOT NULL,
    evidence_kind TEXT NOT NULL, predecessor_generation_id TEXT, started_at TEXT NOT NULL
  )`);
  legacy.prepare(`INSERT INTO startup_generations(id,sequence,lock_id,predecessor_drained,evidence_kind,started_at)
    VALUES(?,?,?,?,?,?)`).run("legacy-generation", 1, "c".repeat(64), 1, "guardian_env_assertion", "2026-01-01T00:00:00.000Z");
  legacy.close();
  const store = new TaskStore(path);
  try {
    const migrated = new DatabaseSync(path);
    try {
      const row = migrated.prepare("SELECT member_verified FROM startup_generations WHERE id='legacy-generation'").get() as { member_verified: number };
      assert.equal(row.member_verified, 0);
    } finally { migrated.close(); }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("worktree creation intent survives ambiguous failure and successful creation records observed identity", () => {
  const store = new TaskStore();
  try {
    const failed = store.submit({ repoPath: "C:/repo", baseRef: "main", prompt: "create" }, "intent_failure");
    store.claimNext("worker-a");
    const plan = { taskId: failed.id, repoPath: "C:/repo", commonGitDir: "C:/repo/.git", path: "C:/worktrees/intent_failure",
      branch: `zero/${failed.id}`, baseCommit: "a".repeat(40) };
    store.recordWorktreeCreationIntent(failed.id, "worker-a", plan);
    // Models a Git add that throws after possibly registering external Git state.
    const quarantined = store.requireWorktreeRecovery(failed.id, "worker-a", "git worktree add failed", { phase: "execute_or_observe" });
    assert.equal(store.getWorktreeCreation(failed.id)?.status, "intent");
    assert.equal(quarantined.status, "recovery_required");
    assert.equal(store.claimNext("worker-b"), undefined);
    assert.throws(() => store.requeuePreWriteIntentLeaseExpiry(failed.id, { kind: "worktree_absent", checkedAt: new Date().toISOString() }), /not an eligible lease-expiry/);

    const succeeded = store.submit({ repoPath: "C:/repo", baseRef: "main", prompt: "create" }, "intent_success");
    store.claimNext("worker-c");
    const successPlan = { ...plan, taskId: succeeded.id, path: `C:/worktrees/${succeeded.id}`, branch: `zero/${succeeded.id}` };
    store.recordWorktreeCreationIntent(succeeded.id, "worker-c", successPlan);
    const observed = { info: { taskId: succeeded.id, path: successPlan.path, branch: successPlan.branch, baseCommit: successPlan.baseCommit },
      commonGitDir: successPlan.commonGitDir, head: successPlan.baseCommit };
    assert.throws(() => store.completeWorktreeCreation(succeeded.id, "other-worker", observed, "b".repeat(64)), /not actively leased/);
    assert.equal(store.getWorktreeCreation(succeeded.id)?.status, "intent");
    const created = store.completeWorktreeCreation(succeeded.id, "worker-c", observed, "b".repeat(64));
    assert.equal(created.status, "created");
    assert.deepEqual(created.observed, observed);
    assert.equal(created.fingerprint, "b".repeat(64));
    assert.ok(created.createdAt);
  } finally { store.close(); }
});

test("additive recovery migration preserves existing SQLite task rows", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-recovery-migration-"));
  const path = join(root, "legacy.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    payload TEXT NOT NULL, revision_count INTEGER NOT NULL DEFAULT 0, lease_owner TEXT,
    lease_expires_at TEXT, heartbeat_at TEXT, failure_reason TEXT, active_attempt_id TEXT
  )`);
  legacy.prepare("INSERT INTO tasks(id,status,created_at,updated_at,payload) VALUES(?,?,?,?,?)")
    .run("legacy_task", "pending", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", JSON.stringify({ repoPath: ".", baseRef: "main", prompt: "preserve me" }));
  legacy.prepare("INSERT INTO tasks(id,status,created_at,updated_at,payload,lease_owner,lease_expires_at,heartbeat_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("legacy_active", "running", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
      JSON.stringify({ repoPath: ".", baseRef: "main", prompt: "may have written without an intent" }),
      "old-binary-worker", "2026-01-01T00:00:01.000Z", "2026-01-01T00:00:00.000Z");
  legacy.close();
  const store = new TaskStore(path);
  try {
    assert.equal(store.get("legacy_task")?.claimGenerationId, undefined);
    const existing = store.get("legacy_task");
    assert.equal(existing?.status, "pending");
    assert.equal(existing?.prompt, "preserve me");
    assert.equal(existing?.recoveryReason, undefined);
    assert.deepEqual(store.recoverExpired(new Date("2026-01-01T00:00:02.000Z")), ["legacy_active"]);
    assert.equal(store.get("legacy_active")?.status, "recovery_required");
    assert.equal(store.get("legacy_active")?.recoveryEvidence?.claimProtocolVersion, null);
    assert.deepEqual(store.listLeaseExpiryRecoveryCandidates(), []);
    assert.throws(() => store.requeuePreWriteIntentLeaseExpiry("legacy_active", { kind: "worktree_absent", checkedAt: new Date().toISOString() }), /not an eligible lease-expiry/);
    const migrated = new DatabaseSync(path);
    try {
      const checkpointTable = migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_recovery_checkpoints'").get();
      assert.ok(checkpointTable);
      assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM execution_recovery_checkpoints").get() &&
        (migrated.prepare("SELECT COUNT(*) AS count FROM execution_recovery_checkpoints").get() as { count: number }).count, 0);
    } finally { migrated.close(); }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("task transitions reject illegal shortcuts and record only committed state changes", () => {
  const store = new TaskStore();
  try {
    const task = store.submit({ repoPath: ".", baseRef: "main", prompt: "x" }, "state_test");
    assert.throws(() => store.transition(task.id, "pending", "done"), /Illegal task state transition/);
    assert.equal(store.get(task.id)?.status, "pending");
    assert.equal(store.events(task.id).filter(e => e.type === "task.transition").length, 0);
    store.transition(task.id, "pending", "running");
    store.transition(task.id, "running", "reviewing");
    store.transition(task.id, "reviewing", "done");
    assert.equal(store.get(task.id)?.status, "done");
  } finally { store.close(); }
});

test("execution stage submissions reject an empty stage list and persist valid stage selections", () => {
  const store = new TaskStore();
  try {
    assert.throws(() => store.submit({ repoPath: ".", baseRef: "main", prompt: "x", executionStages: [] }), /1 to 16 execution stages/);
    assert.throws(() => store.submit({ repoPath: ".", baseRef: "main", prompt: "x", executionStages: Array.from({ length: 17 }, () => ({})) }), /1 to 16 execution stages/);
    assert.throws(() => store.submit({ repoPath: ".", baseRef: "main", prompt: "x", executionStages: [{ provider: "unknown" }] } as unknown as TaskSubmission), /supported selection field/);
    const submission = { repoPath: ".", baseRef: "main", prompt: "x", executionStages: [{ harness: "glm" }, { model: "deepseek-chat" }] };
    const task = store.submit(submission, "execution_stages_store_test");
    assert.deepEqual(task.executionStages, submission.executionStages);
    assert.deepEqual(store.get(task.id)?.executionStages, submission.executionStages);
  } finally { store.close(); }
});

test("attempt completion persists the final reviewer Harness, model, effort, and artifacts", () => {
  const store = new TaskStore();
  try {
    const task = store.submit({ repoPath: ".", baseRef: "main", prompt: "review" }, "review_attempt_test");
    const attempt = store.createAttempt(task.id, "review", { harness: "codex" });
    store.finishAttempt(attempt.id, {
      status: "succeeded", harness: "codex", model: "gpt-review", reasoningEffort: "high",
      stdoutPath: "review.stdout.log", stderrPath: "review.stderr.log", resultPath: "review.events.jsonl",
    });
    const saved = store.attempts(task.id)[0]!;
    assert.equal(saved.harness, "codex");
    assert.equal(saved.model, "gpt-review");
    assert.equal(saved.reasoningEffort, "high");
    assert.equal(saved.stdoutPath, "review.stdout.log");
    assert.equal(saved.stderrPath, "review.stderr.log");
    assert.equal(saved.resultPath, "review.events.jsonl");
  } finally { store.close(); }
});

test("quota pause survives store restart and is claimable only at its persisted retry time", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-quota-store-"));
  const path = join(root, "tasks.sqlite");
  let store = new TaskStore(path);
  try {
    const task = store.submit({ repoPath: ".", baseRef: "main", prompt: "continue" }, "quota_resume_test");
    store.claimNext("quota-worker");
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    store.pauseForQuota(task.id, "quota-worker", { retryAt, reason: "Codex usage limit reached", source: "provider_message", checkpoint: { stage: "implementation", revision: 1, worktree: { baseCommit: "abc" } } });
    store.close();

    store = new TaskStore(path);
    const waiting = store.get(task.id)!;
    assert.equal(waiting.status, "waiting");
    assert.equal(waiting.retryAt, retryAt);
    assert.equal(waiting.quotaRetryCount, 1);
    assert.deepEqual(waiting.resumeCheckpoint, { stage: "implementation", revision: 1, worktree: { baseCommit: "abc" } });
    assert.equal(store.claimNext("early-worker", 60_000, new Date(Date.now() + 30_000)), undefined);
    const resumed = store.claimNext("resumed-worker", 60_000, new Date(Date.now() + 120_000));
    assert.equal(resumed?.id, task.id);
    assert.equal(resumed?.status, "running");
    assert.deepEqual(resumed?.resumeCheckpoint, waiting.resumeCheckpoint);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary execution recovery requires fresh identity, claims atomically, and checkpoints interrupted evidence", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-execution-recovery-"));
  const path = join(root, "tasks.sqlite");
  const lockId = "a".repeat(64);
  const oldGeneration = "11111111111111111111111111111111";
  const newGeneration = "22222222222222222222222222222222";
  let store = new TaskStore(path, { id: oldGeneration, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    const task = store.submit({ repoPath: "C:/repo", baseRef: "main", prompt: "resume ordinary work" }, "execution_recovery_positive");
    store.claimNext("old-owner");
    store.saveRoute({ taskId: task.id, harness: "codex", model: "old-model", selectionSource: "codex",
      reason: "pre-crash route", decidedAt: new Date().toISOString() });
    const plan = { taskId: task.id, repoPath: "C:/repo", commonGitDir: "C:/repo/.git", worktreeRoot: "C:/worktrees", path: `C:/worktrees/${task.id}`,
      branch: `zero/${task.id}`, baseCommit: "a".repeat(40) };
    store.recordWorktreeCreationIntent(task.id, "old-owner", plan);
    const observed = { info: { taskId: task.id, repoPath: plan.repoPath, path: plan.path, branch: plan.branch, baseCommit: plan.baseCommit },
      commonGitDir: plan.commonGitDir, head: plan.baseCommit, fingerprint: "b".repeat(64) };
    store.completeWorktreeCreation(task.id, "old-owner", observed, "b".repeat(64));
    const oldAttempt = store.createAttempt(task.id, "implement", { owner: "old-owner" });
    assert.deepEqual(store.recoverExpired(new Date(Date.now() + 120_000)), [task.id]);
    store.close();

    store = new TaskStore(path, { id: newGeneration, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    assert.equal(store.currentStartupProvesGenerationDrained(oldGeneration), true);
    assert.deepEqual(store.listExecutionRecoveryCandidates().map(candidate => candidate.id), [task.id]);
    assert.throws(() => store.claimExecutionRecovery(task.id, "new-owner", { identity: { checkedAt: new Date(Date.now() - 10_000).toISOString(), observed, fingerprint: "c".repeat(64) } }), /Fresh worktree identity/);
    const claimedAt = new Date();
    const freshObserved = { ...observed, fingerprint: "c".repeat(64) };
    assert.throws(() => store.claimExecutionRecovery(task.id, "new-owner", {
      now: claimedAt, identity: { checkedAt: claimedAt.toISOString(), observed: { ...freshObserved, commonGitDir: "C:/foreign/.git" }, fingerprint: "c".repeat(64) },
    }), /does not match persisted creation identity/);
    assert.equal(store.get(task.id)?.status, "recovery_required");
    const claimed = store.claimExecutionRecovery(task.id, "new-owner", {
      now: claimedAt, leaseMs: 90_000,
      identity: { checkedAt: claimedAt.toISOString(), observed: freshObserved, fingerprint: "c".repeat(64) },
    });
    assert.equal(claimed?.status, "running");
    assert.equal(claimed?.claimGenerationId, newGeneration);
    assert.equal(claimed?.leaseOwner, "new-owner");
    assert.equal(store.getRoute(task.id), undefined);
    const freshBackdatedRoute = { taskId: task.id, harness: "zcode", model: "fresh-model", selectionSource: "codex" as const,
      reason: "rerouted after recovery", decidedAt: "2000-01-01T00:00:00.000Z" };
    store.saveRoute(freshBackdatedRoute);
    assert.deepEqual(store.getRoute(task.id), freshBackdatedRoute);
    const checkpoint = store.executionRecoveryCheckpoint(task.id)!;
    assert.equal(checkpoint.kind, "execution_recovery");
    assert.equal(checkpoint.sourceGenerationId, oldGeneration);
    assert.equal((checkpoint.freshIdentity as { fingerprint: string }).fingerprint, "c".repeat(64));
    assert.equal(((checkpoint.source as { worktreeCreation: { fingerprint: string } }).worktreeCreation).fingerprint, "b".repeat(64));
    assert.equal(((checkpoint.source as { historyBoundary: { attemptSequence: number } }).historyBoundary).attemptSequence, 1);
    assert.equal(store.attempts(task.id).find(attempt => attempt.id === oldAttempt.id)?.status, "interrupted");
    assert.equal(store.claimExecutionRecovery(task.id, "racer", {
      identity: { checkedAt: new Date().toISOString(), observed: freshObserved, fingerprint: "c".repeat(64) },
    }), undefined);
    const quarantined = store.quarantineClaimedExecutionRecovery(task.id, "new-owner", "post-claim worktree identity changed");
    assert.equal(quarantined.status, "recovery_required");
    assert.equal(quarantined.recoveryEvidence?.kind, "execution_recovery_quarantine");
    assert.equal(store.executionRecoveryCheckpoint(task.id), undefined);
    assert.deepEqual(store.listExecutionRecoveryCandidates(), []);
    assert.equal(store.events(task.id).some(event => event.type === "task.execution_recovery_quarantined"), true);
    assert.equal(store.events(task.id).some(event => event.type === "task.execution_recovery_claimed"), true);
    assert.equal(store.events(task.id).some(event => event.type === "task.transition" && (event.payload as { to?: string } | undefined)?.to === "failed"), false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("execution recovery quarantines legacy, multi-stage, review, quota, and identity-mismatched evidence", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-execution-recovery-deny-"));
  const path = join(root, "tasks.sqlite");
  const lockId = "c".repeat(64);
  const oldGeneration = "33333333333333333333333333333333";
  const newGeneration = "44444444444444444444444444444444";
  let store = new TaskStore(path, { id: oldGeneration, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    const ids = ["no_worktree", "intent_only", "multi_stage", "review", "quota", "mismatch", "report", "inspect"];
    const tasks = new Map<string, string>();
    for (const name of ids) {
      const task = store.submit({ repoPath: "C:/repo", baseRef: "main", prompt: name,
        ...(name === "multi_stage" ? { executionStages: [{ harness: "codex" }, { harness: "zcode" }] } : {}) }, `recover_${name}`);
      tasks.set(name, task.id);
      store.claimNext(`old-${name}`);
      if (name !== "no_worktree") {
        const plan = { taskId: task.id, repoPath: "C:/repo", commonGitDir: "C:/repo/.git", worktreeRoot: "C:/worktrees", path: `C:/worktrees/${task.id}`,
          branch: `zero/${task.id}`, baseCommit: "d".repeat(40) };
        store.recordWorktreeCreationIntent(task.id, `old-${name}`, plan);
        if (name !== "intent_only") {
          const observed = { info: { taskId: task.id, repoPath: plan.repoPath, path: plan.path, branch: plan.branch, baseCommit: plan.baseCommit },
            commonGitDir: plan.commonGitDir, head: plan.baseCommit, fingerprint: "e".repeat(64) };
          store.completeWorktreeCreation(task.id, `old-${name}`, observed, "e".repeat(64));
        }
      }
    }
    for (const id of tasks.values()) store.recoverExpired(new Date(Date.now() + 120_000));
    store.close();
    store = new TaskStore(path, { id: newGeneration, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    const editor = new DatabaseSync(path);
    try {
      const reviewId = tasks.get("review")!;
      editor.prepare("INSERT INTO reviews(task_id,at,result) VALUES(?,?,?)").run(reviewId, new Date().toISOString(), JSON.stringify({ approved: true }));
      const quotaId = tasks.get("quota")!;
      editor.prepare("INSERT INTO quota_pauses(task_id,retry_at,retry_count,checkpoint,reason,source) VALUES(?,?,?,?,?,?)")
        .run(quotaId, new Date(Date.now() + 60_000).toISOString(), 1, "{}", "paused", "fallback");
      const reportId = tasks.get("report")!;
      editor.prepare("INSERT INTO events(task_id,type,at,payload) VALUES(?,?,?,?)").run(reportId, "task.report_saved", new Date().toISOString(), "{}");
      const mismatchId = tasks.get("mismatch")!;
      const row = editor.prepare("SELECT recovery_evidence FROM tasks WHERE id=?").get(mismatchId) as { recovery_evidence: string };
      const evidence = JSON.parse(row.recovery_evidence) as Record<string, unknown>;
      editor.prepare("UPDATE tasks SET recovery_evidence=? WHERE id=?").run(JSON.stringify({ ...evidence, claimGenerationId: oldGeneration.replace(/^3/, "5") }), mismatchId);
    } finally { editor.close(); }
    assert.deepEqual(store.listExecutionRecoveryCandidates().map(candidate => candidate.id), [tasks.get("inspect")]);
    const rejected = store.rejectExecutionRecoveryInspection(tasks.get("inspect")!, "persisted worktree identity mismatch", new Date().toISOString());
    assert.equal(rejected.status, "recovery_required");
    assert.equal(store.listExecutionRecoveryCandidates().length, 0);
    assert.equal(store.executionRecoveryCheckpoint(tasks.get("inspect")!), undefined);
    assert.equal(store.events(tasks.get("inspect")!).some(event => event.type === "task.execution_recovery_inspection_required"), true);
    for (const id of tasks.values()) {
      assert.equal(store.claimExecutionRecovery(id, "cannot-claim", { identity: { checkedAt: new Date().toISOString(),
        observed: { info: { taskId: id, repoPath: "C:/repo", path: `C:/worktrees/${id}`, branch: `zero/${id}`, baseCommit: "d".repeat(40) }, commonGitDir: "C:/repo/.git", head: "d".repeat(40) },
        fingerprint: "e".repeat(64) } }), undefined);
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a second expired recovery generation supersedes the old checkpoint without authorizing stale lineage", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-execution-recovery-repeat-"));
  const path = join(root, "tasks.sqlite");
  const lockId = "f".repeat(64);
  const firstGeneration = "55555555555555555555555555555555";
  const recoveryGeneration = "66666666666666666666666666666666";
  const nextGeneration = "77777777777777777777777777777777";
  let store = new TaskStore(path, { id: firstGeneration, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    const task = store.submit({ repoPath: "C:/repo", baseRef: "main", prompt: "repeat" }, "execution_recovery_repeat");
    store.claimNext("first-owner");
    const plan = { taskId: task.id, repoPath: "C:/repo", commonGitDir: "C:/repo/.git", worktreeRoot: "C:/worktrees", path: `C:/worktrees/${task.id}`,
      branch: `zero/${task.id}`, baseCommit: "1".repeat(40) };
    store.recordWorktreeCreationIntent(task.id, "first-owner", plan);
    const observed = { info: { taskId: task.id, repoPath: plan.repoPath, path: plan.path, branch: plan.branch, baseCommit: plan.baseCommit },
      commonGitDir: plan.commonGitDir, head: plan.baseCommit, fingerprint: "2".repeat(64) };
    store.completeWorktreeCreation(task.id, "first-owner", observed, "2".repeat(64));
    store.recoverExpired(new Date(Date.now() + 120_000));
    store.close();

    store = new TaskStore(path, { id: recoveryGeneration, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    const freshAt = new Date();
    store.claimExecutionRecovery(task.id, "recovery-owner", { now: freshAt, identity: { checkedAt: freshAt.toISOString(), observed, fingerprint: "2".repeat(64) } });
    store.close();

    store = new TaskStore(path, { id: nextGeneration, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    assert.deepEqual(store.recoverExpired(new Date(Date.now() + 120_000)), [task.id]);
    const newEvidence = store.get(task.id)?.recoveryEvidence as Record<string, unknown>;
    assert.equal(newEvidence.claimGenerationId, recoveryGeneration);
    assert.equal((newEvidence.priorExecutionRecoveryCheckpoint as { sourceGenerationId: string }).sourceGenerationId, firstGeneration);
    assert.deepEqual(store.listExecutionRecoveryCandidates().map(candidate => candidate.id), [task.id]);
    const latestAt = new Date();
    const latest = store.claimExecutionRecovery(task.id, "latest-owner", { now: latestAt, identity: { checkedAt: latestAt.toISOString(), observed, fingerprint: "2".repeat(64) } });
    assert.equal(latest?.claimGenerationId, nextGeneration);
    assert.equal((store.executionRecoveryCheckpoint(task.id)?.sourceGenerationId), recoveryGeneration);
    store.pauseForQuota(task.id, "latest-owner", { retryAt: new Date(Date.now() + 60_000).toISOString(), reason: "provider quota",
      checkpoint: { stage: "implementation" }, source: "fallback" });
    assert.equal(store.get(task.id)?.status, "waiting");
    assert.equal(store.executionRecoveryCheckpoint(task.id), undefined);
    store.transition(task.id, "waiting", "failed", { reason: "terminal test" });
    const db = new DatabaseSync(path);
    try {
      const checkpointRow = db.prepare("SELECT status FROM execution_recovery_checkpoints WHERE task_id=?").get(task.id) as { status: string };
      assert.equal(checkpointRow.status, "disabled");
    } finally { db.close(); }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent startup generations yield at most one SQLite execution recovery writer", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-execution-recovery-concurrent-"));
  const path = join(root, "tasks.sqlite");
  const lockId = "9".repeat(64);
  const sourceGeneration = "88888888888888888888888888888888";
  const seed = new TaskStore(path, { id: sourceGeneration, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  const task = seed.submit({ repoPath: "C:/repo", baseRef: "main", prompt: "concurrent resume" }, "execution_recovery_concurrent");
  seed.claimNext("source-owner");
  const plan = { taskId: task.id, repoPath: "C:/repo", commonGitDir: "C:/repo/.git", worktreeRoot: "C:/worktrees", path: `C:/worktrees/${task.id}`,
    branch: `zero/${task.id}`, baseCommit: "a".repeat(40) };
  seed.recordWorktreeCreationIntent(task.id, "source-owner", plan);
  const observed = { info: { taskId: task.id, repoPath: plan.repoPath, path: plan.path, branch: plan.branch, baseCommit: plan.baseCommit },
    commonGitDir: plan.commonGitDir, head: plan.baseCommit, fingerprint: "b".repeat(64) };
  seed.completeWorktreeCreation(task.id, "source-owner", observed, "b".repeat(64));
  seed.recoverExpired(new Date(Date.now() + 120_000));
  seed.close();

  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      let store;
      try {
        const { TaskStore } = await import(workerData.moduleUrl);
        store = new TaskStore(workerData.path, { id: workerData.generationId, lockId: workerData.lockId, predecessorDrained: true, evidenceKind: 'guardian_startup_verified' });
        const barrier = new Int32Array(workerData.barrier);
        Atomics.add(barrier, 0, 1);
        Atomics.notify(barrier, 0);
        while (Atomics.load(barrier, 0) < 2) Atomics.wait(barrier, 0, Atomics.load(barrier, 0), 10000);
        const now = new Date();
        const claimed = store.claimExecutionRecovery(workerData.taskId, workerData.owner, {
          now, identity: { checkedAt: now.toISOString(), observed: workerData.observed, fingerprint: workerData.fingerprint }
        });
        parentPort.postMessage({ owner: workerData.owner, claimed: Boolean(claimed), status: store.get(workerData.taskId)?.status });
      } catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
      finally { store?.close(); }
    })();
  `;
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const moduleUrl = new URL("./task-store.js", import.meta.url).href;
  const start = (generationId: string, owner: string) => new Promise<{ owner: string; claimed: boolean; status: string }>((resolve, reject) => {
    const worker = new Worker(workerSource, { eval: true, workerData: { moduleUrl, path, taskId: task.id, lockId,
      generationId, owner, observed, fingerprint: "c".repeat(64), barrier } });
    let result: { owner: string; claimed: boolean; status: string } | undefined;
    worker.once("message", value => { if (value?.error) reject(new Error(value.error)); else result = value; });
    worker.once("error", reject);
    worker.once("exit", code => {
      if (code !== 0) reject(new Error(`recovery worker exited with code ${code}`));
      else if (!result) reject(new Error("recovery worker exited without a result"));
      else resolve(result);
    });
  });
  try {
    const outcomes = await Promise.all([
      start("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "recovery-racer-a"),
      start("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "recovery-racer-b"),
    ]);
    assert.equal(outcomes.filter(outcome => outcome.claimed).length, 1);
    assert.equal(outcomes.filter(outcome => outcome.status === "running").length, 1);
    const check = new TaskStore(path);
    try {
      assert.equal(check.get(task.id)?.status, "running");
      assert.ok(["recovery-racer-a", "recovery-racer-b"].includes(check.get(task.id)?.leaseOwner ?? ""));
      assert.equal(check.executionRecoveryCheckpoint(task.id)?.kind, "execution_recovery");
    } finally { check.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

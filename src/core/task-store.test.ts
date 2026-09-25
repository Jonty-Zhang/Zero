import test from "node:test";
import assert from "node:assert/strict";
import { TaskStore } from "./task-store.js";
import type { TaskSubmission } from "../domain/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
    const existing = store.get("legacy_task");
    assert.equal(existing?.status, "pending");
    assert.equal(existing?.prompt, "preserve me");
    assert.equal(existing?.recoveryReason, undefined);
    assert.deepEqual(store.recoverExpired(new Date("2026-01-01T00:00:02.000Z")), ["legacy_active"]);
    assert.equal(store.get("legacy_active")?.status, "recovery_required");
    assert.equal(store.get("legacy_active")?.recoveryEvidence?.claimProtocolVersion, null);
    assert.deepEqual(store.listLeaseExpiryRecoveryCandidates(), []);
    assert.throws(() => store.requeuePreWriteIntentLeaseExpiry("legacy_active", { kind: "worktree_absent", checkedAt: new Date().toISOString() }), /not an eligible lease-expiry/);
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

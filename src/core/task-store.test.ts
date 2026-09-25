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
    assert.ok(store.events(task.id).some(e => e.type === "task.lease_expired"));
    assert.equal(store.get(task.id)?.recoveryEvidence?.activeAttemptId, attempt.id);
    assert.match(store.get(task.id)?.recoveryReason ?? "", /lease expired/);
    assert.equal(store.claimNext("worker-c"), undefined);
    assert.equal(attempt.id, store.attempts(task.id)[0]?.id);
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
  legacy.close();
  const store = new TaskStore(path);
  try {
    const existing = store.get("legacy_task");
    assert.equal(existing?.status, "pending");
    assert.equal(existing?.prompt, "preserve me");
    assert.equal(existing?.recoveryReason, undefined);
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

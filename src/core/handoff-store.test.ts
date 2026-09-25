import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HANDOFF_V1_MAX_BYTES, parseHandoffV1 } from "../domain/handoff.js";
import type { HandoffV1 } from "../domain/types.js";
import { TaskStore } from "./task-store.js";

function handoffFor(taskId: string, stageId: string, attemptId: string): HandoffV1 {
  return {
    schemaVersion: 1, taskId, stageId, createdAt: new Date().toISOString(),
    source: { attemptId, harness: "zcode", model: "deepseek-v4-pro", harnessVersion: "0.16.9", bindingVersion: "binding-v2", configHash: "cfg-sha256", processStartId: "generation-4" },
    task: { objective: "Add the handoff data layer", acceptanceCriteria: ["Persist typed handoffs"] },
    workspace: { baseCommit: "base-123", headCommit: "head-456", fingerprint: "tree-sha256", state: "dirty", changedFiles: ["src/core/task-store.ts"] },
    completed: ["Added stage persistence"], currentState: "Store migration and tests are ready.",
    decisions: [{ decision: "Use additive tables", rationale: "Preserves old attempt rows." }],
    rejectedOptions: [{ option: "Replace attempts table", reason: "Would risk existing task history." }],
    keyFiles: [{ path: "src/core/task-store.ts", reason: "Owns transactional persistence." }],
    checks: [{ id: "typecheck", status: "passed", evidence: "npm run build" }],
    blockers: [], risks: ["Execution path does not consume stages yet."], nextSteps: ["Connect the worker to stage APIs."],
  };
}

function expireLease(store: TaskStore, taskId: string, owner: string): void {
  assert.equal(store.heartbeat(taskId, owner, 1_000, new Date(Date.now() - 5_000)), true);
}

test("handoff V1 is strict, bounded, and permits unknown workspace facts without invented fingerprints", () => {
  const unknownWorkspace = handoffFor("task-schema", "stage-schema", "attempt-schema");
  unknownWorkspace.workspace = { state: "unknown" };
  assert.deepEqual(parseHandoffV1(unknownWorkspace).workspace, { state: "unknown" });
  assert.throws(() => parseHandoffV1({ ...unknownWorkspace, createdAt: "1" }), /ISO-8601 date-time with a timezone/);
  assert.throws(() => parseHandoffV1({ ...unknownWorkspace, createdAt: "2026-02-30T12:00:00Z" }), /valid calendar date/);

  assert.throws(() => parseHandoffV1({ ...unknownWorkspace, unexpected: true }), /is not allowed/);
  const knownWithoutFingerprint = handoffFor("task-schema", "stage-schema", "attempt-schema");
  knownWithoutFingerprint.workspace = { state: "dirty", changedFiles: [] };
  assert.throws(() => parseHandoffV1(knownWithoutFingerprint), /requires baseCommit, fingerprint, and changedFiles/);

  const oversized = handoffFor("task-schema", "stage-schema", "attempt-schema");
  oversized.decisions = Array.from({ length: 30 }, () => ({ decision: "x".repeat(1_000), rationale: "y".repeat(1_500) }));
  assert.throws(() => parseHandoffV1(oversized), new RegExp(`exceeds ${HANDOFF_V1_MAX_BYTES} bytes`));
});

test("stage, attempt, and provenance-checked handoff persist together and survive reopening", async () => {
  const root = await mkdtemp(join(tmpdir(), "zero-handoff-store-"));
  const path = join(root, "tasks.sqlite");
  let store = new TaskStore(path);
  try {
    const task = store.submit({ repoPath: "C:/repo", baseRef: "main", prompt: "implement" }, "handoff_task");
    store.claimNext("handoff-worker");
    const stage = store.createStage(task.id, {
      role: "implement", harness: "zcode", harnessVersion: "0.16.9", model: "deepseek-v4-pro",
      reasoningEffort: "high", bindingVersion: "binding-v2", configHash: "cfg-sha256",
      processStartId: "generation-4", inputFingerprint: "base-tree-sha256",
    });
    const nextStage = store.createStage(task.id, { role: "revise", predecessorStageId: stage.id, processStartId: "generation-5" });
    assert.throws(() => store.startStage(stage.id, "other-worker", "generation-4"), /not leased/);
    assert.throws(() => store.startStage(nextStage.id, "handoff-worker", "generation-5"), /Predecessor stage .* has not reached a terminal state/);
    store.startStage(stage.id, "handoff-worker", "generation-4");
    assert.throws(() => store.startStage(nextStage.id, "handoff-worker", "generation-5"), /already has a running stage/);
    assert.throws(() => store.finishStage(stage.id, "handoff-worker", "generation-4", "succeeded"), /still has a running attempt|cannot succeed without/);
    assert.throws(() => store.createAttempt(task.id, "implement", { owner: "handoff-worker", stageId: stage.id, harness: "codex", model: "wrong-model" }), /does not match stage selection/);
    assert.throws(() => store.finishStage(stage.id, "handoff-worker", "stale-generation", "succeeded"), /generation does not match/);
    const attempt = store.createAttempt(task.id, "implement", {
      owner: "handoff-worker", stageId: stage.id, harness: "zcode", harnessVersion: "0.16.9", model: "deepseek-v4-pro",
      reasoningEffort: "high", bindingVersion: "binding-v2", configHash: "cfg-sha256",
    });
    assert.throws(() => store.finishAttempt(attempt.id, { status: "succeeded" }), /requires owner and processStartId/);
    assert.throws(() => store.finishAttempt(attempt.id, { status: "succeeded", model: "other-model" }, { owner: "handoff-worker", processStartId: "generation-4" }), /result model conflicts/);
    assert.throws(() => store.finishAttempt(attempt.id, { status: "succeeded", harness: "codex" }, { owner: "handoff-worker", processStartId: "generation-4" }), /result Harness conflicts/);
    assert.throws(() => store.finishAttempt(attempt.id, { status: "succeeded", reasoningEffort: "low" }, { owner: "handoff-worker", processStartId: "generation-4" }), /result reasoning effort conflicts/);
    assert.throws(() => store.finishAttempt(attempt.id, { status: "succeeded" }, { owner: "old-worker", processStartId: "generation-4" }), /not leased/);
    assert.throws(() => store.finishAttempt(attempt.id, { status: "succeeded" }, { owner: "handoff-worker", processStartId: "stale-generation" }), /stale stage generation/);
    store.finishAttempt(attempt.id, { status: "succeeded" }, { owner: "handoff-worker", processStartId: "generation-4" });
    store.finishStage(stage.id, "handoff-worker", "generation-4", "succeeded", "head-tree-sha256");
    store.startStage(nextStage.id, "handoff-worker", "generation-5");
    const failedRevision = store.createAttempt(task.id, "revise", {
      owner: "handoff-worker", stageId: nextStage.id, harness: "codex", harnessVersion: "codex-test",
      model: "gpt-review", reasoningEffort: "high", bindingVersion: "binding-v3", configHash: "cfg-review",
    });
    store.finishAttempt(failedRevision.id, { status: "failed" }, { owner: "handoff-worker", processStartId: "generation-5" });
    assert.equal(store.getStage(nextStage.id)?.harness, "codex");
    assert.throws(() => store.finishStage(nextStage.id, "handoff-worker", "generation-5", "succeeded"), /without a succeeded attempt/);
    store.finishStage(nextStage.id, "handoff-worker", "generation-5", "failed");
    const recoveryStage = store.createStage(task.id, { role: "revise", predecessorStageId: nextStage.id, processStartId: "generation-6" });
    store.startStage(recoveryStage.id, "handoff-worker", "generation-6");
    store.finishStage(recoveryStage.id, "handoff-worker", "generation-6", "interrupted");
    const saved = store.saveHandoff(handoffFor(task.id, stage.id, attempt.id));
    assert.ok(saved.byteLength <= HANDOFF_V1_MAX_BYTES);
    assert.equal(store.getHandoff(saved.id)?.source.attemptId, attempt.id);
    assert.equal(store.attempts(task.id)[0]?.stageId, stage.id);
    assert.equal(store.stages(task.id)[0]?.processStartId, "generation-4");
    assert.equal(store.stages(task.id)[0]?.outputFingerprint, "head-tree-sha256");
    assert.equal(store.events(task.id).at(-1)?.type, "handoff.saved");
    assert.throws(() => store.saveHandoff(handoffFor(task.id, stage.id, "wrong-attempt")), /source attempt/);
    store.close();

    store = new TaskStore(path);
    assert.equal(store.handoffs(task.id).length, 1);
    assert.equal(store.handoffs(task.id)[0]?.workspace.fingerprint, "tree-sha256");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("review stages follow reviewing state and require a live task lease at every stage transition", async () => {
  const store = new TaskStore();
  try {
    const reviewTask = store.submit({ repoPath: "C:/repo", baseRef: "main", prompt: "review the change" }, "review_stage_task");
    store.claimNext("review-worker");
    store.transition(reviewTask.id, "running", "reviewing", { owner: "review-worker" });
    const reviewStage = store.createStage(reviewTask.id, { role: "review", harness: "codex", processStartId: "review-generation" });
    store.startStage(reviewStage.id, "review-worker", "review-generation");
    const reviewAttempt = store.createAttempt(reviewTask.id, "review", { owner: "review-worker", stageId: reviewStage.id, harness: "codex", model: "gpt-review" });
    store.finishAttempt(reviewAttempt.id, { status: "succeeded" }, { owner: "review-worker", processStartId: "review-generation" });
    assert.equal(store.finishStage(reviewStage.id, "review-worker", "review-generation", "succeeded").status, "succeeded");

    const expiredStartTask = store.submit({ repoPath: "C:/repo", baseRef: "main", prompt: "expired before start" }, "expired_start_stage_task");
    store.claimNext("expired-start-worker");
    const pendingStage = store.createStage(expiredStartTask.id, { role: "implement", processStartId: "expired-start-generation" });
    expireLease(store, expiredStartTask.id, "expired-start-worker");
    assert.throws(() => store.startStage(pendingStage.id, "expired-start-worker", "expired-start-generation"), /expired lease/);

    const expiredCreateTask = store.submit({ repoPath: "C:/repo", baseRef: "main", prompt: "expired before attempt" }, "expired_create_attempt_task");
    store.claimNext("expired-create-worker");
    const createStage = store.createStage(expiredCreateTask.id, { role: "implement", processStartId: "expired-create-generation" });
    store.startStage(createStage.id, "expired-create-worker", "expired-create-generation");
    expireLease(store, expiredCreateTask.id, "expired-create-worker");
    assert.throws(() => store.createAttempt(expiredCreateTask.id, "implement", { owner: "expired-create-worker", stageId: createStage.id }), /expired lease/);
    assert.throws(() => store.finishStage(createStage.id, "expired-create-worker", "expired-create-generation", "failed"), /expired lease/);

    const expiredFinishTask = store.submit({ repoPath: "C:/repo", baseRef: "main", prompt: "expired before completion" }, "expired_finish_attempt_task");
    store.claimNext("expired-finish-worker");
    const finishStage = store.createStage(expiredFinishTask.id, { role: "implement", processStartId: "expired-finish-generation" });
    store.startStage(finishStage.id, "expired-finish-worker", "expired-finish-generation");
    const attempt = store.createAttempt(expiredFinishTask.id, "implement", { owner: "expired-finish-worker", stageId: finishStage.id });
    expireLease(store, expiredFinishTask.id, "expired-finish-worker");
    assert.throws(() => store.finishAttempt(attempt.id, { status: "succeeded" }, { owner: "expired-finish-worker", processStartId: "expired-finish-generation" }), /expired lease/);
  } finally { store.close(); }
});

test("expired task lease interrupts linked attempts and stages in the same recovery transaction", () => {
  const store = new TaskStore();
  try {
    const task = store.submit({ repoPath: ".", baseRef: "main", prompt: "recover" }, "stage_recovery_task");
    store.claimNext("expired-worker");
    const stage = store.createStage(task.id, { role: "implement", processStartId: "expired-generation" });
    store.startStage(stage.id, "expired-worker", "expired-generation");
    const attempt = store.createAttempt(task.id, "implement", { owner: "expired-worker", stageId: stage.id, harness: "codex", model: "gpt-main" });

    expireLease(store, task.id, "expired-worker");
    assert.deepEqual(store.recoverExpired(new Date()), [task.id]);
    assert.equal(store.get(task.id)?.status, "recovery_required");
    assert.equal(store.get(task.id)?.recoveryEvidence?.activeAttemptId, attempt.id);
    assert.equal(store.attempts(task.id)[0]?.status, "interrupted");
    assert.equal(store.stages(task.id)[0]?.status, "interrupted");
    assert.match(store.stages(task.id)[0]?.error ?? "", /inspect process and worktree/);
    assert.throws(() => store.finishAttempt(attempt.id, { status: "succeeded" }, { owner: "expired-worker", processStartId: "expired-generation" }), /not running/);
    assert.ok(store.events(task.id).some(event => event.type === "stage.finished" && event.payload?.status === "interrupted"));
  } finally { store.close(); }
});

test("additive migration preserves pre-stage attempts and assigns NULL stageId", async () => {
  const root = await mkdtemp(join(tmpdir(), "zero-stage-migration-"));
  const path = join(root, "legacy.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      payload TEXT NOT NULL, revision_count INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_at TEXT,
      heartbeat_at TEXT, failure_reason TEXT, active_attempt_id TEXT
    );
    CREATE TABLE attempts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), sequence INTEGER NOT NULL,
      role TEXT NOT NULL, status TEXT NOT NULL, harness TEXT, model TEXT, reasoning_effort TEXT,
      started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER, stdout_path TEXT, stderr_path TEXT,
      result_path TEXT, error TEXT, metadata TEXT, UNIQUE(task_id, sequence)
    );
    INSERT INTO tasks(id,status,created_at,updated_at,payload) VALUES('legacy-task','done','2026-01-01','2026-01-01','{"repoPath":".","baseRef":"main","prompt":"old"}');
    INSERT INTO attempts(id,task_id,sequence,role,status,harness,model,started_at) VALUES('legacy-attempt','legacy-task',1,'implement','succeeded','codex','gpt-main','2026-01-01');
  `);
  legacy.close();

  let store = new TaskStore(path);
  let storeClosed = false;
  try {
    assert.equal(store.attempts("legacy-task")[0]?.id, "legacy-attempt");
    assert.equal(store.attempts("legacy-task")[0]?.stageId, undefined);
    const savedStages = store.stages("legacy-task");
    assert.deepEqual(savedStages, []);
    store.close();
    storeClosed = true;
    const migrated = new DatabaseSync(path);
    try {
      const columns = migrated.prepare("PRAGMA table_info(attempts)").all() as Array<{ name: string }>;
      assert.ok(columns.some(column => column.name === "stage_id"));
      const row = migrated.prepare("SELECT id,stage_id FROM attempts WHERE id='legacy-attempt'").get() as { id: string; stage_id: string | null };
      assert.equal(row.id, "legacy-attempt");
      assert.equal(row.stage_id, null);
    } finally { migrated.close(); }
  } finally {
    if (!storeClosed) store.close();
    await rm(root, { recursive: true, force: true });
  }
});

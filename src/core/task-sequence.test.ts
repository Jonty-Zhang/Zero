import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "./task-store.js";

const submission = (prompt: string) => ({ repoPath: ".", baseRef: "main", prompt });

test("sequence order and eligibility survive a TaskStore restart", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-sequence-restart-"));
  const path = join(root, "tasks.sqlite");
  let store = new TaskStore(path);
  try {
    const created = store.createSequence([submission("step one"), { ...submission("step two"), repoPath: "./other" },
      { ...submission("step three"), repoPath: "./third" }], "ordered-sequence", {
      objective: "Deliver the user-requested outcome",
      acceptanceCriteria: ["All user criteria are met", "The result has been reviewed"],
    });
    assert.deepEqual(created.steps.map(step => step.task.prompt), ["step one", "step two", "step three"]);
    assert.equal(store.claimNext("worker-before-restart")?.id, created.steps[0]?.task.id);
    assert.equal(store.claimNext("concurrent-worker"), undefined);
    store.close();

    store = new TaskStore(path);
    const reopened = store.getSequence("ordered-sequence")!;
    assert.equal(reopened.status, "running");
    assert.deepEqual(reopened.steps.map(step => step.position), [0, 1, 2]);
    assert.equal(store.claimNext("after-restart"), undefined);

    // Model the task store's authoritative terminal status after its report/check/review pipeline.
    store.close();
    const db = new DatabaseSync(path);
    try { db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(created.steps[0]!.task.id); }
    finally { db.close(); }
    store = new TaskStore(path);
    assert.equal(store.getSequence("ordered-sequence")?.status, "queued");
    const nextStep = store.claimNext("step-two-worker");
    assert.equal(nextStep?.id, created.steps[1]?.task.id);
    assert.equal(nextStep?.sequenceBaseCommit, undefined);
    assert.equal(nextStep?.baseRef, "main");
    assert.equal(store.getSequence("ordered-sequence")?.status, "running");
    store.close();
    const completedTasksDb = new DatabaseSync(path);
    try { for (const step of created.steps) completedTasksDb.prepare("UPDATE tasks SET status='done' WHERE id=?").run(step.task.id); }
    finally { completedTasksDb.close(); }
    store = new TaskStore(path);
    const goalStatus = store.getSequence("ordered-sequence")!;
    assert.equal(goalStatus.status, "steps_completed");
    assert.equal(goalStatus.objective, "Deliver the user-requested outcome");
    assert.deepEqual(goalStatus.acceptanceCriteria, ["All user criteria are met", "The result has been reviewed"]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("only an aggregate PASS bound to rechecked evidence completes an objective sequence", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-sequence-goal-review-"));
  const path = join(root, "tasks.sqlite");
  let store = new TaskStore(path);
  try {
    const sequence = store.createSequence([submission("step one"), submission("step two")], "goal-review-sequence", {
      objective: "Deliver the combined result", acceptanceCriteria: ["The full result satisfies the criteria"],
    });
    store.close();
    const db = new DatabaseSync(path);
    try { for (const step of sequence.steps) db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(step.task.id); }
    finally { db.close(); }
    store = new TaskStore(path);
    assert.equal(store.getSequence(sequence.id)?.status, "steps_completed");
    const firstFingerprint = "a".repeat(64);
    const attempt = store.startSequenceGoalReview(sequence.id, firstFingerprint, "goal-attempt-pass");
    assert.equal(attempt.state, "running");
    store.finishSequenceGoalReview({ attemptId: attempt.attemptId, verifiedEvidenceFingerprint: firstFingerprint,
      result: { verdict: "pass", summary: "The complete result satisfies the goal.", findings: [] } });
    assert.equal(store.getSequence(sequence.id)?.status, "completed");
    assert.equal(store.getSequence(sequence.id)?.goalReview?.evidenceFingerprint, firstFingerprint);

    const changedAttempt = store.startSequenceGoalReview(sequence.id, "b".repeat(64), "goal-attempt-changed");
    store.finishSequenceGoalReview({ attemptId: changedAttempt.attemptId, verifiedEvidenceFingerprint: "c".repeat(64),
      result: { verdict: "pass", summary: "Reviewer saw an earlier snapshot.", findings: [] } });
    const changed = store.getSequence(sequence.id)!;
    assert.equal(changed.status, "blocked");
    assert.equal(changed.goalReview?.result?.verdict, "blocked");
    assert.match(changed.goalReview?.result?.summary ?? "", /changed during review/);
    assert.equal(changed.blockedReason?.status, "done");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("aggregate review quota and verdict survive restart and retry after the stored time", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-sequence-goal-quota-"));
  const path = join(root, "tasks.sqlite");
  let store = new TaskStore(path);
  try {
    const sequence = store.createSequence([submission("step one"), submission("step two")], "goal-quota-sequence", {
      objective: "Deliver the combined result", acceptanceCriteria: ["The result is reviewed"],
    });
    store.close();
    const db = new DatabaseSync(path);
    try { for (const step of sequence.steps) db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(step.task.id); }
    finally { db.close(); }
    store = new TaskStore(path);
    const startedAt = new Date("2026-09-26T00:00:00.000Z");
    const retryAt = new Date(startedAt.getTime() + 5 * 60 * 60_000).toISOString();
    const attempt = store.startSequenceGoalReview(sequence.id, "d".repeat(64), "goal-attempt-quota", startedAt);
    store.finishSequenceGoalReview({ attemptId: attempt.attemptId, retryAt, now: startedAt });
    assert.equal(store.getSequence(sequence.id)?.status, "waiting");
    store.close();

    store = new TaskStore(path);
    assert.equal(store.sequenceGoalReview(sequence.id)?.retryAt, retryAt);
    assert.throws(() => store.startSequenceGoalReview(sequence.id, "d".repeat(64), "too-early", new Date(startedAt.getTime() + 60_000)), /waiting for quota/);
    const resumedAt = new Date(startedAt.getTime() + 5 * 60 * 60_000 + 1);
    const resumed = store.startSequenceGoalReview(sequence.id, "d".repeat(64), "goal-attempt-resumed", resumedAt);
    store.finishSequenceGoalReview({ attemptId: resumed.attemptId, verifiedEvidenceFingerprint: "d".repeat(64), now: resumedAt,
      result: { verdict: "changes_requested", summary: "One goal criterion remains unmet.", findings: [
        { severity: "high", evidence: "The result lacks required review evidence.", requestedChange: "Add the missing review evidence." },
      ] } });
    assert.equal(store.getSequence(sequence.id)?.status, "blocked");
    store.close();

    store = new TaskStore(path);
    assert.equal(store.getSequence(sequence.id)?.goalReview?.result?.verdict, "changes_requested");
    assert.equal(store.getSequence(sequence.id)?.goalReview?.evidenceFingerprint, "d".repeat(64));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed first step blocks later steps and cannot mark the sequence complete", () => {
  const store = new TaskStore();
  try {
    const sequence = store.createSequence([submission("first"), submission("second")], "failure-sequence");
    const first = sequence.steps[0]!.task;
    store.claimNext("failure-worker");
    store.transition(first.id, "running", "failed", { owner: "failure-worker", clearLease: true, reason: "check failed" });

    const status = store.getSequence(sequence.id)!;
    assert.equal(status.status, "blocked");
    assert.equal(status.blockedReason?.taskId, first.id);
    assert.equal(status.blockedReason?.status, "failed");
    assert.equal(status.blockedReason?.reason, "check failed");
    assert.equal(status.steps.every(step => step.task.status === "done"), false);
    assert.equal(store.claimNext("must-not-run-later-step"), undefined);
  } finally { store.close(); }
});

test("quota waiting is reported separately while later sequence steps remain gated", () => {
  const store = new TaskStore();
  try {
    const sequence = store.createSequence([submission("waiting first"), submission("gated second")], "waiting-sequence");
    const owner = "quota-paused-sequence-step";
    const first = store.claimNext(owner)!;
    store.pauseForQuota(first.id, owner, { retryAt: new Date(Date.now() + 60_000).toISOString(), reason: "provider quota",
      checkpoint: { stage: "execute" } });
    assert.equal(store.getSequence(sequence.id)?.status, "waiting");
    assert.equal(store.claimNext("cannot-skip-waiting-step"), undefined);
  } finally { store.close(); }
});

test("invalid sequence submission leaves no goal or partial tasks persisted", () => {
  const store = new TaskStore();
  try {
    assert.throws(() => store.createSequence([
      submission("valid first"),
      { ...submission("invalid middle"), executionStages: [{ unsupported: "field" } as never] },
      submission("valid last"),
    ], "invalid-sequence"), /executionStages\[0\]\.unsupported/);
    assert.deepEqual(store.listSequences(), []);
    assert.deepEqual(store.list(), []);
    assert.equal(store.getSequence("invalid-sequence"), undefined);
  } finally { store.close(); }
});

test("same-repository handoff fails closed when DONE evidence has no matching applied report", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-sequence-missing-evidence-"));
  const path = join(root, "tasks.sqlite");
  let store = new TaskStore(path);
  try {
    const sequence = store.createSequence([submission("first"), submission("second")], "missing-handoff-evidence");
    store.close();
    const db = new DatabaseSync(path);
    try { db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(sequence.steps[0]!.task.id); }
    finally { db.close(); }
    store = new TaskStore(path);
    assert.equal(store.claimNext("must-fail-closed"), undefined);
    assert.equal(store.get(sequence.steps[1]!.task.id)?.status, "pending");
    assert.equal(store.getSequence(sequence.id)?.status, "blocked");
    assert.match(store.getSequence(sequence.id)?.blockedReason?.reason ?? "", /no matching authoritative applied commit and complete report/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

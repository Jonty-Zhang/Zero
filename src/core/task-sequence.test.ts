import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "./task-store.js";

const submission = (prompt: string) => ({ repoPath: ".", baseRef: "main", prompt });

function seedAuthoritativeDone(path: string, taskId: string, sha: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=OFF");
    const at = "2026-09-26T00:00:00.000Z";
    const operationId = `commit-${taskId}`;
    const packageId = `package-${taskId}`;
    const verdictId = `verdict-${taskId}`;
    const generationId = "sequence-test-generation";
    const evidence = JSON.stringify({ branchRef: `refs/heads/zero/${taskId}`, refHead: sha, worktreeHead: sha,
      treeId: "e".repeat(40), diffHash: "a".repeat(64), candidateObjectVerified: true,
      indexMatchesReviewedTree: true, worktreeClean: true });
    db.prepare(`INSERT INTO commit_operations(id,task_id,package_id,verdict_id,generation_id,owner,claim_owner,claim_generation_id,
      branch_ref,pre_head,tree_id,diff_hash,message,timestamp,author_name,author_email,committer_name,committer_email,encoding,
      status,candidate_sha,created_at,candidate_at,applied_at,applied_evidence)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'applied',?,?,?,?,?)`).run(operationId, taskId, packageId, verdictId, generationId,
      "worker", "worker", generationId, `refs/heads/zero/${taskId}`, "b".repeat(40), "e".repeat(40), "a".repeat(64), "done", at,
      "Zero", "zero@localhost", "Zero", "zero@localhost", "UTF-8", sha, at, at, at, evidence);
    const reportBytes = Buffer.from(JSON.stringify({ taskId, finalStatus: "done", resultCommit: sha }), "utf8");
    const diffBytes = Buffer.from("verified diff", "utf8");
    const reportHash = createHash("sha256").update(reportBytes).digest("hex");
    const diffHash = createHash("sha256").update(diffBytes).digest("hex");
    db.prepare(`INSERT INTO report_operations(id,task_id,commit_operation_id,package_id,verdict_id,generation_id,owner,claim_owner,
      claim_generation_id,artifact_directory,report_path,diff_path,event_high_water,report_bytes,report_sha256,report_size,diff_bytes,
      diff_sha256,diff_size,status,created_at,completed_at,readback_evidence)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'complete',?,?,?)`).run(`report-${taskId}`, taskId, operationId, packageId, verdictId,
      generationId, "worker", "worker", generationId, `C:/artifacts/${taskId}`, `C:/artifacts/${taskId}/report.json`,
      `C:/artifacts/${taskId}/result.diff`, 0, reportBytes, reportHash, reportBytes.length, diffBytes, diffHash, diffBytes.length,
      at, at, JSON.stringify({ verified: true }));
    db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(taskId);
  } finally { db.close(); }
}

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

test("goal revision limit migration is additive and defaults legacy sequences to two", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-sequence-revision-migration-"));
  const path = join(root, "tasks.sqlite");
  let store = new TaskStore(path);
  try {
    const sequence = store.createSequence([submission("one"), submission("two")], "revision-migration", { objective: "Goal" });
    assert.equal(sequence.maxGoalRevisions, 2);
    assert.equal(sequence.goalRevisionCount, 0);
    store.close();
    const legacy = new DatabaseSync(path);
    try { legacy.exec("ALTER TABLE task_sequences DROP COLUMN max_goal_revisions"); }
    finally { legacy.close(); }
    store = new TaskStore(path);
    assert.equal(store.getSequence(sequence.id)?.maxGoalRevisions, 2);
    assert.equal(store.getSequence(sequence.id)?.goalRevisionCount, 0);
    assert.throws(() => store.createSequence([submission("bad one"), submission("bad two")], "bad-revision-limit",
      { maxGoalRevisions: 6 }), /integer from 0 to 5/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("goal revisions are bounded, idempotent, and claim from the latest authoritative same-repository result", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-sequence-revision-append-"));
  const path = join(root, "tasks.sqlite");
  let store = new TaskStore(path);
  try {
    const sequence = store.createSequence([{ ...submission("first"), repoPath: "./earlier-repo" }, submission("second")], "revision-append",
      { objective: "Deliver the goal", maxGoalRevisions: 2 });
    const resultCommit = "c".repeat(40);
    seedAuthoritativeDone(path, sequence.steps[0]!.task.id, "b".repeat(40));
    seedAuthoritativeDone(path, sequence.steps[1]!.task.id, resultCommit);

    const firstAttempt = store.startSequenceGoalReview(sequence.id, "d".repeat(64), "revision-review-1");
    store.finishSequenceGoalReview({ attemptId: firstAttempt.attemptId, verifiedEvidenceFingerprint: "d".repeat(64),
      result: { verdict: "changes_requested", summary: "Add one missing property.", findings: [
        { severity: "medium", evidence: "One required property is absent.", requestedChange: "Add the property." },
      ] } });
    assert.throws(() => store.appendSequenceGoalRevision(sequence.id, firstAttempt.attemptId,
      { ...submission("Wrong repository"), repoPath: "./earlier-repo" }, "wrong-repository-revision"), /final sequence step's repository/);
    const remediation = store.appendSequenceGoalRevision(sequence.id, firstAttempt.attemptId,
      { ...submission("Address the aggregate review findings"), repoPath: "." }, "revision-task-1");
    assert.equal(remediation.sequenceBaseCommit, resultCommit);
    assert.equal(store.getSequence(sequence.id)?.goalRevisionCount, 1);
    assert.equal(store.getSequence(sequence.id)?.maxGoalRevisions, 2);
    assert.equal(store.getSequence(sequence.id)?.status, "queued");
    const claimed = store.claimNext("revision-worker");
    assert.equal(claimed?.id, remediation.id);
    assert.equal(claimed?.sequenceBaseCommit, resultCommit);
    store.close();

    store = new TaskStore(path);
    const duplicate = store.appendSequenceGoalRevision(sequence.id, firstAttempt.attemptId,
      { ...submission("Address the aggregate review findings"), repoPath: "." }, "revision-task-retry");
    assert.equal(duplicate.id, remediation.id);
    assert.equal(store.getSequence(sequence.id)?.goalRevisionCount, 1);

    seedAuthoritativeDone(path, remediation.id, "f".repeat(40));
    const secondAttempt = store.startSequenceGoalReview(sequence.id, "e".repeat(64), "revision-review-2");
    store.finishSequenceGoalReview({ attemptId: secondAttempt.attemptId, verifiedEvidenceFingerprint: "e".repeat(64),
      result: { verdict: "changes_requested", summary: "One detail remains.", findings: [
        { severity: "low", evidence: "A detail is missing.", requestedChange: "Include the detail." },
      ] } });
    const secondRevision = store.appendSequenceGoalRevision(sequence.id, secondAttempt.attemptId,
      { ...submission("Address the remaining aggregate review finding"), repoPath: "." }, "revision-task-2");
    assert.equal(secondRevision.sequenceBaseCommit, "f".repeat(40));
    seedAuthoritativeDone(path, secondRevision.id, "9".repeat(40));
    const thirdAttempt = store.startSequenceGoalReview(sequence.id, "1".repeat(64), "revision-review-3");
    store.finishSequenceGoalReview({ attemptId: thirdAttempt.attemptId, verifiedEvidenceFingerprint: "1".repeat(64),
      result: { verdict: "changes_requested", summary: "Still unmet.", findings: [
        { severity: "medium", evidence: "A requirement remains unmet.", requestedChange: "Complete the requirement." },
      ] } });
    assert.throws(() => store.appendSequenceGoalRevision(sequence.id, thirdAttempt.attemptId,
      { ...submission("Do not exceed the limit"), repoPath: "." }, "revision-task-3"), /limit reached/);
    assert.equal(store.getSequence(sequence.id)?.goalRevisionCount, 2);
    assert.equal(store.get("revision-task-3"), undefined);
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

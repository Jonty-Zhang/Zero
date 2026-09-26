import test from "node:test";
import assert from "node:assert/strict";
import { configureTaskStorePragmas, TaskStore } from "./task-store.js";
import type { TaskSubmission } from "../domain/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";

test("file-backed task store reopens with WAL and FULL synchronous mode", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-sqlite-durability-"));
  const path = join(root, "tasks.sqlite");
  try {
    const first = new TaskStore(path);
    const submitted = first.submit({ repoPath: ".", baseRef: "main", prompt: "persist across reopen" }, "sqlite_durability_reopen");
    first.close();

    const reopened = new TaskStore(path);
    assert.equal(reopened.get(submitted.id)?.prompt, submitted.prompt);
    reopened.close();

    const verification = new DatabaseSync(path);
    try {
      configureTaskStorePragmas(verification, path);
      assert.equal((verification.prepare("PRAGMA journal_mode;").get() as { journal_mode: string }).journal_mode, "wal");
      assert.equal((verification.prepare("PRAGMA synchronous;").get() as { synchronous: number }).synchronous, 2);
    } finally { verification.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

function reviewFixture(checks = [{ id: "unit", argv: ["node", "test.js"] }], leaseMs = 60_000, path = ":memory:",
  startup?: import("./task-store.js").StartupGenerationAttestation) {
  const store = new TaskStore(path, startup);
  const task = store.submit({ repoPath: ".", baseRef: "main", prompt: "review package", checks }, "review_package_store_test");
  const owner = "review-worker";
  const claimed = store.claimNext(owner, leaseMs)!;
  const generationId = claimed.claimGenerationId!;
  const route: import("../domain/types.js").RouteDecision = {
    taskId: task.id, harness: "zcode", model: "model-x", selectionSource: "codex", reason: "test route", decidedAt: new Date().toISOString(),
  };
  const routeAttempt = store.createAttempt(task.id, "route", { owner, harness: "codex" });
  store.finishAttempt(routeAttempt.id, { status: "succeeded", metadata: { decision: route } });
  store.saveRoute(route);
  const stage = store.createStage(task.id, { role: "implement", processStartId: "process-1", harness: "zcode", model: "model-x" });
  store.startStage(stage.id, owner, "process-1");
  const execution = store.createAttempt(task.id, "implement", { owner, stageId: stage.id, harness: "zcode", model: "model-x" });
  store.finishAttempt(execution.id, { status: "succeeded" }, { owner, processStartId: "process-1" });
  const diff = "diff --git a/a b/a\n+change\n";
  const snapshot = { baseCommit: "a".repeat(40), preHead: "b".repeat(40), treeId: "c".repeat(40), fingerprint: "fingerprint",
    diffHash: createHash("sha256").update(diff, "utf8").digest("hex"), diff };
  const expectedCheckIds = checks.map(check => check.id);
  const checkDefinitionHash = createHash("sha256").update(JSON.stringify(checks), "utf8").digest("hex");
  const input = { taskId: task.id, owner, generationId, executionAttemptId: execution.id, executionStageId: stage.id,
    routeAttemptId: routeAttempt.id, route, branchRef: `refs/heads/zero/${task.id}`, snapshot, checkDefinitionHash, expectedCheckIds };
  const result = (id: string, status: "passed" | "failed" = "passed") => ({ id, argv: ["node", "test.js"], status, exitCode: status === "passed" ? 0 : 1, durationMs: 10 });
  return { store, task, owner, generationId, route, routeAttempt, stage, execution, snapshot, input, result };
}

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

test("durable check run creates a review package and reviewing transition atomically", () => {
  const f = reviewFixture();
  try {
    const run = f.store.startCheckRun(f.input);
    f.store.recordCheckResult(run.id, { owner: f.owner, generationId: f.generationId }, f.result("unit"));
    f.store.finishStage(f.stage.id, f.owner, "process-1", "succeeded", "fingerprint");
    const completed = f.store.completeCheckRun(run.id, { owner: f.owner, generationId: f.generationId }, f.snapshot);
    assert.equal(completed.checkRun.status, "completed");
    assert.equal(completed.reviewPackage.checkRunId, run.id);
    assert.equal(completed.reviewPackage.routeAttemptId, f.routeAttempt.id);
    assert.equal(completed.reviewPackage.branchRef, `refs/heads/zero/${f.task.id}`);
    assert.equal(completed.reviewPackage.snapshot.diff, f.snapshot.diff);
    assert.equal(f.store.get(f.task.id)?.status, "reviewing");
    assert.equal(f.store.reviewPackages(f.task.id).length, 1);
  } finally { f.store.close(); }
});

function completeReviewPackage(f: ReturnType<typeof reviewFixture>) {
  const run = f.store.startCheckRun(f.input);
  for (const checkId of f.input.expectedCheckIds) {
    f.store.recordCheckResult(run.id, { owner: f.owner, generationId: f.generationId }, f.result(checkId));
  }
  f.store.finishStage(f.stage.id, f.owner, "process-1", "succeeded", "fingerprint");
  return f.store.completeCheckRun(run.id, { owner: f.owner, generationId: f.generationId }, f.snapshot).reviewPackage;
}

function startBoundReviewAttempt(f: ReturnType<typeof reviewFixture>, packageId: string) {
  return f.store.createAttempt(f.task.id, "review", { owner: f.owner, harness: "codex",
    metadata: { packageId, generationId: f.generationId } });
}

function completePassingReview(f: ReturnType<typeof reviewFixture>) {
  const pkg = completeReviewPackage(f);
  const attempt = startBoundReviewAttempt(f, pkg.id);
  const verdict = f.store.finishPackageReview({ packageId: pkg.id, attemptId: attempt.id, owner: f.owner,
    generationId: f.generationId, recheckedSnapshot: pkg.snapshot,
    result: { verdict: "pass", summary: "No findings.", findings: [] }, attemptResult: { exitCode: 0 } });
  const input = { operationId: "commit-test-1", packageId: pkg.id, verdictId: verdict.id, owner: f.owner,
    generationId: f.generationId, branchRef: pkg.branchRef, preHead: pkg.snapshot.preHead, treeId: pkg.snapshot.treeId,
    diffHash: pkg.snapshot.diffHash, message: "Implement reviewed change", timestamp: "2026-09-26T12:00:00.000Z" };
  return { pkg, attempt, verdict, input };
}

function completeAppliedCommit(f: ReturnType<typeof reviewFixture>) {
  const prepared = completePassingReview(f);
  const operation = f.store.createCommitOperation(prepared.input);
  const candidateSha = "d".repeat(40);
  f.store.recordCommitOperationCandidate(operation.id, { owner: f.owner, generationId: f.generationId }, candidateSha);
  const applied = f.store.markCommitOperationApplied(operation.id, { owner: f.owner, generationId: f.generationId }, {
    branchRef: operation.branchRef, refHead: candidateSha, worktreeHead: candidateSha, treeId: operation.treeId,
    diffHash: operation.diffHash, candidateObjectVerified: true, indexMatchesReviewedTree: true, worktreeClean: true,
  });
  return { ...prepared, operation: applied, candidateSha };
}

function reportInput(f: ReturnType<typeof reviewFixture>, applied: ReturnType<typeof completeAppliedCommit>, operationId = "report-test-1") {
  const artifactDirectory = join(process.cwd(), ".zero-artifacts", f.task.id);
  const reportBytes = Buffer.from(`${JSON.stringify({ taskId: f.task.id, resultCommit: applied.candidateSha,
    finalStatus: "done", diffPath: join(artifactDirectory, "result.diff") }, null, 2)}\n`, "utf8");
  const diffBytes = Buffer.from(applied.pkg.snapshot.diff, "utf8");
  const eventHighWater = f.store.events(f.task.id).at(-1)?.id ?? 0;
  return { operationId, commitOperationId: applied.operation.id, owner: f.owner, generationId: f.generationId,
    artifactDirectory, eventHighWater, reportBytes, diffBytes };
}

function completeReportOperation(f: ReturnType<typeof reviewFixture>, applied: ReturnType<typeof completeAppliedCommit>) {
  const input = reportInput(f, applied);
  const prepared = f.store.createReportOperation(input);
  return f.store.completeReportOperation(prepared.id, { owner: f.owner, generationId: f.generationId },
    { reportBytes: input.reportBytes, diffBytes: input.diffBytes });
}

function registerReviewRecoveryWorktree(f: ReturnType<typeof reviewFixture>) {
  const plan = { taskId: f.task.id, repoPath: "C:/repo", commonGitDir: "C:/repo/.git", worktreeRoot: "C:/worktrees",
    path: `C:/worktrees/${f.task.id}`, branch: `zero/${f.task.id}`, baseCommit: f.snapshot.baseCommit };
  f.store.recordWorktreeCreationIntent(f.task.id, f.owner, plan);
  const observed = { info: { taskId: f.task.id, repoPath: plan.repoPath, path: plan.path, branch: plan.branch, baseCommit: plan.baseCommit },
    commonGitDir: plan.commonGitDir, head: plan.baseCommit, fingerprint: "b".repeat(64) };
  f.store.completeWorktreeCreation(f.task.id, f.owner, observed, "b".repeat(64));
  return { plan, observed };
}

function reviewRecoveryInput(f: ReturnType<typeof reviewFixture>, observed: unknown, kind: "pre_commit" | "applied_candidate",
  at = new Date(), applied?: ReturnType<typeof completeAppliedCommit>) {
  const state = kind === "pre_commit"
    ? { kind, checkedAt: at.toISOString(), branchRef: `refs/heads/zero/${f.task.id}`, head: f.snapshot.preHead,
        treeId: f.snapshot.treeId, diffHash: f.snapshot.diffHash, snapshot: f.snapshot }
    : { kind, checkedAt: at.toISOString(), packageId: applied!.pkg.id, commitOperationId: applied!.operation.id,
        branchRef: applied!.operation.branchRef, head: applied!.candidateSha, refHead: applied!.candidateSha,
        treeId: applied!.operation.treeId, diffHash: applied!.operation.diffHash, candidateSha: applied!.candidateSha,
        candidateObjectVerified: true as const, indexMatchesReviewedTree: true as const, worktreeClean: true as const };
  const observedValue = observed as { info: Record<string, unknown>; commonGitDir: string };
  return { now: at, identity: { checkedAt: at.toISOString(), observed: { ...observedValue, head: state.head, fingerprint: "c".repeat(64) }, fingerprint: "c".repeat(64) }, gitState: state };
}

test("dedicated DONE transaction requires the complete evidence chain and fresh Git verification", () => {
  const f = reviewFixture();
  try {
    const applied = completeAppliedCommit(f);
    const gitEvidence = { branchRef: applied.operation.branchRef, refHead: applied.candidateSha, worktreeHead: applied.candidateSha,
      treeId: applied.operation.treeId, diffHash: applied.operation.diffHash, candidateObjectVerified: true as const,
      indexMatchesReviewedTree: true as const, worktreeClean: true as const };
    const report = completeReportOperation(f, applied);
    const doneInput = { taskId: f.task.id, reportOperationId: report.id, owner: f.owner,
      generationId: f.generationId, gitEvidence };

    assert.throws(() => f.store.transition(f.task.id, "reviewing", "done"), /Illegal task state transition/);
    assert.throws(() => f.store.completeReviewedTask({ ...doneInput, gitEvidence: { ...gitEvidence, refHead: "e".repeat(40) } }), /Fresh Git verification does not match/);
    assert.equal(f.store.get(f.task.id)?.status, "reviewing");

    const completed = f.store.completeReviewedTask(doneInput);
    assert.equal(completed.status, "done");
    assert.equal(completed.leaseOwner, undefined);
    assert.equal(completed.leaseExpiresAt, undefined);
    assert.equal(f.store.events(f.task.id).filter(event => event.type === "task.transition" &&
      (event.payload as { to?: string } | undefined)?.to === "done").length, 1);
    assert.throws(() => f.store.completeReviewedTask(doneInput), /not reviewing under live owner/);
    assert.equal(f.store.events(f.task.id).filter(event => event.type === "task.transition" &&
      (event.payload as { to?: string } | undefined)?.to === "done").length, 1);
  } finally { f.store.close(); }
});

test("G0 pass verdict can create G1 commit intent only through the explicit recovery API and reach DONE", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-recovered-verdict-done-"));
  const path = join(root, "tasks.sqlite");
  const lockId = "4".repeat(64);
  const g0 = "21212121212121212121212121212121";
  const g1 = "31313131313131313131313131313131";
  let f = reviewFixture([{ id: "unit", argv: ["node", "test.js"] }], 60_000, path,
    { id: g0, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    const { observed } = registerReviewRecoveryWorktree(f);
    const reviewed = completePassingReview(f);
    f.store.recoverExpired(new Date(Date.now() + 120_000));
    f.store.close();
    f.store = new TaskStore(path, { id: g1, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    const claimAt = new Date();
    f.store.claimReviewRecovery(f.task.id, "recovery-g1", reviewRecoveryInput(f, observed, "pre_commit", claimAt));
    const preCommitInspection = { checkedAt: claimAt.toISOString(), branchRef: reviewed.pkg.branchRef,
      head: reviewed.pkg.snapshot.preHead, snapshot: reviewed.pkg.snapshot };
    const input = { ...reviewed.input, operationId: "recovered-commit-g1", owner: "recovery-g1", generationId: g1,
      preCommitInspection };
    assert.throws(() => f.store.createCommitOperation({ ...reviewed.input, operationId: "normal-api-must-stay-strict",
      owner: "recovery-g1", generationId: g1 }), /successful atomic Codex package verdict/);
    const operation = f.store.createCommitOperationFromRecoveredVerdict(input);
    assert.equal(operation.verdictId, reviewed.verdict.id);
    assert.equal(operation.generationId, g1);
    assert.equal(operation.owner, "recovery-g1");
    assert.equal(operation.status, "intent");
    const candidateSha = "d".repeat(40);
    f.store.recordCommitOperationCandidate(operation.id, { owner: "recovery-g1", generationId: g1 }, candidateSha);
    const appliedOperation = f.store.markCommitOperationApplied(operation.id, { owner: "recovery-g1", generationId: g1 }, {
      branchRef: operation.branchRef, refHead: candidateSha, worktreeHead: candidateSha, treeId: operation.treeId,
      diffHash: operation.diffHash, candidateObjectVerified: true, indexMatchesReviewedTree: true, worktreeClean: true,
    });
    const applied = { ...reviewed, operation: appliedOperation, candidateSha };
    const reportInputValue = { ...reportInput(f, applied, "recovered-report-g1"), owner: "recovery-g1", generationId: g1 };
    const report = f.store.createReportOperation(reportInputValue);
    f.store.completeReportOperation(report.id, { owner: "recovery-g1", generationId: g1 }, {
      reportBytes: reportInputValue.reportBytes, diffBytes: reportInputValue.diffBytes,
    });
    const evidence = { branchRef: operation.branchRef, refHead: candidateSha, worktreeHead: candidateSha,
      treeId: operation.treeId, diffHash: operation.diffHash, candidateObjectVerified: true as const,
      indexMatchesReviewedTree: true as const, worktreeClean: true as const };
    assert.equal(f.store.completeReviewedTask({ taskId: f.task.id, reportOperationId: report.id,
      owner: "recovery-g1", generationId: g1, gitEvidence: evidence }).status, "done");
  } finally {
    f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("review recovery accepts multiple proven task owners within the source generation after same-generation reclaim", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-review-same-generation-reclaim-"));
  const path = join(root, "tasks.sqlite");
  const lockId = "6".repeat(64);
  const g0 = "81818181818181818181818181818181";
  const g1 = "91919191919191919191919191919191";
  const quotaOwner = "quota-resume-owner";
  let f = reviewFixture([{ id: "unit", argv: ["node", "test.js"] }], 60_000, path,
    { id: g0, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    const { observed } = registerReviewRecoveryWorktree(f);
    completePassingReview(f);
    const editor = new DatabaseSync(path);
    try {
      editor.prepare("UPDATE tasks SET lease_owner=?,lease_expires_at=? WHERE id=?")
        .run(quotaOwner, new Date(Date.now() - 1_000).toISOString(), f.task.id);
      editor.prepare("INSERT INTO events(task_id,type,at,payload) VALUES(?,?,?,?)").run(f.task.id, "task.claimed",
        new Date().toISOString(), JSON.stringify({ owner: quotaOwner, generationId: g0, recovery: "quota_resume" }));
    } finally { editor.close(); }
    f.store.recoverExpired(new Date());
    f.store.close();
    f.store = new TaskStore(path, { id: g1, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    const at = new Date();
    const claim = f.store.claimReviewRecovery(f.task.id, "recovery-g1", reviewRecoveryInput(f, observed, "pre_commit", at));
    assert.equal(claim?.priorClaimGenerationId, g0);
    assert.equal(claim?.claimGenerationId, g1);
    assert.equal(f.store.get(f.task.id)?.leaseOwner, "recovery-g1");
  } finally {
    f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("review recovery validates package epochs across revision before a later generation claim", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-review-recovery-package-epochs-"));
  const path = join(root, "tasks.sqlite");
  const lockId = "8".repeat(64);
  const g0 = "a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8";
  const g1 = "b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8";
  const g2 = "c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8";
  const g1Owner = "recovery-g1";
  let f = reviewFixture([{ id: "unit", argv: ["node", "test.js"] }], 60_000, path,
    { id: g0, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    const { observed } = registerReviewRecoveryWorktree(f);
    const p1 = completeReviewPackage(f);
    const p1Review = startBoundReviewAttempt(f, p1.id);
    f.store.finishPackageReview({ packageId: p1.id, attemptId: p1Review.id, owner: f.owner, generationId: g0,
      recheckedSnapshot: p1.snapshot, result: { verdict: "pass", summary: "P1 reviewed.", findings: [] }, attemptResult: { exitCode: 0 } });
    f.store.recoverExpired(new Date(Date.now() + 120_000));
    f.store.close();
    f.store = new TaskStore(path, { id: g1, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    const recoveredAt = new Date();
    const firstClaim = f.store.claimReviewRecovery(f.task.id, g1Owner, reviewRecoveryInput(f, observed, "pre_commit", recoveredAt));
    assert.ok(firstClaim);

    // G1 performs a review of P1, requests a revision, and seals P2 in G1.
    const p1G1Review = f.store.createAttempt(f.task.id, "review", { owner: g1Owner, harness: "codex",
      metadata: { packageId: p1.id, generationId: g1 } });
    f.store.finishPackageReview({ packageId: p1.id, attemptId: p1G1Review.id, owner: g1Owner, generationId: g1,
      recheckedSnapshot: p1.snapshot, result: { verdict: "changes_requested", summary: "Revise P1.",
        findings: [{ severity: "low", evidence: "Missing edge case.", requestedChange: "Add coverage." }] }, attemptResult: { exitCode: 0 } });
    f.store.transition(f.task.id, "reviewing", "revision", { owner: g1Owner, incrementRevision: true, reason: "review requested changes" });
    f.store.transition(f.task.id, "revision", "running", { owner: g1Owner, reason: "starting revision" });
    const reviseStage = f.store.createStage(f.task.id, { role: "revise", processStartId: "process-g1-revise", harness: "zcode", model: "model-x" });
    f.store.startStage(reviseStage.id, g1Owner, "process-g1-revise");
    const reviseAttempt = f.store.createAttempt(f.task.id, "revise", { owner: g1Owner, stageId: reviseStage.id, harness: "zcode", model: "model-x" });
    f.store.finishAttempt(reviseAttempt.id, { status: "succeeded" }, { owner: g1Owner, processStartId: "process-g1-revise" });
    const p2Input = { ...f.input, owner: g1Owner, generationId: g1, executionAttemptId: reviseAttempt.id,
      executionStageId: reviseStage.id, snapshot: p1.snapshot };
    const run = f.store.startCheckRun(p2Input);
    f.store.recordCheckResult(run.id, { owner: g1Owner, generationId: g1 }, f.result("unit"));
    f.store.finishStage(reviseStage.id, g1Owner, "process-g1-revise", "succeeded", "p2-fingerprint");
    const p2 = f.store.completeCheckRun(run.id, { owner: g1Owner, generationId: g1 }, p1.snapshot).reviewPackage;
    assert.notEqual(p2.id, p1.id);
    const p2Review = f.store.createAttempt(f.task.id, "review", { owner: g1Owner, harness: "codex",
      metadata: { packageId: p2.id, generationId: g1 } });
    const p2Verdict = f.store.finishPackageReview({ packageId: p2.id, attemptId: p2Review.id, owner: g1Owner, generationId: g1,
      recheckedSnapshot: p2.snapshot, result: { verdict: "pass", summary: "P2 passes.", findings: [] }, attemptResult: { exitCode: 0 } });

    f.store.recoverExpired(new Date(Date.now() + 120_000));
    f.store.close();
    f.store = new TaskStore(path, { id: g2, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    const secondClaimAt = new Date();
    const secondClaim = f.store.claimReviewRecovery(f.task.id, "recovery-g2", reviewRecoveryInput(f, observed, "pre_commit", secondClaimAt));
    assert.equal(secondClaim?.priorCheckpointId, firstClaim?.id);
    assert.equal(secondClaim?.priorClaimGenerationId, g1);
    assert.equal(secondClaim?.claimGenerationId, g2);
    assert.equal((f.store.reviewRecoveryClaims(f.task.id)[0]?.packageId), p1.id);
    assert.equal((f.store.reviewRecoveryClaims(f.task.id)[1]?.packageId), p2.id);

    const recoveredCommitInput = { operationId: "epoch-commit-g2", taskId: f.task.id, packageId: p2.id, verdictId: p2Verdict.id,
      owner: "recovery-g2", generationId: g2, branchRef: p2.branchRef, preHead: p2.snapshot.preHead,
      treeId: p2.snapshot.treeId, diffHash: p2.snapshot.diffHash, message: "Commit revised P2",
      timestamp: new Date().toISOString(), preCommitInspection: { checkedAt: new Date().toISOString(), branchRef: p2.branchRef,
        head: p2.snapshot.preHead, snapshot: p2.snapshot } };
    const commit = f.store.createCommitOperationFromRecoveredVerdict(recoveredCommitInput);
    const candidateSha = "d".repeat(40);
    f.store.recordCommitOperationCandidate(commit.id, { owner: "recovery-g2", generationId: g2 }, candidateSha);
    const appliedOperation = f.store.markCommitOperationApplied(commit.id, { owner: "recovery-g2", generationId: g2 }, {
      branchRef: commit.branchRef, refHead: candidateSha, worktreeHead: candidateSha, treeId: commit.treeId,
      diffHash: commit.diffHash, candidateObjectVerified: true, indexMatchesReviewedTree: true, worktreeClean: true,
    });
    const applied = { pkg: p2, attempt: p2Review, verdict: p2Verdict, input: recoveredCommitInput,
      operation: appliedOperation, candidateSha };
    const reportInputValue = { ...reportInput(f, applied, "epoch-report-g2"), owner: "recovery-g2", generationId: g2 };
    const report = f.store.createReportOperation(reportInputValue);
    f.store.completeReportOperation(report.id, { owner: "recovery-g2", generationId: g2 }, {
      reportBytes: reportInputValue.reportBytes, diffBytes: reportInputValue.diffBytes,
    });
    const gitEvidence = { branchRef: commit.branchRef, refHead: candidateSha, worktreeHead: candidateSha, treeId: commit.treeId,
      diffHash: commit.diffHash, candidateObjectVerified: true as const, indexMatchesReviewedTree: true as const, worktreeClean: true as const };
    assert.equal(f.store.completeReviewedTask({ taskId: f.task.id, reportOperationId: report.id, owner: "recovery-g2",
      generationId: g2, gitEvidence }).status, "done");
  } finally {
    f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("G0 completed report survives G1/G2 claims and DONE rejects foreign report generations or a broken chain", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-recovered-complete-report-done-"));
  const path = join(root, "tasks.sqlite");
  const lockId = "5".repeat(64);
  const g0 = "41414141414141414141414141414141";
  const g1 = "51515151515151515151515151515151";
  const g2 = "61616161616161616161616161616161";
  const foreignGeneration = "71717171717171717171717171717171";
  let f = reviewFixture([{ id: "unit", argv: ["node", "test.js"] }], 60_000, path,
    { id: g0, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    const { observed } = registerReviewRecoveryWorktree(f);
    const applied = completeAppliedCommit(f);
    const report = completeReportOperation(f, applied);
    f.store.recoverExpired(new Date(Date.now() + 120_000));
    f.store.close();
    f.store = new TaskStore(path, { id: g1, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    let at = new Date();
    const first = f.store.claimReviewRecovery(f.task.id, "recovery-g1", reviewRecoveryInput(f, observed, "applied_candidate", at, applied));
    assert.equal(f.store.getReportOperation(report.id)?.claimGenerationId, g0);
    f.store.recoverExpired(new Date(Date.now() + 120_000));
    f.store.close();
    f.store = new TaskStore(path, { id: g2, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    at = new Date();
    const second = f.store.claimReviewRecovery(f.task.id, "recovery-g2", reviewRecoveryInput(f, observed, "applied_candidate", at, applied));
    assert.equal(second?.priorCheckpointId, first?.id);
    assert.equal(f.store.getReportOperation(report.id)?.claimGenerationId, g0);
    assert.equal(f.store.getCommitOperation(applied.operation.id)?.claimGenerationId, g2);
    const evidence = { branchRef: applied.operation.branchRef, refHead: applied.candidateSha, worktreeHead: applied.candidateSha,
      treeId: applied.operation.treeId, diffHash: applied.operation.diffHash, candidateObjectVerified: true as const,
      indexMatchesReviewedTree: true as const, worktreeClean: true as const };

    const foreign = new TaskStore(path, { id: foreignGeneration, predecessorDrained: false, evidenceKind: "unguarded" });
    foreign.close();
    const editor = new DatabaseSync(path);
    try {
      editor.exec("DROP TRIGGER report_operations_guard_update");
      editor.prepare("UPDATE report_operations SET claim_generation_id=? WHERE id=?").run(foreignGeneration, report.id);
    } finally { editor.close(); }
    assert.throws(() => f.store.completeReviewedTask({ taskId: f.task.id, reportOperationId: report.id,
      owner: "recovery-g2", generationId: g2, gitEvidence: evidence }), /verified continuous task claim chain/);

    const repair = new DatabaseSync(path);
    try { repair.prepare("UPDATE report_operations SET claim_generation_id=? WHERE id=?").run(g0, report.id); }
    finally { repair.close(); }

    const reportOwnerTamper = new DatabaseSync(path);
    try { reportOwnerTamper.prepare("UPDATE report_operations SET owner=? WHERE id=?").run("foreign-report-creator", report.id); }
    finally { reportOwnerTamper.close(); }
    assert.throws(() => f.store.completeReviewedTask({ taskId: f.task.id, reportOperationId: report.id,
      owner: "recovery-g2", generationId: g2, gitEvidence: evidence }), /generation owners must match/);
    const reportOwnerRestore = new DatabaseSync(path);
    try { reportOwnerRestore.prepare("UPDATE report_operations SET owner=? WHERE id=?").run(f.owner, report.id); }
    finally { reportOwnerRestore.close(); }

    const reportClaimOwnerTamper = new DatabaseSync(path);
    try { reportClaimOwnerTamper.prepare("UPDATE report_operations SET claim_owner=? WHERE id=?").run("foreign-report-claimer", report.id); }
    finally { reportClaimOwnerTamper.close(); }
    assert.throws(() => f.store.completeReviewedTask({ taskId: f.task.id, reportOperationId: report.id,
      owner: "recovery-g2", generationId: g2, gitEvidence: evidence }), /generation owners must match/);
    const reportClaimOwnerRestore = new DatabaseSync(path);
    try { reportClaimOwnerRestore.prepare("UPDATE report_operations SET claim_owner=? WHERE id=?").run(f.owner, report.id); }
    finally { reportClaimOwnerRestore.close(); }

    const commitOwnerTamper = new DatabaseSync(path);
    try {
      commitOwnerTamper.exec("DROP TRIGGER commit_operations_guard_update");
      commitOwnerTamper.prepare("UPDATE commit_operations SET owner=? WHERE id=?").run("foreign-commit-creator", applied.operation.id);
    } finally { commitOwnerTamper.close(); }
    assert.throws(() => f.store.completeReviewedTask({ taskId: f.task.id, reportOperationId: report.id,
      owner: "recovery-g2", generationId: g2, gitEvidence: evidence }), /generation owners must match/);
    const commitOwnerRestore = new DatabaseSync(path);
    try { commitOwnerRestore.prepare("UPDATE commit_operations SET owner=? WHERE id=?").run(f.owner, applied.operation.id); }
    finally { commitOwnerRestore.close(); }

    const reviewOwnerTamper = new DatabaseSync(path);
    let reviewEvent: { id: number; payload: string } | undefined;
    try {
      reviewEvent = reviewOwnerTamper.prepare("SELECT id,payload FROM events WHERE task_id=? AND type='review.finished' ORDER BY id DESC LIMIT 1")
        .get(f.task.id) as { id: number; payload: string } | undefined;
      const payload = JSON.parse(reviewEvent!.payload) as Record<string, unknown>;
      reviewOwnerTamper.prepare("UPDATE events SET payload=? WHERE id=?").run(JSON.stringify({ ...payload, owner: "foreign-reviewer" }), reviewEvent!.id);
    } finally { reviewOwnerTamper.close(); }
    assert.throws(() => f.store.completeReviewedTask({ taskId: f.task.id, reportOperationId: report.id,
      owner: "recovery-g2", generationId: g2, gitEvidence: evidence }), /generation owners must match/);
    const reviewOwnerRestore = new DatabaseSync(path);
    try { reviewOwnerRestore.prepare("UPDATE events SET payload=? WHERE id=?").run(reviewEvent!.payload, reviewEvent!.id); }
    finally { reviewOwnerRestore.close(); }

    const tamper = new DatabaseSync(path);
    try {
      tamper.exec("DROP TRIGGER review_recovery_claims_no_update");
      tamper.prepare("UPDATE review_recovery_claims SET prior_checkpoint_id=id WHERE id=?").run(first!.id);
    } finally { tamper.close(); }
    assert.throws(() => f.store.completeReviewedTask({ taskId: f.task.id, reportOperationId: report.id,
      owner: "recovery-g2", generationId: g2, gitEvidence: evidence }), /verified continuous task claim chain/);
    const restore = new DatabaseSync(path);
    try { restore.prepare("UPDATE review_recovery_claims SET prior_checkpoint_id=NULL WHERE id=?").run(first!.id); }
    finally { restore.close(); }

    assert.equal(f.store.completeReviewedTask({ taskId: f.task.id, reportOperationId: report.id,
      owner: "recovery-g2", generationId: g2, gitEvidence: evidence }).status, "done");
  } finally {
    f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("DONE rejects missing or incomplete report operations and a stale lease", async () => {
  const f = reviewFixture(undefined, 150);
  try {
    const applied = completeAppliedCommit(f);
    const gitEvidence = { branchRef: applied.operation.branchRef, refHead: applied.candidateSha, worktreeHead: applied.candidateSha,
      treeId: applied.operation.treeId, diffHash: applied.operation.diffHash, candidateObjectVerified: true as const,
      indexMatchesReviewedTree: true as const, worktreeClean: true as const };
    assert.throws(() => f.store.completeReviewedTask({ taskId: f.task.id, reportOperationId: "missing-report",
      owner: f.owner, generationId: f.generationId, gitEvidence }), /complete report operation/);
    const input = reportInput(f, applied);
    const prepared = f.store.createReportOperation(input);
    assert.throws(() => f.store.completeReviewedTask({ taskId: f.task.id, reportOperationId: prepared.id,
      owner: f.owner, generationId: f.generationId, gitEvidence }), /complete report operation/);
    await new Promise(resolve => setTimeout(resolve, 170));
    assert.throws(() => f.store.completeReviewedTask({ taskId: f.task.id, reportOperationId: prepared.id,
      owner: f.owner, generationId: f.generationId, gitEvidence }), /live owner/);
    assert.equal(f.store.get(f.task.id)?.status, "reviewing");
  } finally { f.store.close(); }
});

test("DONE rechecks the atomic verdict instead of trusting an applied commit or report", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-done-verdict-"));
  const dbPath = join(root, "tasks.sqlite");
  const f = reviewFixture(undefined, 60_000, dbPath);
  try {
    const applied = completeAppliedCommit(f);
    const report = completeReportOperation(f, applied);
    const evidence = { branchRef: applied.operation.branchRef, refHead: applied.candidateSha, worktreeHead: applied.candidateSha,
      treeId: applied.operation.treeId, diffHash: applied.operation.diffHash, candidateObjectVerified: true as const,
      indexMatchesReviewedTree: true as const, worktreeClean: true as const };
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("DROP TRIGGER review_verdicts_no_update");
      db.prepare("UPDATE review_verdicts SET result=? WHERE id=?")
        .run(JSON.stringify({ verdict: "changes_requested", summary: "not accepted", findings: [{ severity: "high", evidence: "failed", requestedChange: "fix" }] }), applied.verdict.id);
    } finally { db.close(); }
    assert.throws(() => f.store.completeReviewedTask({ taskId: f.task.id, reportOperationId: report.id,
      owner: f.owner, generationId: f.generationId, gitEvidence: evidence }), /passing verdict/);
    assert.equal(f.store.get(f.task.id)?.status, "reviewing");
  } finally {
    f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("report operation stores fixed UTF-8 bytes, hashes, paths, and repairs after store reopen", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-report-operation-"));
  const dbPath = join(root, "tasks.sqlite");
  const f = reviewFixture(undefined, 60_000, dbPath);
  try {
    const applied = completeAppliedCommit(f);
    const input = reportInput(f, applied);
    const operation = f.store.createReportOperation(input);
    assert.equal(operation.status, "prepared");
    assert.equal(operation.packageId, applied.pkg.id);
    assert.equal(operation.verdictId, applied.verdict.id);
    assert.equal(operation.eventHighWater, input.eventHighWater);
    assert.equal(operation.artifactDirectory, input.artifactDirectory);
    assert.equal(operation.reportPath, join(input.artifactDirectory, "report.json"));
    assert.equal(operation.diffPath, join(input.artifactDirectory, "result.diff"));
    assert.deepEqual(operation.reportBytes, input.reportBytes);
    assert.deepEqual(operation.diffBytes, input.diffBytes);
    assert.equal(operation.reportSize, input.reportBytes.byteLength);
    assert.equal(operation.diffSize, input.diffBytes.byteLength);
    assert.equal(operation.reportSha256, createHash("sha256").update(input.reportBytes).digest("hex"));
    assert.equal(operation.diffSha256, applied.operation.diffHash);
    assert.throws(() => f.store.createReportOperation({ ...input, eventHighWater: f.store.events(f.task.id).at(-1)!.id }), /UNIQUE constraint failed/);

    f.store.close();
    const reopened = new TaskStore(dbPath);
    try {
      const recovered = reopened.getReportOperation(operation.id)!;
      assert.deepEqual(recovered.reportBytes, input.reportBytes);
      assert.deepEqual(recovered.diffBytes, input.diffBytes);
      assert.equal(recovered.reportSha256, operation.reportSha256);
      assert.equal(reopened.reportOperations(f.task.id).length, 1);
    } finally { reopened.close(); }
  } finally {
    try { f.store.close(); } catch { /* closed before reopen */ }
    await rm(root, { recursive: true, force: true });
  }
});

test("report completion requires exact independent readback bytes and live claim", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-report-operation-guard-"));
  const dbPath = join(root, "tasks.sqlite");
  const f = reviewFixture(undefined, 60_000, dbPath);
  try {
    const applied = completeAppliedCommit(f);
    const input = reportInput(f, applied);
    const operation = f.store.createReportOperation(input);
    const guard = { owner: f.owner, generationId: f.generationId };
    assert.throws(() => f.store.completeReportOperation(operation.id, { owner: "stale", generationId: f.generationId },
      { reportBytes: input.reportBytes, diffBytes: input.diffBytes }), /guard/);
    assert.throws(() => f.store.completeReportOperation(operation.id, guard,
      { reportBytes: Buffer.from(`${input.reportBytes.toString("utf8")}tamper`), diffBytes: input.diffBytes }), /readback bytes/);
    assert.throws(() => f.store.completeReportOperation(operation.id, guard,
      { reportBytes: input.reportBytes, diffBytes: Buffer.from(`${input.diffBytes.toString("utf8")}tamper`) }), /readback bytes/);
    assert.equal(f.store.getReportOperation(operation.id)?.status, "prepared");

    const completed = f.store.completeReportOperation(operation.id, guard, { reportBytes: input.reportBytes, diffBytes: input.diffBytes });
    assert.equal(completed.status, "complete");
    assert.ok(completed.completedAt);
    assert.deepEqual(f.store.completeReportOperation(operation.id, guard, { reportBytes: input.reportBytes, diffBytes: input.diffBytes }), completed);

    const db = new DatabaseSync(dbPath);
    try { db.prepare("UPDATE tasks SET lease_expires_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", f.task.id); }
    finally { db.close(); }
    assert.throws(() => f.store.completeReportOperation(operation.id, guard,
      { reportBytes: input.reportBytes, diffBytes: input.diffBytes }), /live owner/);
  } finally {
    f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("report creation rejects premature commits, stale event snapshots, and modified diff content", () => {
  const f = reviewFixture();
  try {
    const prepared = completePassingReview(f);
    const commit = f.store.createCommitOperation(prepared.input);
    const invalidBase = { operationId: "report-premature", commitOperationId: commit.id, owner: f.owner,
      generationId: f.generationId, artifactDirectory: join(process.cwd(), ".zero-artifacts", f.task.id),
      eventHighWater: f.store.events(f.task.id).at(-1)!.id,
      reportBytes: Buffer.from(JSON.stringify({ taskId: f.task.id, resultCommit: "d".repeat(40), finalStatus: "done",
        diffPath: join(process.cwd(), ".zero-artifacts", f.task.id, "result.diff") })), diffBytes: Buffer.from(prepared.pkg.snapshot.diff) };
    assert.throws(() => f.store.createReportOperation(invalidBase), /applied commit operation/);

    const candidateSha = "d".repeat(40);
    f.store.recordCommitOperationCandidate(commit.id, { owner: f.owner, generationId: f.generationId }, candidateSha);
    f.store.markCommitOperationApplied(commit.id, { owner: f.owner, generationId: f.generationId }, {
      branchRef: commit.branchRef, refHead: candidateSha, worktreeHead: candidateSha, treeId: commit.treeId,
      diffHash: commit.diffHash, candidateObjectVerified: true, indexMatchesReviewedTree: true, worktreeClean: true,
    });
    const applied = f.store.getCommitOperation(commit.id)!;
    assert.throws(() => f.store.createReportOperation({ ...reportInput(f, { ...prepared, operation: applied, candidateSha }), eventHighWater: 0 }), /event high-water changed/);
    assert.throws(() => f.store.createReportOperation({ ...reportInput(f, { ...prepared, operation: applied, candidateSha }, "report-wrong-diff"),
      diffBytes: Buffer.from("changed") }), /diff hash/);
    assert.throws(() => f.store.createReportOperation({ ...reportInput(f, { ...prepared, operation: applied, candidateSha }, "report-wrong-commit"),
      reportBytes: Buffer.from(JSON.stringify({ taskId: f.task.id, resultCommit: "e".repeat(40) })) }), /exact task ID and applied result commit/);
    const wrongStatus = reportInput(f, { ...prepared, operation: applied, candidateSha }, "report-wrong-status");
    assert.throws(() => f.store.createReportOperation({ ...wrongStatus,
      reportBytes: Buffer.from(JSON.stringify({ ...JSON.parse(wrongStatus.reportBytes.toString("utf8")), finalStatus: "reviewing" })) }), /finalStatus done/);
    const wrongDiffPath = reportInput(f, { ...prepared, operation: applied, candidateSha }, "report-wrong-diff-path");
    assert.throws(() => f.store.createReportOperation({ ...wrongDiffPath,
      reportBytes: Buffer.from(JSON.stringify({ ...JSON.parse(wrongDiffPath.reportBytes.toString("utf8")), diffPath: "other/result.diff" })) }), /fixed task result.diff path/);
  } finally { f.store.close(); }
});

test("commit operation persists deterministic intent then candidate and verified applied evidence", () => {
  const f = reviewFixture();
  try {
    const prepared = completePassingReview(f);
    const operation = f.store.createCommitOperation(prepared.input);
    assert.equal(operation.status, "intent");
    assert.equal(operation.packageId, prepared.pkg.id);
    assert.equal(operation.verdictId, prepared.verdict.id);
    assert.equal(operation.preHead, prepared.pkg.snapshot.preHead);
    assert.equal(operation.treeId, prepared.pkg.snapshot.treeId);
    assert.equal(operation.authorName, "Zero");
    assert.equal(operation.authorEmail, "zero@localhost");
    assert.equal(operation.committerName, "Zero");
    assert.equal(operation.committerEmail, "zero@localhost");
    assert.equal(operation.encoding, "UTF-8");
    assert.equal(operation.candidateSha, undefined);

    const candidateSha = "d".repeat(40);
    const candidate = f.store.recordCommitOperationCandidate(operation.id, { owner: f.owner, generationId: f.generationId }, candidateSha);
    assert.equal(candidate.status, "candidate");
    assert.equal(candidate.candidateSha, candidateSha);
    assert.equal(f.store.recordCommitOperationCandidate(operation.id, { owner: f.owner, generationId: f.generationId }, candidateSha).candidateSha, candidateSha);
    assert.throws(() => f.store.recordCommitOperationCandidate(operation.id, { owner: f.owner, generationId: f.generationId }, "e".repeat(40)), /different candidate SHA/);

    const evidence = { branchRef: operation.branchRef, refHead: candidateSha, worktreeHead: candidateSha,
      treeId: operation.treeId, diffHash: operation.diffHash, candidateObjectVerified: true as const,
      indexMatchesReviewedTree: true as const, worktreeClean: true as const };
    assert.throws(() => f.store.markCommitOperationApplied(operation.id, { owner: f.owner, generationId: f.generationId },
      { ...evidence, branchRef: "refs/heads/zero/another-task" }), /does not match.*operation/);
    assert.equal(f.store.getCommitOperation(operation.id)?.status, "candidate");
    const applied = f.store.markCommitOperationApplied(operation.id, { owner: f.owner, generationId: f.generationId }, evidence);
    assert.equal(applied.status, "applied");
    assert.deepEqual(applied.appliedEvidence, evidence);
    assert.deepEqual(f.store.commitOperations(f.task.id), [applied]);
    assert.deepEqual(f.store.markCommitOperationApplied(operation.id, { owner: f.owner, generationId: f.generationId }, evidence), applied);
    assert.throws(() => f.store.markCommitOperationApplied(operation.id, { owner: f.owner, generationId: f.generationId },
      { ...evidence, refHead: "e".repeat(40) }), /verified Git evidence|cannot be changed/);
  } finally { f.store.close(); }
});

test("commit operation fails closed for duplicate, wrong binding, non-pass verdict, and invalid candidate", () => {
  const f = reviewFixture();
  try {
    const prepared = completePassingReview(f);
    assert.throws(() => f.store.createCommitOperation({ ...prepared.input, verdictId: "legacy-review-only" }), /successful atomic Codex package verdict/);
    assert.throws(() => f.store.createCommitOperation({ ...prepared.input, generationId: "different-generation" }), /live owner|successful atomic/);
    assert.throws(() => f.store.createCommitOperation({ ...prepared.input, preHead: "wrong" }), /valid Git pre-HEAD/);
    assert.throws(() => f.store.createCommitOperation({ ...prepared.input, treeId: "e".repeat(40) }), /do not match.*snapshot/);
    const operation = f.store.createCommitOperation(prepared.input);
    assert.throws(() => f.store.createCommitOperation({ ...prepared.input, operationId: "commit-test-duplicate" }), /UNIQUE constraint failed/);
    assert.throws(() => f.store.recordCommitOperationCandidate(operation.id, { owner: f.owner, generationId: f.generationId }, "nope"), /Invalid candidate/);
    assert.throws(() => f.store.recordCommitOperationCandidate(operation.id, { owner: "other-worker", generationId: f.generationId }, "d".repeat(40)), /guard/);
    assert.throws(() => f.store.markCommitOperationApplied(operation.id, { owner: f.owner, generationId: f.generationId }, {
      branchRef: operation.branchRef, refHead: "d".repeat(40), worktreeHead: "d".repeat(40), treeId: operation.treeId,
      diffHash: operation.diffHash, candidateObjectVerified: true, indexMatchesReviewedTree: true, worktreeClean: true,
    }), /no persisted candidate SHA/);
    assert.deepEqual(f.store.commitOperations(f.task.id).map(item => item.id), [operation.id]);
  } finally { f.store.close(); }
});

test("commit intent verifies package branch and check definitions against the completed run and task", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-commit-operation-evidence-"));
  const path = join(root, "tasks.sqlite");
  const f = reviewFixture(undefined, 60_000, path);
  try {
    const prepared = completePassingReview(f);
    const db = new DatabaseSync(path);
    try {
      db.prepare("UPDATE check_runs SET check_definition_hash=? WHERE id=?")
        .run("f".repeat(64), prepared.pkg.checkRunId);
      assert.throws(() => f.store.createCommitOperation(prepared.input), /definitions do not match/);
      db.prepare("UPDATE check_runs SET check_definition_hash=? WHERE id=?")
        .run(prepared.pkg.checkDefinitionHash, prepared.pkg.checkRunId);
      db.exec("DROP TRIGGER review_packages_no_update");
      db.prepare("UPDATE review_packages SET branch_ref=? WHERE id=?")
        .run("refs/heads/zero/tampered", prepared.pkg.id);
      assert.throws(() => f.store.createCommitOperation(prepared.input), /package's exact task branch ref/);
    } finally { db.close(); }
    assert.deepEqual(f.store.commitOperations(f.task.id), []);
  } finally {
    f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("commit operation cannot authorize failed review or a stale reviewing lease", async () => {
  const f = reviewFixture([{ id: "unit", argv: ["node", "test.js"] }], 150);
  try {
    const pkg = completeReviewPackage(f);
    const attempt = startBoundReviewAttempt(f, pkg.id);
    const verdict = f.store.finishPackageReview({ packageId: pkg.id, attemptId: attempt.id, owner: f.owner,
      generationId: f.generationId, recheckedSnapshot: pkg.snapshot,
      result: { verdict: "changes_requested", summary: "Needs a correction.", findings: [
        { severity: "medium", evidence: "missing case", requestedChange: "add the case" },
      ] }, attemptResult: { exitCode: 0 } });
    const input = { operationId: "commit-failed-verdict", packageId: pkg.id, verdictId: verdict.id, owner: f.owner,
      generationId: f.generationId, branchRef: pkg.branchRef, preHead: pkg.snapshot.preHead, treeId: pkg.snapshot.treeId,
      diffHash: pkg.snapshot.diffHash, message: "Should not commit", timestamp: "2026-09-26T12:00:00.000Z" };
    assert.throws(() => f.store.createCommitOperation(input), /passing review verdict/);
  } finally { f.store.close(); }

  const stale = reviewFixture(undefined, 500);
  try {
    const prepared = completePassingReview(stale);
    await new Promise(resolve => setTimeout(resolve, 520));
    assert.throws(() => stale.store.createCommitOperation(prepared.input), /live owner/);
    assert.deepEqual(stale.store.commitOperations(stale.task.id), []);
  } finally { stale.store.close(); }
});

test("package review atomically finishes a bound codex attempt and persists legacy and immutable verdict evidence", () => {
  const f = reviewFixture();
  try {
    const pkg = completeReviewPackage(f);
    const attempt = startBoundReviewAttempt(f, pkg.id);
    const result = { verdict: "pass" as const, summary: "All acceptance criteria are met.", findings: [], rawPath: "review.json" };
    const verdict = f.store.finishPackageReview({ packageId: pkg.id, attemptId: attempt.id, owner: f.owner,
      generationId: f.generationId, recheckedSnapshot: f.snapshot, result,
      attemptResult: { exitCode: 0, stdoutPath: "review.stdout.log", stderrPath: "review.stderr.log", model: "gpt-review",
        reasoningEffort: "high", metadata: { reviewerModel: "codex-model" } } });
    assert.equal(verdict.packageId, pkg.id);
    assert.equal(verdict.attemptId, attempt.id);
    assert.equal(verdict.generationId, f.generationId);
    assert.deepEqual(verdict.snapshot, pkg.snapshot);
    assert.deepEqual(verdict.result, result);
    assert.deepEqual(f.store.reviews(f.task.id), [result]);
    assert.deepEqual(f.store.packageReviewVerdicts(f.task.id), [verdict]);
    const finishedAttempt = f.store.attempts(f.task.id).find(item => item.id === attempt.id)!;
    assert.equal(finishedAttempt.status, "succeeded");
    assert.equal(finishedAttempt.exitCode, 0);
    assert.equal(finishedAttempt.stdoutPath, "review.stdout.log");
    assert.equal(finishedAttempt.resultPath, "review.json");
    assert.equal(finishedAttempt.model, "gpt-review");
    assert.equal(finishedAttempt.reasoningEffort, "high");
    assert.equal(finishedAttempt.metadata?.packageId, pkg.id);
    assert.equal(finishedAttempt.metadata?.generationId, f.generationId);
    assert.ok(f.store.events(f.task.id).some(event => event.type === "review.finished"));
  } finally { f.store.close(); }
});

test("invalid snapshot, malformed result, and stale lease leave package review attempt running without evidence", async () => {
  const f = reviewFixture([{ id: "unit", argv: ["node", "test.js"] }], 200);
  try {
    const pkg = completeReviewPackage(f);
    const attempt = startBoundReviewAttempt(f, pkg.id);
    const valid = { verdict: "pass" as const, summary: "Clean.", findings: [] };
    assert.throws(() => f.store.finishPackageReview({ packageId: pkg.id, attemptId: attempt.id, owner: f.owner,
      generationId: f.generationId, recheckedSnapshot: f.snapshot, result: valid, attemptResult: { exitCode: 1 } }), /exit code 0/);
    assert.throws(() => f.store.finishPackageReview({ packageId: pkg.id, attemptId: attempt.id, owner: f.owner,
      generationId: f.generationId, recheckedSnapshot: f.snapshot, result: valid, attemptResult: { error: "review process failed" } }), /cannot have an error/);
    assert.throws(() => f.store.finishPackageReview({ packageId: pkg.id, attemptId: attempt.id, owner: f.owner,
      generationId: f.generationId, recheckedSnapshot: { ...f.snapshot, treeId: "changed" }, result: valid }), /snapshot/);
    assert.throws(() => f.store.finishPackageReview({ packageId: pkg.id, attemptId: attempt.id, owner: f.owner,
      generationId: f.generationId, recheckedSnapshot: f.snapshot,
      result: { verdict: "pass", summary: "Looks good", findings: [{ severity: "high", evidence: "issue", requestedChange: "fix" }] } }), /Invalid structured/);
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.throws(() => f.store.finishPackageReview({ packageId: pkg.id, attemptId: attempt.id, owner: f.owner,
      generationId: f.generationId, recheckedSnapshot: f.snapshot, result: valid }), /live owner/);
    assert.equal(f.store.attempts(f.task.id).find(item => item.id === attempt.id)?.status, "running");
    assert.deepEqual(f.store.reviews(f.task.id), []);
    assert.deepEqual(f.store.packageReviewVerdicts(f.task.id), []);
  } finally { f.store.close(); }
});

test("a verdict cannot be recorded for a package superseded by a newer package", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-review-latest-package-"));
  const path = join(root, "tasks.sqlite");
  const f = reviewFixture(undefined, 60_000, path);
  try {
    const pkg = completeReviewPackage(f);
    const attempt = startBoundReviewAttempt(f, pkg.id);
    const db = new DatabaseSync(path);
    try {
      const run = f.store.checkRuns(f.task.id)[0]!;
      const newerRunId = "newer-check-run";
      db.prepare(`INSERT INTO check_runs(id,task_id,generation_id,owner,execution_attempt_id,execution_stage_id,route_attempt_id,
        route,branch_ref,snapshot,check_definition_hash,expected_check_ids,status,created_at,completed_at)
        SELECT ?,task_id,generation_id,owner,execution_attempt_id,execution_stage_id,route_attempt_id,route,branch_ref,snapshot,
        check_definition_hash,expected_check_ids,'completed',?,? FROM check_runs WHERE id=?`)
        .run(newerRunId, "2999-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z", run.id);
      db.prepare(`INSERT INTO review_packages(id,task_id,check_run_id,execution_attempt_id,execution_stage_id,route_attempt_id,
        route,branch_ref,snapshot,check_definition_hash,expected_check_ids,created_at)
        SELECT 'newer-review-package',task_id,?,execution_attempt_id,execution_stage_id,route_attempt_id,route,branch_ref,snapshot,
        check_definition_hash,expected_check_ids,'2999-01-01T00:00:00.000Z' FROM review_packages WHERE id=?`)
        .run(newerRunId, pkg.id);
    } finally { db.close(); }
    assert.throws(() => f.store.finishPackageReview({ packageId: pkg.id, attemptId: attempt.id, owner: f.owner,
      generationId: f.generationId, recheckedSnapshot: f.snapshot,
      result: { verdict: "pass", summary: "Pass", findings: [] } }), /not current/);
    assert.equal(f.store.attempts(f.task.id).find(item => item.id === attempt.id)?.status, "running");
    assert.deepEqual(f.store.reviews(f.task.id), []);
    assert.deepEqual(f.store.packageReviewVerdicts(f.task.id), []);
  } finally {
    f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("check run rejects inconsistent diff and submitted check-definition hashes", () => {
  const f = reviewFixture();
  try {
    assert.throws(() => f.store.startCheckRun({ ...f.input, snapshot: { ...f.snapshot, diffHash: "0".repeat(64) } }), /diff hash/);
    assert.throws(() => f.store.startCheckRun({ ...f.input, snapshot: { ...f.snapshot, diff: null as unknown as string } }), /diff must be a string/);
    assert.throws(() => f.store.startCheckRun({ ...f.input, checkDefinitionHash: "0".repeat(64) }), /submitted task checks/);
    assert.equal(f.store.get(f.task.id)?.status, "running");
  } finally { f.store.close(); }
});

test("check run rejects an empty required-check set", () => {
  const f = reviewFixture([]);
  try {
    assert.throws(() => f.store.startCheckRun(f.input), /nonempty list/);
    assert.equal(f.store.get(f.task.id)?.status, "running");
    assert.deepEqual(f.store.checkRuns(f.task.id), []);
  } finally { f.store.close(); }
});

test("check run accepts a 64 KiB Unicode check ID list", () => {
  const checks = Array.from({ length: 40 }, (_, index) => ({ id: `${"检查🔍".repeat(160)}-${index}`, argv: ["node", "test.js"] }));
  const f = reviewFixture(checks);
  try {
    const run = f.store.startCheckRun(f.input);
    assert.ok(Buffer.byteLength(JSON.stringify(f.input.expectedCheckIds), "utf8") > 16_384);
    assert.equal(run.expectedCheckIds.length, 40);
    for (const check of checks) f.store.recordCheckResult(run.id, { owner: f.owner, generationId: f.generationId }, f.result(check.id));
    f.store.finishStage(f.stage.id, f.owner, "process-1", "succeeded", "fingerprint");
    assert.equal(f.store.completeCheckRun(run.id, { owner: f.owner, generationId: f.generationId }, f.snapshot).checkRun.status, "completed");
  } finally { f.store.close(); }
});

test("check run rejects wrong generation, duplicate, incomplete, and failed results", () => {
  const wrongGeneration = reviewFixture();
  try {
    const run = wrongGeneration.store.startCheckRun(wrongGeneration.input);
    assert.throws(() => wrongGeneration.store.recordCheckResult(run.id, { owner: wrongGeneration.owner, generationId: "stale-generation" }, wrongGeneration.result("unit")), /guard/);
    assert.throws(() => wrongGeneration.store.completeCheckRun(run.id, { owner: wrongGeneration.owner, generationId: "stale-generation" }, wrongGeneration.snapshot), /guard/);
    wrongGeneration.store.recordCheckResult(run.id, { owner: wrongGeneration.owner, generationId: wrongGeneration.generationId }, wrongGeneration.result("unit"));
    assert.throws(() => wrongGeneration.store.recordCheckResult(run.id, { owner: wrongGeneration.owner, generationId: wrongGeneration.generationId }, wrongGeneration.result("unit")), /already has a result/);
    wrongGeneration.store.finishStage(wrongGeneration.stage.id, wrongGeneration.owner, "process-1", "succeeded");
    assert.doesNotThrow(() => wrongGeneration.store.completeCheckRun(run.id, { owner: wrongGeneration.owner, generationId: wrongGeneration.generationId }, wrongGeneration.snapshot));
  } finally { wrongGeneration.store.close(); }

  const incomplete = reviewFixture([{ id: "unit", argv: ["node", "test.js"] }, { id: "lint", argv: ["node", "lint.js"] }]);
  try {
    const run = incomplete.store.startCheckRun(incomplete.input);
    incomplete.store.recordCheckResult(run.id, { owner: incomplete.owner, generationId: incomplete.generationId }, incomplete.result("unit"));
    incomplete.store.finishStage(incomplete.stage.id, incomplete.owner, "process-1", "succeeded");
    assert.throws(() => incomplete.store.completeCheckRun(run.id, { owner: incomplete.owner, generationId: incomplete.generationId }, incomplete.snapshot), /exactly one result/);
    assert.equal(incomplete.store.get(incomplete.task.id)?.status, "running");
    assert.equal(incomplete.store.reviewPackages(incomplete.task.id).length, 0);
  } finally { incomplete.store.close(); }

  const failed = reviewFixture();
  try {
    const run = failed.store.startCheckRun(failed.input);
    failed.store.recordCheckResult(run.id, { owner: failed.owner, generationId: failed.generationId }, failed.result("unit", "failed"));
    failed.store.finishStage(failed.stage.id, failed.owner, "process-1", "succeeded");
    assert.throws(() => failed.store.completeCheckRun(run.id, { owner: failed.owner, generationId: failed.generationId }, failed.snapshot), /must pass/);
    assert.equal(failed.store.get(failed.task.id)?.status, "running");
  } finally { failed.store.close(); }
});

test("check run rejects lease expiry and changed post-check snapshot", async () => {
  const expired = reviewFixture([{ id: "unit", argv: ["node", "test.js"] }], 20);
  try {
    const run = expired.store.startCheckRun(expired.input);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.throws(() => expired.store.recordCheckResult(run.id, { owner: expired.owner, generationId: expired.generationId }, expired.result("unit")), /live owner/);
    assert.throws(() => expired.store.finishCheckRun(run.id, { owner: expired.owner, generationId: expired.generationId }, "abandoned", "lease expired"), /live owner/);
  } finally { expired.store.close(); }

  const changed = reviewFixture();
  try {
    const run = changed.store.startCheckRun(changed.input);
    changed.store.recordCheckResult(run.id, { owner: changed.owner, generationId: changed.generationId }, changed.result("unit"));
    changed.store.finishStage(changed.stage.id, changed.owner, "process-1", "succeeded");
    assert.throws(() => changed.store.completeCheckRun(run.id, { owner: changed.owner, generationId: changed.generationId }, { ...changed.snapshot, treeId: "new-tree" }), /snapshot/);
    assert.equal(changed.store.getCheckRun(run.id)?.status, "running");
    assert.equal(changed.store.get(changed.task.id)?.status, "running");
    assert.equal(changed.store.reviewPackages(changed.task.id).length, 0);
  } finally { changed.store.close(); }
});

test("unsuccessful check runs can be marked terminal without deleting history", () => {
  const f = reviewFixture();
  try {
    const run = f.store.startCheckRun(f.input);
    f.store.recordCheckResult(run.id, { owner: f.owner, generationId: f.generationId }, f.result("unit", "failed"));
    const closed = f.store.finishCheckRun(run.id, { owner: f.owner, generationId: f.generationId }, "failed", "required check failed");
    assert.equal(closed.status, "failed");
    assert.equal(f.store.checkRuns(f.task.id)[0]?.status, "failed");
    assert.deepEqual(f.store.checkRunResults(run.id).map(result => result.status), ["failed"]);
    assert.throws(() => f.store.recordCheckResult(run.id, { owner: f.owner, generationId: f.generationId }, f.result("unit")), /not running/);
  } finally { f.store.close(); }
});

test("legacy databases gain additive review evidence tables without rewriting check history", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-review-migration-"));
  const path = join(root, "tasks.sqlite");
  let store = new TaskStore(path);
  try {
    const task = store.submit({ repoPath: ".", baseRef: "main", prompt: "legacy task" }, "legacy_review_schema");
    store.saveCheck(task.id, { id: "legacy", argv: ["true"], status: "passed", exitCode: 0, durationMs: 1 });
    store.close();
    const legacyDb = new DatabaseSync(path);
    legacyDb.exec("DROP TABLE review_packages; DROP TABLE check_run_results; DROP TABLE check_runs;");
    legacyDb.close();
    store = new TaskStore(path);
    assert.equal(store.checks(task.id)[0]?.id, "legacy");
    const migratedDb = new DatabaseSync(path);
    const tables = migratedDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    migratedDb.close();
    assert.ok(tables.some(table => table.name === "check_runs"));
    assert.ok(tables.some(table => table.name === "check_run_results"));
    assert.ok(tables.some(table => table.name === "review_packages"));
    assert.ok(tables.some(table => table.name === "review_verdicts"));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
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
    assert.throws(() => store.transition(task.id, "reviewing", "done"), /Illegal task state transition/);
    assert.equal(store.get(task.id)?.status, "reviewing");
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
    const checks = [{ id: "unit", argv: ["node", "test.js"] }, { id: "lint", argv: ["node", "lint.js"] }];
    const task = store.submit({ repoPath: "C:/repo", baseRef: "main", prompt: "resume ordinary work", checks }, "execution_recovery_positive");
    store.claimNext("old-owner");
    store.saveRoute({ taskId: task.id, harness: "codex", model: "old-model", selectionSource: "codex",
      reason: "pre-crash route", decidedAt: new Date().toISOString() });
    const plan = { taskId: task.id, repoPath: "C:/repo", commonGitDir: "C:/repo/.git", worktreeRoot: "C:/worktrees", path: `C:/worktrees/${task.id}`,
      branch: `zero/${task.id}`, baseCommit: "a".repeat(40) };
    store.recordWorktreeCreationIntent(task.id, "old-owner", plan);
    const observed = { info: { taskId: task.id, repoPath: plan.repoPath, path: plan.path, branch: plan.branch, baseCommit: plan.baseCommit },
      commonGitDir: plan.commonGitDir, head: plan.baseCommit, fingerprint: "b".repeat(64) };
    store.completeWorktreeCreation(task.id, "old-owner", observed, "b".repeat(64));
    const route: import("../domain/types.js").RouteDecision = { taskId: task.id, harness: "zcode", model: "model-x",
      selectionSource: "codex", reason: "recovery test", decidedAt: new Date().toISOString() };
    const routeAttempt = store.createAttempt(task.id, "route", { owner: "old-owner", harness: "codex" });
    store.finishAttempt(routeAttempt.id, { status: "succeeded", metadata: { decision: route } });
    store.saveRoute(route);
    const stage = store.createStage(task.id, { role: "implement", processStartId: "recovery-process", harness: "zcode", model: "model-x" });
    store.startStage(stage.id, "old-owner", "recovery-process");
    const executionAttempt = store.createAttempt(task.id, "implement", { owner: "old-owner", stageId: stage.id, harness: "zcode", model: "model-x" });
    store.finishAttempt(executionAttempt.id, { status: "succeeded" }, { owner: "old-owner", processStartId: "recovery-process" });
    const diff = "diff --git a/a b/a\n+change\n";
    const snapshot = { baseCommit: plan.baseCommit, preHead: plan.baseCommit, treeId: "tree", fingerprint: "fingerprint",
      diffHash: createHash("sha256").update(diff, "utf8").digest("hex"), diff };
    const checkRun = store.startCheckRun({ taskId: task.id, owner: "old-owner", generationId: oldGeneration,
      executionAttemptId: executionAttempt.id, executionStageId: stage.id, routeAttemptId: routeAttempt.id, route,
      branchRef: `refs/heads/zero/${task.id}`, snapshot,
      checkDefinitionHash: createHash("sha256").update(JSON.stringify(checks), "utf8").digest("hex"), expectedCheckIds: checks.map(check => check.id) });
    store.recordCheckResult(checkRun.id, { owner: "old-owner", generationId: oldGeneration },
      { id: "unit", argv: ["node", "test.js"], status: "passed", exitCode: 0, durationMs: 1 });
    const interruptedAttempt = store.createAttempt(task.id, "implement", { owner: "old-owner" });
    assert.deepEqual(store.recoverExpired(new Date(Date.now() + 120_000)), [task.id]);
    assert.equal(store.getCheckRun(checkRun.id)?.status, "running");
    assert.deepEqual(store.getCheckRun(checkRun.id)?.snapshot, snapshot);
    assert.equal(store.checkRunResults(checkRun.id).length, 1);
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
    assert.equal(store.getCheckRun(checkRun.id)?.status, "abandoned");
    assert.equal(store.getRoute(task.id), undefined);
    const freshBackdatedRoute = { taskId: task.id, harness: "zcode", model: "fresh-model", selectionSource: "codex" as const,
      reason: "rerouted after recovery", decidedAt: "2000-01-01T00:00:00.000Z" };
    store.saveRoute(freshBackdatedRoute);
    assert.deepEqual(store.getRoute(task.id), freshBackdatedRoute);
    const checkpoint = store.executionRecoveryCheckpoint(task.id)!;
    assert.equal(checkpoint.kind, "execution_recovery");
    assert.equal(checkpoint.sourceGenerationId, oldGeneration);
    assert.equal(store.getCheckRun(checkRun.id)?.terminalReason, `abandoned during execution recovery checkpoint ${checkpoint.id}`);
    assert.equal((checkpoint.freshIdentity as { fingerprint: string }).fingerprint, "c".repeat(64));
    assert.equal(((checkpoint.source as { worktreeCreation: { fingerprint: string } }).worktreeCreation).fingerprint, "b".repeat(64));
    assert.equal(((checkpoint.source as { historyBoundary: { attemptSequence: number } }).historyBoundary).attemptSequence, 3);
    assert.equal(store.attempts(task.id).find(attempt => attempt.id === interruptedAttempt.id)?.status, "interrupted");
    const closedRunEvents = store.events(task.id).filter(event => event.type === "check_run.closed" &&
      (event.payload as { checkRunId?: string } | undefined)?.checkRunId === checkRun.id);
    assert.equal(closedRunEvents.length, 1);
    assert.equal((closedRunEvents[0]?.payload as { recoveryCheckpointId?: string }).recoveryCheckpointId,
      (store.events(task.id).find(event => event.type === "task.execution_recovery_claimed")?.payload as { checkpointId?: string }).checkpointId);
    assert.equal(store.claimExecutionRecovery(task.id, "racer", {
      identity: { checkedAt: new Date().toISOString(), observed: freshObserved, fingerprint: "c".repeat(64) },
    }), undefined);
    assert.equal(store.getCheckRun(checkRun.id)?.status, "abandoned");
    assert.equal(store.events(task.id).filter(event => event.type === "check_run.closed" &&
      (event.payload as { checkRunId?: string } | undefined)?.checkRunId === checkRun.id).length, 1);
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

test("review recovery claims a continuous guardian chain and permits a pass created in the prior recovered generation", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-review-recovery-chain-"));
  const path = join(root, "tasks.sqlite");
  const lockId = "a".repeat(64);
  const g0 = "10101010101010101010101010101010";
  const g1 = "20202020202020202020202020202020";
  const g2 = "30303030303030303030303030303030";
  let f = reviewFixture([{ id: "unit", argv: ["node", "test.js"] }], 60_000, path,
    { id: g0, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    const { observed } = registerReviewRecoveryWorktree(f);
    const pkg = completeReviewPackage(f);
    f.store.recoverExpired(new Date(Date.now() + 120_000));
    f.store.close();
    f.store = new TaskStore(path, { id: g1, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    const firstAt = new Date();
    const first = f.store.claimReviewRecovery(f.task.id, "recovery-g1", reviewRecoveryInput(f, observed, "pre_commit", firstAt));
    assert.equal(first?.priorClaimGenerationId, g0);
    assert.equal(first?.claimGenerationId, g1);
    assert.equal(first?.priorCheckpointId, undefined);
    assert.equal(f.store.claimReviewRecovery(f.task.id, "duplicate", reviewRecoveryInput(f, observed, "pre_commit", firstAt)), undefined);

    const attempt = f.store.createAttempt(f.task.id, "review", { owner: "recovery-g1", harness: "codex",
      metadata: { packageId: pkg.id, generationId: g1 } });
    f.store.finishPackageReview({ packageId: pkg.id, attemptId: attempt.id, owner: "recovery-g1", generationId: g1,
      recheckedSnapshot: pkg.snapshot, result: { verdict: "pass", summary: "No findings after recovery.", findings: [] },
      attemptResult: { exitCode: 0 } });
    f.store.close();

    f.store = new TaskStore(path, { id: g2, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    f.store.recoverExpired(new Date(Date.now() + 120_000));
    const secondAt = new Date();
    const second = f.store.claimReviewRecovery(f.task.id, "recovery-g2", reviewRecoveryInput(f, observed, "pre_commit", secondAt));
    assert.equal(second?.priorClaimGenerationId, g1);
    assert.equal(second?.claimGenerationId, g2);
    assert.equal(second?.priorCheckpointId, first?.id);
    assert.equal(second?.sourceGenerationId, g0);
    assert.deepEqual(f.store.reviewRecoveryClaims(f.task.id).map(claim => [claim.priorClaimGenerationId, claim.claimGenerationId]), [[g0, g1], [g1, g2]]);
    assert.equal(f.store.get(f.task.id)?.status, "reviewing");
    assert.equal(f.store.get(f.task.id)?.claimGenerationId, g2);
  } finally {
    f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("review recovery transfers a prepared commit but keeps completed report ownership as audit history", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-review-recovery-report-"));
  const path = join(root, "tasks.sqlite");
  const lockId = "b".repeat(64);
  const g0 = "41414141414141414141414141414141";
  const g1 = "51515151515151515151515151515151";
  const g2 = "61616161616161616161616161616161";
  let f = reviewFixture([{ id: "unit", argv: ["node", "test.js"] }], 60_000, path,
    { id: g0, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    const { observed } = registerReviewRecoveryWorktree(f);
    const applied = completeAppliedCommit(f);
    const completedReport = completeReportOperation(f, applied);
    const originalReportOwner = completedReport.claimOwner;
    const originalReportGeneration = completedReport.claimGenerationId;
    f.store.recoverExpired(new Date(Date.now() + 120_000));
    f.store.close();

    f.store = new TaskStore(path, { id: g1, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    let at = new Date();
    const first = f.store.claimReviewRecovery(f.task.id, "recovery-g1", reviewRecoveryInput(f, observed, "applied_candidate", at, applied));
    assert.equal(first?.commitOperation?.claimOwner, f.owner);
    assert.equal(first?.reportOperation?.status, "complete");
    assert.equal(f.store.getCommitOperation(applied.operation.id)?.claimOwner, "recovery-g1");
    assert.equal(f.store.getReportOperation(completedReport.id)?.claimOwner, originalReportOwner);
    assert.equal(f.store.getReportOperation(completedReport.id)?.claimGenerationId, originalReportGeneration);
    f.store.close();

    f.store = new TaskStore(path, { id: g2, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    f.store.recoverExpired(new Date(Date.now() + 120_000));
    at = new Date();
    const second = f.store.claimReviewRecovery(f.task.id, "recovery-g2", reviewRecoveryInput(f, observed, "applied_candidate", at, applied));
    assert.equal(second?.priorCheckpointId, first?.id);
    assert.equal(f.store.getCommitOperation(applied.operation.id)?.claimOwner, "recovery-g2");
    assert.equal(f.store.getCommitOperation(applied.operation.id)?.claimGenerationId, g2);
    assert.equal(f.store.getReportOperation(completedReport.id)?.claimOwner, originalReportOwner);
    assert.equal(f.store.reviewRecoveryClaims(f.task.id).length, 2);
  } finally {
    f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("review recovery quarantines failed verdicts and broken first-claim source lineage", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-review-recovery-deny-"));
  const path = join(root, "tasks.sqlite");
  const lockId = "c".repeat(64);
  const g0 = "71717171717171717171717171717171";
  const g1 = "81818181818181818181818181818181";
  let f = reviewFixture([{ id: "unit", argv: ["node", "test.js"] }, { id: "lint", argv: ["node", "lint.js"] }], 60_000, path,
    { id: g0, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    const { observed } = registerReviewRecoveryWorktree(f);
    const pkg = completeReviewPackage(f);
    const attempt = startBoundReviewAttempt(f, pkg.id);
    f.store.finishPackageReview({ packageId: pkg.id, attemptId: attempt.id, owner: f.owner, generationId: g0,
      recheckedSnapshot: pkg.snapshot, result: { verdict: "changes_requested", summary: "Needs revision.",
        findings: [{ severity: "low", evidence: "A test is missing.", requestedChange: "Add the test." }] }, attemptResult: { exitCode: 0 } });
    f.store.recoverExpired(new Date(Date.now() + 120_000));
    f.store.close();
    f.store = new TaskStore(path, { id: g1, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    const at = new Date();
    const claim = f.store.claimReviewRecovery(f.task.id, "recovery-g1", reviewRecoveryInput(f, observed, "pre_commit", at));
    assert.equal(claim, undefined);
    assert.equal(f.store.get(f.task.id)?.status, "recovery_required");
    assert.match(f.store.get(f.task.id)?.recoveryReason ?? "", /Latest review verdict is not passing/);
    assert.equal(f.store.reviewRecoveryClaims(f.task.id).length, 0);
    assert.equal(f.store.events(f.task.id).some(event => event.type === "task.review_recovery_quarantined"), true);
  } finally {
    f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("review recovery rejects fresh Git state that differs from the sealed snapshot", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-review-recovery-git-mismatch-"));
  const path = join(root, "tasks.sqlite");
  const lockId = "d".repeat(64);
  const g0 = "91919191919191919191919191919191";
  const g1 = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
  let f = reviewFixture([{ id: "unit", argv: ["node", "test.js"] }], 60_000, path,
    { id: g0, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    const { observed } = registerReviewRecoveryWorktree(f);
    completeReviewPackage(f);
    f.store.recoverExpired(new Date(Date.now() + 120_000));
    f.store.close();
    f.store = new TaskStore(path, { id: g1, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    const at = new Date();
    const input = reviewRecoveryInput(f, observed, "pre_commit", at);
    assert.throws(() => f.store.claimReviewRecovery(f.task.id, "recovery-g1", { ...input,
      gitState: { ...input.gitState, diffHash: "0".repeat(64) } }), /does not match the complete immutable review package snapshot/);
    assert.equal(f.store.get(f.task.id)?.status, "recovery_required");
    assert.equal(f.store.reviewRecoveryClaims(f.task.id).length, 0);
  } finally {
    f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("review recovery transfers a prepared report operation with the prior live claim", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-review-recovery-prepared-report-"));
  const path = join(root, "tasks.sqlite");
  const lockId = "e".repeat(64);
  const g0 = "a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2";
  const g1 = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
  let f = reviewFixture([{ id: "unit", argv: ["node", "test.js"] }], 60_000, path,
    { id: g0, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    const { observed } = registerReviewRecoveryWorktree(f);
    const applied = completeAppliedCommit(f);
    const reportInputValue = reportInput(f, applied);
    const prepared = f.store.createReportOperation(reportInputValue);
    assert.equal(prepared.status, "prepared");
    f.store.recoverExpired(new Date(Date.now() + 120_000));
    f.store.close();

    f.store = new TaskStore(path, { id: g1, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    const at = new Date();
    const claim = f.store.claimReviewRecovery(f.task.id, "recovery-g1", reviewRecoveryInput(f, observed, "applied_candidate", at, applied));
    assert.equal(claim?.reportOperation?.status, "prepared");
    assert.equal(claim?.reportOperation?.claimOwner, f.owner);
    assert.equal(claim?.reportOperation?.claimGenerationId, g0);
    assert.equal(f.store.getReportOperation(prepared.id)?.claimOwner, "recovery-g1");
    assert.equal(f.store.getReportOperation(prepared.id)?.claimGenerationId, g1);
  } finally {
    f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("review recovery quarantines a first claim when the sealed package source generation is missing", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-review-recovery-lineage-gap-"));
  const path = join(root, "tasks.sqlite");
  const lockId = "f".repeat(64);
  const g0 = "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2";
  const g1 = "d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2";
  let f = reviewFixture([{ id: "unit", argv: ["node", "test.js"] }], 60_000, path,
    { id: g0, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    const { observed } = registerReviewRecoveryWorktree(f);
    const pkg = completeReviewPackage(f);
    f.store.recoverExpired(new Date(Date.now() + 120_000));
    f.store.close();
    f.store = new TaskStore(path, { id: g1, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    const editor = new DatabaseSync(path);
    try { editor.prepare("UPDATE check_runs SET generation_id=? WHERE id=?").run(g1, pkg.checkRunId); }
    finally { editor.close(); }
    const at = new Date();
    assert.equal(f.store.claimReviewRecovery(f.task.id, "recovery-g1", reviewRecoveryInput(f, observed, "pre_commit", at)), undefined);
    assert.match(f.store.get(f.task.id)?.recoveryReason ?? "", /First review recovery claim does not match/);
    assert.equal(f.store.reviewRecoveryClaims(f.task.id).length, 0);
  } finally {
    f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("review recovery rejects a tampered historical guardian/checkpoint link", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-review-recovery-chain-tamper-"));
  const path = join(root, "tasks.sqlite");
  const lockId = "1".repeat(64);
  const g0 = "e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2";
  const g1 = "f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2";
  const g2 = "03030303030303030303030303030303";
  let f = reviewFixture([{ id: "unit", argv: ["node", "test.js"] }], 60_000, path,
    { id: g0, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    const { observed } = registerReviewRecoveryWorktree(f);
    completeReviewPackage(f);
    f.store.recoverExpired(new Date(Date.now() + 120_000));
    f.store.close();
    f.store = new TaskStore(path, { id: g1, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    const firstAt = new Date();
    const first = f.store.claimReviewRecovery(f.task.id, "recovery-g1", reviewRecoveryInput(f, observed, "pre_commit", firstAt));
    assert.ok(first);
    f.store.recoverExpired(new Date(Date.now() + 120_000));
    f.store.close();

    f.store = new TaskStore(path, { id: g2, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    const editor = new DatabaseSync(path);
    try {
      editor.exec("DROP TRIGGER review_recovery_claims_no_update");
      editor.prepare("UPDATE review_recovery_claims SET prior_checkpoint_id=id WHERE id=?").run(first!.id);
    } finally { editor.close(); }
    const at = new Date();
    assert.equal(f.store.claimReviewRecovery(f.task.id, "recovery-g2", reviewRecoveryInput(f, observed, "pre_commit", at)), undefined);
    assert.match(f.store.get(f.task.id)?.recoveryReason ?? "", /claim chain is incomplete|broken checkpoint link/);
    assert.equal(f.store.reviewRecoveryClaims(f.task.id).length, 1);
  } finally {
    f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("review recovery quarantines a completed report whose original claim is outside the task chain", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-review-recovery-foreign-report-"));
  const path = join(root, "tasks.sqlite");
  const lockId = "2".repeat(64);
  const g0 = "14141414141414141414141414141414";
  const g1 = "15151515151515151515151515151515";
  const foreignGeneration = "16161616161616161616161616161616";
  let f = reviewFixture([{ id: "unit", argv: ["node", "test.js"] }], 60_000, path,
    { id: g0, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    const { observed } = registerReviewRecoveryWorktree(f);
    const applied = completeAppliedCommit(f);
    const completed = completeReportOperation(f, applied);
    f.store.recoverExpired(new Date(Date.now() + 120_000));
    f.store.close();
    f.store = new TaskStore(path, { id: g1, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    const foreign = new TaskStore(path, { id: foreignGeneration, predecessorDrained: false, evidenceKind: "unguarded" });
    foreign.close();
    const editor = new DatabaseSync(path);
    try {
      editor.exec("DROP TRIGGER report_operations_guard_update");
      editor.prepare("UPDATE report_operations SET claim_generation_id=? WHERE id=?").run(foreignGeneration, completed.id);
    } finally { editor.close(); }
    const at = new Date();
    assert.equal(f.store.claimReviewRecovery(f.task.id, "recovery-g1", reviewRecoveryInput(f, observed, "applied_candidate", at, applied)), undefined);
    assert.match(f.store.get(f.task.id)?.recoveryReason ?? "", /exact commit, verdict, and prior claim/);
    assert.equal(f.store.reviewRecoveryClaims(f.task.id).length, 0);
  } finally {
    f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("review recovery quarantines a commit operation bound to a superseded package", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-review-recovery-stale-commit-"));
  const path = join(root, "tasks.sqlite");
  const lockId = "3".repeat(64);
  const g0 = "17171717171717171717171717171717";
  const g1 = "18181818181818181818181818181818";
  let f = reviewFixture([{ id: "unit", argv: ["node", "test.js"] }], 60_000, path,
    { id: g0, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
  try {
    const { observed } = registerReviewRecoveryWorktree(f);
    const pkg = completeReviewPackage(f);
    const reviewAttempt = startBoundReviewAttempt(f, pkg.id);
    const verdict = f.store.finishPackageReview({ packageId: pkg.id, attemptId: reviewAttempt.id, owner: f.owner, generationId: g0,
      recheckedSnapshot: pkg.snapshot, result: { verdict: "pass", summary: "Reviewed latest package.", findings: [] },
      attemptResult: { exitCode: 0 } });
    const editor = new DatabaseSync(path);
    try {
      const oldCheckRunId = `old-check-${f.task.id}`;
      const oldPackageId = `old-package-${f.task.id}`;
      editor.prepare(`INSERT INTO check_runs(id,task_id,generation_id,owner,execution_attempt_id,execution_stage_id,route_attempt_id,
        route,branch_ref,snapshot,check_definition_hash,expected_check_ids,status,created_at)
        SELECT ?,task_id,generation_id,owner,execution_attempt_id,execution_stage_id,route_attempt_id,route,branch_ref,snapshot,
          check_definition_hash,expected_check_ids,status,created_at FROM check_runs WHERE id=?`).run(oldCheckRunId, pkg.checkRunId);
      editor.prepare(`INSERT INTO review_packages(rowid,id,task_id,check_run_id,execution_attempt_id,execution_stage_id,route_attempt_id,
        route,branch_ref,snapshot,check_definition_hash,expected_check_ids,created_at)
        SELECT 0,?,task_id,?,execution_attempt_id,execution_stage_id,route_attempt_id,route,branch_ref,snapshot,
          check_definition_hash,expected_check_ids,'2000-01-01T00:00:00.000Z' FROM review_packages WHERE id=?`)
        .run(oldPackageId, oldCheckRunId, pkg.id);
      editor.prepare(`INSERT INTO commit_operations(id,task_id,package_id,verdict_id,generation_id,owner,claim_owner,claim_generation_id,
        branch_ref,pre_head,tree_id,diff_hash,message,timestamp,author_name,author_email,committer_name,committer_email,encoding,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`old-commit-${f.task.id}`, f.task.id, oldPackageId, verdict.id, g0,
          f.owner, f.owner, g0, `refs/heads/zero/${f.task.id}`, pkg.snapshot.preHead, pkg.snapshot.treeId, pkg.snapshot.diffHash,
          "old commit", "2026-01-01T00:00:00.000Z", "Zero", "zero@localhost", "Zero", "zero@localhost", "UTF-8", "intent", "2000-01-01T00:00:00.000Z");
    } finally { editor.close(); }
    f.store.recoverExpired(new Date(Date.now() + 120_000));
    f.store.close();
    f.store = new TaskStore(path, { id: g1, lockId, predecessorDrained: true, evidenceKind: "guardian_startup_verified" });
    const at = new Date();
    assert.equal(f.store.claimReviewRecovery(f.task.id, "recovery-g1", reviewRecoveryInput(f, observed, "pre_commit", at)), undefined);
    assert.match(f.store.get(f.task.id)?.recoveryReason ?? "", /commit operation outside the latest package boundary/);
    assert.equal(f.store.get(f.task.id)?.status, "recovery_required");
    assert.equal(f.store.reviewRecoveryClaims(f.task.id).length, 0);
  } finally {
    f.store.close();
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
        parentPort.postMessage({ owner: workerData.owner, generationId: workerData.generationId, claimed: Boolean(claimed) });
      } catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
      finally { store?.close(); }
    })();
  `;
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const moduleUrl = new URL("./task-store.js", import.meta.url).href;
  const start = (generationId: string, owner: string) => new Promise<{ owner: string; generationId: string; claimed: boolean }>((resolve, reject) => {
    const worker = new Worker(workerSource, { eval: true, workerData: { moduleUrl, path, taskId: task.id, lockId,
      generationId, owner, observed, fingerprint: "c".repeat(64), barrier } });
    let result: { owner: string; generationId: string; claimed: boolean } | undefined;
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
    const winner = outcomes.find(outcome => outcome.claimed)!;
    const check = new TaskStore(path);
    try {
      const recovered = check.get(task.id);
      assert.equal(recovered?.status, "running");
      assert.equal(recovered?.leaseOwner, winner.owner);
      const checkpoint = check.executionRecoveryCheckpoint(task.id);
      assert.equal(checkpoint?.kind, "execution_recovery");
      assert.equal(checkpoint?.owner, winner.owner);
      assert.equal(checkpoint?.claimedGenerationId, winner.generationId);
    } finally { check.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

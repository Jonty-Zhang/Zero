import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitWorktreeManager } from "../core/git-worktree.js";
import type { CommitOperationRecord, ReviewPackageRecord, WorktreeCreationRecord } from "../core/task-store.js";
import { inspectReviewRecovery } from "./review-recovery-inspector.js";

const exec = promisify(execFile);

async function fixture(taskId: string) {
  const root = await mkdtemp(join(process.cwd(), `.zero-review-recovery-${taskId}-`));
  const repoPath = join(root, "repo");
  await mkdir(repoPath);
  await exec("git", ["init", "-b", "main"], { cwd: repoPath });
  await exec("git", ["config", "user.name", "Test"], { cwd: repoPath });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  await writeFile(join(repoPath, "seed.txt"), "base\n");
  await exec("git", ["add", "seed.txt"], { cwd: repoPath });
  await exec("git", ["commit", "-m", "seed"], { cwd: repoPath });

  const worktreeRoot = join(root, "worktrees");
  const manager = new GitWorktreeManager(worktreeRoot);
  const plan = await manager.prepareCreatePlan(taskId, repoPath, "main");
  const original = await manager.executePlan(plan);
  await writeFile(join(plan.path, "seed.txt"), "reviewed\n");
  const live = await manager.prepareReview(original.info);
  const snapshot = {
    baseCommit: plan.baseCommit,
    preHead: plan.baseCommit,
    ...live,
  };
  const reviewPackage: ReviewPackageRecord = {
    id: `package-${taskId}`, taskId, checkRunId: `run-${taskId}`,
    executionAttemptId: `execute-${taskId}`, executionStageId: `stage-${taskId}`,
    routeAttemptId: `route-${taskId}`, route: { harness: "codex", model: "gpt" } as never,
    branchRef: `refs/heads/zero/${taskId}`, snapshot,
    checkDefinitionHash: "0".repeat(64), expectedCheckIds: [], createdAt: new Date().toISOString(),
  };
  const creation: WorktreeCreationRecord = {
    taskId, leaseOwner: "owner", status: "created", plan, intentAt: new Date().toISOString(),
    observed: original, fingerprint: original.fingerprint, createdAt: new Date().toISOString(),
  };
  const operation = (status: "intent" | "candidate" | "applied", candidateSha?: string): CommitOperationRecord => ({
    id: `operation-${taskId}`, taskId, packageId: reviewPackage.id, verdictId: `verdict-${taskId}`,
    generationId: "generation", owner: "owner", claimOwner: "owner", claimGenerationId: "generation",
    branchRef: reviewPackage.branchRef, preHead: snapshot.preHead, treeId: snapshot.treeId,
    diffHash: snapshot.diffHash, message: "Reviewed result", timestamp: "2026-09-26T12:00:00+08:00",
    authorName: "Zero", authorEmail: "zero@localhost", committerName: "Zero", committerEmail: "zero@localhost",
    encoding: "UTF-8", status, ...(candidateSha ? { candidateSha } : {}), createdAt: new Date().toISOString(),
  });
  return { root, manager, creation, reviewPackage, operation, original };
}

test("review recovery accepts the exact pre-commit package with no operation or an intent", async () => {
  const f = await fixture("inspect_pre_commit");
  try {
    const noOperation = await inspectReviewRecovery(f.manager, f.creation, f.reviewPackage);
    assert.equal(noOperation.gitState.kind, "pre_commit");
    assert.equal(noOperation.identity.fingerprint, f.reviewPackage.snapshot.fingerprint);

    const intent = await inspectReviewRecovery(f.manager, f.creation, f.reviewPackage, f.operation("intent"));
    assert.equal(intent.gitState.kind, "pre_commit");
    assert.equal(intent.gitState.snapshot.diff, f.reviewPackage.snapshot.diff);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("persisted candidate before CAS is verified but classified as pre-commit", async () => {
  const f = await fixture("inspect_candidate_before_cas");
  try {
    const reviewed = {
      fingerprint: f.reviewPackage.snapshot.fingerprint, diff: f.reviewPackage.snapshot.diff,
      diffHash: f.reviewPackage.snapshot.diffHash, treeId: f.reviewPackage.snapshot.treeId,
    };
    const candidate = await f.manager.createReviewedCommitCandidate(f.original.info,
      f.reviewPackage.snapshot.preHead, reviewed, {
        opId: `operation-${f.creation.taskId}`, message: "Reviewed result", timestamp: "2026-09-26T12:00:00+08:00",
      });
    const result = await inspectReviewRecovery(f.manager, f.creation, f.reviewPackage,
      f.operation("candidate", candidate.commit));
    assert.equal(result.gitState.kind, "pre_commit");
    assert.equal((await f.manager.readTaskBranchHead(f.original.info)).head, f.reviewPackage.snapshot.preHead);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("applied candidate is verified after manager restart without comparing the old fingerprint", async () => {
  const f = await fixture("inspect_applied_restart");
  try {
    const reviewed = {
      fingerprint: f.reviewPackage.snapshot.fingerprint, diff: f.reviewPackage.snapshot.diff,
      diffHash: f.reviewPackage.snapshot.diffHash, treeId: f.reviewPackage.snapshot.treeId,
    };
    const candidate = await f.manager.createReviewedCommitCandidate(f.original.info,
      f.reviewPackage.snapshot.preHead, reviewed, {
        opId: `operation-${f.creation.taskId}`, message: "Reviewed result", timestamp: "2026-09-26T12:00:00+08:00",
      });
    await f.manager.applyReviewedCommitCandidate(f.original.info, candidate, reviewed);

    const freshManager = new GitWorktreeManager(join(f.root, "worktrees"));
    const result = await inspectReviewRecovery(freshManager, f.creation, f.reviewPackage,
      f.operation("candidate", candidate.commit));
    assert.equal(result.gitState.kind, "applied_candidate");
    if (result.gitState.kind === "applied_candidate") assert.equal(result.gitState.candidateSha, candidate.commit);
    assert.notEqual(result.identity.fingerprint, f.reviewPackage.snapshot.fingerprint);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("recovery fails closed for moved refs, missing candidate objects, and dirty applied indexes", async () => {
  const f = await fixture("inspect_fail_closed");
  try {
    const reviewed = {
      fingerprint: f.reviewPackage.snapshot.fingerprint, diff: f.reviewPackage.snapshot.diff,
      diffHash: f.reviewPackage.snapshot.diffHash, treeId: f.reviewPackage.snapshot.treeId,
    };
    const candidate = await f.manager.createReviewedCommitCandidate(f.original.info,
      f.reviewPackage.snapshot.preHead, reviewed, {
        opId: `operation-${f.creation.taskId}`, message: "Reviewed result", timestamp: "2026-09-26T12:00:00+08:00",
      });
    await assert.rejects(
      inspectReviewRecovery(f.manager, f.creation, f.reviewPackage, f.operation("candidate", "0".repeat(40))),
      /missing or is not a commit|could not get object info|not a valid/i,
    );

    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "competing"], { cwd: f.original.info.path });
    await assert.rejects(
      inspectReviewRecovery(f.manager, f.creation, f.reviewPackage, f.operation("candidate", candidate.commit)),
      /no longer points at the sealed package pre-HEAD|moved away/i,
    );
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("recovery rejects staged index pollution before CAS and after applied CAS", async () => {
  const f = await fixture("inspect_dirty_index");
  try {
    const reviewed = {
      fingerprint: f.reviewPackage.snapshot.fingerprint, diff: f.reviewPackage.snapshot.diff,
      diffHash: f.reviewPackage.snapshot.diffHash, treeId: f.reviewPackage.snapshot.treeId,
    };
    const candidate = await f.manager.createReviewedCommitCandidate(f.original.info,
      f.reviewPackage.snapshot.preHead, reviewed, {
        opId: `operation-${f.creation.taskId}`, message: "Reviewed result", timestamp: "2026-09-26T12:00:00+08:00",
      });
    await writeFile(join(f.original.info.path, "seed.txt"), "staged pollution\n");
    await exec("git", ["add", "seed.txt"], { cwd: f.original.info.path });
    await assert.rejects(
      inspectReviewRecovery(f.manager, f.creation, f.reviewPackage, f.operation("candidate", candidate.commit)),
      /does not match the complete immutable review package snapshot|Worktree changed while capturing/i,
    );

    await exec("git", ["reset", "--hard", f.reviewPackage.snapshot.preHead], { cwd: f.original.info.path });
    await writeFile(join(f.original.info.path, "seed.txt"), "reviewed\n");
    await f.manager.prepareReview(f.original.info);
    await f.manager.applyReviewedCommitCandidate(f.original.info, candidate, reviewed);
    await writeFile(join(f.original.info.path, "seed.txt"), "staged pollution after CAS\n");
    await exec("git", ["add", "seed.txt"], { cwd: f.original.info.path });
    await assert.rejects(
      inspectReviewRecovery(f.manager, f.creation, f.reviewPackage, f.operation("candidate", candidate.commit)),
      /clean worktree matching the reviewed snapshot/i,
    );
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("persisted self-committed candidate equal to pre-HEAD uses applied verification", async () => {
  const f = await fixture("inspect_self_committed");
  try {
    await exec("git", ["-c", "user.name=Harness", "-c", "user.email=harness@example.com", "commit", "-m", "self committed reviewed output"], { cwd: f.original.info.path });
    const head = (await f.manager.readTaskBranchHead(f.original.info)).head;
    const live = await f.manager.captureReviewSnapshot(f.original.info);
    const snapshot = { ...f.reviewPackage.snapshot, preHead: head, ...live };
    const reviewPackage = { ...f.reviewPackage, snapshot };
    const operation = { ...f.operation("candidate", head), preHead: head, treeId: snapshot.treeId, diffHash: snapshot.diffHash };
    const result = await inspectReviewRecovery(f.manager, f.creation, reviewPackage, operation);
    assert.equal(result.gitState.kind, "applied_candidate");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

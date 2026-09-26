import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitWorktreeManager, WORKTREE_FINGERPRINT_MAX_FILE_BYTES, type WorktreeInfo } from "./git-worktree.js";

async function candidateFixture(taskId: string) {
  const root = await mkdtemp(join(process.cwd(), `.zero-git-candidate-${taskId}-`));
  const repo = join(root, "repo");
  await mkdir(repo);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["config", "user.name", "Test"], { cwd: repo });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await writeFile(join(repo, "seed.txt"), "base\n");
  await exec("git", ["add", "seed.txt"], { cwd: repo });
  await exec("git", ["commit", "-m", "seed"], { cwd: repo });
  const manager = new GitWorktreeManager(join(root, "worktrees"));
  const info = await manager.create(taskId, repo, "main");
  await writeFile(join(info.path, "seed.txt"), "reviewed\n");
  const reviewed = await manager.prepareReview(info);
  const branch = await manager.readTaskBranchHead(info);
  const metadata = { opId: `op-${taskId}`, message: "Reviewed result", timestamp: "2026-09-26T12:00:00+08:00" };
  return { root, repo, manager, info, reviewed, branch, metadata };
}

test("reviewed candidate is deterministic and only moves the task branch after CAS", async () => {
  const fixture = await candidateFixture("candidate_cas");
  try {
    const { manager, info, reviewed, branch, metadata } = fixture;
    const first = await manager.createReviewedCommitCandidate(info, branch.head, reviewed, metadata);
    assert.deepEqual(await manager.readTaskBranchHead(info), branch);
    const second = await manager.createReviewedCommitCandidate(info, branch.head, reviewed, metadata);
    assert.equal(second.commit, first.commit);
    assert.equal((await manager.readTaskBranchHead(info)).head, branch.head);

    assert.equal(await manager.applyReviewedCommitCandidate(info, first, reviewed), first.commit);
    assert.equal((await manager.readTaskBranchHead(info)).head, first.commit);
    await manager.applyReviewedCommitCandidate(info, first, reviewed);
    await manager.verifyReviewedCommit(info, first.commit, reviewed);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("a fresh manager verifies an applied candidate after restart without its old pre-CAS fingerprint", async () => {
  const fixture = await candidateFixture("candidate_restart_verify");
  try {
    const { manager, info, reviewed, branch, metadata, root } = fixture;
    const candidate = await manager.createReviewedCommitCandidate(info, branch.head, reviewed, metadata);
    await manager.applyReviewedCommitCandidate(info, candidate, reviewed);

    const restartedManager = new GitWorktreeManager(join(root, "worktrees"));
    await restartedManager.verifyAppliedReviewedCommitCandidate(info, candidate, reviewed);
    assert.equal((await restartedManager.readTaskBranchHead(info)).head, candidate.commit);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("recovery can verify an existing candidate object before CAS and fails closed when it is missing", async () => {
  const fixture = await candidateFixture("candidate_object_recovery");
  try {
    const { manager, info, reviewed, branch, metadata } = fixture;
    const candidate = await manager.createReviewedCommitCandidate(info, branch.head, reviewed, metadata);
    await manager.verifyReviewedCommitCandidateObject(info, candidate, reviewed);
    assert.deepEqual(await manager.readTaskBranchHead(info), branch);

    await assert.rejects(
      manager.verifyReviewedCommitCandidateObject(info, { ...candidate, commit: "0".repeat(40) }, reviewed),
      /not a valid|missing or is not a commit|could not get object info/i,
    );
    assert.deepEqual(await manager.readTaskBranchHead(info), branch);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("restart verification rejects index pollution, wrong candidate metadata, and a moved branch", async () => {
  const fixture = await candidateFixture("candidate_restart_reject");
  try {
    const { manager, info, reviewed, branch, metadata, root } = fixture;
    const candidate = await manager.createReviewedCommitCandidate(info, branch.head, reviewed, metadata);
    await manager.applyReviewedCommitCandidate(info, candidate, reviewed);
    const restartedManager = new GitWorktreeManager(join(root, "worktrees"));

    await writeFile(join(info.path, "seed.txt"), "index pollution\n");
    await exec("git", ["add", "seed.txt"], { cwd: info.path });
    await assert.rejects(
      restartedManager.verifyAppliedReviewedCommitCandidate(info, candidate, reviewed),
      /clean worktree matching the reviewed snapshot/,
    );

    await exec("git", ["reset", "--hard", candidate.commit], { cwd: info.path });
    await assert.rejects(
      restartedManager.verifyAppliedReviewedCommitCandidate(info, { ...candidate, opId: "wrong-operation" }, reviewed),
      /operation id does not match/,
    );

    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "competing"], { cwd: info.path });
    await assert.rejects(
      restartedManager.verifyAppliedReviewedCommitCandidate(info, candidate, reviewed),
      /Task branch did not move to the reviewed candidate/,
    );
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("reviewed candidate refuses a competing branch ref update", async () => {
  const fixture = await candidateFixture("candidate_competing");
  try {
    const { manager, info, reviewed, branch, metadata } = fixture;
    const candidate = await manager.createReviewedCommitCandidate(info, branch.head, reviewed, metadata);
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "competing"], { cwd: info.path });
    const competingHead = (await manager.readTaskBranchHead(info)).head;
    assert.notEqual(competingHead, branch.head);
    await assert.rejects(manager.applyReviewedCommitCandidate(info, candidate, reviewed), /moved before candidate apply/);
    assert.equal((await manager.readTaskBranchHead(info)).head, competingHead);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("reviewed candidate apply fails closed when the candidate object is missing", async () => {
  const fixture = await candidateFixture("candidate_missing_object");
  try {
    const { manager, info, reviewed, branch, metadata } = fixture;
    const candidate = await manager.createReviewedCommitCandidate(info, branch.head, reviewed, metadata);
    await assert.rejects(
      manager.applyReviewedCommitCandidate(info, { ...candidate, commit: "0".repeat(40) }, reviewed),
      /not a valid|missing or is not a commit|could not get object info/i,
    );
    assert.equal((await manager.readTaskBranchHead(info)).head, branch.head);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("reviewed candidate refuses a dirty index without moving the branch", async () => {
  const fixture = await candidateFixture("candidate_dirty_index");
  try {
    const { manager, info, reviewed, branch, metadata } = fixture;
    const candidate = await manager.createReviewedCommitCandidate(info, branch.head, reviewed, metadata);
    await writeFile(join(info.path, "seed.txt"), "other staged value\n");
    await exec("git", ["add", "seed.txt"], { cwd: info.path });
    await assert.rejects(manager.applyReviewedCommitCandidate(info, candidate, reviewed), /no longer matches the reviewed snapshot/);
    assert.equal((await manager.readTaskBranchHead(info)).head, branch.head);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("reviewed candidate accepts a self-committed pre-HEAD with the reviewed tree", async () => {
  const fixture = await candidateFixture("candidate_self_commit");
  try {
    const { manager, info, metadata } = fixture;
    await exec("git", ["-c", "user.name=Harness", "-c", "user.email=harness@example.com", "commit", "-m", "worker self commit"], { cwd: info.path });
    const branch = await manager.readTaskBranchHead(info);
    const reviewed = await manager.captureReviewSnapshot(info);
    const candidate = await manager.createReviewedCommitCandidate(info, branch.head, reviewed, metadata);
    assert.equal(candidate.commit, branch.head);
    const { stdout: parentOutput } = await exec("git", ["show", "-s", "--format=%P", candidate.commit], { cwd: info.path });
    assert.equal(parentOutput.trim(), info.baseCommit);
    assert.equal((await manager.readTaskBranchHead(info)).head, branch.head);
    await manager.applyReviewedCommitCandidate(info, candidate, reviewed);
    await manager.verifyAppliedReviewedCommitCandidate(info, candidate, reviewed);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

const exec = promisify(execFile);

test("worktree is isolated, diff includes untracked files, and commit records output", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-git-test-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  await mkdir(repo);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const manager = new GitWorktreeManager(worktrees);
    const info = await manager.create("test_task", repo, "main");
    await writeFile(join(info.path, "seed.txt"), "changed\n");
    await writeFile(join(info.path, "new.txt"), "new data\n");
    const diff = await manager.diff(info);
    assert.match(diff, /seed\.txt/);
    assert.match(diff, /new\.txt/);
    assert.match(diff, /\+new data/);
    await exec("git", ["add", "-A"], { cwd: info.path });
    await exec("git", ["-c", "user.name=Harness", "-c", "user.email=harness@example.com", "commit", "-m", "harness internal commit"], { cwd: info.path });
    assert.deepEqual((await manager.changedPaths(info)).sort(), ["new.txt", "seed.txt"]);
    const reviewed = await manager.prepareReview(info);
    const commit = await manager.commit(info, "task result", reviewed);
    assert.ok(commit);
    assert.equal((await readFile(join(info.path, "new.txt"), "utf8")), "new data\n");
    await manager.remove(info, { deleteBranch: true });
    await assert.rejects(manager.create("../escape", repo, "main"), /unsafe path/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worktree creation plan rejects path or repository identity drift before Git writes", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-git-create-plan-test-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  await mkdir(repo);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const manager = new GitWorktreeManager(worktrees);
    const plan = await manager.prepareCreatePlan("plan_drift", repo, "main");
    await assert.rejects(manager.executePlan({ ...plan, path: join(worktrees, "elsewhere") }), /path does not match its planned task id/);
    await assert.rejects(manager.executePlan({ ...plan, commonGitDir: join(root, "other.git") }), /Git common directory changed/);
    await assert.equal(await manager.exists("plan_drift"), false);
    await assert.rejects(exec("git", ["show-ref", "--verify", "refs/heads/zero/plan_drift"], { cwd: repo }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reopenFromEvidence verifies registered identity and returns a fresh fingerprint", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-git-reopen-evidence-test-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const manager = new GitWorktreeManager(join(root, "worktrees"));
    const plan = await manager.prepareCreatePlan("reopen_task", repo, "main");
    const evidence = await manager.executePlan(plan);

    await writeFile(join(plan.path, "seed.txt"), "resumed work\n");
    const reopened = await manager.reopenFromEvidence(plan, evidence);
    assert.equal(reopened.info.path, plan.path);
    assert.equal(reopened.head, evidence.head);
    assert.match(reopened.fingerprint, /^[a-f0-9]{64}$/);
    assert.notEqual(reopened.fingerprint, evidence.fingerprint);
    assert.equal((await manager.fingerprint(reopened.info)), reopened.fingerprint);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reopenFromEvidence fails closed on persisted and registered identity tampering", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-git-reopen-tamper-test-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const manager = new GitWorktreeManager(join(root, "worktrees"));
    const plan = await manager.prepareCreatePlan("tamper_task", repo, "main");
    const evidence = await manager.executePlan(plan);

    await assert.rejects(manager.reopenFromEvidence({ ...plan, path: join(root, "wrong-path") }, evidence), /does not match its creation plan|does not match its planned task id/);
    await assert.rejects(manager.reopenFromEvidence(plan, { ...evidence, info: { ...evidence.info, branch: "zero/other" } }), /does not match its creation plan/);
    await assert.rejects(manager.reopenFromEvidence(plan, { ...evidence, commonGitDir: join(root, "other.git") }), /does not match its creation plan/);

    await exec("git", ["branch", "-m", "zero/tamper_task", "renamed-task-branch"], { cwd: plan.path });
    await assert.rejects(manager.reopenFromEvidence(plan, evidence), /registration is missing, ambiguous, or has an unexpected branch identity/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reopenFromEvidence rejects HEAD changes during fresh fingerprinting", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-git-reopen-race-test-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  class HeadChangingManager extends GitWorktreeManager {
    changeHeadAfterFingerprint = false;
    override async fingerprint(info: WorktreeInfo): Promise<string> {
      const fingerprint = await super.fingerprint(info);
      if (this.changeHeadAfterFingerprint) {
        this.changeHeadAfterFingerprint = false;
        await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "race commit"], { cwd: info.path });
      }
      return fingerprint;
    }
  }
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const manager = new HeadChangingManager(join(root, "worktrees"));
    const plan = await manager.prepareCreatePlan("head_race", repo, "main");
    const evidence = await manager.executePlan(plan);
    manager.changeHeadAfterFingerprint = true;

    await assert.rejects(manager.reopenFromEvidence(plan, evidence), /HEAD changed while reopening/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("commit refuses a harness-created empty commit when base-to-HEAD has no changes", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-git-empty-test-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const manager = new GitWorktreeManager(join(root, "worktrees"));
    const info = await manager.create("empty_task", repo, "main");
    await exec("git", ["-c", "user.name=Harness", "-c", "user.email=harness@example.com", "commit", "--allow-empty", "-m", "empty"], { cwd: info.path });
    assert.equal((await manager.diff(info)).trim(), "");
    assert.deepEqual(await manager.changedPaths(info), []);
    const reviewed = await manager.prepareReview(info);
    assert.equal(await manager.commit(info, "Zero result", reviewed), undefined);
    await manager.remove(info, { deleteBranch: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("review snapshot stages complete text and binary diffs and commit preserves its exact tree", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-git-reviewed-tree-test-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const manager = new GitWorktreeManager(join(root, "worktrees"));
    const info = await manager.create("reviewed_tree", repo, "main");
    await writeFile(join(info.path, "seed.txt"), "reviewed text\n");
    await writeFile(join(info.path, "new.txt"), "new text\n");
    await writeFile(join(info.path, "payload.bin"), Buffer.from([0, 17, 34, 51, 68]));

    const reviewed = await manager.prepareReview(info);
    assert.match(reviewed.diff, /seed\.txt/);
    assert.match(reviewed.diff, /new\.txt/);
    assert.match(reviewed.diff, /payload\.bin/);
    assert.match(reviewed.diff, /GIT binary patch/);
    assert.equal(reviewed.diffHash, createHash("sha256").update(reviewed.diff, "utf8").digest("hex"));
    assert.deepEqual((await manager.changedPaths(info)).sort(), ["new.txt", "payload.bin", "seed.txt"]);
    assert.notEqual(await manager.status(info), "");

    const commit = await manager.commit(info, "approved tree", reviewed);
    assert.ok(commit);
    await manager.verifyReviewedCommit(info, commit, reviewed);
    const { stdout: tree } = await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: info.path });
    assert.equal(tree.trim(), reviewed.treeId);
    assert.equal(await readFile(join(info.path, "new.txt"), "utf8"), "new text\n");
    await manager.remove(info, { deleteBranch: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worktree fingerprint detects same-length untracked binary replacement that diff and status miss", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-git-fingerprint-binary-test-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const manager = new GitWorktreeManager(join(root, "worktrees"));
    const info = await manager.create("binary_fingerprint", repo, "main");
    const binaryPath = join(info.path, "payload.bin");
    await writeFile(binaryPath, Buffer.from([0, 17, 34, 51]));
    const oldState = async () => `${await manager.status(info)}\0${await manager.diff(info)}`;
    const oldBefore = await oldState();
    const before = await manager.fingerprint(info);
    await writeFile(binaryPath, Buffer.from([0, 17, 34, 52]));
    const oldAfter = await oldState();
    const after = await manager.fingerprint(info);
    assert.equal(oldAfter, oldBefore);
    assert.notEqual(after, before);
    assert.match(before, /^[a-f0-9]{64}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worktree fingerprint includes index and HEAD identity and rejects oversized files and escaped paths", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-git-fingerprint-bounds-test-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const manager = new GitWorktreeManager(join(root, "worktrees"));
    const info = await manager.create("state_fingerprint", repo, "main");
    const initial = await manager.fingerprint(info);

    await writeFile(join(info.path, "seed.txt"), "staged content\n");
    await exec("git", ["add", "seed.txt"], { cwd: info.path });
    await writeFile(join(info.path, "seed.txt"), "base\n");
    assert.notEqual(await manager.fingerprint(info), initial);
    await exec("git", ["reset", "--hard", "HEAD"], { cwd: info.path });
    assert.equal(await manager.fingerprint(info), initial);

    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "empty"], { cwd: info.path });
    assert.notEqual(await manager.fingerprint(info), initial);
    await assert.rejects(manager.fingerprint({ ...info, path: repo }), /escapes configured directory/);

    const largeFile = join(info.path, "too-large.bin");
    await writeFile(largeFile, Buffer.alloc(0));
    await truncate(largeFile, WORKTREE_FINGERPRINT_MAX_FILE_BYTES + 1);
    await assert.rejects(manager.fingerprint(info), /exceeds .* byte limit/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worktree fingerprint fails closed for assume-unchanged and skip-worktree index flags", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-git-fingerprint-index-flags-test-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const manager = new GitWorktreeManager(join(root, "worktrees"));
    const info = await manager.create("index_flag_fingerprint", repo, "main");

    await exec("git", ["update-index", "--assume-unchanged", "seed.txt"], { cwd: info.path });
    await writeFile(join(info.path, "seed.txt"), "hidden assume-unchanged edit\n");
    assert.equal(await manager.status(info), "");
    await assert.rejects(manager.fingerprint(info), /assume-unchanged or skip-worktree/);
    await writeFile(join(info.path, "seed.txt"), "base\n");
    await exec("git", ["update-index", "--no-assume-unchanged", "seed.txt"], { cwd: info.path });

    await exec("git", ["update-index", "--skip-worktree", "seed.txt"], { cwd: info.path });
    await writeFile(join(info.path, "seed.txt"), "hidden skip-worktree edit\n");
    await assert.rejects(manager.fingerprint(info), /assume-unchanged or skip-worktree/);
    await writeFile(join(info.path, "seed.txt"), "base\n");
    await exec("git", ["update-index", "--no-skip-worktree", "seed.txt"], { cwd: info.path });
  } finally { await rm(root, { recursive: true, force: true }); }
});

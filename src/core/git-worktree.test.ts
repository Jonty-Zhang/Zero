import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitWorktreeManager, WORKTREE_FINGERPRINT_MAX_FILE_BYTES } from "./git-worktree.js";

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

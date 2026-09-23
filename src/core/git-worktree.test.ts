import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitWorktreeManager } from "./git-worktree.js";

const exec = promisify(execFile);

test("worktree is isolated, diff includes untracked files, and commit records output", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-git-test-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  await mkdir(repo);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
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
    await exec("git", ["-c", "user.name=Harness", "-c", "user.email=harness@example.invalid", "commit", "-m", "harness internal commit"], { cwd: info.path });
    assert.deepEqual((await manager.changedPaths(info)).sort(), ["new.txt", "seed.txt"]);
    const commit = await manager.commit(info, "task result");
    assert.ok(commit);
    assert.equal((await readFile(join(info.path, "new.txt"), "utf8")), "new data\n");
    await manager.remove(info, { deleteBranch: true });
    await assert.rejects(manager.create("../escape", repo, "main"), /unsafe path/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("commit refuses a harness-created empty commit when base-to-HEAD has no changes", async () => {
  const root = await mkdtemp(join(process.cwd(), ".zero-git-empty-test-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
    await writeFile(join(repo, "seed.txt"), "base\n");
    await exec("git", ["add", "seed.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "seed"], { cwd: repo });
    const manager = new GitWorktreeManager(join(root, "worktrees"));
    const info = await manager.create("empty_task", repo, "main");
    await exec("git", ["-c", "user.name=Harness", "-c", "user.email=harness@example.invalid", "commit", "--allow-empty", "-m", "empty"], { cwd: info.path });
    assert.equal((await manager.diff(info)).trim(), "");
    assert.deepEqual(await manager.changedPaths(info), []);
    assert.equal(await manager.commit(info, "Zero result"), undefined);
    await manager.remove(info, { deleteBranch: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

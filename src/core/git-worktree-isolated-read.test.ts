import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitWorktreeManager } from './git-worktree.js';
import { safeGitEnvironment } from '../orchestrator/trusted-codex-cwd.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
}
async function repository(path: string): Promise<void> {
  await mkdir(path);
  git(path, 'init', '-qb', 'main');
  git(path, 'config', 'core.autocrlf', 'false');
  await writeFile(join(path, 'file.txt'), 'initial\n');
  git(path, 'add', '.');
  git(path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
}
async function fixture(run: (root: string, manager: GitWorktreeManager, plan: Awaited<ReturnType<GitWorktreeManager['prepareCreatePlan']>>,
  evidence: Awaited<ReturnType<GitWorktreeManager['executePlan']>>, env: NodeJS.ProcessEnv) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'zero-isolated-read-'));
  try {
    const repo = join(root, 'repo'); await repository(repo);
    const manager = new GitWorktreeManager(join(root, 'worktrees'));
    const plan = await manager.prepareCreatePlan('task-isolated', repo, 'main');
    const evidence = await manager.executePlan(plan);
    const config = join(root, 'empty-global-config'); await writeFile(config, '');
    await run(root, manager, plan, evidence, safeGitEnvironment(config));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
}

test('isolated worktree reopening and fingerprinting never execute a configured fsmonitor', async () => fixture(async (root, manager, plan, evidence, env) => {
  const marker = join(root, 'fsmonitor-executed');
  const hook = join(root, 'fsmonitor.sh');
  await writeFile(hook, `#!/bin/sh\nprintf executed > "${marker.replaceAll('\\', '/')}"\nprintf 'token\\000'\n`, { mode: 0o700 });
  git(plan.repoPath, 'config', 'core.fsmonitor', hook.replaceAll('\\', '/'));
  // Establish the local Git hook is executable under the unchanged default API.
  await manager.reopenFromEvidence(plan, evidence);
  assert.equal(await readFile(marker, 'utf8'), 'executed');
  await rm(marker);
  await manager.reopenFromEvidence(plan, evidence, env);
  await assert.rejects(access(marker), 'isolated reopening must disable source fsmonitor commands');
  await manager.fingerprint(evidence.info, env);
  await assert.rejects(access(marker), 'isolated fingerprinting must disable source fsmonitor commands');
}));

test('isolated worktree reads ignore ambient Git directory and worktree overrides', async () => fixture(async (root, manager, plan, evidence, env) => {
  const other = join(root, 'other'); await repository(other);
  const original = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = join(other, '.git'); process.env.GIT_WORK_TREE = other;
  try {
    const reopened = await manager.reopenFromEvidence(plan, evidence, env);
    assert.equal(reopened.info.path, plan.path);
    assert.equal(reopened.commonGitDir, plan.commonGitDir);
    assert.equal(await manager.fingerprint(evidence.info, env), evidence.fingerprint);
  } finally {
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE'] as const) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
  }
}));

test('isolated Git evidence retains original commit changes despite replacement refs', async () => fixture(async (_root, manager, plan, evidence, env) => {
  await writeFile(join(plan.path, 'file.txt'), 'changed original content\n');
  git(plan.path, 'add', '.');
  git(plan.path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'result');
  const result = git(plan.path, 'rev-parse', 'HEAD');
  git(plan.repoPath, 'replace', plan.baseCommit, result);
  // Establish that replacement lookup would conceal the original base-to-result change.
  assert.equal(git(plan.path, 'diff', '--no-ext-diff', '--no-textconv', plan.baseCommit, result, '--'), '');
  const diff = execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', plan.baseCommit, result, '--'],
    { cwd: plan.path, env, encoding: 'utf8', windowsHide: true });
  assert.match(diff, /\+changed original content/);
  const reopened = await manager.reopenFromEvidence(plan, evidence, env);
  assert.equal(reopened.head, result);
  assert.equal(reopened.info.baseCommit, plan.baseCommit);
  assert.equal(reopened.commonGitDir, plan.commonGitDir);
}));

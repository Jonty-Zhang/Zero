import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitWorktreeManager } from '../core/git-worktree.js';
import { worktreeGitEnvironment } from './trusted-codex-cwd.js';

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
}

test('isolated worktree reads retain effective global CRLF normalization without executing fsmonitor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zero-worktree-eol-'));
  const keys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    const repo = join(root, 'repo'); await mkdir(repo);
    const globalConfig = join(root, 'user.gitconfig');
    await writeFile(globalConfig, '[core]\n\tautocrlf = true\n\teol = crlf\n');
    process.env.GIT_CONFIG_GLOBAL = globalConfig; process.env.GIT_CONFIG_NOSYSTEM = '1';
    git(repo, ['init', '-qb', 'main']);
    await writeFile(join(repo, 'result.txt'), 'original\n');
    git(repo, ['add', '.']);
    git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'fixture']);
    const manager = new GitWorktreeManager(join(root, 'worktrees'));
    const plan = await manager.prepareCreatePlan('task-eol', repo, 'main'); const observed = await manager.executePlan(plan);
    await writeFile(join(plan.path, 'result.txt'), 'mutation');
    git(plan.path, ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.']);
    assert.match(await readFile(join(plan.path, 'result.txt'), 'utf8'), /\r\n/);
    const marker = join(root, 'monitor-marker'); const hook = join(root, 'monitor.sh');
    await writeFile(hook, `#!/bin/sh\nprintf invoked > "${marker.replaceAll('\\', '/')}"\nprintf 'token\\000'\n`, { mode: 0o700 });
    git(repo, ['config', 'core.fsmonitor', hook.replaceAll('\\', '/')]);
    const emptyConfig = join(root, 'empty-config'); await writeFile(emptyConfig, '');
    const { env, textNormalization } = await worktreeGitEnvironment(emptyConfig, plan.path);
    assert.deepEqual(textNormalization, { autocrlf: 'true', eol: 'crlf' });
    assert.equal(git(plan.path, ['status', '--porcelain'], env), '', 'restored CRLF files must remain clean under the effective source text settings');
    await manager.reopenFromEvidence(plan, observed, env);
    await assert.rejects(access(marker));
    await writeFile(join(plan.path, 'result.txt'), 'actual content change\r\n');
    assert.match(git(plan.path, ['status', '--porcelain'], env), /result.txt/, 'normalization must not hide actual content changes');
    git(repo, ['config', 'core.autocrlf', 'input']); git(repo, ['config', 'core.eol', 'lf']);
    const { env: local, textNormalization: localSettings } = await worktreeGitEnvironment(emptyConfig, plan.path);
    assert.deepEqual(localSettings, { autocrlf: 'input', eol: 'lf' });
    assert.equal(git(plan.path, ['config', '--get', 'core.autocrlf'], local).trim(), 'input');
    assert.equal(git(plan.path, ['config', '--get', 'core.eol'], local).trim(), 'lf');
    assert.equal(git(plan.path, ['config', '--get', 'core.fsmonitor'], local).trim(), 'false');
    const legacy = join(root, 'legacy-config'); await writeFile(legacy, '[core]\n\tautocrlf = false\n\teol = crlf\n');
    process.env.GIT_DIR = join(root, 'missing.git'); process.env.GIT_WORK_TREE = join(root, 'missing');
    process.env.GIT_COMMON_DIR = join(root, 'missing-common'); process.env.GIT_INDEX_FILE = join(root, 'missing-index');
    process.env.GIT_CONFIG = legacy;
    assert.deepEqual((await worktreeGitEnvironment(emptyConfig, plan.path)).textNormalization, localSettings);
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG'] as const) delete process.env[key];
    for (const [value, expected] of [['yes', 'true'], ['off', 'false'], ['1', 'true'], ['0', 'false']]) {
      git(repo, ['config', 'core.autocrlf', value!]);
      assert.equal((await worktreeGitEnvironment(emptyConfig, plan.path)).textNormalization.autocrlf, expected);
    }
    git(repo, ['config', '--unset', 'core.autocrlf']); git(repo, ['config', '--unset', 'core.eol']);
    await writeFile(globalConfig, '');
    const defaults = await worktreeGitEnvironment(emptyConfig, plan.path);
    assert.deepEqual(defaults.textNormalization, { autocrlf: 'false', eol: 'native' });
    assert.equal(git(plan.path, ['config', '--get', 'core.autocrlf'], defaults.env).trim(), 'false');
    assert.equal(git(plan.path, ['config', '--get', 'core.eol'], defaults.env).trim(), 'native');
    git(repo, ['config', 'core.eol', 'unsupported']);
    await assert.rejects(worktreeGitEnvironment(emptyConfig, plan.path), /unsupported/);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

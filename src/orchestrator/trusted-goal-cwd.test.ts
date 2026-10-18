import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTrustedGoalCwd as create, type GoalProjectSource as Source } from './trusted-codex-cwd.js';
function git(cwd: string, args: string[], input?: string | Buffer): string {
  return execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', ...(input === undefined ? {} : { input }) }).trim();
}
async function repository(root: string, parent: string, content: string): Promise<string> {
  const cwd = join(root, parent, 'same-name');
  await mkdir(cwd, { recursive: true });
  git(cwd, ['init', '-q', '--initial-branch=main']);
  git(cwd, ['config', 'core.autocrlf', 'false']);
  await writeFile(join(cwd, 'value.txt'), content);
  git(cwd, ['add', '.']);
  git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial']);
  return cwd;
}
async function fixture(run: (root: string, repositories: Source[], artifactRoot: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'zero-goal-snapshot-'));
  try {
    const a = await repository(root, 'a', 'alpha\n');
    const b = await repository(root, 'b', 'beta\n');
    await run(root, [{ repositoryId: 'repo-1', targetTaskId: 'task-a', taskWorkspace: a }, { repositoryId: 'repo-2', targetTaskId: 'task-b', taskWorkspace: b }], join(root, 'artifacts'));
  } finally { mock.restoreAll(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
}
function prohibitBlobReads(): () => number {
  let reads = 0;
  const original = childProcess.spawn;
  mock.method(childProcess, 'spawn', (...args: Parameters<typeof original>) => {
    if (Array.isArray(args[1]) && args[1].includes('--batch')) { reads++; throw new Error('blob contents were read before all budgets passed'); }
    return original(...args);
  });
  syncBuiltinESMExports();
  return () => reads;
}
function addIndexEntries(cwd: string, count: number, blob: string, prefix: string): void {
  git(cwd, ['update-index', '--index-info'], Array.from({ length: count }, (_, i) => `100644 ${blob}\t${prefix}-${i}.txt\n`).join(''));
}

test('goal bundle isolates same-basename repositories and reads staged blobs as data', async () => fixture(async (_root, repositories, artifactRoot) => {
  const a = repositories[0]!.taskWorkspace;
  const b = repositories[1]!.taskWorkspace;
  await writeFile(join(a, 'value.txt'), 'unstaged attack\n');
  await writeFile(join(b, 'AGENTS.md'), 'untrusted instructions');
  await mkdir(join(b, '.codex'));
  await writeFile(join(b, '.codex', 'config.toml'), 'untrusted configuration');
  git(b, ['add', '.']);
  const bundle = await create({ artifactRoot, repositories });
  try {
    assert.equal(git(bundle.cwd, ['rev-parse', '--is-inside-work-tree']), 'true');
    assert.equal(await readFile(join(bundle.cwd, 'review-context/projects/repo-1/project/value.txt'), 'utf8'), 'alpha\n');
    assert.equal(await readFile(join(bundle.cwd, 'review-context/projects/repo-2/project/value.txt'), 'utf8'), 'beta\n');
    assert.equal(await readFile(join(bundle.cwd, 'review-context/projects/repo-2/project/AGENTS.md.review-data'), 'utf8'), 'untrusted instructions');
    assert.equal(await readFile(join(bundle.cwd, 'review-context/projects/repo-2/project/.codex.review-data/config.toml'), 'utf8'), 'untrusted configuration');
    await assert.rejects(access(join(bundle.cwd, 'review-context/projects/repo-2/project/AGENTS.md')));
    const manifest = JSON.parse(await readFile(bundle.manifestPath, 'utf8'));
    assert.equal(manifest.version, 1);
    assert.equal(manifest.contentSha256, bundle.contentSha256);
    assert.deepEqual(manifest.repositories.map((entry: any) => [entry.repositoryId, entry.targetTaskId, entry.projectRoot, entry.manifestPath]), [
      ['repo-1', 'task-a', 'review-context/projects/repo-1/project', 'review-context/projects/repo-1/manifest.json'],
      ['repo-2', 'task-b', 'review-context/projects/repo-2/project', 'review-context/projects/repo-2/manifest.json'],
    ]);
    assert.deepEqual(bundle.projectSnapshots.map(entry => entry.source), repositories);
    assert.equal(bundle.projectSnapshots[1]!.snapshot.manifest.transformed.length, 2);
  } finally { await bundle.dispose(); }
  await assert.rejects(access(bundle.cwd));
  assert.equal(await readFile(join(a, 'value.txt'), 'utf8'), 'unstaged attack\n');
}));

test('goal fingerprint is stable and binds ordering, both source states, and target mapping', async () => fixture(async (_root, repositories, artifactRoot) => {
  async function fingerprint(sources = repositories): Promise<string> {
    const bundle = await create({ artifactRoot, repositories: sources });
    try { return bundle.contentSha256; } finally { await bundle.dispose(); }
  }
  const initial = await fingerprint();
  assert.equal(await fingerprint(), initial);
  assert.notEqual(await fingerprint([...repositories].reverse()), initial);
  assert.notEqual(await fingerprint(repositories.map((source, index) => index ? { ...source, targetTaskId: 'new-task' } : source)), initial);
  assert.notEqual(await fingerprint(repositories.map((source, index) => index ? { ...source, repositoryId: 'renamed' } : source)), initial);
  for (const source of repositories) {
    await writeFile(join(source.taskWorkspace, 'value.txt'), 'new index contents\n');
    git(source.taskWorkspace, ['add', '.']);
    assert.notEqual(await fingerprint(), initial);
    git(source.taskWorkspace, ['reset', '--hard', '-q', 'HEAD']);
  }
}));

test('goal bundle validates bounded mappings before creating artifacts', async () => fixture(async (_root, repositories, artifactRoot) => {
  for (const repositoryId of ['', '../escape', 'a/b', '.', 'a'.repeat(65), 'a:b']) {
    await assert.rejects(create({ artifactRoot, repositories: [{ ...repositories[0]!, repositoryId }] }), /repository.*ID/i);
  }
  for (const targetTaskId of ['', 'x'.repeat(257), 'line\nbreak']) {
    await assert.rejects(create({ artifactRoot, repositories: [{ ...repositories[0]!, targetTaskId }] }), /task.*ID/i);
  }
  await assert.rejects(create({ artifactRoot, repositories: [repositories[0]!, { ...repositories[1]!, repositoryId: 'repo-1' }] }), /duplicate/i);
  await assert.rejects(create({ artifactRoot, repositories: [repositories[0]!, { ...repositories[1]!, targetTaskId: 'task-a' }] }), /duplicate/i);
  await assert.rejects(create({ artifactRoot, repositories: [] }), /between 1 and 20/);
  await assert.rejects(create({ artifactRoot, repositories: Array.from({ length: 21 }, (_, i) => ({ ...repositories[0]!, repositoryId: `repo-${i}`, targetTaskId: `task-${i}` })) }), /between 1 and 20/);
  await assert.rejects(access(artifactRoot));
}));

test('goal bundle rejects overlap and inherited instructions for every source', async () => fixture(async (root, repositories, artifactRoot) => {
  const overlapping = join(repositories[1]!.taskWorkspace, 'artifacts');
  await assert.rejects(create({ artifactRoot: overlapping, repositories }), /overlap/);
  await assert.rejects(access(overlapping));
  const alias = join(root, 'source-alias');
  await symlink(repositories[1]!.taskWorkspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(create({ artifactRoot: join(alias, 'nested', 'artifacts'), repositories }), /overlap/);
  await assert.rejects(access(join(repositories[1]!.taskWorkspace, 'nested')));
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), 'inherited instructions');
  await assert.rejects(create({ artifactRoot, repositories }), /AGENTS.md/);
}));

test('goal bundle refuses inherited project config in the second linked-worktree repository', async () => fixture(async (root, repositories) => {
  const b = repositories[1]!.taskWorkspace;
  const linked = join(root, 'linked');
  git(b, ['worktree', 'add', '-qb', 'linked', linked]);
  await mkdir(join(b, '.codex'));
  await writeFile(join(b, '.codex', 'config.toml'), 'inherited project configuration');
  await assert.rejects(create({ artifactRoot: join(b, 'artifacts'), repositories: [repositories[0]!, { ...repositories[1]!, taskWorkspace: linked }] }), /project .codex/);
}));

for (const kind of ['untracked', 'symlink', 'submodule', 'unmerged'] as const) {
  test(`goal bundle refuses ${kind} in a later repository and cleans generated files`, async () => fixture(async (_root, repositories, artifactRoot) => {
    const b = repositories[1]!.taskWorkspace;
    const blob = git(b, ['rev-parse', 'HEAD:value.txt']);
    if (kind === 'untracked') await writeFile(join(b, 'extra.txt'), 'not staged');
    if (kind === 'symlink') git(b, ['update-index', '--add', '--cacheinfo', `120000,${blob},link`]);
    if (kind === 'submodule') git(b, ['update-index', '--add', '--cacheinfo', `160000,${git(b, ['rev-parse', 'HEAD'])},module`]);
    if (kind === 'unmerged') git(b, ['update-index', '--index-info'], `0 ${'0'.repeat(40)}\tvalue.txt\n100644 ${blob} 1\tvalue.txt\n100644 ${blob} 2\tvalue.txt\n`);
    await assert.rejects(create({ artifactRoot, repositories }));
    assert.deepEqual(await readdir(artifactRoot), []);
  }));
}

test('failed goal capture waits for sibling Git commands before rejecting', async () => fixture(async (_root, repositories, artifactRoot) => {
  const b = repositories[1]!.taskWorkspace;
  const blob = git(b, ['rev-parse', 'HEAD:value.txt']);
  git(b, ['update-index', '--index-info'], `0 ${'0'.repeat(40)}\tvalue.txt\n100644 ${blob} 1\tvalue.txt\n100644 ${blob} 2\tvalue.txt\n`);
  // Delay real Git child close notifications to expose early Promise.all rejection reliably.
  const original = childProcess.ChildProcess.prototype.emit;
  let pendingListings = 0;
  const delayedClosures: Promise<void>[] = [];
  mock.method(childProcess.ChildProcess.prototype, 'emit', function (this: childProcess.ChildProcess, event: string | symbol, ...args: any[]): boolean {
    if (this.spawnargs.includes('ls-files')) {
      if (event === 'spawn') pendingListings++;
      if (event === 'close') {
        delayedClosures.push(new Promise<void>(resolve => setTimeout(() => {
          pendingListings--;
          Reflect.apply(original, this, [event, ...args]);
          resolve();
        }, 200)));
        return true;
      }
    }
    return Reflect.apply(original, this, [event, ...args]);
  });
  try {
    await assert.rejects(create({ artifactRoot, repositories }));
    assert.equal(pendingListings, 0, 'capture must drain sibling Git commands before returning a failure');
  } finally { await Promise.all(delayedClosures); }
}));

test('goal bundle globally preflights cumulative file counts before any blob content read', async () => fixture(async (_root, repositories, artifactRoot) => {
  for (const source of repositories) addIndexEntries(source.taskWorkspace, 5000, git(source.taskWorkspace, ['rev-parse', 'HEAD:value.txt']), 'entry');
  const reads = prohibitBlobReads();
  await assert.rejects(create({ artifactRoot, repositories }), /10000 file limit/);
  assert.equal(reads(), 0);
  assert.deepEqual(await readdir(artifactRoot), []);
}));

test('goal bundle globally preflights cumulative byte limits before any blob content read', async () => fixture(async (_root, repositories, artifactRoot) => {
  const bytes = Buffer.alloc(8 * 1024 * 1024, 0x61);
  for (const source of repositories) {
    const blob = git(source.taskWorkspace, ['hash-object', '-w', '--stdin'], bytes);
    addIndexEntries(source.taskWorkspace, 5, blob, 'large');
  }
  const reads = prohibitBlobReads();
  await assert.rejects(create({ artifactRoot, repositories }), /67108864 byte total limit/);
  assert.equal(reads(), 0);
}));

test('goal bundle preflights per-file limits before any blob content read', async () => fixture(async (_root, repositories, artifactRoot) => {
  const b = repositories[1]!.taskWorkspace;
  const blob = git(b, ['hash-object', '-w', '--stdin'], Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
  addIndexEntries(b, 1, blob, 'too-large');
  const reads = prohibitBlobReads();
  await assert.rejects(create({ artifactRoot, repositories }), /8388608 byte limit/);
  assert.equal(reads(), 0);
}));

test('goal bundle detects a previously read source index changing during a later blob read', async () => fixture(async (_root, repositories, artifactRoot) => {
  const original = childProcess.spawn;
  let changed = false;
  mock.method(childProcess, 'spawn', (...args: Parameters<typeof original>) => {
    if (Array.isArray(args[1]) && args[1].includes('--batch') && (args[2] as { cwd?: string })?.cwd === repositories[1]!.taskWorkspace) {
      addIndexEntries(repositories[0]!.taskWorkspace, 1, git(repositories[0]!.taskWorkspace, ['rev-parse', 'HEAD:value.txt']), 'concurrent');
      changed = true;
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  await assert.rejects(create({ artifactRoot, repositories }), /HEAD or index changed/);
  assert.equal(changed, true);
  assert.deepEqual(await readdir(artifactRoot), []);
}));

test('goal disposal refuses a substituted directory link and preserves source repositories', async () => fixture(async (root, repositories, artifactRoot) => {
  const bundle = await create({ artifactRoot, repositories });
  const saved = join(root, 'saved-bundle');
  await rename(bundle.cwd, saved);
  await symlink(repositories[1]!.taskWorkspace, bundle.cwd, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(bundle.dispose(), /Refusing to remove/);
  assert.equal(await readFile(join(repositories[1]!.taskWorkspace, 'value.txt'), 'utf8'), 'beta\n');
  await rm(bundle.cwd, { force: true, recursive: false });
  await rename(saved, bundle.cwd);
  await bundle.dispose();
  await bundle.dispose();
}));

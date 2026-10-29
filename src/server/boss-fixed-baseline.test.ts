import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { HarnessAdapter } from '../domain/types.js';
import { TaskStore } from '../core/task-store.js';
import { prepareProjectFolder } from './project-folders.js';
import type { LocalZeroConfig } from './config-store.js';
import { createZeroServer } from './server.js';

const execute = promisify(execFile);
async function fixture() {
  const fixtures = resolve('data/verification/boss-recovery-round27');
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(join(fixtures, 'baseline-')); assert.ok(root.startsWith(fixtures + sep));
  const repo = join(root, 'project'); await mkdir(repo); await writeFile(join(repo, 'source.txt'), 'accepted source');
  await prepareProjectFolder(repo);
  const git = async (...args: string[]) => (await execute('git', ['-C', repo, ...args], { windowsHide: true })).stdout.trim();
  const accepted = await git('rev-parse', 'HEAD');
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  const model = { id: 'lead', provider: 'openai', modelId: 'offline-lead' };
  const config = { async read(): Promise<LocalZeroConfig> { return {
    models: [model], bindings: [{ harness: 'codex', selector: 'cli_argument', verified: true, model, reasoningEfforts: [] }],
    allocator: { modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null },
    verifications: { 'codex:lead': { verifiedAt: '2026-10-30T00:00:00Z', cliVersion: 'offline-1', requestedModel: model.modelId,
      exitCode: 0, level: 'selector_only', reasoningEfforts: [] } },
  }; }, async write() {} };
  const codex: HarnessAdapter = { id: 'codex', async probe() { return { harness: 'codex', available: true, models: ['lead'] }; },
    async run() { throw new Error('Baseline admission must never call a model'); } };
  const server = createZeroServer({ store, config, adapters: { codex } });
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  let sequence = 0;
  const post = async (repoPath: string, baseRef: string) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-idempotency-key': `baseline-request-${++sequence}-123456`,
    }, body: JSON.stringify({ repoPath, baseRef, prompt: 'Continue the accepted project', boss: { preference: 'Codex leads' } }) });
    return { status: response.status, body: await response.json() as { id: string; error?: string } };
  };
  const identity = async () => ({ head: await git('rev-parse', 'HEAD'), refs: await git('show-ref'), objects: await git('count-objects', '-v'),
    index: await readFile(join(repo, '.git', 'index')), config: await readFile(join(repo, '.git', 'config')) });
  return { root, repo, accepted, git, store, post, identity, async close() {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); store.close();
    assert.ok(root.startsWith(fixtures + sep)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } };
}

test('explicit Boss baseline admits dirty projects without scanning or writing their current snapshot', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, 'source.txt'), 'later unreviewed edit');
    await writeFile(join(f.repo, 'large-local.bin'), Buffer.alloc(10 * 1024 * 1024 + 1));
    const before = await f.identity();
    const result = await f.post(f.repo, f.accepted); assert.equal(result.status, 201, result.body.error);
    assert.equal(f.store.get(result.body.id)?.baseRef, f.accepted);
    assert.equal(f.store.get(result.body.id)?.repoPath, await realpath(f.repo));
    assert.deepEqual(await f.identity(), before);
    assert.equal(await readFile(join(f.repo, 'source.txt'), 'utf8'), 'later unreviewed edit');
  } finally { await f.close(); }
});

test('invalid explicit baselines and wrong project roots never initialize or snapshot folders', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, 'source.txt'), 'a dirty file must not be hashed for a rejected baseline');
    const plain = join(f.root, 'plain'); const child = join(f.repo, 'child');
    await mkdir(plain); await mkdir(child); await writeFile(join(plain, 'new.txt'), 'no Git repository');
    const before = await f.identity();
    for (const [path, base] of [[f.repo, 'f'.repeat(40)], [f.repo, '-invalid'], [f.repo, 'bad\nref'],
      [plain, f.accepted], [child, f.accepted], [join(f.root, 'missing'), f.accepted]]) {
      const result = await f.post(path!, base!); assert.equal(result.status, 400, result.body.error);
    }
    assert.equal(f.store.list().length, 0);
    await assert.rejects(lstat(join(plain, '.git')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(child, '.git')), { code: 'ENOENT' });
    assert.deepEqual(await f.identity(), before);
  } finally { await f.close(); }
});

test('explicit Boss baseline supports an existing linked worktree without rewriting its metadata', async () => {
  const f = await fixture();
  try {
    const linked = join(f.root, 'linked');
    await f.git('worktree', 'add', '--detach', linked, f.accepted);
    assert.equal((await lstat(join(linked, '.git'))).isFile(), true);
    const marker = await readFile(join(linked, '.git'));
    await writeFile(join(linked, 'large-local.bin'), Buffer.alloc(10 * 1024 * 1024 + 1));
    const before = await f.identity();
    const result = await f.post(linked, f.accepted); assert.equal(result.status, 201, result.body.error);
    assert.equal(f.store.get(result.body.id)?.repoPath, await realpath(linked));
    assert.deepEqual(await readFile(join(linked, '.git')), marker);
    assert.deepEqual(await f.identity(), before);
  } finally { await f.close(); }
});

test('explicit Boss baseline validation ignores ambient Git directory and index redirection', async () => {
  const f = await fixture();
  const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    const before = await f.identity();
    process.env.GIT_DIR = join(f.root, 'wrong-git');
    process.env.GIT_WORK_TREE = join(f.root, 'wrong-worktree');
    process.env.GIT_INDEX_FILE = join(f.root, 'wrong-index');
    let result: Awaited<ReturnType<typeof f.post>>;
    try { result = await f.post(f.repo, f.accepted); }
    finally { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
    assert.equal(result.status, 201, result.body.error);
    assert.equal(f.store.get(result.body.id)?.baseRef, f.accepted);
    assert.deepEqual(await f.identity(), before);
    await assert.rejects(lstat(join(f.root, 'wrong-index')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(f.root, 'wrong-git')), { code: 'ENOENT' });
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await f.close();
  }
});

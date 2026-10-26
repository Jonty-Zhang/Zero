import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prepareProjectFolder, listProjectFolders } from './project-folders.js';
import { GitWorktreeManager } from '../core/git-worktree.js';
import { createZeroServer } from './server.js';
import { ConfigStore } from './config-store.js';
import { TaskStore } from '../core/task-store.js';

const execute = promisify(execFile);
async function fixture() {
  const base = resolve('data/verification/project-folders-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'case-'));
  return { root, close: () => rm(root, { recursive: true, force: true }) };
}

test('ordinary folders get a private baseline whose real task worktree contains existing source but no secrets or dependencies', async () => {
  const f = await fixture();
  try {
    const project = join(f.root, 'ordinary'); await mkdir(project);
    await writeFile(join(project, 'hello.txt'), 'existing project content');
    await writeFile(join(project, '.env'), 'secret-do-not-snapshot');
    await writeFile(join(project, '.ENV.LOCAL'), 'uppercase-secret-do-not-snapshot');
    await writeFile(join(project, 'auth.json'), 'token-do-not-snapshot');
    await mkdir(join(project, 'node_modules')); await writeFile(join(project, 'node_modules', 'dependency.js'), 'dependency');
    const prepared = await prepareProjectFolder(project);
    assert.equal(prepared.initialized, true); assert.equal(prepared.path, project); assert.equal(prepared.repoPath, project);
    assert.equal(await readFile(join(project, '.env'), 'utf8'), 'secret-do-not-snapshot');
    const worktrees = new GitWorktreeManager(join(f.root, 'worktrees'));
    const task = await worktrees.create('folder-task', prepared.repoPath, 'HEAD');
    assert.equal(await readFile(join(task.path, 'hello.txt'), 'utf8'), 'existing project content');
    for (const path of ['.env', '.ENV.LOCAL', 'auth.json', 'node_modules/dependency.js']) await assert.rejects(readFile(join(task.path, path)));
    const remotes = await execute('git', ['-C', project, 'remote'], { windowsHide: true });
    assert.equal(remotes.stdout.trim(), '');
    assert.equal((await prepareProjectFolder(project)).initialized, false);
  } finally { await f.close(); }
});

test('existing unborn Git projects gain usable history without changing their pre-existing index or configuration', async () => {
  const f = await fixture();
  try {
    const path = join(f.root, 'unborn'); await mkdir(path);
    await execute('git', ['init', '--initial-branch=custom', '--template=', path], { windowsHide: true });
    await writeFile(join(path, 'staged.txt'), 'staged version');
    await execute('git', ['-C', path, 'add', '--', 'staged.txt'], { windowsHide: true });
    await writeFile(join(path, 'staged.txt'), 'current version');
    await writeFile(join(path, 'other.txt'), 'untracked existing content');
    await writeFile(join(path, '.env'), 'private');
    const originalIndex = await readFile(join(path, '.git', 'index'));
    const originalConfig = await readFile(join(path, '.git', 'config'));
    await prepareProjectFolder(path);
    assert.deepEqual(await readFile(join(path, '.git', 'index')), originalIndex);
    assert.deepEqual(await readFile(join(path, '.git', 'config')), originalConfig);
    const branch = await execute('git', ['-C', path, 'symbolic-ref', 'HEAD'], { windowsHide: true });
    assert.equal(branch.stdout.trim(), 'refs/heads/custom');
    const worktrees = new GitWorktreeManager(join(f.root, 'worktrees'));
    const task = await worktrees.create('unborn-task', path, 'HEAD');
    assert.equal(await readFile(join(task.path, 'staged.txt'), 'utf8'), 'current version');
    assert.equal(await readFile(join(task.path, 'other.txt'), 'utf8'), 'untracked existing content');
    await assert.rejects(readFile(join(task.path, '.env')));
  } finally { await f.close(); }
});

test('oversized source fails explicitly, and correcting it allows preparation to retry its own unfinished initialization', async () => {
  const f = await fixture();
  try {
    const path = join(f.root, 'retry'); await mkdir(path);
    await writeFile(join(path, 'large-source.txt'), Buffer.alloc(10 * 1024 * 1024 + 1, 65));
    await assert.rejects(prepareProjectFolder(path), /超过 10 MiB/);
    await writeFile(join(path, 'large-source.txt'), 'corrected small source');
    assert.equal((await prepareProjectFolder(path)).initialized, true);
    assert.equal((await execute('git', ['-C', path, 'show', 'HEAD:large-source.txt'], { windowsHide: true })).stdout, 'corrected small source');
  } finally { await f.close(); }
});

test('preparing an unborn repository never executes its configured Git clean filter', async () => {
  const f = await fixture();
  try {
    const path = join(f.root, 'filters'); await mkdir(path);
    await execute('git', ['init', '--initial-branch=main', '--template=', path], { windowsHide: true });
    await writeFile(join(path, '.gitattributes'), '*.txt filter=must-not-run\n');
    await execute('git', ['-C', path, 'config', 'filter.must-not-run.clean', 'zero-no-external-filter-is-allowed'], { windowsHide: true });
    await execute('git', ['-C', path, 'config', 'filter.must-not-run.required', 'true'], { windowsHide: true });
    await writeFile(join(path, 'content.txt'), 'raw source bytes\r\n');
    const configuration = await readFile(join(path, '.git', 'config'));
    await prepareProjectFolder(path);
    assert.deepEqual(await readFile(join(path, '.git', 'config')), configuration);
    const content = await execute('git', ['-C', path, 'show', 'HEAD:content.txt'], { windowsHide: true });
    assert.equal(content.stdout, 'raw source bytes\r\n');
  } finally { await f.close(); }
});

test('preparing a folder does not execute its repository reference-transaction hook', async () => {
  const f = await fixture();
  try {
    const path = join(f.root, 'hooks'); await mkdir(path);
    await execute('git', ['init', '--initial-branch=main', '--template=', path], { windowsHide: true });
    const hooks = join(path, '.git', 'custom-hooks'); await mkdir(hooks);
    await execute('git', ['-C', path, 'config', 'core.hooksPath', hooks], { windowsHide: true });
    const interpreter = process.execPath.replaceAll('\\', '/').replace('Program Files', 'PROGRA~1');
    await writeFile(join(hooks, 'reference-transaction'), `#!${interpreter}\nimport { writeFileSync } from 'node:fs'; writeFileSync('hook-was-run.txt', 'unsafe execution');\n`, { mode: 0o755 });
    await writeFile(join(path, 'content.txt'), 'source');
    const configuration = await readFile(join(path, '.git', 'config'));
    await prepareProjectFolder(path);
    await assert.rejects(readFile(join(path, 'hook-was-run.txt')), /ENOENT/);
    assert.deepEqual(await readFile(join(path, '.git', 'config')), configuration);
    assert.equal((await execute('git', ['-C', path, 'show', 'HEAD:content.txt'], { windowsHide: true })).stdout, 'source');
  } finally { await f.close(); }
});

test('an existing Git project starts from current files without changing its HEAD, index or source files', async () => {
  const f = await fixture();
  try {
    const path = join(f.root, 'current-files'); await mkdir(path);
    await writeFile(join(path, 'source.txt'), 'committed');
    await writeFile(join(path, 'removed.txt'), 'remove me');
    await prepareProjectFolder(path);
    const originalHead = (await execute('git', ['-C', path, 'rev-parse', 'HEAD'], { windowsHide: true })).stdout.trim();
    await writeFile(join(path, 'source.txt'), 'staged');
    await execute('git', ['-C', path, 'add', 'source.txt'], { windowsHide: true });
    await writeFile(join(path, 'source.txt'), 'current user edits');
    await writeFile(join(path, 'new.txt'), 'untracked current source');
    await rm(join(path, 'removed.txt'));
    const index = await readFile(join(path, '.git', 'index'));
    const configuration = await readFile(join(path, '.git', 'config'));
    const prepared = await prepareProjectFolder(path);
    assert.notEqual(prepared.baseRef, 'HEAD');
    assert.deepEqual(await readFile(join(path, '.git', 'index')), index);
    assert.deepEqual(await readFile(join(path, '.git', 'config')), configuration);
    assert.equal((await execute('git', ['-C', path, 'rev-parse', 'HEAD'], { windowsHide: true })).stdout.trim(), originalHead);
    assert.equal(await readFile(join(path, 'source.txt'), 'utf8'), 'current user edits');
    const worktree = await new GitWorktreeManager(join(f.root, 'worktrees')).create('current-folder-task', path, prepared.baseRef!);
    assert.equal(await readFile(join(worktree.path, 'source.txt'), 'utf8'), 'current user edits');
    assert.equal(await readFile(join(worktree.path, 'new.txt'), 'utf8'), 'untracked current source');
    await assert.rejects(readFile(join(worktree.path, 'removed.txt')), /ENOENT/);
  } finally { await f.close(); }
});

test('empty folders and explicitly created folders work; missing folders are not implicitly created', async () => {
  const f = await fixture();
  try {
    const path = join(f.root, 'new-project');
    await assert.rejects(prepareProjectFolder(path), /文件夹不存在/);
    assert.equal((await prepareProjectFolder(path, true)).initialized, true);
    const result = await execute('git', ['-C', path, 'rev-parse', '--verify', 'HEAD^{commit}'], { windowsHide: true });
    assert.match(result.stdout.trim(), /^[a-f0-9]{40,64}$/);
    await assert.rejects(prepareProjectFolder(join(f.root, 'missing-parent', 'child'), true), /文件夹不存在/);
  } finally { await f.close(); }
});

test('a selected nested folder is never silently promoted to its parent repository', async () => {
  const f = await fixture();
  try {
    await prepareProjectFolder(f.root);
    const child = join(f.root, 'nested'); await mkdir(child); await writeFile(join(child, 'inside.txt'), 'nested content');
    const result = await prepareProjectFolder(child);
    assert.equal(result.repoPath, child); assert.equal(result.initialized, true);
    const top = await execute('git', ['-C', child, 'rev-parse', '--show-toplevel'], { windowsHide: true });
    assert.equal(resolve(top.stdout.trim()), child);
    const parent = await execute('git', ['-C', f.root, 'ls-files'], { windowsHide: true });
    assert.equal(parent.stdout, '');
  } finally { await f.close(); }
});

test('folder browsing lists visible child directories only and leaves project files untouched', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'visible')); await mkdir(join(f.root, '.private')); await writeFile(join(f.root, 'file.txt'), 'untouched');
    assert.deepEqual((await listProjectFolders(f.root)).folders, [{ name: 'visible', path: join(f.root, 'visible') }]);
    await assert.rejects(readFile(join(f.root, '.git', 'HEAD')));
    assert.equal(await readFile(join(f.root, 'file.txt'), 'utf8'), 'untouched');
  } finally { await f.close(); }
});

test('linked child directories cannot import outside files, and concurrent preparation shares one initialization', async () => {
  const f = await fixture();
  try {
    const path = join(f.root, 'project'); const outside = join(f.root, 'outside');
    await mkdir(path); await mkdir(outside); await writeFile(join(outside, 'private.txt'), 'outside selected folder');
    await symlink(outside, join(path, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(path, 'source.txt'), 'inside');
    assert.deepEqual((await listProjectFolders(path)).folders, []);
    const results = await Promise.all(Array.from({ length: 5 }, () => prepareProjectFolder(path)));
    assert.ok(results.every(result => result.initialized));
    const files = await execute('git', ['-C', path, 'ls-tree', '--name-only', '-r', 'HEAD'], { windowsHide: true });
    assert.equal(files.stdout.trim(), 'source.txt');
    assert.equal(await readFile(join(outside, 'private.txt'), 'utf8'), 'outside selected folder');
  } finally { await f.close(); }
});

test('Boss submission accepts a normal folder and plain objective with no user-authored checks or execution stages', async () => {
  const f = await fixture();
  const store = new TaskStore(join(f.root, 'tasks.sqlite'));
  const config = new ConfigStore(join(f.root, 'config.json'));
  const model = { id: 'fixture-lead', provider: 'openai', modelId: 'offline-lead' };
  await writeFile(config.path, JSON.stringify({ models: [model], bindings: [{ harness: 'codex', selector: 'cli_argument', verified: true, model, reasoningEfforts: ['high'] }],
    allocator: { modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null },
    verifications: { 'codex:fixture-lead': { verifiedAt: '2026-10-26T00:00:00Z', cliVersion: 'offline-1', requestedModel: model.modelId,
      exitCode: 0, level: 'selector_only', reasoningEfforts: ['high'] } } }));
  const server = createZeroServer({ store, config, adapters: { codex: {
    id: 'codex', async probe() { return { harness: 'codex', available: true, models: [model.id], reasoningEfforts: ['high'] }; },
    async run() { throw new Error('Folder API tests must never execute a model'); },
  } } });
  try {
    const project = join(f.root, 'boss-project'); await mkdir(project); await writeFile(join(project, 'input.md'), 'existing objective');
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repoPath: project, prompt: '优化', boss: { preference: 'codex gpt6.1sol high，便宜模型负责实现' } }) });
    assert.equal(response.status, 201, await response.text());
    const task = store.list()[0]!;
    assert.equal(task.repoPath, project); assert.deepEqual(task.checks, []); assert.equal(task.prompt, '优化');
    assert.equal(task.boss?.preference, 'codex gpt6.1sol high，便宜模型负责实现');
    const messageResponse = await fetch(`${base}/api/tasks/${task.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '优先确保原有数据保持完整' }) });
    assert.equal(messageResponse.status, 201, await messageResponse.text());
    const detail = await (await fetch(`${base}/api/tasks/${task.id}`)).json() as { bossMessages: Array<{ content: string }> };
    assert.equal(detail.bossMessages.at(-1)?.content, '优先确保原有数据保持完整');
    const crossOrigin = await fetch(`${base}/api/folders?path=${encodeURIComponent(f.root)}`, { headers: { Origin: 'https://untrusted.example' } });
    assert.equal(crossOrigin.status, 403);
    const folders = await (await fetch(`${base}/api/folders?path=${encodeURIComponent(f.root)}`)).json() as { folders: Array<{ name: string }> };
    assert.ok(folders.folders.some(folder => folder.name === 'boss-project'));
    await writeFile(join(project, 'input.md'), 'a newer uncommitted user requirement');
    const current = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repoPath: project, prompt: 'Use my current files', boss: { preference: '' } }) });
    assert.equal(current.status, 201, await current.text());
    const currentTask = store.list().find(item => item.prompt === 'Use my current files')!;
    assert.notEqual(currentTask.baseRef, 'HEAD');
    assert.equal((await execute('git', ['-C', project, 'show', `${currentTask.baseRef}:input.md`], { windowsHide: true })).stdout, 'a newer uncommitted user requirement');
    const oversized = await fetch(`${base}/api/tasks/${task.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'x'.repeat(16001) }) });
    assert.equal(oversized.status, 400);
    store.claimNext('message-boundary');
    store.transition(task.id, 'running', 'reviewing', { owner: 'message-boundary' });
    const late = await fetch(`${base}/api/tasks/${task.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Do not accept and forget this request' }) });
    assert.equal(late.status, 409); assert.match(await late.text(), /正在验收/);
    assert.equal(store.bossMessages(task.id).length, 1);
  } finally { await new Promise<void>(done => server.close(() => done())); store.close(); await f.close(); }
});

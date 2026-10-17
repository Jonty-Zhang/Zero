import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TaskStore } from '../core/task-store.js';
import { createZeroServer, type TaskStorePort } from './server.js';
import type { LocalZeroConfig } from './config-store.js';

const exec = promisify(execFile);
const requestKey = 'http-request-00000000001';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(legacyPort = false) {
  const root = await mkdtemp(join(process.cwd(), '.zero-idempotency-http-'));
  const repo = join(root, 'repo');
  await mkdir(repo);
  await exec('git', ['init', '-b', 'main'], { cwd: repo, windowsHide: true });
  await exec('git', ['config', 'user.name', 'Zero HTTP Test'], { cwd: repo, windowsHide: true });
  await exec('git', ['config', 'user.email', 'zero-http@example.com'], { cwd: repo, windowsHide: true });
  await writeFile(join(repo, 'README.md'), 'HTTP idempotency fixture.\n');
  await exec('git', ['add', 'README.md'], { cwd: repo, windowsHide: true });
  await exec('git', ['commit', '-m', 'fixture'], { cwd: repo, windowsHide: true });
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  const config: LocalZeroConfig = {
    models: [], bindings: [], allocator: { modelId: null, reasoningEffort: null },
    reviewer: { modelId: null, reasoningEffort: null }, verifications: {},
  };
  const state: { configReads: number; beforeRead?: () => Promise<void>; onEnqueue?: () => void } = { configReads: 0 };
  const enqueued: string[] = [];
  const port: TaskStorePort = legacyPort ? new Proxy(store, {
    get(target, property) {
      if (['lookupSubmissionRequest', 'submitIdempotent', 'createSequenceIdempotent'].includes(String(property))) return undefined;
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) : store;
  const server = createZeroServer({
    store: port, adapters: {},
    config: { async read() { state.configReads++; await state.beforeRead?.(); return config; }, async write() {} },
    enqueue(id) { enqueued.push(id); state.onEnqueue?.(); },
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const payload = { repoPath: repo, baseRef: 'main', prompt: 'Implement the requested parser', checkCommands: ['node --version'] };
  const post = async (path: string, body: unknown, key: string | undefined = requestKey) => {
    const response = await fetch(`${url}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(key === undefined ? {} : { 'x-idempotency-key': key }) }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as { id: string; error?: string; steps?: Array<{ task: { id: string } }> } };
  };
  return {
    store, config, state, enqueued, url, payload, post,
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

test('concurrent HTTP task retries share one durable ID and enqueue once', async () => {
  const f = await fixture();
  try {
    const responses = await Promise.all(Array.from({ length: 4 }, () => f.post('/api/tasks', f.payload)));
    assert.deepEqual(responses.map(response => response.status), [201, 201, 201, 201]);
    assert.equal(new Set(responses.map(response => response.body.id)).size, 1);
    assert.equal(f.store.list().length, 1);
    assert.deepEqual(f.enqueued, [responses[0]!.body.id]);
    const reordered = { prompt: f.payload.prompt, checkCommands: f.payload.checkCommands, baseRef: f.payload.baseRef, repoPath: f.payload.repoPath };
    assert.equal((await f.post('/api/tasks', reordered)).body.id, responses[0]!.body.id);
    const fresh = await f.post('/api/tasks', f.payload, 'http-request-intentional-new');
    assert.equal(fresh.status, 201);
    assert.notEqual(fresh.body.id, responses[0]!.body.id);
    assert.equal(f.enqueued.length, 2);
  } finally { await f.close(); }
});

test('HTTP idempotency conflicts reject changed payloads and cross-endpoint key reuse', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post('/api/tasks', f.payload)).status, 201);
    const changed = await f.post('/api/tasks', { ...f.payload, prompt: 'Implement another requested parser' });
    assert.equal(changed.status, 409);
    assert.match(changed.body.error ?? '', /idempotency/i);
    assert.equal((await f.post('/api/sequences', { tasks: [f.payload, f.payload] })).status, 409);
    assert.equal(f.store.list().length, 1);
    assert.equal(f.enqueued.length, 1);
  } finally { await f.close(); }
});

test('HTTP sequence retries return the original ordered tasks without enqueueing again', async () => {
  const f = await fixture();
  try {
    const payload = { objective: 'Complete both parser tasks', tasks: [f.payload, { ...f.payload, prompt: 'Verify the parser behavior' }] };
    const responses = await Promise.all([f.post('/api/sequences', payload), f.post('/api/sequences', payload)]);
    assert.deepEqual(responses.map(response => response.status), [201, 201]);
    assert.equal(responses[0]!.body.id, responses[1]!.body.id);
    assert.deepEqual(responses[0]!.body.steps, responses[1]!.body.steps);
    assert.equal(f.store.listSequences().length, 1);
    assert.equal(f.store.list().length, 2);
    assert.deepEqual(f.enqueued, responses[0]!.body.steps!.map(step => step.task.id));
    assert.equal((await f.post('/api/sequences', { ...payload, objective: 'A different objective' })).status, 409);
  } finally { await f.close(); }
});

test('retry after the HTTP response is abandoned returns the task the server still created', { timeout: 15_000 }, async () => {
  const f = await fixture();
  const parsing = deferred();
  const continueParsing = deferred();
  const persisted = deferred();
  const controller = new AbortController();
  try {
    f.state.beforeRead = async () => { parsing.resolve(); await continueParsing.promise; };
    f.state.onEnqueue = persisted.resolve;
    const abandoned = fetch(`${f.url}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-idempotency-key': requestKey }, body: JSON.stringify(f.payload), signal: controller.signal,
    }).then(() => false, () => true);
    await parsing.promise;
    controller.abort();
    assert.equal(await abandoned, true);
    continueParsing.resolve();
    await persisted.promise;
    const storedId = f.store.list()[0]!.id;
    const retry = await f.post('/api/tasks', f.payload);
    assert.equal(retry.status, 201);
    assert.equal(retry.body.id, storedId);
    assert.equal(f.store.list().length, 1);
    assert.deepEqual(f.enqueued, [storedId]);
  } finally { continueParsing.resolve(); await f.close(); }
});

test('replaying raw request identity succeeds after execution defaults become unavailable', async () => {
  const f = await fixture();
  try {
    const first = await f.post('/api/tasks', f.payload);
    assert.equal(first.status, 201);
    f.config.executionDefaults = { global: { harness: 'unavailable-harness' }, projects: {} };
    const reads = f.state.configReads;
    const replay = await f.post('/api/tasks', f.payload);
    assert.equal(replay.status, 201);
    assert.equal(replay.body.id, first.body.id);
    assert.equal(f.state.configReads, reads, 'lookup must precede configuration/probe validation');
    assert.equal((await f.post('/api/tasks', f.payload, 'http-request-after-config')).status, 400);
    assert.equal(f.store.list().length, 1);
    assert.equal(f.enqueued.length, 1);
  } finally { await f.close(); }
});

test('invalid idempotency headers fail before submission while missing headers retain legacy behavior', async () => {
  const f = await fixture();
  try {
    for (const key of ['', 'short', 'a'.repeat(129), 'http-key-000000001,another-key']) {
      assert.equal((await f.post('/api/tasks', f.payload, key)).status, 400);
    }
    assert.equal(f.store.list().length, 0);
    // The helper's default is a key, so use direct requests to omit the header.
    const responses = await Promise.all([0, 1].map(() => fetch(`${f.url}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(f.payload),
    })));
    assert.deepEqual(responses.map(response => response.status), [201, 201]);
    const tasks = await Promise.all(responses.map(response => response.json() as Promise<{ id: string }>));
    assert.notEqual(tasks[0]!.id, tasks[1]!.id);
    assert.equal(f.store.list().length, 2);
  } finally { await f.close(); }
});

test('ports without durable idempotency explicitly reject keyed HTTP requests', async () => {
  const f = await fixture(true);
  try {
    const task = await f.post('/api/tasks', f.payload);
    assert.equal(task.status, 501);
    assert.match(task.body.error ?? '', /idempotency/i);
    assert.equal((await f.post('/api/sequences', { tasks: [f.payload, f.payload] })).status, 501);
    assert.equal(f.store.list().length, 0);
    assert.equal(f.enqueued.length, 0);
  } finally { await f.close(); }
});

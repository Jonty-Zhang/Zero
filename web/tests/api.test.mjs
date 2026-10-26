import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { api } from '../src/api.ts';

test('project folder APIs encode local paths and preserve preparation intent and supplementary messages', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    calls.push({ path, method: init.method ?? 'GET', body: init.body && JSON.parse(init.body), signal: init.signal });
    return new Response(JSON.stringify({ accepted: true }), { headers: { 'Content-Type': 'application/json' } });
  });
  const folder = 'C:\\项目\\new #folder?';
  const controller = new AbortController();
  await api.folders(folder, { signal: controller.signal });
  await api.folders();
  await api.prepareProject(folder, true);
  await api.messageTask('task/中文 ?', '请检查接力过程');
  assert.equal(calls[0].path, `/api/folders?path=${encodeURIComponent(folder)}`);
  assert.equal(calls[1].path, '/api/folders');
  assert.equal(calls[2].path, '/api/projects/prepare');
  assert.deepEqual(calls[2].body, { path: folder, create: true });
  assert.equal(calls[3].path, `/api/tasks/${encodeURIComponent('task/中文 ?')}/messages`);
  assert.deepEqual(calls[3].body, { content: '请检查接力过程' });
});

test('Boss task retries retain submission identity and exact natural-language preferences', async (t) => {
  const calls = [];
  let fail = true;
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    calls.push({ path, key: init.headers['X-Idempotency-Key'], body: JSON.parse(init.body) });
    if (fail) { fail = false; throw new TypeError('request result uncertain'); }
    return new Response(JSON.stringify({ id: 'boss-created' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  });
  const payload = { repoPath: 'C:/project', prompt: '设计、实现并验收项目', boss: { preference: 'Codex gpt6.1sol high 负责设计，DSH 处理普通工作' } };
  await assert.rejects(api.createTask(payload), /uncertain/);
  await api.createTask(payload);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].key, calls[1].key);
  assert.deepEqual(calls[1].body, payload);
  assert.equal(calls[1].path, '/api/tasks');
});

test('goal review retry posts the exact source attempt and encoded sequence path without task submission keys', async (t) => {
  const sourceAttempt = 'attempt/source ?中文';
  const sequence = { id: 'sequence/中文 ?', status: 'blocked', goalReview: { state: 'verdict', attemptId: sourceAttempt, retryRequestedAt: '2026-10-18T00:00:00Z', result: { verdict: 'blocked' } } };
  let received;
  let status = 202;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { path: req.url, method: req.method, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status === 202 ? sequence : { error: '最新验收尝试已变化' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (path, init) => nativeFetch(`http://127.0.0.1:${server.address().port}${path}`, init));
  assert.deepEqual(await api.retrySequenceGoalReview(sequence.id, sourceAttempt), sequence);
  assert.equal(received.path, `/api/sequences/${encodeURIComponent(sequence.id)}/goal-review/retry`);
  assert.equal(received.method, 'POST');
  assert.equal(received.headers['content-type'], 'application/json');
  assert.equal(received.headers['x-idempotency-key'], undefined);
  assert.deepEqual(received.body, { attemptId: sourceAttempt });
  status = 409;
  await assert.rejects(api.retrySequenceGoalReview(sequence.id, sourceAttempt), { message: '最新验收尝试已变化' });
  assert.deepEqual(received.body, { attemptId: sourceAttempt });
  assert.equal(received.headers['x-idempotency-key'], undefined);
});

test('API failures show the server error message without JSON syntax', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: '仓库路径不存在' }), {
    status: 400, headers: { 'Content-Type': 'application/json' },
  }));
  await assert.rejects(api.createTask({}), { message: '仓库路径不存在' });
});

test('API failures preserve plain-text diagnostics and empty-body status', async (t) => {
  const responses = [new Response('Service temporarily unavailable', { status: 503 }), new Response(null, { status: 502 })];
  t.mock.method(globalThis, 'fetch', async () => responses.shift());
  await assert.rejects(api.tasks(), { message: 'Service temporarily unavailable' });
  await assert.rejects(api.tasks(), { message: '请求失败（502）' });
});

test('task reads can be aborted when a different task is selected', { timeout: 1000 }, async (t) => {
  t.mock.method(globalThis, 'fetch', (_path, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }));
  const controller = new AbortController();
  const pending = api.task('previous-task', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

for (const status of [200, 503]) {
  test(`a stalled ${status} response body preserves the readable request timeout`, { timeout: 3000 }, async (t) => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, 'timeout', () => nativeTimeout(150));
    const server = createServer((_req, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.flushHeaders(); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const nativeFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', (_path, init) => nativeFetch(`http://127.0.0.1:${server.address().port}`, init));
    await assert.rejects(api.tasks(), { message: '请求超时，请检查 Zero 服务后重试' });
  });
}

test('caller cancellation remains an AbortError during an error response body', { timeout: 3000 }, async (t) => {
  const controller = new AbortController();
  const server = createServer((_req, res) => {
    res.writeHead(503); res.flushHeaders();
    setTimeout(() => controller.abort(), 30);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (_path, init) => nativeFetch(`http://127.0.0.1:${server.address().port}`, init));
  await assert.rejects(api.tasks({ signal: controller.signal }), { name: 'AbortError' });
});

for (const kind of ['createTask', 'createSequence']) {
  test(`${kind} reuses submission identity after an uncertain failure and renews it after success`, async (t) => {
    const keys = [];
    let fail = true;
    t.mock.method(globalThis, 'fetch', async (_path, init) => {
      keys.push(init.headers['X-Idempotency-Key']);
      if (fail) { fail = false; throw new TypeError('connection closed after request was sent'); }
      return new Response(JSON.stringify({ id: 'saved-resource' }));
    });
    const payload = { prompt: `idempotent-${kind}`, repoPath: '/repo', checkCommands: ['test'] };
    await assert.rejects(api[kind](payload), /connection closed/);
    await api[kind]({ checkCommands: ['test'], repoPath: '/repo', prompt: `idempotent-${kind}` });
    assert.match(keys[0], /^[A-Za-z0-9_-]{16,128}$/);
    assert.equal(keys[1], keys[0], 'retrying the same JSON payload must not launch another agent');
    await api[kind](payload);
    assert.notEqual(keys[2], keys[1], 'a successful form can intentionally submit a new identical task');
  });
}

test('changed submission payloads and endpoints receive independent identities', async (t) => {
  const keys = [];
  t.mock.method(globalThis, 'fetch', async (_path, init) => { keys.push(init.headers['X-Idempotency-Key']); throw new TypeError('offline'); });
  await assert.rejects(api.createTask({ prompt: 'original' }));
  await assert.rejects(api.createTask({ prompt: 'changed' }));
  await assert.rejects(api.createSequence({ prompt: 'original' }));
  assert.equal(new Set(keys).size, 3);
});

test('uncertain submission identity survives reloading the client module in the same tab', async (t) => {
  const values = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else delete globalThis.sessionStorage; });
  const keys = [];
  t.mock.method(globalThis, 'fetch', async (_path, init) => { keys.push(init.headers['X-Idempotency-Key']); throw new TypeError('connection lost'); });
  await assert.rejects(api.createTask({ prompt: 'survive-reload' }));
  const reloaded = await import(`../src/api.ts?reload=${Date.now()}`);
  await assert.rejects(reloaded.api.createTask({ prompt: 'survive-reload' }));
  assert.equal(keys[1], keys[0]);
  assert.equal(values.size, 1);
  assert.ok(![...values.keys()].some(key => key.includes('survive-reload')), 'storage keys must not retain the prompt text');
});

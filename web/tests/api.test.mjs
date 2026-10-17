import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { api } from '../src/api.ts';

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

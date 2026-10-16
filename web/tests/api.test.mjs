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

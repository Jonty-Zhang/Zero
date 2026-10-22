import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createZeroServer, type AdapterMap, type TaskStorePort } from './server.js';
import type { LocalZeroConfig } from './config-store.js';
import type { HarnessAdapter, HarnessCapabilities } from '../domain/types.js';

const initialConfig = (): LocalZeroConfig => ({ models: [], bindings: [], allocator: { modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null }, verifications: {} });
const report = (available = true): HarnessCapabilities => ({ harness: 'codex', available, models: [], reasoningEfforts: [] });
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!predicate()) { if (performance.now() > deadline) throw new Error('HTTP probe barrier timed out'); await delay(5); }
  // Let handlers that just completed their config read reach their probe wait.
  await delay(10);
}
async function fixture(adapters?: AdapterMap) {
  let current = initialConfig();
  let reads = 0;
  let readFailure: Error | undefined;
  const probes: Array<{ resolve(value?: HarnessCapabilities): void; reject(error: Error): void }> = [];
  const adapter: HarnessAdapter = { id: 'codex',
    probe: () => new Promise<HarnessCapabilities>((resolve, reject) => probes.push({ resolve: value => resolve(value ?? report()), reject })),
    run: async () => { throw new Error('Tests must not execute providers'); },
  };
  const server = createZeroServer({ store: {} as TaskStorePort,
    config: { read: async () => { reads++; if (readFailure) { const error = readFailure; readFailure = undefined; throw error; } return structuredClone(current); }, write: async config => { current = structuredClone(config); } },
    adapters: adapters ?? { codex: adapter },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  return { base, probes, reads: () => reads, setConfig: (config: LocalZeroConfig) => { current = config; },
    failNextRead: () => { readFailure = new Error('config temporarily unreadable'); },
    get: (signal?: AbortSignal) => { const pending = fetch(`${base}/api/capabilities`, { signal }); void pending.catch(() => {}); return pending; },
    close: async () => { probes.forEach(probe => probe.resolve()); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test('concurrent capability HTTP requests share only their active probe and the next request probes again', async () => {
  const f = await fixture();
  try {
    const pending = [f.get(), f.get(), f.get()];
    await until(() => f.reads() === 3);
    assert.equal(f.probes.length, 1, 'one probe per adapter for the same in-flight config');
    f.probes[0]!.resolve();
    assert.deepEqual((await Promise.all(pending)).map(response => response.status), [200, 200, 200]);
    const next = f.get(); await until(() => f.probes.length === 2);
    f.probes[1]!.resolve(); assert.equal((await next).status, 200);
  } finally { await f.close(); }
});

test('overlapping HTTP refreshes share the probe of every configured adapter', async () => {
  const ids = ['codex', 'dsh', 'zcode'] as const;
  const calls = { codex: 0, dsh: 0, zcode: 0 };
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const adapters: AdapterMap = Object.fromEntries(ids.map(id => [id, { id,
    probe: async () => { calls[id]++; await gate; return { ...report(), harness: id }; },
    run: async () => { throw new Error('Tests must not execute providers'); },
  }]));
  const f = await fixture(adapters);
  try {
    const pending = [f.get(), f.get(), f.get()]; await until(() => f.reads() === 3);
    assert.deepEqual(calls, { codex: 1, dsh: 1, zcode: 1 });
    release(); assert.deepEqual((await Promise.all(pending)).map(response => response.status), [200, 200, 200]);
  } finally { release(); await f.close(); }
});

test('a failed configuration read does not poison the next capability request', async () => {
  const f = await fixture();
  try {
    f.failNextRead(); assert.equal((await f.get()).status, 500); assert.equal(f.probes.length, 0);
    const retry = f.get(); await until(() => f.probes.length === 1);
    f.probes[0]!.resolve(); assert.equal((await retry).status, 200);
  } finally { await f.close(); }
});

test('aborting one HTTP client does not start a duplicate probe for its replacement', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const first = f.get(controller.signal).catch(error => (error as Error).name);
    await until(() => f.probes.length === 1);
    controller.abort(); assert.equal(await first, 'AbortError');
    const replacement = f.get(); await until(() => f.reads() === 2);
    assert.equal(f.probes.length, 1, 'client disconnect must not evict active server probes');
    f.probes[0]!.resolve(); assert.equal((await replacement).status, 200);
  } finally { await f.close(); }
});

test('the complete config snapshot separates overlapping probes and old settlement cannot evict the new snapshot', async () => {
  const f = await fixture();
  try {
    const old = f.get(); await until(() => f.probes.length === 1);
    // A setting outside bindings still changes the snapshot identity.
    f.setConfig({ ...initialConfig(), secretRefs: { OPENAI_API_KEY: 'reference-new' } });
    const changed = f.get(); await until(() => f.probes.length === 2);
    f.probes[0]!.resolve(); assert.equal((await old).status, 200);
    const peer = f.get(); await until(() => f.reads() === 3);
    assert.equal(f.probes.length, 2, 'settling the old snapshot cannot clear the new in-flight request');
    f.probes[1]!.resolve(); assert.deepEqual((await Promise.all([changed, peer])).map(response => response.status), [200, 200]);
  } finally { await f.close(); }
});

test('an unavailable probe response is shared in flight but is retried rather than cached', async () => {
  const f = await fixture();
  try {
    const first = f.get(); const peer = f.get(); await until(() => f.reads() === 2);
    assert.equal(f.probes.length, 1);
    f.probes[0]!.reject(new Error('probe temporarily failed'));
    for (const response of await Promise.all([first, peer])) {
      assert.equal(response.status, 200);
      const body = await response.json() as { harnesses: Array<{ id: string; cliAvailable: boolean; reason?: string }> };
      assert.equal(body.harnesses.find(item => item.id === 'codex')!.cliAvailable, false);
    }
    const retry = f.get(); await until(() => f.probes.length === 2);
    f.probes[1]!.resolve();
    const recovered = await (await retry).json() as { harnesses: Array<{ id: string; cliAvailable: boolean }> };
    assert.equal(recovered.harnesses.find(item => item.id === 'codex')!.cliAvailable, true);
  } finally { await f.close(); }
});

test('two local servers never share a capability probe even with identical config', async () => {
  const first = await fixture(); const second = await fixture();
  try {
    const a = first.get(); const b = second.get();
    await until(() => first.probes.length === 1 && second.probes.length === 1);
    first.probes[0]!.resolve(report(false)); second.probes[0]!.resolve(report(true));
    const firstBody = await (await a).json() as { harnesses: Array<{ cliAvailable: boolean }> };
    const secondBody = await (await b).json() as { harnesses: Array<{ cliAvailable: boolean }> };
    assert.equal(firstBody.harnesses[0]!.cliAvailable, false);
    assert.equal(secondBody.harnesses[0]!.cliAvailable, true);
  } finally { await first.close(); await second.close(); }
});

test('config-save validation performs a fresh capability probe while the UI request is in flight', async () => {
  const f = await fixture();
  try {
    const ui = f.get(); await until(() => f.probes.length === 1);
    const save = fetch(`${f.base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ allocator: { modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null } }) });
    await until(() => f.probes.length === 2);
    f.probes[1]!.resolve(); assert.equal((await save).status, 200);
    f.probes[0]!.resolve(); assert.equal((await ui).status, 200);
  } finally { await f.close(); }
});

const verifiedConfig = (): LocalZeroConfig => ({ ...initialConfig(),
  models: [{ id: 'model', provider: 'openai', modelId: 'model' }],
  bindings: [{ harness: 'codex', model: { id: 'model', provider: 'openai', modelId: 'model' }, selector: 'cli_argument', verified: true }],
  verifications: { 'codex:model': { verifiedAt: '2026-10-22T00:00:00Z', cliVersion: 'test', requestedModel: 'model', exitCode: 0, level: 'event_confirmed', reasoningEfforts: [] } },
});
test('task and sequence submission reject fresh unavailability despite an overlapping available UI probe', async () => {
  for (const endpoint of ['tasks', 'sequences']) {
    const f = await fixture();
    try {
      f.setConfig(verifiedConfig());
      const ui = f.get(); await until(() => f.probes.length === 1);
      const task = { repoPath: process.cwd(), prompt: 'Validate fresh adapter availability', execution: { harnessId: 'codex', modelId: 'model' } };
      const submission = fetch(`${f.base}/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(endpoint === 'tasks' ? task : { tasks: [task, task] }) });
      await until(() => f.probes.length === 2);
      f.probes[1]!.resolve(report(false)); assert.equal((await submission).status, 400);
      f.probes[0]!.resolve({ ...report(), models: ['model'] });
      const snapshot = await (await ui).json() as { bindings: Array<{ available: boolean }> };
      assert.equal(snapshot.bindings[0]!.available, true);
    } finally { await f.close(); }
  }
});

test('config-save candidate validation rejects fresh unavailability instead of trusting the UI probe', async () => {
  const f = await fixture();
  try {
    f.setConfig(verifiedConfig());
    const ui = f.get(); await until(() => f.probes.length === 1);
    const save = fetch(`${f.base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ allocator: { modelId: 'model', reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null } }) });
    await until(() => f.probes.length === 2);
    f.probes[1]!.resolve(report(false)); assert.equal((await save).status, 400);
    f.probes[0]!.resolve({ ...report(), models: ['model'] }); assert.equal((await ui).status, 200);
    const saved = await (await fetch(`${f.base}/api/config`)).json() as { allocator: { modelId: string | null } };
    assert.equal(saved.allocator.modelId, null);
  } finally { await f.close(); }
});

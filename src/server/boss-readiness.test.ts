import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../core/task-store.js';
import type { HarnessAdapter, HarnessCapabilities } from '../domain/types.js';
import type { LocalZeroConfig } from './config-store.js';
import { createZeroServer } from './server.js';

type Mode = 'ready' | 'dsh-only' | 'missing-proof' | 'missing-model' | 'cli-unavailable' | 'probe-failure';
const lead = { id: 'lead', provider: 'openai', modelId: 'offline-lead' };
const worker = { id: 'worker', provider: 'deepseek', modelId: 'offline-worker' };
const proof = (requestedModel: string): LocalZeroConfig['verifications'][string] => ({
  requestedModel, cliVersion: 'fixture-1', verifiedAt: '2026-10-26T00:00:00Z', exitCode: 0,
  level: 'selector_only', reasoningEfforts: [],
});

async function fixture(mode: Mode) {
  const root = await mkdtemp(join(tmpdir(), 'zero-boss-ready-'));
  const project = join(root, 'project'); await mkdir(project); await writeFile(join(project, 'source.txt'), 'Original source.');
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  let probes = 0;
  const enqueue: string[] = [];
  const codex: HarnessAdapter = {
    id: 'codex',
    async probe(): Promise<HarnessCapabilities> {
      probes++;
      if (mode === 'probe-failure') throw new Error('Offline Codex probe failed');
      return { harness: 'codex', available: mode !== 'cli-unavailable', models: mode === 'missing-model' ? [] : [lead.id],
        reasoningEfforts: [], ...(mode === 'cli-unavailable' ? { unavailableReason: 'Offline CLI unavailable' } : {}) };
    },
    async run() { throw new Error('Readiness tests must never run a model'); },
  };
  const config = {
    async read(): Promise<LocalZeroConfig> {
      return { models: [lead, worker], allocator: { modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null },
        bindings: [
          ...(mode === 'dsh-only' ? [] : [{ harness: 'codex' as const, model: lead, selector: 'cli_argument' as const, verified: true as const, reasoningEfforts: [] }]),
          { harness: 'dsh', model: worker, selector: 'profile', profile: 'offline', verified: true, reasoningEfforts: [] },
        ], verifications: { 'dsh:worker': proof(worker.modelId), ...(mode === 'missing-proof' ? {} : { 'codex:lead': proof(lead.modelId) }) } };
    }, async write() {},
  };
  const server = createZeroServer({ store, config, adapters: { codex, dsh: {
    id: 'dsh', async probe() { return { harness: 'dsh', available: true, models: [worker.id] }; },
    async run() { throw new Error('Readiness tests must never run a model'); },
  } }, enqueue(id) { enqueue.push(id); } });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const payload = { repoPath: project, prompt: '目标', boss: { preference: 'Codex 模型名称可能写得不准确，负责设计并验收，DSH 实现' } };
  const post = (path = '/api/tasks', body: unknown = payload, key = 'boss-readiness-request-123') => fetch(url + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': key }, body: JSON.stringify(body),
  });
  return { project, payload, store, enqueue, post, get probes() { return probes; }, setMode(next: Mode) { mode = next; },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); },
  };
}

for (const mode of ['dsh-only', 'missing-proof', 'missing-model', 'cli-unavailable', 'probe-failure'] as const) {
  test(`Boss admission rejects ${mode} before folder preparation and accepts the same request after recovery`, async () => {
    const f = await fixture(mode);
    try {
      const rejected = await f.post();
      assert.equal(rejected.status, 503, await rejected.text());
      await assert.rejects(lstat(join(f.project, '.git')), { code: 'ENOENT' });
      assert.equal(await readFile(join(f.project, 'source.txt'), 'utf8'), 'Original source.');
      assert.equal(f.store.list().length, 0); assert.deepEqual(f.enqueue, []);
      f.setMode('ready');
      const accepted = await f.post();
      assert.equal(accepted.status, 201, await accepted.text());
      const task = f.store.list()[0]!;
      assert.equal(task.prompt, f.payload.prompt); assert.deepEqual(task.boss, f.payload.boss);
      assert.equal(f.store.list().length, 1); assert.deepEqual(f.enqueue, [task.id]);
      f.setMode(mode);
      const probes = f.probes;
      const replay = await f.post();
      assert.equal(replay.status, 201); assert.equal((await replay.json() as { id: string }).id, task.id);
      assert.equal(f.probes, probes, 'accepted idempotent replay must not depend on current provider availability');
      assert.equal(f.store.list().length, 1); assert.deepEqual(f.enqueue, [task.id]);
    } finally { await f.close(); }
  });
}

test('Boss sequence admission also rejects an unavailable lead before preparing any project', async () => {
  const f = await fixture('dsh-only');
  try {
    const response = await f.post('/api/sequences', { tasks: [f.payload, { ...f.payload, prompt: '第二步' }] });
    assert.equal(response.status, 503, await response.text());
    await assert.rejects(lstat(join(f.project, '.git')), { code: 'ENOENT' });
    assert.equal(f.store.list().length, 0); assert.equal(f.store.listSequences().length, 0); assert.deepEqual(f.enqueue, []);
  } finally { await f.close(); }
});

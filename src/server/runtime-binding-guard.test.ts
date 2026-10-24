import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createPortReservation } from 'node:net';
import { ConfigStore, type LocalZeroConfig } from './config-store.js';
import { createDefaultAdapters, createZeroServer, type AdapterMap, type ConfigPort } from './server.js';
import { TaskStore } from '../core/task-store.js';
import { CodexAdapter } from '../adapters/codex.js';
import { DshAdapter } from '../adapters/dsh.js';
import { ZCodeCompositeAdapter } from '../adapters/zcode-composite.js';
import { ZCodeAdapter } from '../adapters/zcode.js';
import { ZCodeAppServerAdapter } from '../adapters/zcode-app-server-adapter.js';
import type { ModelBinding, ModelConfig, RunContext } from '../adapters/types.js';
import type { HarnessCapabilities, RunRequest } from '../domain/types.js';

const root = await mkdtemp(join(tmpdir(), 'zero-runtime-binding-guard-'));
const previousDataDir = process.env.ZERO_DATA_DIR;
process.env.ZERO_DATA_DIR = root;
const { startZeroServer } = await import('./main.js');
const originals = { spawn: childProcess.spawn, spawnSync: childProcess.spawnSync, exec: childProcess.exec, execFile: childProcess.execFile };
const denyProcess = () => { throw new Error('Runtime binding tests cannot start any process'); };
childProcess.spawn = denyProcess;
childProcess.spawnSync = denyProcess;
childProcess.exec = denyProcess as unknown as typeof childProcess.exec;
childProcess.execFile = denyProcess as unknown as typeof childProcess.execFile;
syncBuiltinESMExports();
const oldModel: ModelConfig = { id: 'shared-local', provider: 'account:first', modelId: 'upstream-first' };
const replacement: ModelConfig = { ...oldModel, provider: 'account:second', modelId: 'upstream-second' };
const otherModel: ModelConfig = { id: 'other-local', provider: 'account:other', modelId: 'upstream-other' };
const codex = (model: ModelConfig): ModelBinding => ({ harness: 'codex', model, selector: 'cli_argument', verified: true, verifiedCliVersion: 'fixture-1', reasoningEfforts: ['high'] });
const proof = (model: ModelConfig): LocalZeroConfig['verifications'][string] => ({ verifiedAt: '2026-10-24T00:00:00.000Z', cliVersion: 'fixture-1', requestedModel: model.modelId, exitCode: 0, level: 'selector_only', reasoningEfforts: ['high'] });
// Exercise the desired structural port against both the old and fixed factory.
const runtimeFactory = createDefaultAdapters as (bindings: ModelBinding[], config: Pick<ConfigStore, 'read'>) => AdapterMap;
const request = (harness = 'codex', model = oldModel.id, role: RunRequest['role'] = 'implement'): RunRequest => ({ taskId: 'task', attemptId: `attempt-${role}`, harness, model, role, cwd: root, prompt: 'fixture', reasoningEffort: 'high' });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
async function seed(bindings: ModelBinding[] = [codex(oldModel), codex(otherModel)]) {
  const config: LocalZeroConfig = { models: bindings.map(binding => binding.model), bindings,
    verifications: Object.fromEntries(bindings.map(binding => [`${binding.harness}:${binding.model.id}`, proof(binding.model)])),
    allocator: { modelId: oldModel.id, reasoningEffort: 'high' }, reviewer: { modelId: oldModel.id, reasoningEffort: 'high' } };
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify(config));
  return { config, store: new ConfigStore(path), save: (value: LocalZeroConfig) => writeFile(path, JSON.stringify(value)) };
}
function probes(t: TestContext) {
  for (const prototype of [CodexAdapter.prototype, DshAdapter.prototype, ZCodeCompositeAdapter.prototype]) {
    t.mock.method(prototype, 'probe', async function (this: { id: string; bindings: ModelBinding[] }): Promise<HarnessCapabilities> {
      return { harness: this.id, available: true, version: 'fixture-1', models: this.bindings.filter(binding => binding.harness === this.id).map(binding => binding.model.id), reasoningEfforts: ['high'], roles: ['route', 'review', 'implement', 'revise'] };
    });
  }
  const prepared: Array<{ model: ModelConfig; args: string[] }> = [];
  const prepare = CodexAdapter.prototype.prepare;
  t.mock.method(CodexAdapter.prototype, 'prepare', async function (this: CodexAdapter, context: RunContext, binding: ModelBinding) {
    const invocation = await prepare.call(this, context, binding);
    prepared.push({ model: binding.model, args: invocation.args });
    throw new Error('STOP_BEFORE_PROCESS');
  });
  return prepared;
}
async function httpFixture(adapters: AdapterMap, config: ConfigPort) {
  const store = new TaskStore(join(root, `http-${crypto.randomUUID()}.sqlite`));
  const server = createZeroServer({ store, config, adapters });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { async capabilities() { const response = await fetch(`http://127.0.0.1:${address.port}/api/capabilities`); assert.equal(response.status, 200); return response.json(); },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); } };
}

test('same-ID replacement disappears from HTTP choices and cannot reach old Codex prepare in any role', async t => {
  const prepared = probes(t); const f = await seed();
  const adapters = runtimeFactory(f.config.bindings, f.store);
  const http = await httpFixture(adapters, f.store);
  try {
    assert.equal((await http.capabilities()).bindings.find((b: { modelId: string }) => b.modelId === oldModel.id).available, true);
    await f.save({ ...f.config, models: [replacement, otherModel] });
    await f.store.markVerified('codex', replacement.id, proof(replacement), replacement);
    const caps = await http.capabilities();
    const changed = caps.bindings.find((b: { modelId: string }) => b.modelId === replacement.id);
    assert.equal(changed.available, false); assert.match(changed.reason, /重启 Zero/);
    assert.equal(caps.allocator.models.some((model: { id: string }) => model.id === oldModel.id), false);
    assert.equal(caps.reviewer.models.some((model: { id: string }) => model.id === oldModel.id), false);
    for (const role of ['route', 'review', 'implement', 'revise'] as const) {
      const result = await adapters.codex!.run(request('codex', oldModel.id, role));
      assert.equal(result.status, 'failed'); assert.match(result.error!, /重启 Zero/);
    }
    assert.equal(prepared.length, 0);
    const unchanged = await adapters.codex!.run(request('codex', otherModel.id));
    assert.equal(unchanged.error, 'STOP_BEFORE_PROCESS'); assert.equal(prepared[0]!.model.id, otherModel.id);
  } finally { await http.close(); }
});

test('preferences, registry order and JSON property order do not invalidate unchanged runtime bindings', async t => {
  const prepared = probes(t); const f = await seed(); const adapters = runtimeFactory(f.config.bindings, f.store);
  await f.save({ ...f.config, models: [...f.config.models].reverse(), bindings: [...f.config.bindings].reverse().map(binding => ({ ...binding, model: { modelId: binding.model.modelId, provider: binding.model.provider, id: binding.model.id } })),
    allocator: { modelId: otherModel.id, reasoningEffort: 'high' }, reviewer: { modelId: otherModel.id, reasoningEffort: 'high' }, executionDefaults: { global: { model: otherModel.id }, projects: {} } });
  assert.deepEqual((await adapters.codex!.probe()).models.sort(), [oldModel.id, otherModel.id].sort());
  assert.equal((await adapters.codex!.run(request())).error, 'STOP_BEFORE_PROCESS');
  assert.ok(prepared[0]!.args.includes(oldModel.modelId));
});

test('HTTP cannot combine replacement labels with a probe of a different binding snapshot', async t => {
  const prepared = probes(t); const f = await seed(); const adapters = runtimeFactory(f.config.bindings, f.store);
  const differentSnapshot = { ...f.config, models: [replacement], bindings: [codex(replacement)], verifications: { [`codex:${replacement.id}`]: proof(replacement) } };
  const http = await httpFixture(adapters, { read: async () => structuredClone(differentSnapshot), write: async () => { throw new Error('Read-only fixture'); } });
  try {
    assert.equal((await adapters.codex!.probe()).models.includes(oldModel.id), true);
    const caps = await http.capabilities();
    assert.equal(caps.bindings[0].modelName, replacement.modelId);
    assert.equal(caps.bindings[0].available, false);
    assert.match(caps.bindings[0].reason, /重启 Zero/);
    assert.deepEqual(caps.allocator.models, []);
    assert.equal((await adapters.codex!.run(request())).error, 'STOP_BEFORE_PROCESS');
    assert.equal(prepared[0]!.model.modelId, oldModel.modelId);
  } finally { await http.close(); }
});

test('a fresh factory captures a replacement binding while the running factory rejects it', async t => {
  const prepared = probes(t); const f = await seed(); const stale = runtimeFactory(f.config.bindings, f.store);
  const next = { ...f.config, models: [replacement], bindings: [codex(replacement)], verifications: { [`codex:${replacement.id}`]: proof(replacement) } };
  await f.save(next);
  assert.match((await stale.codex!.run(request())).error!, /重启 Zero/);
  const fresh = runtimeFactory(next.bindings, f.store);
  assert.equal((await fresh.codex!.run(request())).error, 'STOP_BEFORE_PROCESS');
  assert.deepEqual(prepared.map(item => item.model), [replacement]);
});

test('missing proof, changed registry tuple and duplicate current bindings cannot use a captured selector', async t => {
  const prepared = probes(t);
  for (const change of [
    (config: LocalZeroConfig) => ({ ...config, verifications: {} }),
    (config: LocalZeroConfig) => ({ ...config, models: [replacement, otherModel] }),
    (config: LocalZeroConfig) => ({ ...config, bindings: [...config.bindings, codex(replacement)] }),
    (config: LocalZeroConfig) => ({ ...config, bindings: config.bindings.map(binding => binding.model.id === oldModel.id ? { ...binding, verifiedCliVersion: 'fixture-2' } : binding) }),
    (config: LocalZeroConfig) => ({ ...config, bindings: config.bindings.map(binding => binding.model.id === oldModel.id ? { ...binding, reasoningEfforts: ['low' as const] } : binding) }),
  ]) {
    const f = await seed(); const adapters = runtimeFactory(f.config.bindings, f.store); await f.save(change(f.config));
    assert.equal((await adapters.codex!.probe()).models.includes(oldModel.id), false);
    assert.match((await adapters.codex!.run(request())).error!, /重启 Zero/);
  }
  assert.deepEqual(prepared, []);
});

test('changed DSH profile and both ZCode selectors fail before their captured adapters run', async t => {
  probes(t); let runs = 0;
  for (const prototype of [DshAdapter.prototype, ZCodeAdapter.prototype, ZCodeAppServerAdapter.prototype]) t.mock.method(prototype, 'run', async () => { runs++; return { status: 'completed', exitCode: 0, durationMs: 0 }; });
  const bindings: ModelBinding[] = [
    { harness: 'dsh', model: oldModel, selector: 'profile', profile: 'first', verified: true, verifiedCliVersion: 'fixture-1', reasoningEfforts: [] },
    { harness: 'zcode', model: oldModel, selector: 'isolated_config', configDir: join(root, 'first-config'), mode: 'build', verified: true, verifiedCliVersion: 'fixture-1', reasoningEfforts: [] },
    { harness: 'zcode', model: oldModel, selector: 'app_server_existing_desktop', verified: true, verifiedCliVersion: 'fixture-1', verificationSource: 'smoke_test', reasoningEfforts: ['high'],
      verificationEvidence: { kind: 'selector_only', verifiedAt: '2026-10-24T00:00:00.000Z', providerId: oldModel.provider, modelId: oldModel.modelId, cliVersion: 'fixture-1', reasoningEffort: 'high' } },
  ];
  for (const binding of bindings) {
    const f = await seed([binding]); const adapters = runtimeFactory(f.config.bindings, f.store);
    const changed = binding.selector === 'profile' ? { ...binding, profile: 'second' } : binding.selector === 'isolated_config' ? { ...binding, mode: 'yolo' } : { ...binding, model: replacement };
    await f.save({ ...f.config, models: [changed.model], bindings: [changed] });
    assert.match((await adapters[binding.harness]!.run(request(binding.harness))).error!, /重启 Zero/);
  }
  assert.equal(runs, 0);
});

test('cancellation while waiting for the fresh config read prevents any later prepare', async t => {
  const prepared = probes(t); const f = await seed(); const entered = deferred(); const release = deferred();
  const adapters = runtimeFactory(f.config.bindings, { async read() { entered.resolve(); await release.promise; return f.store.read(); } });
  const run = adapters.codex!.run(request());
  try {
    const phase = await Promise.race([entered.promise.then(() => 'reading'), run.then(() => 'finished')]);
    assert.equal(phase, 'reading');
    await adapters.codex!.cancel!('task', 'attempt-implement'); release.resolve();
    assert.equal((await run).status, 'cancelled'); assert.deepEqual(prepared, []);
  } finally { release.resolve(); await run; }
});

test('the production startZeroServer wiring blocks a same-ID replacement until restart', async t => {
  const prepared = probes(t); const f = await seed();
  const reservation = createPortReservation(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const runtime = await startZeroServer({ port: address.port });
  try {
    const next = { ...f.config, models: [replacement], bindings: [codex(replacement)], verifications: { [`codex:${replacement.id}`]: proof(replacement) } };
    await f.save(next);
    const response = await fetch(`${runtime.url}/api/capabilities`); assert.equal(response.status, 200);
    const caps = await response.json(); const changed = caps.bindings.find((b: { modelId: string }) => b.modelId === replacement.id);
    assert.equal(changed.available, false); assert.match(changed.reason, /重启 Zero/);
    assert.deepEqual(prepared, []);
  } finally { runtime.server.closeAllConnections(); await runtime.close(); }
});

test.after(async () => {
  Object.assign(childProcess, originals); syncBuiltinESMExports();
  if (previousDataDir === undefined) delete process.env.ZERO_DATA_DIR;
  else process.env.ZERO_DATA_DIR = previousDataDir;
  await rm(root, { recursive: true, force: true });
});

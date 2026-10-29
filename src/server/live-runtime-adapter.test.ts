import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelBinding, ModelConfig } from '../adapters/types.js';
import type { HarnessAdapter, RunRequest, RunResult } from '../domain/types.js';
import type { LocalZeroConfig } from './config-store.js';
import { LiveRuntimeAdapter } from './live-runtime-adapter.js';
import { activateVerifiedCodexBinding } from './main.js';
import type { ConfigStore } from './config-store.js';

const model = (id: string): ModelConfig => ({ id, provider: 'openai', modelId: id });
const binding = (id: string): ModelBinding => ({ harness: 'codex', selector: 'cli_argument', model: model(id), verified: true, reasoningEfforts: ['high'], verifiedCliVersion: 'fixture' });
const config = (bindings: ModelBinding[] = []): LocalZeroConfig => ({ models: bindings.map(item => item.model), bindings,
  allocator: { modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null },
  verifications: Object.fromEntries(bindings.map(item => [`codex:${item.model.id}`, { verifiedAt: new Date().toISOString(), cliVersion: 'fixture', requestedModel: item.model.modelId, exitCode: 0 as const, level: 'selector_only' as const, reasoningEfforts: ['high'] }])) });
const request = (id: string, attemptId = 'attempt'): RunRequest => ({ taskId: 'task', attemptId, model: id, harness: 'codex', role: 'implement', cwd: '.', prompt: 'fixture', reasoningEffort: 'high' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(initial = config()) {
  let current = initial;
  const executions: Array<{ captured: ModelBinding[]; request: RunRequest }> = [];
  const cancellations: string[] = [];
  let pending: ReturnType<typeof deferred<RunResult>> | undefined;
  let readGate: ReturnType<typeof deferred<void>> | undefined;
  const adapter = new LiveRuntimeAdapter({ id: 'codex', startupBindings: initial.bindings,
    async readConfig() { await readGate?.promise; return current; },
    createDelegate(bindings): HarnessAdapter { return { id: 'codex',
      async probe() { return { harness: 'codex', available: true, version: 'fixture', models: bindings.map(item => item.model.id) }; },
      async run(runRequest) { executions.push({ captured: bindings, request: runRequest }); return pending ? pending.promise : { status: 'completed', exitCode: 0, durationMs: 1 }; },
      async cancel(taskId, attemptId) { cancellations.push(`${taskId}:${attemptId}:${bindings.map(item => item.model.id).join(',')}`); pending?.resolve({ status: 'cancelled', exitCode: null, durationMs: 1 }); },
    }; },
  });
  return { adapter, executions, cancellations, get current() { return current; }, set(value: LocalZeroConfig) { current = value; }, blockRun() { pending = deferred<RunResult>(); }, blockRead() { readGate = deferred<void>(); return readGate; } };
}

test('a verified model becomes usable in the same facade only after explicit activation', async () => {
  const f = fixture(); assert.deepEqual((await f.adapter.probe()).models, []);
  f.set(config([binding('new')]));
  assert.deepEqual((await f.adapter.probe()).models, [], 'external config edits do not activate');
  assert.equal((await f.adapter.run(request('new'))).status, 'failed');
  await f.adapter.activate(binding('new'), f.current);
  assert.deepEqual((await f.adapter.probe()).models, ['new']);
  assert.equal((await f.adapter.run(request('new'))).status, 'completed');
});
test('activation keeps an in-flight attempt and its cancellation on the original delegate', async () => {
  const f = fixture(config([binding('old')])); f.blockRun();
  const run = f.adapter.run(request('old'));
  await new Promise<void>(resolve => setImmediate(resolve));
  f.set(config([binding('old'), binding('new')])); await f.adapter.activate(binding('new'), f.current);
  assert.deepEqual((await f.adapter.probe()).models, ['old', 'new']);
  await f.adapter.cancel('task', 'attempt'); assert.equal((await run).status, 'cancelled');
  assert.deepEqual(f.executions[0]!.captured.map(item => item.model.id), ['old']);
  assert.deepEqual(f.cancellations, ['task:attempt:old']);
});
test('duplicate attempt cannot replace cancellation custody', async () => {
  const f = fixture(config([binding('old')])); f.blockRun(); const run = f.adapter.run(request('old'));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await f.adapter.run(request('old'))).status, 'failed');
  await f.adapter.cancel('task', 'attempt'); await run; assert.equal(f.executions.length, 1);
});
test('cancellation during configuration preparation prevents any provider run', async () => {
  const f = fixture(config([binding('old')])); const gate = f.blockRead();
  const run = f.adapter.run(request('old')); await f.adapter.cancel('task', 'attempt'); gate.resolve();
  assert.equal((await run).status, 'cancelled'); assert.equal(f.executions.length, 0);
});
test('revocation still removes an approved model from probe and execution', async () => {
  const f = fixture(config([binding('old')])); f.set(config());
  assert.deepEqual((await f.adapter.probe()).models, []);
  assert.equal((await f.adapter.run(request('old'))).status, 'failed'); assert.equal(f.executions.length, 0);
});
test('neither missing proof nor a stale snapshot can activate a selector', async () => {
  const f = fixture(); const intended = config([binding('new')]); f.set({ ...intended, verifications: {} });
  await assert.rejects(f.adapter.activate(binding('new'), intended));
  f.set(intended); await assert.rejects(f.adapter.activate(binding('new'), { ...intended, verifications: {} }));
  assert.deepEqual((await f.adapter.probe()).models, []);
});
test('a reused local ID cannot silently change the provider model even with fresh proof', async () => {
  const f = fixture(config([binding('old')])); const changed = { ...binding('old'), model: { ...model('old'), modelId: 'other' } } as ModelBinding;
  const next = config([changed]); f.set(next);
  await assert.rejects(f.adapter.activate(changed, next));
  assert.equal((await f.adapter.run(request('old'))).status, 'failed'); assert.equal(f.executions.length, 0);
});
test('newly verified efforts of the same identity activate without losing earlier selectors', async () => {
  const f = fixture(config([binding('old')]));
  const extended = { ...binding('old'), reasoningEfforts: ['high', 'low'] } as ModelBinding;
  const next = config([extended]); next.verifications['codex:old']!.reasoningEfforts = ['high', 'low']; f.set(next);
  assert.deepEqual((await f.adapter.probe()).models, [], 'unapproved effort changes remain gated');
  await f.adapter.activate(extended, next);
  assert.equal((await f.adapter.run({ ...request('old'), reasoningEffort: 'low' })).status, 'completed');
  assert.deepEqual(f.executions[0]!.captured[0]!.reasoningEfforts, ['high', 'low']);
});
test('duplicate registry identity cannot be approved or replace earlier cancellation custody', async () => {
  const f = fixture(); const next = config([binding('new'), binding('new')]); f.set(next);
  await assert.rejects(f.adapter.activate(binding('new'), next));
  assert.deepEqual((await f.adapter.probe()).models, []);
  assert.equal((await f.adapter.run(request('new'))).status, 'failed'); assert.equal(f.executions.length, 0);
});
test('activation captures input values before asynchronous inspection', async () => {
  const f = fixture(); const candidate = binding('new'); const next = config([structuredClone(candidate)]); f.set(next);
  const snapshot = structuredClone(next);
  const activation = f.adapter.activate(candidate, snapshot);
  candidate.model.modelId = 'caller-mutated'; snapshot.verifications = {};
  await activation;
  assert.equal((await f.adapter.run(request('new'))).status, 'completed');
  assert.equal(f.executions[0]!.captured[0]!.model.modelId, 'new');
});

test('a proof replaced while activation probe is waiting never commits an approved model', async () => {
  const candidate=binding('new'); const current=config([candidate]);
  const receipt={binding:structuredClone(candidate),verification:structuredClone(current.verifications['codex:new']!)};
  const entered=deferred<void>(); const release=deferred<void>(); let gated=true;
  const adapter=new LiveRuntimeAdapter({id:'codex',startupBindings:[],readConfig:async()=>structuredClone(current),
    createDelegate:bindings=>({id:'codex',async probe(){if(gated){gated=false;entered.resolve();await release.promise;}return {harness:'codex',available:true,models:bindings.map(item=>item.model.id)};},
      async run(){return {status:'completed',exitCode:0,durationMs:1};}})});
  const store={read:async()=>structuredClone(current)} as ConfigStore;
  const activation=activateVerifiedCodexBinding(adapter,store,receipt);
  await entered.promise;
  current.verifications['codex:new']!.verifiedAt='2030-01-01T00:00:00.000Z';
  release.resolve();
  await assert.rejects(activation,/proof|binding|configuration/i);
  assert.deepEqual((await adapter.probe()).models,[],'failed activation cannot leave a usable selector');
  assert.equal((await adapter.run(request('new'))).status,'failed');
});

test('revoking the exact activated effort evidence removes the model before any provider execution', async () => {
  const candidate=binding('new');const current=config([candidate]);
  current.verifications['codex:new']!.effortEvidence={high:{verifiedAt:'2026-10-29T01:00:00.000Z',cliVersion:'fixture',exitCode:0}};
  const f=fixture();f.set(current);
  const store={read:async()=>structuredClone(f.current)} as ConfigStore;
  await activateVerifiedCodexBinding(f.adapter,store,{binding:structuredClone(candidate),verification:structuredClone(current.verifications['codex:new']!)});
  assert.deepEqual((await f.adapter.probe()).models,['new']);
  delete current.verifications['codex:new']!.effortEvidence;
  assert.deepEqual((await f.adapter.probe()).models,[]);
  assert.equal((await f.adapter.run(request('new'))).status,'failed');
  assert.equal(f.executions.length,0);
});

test('a newly verified effort replaces its earlier receipt authorization without inheriting the old predicate', async () => {
  const first=binding('new');const initial=config([first]);const f=fixture();f.set(initial);
  const store={read:async()=>structuredClone(f.current)} as ConfigStore;
  await activateVerifiedCodexBinding(f.adapter,store,{binding:structuredClone(first),verification:structuredClone(initial.verifications['codex:new']!)});
  const extended={...binding('new'),reasoningEfforts:['high','low']} as ModelBinding;
  const next=config([extended]);next.verifications['codex:new']!.reasoningEfforts=['high','low'];
  next.verifications['codex:new']!.effortEvidence={low:{verifiedAt:'2026-10-29T01:00:00.000Z',cliVersion:'fixture',exitCode:0}};f.set(next);
  await activateVerifiedCodexBinding(f.adapter,store,{binding:structuredClone(extended),verification:structuredClone(next.verifications['codex:new']!)});
  assert.deepEqual((await f.adapter.probe()).models,['new']);
  assert.equal((await f.adapter.run({...request('new'),reasoningEffort:'low'})).status,'completed');
});

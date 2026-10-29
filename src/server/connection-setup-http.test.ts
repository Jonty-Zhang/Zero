import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigStore } from './config-store.js';
import { ConnectionSetupService, type VerificationJob } from './connection-setup.js';
import { LiveRuntimeAdapter } from './live-runtime-adapter.js';
import { createZeroServer } from './server.js';
import { activateVerifiedCodexBinding, runBindingVerification } from './main.js';
import { TaskStore } from '../core/task-store.js';
import { GitWorktreeManager } from '../core/git-worktree.js';
import { TestRunner } from '../core/test-runner.js';
import { prepareProjectFolder } from './project-folders.js';
import { BossOrchestrator } from '../orchestrator/boss.js';
import { TaskReviewer } from '../orchestrator/reviewer.js';
import { TaskWorker } from '../orchestrator/worker.js';
import type { ModelBinding, ModelConfig } from '../adapters/types.js';
import type { HarnessAdapter, RunResult } from '../domain/types.js';

const complete = (final: string, actualModel?: string): RunResult => ({ status: 'completed', exitCode: 0, durationMs: 1, final, actualModel });
async function fixture(options: { models?: ModelConfig[]; wrongActual?: boolean; held?: boolean; replaceAfterVerification?: 'proof' | 'tuple' } = {}) {
  const parent = resolve('data/verification/boss-workflow-round21/http-fixtures'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'connections-')); assert.ok(root.startsWith(parent + sep));
  const path = join(root, 'config.json'); await writeFile(path, JSON.stringify({ models: options.models ?? [], bindings: [] }));
  const config = new ConfigStore(path); const store = new TaskStore(join(root, 'tasks.sqlite'));
  const calls = { verification: 0, selection: 0, planning: 0, writer: 0, reviewer: 0 };
  let release!: () => void; const gate = new Promise<void>(done => { release = done; });
  const raw = (bindings: ModelBinding[], verification = false): HarnessAdapter => ({ id: 'codex',
    async probe() { return { harness: 'codex', available: true, version: 'fixture-cli', models: bindings.map(binding => binding.model.id), reasoningEfforts: ['high', 'low'], roles: ['route', 'review', 'implement', 'revise'] }; },
    async run(request) {
      const selected = bindings.find(binding => binding.model.id === request.model); assert.ok(selected);
      if (verification) {
        calls.verification++; if (options.held) await gate;
        const nonce = request.prompt.match(/ZERO_BINDING_VERIFIED_[A-Za-z0-9-]+/)?.[0]; assert.ok(nonce);
        return complete(nonce, options.wrongActual ? 'SECRET-unexpected-model' : selected.model.modelId);
      }
      if (request.role === 'review') { calls.reviewer++; assert.equal(await readFile(join(request.cwd, 'review-context/project/result.txt'), 'utf8'), 'approved'); return complete(JSON.stringify({ verdict: 'pass', summary: 'The exact artifact and real check satisfy the objective', findings: [] })); }
      if (request.outputSchemaPath) {
        const schema = JSON.parse(await readFile(request.outputSchemaPath, 'utf8'));
        if (schema.properties.bindingId) { calls.selection++; return complete(JSON.stringify({ bindingId: `codex:${request.model}`, reasoningEffort: 'high', reason: 'Use the newly verified project lead' })); }
        if (schema.properties.action) { calls.planning++; return complete(JSON.stringify({ action: 'plan', summary: 'Create and verify the requested artifact', consultantBindingId: null, consultantEffort: null, question: null,
          acceptanceCriteria: ['result.txt contains approved'], maxRevisions: 0,
          stages: [{ bindingId: `codex:${request.model}`, reasoningEffort: 'high', objective: 'Create result.txt containing approved' }],
          checks: [{ id: 'artifact', argv: [process.execPath, '-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt','utf8'),'approved')"] }] })); }
      }
      assert.equal(request.role, 'implement'); calls.writer++; await writeFile(join(request.cwd, 'result.txt'), 'approved'); return complete('Created the requested artifact');
    },
  });
  const live = new LiveRuntimeAdapter({ id: 'codex', startupBindings: [], readConfig: () => config.read(), createDelegate: bindings => raw(bindings) });
  const connections = new ConnectionSetupService({ config, path: join(root, 'connections.sqlite'), codex: live,
    async verify(model, effort) {
      const receipt = await runBindingVerification(model.id, effort, { config, dataDir: root, expectedModel: model, createAdapter: bindings => raw(bindings, true) });
      if (options.replaceAfterVerification) {
        const changed = await config.read(); const proof = changed.verifications[`codex:${model.id}`]!;
        if (options.replaceAfterVerification === 'proof') {
          proof.verifiedAt = '2030-01-01T00:00:00.000Z';
          if (proof.effortEvidence?.high) proof.effortEvidence.high.verifiedAt = proof.verifiedAt;
        } else {
          changed.models.find(item => item.id === model.id)!.modelId = 'unverified-replacement';
          changed.bindings.find(binding => binding.model.id === model.id)!.model.modelId = 'unverified-replacement';
          proof.requestedModel = 'unverified-replacement'; proof.actualModel = 'unverified-replacement';
        }
        await writeFile(path, JSON.stringify(changed));
      }
      await activateVerifiedCodexBinding(live, config, receipt);
    },
  });
  const server = createZeroServer({ store, config, connections, adapters: { codex: live } });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
  const post = (route: string, payload: unknown, key: string) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Idempotency-Key': key }, body: JSON.stringify(payload) });
  const get = (route: string) => fetch(base + route);
  const finish = async (id: string): Promise<VerificationJob> => {
    for (let count = 0; count < 200; count++) {
      const response = await get(`/api/connections/verifications/${id}`); assert.equal(response.status, 200); const job = await response.json() as VerificationJob;
      if (!['queued', 'running'].includes(job.state)) return job;
      await delay(25);
    }
    throw new Error('Verification job did not settle');
  };
  return { root, config, store, live, calls, connections, post, get, finish, release,
    async close() { release(); await connections.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); },
  };
}

test('website setup and explicit verification unlock a complete real Boss/Worker task without restart', { timeout: 180_000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.get('/api/connections/setup')).status, 200);
    assert.equal((await f.get('/api/connections/setup')).status, 200); assert.equal(f.calls.verification, 0);
    const before = await (await f.get('/api/capabilities')).json() as { allocator: { models: unknown[] } }; assert.equal(before.allocator.models.length, 0);
    const response = await f.post('/api/connections/codex/verify', { modelId: 'new-lead', reasoningEffort: 'high' }, 'http-new-lead-123456'); assert.equal(response.status, 202);
    const job = await response.json() as VerificationJob; assert.equal((await f.finish(job.id)).state, 'succeeded'); assert.equal(f.calls.verification, 1);
    const caps = await (await f.get('/api/capabilities')).json() as { allocator: { models: Array<{ id: string }> }; bindings: Array<{ modelId: string; available: boolean }> };
    assert.ok(caps.allocator.models.some(model => model.id === 'new-lead')); assert.ok(caps.bindings.some(binding => binding.modelId === 'new-lead' && binding.available));
    const repo = join(f.root, 'project'); await mkdir(repo); await writeFile(join(repo, 'README.md'), 'Website connected project.\n'); await prepareProjectFolder(repo);
    const submitted = await f.post('/api/tasks', { repoPath: repo, prompt: 'Create result.txt with approved', boss: { preference: 'new-lead high' } }, 'http-boss-task-123456'); assert.equal(submitted.status, 201, await submitted.clone().text());
    const task = await submitted.json() as { id: string }; const artifactRoot = join(f.root, 'artifacts');
    const boss = new BossOrchestrator({ codex: f.live, adapters: new Map([['codex', f.live]]), artifactRoot,
      getCandidates: async () => (await f.live.probe()).models.map(model => ({ bindingId: `codex:${model}`, model, harness: 'codex', available: true, healthy: true, verified: true, reasoningEfforts: ['high'], capabilities: ['route', 'review', 'implement'] })) });
    const worker = new TaskWorker({ store: f.store, worktrees: new GitWorktreeManager(join(f.root, 'worktrees')), testRunner: new TestRunner(), adapters: new Map([['codex', f.live]]), artifactRoot, boss,
      router: { async route(current) { return { taskId: current.id, harness: 'codex', model: 'new-lead', reasoningEffort: 'high', reason: 'Execute the newly connected Boss assignment', selectionSource: 'task', decidedAt: new Date().toISOString() }; } },
      reviewer: new TaskReviewer({ codex: f.live, model: 'new-lead', reasoningEffort: 'high', artifactDir: artifactRoot }),
    });
    const result = await worker.runNext('http-worker'); assert.equal(result?.id, task.id); assert.equal(result?.status, 'done', result?.failureReason);
    assert.deepEqual(f.calls, { verification: 1, selection: 1, planning: 1, writer: 1, reviewer: 1 });
    assert.equal(f.store.commitOperations(task.id).length, 1); assert.equal(f.store.reportOperations(task.id).length, 1);
  } finally { await f.close(); }
});

test('HTTP alias and canonical requests deduplicate one actual verification with durable receipt aliases', async () => {
  const f = await fixture({ models: [{ id: 'lead-local', provider: 'openai', modelId: 'upstream-lead' }], held: true });
  try {
    const input = { modelId: 'upstream-lead', reasoningEffort: 'high' };
    const [one, two] = await Promise.all([f.post('/api/connections/codex/verify', input, 'alias-request-123456'), f.post('/api/connections/codex/verify', { ...input, modelId: 'lead-local' }, 'canonical-request-123456')]);
    assert.equal(one.status, 202); assert.equal(two.status, 202); const first = await one.json() as VerificationJob; const second = await two.json() as VerificationJob;
    assert.equal(first.id, second.id); assert.equal(first.modelId, 'lead-local');
    const snapshot = await (await f.get(`/api/connections/verifications/${first.id}`)).json() as VerificationJob;
    assert.deepEqual(snapshot.requestedModelIds?.sort(), ['lead-local', 'upstream-lead']);
    const conflict = await f.post('/api/connections/codex/verify', { ...input, reasoningEffort: 'low' }, 'alias-request-123456'); assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as {verificationNotStarted?:boolean}).verificationNotStarted,true,'only this conflicting payload was refused; the original job still exists');
    f.release(); assert.equal((await f.finish(first.id)).state, 'succeeded'); assert.equal(f.calls.verification, 1);
    const replay = await f.post('/api/connections/codex/verify', input, 'alias-request-123456'); assert.equal((await replay.json() as VerificationJob).id, first.id); assert.equal(f.calls.verification, 1);
  } finally { await f.close(); }
});

test('HTTP pre-admission refusals are marked while unrelated errors and uncertain failures retain their keys',async()=>{
  const f=await fixture();
  try {
    const invalid=await f.post('/api/connections/codex/verify',{modelId:'--unsafe',reasoningEffort:'high'},'invalid-admission-key-12345');
    assert.equal(invalid.status,400);assert.equal((await invalid.json() as {verificationNotStarted?:boolean}).verificationNotStarted,true);
    assert.equal(f.calls.verification,0);
    const unrelated=await f.post('/api/projects/prepare',{bad:true},'unrelated-route-key-12345');
    assert.equal(unrelated.status,400);assert.equal((await unrelated.json() as {verificationNotStarted?:boolean}).verificationNotStarted,undefined);
    const original=f.connections.submit.bind(f.connections);
    f.connections.submit=async()=>{throw new Error('injected uncertain failure');};
    const uncertain=await f.post('/api/connections/codex/verify',{modelId:'new-lead',reasoningEffort:'high'},'uncertain-admission-key-12345');
    assert.equal(uncertain.status,500);assert.equal((await uncertain.json() as {verificationNotStarted?:boolean}).verificationNotStarted,undefined);
    f.connections.submit=original;
    await f.connections.close();
    const unavailable=await f.post('/api/connections/codex/verify',{modelId:'new-lead',reasoningEffort:'high'},'unavailable-admission-key-12345');
    assert.equal(unavailable.status,503);assert.equal((await unavailable.json() as {verificationNotStarted?:boolean}).verificationNotStarted,undefined);
    assert.equal(f.calls.verification,0);
  }finally{await f.close();}
});

test('HTTP wrong model evidence cannot enable a binding and the durable failure hides provider output', async () => {
  const f = await fixture({ wrongActual: true });
  try {
    const response = await f.post('/api/connections/codex/verify', { modelId: 'new-lead', reasoningEffort: 'high' }, 'wrong-model-request-12345'); assert.equal(response.status, 202);
    const job = await response.json() as VerificationJob; const failed = await f.finish(job.id); assert.equal(failed.state, 'failed'); assert.ok(failed.error); assert.ok(!JSON.stringify(failed).includes('SECRET'));
    assert.equal((await f.config.read()).bindings.length, 0); assert.deepEqual((await f.live.probe()).models, []); assert.equal(f.calls.verification, 1);
    const missing = await f.get('/api/connections/verifications/missing'); assert.equal(missing.status, 404);
  } finally { await f.close(); }
});

for (const replacement of ['proof', 'tuple'] as const) {
  test(`HTTP verification cannot activate a ${replacement} replaced after the actual successful verification`, async () => {
    const f = await fixture({ replaceAfterVerification: replacement });
    try {
      const response = await f.post('/api/connections/codex/verify', { modelId: 'new-lead', reasoningEffort: 'high' }, `replace-${replacement}-123456`);
      assert.equal(response.status, 202); const job = await response.json() as VerificationJob;
      const failed = await f.finish(job.id); assert.equal(failed.state, 'failed'); assert.ok(failed.error); assert.equal(f.calls.verification, 1);
      assert.equal((await f.config.read()).bindings.length, 1, 'the real nonce verification persisted before the adversarial edit');
      assert.deepEqual((await f.live.probe()).models, [], 'the modified fresh entry is never authority to activate');
      const capabilities = await (await f.get('/api/capabilities')).json() as { allocator: { models: unknown[] } };
      assert.deepEqual(capabilities.allocator.models, []);
    } finally { await f.close(); }
  });
}

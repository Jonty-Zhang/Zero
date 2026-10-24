import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ConfigStore, type LocalZeroConfig } from './config-store.js';
import { CodexAdapter } from '../adapters/codex.js';
import type { ModelBinding, ModelConfig, ReasoningEffort } from '../adapters/types.js';

const root = await mkdtemp(join(tmpdir(), 'zero-enrollment-identity-'));
const previousDataDir = process.env.ZERO_DATA_DIR;
process.env.ZERO_DATA_DIR = root;
const configPath = join(root, 'config.json');
const first: ModelConfig = { id: 'first-local', provider: 'account:first', modelId: 'second-local' };
const second: ModelConfig = { id: 'second-local', provider: 'account:desired', modelId: 'desired-upstream' };
const originals = { spawn: childProcess.spawn, spawnSync: childProcess.spawnSync, exec: childProcess.exec, execFile: childProcess.execFile,
  probe: CodexAdapter.prototype.probe, run: CodexAdapter.prototype.run };
const denyProcess = () => { throw new Error('Enrollment identity tests must not launch processes'); };
childProcess.spawn = denyProcess;
childProcess.exec = denyProcess as unknown as typeof childProcess.exec;
childProcess.execFile = denyProcess as unknown as typeof childProcess.execFile;
let gitChecks = 0;
childProcess.spawnSync = ((_executable: string, args: string[]) => {
  assert.equal(_executable, 'git');
  assert.equal(args[0], '-C');
  const cwd = resolve(args[1]!);
  const delta = relative(root, cwd);
  assert.ok(delta && !delta.startsWith('..') && !isAbsolute(delta));
  assert.deepEqual(args.slice(2), ['rev-parse', '--is-inside-work-tree']);
  gitChecks++;
  return { status: 0, signal: null, output: [null, 'true\n', ''], stdout: 'true\n', stderr: '', pid: 0 };
}) as typeof childProcess.spawnSync;
syncBuiltinESMExports();
const { runBindingVerification } = await import('./main.js');
let probedModels: ModelConfig[] = [];
let requestedModels: string[] = [];
let beforeResult: (() => Promise<void>) | undefined;
CodexAdapter.prototype.probe = async function () {
  const bindings = (this as unknown as { bindings: ModelBinding[] }).bindings;
  probedModels.push(...bindings.map(binding => binding.model));
  return { harness: 'codex', available: true, version: 'test-v1', models: bindings.map(binding => binding.model.id), reasoningEfforts: ['high'] };
};
CodexAdapter.prototype.run = async request => {
  requestedModels.push(request.model);
  const nonce = request.prompt.match(/ZERO_BINDING_VERIFIED_[a-f0-9-]+/)?.[0];
  assert.ok(nonce);
  await beforeResult?.();
  return { status: 'completed', exitCode: 0, durationMs: 0, final: nonce };
};
const proof = (model: ModelConfig, effort: ReasoningEffort = 'high') => ({ verifiedAt: '2026-10-24T00:00:00.000Z',
  cliVersion: 'test-v1', requestedModel: model.modelId, exitCode: 0 as const, level: 'selector_only' as const, reasoningEfforts: [effort] });
const binding = (model: ModelConfig): ModelBinding => ({ harness: 'codex', model, selector: 'cli_argument', verified: true,
  verifiedCliVersion: 'test-v1', reasoningEfforts: ['high'] });
async function seed(models: ModelConfig[], verified = false) {
  probedModels = []; requestedModels = []; gitChecks = 0; beforeResult = undefined;
  const config: LocalZeroConfig = { models, bindings: verified ? models.map(binding) : [],
    verifications: verified ? Object.fromEntries(models.map(model => [`codex:${model.id}`, proof(model)])) : {},
    allocator: { modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null },
    secretRefs: { FIXTURE_KEY: 'secret://preserved' } };
  const bytes = JSON.stringify(config, null, 2) + '\n';
  await writeFile(configPath, bytes);
  return { store: new ConfigStore(configPath), config, bytes };
}

test('real Codex verification keeps the exact Zero identity ahead of an upstream alias in either order', async () => {
  for (const models of [[first, second], [second, first]]) {
    const f = await seed(models);
    await runBindingVerification(second.id, 'high');
    assert.deepEqual(probedModels, [second]);
    assert.deepEqual(requestedModels, [second.id]);
    assert.equal(gitChecks, 1);
    const saved = await f.store.read();
    assert.deepEqual(saved.bindings.map(item => item.model), [second]);
    assert.deepEqual(Object.keys(saved.verifications), [`codex:${second.id}`]);
    assert.equal(saved.verifications[`codex:${second.id}`]!.requestedModel, second.modelId);
    assert.deepEqual(saved.secretRefs, f.config.secretRefs);
  }
});

test('real Codex verification accepts a unique legacy alias despite a different exact-ID collision', async () => {
  const f = await seed([first, second]);
  await runBindingVerification(second.modelId);
  assert.deepEqual(probedModels, [second]);
  assert.deepEqual(requestedModels, [second.id]);
  assert.deepEqual((await f.store.read()).bindings.map(item => item.model), [second]);
});

test('ordinary noncolliding Codex enrollment still persists its nonce proof', async () => {
  const f = await seed([second]);
  await runBindingVerification(second.id);
  const saved = await f.store.read();
  assert.deepEqual(saved.bindings.map(item => item.model), [second]);
  assert.deepEqual(Object.keys(saved.verifications[`codex:${second.id}`]!.effortEvidence!), ['high']);
  assert.deepEqual(saved.allocator, f.config.allocator);
  assert.deepEqual(saved.reviewer, f.config.reviewer);
});

const ambiguous = [
  { name: 'duplicate exact IDs', models: [second, { ...second, provider: 'other-account' }], selector: second.id },
  { name: 'ambiguous aliases', models: [second, { ...second, id: 'other-local', provider: 'other-account' }], selector: second.modelId },
];
for (const item of ambiguous) {
  test(`verification rejects ${item.name} before probe, run or config persistence`, async () => {
    for (const models of [item.models, [...item.models].reverse()]) {
      const f = await seed(models);
      await assert.rejects(runBindingVerification(item.selector));
      assert.deepEqual(probedModels, []);
      assert.deepEqual(requestedModels, []);
      assert.equal(gitChecks, 0);
      assert.equal(await readFile(configPath, 'utf8'), f.bytes);
    }
  });
}

test('the public store method persists only the uniquely selected exact or legacy model', async () => {
  for (const models of [[first, second], [second, first]]) for (const selector of [second.id, second.modelId]) {
    const f = await seed(models);
    await f.store.markVerified('codex', selector, proof(second), second);
    const saved = await f.store.read();
    assert.deepEqual(saved.bindings.map(item => item.model), [second]);
    assert.deepEqual(Object.keys(saved.verifications), [`codex:${second.id}`]);
    assert.deepEqual(saved.models, models);
  }
});

test('the public store method rejects ambiguous identities without changing config bytes', async () => {
  for (const item of ambiguous) for (const models of [item.models, [...item.models].reverse()]) {
    const f = await seed(models);
    await assert.rejects(f.store.markVerified('codex', item.selector, proof(second)));
    assert.equal(await readFile(configPath, 'utf8'), f.bytes);
  }
});

test('adding a reasoning effort updates only the intended exact or uniquely aliased model', async () => {
  for (const models of [[first, second], [second, first]]) for (const selector of [second.id, second.modelId]) {
    const f = await seed(models, true);
    await f.store.markReasoningEffortVerified('codex', selector, 'low', 'test-v1');
    const saved = await f.store.read();
    assert.deepEqual(saved.bindings.find(item => item.model.id === first.id), f.config.bindings.find(item => item.model.id === first.id));
    assert.deepEqual(saved.verifications[`codex:${first.id}`], f.config.verifications[`codex:${first.id}`]);
    assert.deepEqual(saved.bindings.find(item => item.model.id === second.id)!.reasoningEfforts, ['high', 'low']);
    assert.deepEqual(saved.verifications[`codex:${second.id}`]!.reasoningEfforts, ['high', 'low']);
  }
});

test('adding a reasoning effort rejects ambiguous model identity without changing bytes', async () => {
  for (const item of ambiguous) {
    const f = await seed(item.models, true);
    await assert.rejects(f.store.markReasoningEffortVerified('codex', item.selector, 'low', 'test-v1'));
    assert.equal(await readFile(configPath, 'utf8'), f.bytes);
  }
});

test('a model tuple changed during the real nonce call still rejects the stale proof', async () => {
  for (const replacement of [{ ...second, provider: 'changed-account' }, { ...second, modelId: 'changed-upstream' }]) {
    const f = await seed([second]);
    let changedBytes = '';
    beforeResult = async () => { changedBytes = JSON.stringify({ ...f.config, models: [replacement] }) + '\n'; await writeFile(configPath, changedBytes); };
    await assert.rejects(runBindingVerification(second.id), /changed during Codex verification/);
    assert.equal(await readFile(configPath, 'utf8'), changedBytes);
    assert.deepEqual((await f.store.read()).bindings, []);
  }
});

test.after(async () => {
  CodexAdapter.prototype.probe = originals.probe;
  CodexAdapter.prototype.run = originals.run;
  childProcess.spawn = originals.spawn;
  childProcess.spawnSync = originals.spawnSync;
  childProcess.exec = originals.exec;
  childProcess.execFile = originals.execFile;
  syncBuiltinESMExports();
  if (previousDataDir === undefined) delete process.env.ZERO_DATA_DIR;
  else process.env.ZERO_DATA_DIR = previousDataDir;
  await rm(root, { recursive: true, force: true });
});

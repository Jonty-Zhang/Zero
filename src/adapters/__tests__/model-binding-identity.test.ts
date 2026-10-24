import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createDefaultAdapters } from '../../server/server.js';
import { CodexAdapter } from '../codex.js';
import { DshAdapter } from '../dsh.js';
import { ZCodeAppServerAdapter } from '../zcode-app-server-adapter.js';
import type { HarnessCapabilities, RunRequest } from '../../domain/types.js';
import type { Invocation, ModelBinding, ModelConfig, RunContext } from '../types.js';

const first: ModelConfig = { id: 'first-model', provider: 'account:first', modelId: 'second-model' };
const second: ModelConfig = { id: 'second-model', provider: 'account:desired', modelId: 'desired-upstream' };
const codexBinding = (model: ModelConfig): ModelBinding => ({ harness: 'codex', model, selector: 'cli_argument', verified: true });
const desktopBinding = (model: ModelConfig): ModelBinding => ({
  harness: 'zcode', selector: 'app_server_existing_desktop', model, verified: true,
  verificationSource: 'smoke_test', verifiedCliVersion: '0.16.9', reasoningEfforts: ['high'],
  verificationEvidence: { kind: 'selector_only', verifiedAt: '2026-10-24T00:00:00Z', providerId: model.provider, modelId: model.modelId, cliVersion: '0.16.9', reasoningEffort: 'high' },
});
const request = (model: string, harness = 'codex'): RunRequest => ({
  taskId: 'identity-task', attemptId: 'identity-attempt', role: 'implement', cwd: process.cwd(),
  prompt: 'Implement the requested cross-agent task.', harness, model,
});
function intercept(adapter: CodexAdapter | DshAdapter, modelIds: string[], useRealCodexPrepare = false) {
  const selected: ModelBinding[] = [];
  const invocations: Invocation[] = [];
  let probes = 0;
  const prepare = adapter.prepare.bind(adapter);
  adapter.probe = async (): Promise<HarnessCapabilities> => { probes++; return { harness: adapter.id, available: true, models: modelIds, roles: ['implement'] }; };
  adapter.prepare = async (context: RunContext, binding: ModelBinding): Promise<Invocation> => {
    selected.push(binding);
    if (useRealCodexPrepare) invocations.push(await prepare(context, binding));
    throw new Error('Stopped before launching a task process');
  };
  return { selected, invocations, probes: () => probes };
}
function desktopHarness(bindings: ModelBinding[]) {
  const selections: unknown[] = [];
  let launches = 0;
  let probes = 0;
  const adapter = new ZCodeAppServerAdapter({
    bindings, zcodeEntry: join(process.cwd(), 'never-launched-identity-cli.mjs'), timeoutMs: 1_000,
    runProbeCommand: async args => { probes++; return { code: 0, stdout: args[0] === '--version' ? '0.16.9' : 'Usage: zcode app-server', stderr: '' }; },
    launchPeer: async () => {
      launches++;
      let inputId: unknown;
      return {
        async request(method, params) {
          if (method === 'session/create') return {
            session: { sessionId: 'identity-session' },
            settings: { model: { available: bindings.filter(binding => binding.selector === 'app_server_existing_desktop').map(binding => ({
              ref: { providerId: binding.model.provider, modelId: binding.model.modelId }, reasoning: { levels: [{ value: 'high' }] },
            })) } },
          };
          if (method === 'v4/command') {
            inputId = params.commandId;
            if (params.type === 'sendText') selections.push((params.payload as Record<string, unknown>).modelSelection);
            return { status: 'accepted', commandId: params.commandId, result: { type: 'inputAccepted', delivery: 'startNow', inputId } };
          }
          if (method === 'session/events') return { events: [
            { seq: 1, type: 'turn.started', turnId: 'identity-turn', payload: { inputId, foregroundExecutionId: 'identity-execution' } },
            { seq: 2, type: 'turn.completed', turnId: 'identity-turn', payload: { inputId, resultType: 'success', response: 'done' } },
          ] };
          return {};
        },
        async readPendingInteractions() { return []; },
        async close() {},
      };
    },
  });
  return { adapter, selections, launches: () => launches, probes: () => probes };
}

test('Codex execution prefers the exact Zero ID over another model upstream alias in either order', async () => {
  for (const bindings of [[codexBinding(first), codexBinding(second)], [codexBinding(second), codexBinding(first)]]) {
    const adapter = createDefaultAdapters(bindings).codex as CodexAdapter;
    const observed = intercept(adapter, [first.id, second.id], true);
    await adapter.run(request(second.id));
    assert.equal(observed.selected[0]?.model.id, second.id);
    assert.equal(observed.invocations[0]?.requestedModel, second.modelId);
    const args = observed.invocations[0]!.args;
    assert.equal(args[args.indexOf('--model') + 1], second.modelId);
  }
});

test('factory adapters resolve a shared Zero model only within their own Harness in either order', async () => {
  const model = { id: 'shared-local', provider: 'provider', modelId: 'shared-upstream' };
  const shared: ModelBinding[] = [codexBinding(model), { harness: 'dsh', model, selector: 'profile', profile: 'headless-shared', verified: true }];
  for (const bindings of [shared, [...shared].reverse()]) {
    const adapters = createDefaultAdapters(bindings);
    for (const harness of ['codex', 'dsh'] as const) {
      const adapter = adapters[harness] as CodexAdapter | DshAdapter;
      const observed = intercept(adapter, [model.id]);
      await adapter.run(request(model.id, harness));
      assert.equal(observed.selected[0]?.harness, harness);
      assert.equal(observed.probes(), 1);
    }
  }
});

test('Base binding selection rejects duplicate exact IDs and ambiguous aliases before probing', async () => {
  const duplicateId = codexBinding({ ...second, modelId: 'other-upstream' });
  const duplicateAlias = codexBinding({ id: 'another-local', provider: 'other-account', modelId: second.modelId });
  for (const [bindings, model] of [
    [[codexBinding(second), duplicateId], second.id],
    [[codexBinding(second), duplicateAlias], second.modelId],
    [[{ ...codexBinding(second), verified: false } as unknown as ModelBinding, duplicateAlias], second.modelId],
  ] as const) {
    const adapter = new CodexAdapter({ bindings: [...bindings] });
    const observed = intercept(adapter, [second.id, 'another-local']);
    const result = await adapter.run(request(model));
    assert.equal(result.status, 'failed');
    assert.equal(observed.selected.length, 0);
    assert.equal(observed.probes(), 0);
  }
});

test('Base selection preserves ordinary IDs and unique legacy aliases without bypassing an invalid exact binding', async () => {
  const adapter = new CodexAdapter({ bindings: [codexBinding(first), codexBinding(second)] });
  const observed = intercept(adapter, [first.id, second.id]);
  await adapter.run(request(first.id));
  await adapter.run(request(second.modelId));
  assert.deepEqual(observed.selected.map(binding => binding.model.id), [first.id, second.id]);
  const invalidExact = { ...codexBinding(second), verified: false } as unknown as ModelBinding;
  const blocked = new CodexAdapter({ bindings: [codexBinding(first), invalidExact] });
  const blockedObserved = intercept(blocked, [first.id, second.id]);
  const result = await blocked.run(request(second.id));
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /not verified/);
  assert.equal(blockedObserved.probes(), 0);
});

test('desktop execution prefers an exact Zero ID over another provider upstream alias in either order', async () => {
  for (const bindings of [[desktopBinding(first), desktopBinding(second)], [desktopBinding(second), desktopBinding(first)]]) {
    const state = desktopHarness(bindings);
    const result = await state.adapter.run({ ...request(second.id, 'zcode'), reasoningEffort: 'high' });
    assert.equal(result.status, 'completed');
    assert.equal(result.metadata?.requestedProviderId, second.provider);
    assert.equal(result.metadata?.requestedModelId, second.modelId);
    assert.equal(state.launches(), 1);
  }
});

test('desktop execution rejects duplicate exact IDs and ambiguous aliases before probe or peer launch', async () => {
  const duplicateId = desktopBinding({ ...second, modelId: 'another-upstream' });
  const duplicateAlias = desktopBinding({ id: 'another-local', provider: 'other-account', modelId: second.modelId });
  for (const [bindings, model] of [
    [[desktopBinding(second), duplicateId], second.id],
    [[desktopBinding(second), duplicateAlias], second.modelId],
    [[{ ...desktopBinding(second), verified: false } as unknown as ModelBinding, duplicateAlias], second.modelId],
  ] as const) {
    const state = desktopHarness([...bindings]);
    const result = await state.adapter.run({ ...request(model, 'zcode'), reasoningEffort: 'high' });
    assert.equal(result.status, 'failed');
    assert.equal(state.probes(), 0);
    assert.equal(state.launches(), 0);
  }
});

test('desktop selection retains unique legacy aliases and limits collisions to its own selector', async () => {
  const otherSelector: ModelBinding = { harness: 'zcode', model: first, selector: 'isolated_config', verified: true, configDir: process.cwd(), mode: 'build' };
  const state = desktopHarness([otherSelector, desktopBinding(second)]);
  for (const model of [second.id, second.modelId]) {
    const result = await state.adapter.run({ ...request(model, 'zcode'), reasoningEffort: 'high' });
    assert.equal(result.status, 'completed');
    assert.equal(result.metadata?.requestedProviderId, second.provider);
  }
  assert.equal(state.selections.length, 2);
});

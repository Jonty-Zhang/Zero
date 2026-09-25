import test from 'node:test';
import assert from 'node:assert/strict';
import type { HarnessAdapter, HarnessCapabilities, RunRequest, RunResult } from '../../domain/types.js';
import type { ModelBinding } from '../types.js';
import { ZCodeCompositeAdapter } from '../zcode-composite.js';

const isolatedBinding: ModelBinding = {
  harness: 'zcode', selector: 'isolated_config', verified: true,
  model: { id: 'isolated', provider: 'private', modelId: 'shared-name' },
  configDir: 'C:/zero/isolated', mode: 'build', reasoningEfforts: [],
};
const desktopBinding: ModelBinding = {
  harness: 'zcode', selector: 'app_server_existing_desktop', verified: true,
  verificationSource: 'smoke_test', verifiedCliVersion: '0.16.9',
  model: { id: 'desktop', provider: 'account:start-plan', modelId: 'shared-name' },
  verificationEvidence: { kind: 'selector_only', verifiedAt: '2026-09-25T00:00:00Z', providerId: 'account:start-plan', modelId: 'shared-name', cliVersion: '0.16.9' },
  reasoningEfforts: [],
};

function fakeAdapter(models: string[], available = true): HarnessAdapter & { runs: RunRequest[]; cancelled: string[] } {
  const runs: RunRequest[] = [];
  const cancelled: string[] = [];
  return {
    id: 'zcode', runs, cancelled,
    async probe(): Promise<HarnessCapabilities> {
      return { harness: 'zcode', version: '0.16.9', models, available, roles: ['implement', 'revise'] };
    },
    async run(request): Promise<RunResult> {
      runs.push(request);
      return { status: 'completed', exitCode: 0, durationMs: 1, final: models[0] };
    },
    async cancel(taskId, attemptId) { cancelled.push(`${taskId}:${attemptId}`); },
  };
}

function request(model: string): RunRequest {
  return { taskId: 'task', attemptId: 'attempt', role: 'implement', cwd: 'C:/zero/worktree', prompt: 'work', harness: 'zcode', model };
}

test('composite ZCode adapter routes only exact Zero model IDs to their selector', async () => {
  const isolated = fakeAdapter(['isolated']);
  const desktop = fakeAdapter(['desktop']);
  const adapter = new ZCodeCompositeAdapter({ bindings: [isolatedBinding, desktopBinding], isolated, existingDesktop: desktop });
  assert.deepEqual((await adapter.probe()).models, ['isolated', 'desktop']);
  assert.equal((await adapter.run(request('isolated'))).final, 'isolated');
  assert.equal((await adapter.run(request('desktop'))).final, 'desktop');
  assert.equal(isolated.runs.length, 1);
  assert.equal(desktop.runs.length, 1);
  await assert.rejects(adapter.run(request('shared-name')), /no unique verified Zero model binding/);
  assert.equal(isolated.runs.length + desktop.runs.length, 2);
});

test('unhealthy desktop selector cannot advertise its model through healthy isolated CLI', async () => {
  const isolated = fakeAdapter(['isolated']);
  const desktop = fakeAdapter(['desktop'], false);
  const adapter = new ZCodeCompositeAdapter({ bindings: [isolatedBinding, desktopBinding], isolated, existingDesktop: desktop });
  const caps = await adapter.probe();
  assert.equal(caps.available, true);
  assert.deepEqual(caps.models, ['isolated']);
});

test('duplicate Zero model IDs never dispatch to either ZCode selector', async () => {
  const isolated = fakeAdapter(['isolated']);
  const desktop = fakeAdapter(['isolated']);
  const adapter = new ZCodeCompositeAdapter({ bindings: [isolatedBinding, { ...desktopBinding, model: { ...desktopBinding.model, id: 'isolated' } }], isolated, existingDesktop: desktop });
  assert.deepEqual((await adapter.probe()).models, []);
  await assert.rejects(adapter.run(request('isolated')), /no unique verified Zero model binding/);
  assert.equal(isolated.runs.length + desktop.runs.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RunRequest, RunResult } from '../domain/types.js';
import type { ModelBinding } from '../adapters/types.js';
import type { DshAdapter } from '../adapters/dsh.js';
import { ConfigStore } from './config-store.js';
import { runDshBindingVerification } from './main.js';

const model = { id: 'deepseek-main', provider: 'deepseek-official', modelId: 'deepseek-flash' };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zero-dsh-enrollment-'));
  const dshHome = join(root, 'dsh-home');
  const profile = join(dshHome, 'profiles', 'zero-deepseek');
  const verificationRoot = join(root, 'verification');
  await mkdir(profile, { recursive: true });
  const configPath = join(root, 'config.json');
  const initial = {
    models: [model],
    bindings: [{ harness: 'dsh', model, selector: 'profile', profile: 'zero-deepseek', verified: true, verifiedCliVersion: 'dsh-old', verificationSource: 'smoke_test', reasoningEfforts: [] }],
    allocator: { modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null },
    verifications: { 'dsh:deepseek-main': { verifiedAt: '2026-01-01T00:00:00.000Z', cliVersion: 'dsh-old', requestedModel: model.modelId, exitCode: 0, level: 'selector_only', profile: 'zero-deepseek', reasoningEfforts: [] } },
  };
  await writeFile(configPath, `${JSON.stringify(initial, null, 2)}\n`, 'utf8');
  return { root, dshHome, verificationRoot, config: new ConfigStore(configPath), initialBytes: await readFile(configPath, 'utf8') };
}

function fakeAdapter(resultFactory: (request: RunRequest) => RunResult) {
  return (_bindings: ModelBinding[], _dshHome: string) => ({
    probe: async () => ({ harness: 'dsh', available: true, version: 'dsh-test-2', models: [model.id], reasoningEfforts: [] }),
    run: async (request: RunRequest) => resultFactory(request),
  }) as unknown as Pick<DshAdapter, 'probe' | 'run'>;
}

test('DSH enrollment persists a version-pinned selector-only binding only after the nonce succeeds', async () => {
  const f = await fixture();
  try {
    await runDshBindingVerification(model.id, 'zero-deepseek', {
      config: f.config, dshHome: f.dshHome, verificationRoot: f.verificationRoot,
      createAdapter: fakeAdapter(request => {
        assert.equal(request.harness, 'dsh');
        assert.equal(request.model, model.id);
        assert.equal(request.role, 'implement');
        assert.equal(request.reasoningEffort, undefined);
        assert.equal(request.artifactDir, undefined);
        const nonce = /Reply with exactly this string and nothing else: (ZERO_DSH_BINDING_VERIFIED_[A-Za-z0-9-]+)/.exec(request.prompt)?.[1];
        assert.ok(nonce);
        return { status: 'completed', exitCode: 0, final: nonce, durationMs: 1 };
      }),
    });
    const config = await f.config.read();
    const binding = config.bindings.find(item => item.harness === 'dsh' && item.model.id === model.id);
    assert.deepEqual(binding, {
      harness: 'dsh', model, selector: 'profile', profile: 'zero-deepseek', verified: true,
      verificationSource: 'smoke_test', verifiedCliVersion: 'dsh-test-2', reasoningEfforts: [],
    });
    assert.deepEqual(config.verifications['dsh:deepseek-main'], {
      verifiedAt: config.verifications['dsh:deepseek-main']?.verifiedAt,
      cliVersion: 'dsh-test-2', requestedModel: model.modelId, exitCode: 0,
      level: 'selector_only', profile: 'zero-deepseek', reasoningEfforts: [],
    });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('failed DSH nonce verification leaves an existing binding byte-for-byte unchanged', async () => {
  const f = await fixture();
  try {
    await assert.rejects(runDshBindingVerification(model.id, 'zero-deepseek', {
      config: f.config, dshHome: f.dshHome, verificationRoot: f.verificationRoot,
      createAdapter: fakeAdapter(() => ({ status: 'failed', exitCode: 1, final: 'provider error', durationMs: 1, error: 'sensitive provider detail' })),
    }), /existing binding remains unchanged/);
    assert.equal(await readFile(f.config.path, 'utf8'), f.initialBytes);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('DSH enrollment rejects an unsafe or missing profile before constructing an adapter', async () => {
  const f = await fixture();
  try {
    let constructed = false;
    await assert.rejects(runDshBindingVerification(model.id, '../outside', {
      config: f.config, dshHome: f.dshHome, verificationRoot: f.verificationRoot,
      createAdapter: () => { constructed = true; throw new Error('must not be reached'); },
    }), /safe profile name/);
    await assert.rejects(runDshBindingVerification(model.id, 'missing-profile', {
      config: f.config, dshHome: f.dshHome, verificationRoot: f.verificationRoot,
      createAdapter: () => { constructed = true; throw new Error('must not be reached'); },
    }), /must already exist/);
    assert.equal(constructed, false);
    assert.equal(await readFile(f.config.path, 'utf8'), f.initialBytes);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

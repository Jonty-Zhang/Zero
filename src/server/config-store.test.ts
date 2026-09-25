import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigStore, type ZCodeAppServerNonceProof, type ZCodeAppServerVerificationEvidence } from './config-store.js';

const model = { id: 'glm-main', provider: 'zai', modelId: 'glm-5' };
const evidence: ZCodeAppServerVerificationEvidence = {
  verifiedAt: '2026-09-25T08:30:00.000Z',
  cliVersion: 'zcode 1.4.2',
  providerId: 'zai',
  modelId: 'glm-5',
};
const nonceProof: ZCodeAppServerNonceProof = {
  nonce: 'ZERO_ZCODE_APP_SERVER_BINDING_VERIFIED_3c78a744-8bd2-4f9b-8b14-5ce8d95bd880',
  echoedNonce: 'ZERO_ZCODE_APP_SERVER_BINDING_VERIFIED_3c78a744-8bd2-4f9b-8b14-5ce8d95bd880',
  sessionEndedSuccessfully: true,
  peerExited: true,
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zero-zcode-app-server-store-'));
  const path = join(root, 'config.json');
  const initial = {
    models: [model],
    bindings: [
      { harness: 'zcode', model, selector: 'isolated_config', configDir: join(root, 'old-config'), mode: 'build', verified: true, verifiedCliVersion: 'zcode-old', reasoningEfforts: [] },
      { harness: 'codex', model: { id: 'codex-main', provider: 'openai', modelId: 'gpt-6-sol' }, selector: 'cli_argument', verified: true, reasoningEfforts: ['high'] },
    ],
    allocator: { modelId: 'codex-main', reasoningEffort: 'high' },
    reviewer: { modelId: null, reasoningEffort: null },
    verifications: {
      'zcode:glm-main': { verifiedAt: '2026-01-01T00:00:00.000Z', cliVersion: 'zcode-old', requestedModel: 'glm-5', exitCode: 0, level: 'selector_only', reasoningEfforts: [] },
      'codex:codex-main': { verifiedAt: '2026-01-01T00:00:00.000Z', cliVersion: 'codex-old', requestedModel: 'gpt-6-sol', exitCode: 0, level: 'selector_only', reasoningEfforts: ['high'] },
    },
    secretRefs: { OPENAI_API_KEY: 'secret://openai' },
  };
  await writeFile(path, `${JSON.stringify(initial, null, 2)}\n`, 'utf8');
  return { root, path, store: new ConfigStore(path), initialBytes: await readFile(path, 'utf8'), initial };
}

test('app-server verification replaces the ZCode binding and preserves other Zero config', async () => {
  const f = await fixture();
  try {
    await f.store.markZCodeAppServerVerified(model.id, model, evidence, nonceProof);
    const config = await f.store.read();
    assert.deepEqual(config.bindings.find(binding => binding.harness === 'zcode' && binding.model.id === model.id), {
      harness: 'zcode', model, selector: 'app_server_existing_desktop', verified: true,
      verificationSource: 'smoke_test',
      verifiedCliVersion: evidence.cliVersion,
      verificationEvidence: {
        kind: 'selector_only', verifiedAt: evidence.verifiedAt, providerId: 'zai', modelId: 'glm-5', cliVersion: evidence.cliVersion,
      },
      reasoningEfforts: [],
    });
    assert.equal(config.bindings.filter(binding => binding.harness === 'zcode' && binding.model.id === model.id).length, 1);
    assert.deepEqual(config.bindings.find(binding => binding.harness === 'codex'), f.initial.bindings[1]);
    assert.deepEqual(config.models, f.initial.models);
    assert.deepEqual(config.allocator, f.initial.allocator);
    assert.deepEqual(config.reviewer, f.initial.reviewer);
    assert.deepEqual(config.secretRefs, f.initial.secretRefs);
    assert.deepEqual(config.verifications['codex:codex-main'], f.initial.verifications['codex:codex-main']);
    assert.deepEqual(config.verifications['zcode:glm-main'], {
      verifiedAt: evidence.verifiedAt, cliVersion: evidence.cliVersion, requestedModel: 'glm-5',
      exitCode: 0, level: 'selector_only', reasoningEfforts: [],
    });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('app-server verification failures preserve the config file byte-for-byte', async () => {
  const cases: Array<{ name: string; run: (store: ConfigStore) => Promise<void>; error: RegExp }> = [
    { name: 'provider mismatch', run: store => store.markZCodeAppServerVerified(model.id, model, { ...evidence, providerId: 'other' }, nonceProof), error: /exact provider\/model tuple/ },
    { name: 'model mismatch', run: store => store.markZCodeAppServerVerified(model.id, model, { ...evidence, modelId: 'glm-5.1' }, nonceProof), error: /exact provider\/model tuple/ },
    { name: 'unknown CLI version', run: store => store.markZCodeAppServerVerified(model.id, model, { ...evidence, cliVersion: 'unknown' }, nonceProof), error: /CLI version/ },
    { name: 'unmatched nonce', run: store => store.markZCodeAppServerVerified(model.id, model, evidence, { ...nonceProof, echoedNonce: 'different' }), error: /nonce verification/ },
    { name: 'empty nonce', run: store => store.markZCodeAppServerVerified(model.id, model, evidence, { ...nonceProof, nonce: '' }), error: /nonce verification/ },
    { name: 'session not ended', run: store => store.markZCodeAppServerVerified(model.id, model, evidence, { ...nonceProof, sessionEndedSuccessfully: false }), error: /session must end/ },
    { name: 'peer not confirmed exited', run: store => store.markZCodeAppServerVerified(model.id, model, evidence, { ...nonceProof, peerExited: false }), error: /session must end/ },
    { name: 'changed local tuple', run: store => store.markZCodeAppServerVerified(model.id, { ...model, modelId: 'glm-4' }, evidence, nonceProof), error: /exact provider\/model tuple/ },
  ];

  for (const item of cases) {
    const f = await fixture();
    try {
      await assert.rejects(item.run(f.store), item.error, item.name);
      assert.equal(await readFile(f.path, 'utf8'), f.initialBytes, `${item.name} changed config bytes`);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test('app-server verification requires a unique local model ID and the exact current model tuple', async () => {
  const f = await fixture();
  try {
    const duplicate = { ...model, provider: 'other-provider', modelId: 'other-model' };
    await writeFile(f.path, `${JSON.stringify({ ...f.initial, models: [model, duplicate] }, null, 2)}\n`, 'utf8');
    const beforeDuplicateFailure = await readFile(f.path, 'utf8');
    await assert.rejects(f.store.markZCodeAppServerVerified(model.id, model, evidence, nonceProof), /exactly one local model ID/);
    assert.equal(await readFile(f.path, 'utf8'), beforeDuplicateFailure);

    await writeFile(f.path, `${JSON.stringify(f.initial, null, 2)}\n`, 'utf8');
    const beforeTupleFailure = await readFile(f.path, 'utf8');
    await assert.rejects(f.store.markZCodeAppServerVerified(model.id, { ...model, provider: 'other-provider' }, evidence, nonceProof), /exact provider\/model tuple/);
    assert.equal(await readFile(f.path, 'utf8'), beforeTupleFailure);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

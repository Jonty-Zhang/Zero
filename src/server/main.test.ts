import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RunRequest, RunResult } from '../domain/types.js';
import type { ModelBinding } from '../adapters/types.js';
import type { DshAdapter } from '../adapters/dsh.js';
import type { ZCodeAdapter } from '../adapters/zcode.js';
import type { ZCodeProtocolPeer } from '../adapters/zcode-protocol-session.js';
import type { ZCodeAppServerAdapterConfig } from '../adapters/zcode-app-server-adapter.js';
import type { ZCodeAppServerPeerOptions } from '../adapters/zcode-app-server-peer.js';
import { ZCodeAppServerAdapter } from '../adapters/zcode-app-server-adapter.js';
import { ConfigStore } from './config-store.js';
import { runDshBindingVerification, runZCodeBindingVerification, runZCodeDesktopBindingVerification } from './main.js';

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

const zcodeModel = { id: 'glm-main', provider: 'zai', modelId: 'glm-5' };

async function zcodeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'zero-zcode-enrollment-'));
  const configDir = join(root, 'zcode-configs', 'glm-main');
  await mkdir(join(configDir, '.zcode', 'cli'), { recursive: true });
  await writeFile(join(configDir, '.zcode', 'cli', 'config.json'), JSON.stringify({ model: { main: 'zai/glm-5' } }), 'utf8');
  const configPath = join(root, 'config.json');
  const initial = {
    models: [zcodeModel],
    bindings: [{ harness: 'zcode', model: zcodeModel, selector: 'isolated_config', configDir, mode: 'yolo', verified: true, verifiedCliVersion: 'zcode-old', verificationSource: 'smoke_test', reasoningEfforts: [] }],
    allocator: { modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null },
    verifications: { 'zcode:glm-main': { verifiedAt: '2026-01-01T00:00:00.000Z', cliVersion: 'zcode-old', requestedModel: zcodeModel.modelId, exitCode: 0, level: 'selector_only', configDir, mode: 'yolo', reasoningEfforts: [] } },
  };
  await writeFile(configPath, `${JSON.stringify(initial, null, 2)}\n`, 'utf8');
  return { root, configDir, verificationRoot: join(root, 'verification'), config: new ConfigStore(configPath), initialBytes: await readFile(configPath, 'utf8') };
}

function fakeZCodeAdapter(run: (request: RunRequest) => RunResult, probe?: () => Promise<{ harness: 'zcode'; available: boolean; version?: string; models: string[]; reasoningEfforts: [] }>) {
  let probeCount = 0;
  return (_bindings: ModelBinding[]) => ({
    probe: async () => {
      probeCount++;
      return probe ? probe() : { harness: 'zcode', available: true, version: 'zcode-test-2', models: [zcodeModel.id], reasoningEfforts: [] };
    },
    run: async (request: RunRequest) => run(request),
    get probeCount() { return probeCount; },
  }) as unknown as Pick<ZCodeAdapter, 'probe' | 'run'>;
}

test('ZCode enrollment pins the isolated selector and mode only after a successful nonce and post-call probe', async () => {
  const f = await zcodeFixture();
  try {
    await runZCodeBindingVerification(zcodeModel.id, f.configDir, 'build', {
      config: f.config, dataRoot: f.root, verificationRoot: f.verificationRoot,
      createAdapter: fakeZCodeAdapter(request => {
        assert.equal(request.harness, 'zcode');
        assert.equal(request.model, zcodeModel.id);
        assert.equal(request.role, 'implement');
        assert.equal(request.reasoningEffort, undefined);
        assert.equal(request.artifactDir, undefined);
        assert.notEqual(request.cwd, f.root);
        const nonce = /Reply with exactly this string and nothing else: (ZERO_ZCODE_BINDING_VERIFIED_[A-Za-z0-9-]+)/.exec(request.prompt)?.[1];
        assert.ok(nonce);
        return { status: 'completed', exitCode: 0, final: nonce, durationMs: 1 };
      }),
    });
    const config = await f.config.read();
    assert.deepEqual(config.bindings.find(item => item.harness === 'zcode' && item.model.id === zcodeModel.id), {
      harness: 'zcode', model: zcodeModel, selector: 'isolated_config', configDir: f.configDir, mode: 'build', verified: true,
      verificationSource: 'smoke_test', verifiedCliVersion: 'zcode-test-2', reasoningEfforts: [],
    });
    assert.deepEqual(config.verifications['zcode:glm-main'], {
      verifiedAt: config.verifications['zcode:glm-main']?.verifiedAt,
      cliVersion: 'zcode-test-2', requestedModel: zcodeModel.modelId, exitCode: 0,
      level: 'selector_only', configDir: f.configDir, mode: 'build', reasoningEfforts: [],
    });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('failed ZCode nonce leaves the previous binding byte-for-byte unchanged', async () => {
  const f = await zcodeFixture();
  try {
    await assert.rejects(runZCodeBindingVerification(zcodeModel.id, f.configDir, 'yolo', {
      config: f.config, dataRoot: f.root, verificationRoot: f.verificationRoot,
      createAdapter: fakeZCodeAdapter(() => ({ status: 'failed', exitCode: 1, final: 'provider error', durationMs: 1, error: 'sensitive provider detail' })),
    }), /existing binding remains unchanged/);
    assert.equal(await readFile(f.config.path, 'utf8'), f.initialBytes);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('ZCode enrollment leaves the old binding unchanged when the post-call CLI version differs', async () => {
  const f = await zcodeFixture();
  let probeCount = 0;
  try {
    await assert.rejects(runZCodeBindingVerification(zcodeModel.id, f.configDir, 'build', {
      config: f.config, dataRoot: f.root, verificationRoot: f.verificationRoot,
      createAdapter: fakeZCodeAdapter(request => {
        const nonce = /Reply with exactly this string and nothing else: (ZERO_ZCODE_BINDING_VERIFIED_[A-Za-z0-9-]+)/.exec(request.prompt)?.[1];
        assert.ok(nonce);
        return { status: 'completed', exitCode: 0, final: nonce, durationMs: 1 };
      }, async () => {
        probeCount++;
        return { harness: 'zcode', available: true, version: probeCount === 1 ? 'zcode-test-2' : 'zcode-test-3', models: [zcodeModel.id], reasoningEfforts: [] };
      }),
    }), /CLI version or isolated model selection changed/);
    assert.equal(probeCount, 2);
    assert.equal(await readFile(f.config.path, 'utf8'), f.initialBytes);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('ZCode enrollment rejects unsupported modes, outside paths and incorrect model selection before adapter construction', async () => {
  const f = await zcodeFixture();
  try {
    let constructed = false;
    const createAdapter = () => { constructed = true; throw new Error('must not be reached'); };
    await assert.rejects(runZCodeBindingVerification(zcodeModel.id, f.configDir, 'edit', { config: f.config, dataRoot: f.root, createAdapter }), /must be build or yolo/);
    await assert.rejects(runZCodeBindingVerification(zcodeModel.id, join(tmpdir(), 'outside-zcode'), 'build', { config: f.config, dataRoot: f.root, createAdapter }), /beneath Zero's data root/);
    await writeFile(join(f.configDir, '.zcode', 'cli', 'config.json'), JSON.stringify({ model: { main: 'zai/glm-5.3' } }), 'utf8');
    await assert.rejects(runZCodeBindingVerification(zcodeModel.id, f.configDir, 'build', { config: f.config, dataRoot: f.root, createAdapter }), /must select exactly zai\/glm-5/);
    assert.equal(constructed, false);
    assert.equal(await readFile(f.config.path, 'utf8'), f.initialBytes);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

function fakeDesktopProbe(version: () => string, observedArgs: string[]) {
  return (config: ZCodeAppServerAdapterConfig) => {
    assert.deepEqual(config.bindings, [], 'desktop enrollment must probe with no configured bindings');
    return new ZCodeAppServerAdapter({
      ...config,
      runProbeCommand: async args => {
        observedArgs.push(args.join(' '));
        if (args.length !== 1 || !['--version', '--help'].includes(args[0]!)) return { code: 1, stdout: '', stderr: '' };
        return args[0] === '--version'
          ? { code: 0, stdout: version(), stderr: '' }
          : { code: 0, stdout: 'ZCode app-server', stderr: '' };
      },
    });
  };
}

function fakeDesktopPeer(responseOverride?: string, closeError?: Error) {
  let inputId = '';
  let response = '';
  let eventRead = false;
  let closeCount = 0;
  const peer: ZCodeProtocolPeer = {
    async request(method, params) {
      if (method === 'session/create') return {
        session: { sessionId: 'fake-desktop-session' },
        settings: { model: { available: [{ ref: { providerId: zcodeModel.provider, modelId: zcodeModel.modelId } }] } },
      };
      if (method === 'v4/command') {
        const payload = params.payload as Record<string, unknown>;
        if (params.type === 'sendText') {
          inputId = String(params.commandId);
          const prompt = String(payload.text);
          const nonce = /ZERO_ZCODE_DESKTOP_BINDING_VERIFIED_[A-Za-z0-9-]+/.exec(prompt)?.[0];
          assert.ok(nonce, 'session prompt must contain a cryptographic nonce');
          response = responseOverride ?? nonce;
          return { commandId: params.commandId, status: 'accepted', result: { type: 'inputAccepted', inputId, delivery: 'startNow' } };
        }
      }
      if (method === 'session/events') {
        assert.equal(params.afterSeq, 0);
        if (eventRead) return { events: [] };
        eventRead = true;
        return { events: [
          { seq: 1, type: 'turn.started', turnId: 'fake-turn', payload: { inputId, foregroundExecutionId: 'fake-execution' } },
          { seq: 2, type: 'turn.completed', turnId: 'fake-turn', payload: { resultType: 'success', response } },
        ] };
      }
      throw new Error(`Unexpected fake protocol method ${method}`);
    },
    async readPendingInteractions() { return []; },
    async close() { closeCount++; if (closeError) throw closeError; },
  };
  return { peer, get closeCount() { return closeCount; } };
}

function desktopEnrollmentOptions(f: Awaited<ReturnType<typeof zcodeFixture>>, overrides: {
  peer?: ReturnType<typeof fakeDesktopPeer>;
  version?: () => string;
} = {}) {
  const peer = overrides.peer ?? fakeDesktopPeer();
  const version = overrides.version ?? (() => 'zcode-desktop-test-2');
  const probeArgs: string[] = [];
  return {
    config: f.config,
    dataRoot: f.root,
    zcodeEntry: join(f.root, 'zcode.js'),
    createAdapter: fakeDesktopProbe(version, probeArgs),
    launchPeer: async (options: ZCodeAppServerPeerOptions) => {
      assert.equal(options.entry, join(f.root, 'zcode.js'));
      assert.equal(options.profileMode, 'existing-desktop');
      assert.ok(options.taskWorktree.startsWith(join(f.root, 'verification')));
      return peer.peer;
    },
    peer,
    probeArgs,
  };
}

test('ZCode existing-desktop enrollment proves exact nonce, closes peer and replaces binding only after both empty-binding probes', async () => {
  const f = await zcodeFixture();
  const options = desktopEnrollmentOptions(f);
  try {
    await runZCodeDesktopBindingVerification(zcodeModel.id, options);
    assert.equal(options.peer.closeCount, 1);
    assert.deepEqual(options.probeArgs, ['--version', '--help', '--version', '--help']);
    const config = await f.config.read();
    assert.deepEqual(config.bindings.find(item => item.harness === 'zcode' && item.model.id === zcodeModel.id), {
      harness: 'zcode', model: zcodeModel, selector: 'app_server_existing_desktop', verified: true,
      verificationSource: 'smoke_test', verifiedCliVersion: 'zcode-desktop-test-2',
      verificationEvidence: {
        kind: 'selector_only', providerId: zcodeModel.provider, modelId: zcodeModel.modelId,
        cliVersion: 'zcode-desktop-test-2', verifiedAt: config.verifications['zcode:glm-main']?.verifiedAt,
      }, reasoningEfforts: [],
    });
    assert.equal(config.verifications['zcode:glm-main']?.level, 'selector_only');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('ZCode existing-desktop enrollment rejects a bad nonce without changing config', async () => {
  const f = await zcodeFixture();
  const options = desktopEnrollmentOptions(f, { peer: fakeDesktopPeer('wrong nonce') });
  try {
    await assert.rejects(runZCodeDesktopBindingVerification(zcodeModel.id, options), /nonce verification failed/);
    assert.equal(options.peer.closeCount, 1);
    assert.equal(await readFile(f.config.path, 'utf8'), f.initialBytes);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('ZCode existing-desktop enrollment rejects failed peer close and preserves prior binding bytes', async () => {
  const f = await zcodeFixture();
  const options = desktopEnrollmentOptions(f, { peer: fakeDesktopPeer(undefined, new Error('exit was not confirmed')) });
  try {
    await assert.rejects(runZCodeDesktopBindingVerification(zcodeModel.id, options));
    assert.equal(options.peer.closeCount, 1);
    assert.equal(await readFile(f.config.path, 'utf8'), f.initialBytes);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('ZCode existing-desktop enrollment rejects a post-session CLI version change', async () => {
  const f = await zcodeFixture();
  let probeCount = 0;
  const options = desktopEnrollmentOptions(f, { version: () => (++probeCount === 1 ? 'zcode-desktop-test-2' : 'zcode-desktop-test-3') });
  try {
    await assert.rejects(runZCodeDesktopBindingVerification(zcodeModel.id, options), /probe changed/);
    assert.equal(probeCount, 2);
    assert.equal(options.peer.closeCount, 1);
    assert.equal(await readFile(f.config.path, 'utf8'), f.initialBytes);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

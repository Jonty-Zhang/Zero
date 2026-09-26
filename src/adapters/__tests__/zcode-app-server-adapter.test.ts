import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunRequest } from '../../domain/types.js';
import type { ModelBinding } from '../types.js';
import { ZCodeAppServerAdapter } from '../zcode-app-server-adapter.js';
import type { ProbeCommandResult } from '../zcode-app-server-adapter.js';
import type { ZCodeAppServerDiagnosticEvent, ZCodeAppServerPeerOptions } from '../zcode-app-server-peer.js';
import type { ZCodeProtocolPeer } from '../zcode-protocol-session.js';

const binding = (overrides: Record<string, unknown> = {}): ModelBinding => ({
  harness: 'zcode',
  selector: 'app_server_existing_desktop',
  model: { id: 'glm-flash', provider: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash' },
  verified: true,
  verificationSource: 'smoke_test',
  verifiedCliVersion: '0.16.9',
  verificationEvidence: {
    kind: 'selector_only',
    verifiedAt: '2026-09-25T00:00:00.000Z',
    providerId: 'account:zai-start-plan',
    modelId: 'GLM-5.3-Flash',
    cliVersion: '0.16.9',
  },
  ...overrides,
} as ModelBinding);

const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  taskId: 'task-7',
  attemptId: 'attempt-2',
  role: 'implement',
  cwd: 'C:/zero/worktrees/task-7',
  prompt: 'Change the requested file.',
  harness: 'zcode',
  model: 'glm-flash',
  ...overrides,
});

function probeCommand(version = '0.16.9', help = 'Usage: zcode [options]\n  app-server') {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<ProbeCommandResult> => {
    calls.push([...args]);
    if (args[0] === '--version') return { code: 0, stdout: version, stderr: '' };
    if (args[0] === '--help') return { code: 0, stdout: help, stderr: '' };
    return { code: 2, stdout: '', stderr: '' };
  };
  return { calls, run };
}

function fakePeer(options: { blockAfterStart?: boolean; turnFailure?: unknown; closeError?: Error } = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let closed = false;
  let sendStarted!: () => void;
  const sendObserved = new Promise<void>(resolve => { sendStarted = resolve; });
  let turnStarted!: () => void;
  const turnObserved = new Promise<void>(resolve => { turnStarted = resolve; });
  const peer: ZCodeProtocolPeer = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session/create') return {
        session: { sessionId: 's-app-server-test' },
        settings: { model: { available: [{ ref: { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash' } }] } },
      };
      if (method === 'v4/command') {
        if (params.type === 'stop') return { status: 'accepted', commandId: params.commandId };
        if (params.type === 'sendText') sendStarted();
        return {
          status: 'accepted', commandId: params.commandId,
          result: { type: 'inputAccepted', delivery: 'startNow', inputId: params.commandId },
        };
      }
      if (method === 'session/events') {
        const inputId = calls.find(call => call.method === 'v4/command' && call.params.type === 'sendText')?.params.commandId;
        if (options.turnFailure !== undefined) return { events: [
          { seq: 1, type: 'turn.failed', turnId: 'turn-1', payload: { inputId, error: options.turnFailure } },
        ] };
        if (options.blockAfterStart) {
          const firstPoll = calls.filter(call => call.method === 'session/events').length === 1;
          if (firstPoll) turnStarted();
          return { events: firstPoll
            ? [{ seq: 1, type: 'turn.started', turnId: 'turn-1', payload: { inputId, foregroundExecutionId: 'exec-1' } }]
            : [] };
        }
        return { events: [
          { seq: 1, type: 'turn.started', turnId: 'turn-1', payload: { inputId, foregroundExecutionId: 'exec-1' } },
          { seq: 2, type: 'turn.completed', turnId: 'turn-1', payload: { inputId, resultType: 'success', response: 'done' } },
        ] };
      }
      return {};
    },
    async readPendingInteractions() { return []; },
    async close() { closed = true; if (options.closeError) throw options.closeError; },
  };
  return { peer, calls, sendObserved, turnObserved, isClosed: () => closed };
}

function adapterHarness(options: { version?: string; bindings?: ModelBinding[]; peer?: ReturnType<typeof fakePeer>; help?: string } = {}) {
  const cli = probeCommand(options.version, options.help);
  const peer = options.peer ?? fakePeer();
  let launchOptions: ZCodeAppServerPeerOptions | undefined;
  const adapter = new ZCodeAppServerAdapter({
    zcodeEntry: 'C:/tools/zcode/cli.mjs',
    bindings: options.bindings ?? [binding()],
    timeoutMs: 2_000,
    runProbeCommand: cli.run,
    launchPeer: async value => { launchOptions = value; return peer.peer; },
  });
  return { adapter, peer, cli, launchOptions: () => launchOptions };
}

test('probe is limited to help/version and reports only version-matched selector bindings', async () => {
  const cli = probeCommand();
  let launches = 0;
  const adapter = new ZCodeAppServerAdapter({
    zcodeEntry: 'C:/tools/zcode/cli.mjs',
    bindings: [binding()],
    runProbeCommand: cli.run,
    launchPeer: async () => { launches += 1; throw new Error('probe must not launch app-server'); },
  });

  const result = await adapter.probe();

  assert.deepEqual(cli.calls, [['--version'], ['--help']]);
  assert.equal(launches, 0);
  assert.equal(result.available, true);
  assert.deepEqual(result.models, ['glm-flash']);
  assert.equal(result.probeEvidence?.authentication, 'not_checked');
  assert.equal(result.probeEvidence?.modelSmokeTest, 'not_checked');
});

test('desktop diagnostic reports lifecycle categories and a model count without identities', async () => {
  const cli = probeCommand();
  const calls: string[] = [];
  let closed = false;
  const secret = 'fake-provider-key-diagnostic-test';
  const adapter = new ZCodeAppServerAdapter({
    zcodeEntry: 'C:/tools/zcode/cli.mjs',
    runProbeCommand: cli.run,
    launchPeer: async () => ({
      async request(method) {
        calls.push(method);
        return {
          session: { sessionId: 'session-secret-id' },
          settings: { model: { available: [
            { ref: { providerId: secret, modelId: 'private-model-name' } },
            { ref: { providerId: 'private-provider-name', modelId: 'private-model-name-2' } },
          ] } },
        };
      },
      async readPendingInteractions() { throw new Error('diagnostic must not inspect interactions'); },
      async close() { closed = true; },
    }),
  });

  const diagnostic = await adapter.diagnoseExistingDesktop('C:/zero/worktree');
  const stdout = `${JSON.stringify(diagnostic)}\n`;
  const stderr = '';

  assert.deepEqual(diagnostic, {
    version: 'reported', childSpawn: 'started', sessionCreate: 'acknowledged',
    failureStage: 'none',
    preferenceAckFailure: 'none',
    preferenceAckRpcFailure: 'not_applicable',
    modelRegistry: 'populated', modelCount: 2,
  });
  assert.deepEqual(calls, ['session/create']);
  assert.equal(closed, true);
  assert.equal(stdout.includes(secret), false);
  assert.equal(stdout.includes('private-model-name'), false);
  assert.equal(stdout.includes('session-secret-id'), false);
  assert.equal(stderr.includes(secret), false);
});

test('desktop diagnostic converts child launch errors with fake credentials to fixed categories', async () => {
  const secret = 'fake-provider-key-never-print-this';
  const cli = probeCommand();
  const adapter = new ZCodeAppServerAdapter({
    zcodeEntry: 'C:/tools/zcode/cli.mjs',
    runProbeCommand: cli.run,
    launchPeer: async () => { throw new Error(`spawn failed with ${secret}`); },
  });

  const diagnostic = await adapter.diagnoseExistingDesktop('C:/zero/worktree');
  const stdout = `${JSON.stringify(diagnostic)}\n`;
  const stderr = '';

  assert.deepEqual(diagnostic, {
    version: 'reported', childSpawn: 'failed', sessionCreate: 'not_run',
    failureStage: 'launch',
    preferenceAckFailure: 'none',
    preferenceAckRpcFailure: 'not_applicable',
    modelRegistry: 'not_checked', modelCount: null,
  });
  assert.equal(stdout.includes(secret), false);
  assert.equal(stderr.includes(secret), false);
});

test('desktop diagnostic maps safe peer events to categorical failure stages', async () => {
  const cli = probeCommand();
  const cases: Array<{
    event: ZCodeAppServerDiagnosticEvent;
    response?: unknown;
    failureStage: 'preference_ack' | 'session_create' | 'response_shape';
    preferenceAckFailure: 'none' | 'rpc_failed' | 'ack_invalid';
    preferenceAckRpcFailure: 'not_applicable' | 'method_not_found' | 'invalid_params' | 'other_protocol_error' | 'no_code';
  }> = [
    { event: { stage: 'preference_ack', outcome: 'failed', code: 'ack_invalid', elapsedMs: 2 }, failureStage: 'preference_ack', preferenceAckFailure: 'ack_invalid', preferenceAckRpcFailure: 'not_applicable' },
    { event: { stage: 'preference_ack', outcome: 'failed', code: 'rpc_failed', rpcErrorCategory: 'method_not_found', elapsedMs: 3 }, failureStage: 'preference_ack', preferenceAckFailure: 'rpc_failed', preferenceAckRpcFailure: 'method_not_found' },
    { event: { stage: 'preference_ack', outcome: 'failed', code: 'rpc_failed', rpcErrorCategory: 'invalid_params', elapsedMs: 4 }, failureStage: 'preference_ack', preferenceAckFailure: 'rpc_failed', preferenceAckRpcFailure: 'invalid_params' },
    { event: { stage: 'preference_ack', outcome: 'failed', code: 'rpc_failed', rpcErrorCategory: 'other_protocol_error', elapsedMs: 5 }, failureStage: 'preference_ack', preferenceAckFailure: 'rpc_failed', preferenceAckRpcFailure: 'other_protocol_error' },
    { event: { stage: 'preference_ack', outcome: 'failed', code: 'rpc_failed', rpcErrorCategory: 'no_code', elapsedMs: 6 }, failureStage: 'preference_ack', preferenceAckFailure: 'rpc_failed', preferenceAckRpcFailure: 'no_code' },
    { event: { stage: 'session_create_rpc', outcome: 'failed', code: 'rpc_failed', elapsedMs: 7 }, failureStage: 'session_create', preferenceAckFailure: 'none', preferenceAckRpcFailure: 'not_applicable' },
    { event: { stage: 'session_create_rpc', outcome: 'failed', code: 'response_invalid', elapsedMs: 8 }, response: { session: {} }, failureStage: 'response_shape', preferenceAckFailure: 'none', preferenceAckRpcFailure: 'not_applicable' },
  ];

  for (const current of cases) {
    const secret = 'CANARY_PRIVATE_ERROR_TEXT';
    const adapter = new ZCodeAppServerAdapter({
      zcodeEntry: 'C:/tools/zcode/cli.mjs',
      runProbeCommand: cli.run,
      launchPeer: async options => {
        options.onDiagnostic?.(current.event);
        return {
          async request() {
            if (current.response !== undefined) return current.response;
            throw new Error(secret);
          },
          async readPendingInteractions() { return []; },
          async close() {},
        };
      },
    });

    const diagnostic = await adapter.diagnoseExistingDesktop('C:/zero/worktree');
    assert.equal(diagnostic.failureStage, current.failureStage);
    assert.equal(diagnostic.preferenceAckFailure, current.preferenceAckFailure);
    assert.equal(diagnostic.preferenceAckRpcFailure, current.preferenceAckRpcFailure);
    assert.equal(JSON.stringify(diagnostic).includes(secret), false);
  }
});

test('run uses the exact provider/model in one existing-desktop task-worktree session and reports selector_only', async () => {
  const state = adapterHarness();
  const result = await state.adapter.run(request());

  assert.equal(result.status, 'completed');
  assert.equal(result.final, 'done');
  assert.equal(result.actualModel, undefined);
  assert.equal(result.metadata?.modelVerification, 'selector_only');
  assert.deepEqual(state.cli.calls, [['--version'], ['--help']]);
  assert.equal(state.launchOptions()?.profileMode, 'existing-desktop');
  assert.equal(state.launchOptions()?.taskWorktree, 'C:/zero/worktrees/task-7');
  assert.deepEqual(state.peer.calls.map(call => call.method), ['session/create', 'v4/command', 'session/events']);
  const create = state.peer.calls[0]!;
  assert.equal(create.params.persistence, 'deferred');
  const send = state.peer.calls[1]!;
  assert.deepEqual((send.params.payload as Record<string, unknown>).modelSelection, {
    providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash',
  });
  assert.equal(state.peer.isClosed(), true);
});

test('a structured temporal usage limit becomes a quota result after confirmed peer close', async () => {
  const retryAt = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
  const peer = fakePeer({ turnFailure: { message: `You've hit your usage limit. Try again at ${retryAt}` } });
  const state = adapterHarness({ peer });
  const result = await state.adapter.run(request());

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.quota, { source: 'provider_message', retryAt });
  assert.match(result.error ?? '', /usage limit reached/);
  assert.ok(!result.error?.includes(retryAt));
  assert.equal(peer.isClosed(), true);
});

test('quota-like peer close failures and transient turn errors remain ordinary failures', async () => {
  const uncertainClose = fakePeer({
    turnFailure: { message: "You've hit your usage limit" },
    closeError: new Error("peer close: you've hit your usage limit"),
  });
  const closeResult = await adapterHarness({ peer: uncertainClose }).adapter.run(request());
  assert.equal(closeResult.status, 'failed');
  assert.equal(closeResult.quota, undefined);
  assert.equal(closeResult.error, 'ZCode app-server execution failed; protocol logs were not retained');

  for (const message of ['authentication failed', 'network connection reset', 'provider rate limit exceeded']) {
    const peer = fakePeer({ turnFailure: { message } });
    const result = await adapterHarness({ peer }).adapter.run(request());
    assert.equal(result.status, 'failed', message);
    assert.equal(result.quota, undefined, message);
    assert.equal(result.error, 'ZCode app-server execution failed; protocol logs were not retained');
    assert.equal(peer.isClosed(), true);
  }
});

test('run fails closed before launch for inconsistent binding evidence, unsafe identity, or version mismatch', async () => {
  const badEvidence = binding({ verificationEvidence: { kind: 'selector_only', verifiedAt: 'bad', providerId: 'other', modelId: 'GLM-5.3-Flash', cliVersion: '0.16.9' } });
  const badIdentity = binding({ model: { id: 'glm-flash', provider: 'account:zai-start-plan\nsecret', modelId: 'GLM-5.3-Flash' } });
  for (const configured of [badEvidence, badIdentity]) {
    const state = adapterHarness({ bindings: [configured] });
    const result = await state.adapter.run(request());
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /unverified|inconsistent/);
    assert.equal(state.launchOptions(), undefined);
  }
  const mismatch = adapterHarness({ version: '0.16.10' });
  const result = await mismatch.adapter.run(request());
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /version/);
  assert.equal(mismatch.launchOptions(), undefined);
});

test('run rejects duplicate binding identities and unverified reasoning requests', async () => {
  const duplicate = adapterHarness({ bindings: [binding(), binding({ model: { id: 'other-id', provider: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash' } })] });
  assert.equal((await duplicate.adapter.run(request({ model: 'GLM-5.3-Flash' }))).status, 'failed');
  assert.equal(duplicate.launchOptions(), undefined);

  const noReasoning = adapterHarness();
  const result = await noReasoning.adapter.run(request({ reasoningEffort: 'high' }));
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /reasoning effort/);
  assert.equal(noReasoning.launchOptions(), undefined);
});

test('cancel sends only the observed foreground stop and closes the app-server peer', async () => {
  const peer = fakePeer({ blockAfterStart: true });
  const state = adapterHarness({ peer });
  const run = state.adapter.run(request());
  await peer.sendObserved;
  await peer.turnObserved;
  await new Promise(resolve => setTimeout(resolve, 0));
  await state.adapter.cancel('task-7', 'attempt-2');
  const result = await run;

  assert.equal(result.status, 'cancelled');
  const stop = peer.calls.find(call => call.method === 'v4/command' && call.params.type === 'stop');
  assert.equal((stop?.params.payload as Record<string, unknown>).expectedForegroundExecutionId, 'exec-1');
  assert.equal(peer.isClosed(), true);
});

test('protocol timeout is reported as timed_out and closes the peer', async () => {
  const peer = fakePeer({ blockAfterStart: true });
  const state = adapterHarness({ peer });
  const adapter = new ZCodeAppServerAdapter({
    zcodeEntry: 'C:/tools/zcode/cli.mjs', bindings: [binding()], timeoutMs: 1,
    runProbeCommand: state.cli.run,
    launchPeer: async () => peer.peer,
  });

  const result = await adapter.run(request());

  assert.equal(result.status, 'timed_out');
  assert.equal(peer.isClosed(), true);
});

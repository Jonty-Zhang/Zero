import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZCodeAppServerPeer } from '../zcode-app-server-peer.js';
import type { ZCodeAppServerDiagnosticEvent } from '../zcode-app-server-peer.js';

const SERVER_SOURCE = String.raw`
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
process.stderr.write('prompt=CANARY_STDERR token=CANARY_TOKEN config=CANARY_CONFIG profile=C:/private/profile proxy=http://private-proxy.invalid');
let mode = 'normal';
let keepAlive;
const seenMethods = [];
let runtimePreferenceResponse;
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
const respond = (id, result) => write({ id, result });
const snapshotWire = (subscriptionId, pendingInteractions, options = {}) => ({
  wireVersion: 3,
  kind: 'complete',
  deliveryKind: 'initial',
  logicalFrameId: 'frame-initial',
  logicalFrameOrdinal: 1,
  topic: 'conversation/session-one',
  subscriptionId,
  frame: {
    topic: 'conversation/session-one',
    subscriptionId,
    fromSeq: 0,
    toSeq: 0,
    sentAt: Date.now(),
    payload: {
      kind: 'snapshot',
      snapshot: {
        protocolVersion: 1,
        sessionId: 'session-one',
        logEpoch: 'epoch-one',
        seq: 0,
        ...(options.malformed ? {} : { pendingInteractions }),
      },
    },
  },
});
const deltaWire = (subscriptionId, pendingInteractions, fromSeq = 0, toSeq = 1) => ({
  wireVersion: 3,
  kind: 'complete',
  deliveryKind: 'online',
  logicalFrameId: 'frame-delta',
  logicalFrameOrdinal: 2,
  topic: 'conversation/session-one',
  subscriptionId,
  frame: {
    topic: 'conversation/session-one',
    subscriptionId,
    fromSeq,
    toSeq,
    sentAt: Date.now(),
    payload: {
      kind: 'deltas',
      deltas: [{ op: 'state.updated', patch: { pendingInteractions } }],
    },
  },
});
rl.on('line', raw => {
  const request = JSON.parse(raw);
  if (Object.hasOwn(request, 'error')) {
    return;
  }
  if (Object.hasOwn(request, 'result') && !Object.hasOwn(request, 'method')) {
    runtimePreferenceResponse = request.result;
    return;
  }
  const { id, method, params = {} } = request;
  if (typeof method === 'string') seenMethods.push(method);
  if (Object.hasOwn(request, 'jsonrpc')) {
    write({ id, error: { code: -32600, message: 'Must use the app-server envelope' } });
    return;
  }
  if (method === 'session/create') {
    write({ id: 'runtime-pref-request', method: 'session/requestRuntimePreferences', params: {
      sessionId: 'session-one', scope: 'runtime-materialization',
    } });
    respond(id, mode === 'session-bad' ? { session: {} } : { session: { sessionId: 'session-one' } });
    return;
  }
  if (method === 'workspace/updateInteractionPreferences') {
    if (mode.startsWith('pref-error')) {
      const codes = {
        'pref-error': 777,
        'pref-error-method-not-found': -32601,
        'pref-error-invalid-params': -32602,
      };
      const code = codes[mode];
      write({ id, error: { ...(code === undefined ? {} : { code }), message: 'prompt=CANARY_PROMPT token=CANARY_TOKEN config=CANARY_CONFIG profile=C:/private/profile proxy=http://private-proxy.invalid' } });
      return;
    }
    if (mode === 'pref-malformed') {
      respond(id, {});
      return;
    }
    respond(id, {
      workspace: params.workspace,
      askUserQuestionAutoResolutionEnabled: mode === 'pref-bad',
      snoozedInteractionCount: 0,
    });
    return;
  }
  if (method === 'v4/conversation/subscribe') {
    if (mode === 'subscribe-malformed') {
      respond(id, { ack: null });
      return;
    }
    if (params.topic !== 'conversation/session-one' || !params.connectionId || params.clientMode !== 'desktop-continuous') {
      respond(id, { ack: {} });
      return;
    }
    const ack = { id, result: { ack: { subscriptionId: 'sub-one', mode: 'snapshot', logEpoch: 'epoch-one' } } };
    const initialFrame = {
      method: 'v4/conversation/frame',
      params: snapshotWire('sub-one', mode === 'pending' ? [{
        interactionId: 'interaction-one', kind: 'permission', anchorRowId: null, createdAt: 1,
        payload: { kind: 'permission', toolCallId: 'tool-one', toolName: 'Write', summary: 'Write file', detail: {}, options: [] },
      }] : [], { malformed: mode === 'malformed' }),
    };
    if (mode === 'same-chunk') process.stdout.write(JSON.stringify(ack) + '\n' + JSON.stringify(initialFrame) + '\n');
    else {
      respond(id, { ack: { subscriptionId: 'sub-one', mode: 'snapshot', logEpoch: 'epoch-one' } });
      if (mode !== 'silent') setTimeout(() => write(initialFrame), 1);
    }
    return;
  }
  if (method === 'test/set-mode') {
    mode = params.mode;
    if (mode === 'ignore-close') keepAlive = setInterval(() => {}, 1_000);
    respond(id, { ok: true });
    return;
  }
  if (method === 'test/delta') {
    respond(id, { ok: true });
    setTimeout(() => write({ method: 'v4/conversation/frame', params: deltaWire('sub-one', params.pendingInteractions) }), 1);
    return;
  }
  if (method === 'test/gap') {
    respond(id, { ok: true });
    setTimeout(() => write({ method: 'v4/conversation/frame', params: deltaWire('sub-one', [], 7, 8) }), 1);
    return;
  }
  if (method === 'test/wrong-id') {
    write({ id: 'unexpected-id', result: { ok: true } });
    return;
  }
  if (method === 'test/reverse') {
    write({ id: 'reverse-request', method: 'interaction/requestPermission', params: { sessionId: 'session-one', toolName: 'Write' } });
    respond(id, { ok: true });
    return;
  }
  if (method === 'test/reverse-runtime-invalid') {
    write({ id: 'reverse-runtime-invalid', method: 'session/requestRuntimePreferences', params: {
      sessionId: 'session-one', scope: 'unexpected-scope',
    } });
    respond(id, { ok: true });
    return;
  }
  if (method === 'test/env') {
    respond(id, {
      dataBaseDir: process.env.ZCODE_DATA_BASE_DIR,
      hasUserHome: Boolean(process.env.USERPROFILE || process.env.HOME),
      hasZcodeHome: Boolean(process.env.ZCODE_HOME),
      hasSecret: Boolean(process.env.ZERO_PEER_TEST_SECRET),
      hasDesktopProfile: Boolean(process.env.APPDATA && process.env.LOCALAPPDATA && process.env.USERPROFILE),
      hasProxy: Boolean(process.env.HTTP_PROXY && process.env.HTTPS_PROXY && process.env.ALL_PROXY && process.env.NO_PROXY),
      appServerArg: process.argv[2],
    });
    return;
  }
  if (method === 'test/methods') {
    respond(id, { methods: seenMethods });
    return;
  }
  if (method === 'test/runtime-pref-response') {
    respond(id, { preferences: runtimePreferenceResponse });
    return;
  }
  if (method === 'test/slow') return setTimeout(() => respond(id, { value: 'slow' }), 35);
  if (method === 'test/fast') return setTimeout(() => respond(id, { value: 'fast' }), 1);
  if (method === 'test/hang') return;
  if (method === 'test/destroy-stdin') {
    respond(id, { ok: true });
    mode = 'ignore-close';
    keepAlive = setInterval(() => {}, 1_000);
    setTimeout(() => process.stdin.destroy(), 5);
    return;
  }
  respond(id, { ok: true });
});
rl.on('close', () => {
  if (mode === 'delayed-close') setTimeout(() => process.exit(0), 350);
});
`;

async function withFakeServer<T>(run: (peer: ZCodeAppServerPeer, dirs: { root: string; worktree: string; dataBaseDir: string }) => Promise<T>, onDiagnostic?: (event: ZCodeAppServerDiagnosticEvent) => void): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'zero-zcode-peer-'));
  const worktree = join(root, 'task-worktree');
  const dataBaseDir = join(root, 'isolated-zcode-data');
  await mkdir(worktree);
  const entry = join(root, 'fake-app-server.mjs');
  await writeFile(entry, SERVER_SOURCE, 'utf8');
  const peer = await ZCodeAppServerPeer.launch({
    entry,
    taskWorktree: worktree,
    profileMode: 'isolated',
    zeroDataRoot: root,
    dataBaseDir,
    requestTimeoutMs: 1_000,
    initialFrameTimeoutMs: 150,
    onDiagnostic,
  });
  try {
    return await run(peer, { root, worktree, dataBaseDir });
  } finally {
    try { await peer.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}

async function createSession(peer: ZCodeAppServerPeer): Promise<void> {
  const result = await peer.request('session/create', {
    workspace: { workspacePath: 'C:/zero/task-worktree', workspaceIdentity: 'C:/zero/task-worktree', workspaceKey: 'task-one' },
    persistence: 'deferred',
  }) as { session?: { sessionId?: string } };
  assert.equal(result.session?.sessionId, 'session-one');
}

// Bypass the production method allowlist only for fake-process control and inspection.
function debugRequest(peer: ZCodeAppServerPeer, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return (peer as unknown as { requestRaw(method: string, params: Record<string, unknown>): Promise<unknown> })
    .requestRaw(method, params);
}

test('public request rejects raw session send/stop and arbitrary methods', async () => {
  await withFakeServer(async peer => {
    for (const method of ['session/send', 'session/stop', 'arbitrary/private-method']) {
      await assert.rejects(peer.request(method, {}), /unsupported method/);
    }
  });
});

test('stdio peer matches out-of-order RPC responses and uses isolated env/absolute entry', async () => {
  const oldSecret = process.env.ZERO_PEER_TEST_SECRET;
  process.env.ZERO_PEER_TEST_SECRET = 'not-forwarded';
  try {
    await withFakeServer(async (peer, dirs) => {
      const [slow, fast, env] = await Promise.all([
        debugRequest(peer, 'test/slow', {}),
        debugRequest(peer, 'test/fast', {}),
        debugRequest(peer, 'test/env', {}),
      ]) as [{ value: string }, { value: string }, Record<string, unknown>];
      assert.equal(slow.value, 'slow');
      assert.equal(fast.value, 'fast');
      assert.equal(env.dataBaseDir, dirs.dataBaseDir);
      assert.equal(env.hasUserHome, false);
      assert.equal(env.hasZcodeHome, false);
      assert.equal(env.hasSecret, false);
      assert.equal(env.appServerArg, 'app-server');
    });
  } finally {
    if (oldSecret === undefined) delete process.env.ZERO_PEER_TEST_SECRET;
    else process.env.ZERO_PEER_TEST_SECRET = oldSecret;
  }
});

test('session creation requires confirmed auto-resolution disablement before sendText', async () => {
  await withFakeServer(async peer => {
    const createParams = {
      workspace: { workspacePath: 'C:/zero/task-worktree', workspaceIdentity: 'C:/zero/task-worktree', workspaceKey: 'task-one' },
      persistence: 'deferred',
    };
    await assert.rejects(peer.request('session/create', { ...createParams, firstInput: 'execute early' }), /gated deferred task-session schema/);
    await assert.rejects(peer.request('v4/command', {
      commandId: 'input-one', clientId: 'client-one', sessionId: 'session-one', type: 'sendText', payload: {}, issuedAt: 1,
    }), /interaction-gated task session/);
    await createSession(peer);
    const { methods } = await debugRequest(peer, 'test/methods', {}) as { methods: string[] };
    assert.ok(methods.indexOf('workspace/updateInteractionPreferences') < methods.indexOf('session/create'));
    const { preferences } = await debugRequest(peer, 'test/runtime-pref-response', {}) as { preferences: Record<string, unknown> };
    assert.deepEqual(preferences, {
      nativeSearchEnhancementsEnabled: false,
      memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: false,
      modelContextBudgetStrategy: 'preflight-v1',
    });
    const sendParams = {
      commandId: 'input-one', clientId: 'client-one', sessionId: 'session-one', type: 'sendText',
      payload: {
        text: 'No model call in this fake peer test', requestedDelivery: 'startNow',
        modelSelection: { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash' },
        modelExecution: {
          selectionScope: 'execution', memoryExtraction: 'skip',
          subagents: { foregroundModel: 'submission', background: 'deny' },
        },
      },
      issuedAt: 1,
    };
    assert.equal(await peer.request('v4/command', sendParams).then(() => 'sent'), 'sent');
    await assert.rejects(peer.request('v4/command', {
      ...sendParams,
      commandId: 'input-two',
      payload: { ...sendParams.payload, modelExecution: { selectionScope: 'turn' } },
    }), /execution-scoped model/);
  });

  await withFakeServer(async peer => {
    await debugRequest(peer, 'test/set-mode', { mode: 'pref-bad' });
    await assert.rejects(createSession(peer), /auto-resolution disablement was not confirmed/);
    const { methods } = await debugRequest(peer, 'test/methods', {}) as { methods: string[] };
    assert.equal(methods.includes('session/create'), false);
  });
});

test('diagnostics expose bounded safe lifecycle enums and omit RPC text and user supplied data', async () => {
  const events: ZCodeAppServerDiagnosticEvent[] = [];
  await withFakeServer(async peer => {
    await createSession(peer);
    assert.deepEqual(await peer.readPendingInteractions('session-one'), []);
  }, event => events.push(event));

  assert.ok(events.some(event => event.stage === 'launch' && event.outcome === 'acknowledged'));
  assert.ok(events.some(event => event.stage === 'preference_ack' && event.outcome === 'acknowledged'));
  assert.ok(events.some(event => event.stage === 'session_create_rpc' && event.outcome === 'acknowledged'));
  assert.ok(events.some(event => event.stage === 'subscribe_ack' && event.outcome === 'acknowledged'));
  assert.ok(events.some(event => event.stage === 'child_exit' && event.outcome === 'exited'));
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), [
      ...(event.code === undefined ? [] : ['code']),
      ...(event.rpcErrorCategory === undefined ? [] : ['rpcErrorCategory']),
      'elapsedMs', 'outcome', 'stage',
    ].sort());
    assert.equal(Number.isInteger(event.elapsedMs), true);
    assert.ok(Number(event.elapsedMs) >= 0 && Number(event.elapsedMs) <= 86_400_000);
  }

  const failedEvents: ZCodeAppServerDiagnosticEvent[] = [];
  await withFakeServer(async peer => {
    await debugRequest(peer, 'test/set-mode', { mode: 'pref-error' });
    await assert.rejects(createSession(peer));
  }, event => failedEvents.push(event));
  assert.ok(failedEvents.some(event => event.stage === 'preference_ack' && event.outcome === 'failed' && event.code === 'rpc_failed'));
  const malformedPreferenceEvents: ZCodeAppServerDiagnosticEvent[] = [];
  await withFakeServer(async peer => {
    await debugRequest(peer, 'test/set-mode', { mode: 'pref-malformed' });
    await assert.rejects(createSession(peer), /preference ACK was malformed/);
  }, event => malformedPreferenceEvents.push(event));
  assert.ok(malformedPreferenceEvents.some(event => event.stage === 'preference_ack' && event.outcome === 'failed' && event.code === 'ack_invalid'));

  const invalidSubscriptionEvents: ZCodeAppServerDiagnosticEvent[] = [];
  await withFakeServer(async peer => {
    await createSession(peer);
    await debugRequest(peer, 'test/set-mode', { mode: 'subscribe-malformed' });
    await assert.rejects(peer.readPendingInteractions('session-one'), /invalid initial snapshot ACK/);
  }, event => invalidSubscriptionEvents.push(event));
  assert.ok(invalidSubscriptionEvents.some(event => event.stage === 'subscribe_ack' && event.outcome === 'failed' && event.code === 'ack_invalid'));

  const invalidSessionEvents: ZCodeAppServerDiagnosticEvent[] = [];
  await withFakeServer(async peer => {
    await debugRequest(peer, 'test/set-mode', { mode: 'session-bad' });
    const result = await peer.request('session/create', {
      workspace: { workspacePath: 'C:/zero/task-worktree', workspaceIdentity: 'C:/zero/task-worktree', workspaceKey: 'task-one' },
      persistence: 'deferred',
    });
    assert.deepEqual(result, { session: {} });
  }, event => invalidSessionEvents.push(event));
  assert.ok(invalidSessionEvents.some(event => event.stage === 'session_create_rpc' && event.outcome === 'failed' && event.code === 'response_invalid'));

  const timeoutEvents: ZCodeAppServerDiagnosticEvent[] = [];
  await withFakeServer(async peer => {
    await debugRequest(peer, 'test/set-mode', { mode: 'silent' });
    await createSession(peer);
    await assert.rejects(peer.readPendingInteractions('session-one'), /conversation snapshot timed out/);
  }, event => timeoutEvents.push(event));
  assert.ok(timeoutEvents.some(event => event.stage === 'initial_frame_timeout' && event.outcome === 'timeout' && event.code === 'initial_frame_timeout'));

  const diagnosticText = JSON.stringify([...events, ...failedEvents, ...malformedPreferenceEvents, ...invalidSubscriptionEvents, ...invalidSessionEvents, ...timeoutEvents]);
  for (const canary of ['CANARY_PROMPT', 'CANARY_STDERR', 'CANARY_TOKEN', 'CANARY_CONFIG', 'C:/private/profile', 'private-proxy.invalid']) {
    assert.equal(diagnosticText.includes(canary), false);
  }
});

test('preference RPC failures expose only fixed JSON-RPC numeric-code categories', async () => {
  const cases = [
    ['pref-error-method-not-found', 'method_not_found'],
    ['pref-error-invalid-params', 'invalid_params'],
    ['pref-error', 'other_protocol_error'],
    ['pref-error-no-code', 'no_code'],
  ] as const;

  for (const [mode, category] of cases) {
    const events: ZCodeAppServerDiagnosticEvent[] = [];
    await withFakeServer(async peer => {
      await debugRequest(peer, 'test/set-mode', { mode });
      await assert.rejects(createSession(peer));
    }, event => events.push(event));

    const event = events.find(candidate => candidate.stage === 'preference_ack' && candidate.outcome === 'failed');
    assert.equal(event?.code, 'rpc_failed');
    assert.equal(event?.rpcErrorCategory, category);
    const serialized = JSON.stringify(events);
    for (const canary of ['CANARY_PROMPT', 'CANARY_TOKEN', 'CANARY_CONFIG', 'C:/private/profile', 'private-proxy.invalid', '-32601', '-32602', '777']) {
      assert.equal(serialized.includes(canary), false);
    }
  }
});

test('existing-desktop mode forwards only profile location and proxy variables without overriding the data root', async () => {
  const keys = ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'ZCODE_DATA_BASE_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    APPDATA: 'C:/zero-safe-test/appdata',
    LOCALAPPDATA: 'C:/zero-safe-test/localappdata',
    USERPROFILE: 'C:/zero-safe-test/profile',
    HOME: 'C:/zero-safe-test/home',
    ZCODE_DATA_BASE_DIR: 'C:/zero-safe-test/custom-zcode-data',
    HTTP_PROXY: 'http://proxy.example.invalid:8080',
    HTTPS_PROXY: 'http://proxy.example.invalid:8080',
    ALL_PROXY: 'http://proxy.example.invalid:8080',
    NO_PROXY: 'localhost',
  });
  try {
    const root = await mkdtemp(join(tmpdir(), 'zero-zcode-peer-desktop-'));
    const worktree = join(root, 'task-worktree');
    await mkdir(worktree);
    const entry = join(root, 'fake-app-server.mjs');
    await writeFile(entry, SERVER_SOURCE, 'utf8');
    const peer = await ZCodeAppServerPeer.launch({ entry, taskWorktree: worktree, profileMode: 'existing-desktop' });
    try {
      const env = await debugRequest(peer, 'test/env', {}) as Record<string, unknown>;
      assert.equal(env.dataBaseDir, 'C:/zero-safe-test/custom-zcode-data');
      assert.equal(env.hasDesktopProfile, true);
      assert.equal(env.hasProxy, true);
      assert.equal(env.hasZcodeHome, false);
    } finally {
      await peer.close();
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('v4 conversation subscription requires and tracks initial snapshot plus pending interaction deltas', async () => {
  await withFakeServer(async peer => {
    await createSession(peer);
    assert.deepEqual(await peer.readPendingInteractions('session-one'), []);
    await debugRequest(peer, 'test/delta', {
      pendingInteractions: [{ interactionId: 'interaction-delta', kind: 'userInput', anchorRowId: null,
        createdAt: 2, payload: { kind: 'userInput', prompt: 'Choose', freeText: false } }],
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(await peer.readPendingInteractions('session-one'), [
      { interactionId: 'interaction-delta', kind: 'userInput', anchorRowId: null,
        createdAt: 2, payload: { kind: 'userInput', prompt: 'Choose', freeText: false } },
    ]);
  });
});

test('initial snapshot is buffered when subscribe ACK and frame share an NDJSON chunk', async () => {
  await withFakeServer(async peer => {
    await createSession(peer);
    await debugRequest(peer, 'test/set-mode', { mode: 'same-chunk' });
    assert.deepEqual(await peer.readPendingInteractions('session-one'), []);
  });
});

test('invalid snapshot and missing initial notification fail closed', async () => {
  await withFakeServer(async peer => {
    await debugRequest(peer, 'test/set-mode', { mode: 'malformed' });
    await createSession(peer);
    await assert.rejects(peer.readPendingInteractions('session-one'), /snapshot lacks.*pendingInteractions/);
  });

  await withFakeServer(async peer => {
    await debugRequest(peer, 'test/set-mode', { mode: 'silent' });
    await createSession(peer);
    await assert.rejects(peer.readPendingInteractions('session-one'), /conversation snapshot timed out/);
  });

  await withFakeServer(async peer => {
    await debugRequest(peer, 'test/set-mode', { mode: 'pending' });
    await createSession(peer);
    assert.deepEqual(await peer.readPendingInteractions('session-one'), [{
      interactionId: 'interaction-one', kind: 'permission', anchorRowId: null, createdAt: 1,
      payload: { kind: 'permission', toolCallId: 'tool-one', toolName: 'Write', summary: 'Write file', detail: {}, options: [] },
    }]);
  });
});

test('reverse permission request is answered with error and surfaced as a blocker', async () => {
  await withFakeServer(async peer => {
    await createSession(peer);
    assert.deepEqual(await peer.readPendingInteractions('session-one'), []);
    await debugRequest(peer, 'test/reverse', {});
    await assert.rejects(peer.readPendingInteractions('session-one'), /interaction request is not supported/);
  });
});

test('malformed runtime-preference reverse requests are rejected and block reads', async () => {
  await withFakeServer(async peer => {
    await createSession(peer);
    assert.deepEqual(await peer.readPendingInteractions('session-one'), []);
    await debugRequest(peer, 'test/reverse-runtime-invalid', {});
    await assert.rejects(peer.readPendingInteractions('session-one'), /runtime preference reverse request was malformed/);
  });
});

test('RPC response IDs must match and delta sequence gaps invalidate the subscription', async () => {
  await withFakeServer(async peer => {
    await assert.rejects(debugRequest(peer, 'test/wrong-id', {}), /response id did not match/);
  });

  await withFakeServer(async peer => {
    await createSession(peer);
    assert.deepEqual(await peer.readPendingInteractions('session-one'), []);
    await debugRequest(peer, 'test/gap', {});
    await new Promise(resolve => setTimeout(resolve, 150));
    await assert.rejects(peer.readPendingInteractions('session-one'), /sequence gap/);
  });
});

test('RPC timeout and AbortSignal terminate the peer and reject pending requests', async () => {
  await withFakeServer(async peer => {
    await assert.rejects(debugRequest(peer, 'test/hang', {}), /timed out/);
    await assert.rejects(debugRequest(peer, 'test/fast', {}), /timed out/);
  });

  const root = await mkdtemp(join(tmpdir(), 'zero-zcode-peer-abort-'));
  const worktree = join(root, 'task-worktree');
  const dataBaseDir = join(root, 'isolated-zcode-data');
  await mkdir(worktree);
  const entry = join(root, 'fake-app-server.mjs');
  await writeFile(entry, SERVER_SOURCE, 'utf8');
  const controller = new AbortController();
  const peer = await ZCodeAppServerPeer.launch({ entry, taskWorktree: worktree, profileMode: 'isolated', zeroDataRoot: root, dataBaseDir, signal: controller.signal });
  const waiting = debugRequest(peer, 'test/hang', {});
  controller.abort();
  await assert.rejects(waiting, /cancelled/);
  await peer.close();
  await rm(root, { recursive: true, force: true });
});

test('close waits for delayed child exit and confirms forced termination when stdin close is ignored', async () => {
  await withFakeServer(async peer => {
    await debugRequest(peer, 'test/set-mode', { mode: 'delayed-close' });
    const started = Date.now();
    await peer.close();
    assert.ok(Date.now() - started >= 250);
  });

  const root = await mkdtemp(join(tmpdir(), 'zero-zcode-peer-refuse-close-'));
  const worktree = join(root, 'task-worktree');
  await mkdir(worktree);
  const entry = join(root, 'fake-app-server.mjs');
  await writeFile(entry, SERVER_SOURCE, 'utf8');
  const peer = await ZCodeAppServerPeer.launch({
    entry, taskWorktree: worktree, profileMode: 'isolated', zeroDataRoot: root,
    dataBaseDir: join(root, 'isolated-zcode-data'), requestTimeoutMs: 1_000,
  });
  await debugRequest(peer, 'test/set-mode', { mode: 'ignore-close' });
  const started = Date.now();
  let closeError: unknown;
  try { await peer.close(); } catch (error) { closeError = error; }
  assert.ok(Date.now() - started >= 700);
  if (closeError) assert.match(String(closeError), /process tree termination failed/);
  await rm(root, { recursive: true, force: true });
});

test('stdin close fails the peer and rejects subsequent requests', async () => {
  await withFakeServer(async peer => {
    await debugRequest(peer, 'test/destroy-stdin', {});
    await new Promise(resolve => setTimeout(resolve, 20));
    await assert.rejects(debugRequest(peer, 'test/after-stdin-close', {}), /closed|failed|write|exited|timed out/i);
  });
});

test('peer rejects unsafe entry, task/data overlap, and relative paths before spawning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zero-zcode-peer-invalid-'));
  const worktree = join(root, 'worktree');
  await mkdir(worktree);
  const entry = join(root, 'entry.mjs');
  await writeFile(entry, SERVER_SOURCE, 'utf8');
  await assert.rejects(ZCodeAppServerPeer.launch({ entry: 'relative-entry.mjs', taskWorktree: worktree, profileMode: 'isolated', zeroDataRoot: root, dataBaseDir: join(root, 'data') }), /absolute JavaScript/);
  await assert.rejects(ZCodeAppServerPeer.launch({ entry, taskWorktree: worktree, profileMode: 'isolated', zeroDataRoot: root, dataBaseDir: join(worktree, 'inside') }), /isolated from the task worktree/);
  await assert.rejects(ZCodeAppServerPeer.launch({ entry, taskWorktree: 'relative-worktree', profileMode: 'isolated', zeroDataRoot: root, dataBaseDir: join(root, 'data') }), /taskWorktree must be absolute/);
  await assert.rejects(ZCodeAppServerPeer.launch({ entry, taskWorktree: worktree, profileMode: 'existing-desktop', dataBaseDir: join(root, 'data') }), /must not override/);
  await rm(root, { recursive: true, force: true });
});

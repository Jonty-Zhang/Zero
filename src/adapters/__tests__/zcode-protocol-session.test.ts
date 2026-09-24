import test from 'node:test';
import assert from 'node:assert/strict';
import { runZCodeProtocolSession } from '../zcode-protocol-session.js';
import type { ZCodeProtocolPeer } from '../zcode-protocol-session.js';

interface FakeOptions {
  eventsByPoll?: unknown[][];
  pendingByRead?: unknown[];
  sendAck?: Record<string, unknown> | ((params: Record<string, unknown>) => Record<string, unknown>);
  deleteAck?: Record<string, unknown>;
  catalog?: Array<Record<string, unknown>>;
}

const catalogEntry = (providerId: string, modelId: string, extra: Record<string, unknown> = {}) => ({
  ref: { providerId, modelId },
  ...extra,
});
const startPlanCatalogEntry = (providerId = 'account:zai-start-plan', extra: Record<string, unknown> = {}) =>
  catalogEntry(providerId, 'GLM-5.3-Flash', extra);

function fakePeer(options: FakeOptions = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let poll = 0;
  let pendingRead = 0;
  let closed = false;
  const peer: ZCodeProtocolPeer = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session/create') return {
        session: { sessionId: 's-test' },
        settings: { model: { available: options.catalog ?? [startPlanCatalogEntry()] } },
      };
      if (method === 'v4/command') {
        if (params.type === 'stop') return { status: 'accepted', commandId: params.commandId };
        if (params.type === 'deleteQueueItem') {
          return options.deleteAck ?? { status: 'accepted', commandId: params.commandId };
        }
        const customAck = typeof options.sendAck === 'function' ? options.sendAck(params) : options.sendAck;
        return customAck ?? {
          status: 'accepted',
          commandId: params.commandId,
          result: { type: 'inputAccepted', delivery: 'startNow', inputId: params.commandId },
        };
      }
      if (method === 'session/events') {
        const events = options.eventsByPoll?.[poll++] ?? [];
        return { events };
      }
      return {};
    },
    async readPendingInteractions() {
      const value = options.pendingByRead?.[pendingRead] ?? [];
      pendingRead += 1;
      return value;
    },
    async close() { closed = true; },
  };
  return { peer, calls, isClosed: () => closed };
}

const request = (suffix: string, overrides: Partial<Parameters<typeof runZCodeProtocolSession>[1]> = {}) => ({
  cwd: `C:/zero-data/worktrees/${suffix}`,
  workspaceKey: suffix,
  model: { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash' },
  prompt: 'Continue the task',
  pollIntervalMs: 0,
  ...overrides,
});

test('protocol bridge pins the requested provider/model and waits for the matching successful turn', async () => {
  const fake = fakePeer({ eventsByPoll: [
    [{ seq: 1, type: 'turn.started', turnId: 'turn-current', payload: {
      inputId: '$command-id', foregroundExecutionId: 'exec-current',
    } }],
    [{ seq: 2, type: 'turn.completed', turnId: 'turn-current', payload: {
      inputId: '$command-id', resultType: 'success', response: 'done',
    } }],
  ] });
  // Resolve only the test marker without exposing random IDs in fixture setup.
  const command = 'v4/command';
  const originalRequest = fake.peer.request.bind(fake.peer);
  fake.peer.request = async (method, params) => {
    if (method === 'session/events') {
      const response = await originalRequest(method, params) as { events: Array<Record<string, unknown>> };
      const inputId = fake.calls.find(call => call.method === command && call.params.type === 'sendText')?.params.commandId;
      return { events: response.events.map(event => ({ ...event, payload: { ...(event.payload as object), inputId } })) };
    }
    return originalRequest(method, params);
  };
  const result = await runZCodeProtocolSession(fake.peer, request('task-1'));

  assert.equal(result.response, 'done');
  assert.deepEqual(result.requestedModel, request('task-1').model);
  assert.equal(result.modelVerification, 'selector_only');
  assert.deepEqual(fake.calls.map(call => call.method), [
    'session/create', 'v4/command', 'session/events', 'session/events',
  ]);
  const send = fake.calls[1]!;
  assert.equal(send.params.type, 'sendText');
  assert.equal(send.params.sessionId, 's-test');
  assert.equal((send.params.payload as Record<string, unknown>).requestedDelivery, 'startNow');
  assert.deepEqual((send.params.payload as Record<string, unknown>).modelSelection, {
    providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash',
  });
  assert.deepEqual((send.params.payload as Record<string, unknown>).modelExecution, {
    selectionScope: 'execution',
    memoryExtraction: 'skip',
    subagents: { foregroundModel: 'submission', background: 'deny' },
  });
  assert.equal(fake.calls[2]?.params.afterSeq, 0);
  assert.equal(fake.calls[3]?.params.afterSeq, 1);
  assert.equal(fake.isClosed(), true);
});

test('sendText rejects non-accepted acknowledgements without polling', async () => {
  for (const ack of [{ status: 'rejected', reasonCode: 'bad' }, { status: 'noop' }]) {
    const fake = fakePeer({ sendAck: ack });
    await assert.rejects(runZCodeProtocolSession(fake.peer, request('ack-fail')), /sendText/);
    assert.equal(fake.calls.filter(call => call.method === 'session/events').length, 0);
    assert.equal(fake.isClosed(), true);
  }
});

test('catalog uniquely binds the requested provider/model and validates reasoning options', async () => {
  const bigModel = request('bigmodel-plan', {
    model: { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash', reasoningLevel: 'high' },
  });
  const fake = fakePeer({ catalog: [startPlanCatalogEntry('account:bigmodel-start-plan', {
    reasoning: { levels: [{ value: 'high' }] },
  })], eventsByPoll: [[{ seq: 1, type: 'turn.completed', turnId: 'turn-1', payload: {
    inputId: '$command-id', resultType: 'success', response: 'ok',
  } }]] });
  const originalRequest = fake.peer.request.bind(fake.peer);
  fake.peer.request = async (method, params) => {
    if (method === 'session/events') {
      const response = await originalRequest(method, params) as { events: Array<Record<string, unknown>> };
      const inputId = fake.calls.find(call => call.method === 'v4/command' && call.params.type === 'sendText')?.params.commandId;
      return { events: response.events.map(event => ({ ...event, payload: { ...(event.payload as object), inputId } })) };
    }
    return originalRequest(method, params);
  };
  await runZCodeProtocolSession(fake.peer, bigModel);
  assert.deepEqual((fake.calls.find(call => call.params.type === 'sendText')?.params.payload as Record<string, unknown>).modelSelection, {
    providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'high' },
  });
});

test('catalog missing, disabled, duplicated, mismatched, or incomplete reasoning fails closed before sendText', async () => {
  const invalidCatalogs: Array<Array<Record<string, unknown>>> = [
    [],
    [startPlanCatalogEntry('account:zai-start-plan', { disabledReason: 'unavailable' })],
    [startPlanCatalogEntry(), startPlanCatalogEntry()],
    [startPlanCatalogEntry('account:bigmodel-start-plan')],
    [startPlanCatalogEntry('account:zai-start-plan', { label: 'first' }), startPlanCatalogEntry('account:zai-start-plan', { label: 'second' })],
    [startPlanCatalogEntry('account:zai-start-plan', { reasoning: { levels: [{ value: 'low' }] } })],
  ];
  for (let index = 0; index < invalidCatalogs.length; index += 1) {
    const fake = fakePeer({ catalog: invalidCatalogs[index] });
    const askedForReasoning = index === invalidCatalogs.length - 1;
    const model = askedForReasoning
      ? { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash', reasoningLevel: 'high' }
      : request(`catalog-invalid-${index}`).model;
    await assert.rejects(runZCodeProtocolSession(fake.peer, request(`catalog-invalid-${index}`, { model })), /provider\/model|catalog entry|reasoning level/);
    assert.ok(!fake.calls.some(call => call.method === 'v4/command'));
    assert.equal(fake.isClosed(), true);
  }
});

test('catalog validation accepts other exact provider/model tuples without inferring identity from labels', async () => {
  const model = { providerId: 'account:deepseek', modelId: 'DeepSeek-V3.2' };
  const fake = fakePeer({ catalog: [catalogEntry(model.providerId, model.modelId, { label: 'GLM-5.3-Flash' })] });
  const requestPeer = fake.peer.request.bind(fake.peer);
  fake.peer.request = async (method, params) => {
    if (method === 'session/events') {
      const result = await requestPeer(method, params) as { events: Array<Record<string, unknown>> };
      const inputId = fake.calls.find(call => call.params.type === 'sendText')?.params.commandId;
      return { events: [{ seq: 1, type: 'turn.completed', payload: {
        inputId, resultType: 'success', response: 'ok',
      } }, ...result.events] };
    }
    return requestPeer(method, params);
  };
  await runZCodeProtocolSession(fake.peer, request('generic-model', { model }));
  const send = fake.calls.find(call => call.params.type === 'sendText');
  assert.deepEqual((send?.params.payload as Record<string, unknown>).modelSelection, model);

  const misleadingLabel = fakePeer({ catalog: [catalogEntry('account:glm-provider', 'GLM-5.3-Flash', {
    label: 'DeepSeek-V3.2',
  })] });
  await assert.rejects(
    runZCodeProtocolSession(misleadingLabel.peer, request('label-is-not-identity', { model })),
    /provider\/model catalog entry is missing/,
  );
  assert.ok(!misleadingLabel.calls.some(call => call.params.type === 'sendText'));
});

test('sendText never interprets delivery from an ACK for a different commandId', async () => {
  for (const delivery of ['startNow', 'queue', 'guide']) {
    const fake = fakePeer();
    const requestPeer = fake.peer.request.bind(fake.peer);
    fake.peer.request = async (method, params) => {
      if (method === 'v4/command' && params.type === 'sendText') {
        fake.calls.push({ method, params });
        return {
          status: 'accepted',
          commandId: 'different-command',
          result: { type: 'inputAccepted', delivery, inputId: params.commandId },
        };
      }
      return requestPeer(method, params);
    };
    await assert.rejects(
      runZCodeProtocolSession(fake.peer, request(`mismatched-ack-${delivery}`)),
      /mismatched commandId.*may still be queued or running/,
    );
    assert.equal(fake.calls.filter(call => call.method === 'session/events').length, 0);
    assert.equal(fake.calls.filter(call => call.params.type === 'deleteQueueItem').length, 0);
    assert.equal(fake.calls.filter(call => call.params.type === 'stop').length, 0);
    assert.equal(fake.isClosed(), true);
  }
});

test('accepted queue ACK withdraws only queue_<commandId> and verifies the exact delete ACK', async () => {
  const fake = fakePeer({ sendAck: {
    status: 'accepted', result: { type: 'inputAccepted', delivery: 'queue', inputId: 'input-id' },
  } });
  fake.peer.request = async (method, params) => {
    fake.calls.push({ method, params });
      if (method === 'session/create') return {
        session: { sessionId: 's-test' },
        settings: { model: { available: [startPlanCatalogEntry()] } },
      };
    if (method === 'v4/command' && params.type === 'sendText') return {
      status: 'accepted', commandId: params.commandId,
      result: { type: 'inputAccepted', delivery: 'queue', inputId: params.commandId },
    };
    if (method === 'v4/command' && params.type === 'deleteQueueItem') return {
      status: 'accepted', commandId: params.commandId,
    };
    return {};
  };
  await assert.rejects(runZCodeProtocolSession(fake.peer, request('queued')), /queued and its exact queue item was withdrawn/);
  const deleteCall = fake.calls.find(call => call.params.type === 'deleteQueueItem');
  const sendCall = fake.calls.find(call => call.params.type === 'sendText');
  assert.deepEqual(deleteCall?.params.payload, { queueItemId: `queue_${String(sendCall?.params.commandId)}` });
  assert.equal(fake.calls.filter(call => call.params.type === 'stop').length, 0);
  assert.equal(fake.calls.filter(call => call.method === 'session/events').length, 0);
  assert.equal(fake.isClosed(), true);
});

test('unconfirmed queue deletion reports that the accepted input may still run', async () => {
  const fake = fakePeer({
    sendAck: params => ({ status: 'accepted', commandId: params.commandId,
      result: { type: 'inputAccepted', delivery: 'queue', inputId: params.commandId } }),
    deleteAck: { status: 'noop', reasonCode: 'queue.itemMissing' },
  });
  await assert.rejects(runZCodeProtocolSession(fake.peer, request('queue-race')), /may still be queued or already running.*not confirmed/);
  assert.equal(fake.calls.filter(call => call.params.type === 'deleteQueueItem').length, 1);
  assert.equal(fake.calls.filter(call => call.params.type === 'stop').length, 0);
  assert.equal(fake.calls.filter(call => call.method === 'session/events').length, 0);
  assert.equal(fake.isClosed(), true);
});

test('guide delivery is reported as unretractable and never treated as cancelled by peer close', async () => {
  const fake = fakePeer({ sendAck: params => ({
    status: 'accepted', commandId: params.commandId,
    result: { type: 'inputAccepted', delivery: 'guide', inputId: params.commandId },
  }) });
  await assert.rejects(runZCodeProtocolSession(fake.peer, request('guide')), /guide.*cannot be safely retracted/);
  assert.equal(fake.calls.filter(call => call.params.type === 'deleteQueueItem').length, 0);
  assert.equal(fake.calls.filter(call => call.params.type === 'stop').length, 0);
  assert.equal(fake.calls.filter(call => call.method === 'session/events').length, 0);
  assert.equal(fake.isClosed(), true);
});

test('a pending interaction before send fails closed without launching a turn', async () => {
  const fake = fakePeer({ pendingByRead: [[{ interactionId: 'i1', kind: 'permission', payload: {} }]] });
  await assert.rejects(runZCodeProtocolSession(fake.peer, request('pending-before-send')), /pending interaction.*permission/);
  assert.deepEqual(fake.calls.map(call => call.method), ['session/create']);
});

test('permission and AskUserQuestion events fail closed and stop only the observed execution', async () => {
  for (const interaction of [
    { seq: 2, type: 'permission.requested', payload: { toolName: 'Write', requestId: 'r1' } },
    { seq: 2, type: 'userInput.requested', payload: { toolName: 'AskUserQuestion', requestId: 'r2' } },
  ]) {
    const fake = fakePeer({ eventsByPoll: [[
      { seq: 1, type: 'turn.started', turnId: 'turn-current', payload: {
        inputId: '$command-id', foregroundExecutionId: 'exec-current',
      } },
      interaction,
    ]] });
    const originalRequest = fake.peer.request.bind(fake.peer);
    fake.peer.request = async (method, params) => {
      if (method === 'session/events') {
        const response = await originalRequest(method, params) as { events: Array<Record<string, unknown>> };
        const inputId = fake.calls.find(call => call.method === 'v4/command' && call.params.type === 'sendText')?.params.commandId;
        return { events: response.events.map(event => ({ ...event, payload: { ...(event.payload as object), inputId } })) };
      }
      return originalRequest(method, params);
    };
    await assert.rejects(runZCodeProtocolSession(fake.peer, request('interaction')), /blocked unattended execution/);
    const commands = fake.calls.filter(call => call.method === 'v4/command');
    assert.equal(commands.length, 2);
    const stop = commands[1]!;
    assert.equal(stop.params.type, 'stop');
    assert.deepEqual(stop.params.payload, { expectedForegroundExecutionId: 'exec-current' });
    assert.ok(!fake.calls.some(call => call.method === 'session/stop'));
  }
});

test('a malformed pending-interaction view fails closed before sending', async () => {
  const fake = fakePeer({ pendingByRead: [undefined] });
  // undefined fixture uses the no-value fallback (empty list), so explicitly replace it.
  fake.peer.readPendingInteractions = async () => ({ pendingInteractions: [] });
  await assert.rejects(runZCodeProtocolSession(fake.peer, request('bad-interaction-view')), /interaction state is unavailable/);
  assert.ok(!fake.calls.some(call => call.method === 'v4/command'));
});

test('completion correlation ignores stale turns and only accepts matching inputId or turnId', async () => {
  const fake = fakePeer({ eventsByPoll: [
    [{ seq: 3, type: 'turn.completed', turnId: 'turn-old', payload: { inputId: 'previous', resultType: 'success' } }],
    [{ seq: 4, type: 'turn.started', turnId: 'turn-current', payload: {
      inputId: '$command-id', foregroundExecutionId: 'exec-current',
    } }],
    [{ seq: 5, type: 'turn.completed', turnId: 'turn-current', payload: {
      inputId: '$command-id', resultType: 'success', response: 'new result',
    } }],
  ] });
  const originalRequest = fake.peer.request.bind(fake.peer);
  fake.peer.request = async (method, params) => {
    if (method === 'session/events') {
      const response = await originalRequest(method, params) as { events: Array<Record<string, unknown>> };
      const inputId = fake.calls.find(call => call.method === 'v4/command' && call.params.type === 'sendText')?.params.commandId;
      return { events: response.events.map(event => event.payload && (event.payload as Record<string, unknown>).inputId === '$command-id'
        ? { ...event, payload: { ...(event.payload as object), inputId } }
        : event) };
    }
    return originalRequest(method, params);
  };
  const result = await runZCodeProtocolSession(fake.peer, request('correlation'));
  assert.equal(result.response, 'new result');
  assert.equal(fake.calls.filter(call => call.method === 'session/events').length, 3);
  assert.equal(fake.calls[2]?.params.afterSeq, 0);
  assert.equal(fake.calls[3]?.params.afterSeq, 3);
  assert.equal(fake.calls[4]?.params.afterSeq, 4);
});

test('failed completion and app-server disconnect never report success', async () => {
  const failed = fakePeer({ eventsByPoll: [[{ seq: 1, type: 'turn.completed', payload: {
    inputId: '$command-id', resultType: 'cancelled', response: 'partial',
  } }]] });
  const originalRequest = failed.peer.request.bind(failed.peer);
  failed.peer.request = async (method, params) => {
    if (method === 'session/events') {
      const response = await originalRequest(method, params) as { events: Array<Record<string, unknown>> };
      const inputId = failed.calls.find(call => call.method === 'v4/command' && call.params.type === 'sendText')?.params.commandId;
      return { events: response.events.map(event => ({ ...event, payload: { ...(event.payload as object), inputId } })) };
    }
    return originalRequest(method, params);
  };
  await assert.rejects(runZCodeProtocolSession(failed.peer, request('cancelled')), /cancelled/);

  const turnFailed = fakePeer({ eventsByPoll: [[{ seq: 1, type: 'turn.failed', payload: {
    inputId: '$command-id', error: { message: 'provider failed' },
  } }]] });
  const failedRequest = turnFailed.peer.request.bind(turnFailed.peer);
  turnFailed.peer.request = async (method, params) => {
    if (method === 'session/events') {
      const response = await failedRequest(method, params) as { events: Array<Record<string, unknown>> };
      const inputId = turnFailed.calls.find(call => call.method === 'v4/command' && call.params.type === 'sendText')?.params.commandId;
      return { events: response.events.map(event => ({ ...event, payload: { ...(event.payload as object), inputId } })) };
    }
    return failedRequest(method, params);
  };
  await assert.rejects(runZCodeProtocolSession(turnFailed.peer, request('turn-failed')), /provider failed/);

  const disconnected: string[] = [];
  const peer: ZCodeProtocolPeer = {
    async request(method, params) {
      disconnected.push(method);
      if (method === 'session/create') return {
        session: { sessionId: 's-disconnect' },
        settings: { model: { available: [startPlanCatalogEntry()] } },
      };
      if (method === 'v4/command') return { status: 'accepted', commandId: params.commandId, result: {
        type: 'inputAccepted', delivery: 'startNow', inputId: params.commandId,
      } };
      if (method === 'session/events') throw new Error('app-server disconnected');
      return {};
    },
    async readPendingInteractions() { return []; },
    async close() {},
  };
  await assert.rejects(runZCodeProtocolSession(peer, request('disconnect')), /disconnected/);
  assert.deepEqual(disconnected, ['session/create', 'v4/command', 'session/events']);
});

test('missing foreground execution token fails closed without any unguarded stop or session close', async () => {
  const abort = new AbortController();
  const fake = fakePeer({ eventsByPoll: [[{ seq: 1, type: 'turn.started', turnId: 'turn-current', payload: {
    inputId: '$command-id',
  } }]] });
  const originalRequest = fake.peer.request.bind(fake.peer);
  fake.peer.request = async (method, params) => {
    if (method === 'session/events') {
      const response = await originalRequest(method, params) as { events: Array<Record<string, unknown>> };
      const inputId = fake.calls.find(call => call.method === 'v4/command' && call.params.type === 'sendText')?.params.commandId;
      return { events: response.events.map(event => ({ ...event, payload: { ...(event.payload as object), inputId } })) };
    }
    return originalRequest(method, params);
  };
  const running = runZCodeProtocolSession(fake.peer, request('cancel', { pollIntervalMs: 10_000, signal: abort.signal }));
  setTimeout(() => abort.abort(new Error('test cancel')), 10);
  await assert.rejects(running, /test cancel.*session may still be running/);
  assert.ok(!fake.calls.some(call => call.method === 'session/stop' || (call.method === 'v4/command' && call.params.type === 'stop')));
  assert.ok(!fake.calls.some(call => call.method === 'session/close'));
  assert.equal(fake.isClosed(), true);
});

test('invalid workspace is rejected before RPC calls and closes only the peer', async () => {
  const fake = fakePeer();
  await assert.rejects(runZCodeProtocolSession(fake.peer, request('bad', { cwd: 'relative/path' })), /cwd must be absolute/);
  assert.deepEqual(fake.calls, []);
  assert.equal(fake.isClosed(), true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { runZCodeProtocolSession } from '../zcode-protocol-session.js';
import type { ZCodeProtocolPeer } from '../zcode-protocol-session.js';

function fakePeer(eventsByPoll: unknown[][]) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let poll = 0;
  let closed = false;
  const peer: ZCodeProtocolPeer = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session/create') return { session: { sessionId: 's-test' } };
      if (method === 'session/events') {
        const expectedInputId = calls.find(call => call.method === 'session/send')?.params.inputId;
        const events = eventsByPoll[poll++] ?? [];
        return { events: events.map(event => {
          if (!event || typeof event !== 'object' || Array.isArray(event)) return event;
          const row = event as Record<string, unknown>;
          if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) return row;
          const payload = row.payload as Record<string, unknown>;
          return payload.inputId === '$sent-input-id'
            ? { ...row, payload: { ...payload, inputId: expectedInputId } }
            : row;
        }) };
      }
      return {};
    },
    async close() { closed = true; },
  };
  return { peer, calls, isClosed: () => closed };
}

test('ZCode protocol driver selects provider/model per send and waits for the matching turn.completed', async () => {
  const fake = fakePeer([
    [{ seq: 1, type: 'turn.started', turnId: 'turn-current', payload: { inputId: '$sent-input-id', input: 'Continue the task' } }],
    [{ seq: 2, type: 'turn.completed', turnId: 'turn-current', payload: { inputId: '$sent-input-id', resultType: 'success', response: 'done' } }],
  ]);
  const result = await runZCodeProtocolSession(fake.peer, {
    cwd: 'C:/zero-data/worktrees/task-1', workspaceKey: 'zero-task-task-1',
    model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro', reasoningLevel: 'high' },
    prompt: 'Continue the task', pollIntervalMs: 0,
  });

  assert.equal(result.response, 'done');
  assert.equal(result.model.providerId, 'deepseek');
  assert.deepEqual(fake.calls.map(call => call.method), [
    'session/create', 'session/send', 'session/events', 'session/events',
  ]);
  assert.deepEqual(fake.calls[0]?.params, {
    workspace: {
      workspacePath: 'C:/zero-data/worktrees/task-1',
      workspaceIdentity: 'C:/zero-data/worktrees/task-1',
      workspaceKey: 'zero-task-task-1',
    },
    persistence: 'deferred',
  });
  assert.deepEqual(fake.calls[1]?.params, {
    sessionId: 's-test', content: 'Continue the task',
    inputId: fake.calls[1]?.params.inputId, queryId: fake.calls[1]?.params.inputId,
    modelSelection: { providerId: 'deepseek', modelId: 'deepseek-v4-pro', options: { reasoningLevel: 'high' } },
  });
  assert.equal(typeof fake.calls[1]?.params.inputId, 'string');
  assert.equal(fake.calls[3]?.params.afterSeq, 1);
  assert.equal('limit' in (fake.calls[3]?.params ?? {}), false);
  assert.equal(fake.isClosed(), true);
});

test('ZCode protocol driver treats send acknowledgement as non-final and rejects unsuccessful completion', async () => {
  const fake = fakePeer([[{ seq: 4, type: 'turn.completed', payload: { inputId: '$sent-input-id', resultType: 'error_max_budget', response: 'partial' } }]]);
  await assert.rejects(runZCodeProtocolSession(fake.peer, {
    cwd: 'C:/zero-data/worktrees/task-2', workspaceKey: 'task-2',
    model: { providerId: 'bigmodel-api', modelId: 'glm-5.3' }, prompt: 'Implement', pollIntervalMs: 0,
  }), /error_max_budget/);
  assert.deepEqual(fake.calls.map(call => call.method), ['session/create', 'session/send', 'session/events']);
  assert.equal(fake.isClosed(), true);
});

test('ZCode protocol driver sends session/stop on cancellation, then closes the peer without deleting the session', async () => {
  const abort = new AbortController();
  const fake = fakePeer([[]]);
  const running = runZCodeProtocolSession(fake.peer, {
    cwd: 'C:/zero-data/worktrees/task-3', workspaceKey: 'task-3',
    model: { providerId: 'deepseek', modelId: 'deepseek-flash' }, prompt: 'Implement',
    pollIntervalMs: 10_000, signal: abort.signal,
  });
  setTimeout(() => abort.abort(new Error('test cancel')), 10);
  await assert.rejects(running, /test cancel/);
  assert.ok(fake.calls.some(call => call.method === 'session/stop'));
  assert.ok(!fake.calls.some(call => call.method === 'session/close'));
  assert.equal(fake.isClosed(), true);
});

test('ZCode protocol driver refuses relative workspace paths before contacting the peer', async () => {
  const fake = fakePeer([]);
  await assert.rejects(runZCodeProtocolSession(fake.peer, {
    cwd: 'relative/path', workspaceKey: 'task-4',
    model: { providerId: 'deepseek', modelId: 'deepseek-flash' }, prompt: 'Implement',
  }), /cwd must be absolute/);
  assert.deepEqual(fake.calls, []);
  assert.equal(fake.isClosed(), true);
});

test('ZCode protocol driver never treats an app-server disconnect without turn.completed as success', async () => {
  const calls: string[] = [];
  const peer: ZCodeProtocolPeer = {
    async request(method) {
      calls.push(method);
      if (method === 'session/create') return { session: { sessionId: 's-disconnect' } };
      if (method === 'session/events') throw new Error('app-server exited before completion event');
      return {};
    },
    async close() {},
  };
  await assert.rejects(runZCodeProtocolSession(peer, {
    cwd: 'C:/zero-data/worktrees/task-5', workspaceKey: 'task-5',
    model: { providerId: 'deepseek', modelId: 'deepseek-flash' }, prompt: 'Implement', pollIntervalMs: 0,
  }), /app-server exited before completion event/);
  assert.deepEqual(calls, ['session/create', 'session/send', 'session/events']);
});

test('ZCode protocol driver ignores a stale completed event from a prior turn in the same session', async () => {
  const fake = fakePeer([
    [{ seq: 3, type: 'turn.completed', turnId: 'turn-old', payload: { inputId: 'previous-input', resultType: 'success', response: 'old result' } }],
    [{ seq: 5, type: 'turn.started', turnId: 'turn-current', payload: { inputId: '$sent-input-id', input: 'new work' } }],
    [{ seq: 6, type: 'turn.completed', turnId: 'turn-current', payload: { inputId: '$sent-input-id', resultType: 'success', response: 'new result' } }],
  ]);
  const result = await runZCodeProtocolSession(fake.peer, {
    cwd: 'C:/zero-data/worktrees/task-6', workspaceKey: 'task-6',
    model: { providerId: 'deepseek', modelId: 'deepseek-flash' }, prompt: 'Continue', pollIntervalMs: 0,
  });
  assert.equal(result.response, 'new result');
  assert.equal(fake.calls.filter(call => call.method === 'session/events').length, 3);
  assert.equal(fake.calls[2]?.params.afterSeq, 0);
  assert.equal(fake.calls[3]?.params.afterSeq, 3);
  assert.equal(fake.calls[4]?.params.afterSeq, 5);
});

test('ZCode protocol driver removes abort listeners after each completed poll delay', async () => {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (type === 'abort' && listener) listeners.add(listener);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (type === 'abort' && listener) listeners.delete(listener);
    },
  } as unknown as AbortSignal;
  const polls = Array.from({ length: 20 }, (_, index) => [{ seq: index + 1, type: 'session.updated', payload: {} }]);
  polls.push([{ seq: 21, type: 'turn.completed', payload: { inputId: '$sent-input-id', resultType: 'success', response: 'done' } }]);
  const fake = fakePeer(polls);
  await runZCodeProtocolSession(fake.peer, {
    cwd: 'C:/zero-data/worktrees/task-7', workspaceKey: 'task-7',
    model: { providerId: 'deepseek', modelId: 'deepseek-flash' }, prompt: 'Implement',
    pollIntervalMs: 0, signal,
  });
  assert.equal(fake.calls.filter(call => call.method === 'session/events').length, 21);
  assert.equal(listeners.size, 0);
});

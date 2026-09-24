import { randomUUID } from 'node:crypto';

/**
 * Experimental driver for ZCode's app-server NDJSON RPC surface.
 *
 * This module is deliberately not wired into the default ZCode adapter or model
 * bindings. A caller must provide its own protocol peer and explicit model.
 */
export interface ZCodeProtocolPeer {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface ZCodeProtocolModel {
  providerId: string;
  modelId: string;
  reasoningLevel?: string;
}

export interface ZCodeProtocolSessionRequest {
  cwd: string;
  workspaceKey: string;
  model: ZCodeProtocolModel;
  prompt: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface ZCodeProtocolSessionResult {
  sessionId: string;
  response: string;
  model: ZCodeProtocolModel;
  status: 'completed';
}

const METHODS = {
  create: 'session/create',
  send: 'session/send',
  events: 'session/events',
  stop: 'session/stop',
} as const;

/** Runs one explicit-model session. The peer owns process launch and NDJSON framing. */
export async function runZCodeProtocolSession(
  peer: ZCodeProtocolPeer,
  request: ZCodeProtocolSessionRequest,
): Promise<ZCodeProtocolSessionResult> {
  try {
    validateRequest(request);
  } catch (error) {
    await peer.close().catch(() => undefined);
    throw error;
  }
  const selection = {
    providerId: request.model.providerId,
    modelId: request.model.modelId,
    ...(request.model.reasoningLevel ? { options: { reasoningLevel: request.model.reasoningLevel } } : {}),
  };
  const createParams = {
    workspace: {
      workspacePath: request.cwd,
      workspaceIdentity: request.cwd,
      workspaceKey: request.workspaceKey,
    },
    persistence: 'deferred',
  };

  let sessionId: string | undefined;
  let sent = false;
  let stopSent = false;
  let activeTurnId: string | undefined;
  const inputId = randomUUID();
  const startedAt = Date.now();
  const timeoutMs = request.timeoutMs ?? 30 * 60_000;
  let afterSeq = 0;

  const stop = async () => {
    if (!sessionId || !sent || stopSent) return;
    stopSent = true;
    await peer.request(METHODS.stop, { sessionId });
  };

  try {
    throwIfAborted(request.signal);
    const created = asRecord(await peer.request(METHODS.create, createParams));
    const snapshotSession = created.session && typeof created.session === 'object' && !Array.isArray(created.session)
      ? asRecord(created.session)
      : undefined;
    sessionId = nonEmptyString(snapshotSession?.sessionId);
    if (!sessionId) throw new Error('ZCode session/create returned no sessionId');
    throwIfAborted(request.signal);

    await peer.request(METHODS.send, {
      sessionId,
      content: request.prompt,
      inputId,
      queryId: inputId,
      // Per-turn selection flows through ZCode's canonical send intent. session/create
      // model and thoughtLevel call app setters and can update workspace last-used state.
      modelSelection: selection,
    });
    sent = true;

    while (true) {
      throwIfAborted(request.signal);
      if (Date.now() - startedAt >= timeoutMs) {
        await stop();
        throw new Error(`ZCode protocol session timed out after ${timeoutMs}ms`);
      }
      // No limit: the upstream limit is a tail slice, not a cursor page. afterSeq is
      // the actual exclusive cursor, and the event's inputId/turnId isolates this run.
      const result = asRecord(await peer.request(METHODS.events, { sessionId, afterSeq }));
      if (!Array.isArray(result.events)) throw new Error('ZCode session/events returned an invalid events field');
      for (const eventValue of result.events) {
        const event = asRecord(eventValue);
        const seq = typeof event.seq === 'number' ? event.seq : undefined;
        if (seq !== undefined) afterSeq = Math.max(afterSeq, seq);
        const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
          ? asRecord(event.payload)
          : undefined;
        if (event.type === 'turn.started' && payload?.inputId === inputId && typeof event.turnId === 'string') {
          activeTurnId = event.turnId;
          continue;
        }
        const belongsToThisTurn = payload?.inputId === inputId
          || (Boolean(activeTurnId) && event.turnId === activeTurnId);
        if (!belongsToThisTurn) continue;
        if (event.type === 'turn.failed') {
          const failure = payload?.error && typeof payload.error === 'object' && !Array.isArray(payload.error)
            ? asRecord(payload.error)
            : undefined;
          throw new Error(nonEmptyString(failure?.message) ?? 'ZCode model turn failed');
        }
        if (event.type === 'turn.completed') {
          if (payload?.resultType !== 'success') {
            throw new Error(`ZCode model turn ended with ${String(payload?.resultType ?? 'unknown status')}`);
          }
          return {
            sessionId,
            response: typeof payload.response === 'string' ? payload.response : '',
            model: request.model,
            status: 'completed',
          };
        }
      }
      await delay(request.pollIntervalMs ?? 250, request.signal);
    }
  } catch (error) {
    if (request.signal?.aborted) await stop().catch(() => undefined);
    throw error;
  } finally {
    // Do not call session/close here: upstream uses it to remove the product
    // session and publish session.removed. Closing stdio shuts down this adapter's
    // process while preserving the persisted task/session for later UI visibility.
    await peer.close();
  }
}

function validateRequest(request: ZCodeProtocolSessionRequest): void {
  if (!request.cwd || !isAbsolutePath(request.cwd)) throw new Error('ZCode protocol cwd must be absolute');
  if (!request.workspaceKey.trim()) throw new Error('ZCode protocol workspaceKey is required');
  if (!request.model.providerId.trim() || !request.model.modelId.trim()) throw new Error('ZCode protocol model must include providerId and modelId');
  if (!request.prompt.trim()) throw new Error('ZCode protocol prompt must not be empty');
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)) throw new Error('ZCode protocol timeoutMs must be positive');
  if (request.pollIntervalMs !== undefined && (!Number.isFinite(request.pollIntervalMs) || request.pollIntervalMs < 0)) throw new Error('ZCode protocol pollIntervalMs must be non-negative');
}

function isAbsolutePath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/.test(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('ZCode protocol session cancelled');
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error('ZCode protocol session cancelled'));
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error('ZCode protocol session cancelled'));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    // Cover the narrow race where abort fires after the initial check and before
    // addEventListener has registered the handler.
    if (signal?.aborted) onAbort();
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ZCode protocol response must be an object');
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

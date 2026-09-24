import { randomUUID } from 'node:crypto';

/**
 * Experimental, deliberately unbound ZCode app-server bridge.
 *
 * This prototype has a Zero-owned stdio peer and v4 conversation state reader,
 * but remains deliberately unbound from task routing pending end-to-end enrollment
 * and live model verification.
 */
export interface ZCodeProtocolPeer {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  readPendingInteractions(sessionId: string): Promise<unknown>;
  close(): Promise<void>;
}

export interface ZCodeProtocolModel {
  providerId: string;
  modelId: string;
  reasoningLevel?: string;
}

const START_PLAN_PROVIDER_IDS = new Set(['account:zai-start-plan', 'account:bigmodel-start-plan']);
const START_PLAN_MODEL_ID = 'GLM-5.3-Flash';

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
  requestedModel: ZCodeProtocolModel;
  modelVerification: 'selector_only';
  status: 'completed';
}

const METHODS = {
  create: 'session/create',
  command: 'v4/command',
  events: 'session/events',
} as const;

/** Runs one isolated explicit-model turn. The peer owns process launch and NDJSON framing. */
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
    ...(request.model.reasoningLevel
      ? { options: { reasoningLevel: request.model.reasoningLevel } }
      : {}),
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
  let foregroundExecutionId: string | undefined;
  let turnTerminal = false;
  const clientId = randomUUID();
  const inputId = randomUUID();
  const startedAt = Date.now();
  const timeoutMs = request.timeoutMs ?? 30 * 60_000;
  let afterSeq = 0;

  const stop = async (): Promise<string | undefined> => {
    if (!sessionId || !sent || stopSent) return undefined;
    stopSent = true;
    if (foregroundExecutionId) {
      const ackCommandId = randomUUID();
      try {
        const ack = asRecord(await peer.request(METHODS.command, {
          commandId: ackCommandId,
          clientId,
          sessionId,
          type: 'stop',
          payload: { expectedForegroundExecutionId: foregroundExecutionId },
          issuedAt: Date.now(),
        }));
        if ((ack.status === 'accepted' || ack.status === 'noop') && ack.commandId === ackCommandId) return undefined;
        if (ack.commandId !== ackCommandId) return 'guarded v4 stop ACK commandId did not match this stop';
        return `guarded v4 stop was ${String(ack.status ?? 'unrecognized')}`;
      } catch (error) {
        return `guarded v4 stop failed: ${safeErrorMessage(error)}`;
      }
    }
    return 'guarded v4 stop unavailable because foregroundExecutionId was not observed; the session may still be running, isolate it and wait for the app-server process to exit';
  };

  const deleteAcceptedQueueItem = async (queueCommandId: string): Promise<string | undefined> => {
    if (!sessionId) return 'session id unavailable for targeted queue withdrawal';
    const deleteCommandId = randomUUID();
    try {
      const ack = asRecord(await peer.request(METHODS.command, {
        commandId: deleteCommandId,
        clientId,
        sessionId,
        type: 'deleteQueueItem',
        payload: { queueItemId: `queue_${queueCommandId}` },
        issuedAt: Date.now(),
      }));
      // In 0.16.9 deleteQueueItem returns no result on removal; a missing item is
      // a `noop` ACK. It may already have drained, so anything except this exact
      // accepted ACK cannot prove that the input was withdrawn.
      if (ack.status !== 'accepted' || ack.commandId !== deleteCommandId || ack.result !== undefined) {
        return `targeted queue withdrawal was not confirmed (status=${String(ack.status ?? 'unknown')})`;
      }
      return undefined;
    } catch {
      return 'targeted queue withdrawal request failed';
    }
  };

  try {
    throwIfAborted(request.signal);
    const created = asRecord(await peer.request(METHODS.create, createParams));
    const snapshotSession = created.session && typeof created.session === 'object' && !Array.isArray(created.session)
      ? asRecord(created.session)
      : undefined;
    sessionId = nonEmptyString(snapshotSession?.sessionId);
    if (!sessionId) throw new Error('ZCode session/create returned no sessionId');
    assertStartPlanModelAvailable(created, request.model);

    // A missing or malformed state view is a hard block: legacy events alone do
    // not expose all v4 pending interactions or AskUserQuestion auto-resolution.
    assertNoPendingInteractions(await peer.readPendingInteractions(sessionId));
    throwIfAborted(request.signal);

    const ack = asRecord(await peer.request(METHODS.command, {
      commandId: inputId,
      clientId,
      sessionId,
      type: 'sendText',
      payload: {
        text: request.prompt,
        requestedDelivery: 'startNow',
        modelSelection: selection,
        // 0.16.9 execution scope avoids changing the persisted session selection.
        // memoryExtraction: skip disables Project Memory extraction only; it is
        // not a promise that all session/runtime state remains non-persistent.
        // Do not attach requestAuth: this adapter never forwards credentials.
        modelExecution: {
          selectionScope: 'execution',
          memoryExtraction: 'skip',
          subagents: { foregroundModel: 'submission', background: 'deny' },
        },
      },
      issuedAt: Date.now(),
    }));
    const result = ack.result && typeof ack.result === 'object' && !Array.isArray(ack.result)
      ? asRecord(ack.result)
      : undefined;
    if (ack.commandId !== inputId) {
      const accepted = ack.status === 'accepted';
      throw new Error(accepted
        ? 'ZCode accepted sendText with a mismatched commandId; the input may still be queued or running. Isolate and inspect the session before resuming'
        : 'ZCode sendText ACK commandId did not match this input');
    }
    if (
      ack.status === 'accepted' &&
      result?.type === 'inputAccepted' &&
      result.inputId !== inputId
    ) {
      throw new Error('ZCode accepted sendText with a mismatched inputId; the input may still be queued or running. Isolate and inspect the session before resuming');
    }
    if (
      ack.status === 'accepted' &&
      result?.type === 'inputAccepted' &&
      result.delivery === 'queue'
    ) {
      const withdrawalIssue = await deleteAcceptedQueueItem(inputId);
      if (withdrawalIssue) {
        throw new Error(`ZCode sendText was queued; it may still be queued or already running. Isolate and inspect the session before resuming (${withdrawalIssue})`);
      }
      throw new Error('ZCode sendText was queued and its exact queue item was withdrawn');
    }
    if (ack.status === 'accepted' && result?.type === 'inputAccepted' && result.delivery === 'guide') {
      throw new Error('ZCode sendText was delivered as guide and cannot be safely retracted; isolate and inspect the session before resuming');
    }
    if (ack.status !== 'accepted') {
      throw new Error(`ZCode v4 sendText was ${String(ack.status ?? 'unrecognized')}`);
    }
    if (result?.type !== 'inputAccepted') {
      throw new Error('ZCode accepted sendText but returned no verifiable input disposition; it may still be queued or running. Isolate and inspect the session before resuming');
    }
    if (
      result.delivery !== 'startNow' ||
      result.inputId !== inputId
    ) {
      throw new Error('ZCode accepted sendText without confirming this input started now; it may still be queued or running. Isolate and inspect the session before resuming');
    }
    sent = true;

    while (true) {
      throwIfAborted(request.signal);
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`ZCode protocol session timed out after ${timeoutMs}ms`);
      }

      assertNoPendingInteractions(await peer.readPendingInteractions(sessionId));

      // No limit: upstream limit is a tail slice, not a cursor page. afterSeq is
      // the exclusive cursor; event inputId/turnId isolates this request.
      const result = asRecord(await peer.request(METHODS.events, { sessionId, afterSeq }));
      if (!Array.isArray(result.events)) throw new Error('ZCode session/events returned an invalid events field');
      for (const eventValue of result.events) {
        const event = asRecord(eventValue);
        const seq = typeof event.seq === 'number' ? event.seq : undefined;
        if (seq !== undefined) afterSeq = Math.max(afterSeq, seq);
        const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
          ? asRecord(event.payload)
          : undefined;

        if (isInteractionEvent(event, payload)) {
          throw new Error(interactionBlockReason(event, payload));
        }
        if (
          event.type === 'turn.started' &&
          payload?.inputId === inputId &&
          typeof event.turnId === 'string'
        ) {
          activeTurnId = event.turnId;
          foregroundExecutionId = nonEmptyString(payload.foregroundExecutionId);
          continue;
        }
        const belongsToThisTurn = payload?.inputId === inputId
          || (Boolean(activeTurnId) && event.turnId === activeTurnId);
        if (!belongsToThisTurn) continue;
        if (event.type === 'turn.failed') {
          turnTerminal = true;
          const failure = payload?.error && typeof payload.error === 'object' && !Array.isArray(payload.error)
            ? asRecord(payload.error)
            : undefined;
          throw new Error(nonEmptyString(failure?.message) ?? 'ZCode model turn failed');
        }
        if (event.type === 'turn.completed') {
          turnTerminal = true;
          if (payload?.resultType !== 'success') {
            throw new Error(`ZCode model turn ended with ${String(payload?.resultType ?? 'unknown status')}`);
          }
          return {
            sessionId,
            response: typeof payload.response === 'string' ? payload.response : '',
            requestedModel: request.model,
            modelVerification: 'selector_only',
            status: 'completed',
          };
        }
      }
      await delay(request.pollIntervalMs ?? 250, request.signal);
    }
  } catch (error) {
    let message = safeErrorMessage(error);
    if (sent && !turnTerminal) {
      const stopError = await stop();
      if (stopError) message += `; ${stopError}`;
    }
    if (request.signal?.aborted) throw new Error(message, { cause: error });
    throw new Error(message, { cause: error });
  } finally {
    // Never call session/close: it removes the product session. Closing stdio
    // shuts down this adapter's process while preserving the session for review.
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

function assertNoPendingInteractions(value: unknown): void {
  if (!Array.isArray(value)) throw new Error('ZCode interaction state is unavailable; refusing to run without v4 pendingInteractions');
  if (value.length > 0) {
    const kinds = value.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return 'unparseable interaction';
      const kind = (item as Record<string, unknown>).kind;
      return typeof kind === 'string' ? kind : 'unparseable interaction';
    });
    throw new Error(`ZCode pending interaction blocks unattended execution: ${kinds.join(', ')}`);
  }
}

function assertStartPlanModelAvailable(snapshot: Record<string, unknown>, model: ZCodeProtocolModel): void {
  if (!START_PLAN_PROVIDER_IDS.has(model.providerId) || model.modelId !== START_PLAN_MODEL_ID) {
    throw new Error('ZCode model request is outside the allowed Start Plan GLM-5.3-Flash providers');
  }
  const settings = snapshot.settings && typeof snapshot.settings === 'object' && !Array.isArray(snapshot.settings)
    ? asRecord(snapshot.settings)
    : undefined;
  const modelSettings = settings?.model && typeof settings.model === 'object' && !Array.isArray(settings.model)
    ? asRecord(settings.model)
    : undefined;
  if (!Array.isArray(modelSettings?.available)) {
    throw new Error('ZCode session/create did not provide a verifiable model catalog');
  }
  const candidates = modelSettings.available.flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const option = asRecord(value);
    const ref = option.ref && typeof option.ref === 'object' && !Array.isArray(option.ref)
      ? asRecord(option.ref)
      : undefined;
    if (!ref || !START_PLAN_PROVIDER_IDS.has(String(ref.providerId)) || ref.modelId !== START_PLAN_MODEL_ID) return [];
    return [{ option, providerId: String(ref.providerId) }];
  });
  if (candidates.length !== 1) {
    throw new Error('ZCode Start Plan model catalog entry is missing, duplicated, or ambiguous');
  }
  const candidate = candidates[0]!;
  if (candidate.providerId !== model.providerId) {
    throw new Error('ZCode requested Start Plan provider does not match the unique available catalog entry');
  }
  if (candidate.option.disabledReason !== undefined) {
    throw new Error('ZCode Start Plan model catalog entry is disabled');
  }
  if (model.reasoningLevel) {
    const reasoning = candidate.option.reasoning && typeof candidate.option.reasoning === 'object' && !Array.isArray(candidate.option.reasoning)
      ? asRecord(candidate.option.reasoning)
      : undefined;
    if (!Array.isArray(reasoning?.levels) || !reasoning.levels.some(level =>
      level && typeof level === 'object' && !Array.isArray(level) && asRecord(level).value === model.reasoningLevel
    )) {
      throw new Error('ZCode reasoning level is not listed for the selected Start Plan model');
    }
  }
}

function isInteractionEvent(event: Record<string, unknown>, payload?: Record<string, unknown>): boolean {
  if (
    event.type === 'permission.requested' ||
    event.type === 'userInput.requested' ||
    event.type === 'interaction.requested'
  ) return true;
  return payload?.toolName === 'AskUserQuestion' || payload?.toolName === 'ask_user_question';
}

function interactionBlockReason(event: Record<string, unknown>, payload?: Record<string, unknown>): string {
  const kind = nonEmptyString(event.type) ?? 'unknown interaction event';
  const tool = nonEmptyString(payload?.toolName);
  return `ZCode ${kind}${tool ? ` (${tool})` : ''} blocked unattended execution; no interaction was auto-approved`;
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

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

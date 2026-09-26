import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ZCodeProtocolPeer } from './zcode-protocol-session.js';

const MAX_LINE_BYTES = 17 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 128;
const MAX_REVERSE_BLOCKERS = 16;
const MAX_PRE_ACK_FRAMES = 8;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_INITIAL_FRAME_TIMEOUT_MS = 10_000;
const V4_WIRE_PROTOCOL_VERSION = 3;

export type ZCodeAppServerDiagnosticStage =
  | 'launch'
  | 'preference_ack'
  | 'session_create_rpc'
  | 'subscribe_ack'
  | 'initial_frame_timeout'
  | 'child_exit';

export type ZCodeAppServerDiagnosticOutcome =
  | 'started'
  | 'acknowledged'
  | 'failed'
  | 'timeout'
  | 'exited';

export type ZCodeAppServerDiagnosticCode =
  | 'launch_failed'
  | 'rpc_failed'
  | 'ack_invalid'
  | 'response_invalid'
  | 'initial_frame_timeout'
  | 'child_exit_unexpected'
  | 'child_exit_during_close';

export type ZCodeAppServerRpcErrorCategory =
  | 'method_not_found'
  | 'invalid_params'
  | 'other_protocol_error'
  | 'no_code';

/** Deliberately contains no app-server, process, profile, or task supplied data. */
export interface ZCodeAppServerDiagnosticEvent {
  readonly stage: ZCodeAppServerDiagnosticStage;
  readonly outcome: ZCodeAppServerDiagnosticOutcome;
  readonly code?: ZCodeAppServerDiagnosticCode;
  readonly rpcErrorCategory?: ZCodeAppServerRpcErrorCategory;
  readonly elapsedMs: number;
}

export type ZCodeAppServerDiagnosticSink = (event: ZCodeAppServerDiagnosticEvent) => void;

export interface ZCodeAppServerPeerOptions {
  /** Absolute JavaScript CLI entry, invoked by the current Node executable. */
  entry: string;
  /** Absolute isolated Zero task worktree passed as the child cwd. */
  taskWorktree: string;
  /** Must be explicitly selected; this peer never guesses which profile to use. */
  profileMode: 'isolated' | 'existing-desktop';
  /** Required only for isolated mode; app data must be inside this Zero-owned root. */
  zeroDataRoot?: string;
  /** Required only for isolated mode; never defaults to the user profile. */
  dataBaseDir?: string;
  requestTimeoutMs?: number;
  initialFrameTimeoutMs?: number;
  signal?: AbortSignal;
  /** Receives fixed, privacy-safe lifecycle events. Sink exceptions are ignored. */
  onDiagnostic?: ZCodeAppServerDiagnosticSink;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

class ZCodeAppServerRpcError extends Error {
  constructor(readonly rpcCode: number | undefined) {
    super('ZCode app-server RPC failed');
  }
}

interface SubscriptionState {
  sessionId: string;
  topic: string;
  subscriptionId?: string;
  observedSubscriptionId?: string;
  logEpoch?: string;
  sequence?: number;
  pendingInteractions?: unknown[];
  preAckFrames: Array<{ wire: Record<string, unknown>; bytes: number }>;
  preAckBytes: number;
  error?: Error;
  initialized: Deferred<void>;
  subscribePromise?: Promise<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

/**
 * Zero-owned app-server process using the official 0.16.9 line protocol.
 *
 * The protocol messages are strict `{id,method,params}` / `{id,result}` objects
 * (not JSON-RPC 2.0 envelopes). Profile mode is explicit: isolated mode forces
 * a Zero-owned data directory; existing-desktop mode leaves data-root selection
 * untouched and forwards only the minimum profile/proxy environment.
 */
export class ZCodeAppServerPeer implements ZCodeProtocolPeer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscriptions = new Map<string, SubscriptionState>();
  private readonly interactionGatedSessions = new Set<string>();
  private readonly globalBlockers: string[] = [];
  private nextRequestId = 1;
  private stdoutBuffer = Buffer.alloc(0);
  private terminalError?: Error;
  private closing = false;
  private childClosed = false;
  private closePromise?: Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly initialFrameTimeoutMs: number;
  private readonly connectionId = randomUUID();
  private readonly abortSignal?: AbortSignal;
  private readonly diagnosticSink?: ZCodeAppServerDiagnosticSink;
  private readonly launchedAt = Date.now();

  private constructor(options: ZCodeAppServerPeerOptions, child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.initialFrameTimeoutMs = options.initialFrameTimeoutMs ?? DEFAULT_INITIAL_FRAME_TIMEOUT_MS;
    this.abortSignal = options.signal;
    this.diagnosticSink = options.onDiagnostic;
    child.stdout.on('data', this.onStdout);
    child.stderr.on('data', this.onStderr);
    child.stdin.on('error', this.onInputError);
    child.stdin.on('close', this.onInputError);
    child.stdout.on('error', this.onStreamError);
    child.stderr.on('error', this.onStreamError);
    child.once('error', this.onChildError);
    child.once('close', this.onChildClose);
    options.signal?.addEventListener('abort', this.onAbort, { once: true });
    if (options.signal?.aborted) this.onAbort();
  }

  static async launch(options: ZCodeAppServerPeerOptions): Promise<ZCodeAppServerPeer> {
    const startedAt = Date.now();
    emitDiagnostic(options.onDiagnostic, 'launch', 'started', undefined, 0);
    let peer: ZCodeAppServerPeer | undefined;
    try {
      validateOptions(options);
      await access(options.entry);
      const taskStat = await stat(options.taskWorktree);
      if (!taskStat.isDirectory()) throw new Error('ZCode taskWorktree must be an existing directory');
      if (options.profileMode === 'isolated') {
        await mkdir(options.zeroDataRoot!, { recursive: true });
        await mkdir(options.dataBaseDir!, { recursive: true });
        const [realRoot, realDataDir, realWorktree] = await Promise.all([
          realpath(options.zeroDataRoot!),
          realpath(options.dataBaseDir!),
          realpath(options.taskWorktree),
        ]);
        if (!isPathInside(realRoot, realDataDir)) {
          throw new Error('ZCode dataBaseDir resolves outside the Zero-owned data root');
        }
        if (realWorktree === realDataDir || isPathInside(realWorktree, realDataDir) || isPathInside(realDataDir, realWorktree)) {
          throw new Error('ZCode app data directory resolves inside the task worktree');
        }
      }

      const child = spawn(process.execPath, [options.entry, 'app-server'], {
        cwd: options.taskWorktree,
        env: childEnvironment(options.profileMode, options.dataBaseDir),
        shell: false,
        windowsHide: true,
        stdio: 'pipe',
        detached: process.platform !== 'win32',
      });
      peer = new ZCodeAppServerPeer(options, child);
      await peer.waitForSpawn();
      peer.emitDiagnostic('launch', 'acknowledged', undefined, elapsedMs(startedAt));
      return peer;
    } catch (error) {
      emitDiagnostic(options.onDiagnostic, 'launch', 'failed', 'launch_failed', elapsedMs(startedAt));
      if (peer) await peer.close();
      throw error;
    }
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!['session/create', 'session/events', 'v4/conversation/subscribe', 'v4/command'].includes(method)) {
      throw new Error('ZCode app-server peer refuses an unsupported method');
    }
    if (method === 'session/create') {
      if (Object.keys(params).some(key => key !== 'workspace' && key !== 'persistence') || params.persistence !== 'deferred') {
        throw new Error('ZCode session/create refused fields outside the gated deferred task-session schema');
      }
      const workspace = asRecord(params.workspace);
      const workspacePath = nonEmptyString(workspace.workspacePath);
      const workspaceKey = nonEmptyString(workspace.workspaceKey);
      const workspaceIdentity = nonEmptyString(workspace.workspaceIdentity);
      if (!workspacePath || !workspaceKey || !workspaceIdentity || Object.hasOwn(workspace, 'remoteSessionId')) {
        throw new Error('ZCode session/create requires a local workspace identity for interaction safety gating');
      }
      const expectedWorkspace = { workspacePath, workspaceIdentity, workspaceKey };
      const preferenceStartedAt = Date.now();
      this.emitDiagnostic('preference_ack', 'started', undefined, 0);
      let preferenceResult: unknown;
      try {
        preferenceResult = await this.requestRaw('workspace/updateInteractionPreferences', {
          workspace: expectedWorkspace,
          preferences: { askUserQuestionAutoResolutionEnabled: false },
        });
      } catch (error) {
        this.emitDiagnostic('preference_ack', 'failed', 'rpc_failed', elapsedMs(preferenceStartedAt), rpcErrorCategory(error));
        throw error;
      }
      let preference: Record<string, unknown>;
      let acknowledgedWorkspace: Record<string, unknown>;
      try {
        preference = asRecord(preferenceResult);
        acknowledgedWorkspace = asRecord(preference.workspace);
      } catch {
        this.emitDiagnostic('preference_ack', 'failed', 'ack_invalid', elapsedMs(preferenceStartedAt));
        throw new Error('ZCode interaction preference ACK was malformed');
      }
      if (
        Object.keys(preference).length !== 3 ||
        preference.askUserQuestionAutoResolutionEnabled !== false ||
        preference.workspace === undefined ||
        Object.keys(acknowledgedWorkspace).length !== 3 ||
        acknowledgedWorkspace.workspacePath !== workspacePath ||
        acknowledgedWorkspace.workspaceIdentity !== workspaceIdentity ||
        acknowledgedWorkspace.workspaceKey !== workspaceKey ||
        !Number.isSafeInteger(preference.snoozedInteractionCount) ||
        Number(preference.snoozedInteractionCount) < 0
      ) {
        this.emitDiagnostic('preference_ack', 'failed', 'ack_invalid', elapsedMs(preferenceStartedAt));
        throw new Error('ZCode interaction auto-resolution disablement was not confirmed; session creation refused');
      }
      this.emitDiagnostic('preference_ack', 'acknowledged', undefined, elapsedMs(preferenceStartedAt));
      const sessionStartedAt = Date.now();
      this.emitDiagnostic('session_create_rpc', 'started', undefined, 0);
      let created: unknown;
      try {
        created = await this.requestRaw(method, params);
      } catch (error) {
        this.emitDiagnostic('session_create_rpc', 'failed', 'rpc_failed', elapsedMs(sessionStartedAt));
        throw error;
      }
      const session = isRecord(created) && isRecord(created.session) ? created.session : undefined;
      const sessionId = nonEmptyString(session?.sessionId);
      if (!sessionId) this.emitDiagnostic('session_create_rpc', 'failed', 'response_invalid', elapsedMs(sessionStartedAt));
      else this.emitDiagnostic('session_create_rpc', 'acknowledged', undefined, elapsedMs(sessionStartedAt));
      if (sessionId) this.interactionGatedSessions.add(sessionId);
      return created;
    }
    if (method === 'v4/command') {
      const sessionId = nonEmptyString(params.sessionId);
      if (!sessionId || !this.interactionGatedSessions.has(sessionId)) {
        throw new Error('ZCode command refused because it does not target an interaction-gated task session');
      }
      if (params.type === 'sendText') {
        if (!hasSafeSendTextExecution(params.payload)) {
          throw new Error('ZCode sendText refused without execution-scoped model, memory, and subagent safeguards');
        }
      } else if (params.type === 'stop') {
        const payload = isRecord(params.payload) ? params.payload : undefined;
        if (!nonEmptyString(payload?.expectedForegroundExecutionId)) {
          throw new Error('ZCode stop refused without an expected foreground execution token');
        }
      } else if (params.type !== 'deleteQueueItem') {
        throw new Error('ZCode app-server peer refuses unsupported v4 command types');
      }
    }
    return this.requestRaw(method, params);
  }

  private async requestRaw(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.assertUsable();
    const id = `zero-${this.nextRequestId++}`;
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      throw new Error('ZCode app-server peer request limit reached');
    }
    const response = new Promise<unknown>((resolveResponse, rejectResponse) => {
      const key = responseKey(id)!;
      const timer = setTimeout(() => {
        this.pending.delete(key);
        const error = new Error(`ZCode app-server RPC timed out (${method})`);
        rejectResponse(error);
        this.fail(error);
      }, this.requestTimeoutMs);
      this.pending.set(key, { resolve: resolveResponse, reject: rejectResponse, timer });
    });
    try {
      await this.writeMessage({ id, method, params });
    } catch (error) {
      const writeError = new Error('ZCode app-server request write failed');
      this.fail(writeError);
      await response.catch(() => undefined);
      throw error instanceof Error ? error : new Error('ZCode app-server request write failed');
    }
    return response;
  }

  async readPendingInteractions(sessionId: string): Promise<unknown> {
    this.assertUsable();
    if (this.globalBlockers.length > 0) {
      throw new Error(`ZCode app-server blocked reverse request: ${this.globalBlockers[0]}`);
    }
    let state = this.subscriptions.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        topic: `conversation/${sessionId}`,
        initialized: deferred<void>(),
        preAckFrames: [],
        preAckBytes: 0,
      };
      this.subscriptions.set(sessionId, state);
      state.subscribePromise = this.subscribe(state);
    }
    await state.subscribePromise;
    const frameWaitStartedAt = Date.now();
    try {
      await withTimeout(state.initialized.promise, this.initialFrameTimeoutMs, 'ZCode v4 conversation snapshot timed out');
    } catch (error) {
      if (error instanceof InitialFrameTimeoutError) {
        this.emitDiagnostic('initial_frame_timeout', 'timeout', 'initial_frame_timeout', elapsedMs(frameWaitStartedAt));
      }
      throw error;
    }
    if (state.error) throw state.error;
    if (!Array.isArray(state.pendingInteractions)) {
      throw new Error('ZCode v4 conversation snapshot has no pendingInteractions state');
    }
    return [...state.pendingInteractions];
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.abortSignal?.removeEventListener('abort', this.onAbort);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('ZCode app-server peer closed'));
      this.pending.delete(id);
    }
    this.closePromise = this.closeProcess();
    return this.closePromise;
  }

  private async subscribe(state: SubscriptionState): Promise<void> {
    const startedAt = Date.now();
    this.emitDiagnostic('subscribe_ack', 'started', undefined, 0);
    let response: unknown;
    try {
      response = await this.request('v4/conversation/subscribe', {
        topic: state.topic,
        connectionId: this.connectionId,
        clientMode: 'desktop-continuous',
      });
    } catch (error) {
      this.emitDiagnostic('subscribe_ack', 'failed', 'rpc_failed', elapsedMs(startedAt));
      throw error;
    }
    let ack: Record<string, unknown>;
    try {
      const result = asRecord(response);
      ack = asRecord(result.ack);
    } catch {
      this.emitDiagnostic('subscribe_ack', 'failed', 'ack_invalid', elapsedMs(startedAt));
      throw new Error('ZCode v4 conversation subscribe returned an invalid initial snapshot ACK');
    }
    const subscriptionId = nonEmptyString(ack.subscriptionId);
    const logEpoch = nonEmptyString(ack.logEpoch);
    if (!subscriptionId || ack.mode !== 'snapshot' || !logEpoch) {
      this.emitDiagnostic('subscribe_ack', 'failed', 'ack_invalid', elapsedMs(startedAt));
      throw new Error('ZCode v4 conversation subscribe returned an invalid initial snapshot ACK');
    }
    if (state.observedSubscriptionId && state.observedSubscriptionId !== subscriptionId) {
      this.emitDiagnostic('subscribe_ack', 'failed', 'ack_invalid', elapsedMs(startedAt));
      throw new Error('ZCode v4 conversation frame subscriptionId did not match its ACK');
    }
    this.emitDiagnostic('subscribe_ack', 'acknowledged', undefined, elapsedMs(startedAt));
    state.subscriptionId = subscriptionId;
    state.logEpoch = logEpoch;
    for (const queued of state.preAckFrames) this.applyConversationWire(state, queued.wire);
    state.preAckFrames = [];
    state.preAckBytes = 0;
  }

  private readonly onStdout = (chunk: Buffer | string): void => {
    if (this.terminalError || this.closing) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, bytes]);
    if (this.stdoutBuffer.length > MAX_LINE_BYTES && this.stdoutBuffer.indexOf(0x0a) < 0) {
      this.fail(new Error('ZCode app-server NDJSON line exceeded the safe size limit'));
      return;
    }
    let newline = this.stdoutBuffer.indexOf(0x0a);
    while (newline >= 0) {
      if (newline > MAX_LINE_BYTES) {
        this.fail(new Error('ZCode app-server NDJSON line exceeded the safe size limit'));
        return;
      }
      const line = this.stdoutBuffer.subarray(0, newline).toString('utf8').trim();
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line) this.dispatchLine(line);
      if (this.terminalError) return;
      newline = this.stdoutBuffer.indexOf(0x0a);
    }
  };

  private readonly onStderr = (): void => {
    // Stderr is drained to prevent child backpressure but never retained or surfaced.
  };

  private readonly onInputError = (): void => {
    if (!this.closing) this.fail(new Error('ZCode app-server stdin closed'));
  };

  private readonly onStreamError = (): void => {
    this.fail(new Error('ZCode app-server stream failed'));
  };

  private readonly onChildError = (): void => {
    this.fail(new Error('ZCode app-server process failed to start'));
  };

  private readonly onChildClose = (code: number | null): void => {
    this.childClosed = true;
    this.emitDiagnostic('child_exit', 'exited', this.closing ? 'child_exit_during_close' : 'child_exit_unexpected', elapsedMs(this.launchedAt));
    if (!this.closing && !this.terminalError) {
      this.fail(new Error(`ZCode app-server exited unexpectedly (${code ?? 'no exit code'})`));
    }
  };

  private readonly onAbort = (): void => {
    this.fail(new Error('ZCode app-server peer cancelled'));
  };

  private dispatchLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      this.fail(new Error('ZCode app-server emitted malformed NDJSON'));
      return;
    }
    if (!isRecord(message)) {
      this.fail(new Error('ZCode app-server emitted an invalid protocol message'));
      return;
    }
    if (Object.hasOwn(message, 'id') && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      this.handleResponse(message);
      return;
    }
    if (Object.hasOwn(message, 'id') && typeof message.method === 'string') {
      this.handleReverseRequest(message);
      return;
    }
    if (typeof message.method === 'string') {
      if (message.method === 'v4/conversation/frame') this.handleConversationFrame(message.params, Buffer.byteLength(line, 'utf8'));
      // Other notifications have no request/response lifecycle. No app-server data
      // is logged; the interaction-bearing request methods are handled separately.
      return;
    }
    this.fail(new Error('ZCode app-server emitted an unrecognized protocol message'));
  }

  private handleResponse(message: Record<string, unknown>): void {
    const key = responseKey(message.id);
    if (!key) {
      this.fail(new Error('ZCode app-server response used an invalid request id'));
      return;
    }
    const pending = this.pending.get(key);
    if (!pending) {
      this.fail(new Error('ZCode app-server response id did not match a pending request'));
      return;
    }
    this.pending.delete(key);
    clearTimeout(pending.timer);
    if (Object.hasOwn(message, 'error')) {
      const rpcError = isRecord(message.error) ? message.error : undefined;
      const rpcCode = typeof rpcError?.code === 'number' ? rpcError.code : undefined;
      pending.reject(new ZCodeAppServerRpcError(rpcCode));
      return;
    }
    pending.resolve(message.result);
  }

  private handleReverseRequest(message: Record<string, unknown>): void {
    if (responseKey(message.id) === undefined) {
      this.fail(new Error('ZCode app-server reverse request used an invalid id'));
      return;
    }
    const method = typeof message.method === 'string' ? message.method : '';
    const params = isRecord(message.params) ? message.params : undefined;
    const knownInteraction = method === 'interaction/requestPermission' ||
      method === 'interaction/requestUserInput';
    const knownRuntimePreference = method === 'session/requestRuntimePreferences';
    if (knownRuntimePreference) {
      const sessionId = nonEmptyString(params?.sessionId);
      const validKeys = params !== undefined && Object.keys(params).every(key => key === 'sessionId' || key === 'scope');
      const validScope = params?.scope === 'runtime-materialization' || params?.scope === 'user-execution';
      if (sessionId && validKeys && validScope) {
        void this.writeMessage({
          id: message.id,
          result: {
            nativeSearchEnhancementsEnabled: false,
            memoryEnabled: false,
            askUserQuestionAutoResolutionEnabled: false,
            modelContextBudgetStrategy: 'preflight-v1',
          },
        }).catch(() => this.fail(new Error('ZCode runtime preference response failed')));
        return;
      }
      if (this.globalBlockers.length < MAX_REVERSE_BLOCKERS) {
        this.globalBlockers.push('runtime preference reverse request was malformed');
      }
      void this.writeMessage({
        id: message.id,
        error: { code: -32001, message: 'Zero-owned app-server peer refuses malformed runtime preference requests' },
      }).catch(() => this.fail(new Error('ZCode runtime preference error response failed')));
      return;
    }
    const sessionId = nonEmptyString(params?.sessionId);
    const reason = knownInteraction
      ? 'interaction request is not supported by the Zero peer'
      : 'reverse request is not supported by the Zero peer';
    if (sessionId && this.subscriptions.has(sessionId)) {
      this.setSubscriptionError(this.subscriptions.get(sessionId)!, new Error(`ZCode ${reason}`));
    } else if (this.globalBlockers.length < MAX_REVERSE_BLOCKERS) {
      this.globalBlockers.push(reason);
    }
    // Always answer the reverse RPC with an error. Dropping it would leave the
    // server awaiting a permission/runtime-preferences response indefinitely.
    void this.writeMessage({
      id: message.id,
      error: { code: -32001, message: 'Zero-owned app-server peer refuses reverse requests' },
    }).catch(() => this.fail(new Error('ZCode app-server reverse request response failed')));
  }

  private handleConversationFrame(value: unknown, bytes: number): void {
    if (!isRecord(value) || typeof value.topic !== 'string') {
      this.fail(new Error('ZCode v4 conversation frame is malformed'));
      return;
    }
    const sessionId = value.topic.startsWith('conversation/') ? value.topic.slice('conversation/'.length) : '';
    const state = this.subscriptions.get(sessionId);
    if (!state) {
      if (this.globalBlockers.length < MAX_REVERSE_BLOCKERS) this.globalBlockers.push('unexpected conversation frame received');
      return;
    }
    if (!state.subscriptionId) {
      if (state.preAckFrames.length >= MAX_PRE_ACK_FRAMES || state.preAckBytes + bytes > MAX_LINE_BYTES) {
        this.setSubscriptionError(state, new Error('ZCode v4 pre-ACK conversation frames exceeded the safe buffer limit'));
        return;
      }
      state.preAckFrames.push({ wire: value, bytes });
      state.preAckBytes += bytes;
      return;
    }
    try {
      this.applyConversationWire(state, value);
    } catch (error) {
      this.setSubscriptionError(state, error instanceof Error ? error : new Error('ZCode v4 conversation frame could not be verified'));
    }
  }

  private applyConversationWire(state: SubscriptionState, wire: Record<string, unknown>): void {
    if (wire.wireVersion !== V4_WIRE_PROTOCOL_VERSION) throw new Error('ZCode v4 wire version mismatch');
    if (wire.kind === 'fragment') throw new Error('ZCode v4 fragmented conversation frames are unsupported by this peer');
    if (wire.kind !== 'complete') throw new Error('ZCode v4 conversation wire frame kind is invalid');
    if (!['initial', 'online', 'recovery'].includes(String(wire.deliveryKind))) {
      throw new Error('ZCode v4 conversation deliveryKind is invalid');
    }
    if (!nonEmptyString(wire.logicalFrameId) || !Number.isSafeInteger(wire.logicalFrameOrdinal) || Number(wire.logicalFrameOrdinal) < 1) {
      throw new Error('ZCode v4 logical frame identity is invalid');
    }
    if (wire.topic !== state.topic) throw new Error('ZCode v4 conversation topic mismatch');
    const subscriptionId = nonEmptyString(wire.subscriptionId);
    if (!subscriptionId) throw new Error('ZCode v4 conversation frame has no subscriptionId');
    if (state.subscriptionId && subscriptionId !== state.subscriptionId) throw new Error('ZCode v4 conversation subscriptionId mismatch');
    if (state.observedSubscriptionId && subscriptionId !== state.observedSubscriptionId) throw new Error('ZCode v4 conversation subscriptionId changed');
    state.observedSubscriptionId = subscriptionId;
    const frame = asRecord(wire.frame);
    if (frame.topic !== state.topic || frame.subscriptionId !== subscriptionId) {
      throw new Error('ZCode v4 logical conversation frame routing mismatch');
    }
    if (!Number.isSafeInteger(frame.fromSeq) || !Number.isSafeInteger(frame.toSeq) || Number(frame.toSeq) < Number(frame.fromSeq)) {
      throw new Error('ZCode v4 conversation frame sequence is invalid');
    }
    const payload = asRecord(frame.payload);
    if (payload.kind === 'snapshot') {
      const snapshot = asRecord(payload.snapshot);
      if (
        wire.deliveryKind !== 'initial' ||
        snapshot.protocolVersion !== 1 ||
        snapshot.sessionId !== state.sessionId ||
        snapshot.logEpoch !== state.logEpoch ||
        !Array.isArray(snapshot.pendingInteractions)
      ) {
        throw new Error('ZCode v4 snapshot lacks the expected session pendingInteractions state');
      }
      if (frame.fromSeq !== 0 || !Number.isSafeInteger(snapshot.seq) || frame.toSeq !== snapshot.seq) {
        throw new Error('ZCode v4 snapshot sequence did not match its frame');
      }
      state.pendingInteractions = [...snapshot.pendingInteractions];
      validatePendingInteractions(state.pendingInteractions);
      state.sequence = Number(frame.toSeq);
      state.initialized.resolve(undefined);
      return;
    }
    if (payload.kind !== 'deltas' || !Array.isArray(payload.deltas)) {
      throw new Error('ZCode v4 conversation payload kind is invalid');
    }
    if (wire.deliveryKind === 'initial') throw new Error('ZCode v4 initial delivery must contain a snapshot');
    if (state.sequence === undefined || frame.fromSeq !== state.sequence) {
      throw new Error('ZCode v4 conversation delta arrived before snapshot or with a sequence gap');
    }
    if (Number(frame.toSeq) <= Number(frame.fromSeq) || payload.deltas.length === 0) {
      throw new Error('ZCode v4 conversation delta frame has an invalid sequence range');
    }
    for (const deltaValue of payload.deltas) {
      const delta = asRecord(deltaValue);
      if (delta.op !== 'state.updated') continue;
      const patch = asRecord(delta.patch);
      if (Object.hasOwn(patch, 'pendingInteractions')) {
        if (!Array.isArray(patch.pendingInteractions)) throw new Error('ZCode pendingInteractions delta is malformed');
        validatePendingInteractions(patch.pendingInteractions);
        state.pendingInteractions = [...patch.pendingInteractions];
      }
    }
    state.sequence = Number(frame.toSeq);
  }

  private setSubscriptionError(state: SubscriptionState, error: Error): void {
    if (state.error) return;
    state.error = error;
    state.initialized.reject(error);
  }

  private async writeMessage(message: Record<string, unknown>): Promise<void> {
    this.assertUsable();
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw new Error('ZCode app-server request exceeded the safe line size limit');
    if (this.child.stdin.write(line, 'utf8')) return;
    await waitForDrain(this.child.stdin);
    this.assertUsable();
  }

  private assertUsable(): void {
    if (this.terminalError) throw this.terminalError;
    if (this.closing) throw new Error('ZCode app-server peer is closed');
  }

  private fail(error: Error): void {
    if (this.terminalError || this.closing) return;
    this.terminalError = error;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const state of this.subscriptions.values()) this.setSubscriptionError(state, error);
    void terminateChildTree(this.child).catch(() => undefined);
  }

  private emitDiagnostic(
    stage: ZCodeAppServerDiagnosticStage,
    outcome: ZCodeAppServerDiagnosticOutcome,
    code: ZCodeAppServerDiagnosticCode | undefined,
    elapsed: number,
    rpcErrorCategory?: ZCodeAppServerRpcErrorCategory,
  ): void {
    emitDiagnostic(this.diagnosticSink, stage, outcome, code, elapsed, rpcErrorCategory);
  }

  private async waitForSpawn(): Promise<void> {
    if (this.child.pid) return;
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      const timer = setTimeout(() => rejectSpawn(new Error('ZCode app-server did not start')), 5_000);
      this.child.once('spawn', () => {
        clearTimeout(timer);
        resolveSpawn();
      });
      this.child.once('error', () => {
        clearTimeout(timer);
        rejectSpawn(new Error('ZCode app-server failed to start'));
      });
    });
  }

  private async closeProcess(): Promise<void> {
    if (this.childClosed) return;
    if (!this.child.pid) {
      if (await this.waitForChildClose(5_000)) return;
      throw new Error('ZCode app-server close was not observed after launch failure');
    }
    this.child.stdin.end();
    if (await this.waitForChildClose(750)) return;
    let terminationError: Error | undefined;
    try { await terminateChildTree(this.child); } catch {
      terminationError = new Error('ZCode app-server process tree termination failed');
    }
    if (!await this.waitForChildClose(5_000)) {
      throw new Error('ZCode app-server process exit could not be confirmed; isolate the task and do not continue', { cause: terminationError });
    }
    if (terminationError) throw terminationError;
  }

  private waitForChildClose(timeoutMs: number): Promise<boolean> {
    if (this.childClosed) return Promise.resolve(true);
    return new Promise(resolveClose => {
      const finish = (closed: boolean) => {
        clearTimeout(timer);
        this.child.off('close', onClose);
        resolveClose(closed);
      };
      const onClose = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.child.once('close', onClose);
    });
  }
}

function validateOptions(options: ZCodeAppServerPeerOptions): void {
  if (!isAbsolute(options.entry) || !['.js', '.mjs', '.cjs'].includes(extname(options.entry).toLowerCase())) {
    throw new Error('ZCode CLI entry must be an absolute JavaScript file path');
  }
  if (!isAbsolute(options.taskWorktree)) throw new Error('ZCode taskWorktree must be absolute');
  if (options.profileMode !== 'isolated' && options.profileMode !== 'existing-desktop') {
    throw new Error('ZCode profileMode must be explicitly selected');
  }
  if (options.profileMode === 'isolated') {
    if (!options.zeroDataRoot || !isAbsolute(options.zeroDataRoot)) throw new Error('ZCode zeroDataRoot must be absolute in isolated mode');
    if (!options.dataBaseDir || !isAbsolute(options.dataBaseDir)) throw new Error('ZCode dataBaseDir must be absolute in isolated mode');
    const worktree = resolve(options.taskWorktree);
    const zeroRoot = resolve(options.zeroDataRoot);
    const dataDir = resolve(options.dataBaseDir);
    if (!isPathInside(zeroRoot, dataDir)) throw new Error('ZCode dataBaseDir must be inside the Zero-owned data root');
    if (worktree === dataDir || isPathInside(worktree, dataDir) || isPathInside(dataDir, worktree)) {
      throw new Error('ZCode app data directory must be isolated from the task worktree');
    }
  } else if (options.zeroDataRoot !== undefined || options.dataBaseDir !== undefined) {
    throw new Error('ZCode existing-desktop mode must not override the profile data root');
  }
  for (const [name, value] of Object.entries({
    requestTimeoutMs: options.requestTimeoutMs,
    initialFrameTimeoutMs: options.initialFrameTimeoutMs,
  })) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error(`${name} must be positive`);
  }
}

function validatePendingInteractions(values: unknown[]): void {
  for (const value of values) {
    if (!isRecord(value)) throw new Error('ZCode pendingInteractions contains an invalid entry');
    const kind = value.kind;
    if (!['permission', 'userInput', 'workspaceHookReview'].includes(String(kind))) {
      throw new Error('ZCode pendingInteractions contains an unknown kind');
    }
    if (!nonEmptyString(value.interactionId) || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0) {
      throw new Error('ZCode pendingInteractions entry identity is invalid');
    }
    if (value.anchorRowId !== null && typeof value.anchorRowId !== 'number') {
      throw new Error('ZCode pendingInteractions anchor is invalid');
    }
    if (!isRecord(value.payload) || value.payload.kind !== kind) {
      throw new Error('ZCode pendingInteractions payload does not match its kind');
    }
    const payload = value.payload;
    if (kind === 'permission' && (
      typeof payload.toolCallId !== 'string' || typeof payload.toolName !== 'string' ||
      typeof payload.summary !== 'string' || !Object.hasOwn(payload, 'detail') || !Array.isArray(payload.options)
    )) throw new Error('ZCode permission interaction payload is malformed');
    if (kind === 'userInput' && (typeof payload.prompt !== 'string' || typeof payload.freeText !== 'boolean')) {
      throw new Error('ZCode userInput interaction payload is malformed');
    }
    if (kind === 'workspaceHookReview' && (
      typeof payload.interactionId !== 'string' || payload.interactionId !== value.interactionId ||
      typeof payload.reviewFlowId !== 'string' || !Number.isSafeInteger(payload.generation)
    )) throw new Error('ZCode workspaceHookReview interaction payload is malformed');
  }
}

function hasSafeSendTextExecution(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const payloadKeys = ['text', 'requestedDelivery', 'modelSelection', 'modelExecution'];
  if (Object.keys(value).some(key => !payloadKeys.includes(key))) return false;
  if (typeof value.text !== 'string' || !value.text.trim() || value.requestedDelivery !== 'startNow') return false;
  const selection = isRecord(value.modelSelection) ? value.modelSelection : undefined;
  if (!selection || Object.keys(selection).some(key => !['providerId', 'modelId', 'options'].includes(key))) return false;
  if (!nonEmptyString(selection.providerId) || !nonEmptyString(selection.modelId)) return false;
  if (selection.options !== undefined) {
    const options = isRecord(selection.options) ? selection.options : undefined;
    if (!options || Object.keys(options).some(key => key !== 'reasoningLevel') ||
      (options.reasoningLevel !== undefined && !nonEmptyString(options.reasoningLevel))) return false;
  }
  const execution = isRecord(value.modelExecution) ? value.modelExecution : undefined;
  if (!execution || Object.keys(execution).some(key => !['selectionScope', 'memoryExtraction', 'subagents'].includes(key))) return false;
  if (execution.selectionScope !== 'execution' || execution.memoryExtraction !== 'skip') return false;
  const subagents = isRecord(execution.subagents) ? execution.subagents : undefined;
  return Boolean(subagents && Object.keys(subagents).length === 2 &&
    subagents.foregroundModel === 'submission' && subagents.background === 'deny');
}

function childEnvironment(profileMode: ZCodeAppServerPeerOptions['profileMode'], dataBaseDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowed = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'];
  const proxyNames = [
    ['HTTP_PROXY', 'http_proxy'],
    ['HTTPS_PROXY', 'https_proxy'],
    ['ALL_PROXY', 'all_proxy'],
    ['NO_PROXY', 'no_proxy'],
  ];
  if (profileMode === 'existing-desktop') {
    allowed.push('APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'ZCODE_DATA_BASE_DIR');
  }
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (profileMode === 'isolated') {
    // Node on Windows synthesizes USERPROFILE even when omitted from env; blank
    // all profile locators so ZCode cannot accidentally fall back to the desktop.
    env.APPDATA = '';
    env.LOCALAPPDATA = '';
    env.USERPROFILE = '';
    env.HOME = '';
  } else {
    for (const variants of proxyNames) {
      const found = variants.filter(key => process.env[key] !== undefined);
      if (process.platform === 'win32') {
        const key = found[0];
        if (key) env[variants[0]!] = process.env[key];
      } else {
        for (const key of found) env[key] = process.env[key];
      }
    }
  }
  if (profileMode === 'isolated' && dataBaseDir) env.ZCODE_DATA_BASE_DIR = resolve(dataBaseDir);
  return env;
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function responseKey(value: unknown): string | undefined {
  if (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))) {
    return `${typeof value}:${String(value)}`;
  }
  return undefined;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // A subscription may fail before readPendingInteractions reaches its await.
  void promise.catch(() => undefined);
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new InitialFrameTimeoutError(message)), timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolvePromise(value); },
      error => { clearTimeout(timer); rejectPromise(error); },
    );
  });
}

class InitialFrameTimeoutError extends Error {}

function elapsedMs(startedAt: number): number {
  return Math.min(24 * 60 * 60 * 1_000, Math.max(0, Math.floor(Date.now() - startedAt)));
}

function emitDiagnostic(
  sink: ZCodeAppServerDiagnosticSink | undefined,
  stage: ZCodeAppServerDiagnosticStage,
  outcome: ZCodeAppServerDiagnosticOutcome,
  code: ZCodeAppServerDiagnosticCode | undefined,
  elapsed: number,
  rpcErrorCategory?: ZCodeAppServerRpcErrorCategory,
): void {
  if (typeof sink !== 'function') return;
  const event: ZCodeAppServerDiagnosticEvent = {
    stage,
    outcome,
    ...(code === undefined ? {} : { code }),
    ...(rpcErrorCategory === undefined ? {} : { rpcErrorCategory }),
    elapsedMs: Math.min(24 * 60 * 60 * 1_000, Math.max(0, Math.floor(elapsed))),
  };
  try { sink(event); } catch {
    // Diagnostics are observational and cannot change protocol behavior.
  }
}

function rpcErrorCategory(error: unknown): ZCodeAppServerRpcErrorCategory {
  if (!(error instanceof ZCodeAppServerRpcError) || error.rpcCode === undefined) return 'no_code';
  if (error.rpcCode === -32601) return 'method_not_found';
  if (error.rpcCode === -32602) return 'invalid_params';
  return 'other_protocol_error';
}

function waitForDrain(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolveDrain, rejectDrain) => {
    const onDrain = () => { cleanup(); resolveDrain(); };
    const onError = () => { cleanup(); rejectDrain(new Error('ZCode app-server stdin write failed')); };
    const cleanup = () => {
      stream.off('drain', onDrain);
      stream.off('error', onError);
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

async function terminateChildTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || !child.pid) return;
  let treeKillFailed = false;
  if (process.platform === 'win32') {
    const { execFile } = await import('node:child_process');
    await new Promise<void>((resolveKill, rejectKill) => {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, error => {
        if (error) rejectKill(error);
        else resolveKill();
      });
    }).catch(() => { treeKillFailed = true; });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        treeKillFailed = true;
      }
    }
  }
  if (!child.kill('SIGKILL') && child.exitCode === null) treeKillFailed = true;
  if (treeKillFailed) throw new Error('ZCode app-server process tree termination failed');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('ZCode app-server returned an invalid object');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

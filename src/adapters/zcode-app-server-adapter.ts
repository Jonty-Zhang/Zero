import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { HarnessAdapter, HarnessCapabilities, RunRequest, RunResult } from '../domain/types.js';
import { ZCodeAppServerPeer } from './zcode-app-server-peer.js';
import type { ZCodeAppServerDiagnosticEvent, ZCodeAppServerPeerOptions, ZCodeAppServerTransportFailureCategory } from './zcode-app-server-peer.js';
import { runZCodeProtocolSession, ZCodeQuotaError } from './zcode-protocol-session.js';
import type { ZCodeProtocolPeer } from './zcode-protocol-session.js';
import type { ModelBinding, ModelConfig, ReasoningEffort } from './types.js';
import { runProcess } from './process-runner.js';

export type ExistingDesktopBinding = Extract<ModelBinding, { harness: 'zcode'; selector: 'app_server_existing_desktop' }>;

export interface ZCodeAppServerAdapterConfig {
  /** Absolute JavaScript CLI entry used by both the help probe and app-server. */
  zcodeEntry?: string;
  bindings?: ModelBinding[];
  timeoutMs?: number;
  probeDataDir?: string;
  /** Deterministic test seam. Probe arguments remain limited to --version/--help. */
  runProbeCommand?: (args: string[]) => Promise<ProbeCommandResult>;
  /** Deterministic test seam for a peer launched with existing-desktop mode. */
  launchPeer?: (options: ZCodeAppServerPeerOptions) => Promise<ZCodeProtocolPeer>;
}

export interface ProbeCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface ZCodeDesktopDiagnostic {
  version: 'not_run' | 'reported' | 'unavailable';
  childSpawn: 'not_run' | 'started' | 'failed';
  sessionCreate: 'not_run' | 'acknowledged' | 'failed';
  failureStage: 'not_checked' | 'none' | 'launch' | 'preference_ack' | 'session_create' | 'response_shape' | 'model_registry';
  preferenceAckFailure: 'not_checked' | 'none' | 'rpc_failed' | 'ack_invalid' | 'other';
  preferenceAckRpcFailure: 'not_checked' | 'not_applicable' | 'method_not_found' | 'invalid_params' | 'other_protocol_error' | 'no_code';
  preferenceAckTransportFailure: 'not_checked' | 'not_applicable' | ZCodeAppServerTransportFailureCategory;
  modelRegistry: 'not_checked' | 'unavailable' | 'empty' | 'populated';
  modelCount: number | null;
}

const MAX_PROBE_OUTPUT = 64 * 1024;
const SUPPORTED_ROLES = new Set(['implement', 'revise']);
const SAFE_MODEL_ID = /^[^\u0000-\u001f\u007f]{1,256}$/;

/** Runs an explicit model turn through a separate stdio app-server using the existing desktop profile. */
export class ZCodeAppServerAdapter implements HarnessAdapter {
  readonly id = 'zcode' as const;

  private readonly entry?: string;
  private readonly bindings: ModelBinding[];
  private readonly timeoutMs: number;
  private readonly probeDataDir: string;
  private readonly runProbeCommand: (args: string[]) => Promise<ProbeCommandResult>;
  private readonly launchPeer: (options: ZCodeAppServerPeerOptions) => Promise<ZCodeProtocolPeer>;
  private readonly active = new Map<string, AbortController>();

  constructor(config: ZCodeAppServerAdapterConfig = {}) {
    this.entry = config.zcodeEntry ?? process.env.ZERO_ZCODE_ENTRY;
    this.bindings = config.bindings ?? [];
    this.timeoutMs = config.timeoutMs ?? 30 * 60_000;
    this.probeDataDir = resolve(config.probeDataDir ?? defaultProbeDataDir());
    this.runProbeCommand = config.runProbeCommand ?? (args => this.defaultProbeCommand(args));
    this.launchPeer = config.launchPeer ?? (options => ZCodeAppServerPeer.launch(options));
  }

  async probe(): Promise<HarnessCapabilities> {
    const result = await this.probeCli();
    const bindings = result.available
      ? this.bindings.filter(isExistingDesktopBinding).filter(binding => isBindingEvidenceValid(binding) && binding.verifiedCliVersion === result.version)
      : [];
    return {
      harness: this.id,
      ...(result.version ? { version: result.version } : {}),
      models: [...new Set(bindings.map(binding => binding.model.id))],
      reasoningEfforts: [...new Set(bindings.flatMap(binding => binding.reasoningEfforts ?? []))],
      roles: ['implement', 'revise'],
      available: result.available,
      probeEvidence: {
        versionAndHelp: result.available ? 'passed' : 'failed',
        authentication: 'not_checked',
        modelSmokeTest: 'not_checked',
        configuredBindings: bindings.length ? 'declared_verified' : 'none',
      },
      ...(!result.available ? { unavailableReason: result.reason ?? 'ZCode version/help probe failed' } : {}),
    };
  }

  /**
   * Checks the existing-desktop app-server lifecycle without sending model
   * input. The only returned values are fixed stage categories and a count.
   */
  async diagnoseExistingDesktop(cwd: string): Promise<ZCodeDesktopDiagnostic> {
    const result: ZCodeDesktopDiagnostic = {
      version: 'unavailable',
      childSpawn: 'not_run',
      sessionCreate: 'not_run',
      failureStage: 'not_checked',
      preferenceAckFailure: 'not_checked',
      preferenceAckRpcFailure: 'not_checked',
      preferenceAckTransportFailure: 'not_checked',
      modelRegistry: 'not_checked',
      modelCount: null,
    };
    const probe = await this.probeCli();
    if (probe.version) result.version = 'reported';
    if (!probe.available) return result;
    result.failureStage = 'none';
    result.preferenceAckFailure = 'none';
    result.preferenceAckRpcFailure = 'not_applicable';
    result.preferenceAckTransportFailure = 'not_applicable';

    let peer: ZCodeProtocolPeer;
    try {
      peer = await this.launchPeer({
        entry: this.entry!, taskWorktree: cwd, profileMode: 'existing-desktop',
        onDiagnostic: event => applyFailureStage(result, event),
      });
      result.childSpawn = 'started';
    } catch {
      result.childSpawn = 'failed';
      if (result.failureStage === 'none') result.failureStage = 'launch';
      return result;
    }

    try {
      const created = await peer.request('session/create', {
        workspace: {
          workspacePath: cwd,
          workspaceIdentity: cwd,
          workspaceKey: safeWorkspaceKey('zcode-diagnostic'),
        },
        persistence: 'deferred',
      });
      const createdRecord = isRecord(created) ? created : undefined;
      const createdSession = createdRecord && isRecord(createdRecord.session) ? createdRecord.session : undefined;
      if (!createdSession || typeof createdSession.sessionId !== 'string' || !validIdentity(createdSession.sessionId)) {
        result.sessionCreate = 'failed';
        result.failureStage = 'response_shape';
        result.modelRegistry = 'unavailable';
        return result;
      }
      result.sessionCreate = 'acknowledged';
      const settings = createdRecord && isRecord(createdRecord.settings) ? createdRecord.settings : undefined;
      const modelSettings = settings && isRecord(settings.model) ? settings.model : undefined;
      const available = modelSettings?.available;
      if (!Array.isArray(available)) {
        result.failureStage = 'model_registry';
        result.modelRegistry = 'unavailable';
        return result;
      }
      result.modelCount = available.length;
      result.modelRegistry = available.length ? 'populated' : 'empty';
      return result;
    } catch {
      result.sessionCreate = 'failed';
      result.modelRegistry = 'unavailable';
      if (result.failureStage === 'none') result.failureStage = 'session_create';
      return result;
    } finally {
      await peer.close().catch(() => undefined);
    }
  }

  async run(request: RunRequest): Promise<RunResult> {
    const started = Date.now();
    if (request.harness !== this.id) return result('failed', 'Request harness does not match ZCode', started);
    if (!SUPPORTED_ROLES.has(request.role)) return result('failed', 'ZCode app-server supports implementation and revision runs only', started);
    if (!this.entry || !isJavaScriptEntry(this.entry)) return result('failed', 'ZCode app-server requires an absolute JavaScript CLI entry', started);

    const matches = this.bindings.filter(binding => isExistingDesktopBinding(binding) &&
      (binding.model.id === request.model || binding.model.modelId === request.model));
    if (matches.length !== 1) return result('failed', 'No unique existing-desktop ZCode binding matches the requested model', started, { requestedModel: request.model });
    const binding = matches[0] as ExistingDesktopBinding;
    if (!isBindingEvidenceValid(binding)) return result('failed', 'ZCode existing-desktop binding is unverified or has inconsistent selector evidence', started, { requestedModel: binding.model.modelId });
    if (request.reasoningEffort !== undefined && (!request.reasoningEffort || !binding.reasoningEfforts?.includes(request.reasoningEffort as ReasoningEffort))) {
      return result('failed', 'Requested ZCode reasoning effort is not explicitly verified for this model', started, { requestedModel: binding.model.modelId });
    }

    const probe = await this.probeCli();
    if (!probe.available) return result('failed', probe.reason ?? 'ZCode version/help probe failed', started, { requestedModel: binding.model.modelId });
    if (probe.version !== binding.verifiedCliVersion || probe.version !== binding.verificationEvidence.cliVersion) {
      return result('failed', 'Installed ZCode CLI version does not match the verified binding version', started, { requestedModel: binding.model.modelId, harnessVersion: probe.version });
    }

    const deadline = request.deadline === undefined ? undefined : Date.parse(request.deadline);
    if (deadline !== undefined && !Number.isFinite(deadline)) return result('failed', 'Run deadline is not a valid timestamp', started, { requestedModel: binding.model.modelId });
    if (deadline !== undefined && deadline <= Date.now()) return result('timed_out', 'Run deadline has already elapsed', started, { requestedModel: binding.model.modelId, harnessVersion: probe.version });
    const timeoutMs = deadline === undefined ? this.timeoutMs : Math.min(this.timeoutMs, deadline - Date.now());
    const controller = new AbortController();
    const activeKey = `${request.taskId}:${request.attemptId}`;
    if (this.active.has(activeKey)) return result('failed', 'A ZCode app-server run is already active for this task attempt', started, { requestedModel: binding.model.modelId });
    this.active.set(activeKey, controller);
    const timer = setTimeout(() => controller.abort(new Error('ZCode app-server run timed out')), timeoutMs);

    try {
      const peer = await this.launchPeer({ entry: this.entry, taskWorktree: request.cwd, profileMode: 'existing-desktop', signal: controller.signal });
      const session = await runZCodeProtocolSession(peer, {
        cwd: request.cwd,
        workspaceKey: safeWorkspaceKey(request.taskId),
        model: {
          providerId: binding.model.provider,
          modelId: binding.model.modelId,
          ...(request.reasoningEffort ? { reasoningLevel: request.reasoningEffort } : {}),
        },
        prompt: request.prompt,
        timeoutMs,
        signal: controller.signal,
      });
      return {
        status: 'completed',
        exitCode: 0,
        final: session.response,
        requestedModel: binding.model.modelId,
        harnessVersion: probe.version,
        durationMs: Date.now() - started,
        sessionId: session.sessionId,
        metadata: {
          modelVerification: 'selector_only',
          requestedProviderId: binding.model.provider,
          requestedModelId: binding.model.modelId,
          ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        },
      };
    } catch (error) {
      const cancelled = controller.signal.aborted && !isTimeoutSignal(controller.signal);
      const timedOut = isTimeoutSignal(controller.signal) || isTimeoutError(error);
      if (error instanceof ZCodeQuotaError && !cancelled && !timedOut) {
        return result('failed', 'ZCode model usage limit reached; run paused for a later retry', started, {
          requestedModel: binding.model.modelId,
          harnessVersion: probe.version,
          quota: error.quota,
        });
      }
      return result(cancelled ? 'cancelled' : timedOut ? 'timed_out' : 'failed',
        cancelled ? 'ZCode app-server run was cancelled' : timedOut ? 'ZCode app-server run timed out' : 'ZCode app-server execution failed; protocol logs were not retained',
        started,
        { requestedModel: binding.model.modelId, harnessVersion: probe.version });
    } finally {
      clearTimeout(timer);
      this.active.delete(activeKey);
    }
  }

  async cancel(taskId: string, attemptId: string): Promise<void> {
    this.active.get(`${taskId}:${attemptId}`)?.abort(new Error('ZCode app-server run cancelled'));
  }

  private async probeCli(): Promise<{ available: boolean; version?: string; reason?: string }> {
    if (!this.entry || !isJavaScriptEntry(this.entry)) return { available: false, reason: 'ZCode app-server requires an absolute JavaScript CLI entry' };
    try {
      const version = await this.runProbeCommand(['--version']);
      if (version.code !== 0) return { available: false, reason: 'ZCode version probe failed' };
      const versionText = boundedText(version.stdout).trim();
      if (!versionText || versionText.length > 128 || /[\r\n]/.test(versionText)) return { available: false, reason: 'ZCode version probe returned an invalid version' };
      const help = await this.runProbeCommand(['--help']);
      if (help.code !== 0) return { available: false, version: versionText, reason: 'ZCode help probe failed' };
      if (!/\bapp-server\b/i.test(boundedText(`${help.stdout}\n${help.stderr}`))) {
        return { available: false, version: versionText, reason: 'ZCode help does not advertise app-server' };
      }
      return { available: true, version: versionText };
    } catch {
      return { available: false, reason: 'ZCode version/help probe could not be completed' };
    }
  }

  private async defaultProbeCommand(args: string[]): Promise<ProbeCommandResult> {
    // The probe always points ZCode at a Zero-owned empty root. It never inspects
    // the user's desktop profile or sends a model request.
    const result = await runProcess({
      executable: process.execPath,
      args: [this.entry!, ...args],
      cwd: process.cwd(),
      env: probeEnvironment(this.probeDataDir),
      timeoutMs: 8_000,
      maxLogBytes: MAX_PROBE_OUTPUT,
    });
    return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr, ...(result.error ? { error: result.error } : {}) };
  }
}

function isExistingDesktopBinding(binding: ModelBinding): binding is ExistingDesktopBinding {
  return binding.harness === 'zcode' && binding.selector === 'app_server_existing_desktop';
}

function isBindingEvidenceValid(binding: ExistingDesktopBinding): boolean {
  const evidence = binding.verificationEvidence;
  return binding.verified === true &&
    binding.verificationSource === 'smoke_test' &&
    validIdentity(binding.model.provider) && validIdentity(binding.model.modelId) &&
    validIdentity(binding.model.id) &&
    typeof binding.verifiedCliVersion === 'string' && binding.verifiedCliVersion.trim().length > 0 &&
    evidence?.kind === 'selector_only' &&
    Number.isFinite(Date.parse(evidence.verifiedAt)) &&
    evidence.providerId === binding.model.provider && evidence.modelId === binding.model.modelId &&
    evidence.cliVersion === binding.verifiedCliVersion &&
    (binding.reasoningEfforts ?? []).every(value => ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(value));
}

function validIdentity(value: string): boolean {
  return typeof value === 'string' && value === value.trim() && SAFE_MODEL_ID.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function applyFailureStage(result: ZCodeDesktopDiagnostic, event: ZCodeAppServerDiagnosticEvent): void {
  if (!['failed', 'timeout', 'exited'].includes(event.outcome)) return;
  if (event.stage === 'launch') result.failureStage = 'launch';
  else if (event.stage === 'preference_ack') {
    result.failureStage = 'preference_ack';
    result.preferenceAckFailure = event.code === 'rpc_failed' || event.code === 'ack_invalid'
      ? event.code
      : 'other';
    if (event.code === 'rpc_failed') {
      result.preferenceAckRpcFailure = event.rpcErrorCategory ?? 'no_code';
      result.preferenceAckTransportFailure = event.transportFailureCategory ?? 'other';
    }
  }
  else if (event.stage === 'session_create_rpc') {
    result.failureStage = event.code === 'response_invalid' ? 'response_shape' : 'session_create';
  } else if (event.stage === 'subscribe_ack' || event.stage === 'initial_frame_timeout') {
    result.failureStage = 'model_registry';
  }
}

function isJavaScriptEntry(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/.test(value) && /\.(?:js|mjs|cjs)$/i.test(value);
}

function safeWorkspaceKey(taskId: string): string {
  const value = taskId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100);
  return value && value !== '.' && value !== '..' ? value : 'zcode-task';
}

function boundedText(value: string): string { return value.slice(0, MAX_PROBE_OUTPUT); }

function result(status: RunResult['status'], error: string, started: number, extra: Partial<RunResult> = {}): RunResult {
  return { status, exitCode: null, durationMs: Date.now() - started, error, ...extra };
}

function isTimeoutSignal(signal: AbortSignal): boolean {
  return signal.reason instanceof Error && signal.reason.message === 'ZCode app-server run timed out';
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timed out/i.test(error.message);
}

function defaultProbeDataDir(): string {
  const root = process.env.ZERO_DATA_DIR || (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Zero')
    : join(homedir(), '.local', 'share', 'zero'));
  return join(root, 'zcode-app-server-probe');
}

function probeEnvironment(dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ZCODE_DATA_BASE_DIR: dataDir };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

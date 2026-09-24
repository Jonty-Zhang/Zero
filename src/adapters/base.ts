import type { HarnessAdapter as DomainAdapter, HarnessCapabilities, RunRequest, RunResult } from '../domain/types.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildChildEnv, runProcess } from './process-runner.js';
import type { AdapterRunResult, HarnessId, Invocation, ModelBinding, ParsedOutput, ReasoningEffort, RunContext } from './types.js';
import { classifyQuota } from '../core/quota.js';

export interface AdapterConfig {
  executable?: string;
  bindings?: ModelBinding[];
  envAllowlist?: string[];
  secretRefs?: Record<string, string>;
  resolveSecret?: (ref: string) => string | undefined;
  timeoutMs?: number;
  maxLogBytes?: number;
}

const DEFAULT_ENV_ALLOWLIST = [
  'PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'USERPROFILE', 'HOME', 'XDG_CONFIG_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
];

export abstract class BaseHarnessAdapter implements DomainAdapter {
  abstract readonly id: HarnessId;
  protected readonly bindings: ModelBinding[];
  private readonly active = new Map<string, AbortController>();
  protected readonly config: AdapterConfig;

  constructor(config: AdapterConfig = {}) {
    this.config = config;
    this.bindings = config.bindings ?? [];
  }

  protected get executable(): string { return this.config.executable ?? this.id; }

  abstract probe(): Promise<HarnessCapabilities>;
  abstract prepare(context: RunContext, binding: ModelBinding): Promise<Invocation>;
  protected abstract parseOutput(stdout: string, stderr: string): ParsedOutput;

  async run(request: RunRequest): Promise<RunResult> {
    if (request.harness !== this.id) return this.domainResult('failed', null, 0, { error: `Request harness ${request.harness} does not match adapter ${this.id}` });
    const binding = this.findBinding(request.model);
    if (!binding) return this.domainResult('failed', null, 0, { requestedModel: request.model, error: `No verified ${this.id} binding is configured for model ${request.model}` });
    if (binding.harness !== this.id || !binding.verified) return this.domainResult('failed', null, 0, { requestedModel: request.model, error: 'Model binding is not verified for this harness' });
    const liveProbe = await this.probe();
    if (!liveProbe.available || !liveProbe.models.includes(binding.model.id)) {
      return this.domainResult('failed', null, 0, { requestedModel: binding.model.modelId, error: liveProbe.unavailableReason ?? `Model binding ${binding.model.id} is not verified for the installed ${this.id} CLI version` });
    }

    const deadline = request.deadline ? Date.parse(request.deadline) : undefined;
    if (deadline !== undefined && !Number.isFinite(deadline)) return this.domainResult('failed', null, 0, { requestedModel: binding.model.modelId, error: 'Run deadline is not a valid timestamp' });
    if (deadline !== undefined && deadline <= Date.now()) return this.domainResult('timed_out', null, 0, { requestedModel: binding.model.modelId, error: 'Run deadline has already elapsed' });
    const timeoutMs = deadline !== undefined ? Math.max(1, deadline - Date.now()) : this.config.timeoutMs ?? 30 * 60_000;
    let reasoningEffort: ReasoningEffort | undefined;
    try { reasoningEffort = this.normalizeEffort(request.reasoningEffort); }
    catch (error) { return this.domainResult('failed', null, 0, { requestedModel: binding.model.modelId, error: error instanceof Error ? error.message : String(error) }); }
    const ctx: RunContext = {
      taskId: request.taskId,
      attemptId: request.attemptId,
      role: request.role === 'route' ? 'allocate' : request.role,
      cwd: request.cwd,
      prompt: request.prompt,
      timeoutMs,
      artifactDir: request.artifactDir,
      outputSchemaPath: request.outputSchemaPath,
      reasoningEffort,
      envAllowlist: this.config.envAllowlist ?? DEFAULT_ENV_ALLOWLIST,
      secretRefs: this.config.secretRefs,
      resolveSecret: this.config.resolveSecret,
    };
    try {
      const invocation = await this.prepare(ctx, binding);
      const startedAt = new Date().toISOString();
      const started = Date.now();
      const child = buildChildEnv(ctx.envAllowlist, ctx.secretRefs, ctx.resolveSecret, invocation.env);
      const controller = new AbortController();
      const activeKey = `${request.taskId}:${request.attemptId}`;
      this.active.set(activeKey, controller);
      let outcome;
      try {
        outcome = await runProcess({
          executable: invocation.executable,
          args: invocation.args,
          stdin: invocation.stdin,
          cwd: invocation.cwd,
          env: child.env,
          timeoutMs,
          maxLogBytes: this.config.maxLogBytes,
          secrets: child.secrets,
          signal: controller.signal,
        });
      } finally { this.active.delete(activeKey); }
      const parsed = invocation.parseOutput(outcome.stdout, outcome.stderr);
      const modelMismatch = Boolean(parsed.actualModel && parsed.actualModel !== binding.model.modelId);
      const status = modelMismatch ? 'failed' : outcome.status === 'completed' && outcome.exitCode !== 0 ? 'failed' : outcome.status;
      const runError = modelMismatch
        ? `Harness reported model ${parsed.actualModel}, expected ${binding.model.modelId}`
        : outcome.error;
      const artifactPaths = request.artifactDir
        ? await this.persistArtifacts(request.artifactDir, request.taskId, request.attemptId, outcome.stdout, outcome.stderr, parsed)
        : {};
      const result: AdapterRunResult = {
        harness: this.id,
        status,
        exitCode: outcome.exitCode,
        requestedModel: binding.model.modelId,
        actualModel: parsed.actualModel,
        reasoningEffort: invocation.reasoningEffort,
        startedAt,
        durationMs: Date.now() - started,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        events: parsed.events,
        finalText: parsed.finalText,
        sessionId: parsed.sessionId,
        error: runError,
      };
      const quota = outcome.status === 'failed' && outcome.exitCode !== 0
        ? classifyQuota(`${outcome.stdout}\n${outcome.stderr}\n${parsed.events.map(event => event.message ?? '').join('\n')}`)
        : undefined;
      return {
        status: result.status,
        exitCode: result.exitCode,
        final: result.finalText,
        requestedModel: result.requestedModel,
        actualModel: result.actualModel,
        ...artifactPaths,
        durationMs: result.durationMs,
        sessionId: result.sessionId,
        error: result.error,
        metadata: {
          harness: result.harness,
          reasoningEffort: result.reasoningEffort,
          startedAt: result.startedAt,
          eventCount: result.events.length,
          modelVerification: result.actualModel ? 'event_confirmed' : 'selector_only',
        },
        ...(quota ? { quota } : {}),
      };
    } catch (error) {
      return this.domainResult('failed', null, 0, {
        requestedModel: binding.model.modelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async cancel(taskId: string, attemptId: string): Promise<void> {
    this.active.get(`${taskId}:${attemptId}`)?.abort();
  }

  private async persistArtifacts(artifactDir: string, taskId: string, attemptId: string, stdout: string, stderr: string, parsed: ParsedOutput): Promise<Pick<RunResult, 'stdoutPath' | 'stderrPath' | 'eventsPath'>> {
    await mkdir(artifactDir, { recursive: true });
    const prefix = `${safeName(taskId)}-${safeName(attemptId)}`;
    const stdoutPath = join(artifactDir, `${prefix}.stdout.log`);
    const stderrPath = join(artifactDir, `${prefix}.stderr.log`);
    const eventsPath = join(artifactDir, `${prefix}.events.jsonl`);
    const events = parsed.events.map((event) => JSON.stringify(event)).join('\n');
    await Promise.all([
      writeFile(stdoutPath, stdout, { encoding: 'utf8', flag: 'wx' }),
      writeFile(stderrPath, stderr, { encoding: 'utf8', flag: 'wx' }),
      writeFile(eventsPath, events ? `${events}\n` : '', { encoding: 'utf8', flag: 'wx' }),
    ]);
    return { stdoutPath, stderrPath, eventsPath };
  }

  protected findBinding(model: string): ModelBinding | undefined {
    return this.bindings.find((binding) => binding.model.id === model || binding.model.modelId === model);
  }

  protected supportedBindings(): string[] {
    return [...new Set(this.bindings.filter((binding) => binding.harness === this.id && binding.verified).map((binding) => binding.model.id))];
  }

  protected bindingsForVersion<T extends ModelBinding>(bindings: T[], version?: string): T[] {
    return bindings.filter((binding) => binding.verified && (!binding.verifiedCliVersion || binding.verifiedCliVersion === version));
  }

  protected bindingVerification(models: string[]): Record<string, 'smoke_test' | 'manual_config'> {
    const result: Record<string, 'smoke_test' | 'manual_config'> = {};
    for (const binding of this.bindings) {
      if (binding.harness !== this.id || !binding.verified || !models.includes(binding.model.id)) continue;
      result[binding.model.id] = binding.verificationSource ?? 'manual_config';
    }
    return result;
  }

  protected normalizeEffort(value?: string): ReasoningEffort | undefined {
    if (!value) return undefined;
    const valid: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
    if (!valid.includes(value as ReasoningEffort)) throw new Error(`Unsupported reasoning effort: ${value}`);
    return value as ReasoningEffort;
  }

  protected get probeEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of this.config.envAllowlist ?? DEFAULT_ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
    return env;
  }

  async command(args: string[], cwd = process.cwd()): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
    const result = await runProcess({ executable: this.executable, args, cwd, env: this.probeEnv, timeoutMs: 8_000, maxLogBytes: 64 * 1024 });
    return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr, ...(result.error ? { error: result.error } : {}) };
  }

  protected parsePlainText(stdout: string): ParsedOutput {
    const text = stdout.trim();
    return { events: text ? [{ type: 'output', message: text }] : [], finalText: text || undefined };
  }

  protected domainResult(status: RunResult['status'], exitCode: number | null, durationMs: number, extra: Partial<RunResult> = {}): RunResult {
    return { status, exitCode, durationMs, ...extra };
  }
}

function safeName(value: string): string {
  const result = value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100);
  if (!result || result === '.' || result === '..') throw new Error('Task and attempt IDs must be safe path components');
  return result;
}

export function parseJsonLines(stdout: string, stderr = ''): ParsedOutput {
  const events: ParsedOutput['events'] = [];
  let finalText: string | undefined;
  let actualModel: string | undefined;
  let sessionId: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch {
      events.push({ type: 'unparsed', message: line });
      continue;
    }
    if (!value || typeof value !== 'object') {
      events.push({ type: 'unparsed', data: value });
      continue;
    }
    const item = value as Record<string, unknown>;
    const type = typeof item.type === 'string' ? item.type : typeof item.event === 'string' ? item.event : 'message';
    if (typeof item.session_id === 'string') sessionId = item.session_id;
    if (typeof item.model === 'string') actualModel = item.model;
    if (type === 'thread.started' && typeof item.thread_id === 'string') sessionId = item.thread_id;
    if (type === 'turn.completed' && typeof item.model === 'string') actualModel = item.model;
    const text = extractText(item);
    if (text && /completed|final|result|assistant_message/i.test(type)) finalText = text;
    events.push({ type, ...(text ? { message: text } : {}), data: item });
  }
  if (stderr.trim()) events.push({ type: 'stderr', message: stderr.trim() });
  return { events, finalText, actualModel, sessionId };
}

function extractText(item: Record<string, unknown>): string | undefined {
  for (const key of ['text', 'message', 'content', 'final']) {
    const value = item[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const text = value.map((part) => typeof part === 'string' ? part : part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string' ? (part as Record<string, unknown>).text : '').filter(Boolean).join('');
      if (text) return text;
    }
  }
  if (item.item && typeof item.item === 'object') return extractText(item.item as Record<string, unknown>);
  return undefined;
}

export async function probeExecutable(adapter: BaseHarnessAdapter, helpArgs: string[], requiredFlags: string[]): Promise<{ version?: string; help: string; reason?: string }> {
  const version = await adapter.command(['--version']);
  if (version.code !== 0) return { reason: version.error ?? `Version probe exited ${String(version.code)}`, help: '' };
  const help = await adapter.command(helpArgs);
  if (help.code !== 0) return { version: version.stdout.trim(), help: '', reason: help.error ?? `Help probe exited ${String(help.code)}` };
  const text = `${help.stdout}\n${help.stderr}`;
  const missing = requiredFlags.filter((flag) => !text.includes(flag));
  return { version: version.stdout.trim(), help: text, ...(missing.length ? { reason: `CLI help did not advertise required options: ${missing.join(', ')}` } : {}) };
}

/** Keep prompt-in-argv adapters below Windows CreateProcess's 32,767 UTF-16 code-unit cap with room for quoting. */
export function assertPromptFitsArgv(args: string[]): void {
  const estimatedLength = args.reduce((sum, arg) => sum + arg.length + 3, 0);
  if (estimatedLength > 16_000) {
    throw new Error('Prompt exceeds this Harness safe command-line budget; it cannot receive this prompt through stdin.');
  }
}

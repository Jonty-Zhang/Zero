import type { HarnessAdapter, HarnessCapabilities, RunRequest, RunResult } from '../domain/types.js';
import { readFile } from 'node:fs/promises';

export interface OpenAICompatibleCoordinatorConfig {
  baseUrl: string;
  model: string;
  keyEnv: string;
  timeoutMs?: number;
  maxPromptChars?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
}

/** Routing-only adapter for OpenAI-compatible chat completions APIs. It is never registered as a worker harness. */
export class OpenAICompatibleCoordinator implements HarnessAdapter {
  readonly id = 'api-coordinator';
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxPromptChars: number;
  private readonly maxResponseBytes: number;
  private readonly requestFetch: typeof fetch;
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly config: OpenAICompatibleCoordinatorConfig) {
    const base = new URL(config.baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
      throw new Error('API coordinator baseUrl must be an HTTPS URL without credentials, query, or fragment');
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.keyEnv)) throw new Error('API coordinator keyEnv must be an environment variable name');
    if (!config.model.trim() || config.model.length > 200) throw new Error('API coordinator model must be a non-empty string of at most 200 characters');
    this.endpoint = new URL('chat/completions', base.href.endsWith('/') ? base : new URL(`${base.href}/`)).href;
    this.timeoutMs = config.timeoutMs ?? 45_000;
    this.maxPromptChars = config.maxPromptChars ?? 32_000;
    this.maxResponseBytes = config.maxResponseBytes ?? 128 * 1024;
    this.requestFetch = config.fetch ?? fetch;
  }

  async probe(): Promise<HarnessCapabilities> {
    const available = typeof process.env[this.config.keyEnv] === 'string' && process.env[this.config.keyEnv]!.length > 0;
    return { harness: this.id, available, models: available ? [this.config.model] : [], reasoningEfforts: [], roles: ['route'],
      ...(available ? {} : { unavailableReason: `API key environment variable ${this.config.keyEnv} is not set` }) };
  }

  async run(request: RunRequest): Promise<RunResult> {
    const id = JSON.stringify([request.taskId, request.attemptId]);
    if (this.active.has(id)) return { status: 'failed', exitCode: 1, durationMs: 0, error: 'API coordinator attempt is already running' };
    const controller = new AbortController();
    this.active.set(id, controller);
    try { return await this.runRequest(request, controller.signal); }
    finally { if (this.active.get(id) === controller) this.active.delete(id); }
  }

  async cancel(taskId: string, attemptId: string): Promise<void> {
    this.active.get(JSON.stringify([taskId, attemptId]))?.abort(new Error('API coordinator request cancelled'));
  }

  private async runRequest(request: RunRequest, cancellation: AbortSignal): Promise<RunResult> {
    const started = Date.now();
    if (request.role !== 'route' || request.harness !== this.id || request.model !== this.config.model) {
      return { status: 'failed', exitCode: 1, durationMs: Date.now() - started, error: 'API coordinator only accepts routing requests for its configured model' };
    }
    let prompt = request.prompt;
    if (request.outputSchemaPath) {
      try {
        const schema = JSON.parse(await readFile(request.outputSchemaPath, 'utf8')) as unknown;
        prompt = `${prompt}\n\nRequired JSON schema:\n${JSON.stringify(schema)}`;
      } catch { return { status: 'failed', exitCode: 1, requestedModel: this.config.model, durationMs: Date.now() - started, error: 'API coordinator could not read the local routing schema' }; }
    }
    if (prompt.length > this.maxPromptChars) {
      return { status: 'failed', exitCode: 1, requestedModel: this.config.model, durationMs: Date.now() - started, error: `API coordinator prompt exceeds ${this.maxPromptChars} characters` };
    }
    const key = process.env[this.config.keyEnv];
    if (!key) return { status: 'failed', exitCode: 1, requestedModel: this.config.model, durationMs: Date.now() - started, error: `API key environment variable ${this.config.keyEnv} is not set` };

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([cancellation, timeout]);
    const stopped = (): RunResult => ({ status: cancellation.aborted ? 'cancelled' : 'timed_out', exitCode: null,
      requestedModel: this.config.model, durationMs: Date.now() - started,
      error: cancellation.aborted ? 'API coordinator request cancelled' : 'API coordinator request timed out' });
    if (signal.aborted) return stopped();

    let response: Response;
    try {
      response = await this.requestFetch(this.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.config.model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, max_tokens: 1200 }),
      });
    } catch (error) {
      if (signal.aborted) return stopped();
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return { status: timedOut ? 'timed_out' : 'failed', exitCode: null, requestedModel: this.config.model,
        durationMs: Date.now() - started, error: timedOut ? 'API coordinator request timed out' : 'API coordinator request failed' };
    }

    if (signal.aborted) { await response.body?.cancel().catch(() => undefined); return stopped(); }
    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      const retryAt = retryAtFromHeader(response.headers.get('retry-after'));
      return { status: 'failed', exitCode: 429, requestedModel: this.config.model, durationMs: Date.now() - started,
        error: 'API coordinator was rate limited', quota: { source: response.headers.has('retry-after') ? 'retry_after' : 'fallback', ...(retryAt ? { retryAt } : {}) } };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { status: 'failed', exitCode: response.status, requestedModel: this.config.model, durationMs: Date.now() - started,
        error: `API coordinator returned HTTP ${response.status}` };
    }

    let bodyText: string;
    try { bodyText = await readBounded(response, this.maxResponseBytes); }
    catch {
      if (signal.aborted) return stopped();
      return { status: 'failed', exitCode: 1, requestedModel: this.config.model, durationMs: Date.now() - started, error: 'API coordinator response exceeded the size limit or was unreadable' };
    }
    if (signal.aborted) return stopped();
    try {
      const body: unknown = JSON.parse(bodyText);
      const content = isRecord(body) && Array.isArray(body.choices) && isRecord(body.choices[0]) &&
        isRecord(body.choices[0].message) && typeof body.choices[0].message.content === 'string'
        ? body.choices[0].message.content : undefined;
      if (!content?.trim()) return { status: 'failed', exitCode: 1, requestedModel: this.config.model, durationMs: Date.now() - started, error: 'API coordinator response contained no message content' };
      return { status: 'completed', exitCode: 0, final: content, requestedModel: this.config.model, durationMs: Date.now() - started };
    } catch {
      return { status: 'failed', exitCode: 1, requestedModel: this.config.model, durationMs: Date.now() - started, error: 'API coordinator returned invalid JSON' };
    }
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new Error('No response body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('Response too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))));
}

function retryAtFromHeader(value: string | null): string | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const timestamp = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000 : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function isRecord(value: unknown): value is Record<string, any> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

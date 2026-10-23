import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RunRequest, HarnessAdapter } from '../../domain/types.js';
import { OpenAICompatibleCoordinator } from '../openai-compatible-coordinator.js';
import { TaskRouter } from '../router.js';
import { QuotaLimitError } from '../../core/quota.js';

const keyEnv = 'ZERO_API_ERROR_FIXTURE_KEY';
const request: RunRequest = { taskId: 'error-task', attemptId: 'attempt', role: 'route',
  cwd: '.', prompt: 'local fixture', harness: 'api-coordinator', model: 'router' };

async function withKey(run: () => Promise<void>) {
  const previous = process.env[keyEnv];
  process.env[keyEnv] = 'fixture-secret-never-return';
  try { await run(); }
  finally {
    if (previous === undefined) delete process.env[keyEnv];
    else process.env[keyEnv] = previous;
  }
}
function adapter(response: () => Response, options: { maxResponseBytes?: number } = {}) {
  return new OpenAICompatibleCoordinator({ baseUrl: 'https://fixture.invalid', model: 'router',
    keyEnv, fetch: async () => response(), ...options });
}

test('permanent account evidence in a 429 is an ordinary failure without leaking provider details', () => withKey(async () => {
  const codes = ['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'billing_hard_limit_reached'];
  const errors: Array<{ code?: string; type?: string; message?: string }> = codes.flatMap(code => [{ code }, { type: code }]);
  errors.push({ message: 'Payment required: fixture-secret-never-return' });
  for (const error of errors) {
    const api = adapter(() => Response.json({ error }, { status: 429, headers: { 'Retry-After': '60' } }));
    const result = await api.run(request);
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 429);
    assert.equal(result.requestedModel, 'router');
    assert.equal(result.quota, undefined, JSON.stringify(error));
    assert.equal(result.error, 'API coordinator account requires attention');
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  }
}));

test('temporary, empty, malformed and unrelated 429 bodies retain resumable quota recovery', () => withKey(async () => {
  for (const body of ['', 'not JSON', JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Too many requests' } }),
    JSON.stringify({ metadata: { code: 'insufficient_quota' }, error: { code: 'rate_limit_exceeded', detail: 'insufficient_quota' } })]) {
    const result = await adapter(() => new Response(body, { status: 429 })).run(request);
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.quota, { source: 'fallback' });
    assert.equal(result.error, 'API coordinator was rate limited');
  }
  const auth = await adapter(() => Response.json({ error: { code: 'invalid_api_key' } }, { status: 401 })).run(request);
  assert.equal(auth.quota, undefined);
  assert.equal(auth.exitCode, 401);
}));

test('unusable Retry-After values never throw or claim a valid retry hint', () => withKey(async () => {
  for (const header of ['1000000000000000000000000000000000000000', '1e999', 'not-a-date']) {
    const result = await adapter(() => new Response('', { status: 429, headers: { 'Retry-After': header } })).run(request);
    assert.deepEqual(result.quota, { source: 'fallback' }, header);
  }
  for (const header of ['60', new Date(Date.now() + 120_000).toUTCString()]) {
    const result = await adapter(() => new Response('', { status: 429, headers: { 'Retry-After': header } })).run(request);
    assert.equal(result.quota?.source, 'retry_after');
    assert.ok(Date.parse(result.quota!.retryAt!) > Date.now());
  }
}));

test('429 error inspection is bounded and cancels an oversized stream', () => withKey(async () => {
  let cancelled = false;
  const result = await adapter(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('fixture-secret-never-return'.repeat(100))); },
    cancel() { cancelled = true; },
  }), { status: 429 }), { maxResponseBytes: 64 }).run(request);
  assert.equal(cancelled, true);
  assert.deepEqual(result.quota, { source: 'fallback' });
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
}));

for (const mode of ['cancel', 'timeout'] as const) {
  test(`${mode} during 429 body inspection retains its terminal classification`, () => withKey(async () => {
    let bodyRead!: () => void;
    const reading = new Promise<void>(resolve => { bodyRead = resolve; });
    let transportAborted = false;
    const api = new OpenAICompatibleCoordinator({ baseUrl: 'https://fixture.invalid', model: 'router', keyEnv,
      timeoutMs: mode === 'timeout' ? 30 : 5_000, fetch: async (_url, init) => {
        const signal = init!.signal!;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener('abort', () => { transportAborted = true; controller.error(signal.reason); }, { once: true });
          },
          pull() { bodyRead(); },
        }), { status: 429 });
      } });
    const running = api.run(request);
    let timer!: ReturnType<typeof setTimeout>;
    try {
      await reading;
      if (mode === 'cancel') await api.cancel(request.taskId, request.attemptId);
      const result = await Promise.race([running, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('429 read did not settle')), 1_000);
      })]);
      assert.equal(result.status, mode === 'cancel' ? 'cancelled' : 'timed_out');
      assert.equal(result.quota, undefined);
      assert.equal(transportAborted, true);
    } finally {
      clearTimeout(timer);
      await api.cancel(request.taskId, request.attemptId);
      await running;
    }
  }));
}

test('the real API router pauses only temporary 429 errors', () => withKey(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zero-api-error-route-'));
  try {
    const unused: HarnessAdapter = { id: 'codex', async probe() { throw new Error('unused'); }, async run() { throw new Error('unused'); } };
    for (const permanent of [false, true]) {
      const api = adapter(() => Response.json({ error: { code: permanent ? 'insufficient_quota' : 'rate_limit_exceeded' } }, { status: 429 }));
      const router = new TaskRouter({ api, codex: unused, coordinatorKind: 'api', coordinatorModel: 'router', cwd: dir, artifactDir: dir });
      await assert.rejects(router.decide({ taskId: request.taskId, submission: { repoPath: dir,
        baseRef: 'main', prompt: 'route fixture' },
        candidates: [{ bindingId: 'fake:writer', harness: 'fake', model: 'writer', verified: true, available: true,
          healthy: true, reasoningEfforts: [], capabilities: ['code'] }], repositorySummary: 'local fixture' }),
      error => permanent ? error instanceof Error && !(error instanceof QuotaLimitError) && /account requires attention/.test(error.message)
        : error instanceof QuotaLimitError);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}));

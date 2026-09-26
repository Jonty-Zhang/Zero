import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HarnessAdapter, HarnessCapabilities, RunRequest, RunResult, TaskRecord } from '../../domain/types.js';
import { OpenAICompatibleCoordinator } from '../openai-compatible-coordinator.js';
import { TaskRouter, type RouteCandidate } from '../router.js';
import { QuotaLimitError } from '../../core/quota.js';

const responseText = JSON.stringify({ taskType: 'implementation', complexity: 'low', bindingId: 'zcode:glm', reasoningEffort: null, reason: 'A small implementation task.' });
const candidate: RouteCandidate = { bindingId: 'zcode:glm', harness: 'zcode', model: 'glm', verified: true, available: true, healthy: true, reasoningEfforts: [], capabilities: ['code'] };
const task: TaskRecord = { id: 'api-route-test', repoPath: 'C:/repo', baseRef: 'main', prompt: 'Implement this small routing test.', status: 'running', createdAt: '', updatedAt: '', revisionCount: 0 };

test('API coordinator sends bounded JSON-mode chat completion with environment-only bearer key', async () => {
  const old = process.env.ZERO_TEST_COORDINATOR_KEY;
  process.env.ZERO_TEST_COORDINATOR_KEY = 'test-secret-value';
  const dir = await mkdtemp(join(tmpdir(), 'zero-api-request-test-'));
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  try {
    const schemaPath = join(dir, 'route.schema.json');
    await writeFile(schemaPath, JSON.stringify({ type: 'object', properties: { bindingId: { type: 'string' } } }), 'utf8');
    const adapter = new OpenAICompatibleCoordinator({ baseUrl: 'https://api.example.test/v1/', model: 'route-model', keyEnv: 'ZERO_TEST_COORDINATOR_KEY', fetch: async (input, init) => {
      seenUrl = String(input); seenInit = init;
      return Response.json({ choices: [{ message: { content: responseText } }] });
    } });
    const result = await adapter.run({ taskId: task.id, attemptId: 'attempt', role: 'route', cwd: 'C:/artifacts', prompt: 'bounded prompt', harness: adapter.id, model: 'route-model', outputSchemaPath: schemaPath });
    assert.equal(result.status, 'completed');
    assert.equal(result.final, responseText);
    assert.equal(seenUrl, 'https://api.example.test/v1/chat/completions');
    assert.equal((seenInit?.headers as Record<string, string>).Authorization, 'Bearer test-secret-value');
    assert.equal(seenInit?.redirect, 'error');
    const sent = JSON.parse(String(seenInit?.body));
    assert.equal(sent.model, 'route-model');
    assert.match(sent.messages[0].content, /Required JSON schema/);
    assert.match(sent.messages[0].content, /bindingId/);
    assert.deepEqual(sent.response_format, { type: 'json_object' });
    assert.equal(sent.max_tokens, 1200);
    assert.equal(JSON.stringify(result).includes('test-secret-value'), false);
  } finally {
    if (old === undefined) delete process.env.ZERO_TEST_COORDINATOR_KEY;
    else process.env.ZERO_TEST_COORDINATOR_KEY = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test('API coordinator pauses on 429 and refuses oversized prompt or redirected endpoint', async () => {
  const old = process.env.ZERO_TEST_COORDINATOR_KEY;
  process.env.ZERO_TEST_COORDINATOR_KEY = 'secret';
  try {
    const limited = new OpenAICompatibleCoordinator({ baseUrl: 'https://api.example.test/v1', model: 'route-model', keyEnv: 'ZERO_TEST_COORDINATOR_KEY', fetch: async () => new Response('', { status: 429, headers: { 'retry-after': '3' } }) });
    const rateLimit = await limited.run({ taskId: 't', attemptId: 'a', role: 'route', cwd: '.', prompt: 'x', harness: limited.id, model: 'route-model' });
    assert.equal(rateLimit.status, 'failed');
    assert.equal(rateLimit.quota?.source, 'retry_after');
    assert.ok(Date.parse(rateLimit.quota?.retryAt ?? '') > Date.now());
    const tooLarge = new OpenAICompatibleCoordinator({ baseUrl: 'https://api.example.test', model: 'm', keyEnv: 'ZERO_TEST_COORDINATOR_KEY', maxPromptChars: 2, fetch: async () => { throw new Error('must not fetch'); } });
    const oversized = await tooLarge.run({ taskId: 't', attemptId: 'a', role: 'route', cwd: '.', prompt: 'long', harness: tooLarge.id, model: 'm' });
    assert.match(oversized.error ?? '', /exceeds/);
    assert.throws(() => new OpenAICompatibleCoordinator({ baseUrl: 'http://api.example.test', model: 'm', keyEnv: 'ZERO_TEST_COORDINATOR_KEY' }), /HTTPS/);
  } finally {
    if (old === undefined) delete process.env.ZERO_TEST_COORDINATOR_KEY;
    else process.env.ZERO_TEST_COORDINATOR_KEY = old;
  }
});

class FakeApi implements HarnessAdapter {
  readonly id = 'api-coordinator';
  calls = 0;
  response: Partial<RunResult> = { status: 'completed', exitCode: 0, final: responseText };
  async probe(): Promise<HarnessCapabilities> { return { harness: this.id, available: true, models: ['route-model'] }; }
  async run(_request: RunRequest): Promise<RunResult> { this.calls++; return { durationMs: 1, ...this.response } as RunResult; }
}
class FakeCodex implements HarnessAdapter {
  readonly id = 'codex';
  async probe(): Promise<HarnessCapabilities> { throw new Error('Codex must not be called'); }
  async run(): Promise<RunResult> { throw new Error('Codex must not be called'); }
}

test('API coordinator routes only to eligible candidates and records api source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zero-api-coordinator-test-'));
  try {
    const api = new FakeApi();
    const router = new TaskRouter({ codex: new FakeCodex(), api, coordinatorKind: 'api', coordinatorModel: 'route-model', cwd: dir, artifactDir: join(dir, 'artifacts'), getCandidates: () => [candidate] });
    const analysis = await router.decide({ taskId: task.id, submission: task, candidates: [candidate], repositorySummary: 'repo summary' });
    assert.equal(api.calls, 1);
    assert.equal(analysis.decision.selectionSource, 'api');
    assert.deepEqual(analysis.decision.fieldSources, { harness: 'api', model: 'api', reasoningEffort: 'api' });
    assert.equal(analysis.decision.bindingId, candidate.bindingId);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('API route validates candidate JSON and translates 429 into a resumable quota pause', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zero-api-coordinator-test-'));
  try {
    const api = new FakeApi();
    const router = new TaskRouter({ codex: new FakeCodex(), api, coordinatorKind: 'api', coordinatorModel: 'route-model', cwd: dir, artifactDir: join(dir, 'artifacts') });
    const input = { taskId: task.id, submission: task, candidates: [candidate], repositorySummary: 'repo summary' };
    api.response.final = '{"bindingId":"zcode:glm"';
    await assert.rejects(router.decide(input), /API route output is not strict JSON/);
    api.response.final = JSON.stringify({ taskType: 'implementation', complexity: 'low', bindingId: 'other:model', reasoningEffort: null, reason: 'outside' });
    await assert.rejects(router.decide(input), /API selected binding outside the candidate set/);
    api.response = { status: 'failed', exitCode: 429, quota: { source: 'retry_after', retryAt: '2026-09-26T12:00:00.000Z' } };
    await assert.rejects(router.decide(input), error => error instanceof QuotaLimitError && error.retryAt === '2026-09-26T12:00:00.000Z');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

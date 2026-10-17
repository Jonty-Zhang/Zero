import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { HandoffRecord, HarnessAdapter, HarnessCapabilities, RunRequest, RunResult, TaskSubmission } from '../domain/types.js';
import type { ModelBinding } from '../adapters/types.js';
import { TaskStore } from '../core/task-store.js';
import { ConfigStore, type LocalZeroConfig } from './config-store.js';
import { createCodexAdapter, createZeroServer, type TaskStorePort } from './server.js';

const execFileAsync = promisify(execFile);

test('check commands preserve the standard end-of-options separator for npm and node', async () => {
  const f = await createFixture();
  try {
    const response = await fetch(`${f.url}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: f.repoPath, prompt: 'Run the repository checks with explicit test arguments.',
        checkCommands: ['npm test -- --runInBand', 'node --test -- tests/example.test.cjs'] }) });
    assert.equal(response.status, 201, await response.text());
    const task = f.store.list()[0]!;
    assert.deepEqual(task.checks?.map(check => check.argv), [['npm', 'test', '--', '--runInBand'], ['node', '--test', '--', 'tests/example.test.cjs']]);
  } finally { await f.close(); }
});

function getWithHost(url: string, host: string): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: { Host: host },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => resolveResponse({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
}

class ProbeOnlyAdapter implements HarnessAdapter {
  probeCalls = 0;
  constructor(readonly id: string, readonly cap: HarnessCapabilities) {}
  probe(): Promise<HarnessCapabilities> { this.probeCalls++; return Promise.resolve(this.cap); }
  async run(_request: RunRequest): Promise<RunResult> {
    throw new Error('API integration tests must not execute a Harness');
  }
}

interface Fixture {
  root: string;
  repoPath: string;
  artifactRoot: string;
  store: TaskStore;
  adapter: ProbeOnlyAdapter;
  config: ConfigStore;
  url: string;
  close(): Promise<void>;
}

const model = { id: 'glm-main', provider: 'zai', modelId: 'glm-5' };
const codexModel = { id: 'codex-main', provider: 'openai', modelId: 'gpt-6-sol' };
const binding: ModelBinding = {
  harness: 'zcode', model, selector: 'isolated_config', configDir: 'unused-in-probe-test', mode: 'yolo', verified: true,
  reasoningEfforts: ['low', 'high'], verificationSource: 'smoke_test', verifiedCliVersion: 'zcode-test-1',
};

test('Codex adapter uses ZERO_CODEX_EXE in its execution invocation', async () => {
  const previous = process.env.ZERO_CODEX_EXE;
  process.env.ZERO_CODEX_EXE = 'C:\\tools\\codex\\codex.exe';
  try {
    const adapter = createCodexAdapter([{ harness: 'codex', model, selector: 'cli_argument', verified: true }]);
    const invocation = await adapter.prepare({ taskId: 'task', attemptId: 'attempt', role: 'implement', cwd: process.cwd(), prompt: 'hello' },
      { harness: 'codex', model, selector: 'cli_argument', verified: true });
    assert.equal(invocation.executable, 'C:\\tools\\codex\\codex.exe');
  } finally {
    if (previous === undefined) delete process.env.ZERO_CODEX_EXE;
    else process.env.ZERO_CODEX_EXE = previous;
  }
});

test('Codex adapter rejects an invalid ZERO_CODEX_WINDOWS_SANDBOX before execution', () => {
  const previous = process.env.ZERO_CODEX_WINDOWS_SANDBOX;
  process.env.ZERO_CODEX_WINDOWS_SANDBOX = 'danger-full-access';
  try {
    assert.throws(() => createCodexAdapter([{ harness: 'codex', model, selector: 'cli_argument', verified: true }]),
      /ZERO_CODEX_WINDOWS_SANDBOX must be elevated or unelevated/);
  } finally {
    if (previous === undefined) delete process.env.ZERO_CODEX_WINDOWS_SANDBOX;
    else process.env.ZERO_CODEX_WINDOWS_SANDBOX = previous;
  }
});

test('Codex adapter maps ZERO_CODEX_WINDOWS_SANDBOX to a per-invocation config override', async () => {
  const previous = process.env.ZERO_CODEX_WINDOWS_SANDBOX;
  process.env.ZERO_CODEX_WINDOWS_SANDBOX = 'unelevated';
  try {
    const adapter = createCodexAdapter([{ harness: 'codex', model, selector: 'cli_argument', verified: true }]);
    const invocation = await adapter.prepare({ taskId: 'task', attemptId: 'attempt', role: 'implement', cwd: process.cwd(), prompt: 'hello' },
      { harness: 'codex', model, selector: 'cli_argument', verified: true });
    const index = invocation.args.indexOf('windows.sandbox=unelevated');
    assert.ok(index > 0);
    assert.equal(invocation.args[index - 1], '-c');
  } finally {
    if (previous === undefined) delete process.env.ZERO_CODEX_WINDOWS_SANDBOX;
    else process.env.ZERO_CODEX_WINDOWS_SANDBOX = previous;
  }
});

function testConfig(hasLiveVerification: boolean, includeCodex = false): LocalZeroConfig {
  return {
    models: [model, ...(includeCodex ? [codexModel] : [])],
    bindings: [binding, ...(includeCodex ? [{ harness: 'codex' as const, model: codexModel, selector: 'cli_argument' as const, verified: true as const, reasoningEfforts: ['high' as const] }] : [])],
    allocator: { modelId: null, reasoningEffort: null },
    reviewer: { modelId: null, reasoningEffort: null },
    verifications: hasLiveVerification ? {
      'zcode:glm-main': {
        verifiedAt: '2026-09-24T00:00:00.000Z', cliVersion: 'zcode-test-1', requestedModel: 'glm-5',
        exitCode: 0, level: 'event_confirmed', actualModel: 'glm-5', reasoningEfforts: ['low', 'high'],
      },
      ...(includeCodex ? { 'codex:codex-main': {
        verifiedAt: '2026-09-24T00:00:00.000Z', cliVersion: 'codex-test-1', requestedModel: 'gpt-6-sol',
        exitCode: 0 as const, level: 'event_confirmed' as const, actualModel: 'gpt-6-sol', reasoningEfforts: ['high' as const],
      } } : {}),
    } : {},
  };
}

async function createFixture(hasLiveVerification = true, enqueue?: (taskId: string, store: TaskStore) => void | Promise<void>, includeCodex = false,
  storePort: (store: TaskStore) => TaskStorePort = store => store): Promise<Fixture> {
  const root = await mkdtemp(join(process.cwd(), '.zero-server-test-'));
  const repoPath = join(root, 'repo');
  const artifactRoot = join(root, 'artifacts');
  await mkdir(repoPath, { recursive: true });
  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: repoPath, windowsHide: true });
  await execFileAsync('git', ['config', 'user.name', 'Zero API Test'], { cwd: repoPath, windowsHide: true });
  await execFileAsync('git', ['config', 'user.email', 'zero-api-test@example.com'], { cwd: repoPath, windowsHide: true });
  await writeFile(join(repoPath, 'README.md'), '# API test repository\n', 'utf8');
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoPath, windowsHide: true });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoPath, windowsHide: true });

  const configPath = join(root, 'config', 'zero.json');
  await mkdir(join(root, 'config'), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(testConfig(hasLiveVerification, includeCodex), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  const config = new ConfigStore(configPath);
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  const capability: HarnessCapabilities = {
    harness: 'zcode', version: 'zcode-test-1', available: true, models: ['glm-main'],
    reasoningEfforts: ['low', 'high'], roles: ['implement', 'revise'],
    probeEvidence: { versionAndHelp: 'passed', authentication: 'not_checked', modelSmokeTest: 'not_checked', configuredBindings: 'declared_verified' },
  };
  const codexCapability: HarnessCapabilities = {
    harness: 'codex', version: 'codex-test-1', available: true, models: ['codex-main'], reasoningEfforts: ['high'], roles: ['implement', 'revise'],
    probeEvidence: { versionAndHelp: 'passed', authentication: 'not_checked', modelSmokeTest: 'not_checked', configuredBindings: 'declared_verified' },
  };
  const adapters = { zcode: new ProbeOnlyAdapter('zcode', capability), ...(includeCodex ? { codex: new ProbeOnlyAdapter('codex', codexCapability) } : {}) };
  const server = createZeroServer({ store: storePort(store), config, adapters, artifactRoot, staticDir: join(root, 'web'), ...(enqueue ? { enqueue: taskId => enqueue(taskId, store) } : {}) });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolveListen(); });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    root, repoPath, artifactRoot, store, config, adapter: adapters.zcode,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

test('POST /api/tasks maps repository, checks, and manually locked route fields', async () => {
  const f = await createFixture();
  try {
    const response = await fetch(`${f.url}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: f.repoPath,
        baseRef: 'main',
        prompt: 'Implement a parser that rejects invalid UTF-8 input.',
        acceptanceCriteria: ['Invalid input returns a useful error', 'Existing valid input keeps working'],
        maxRevisions: 3,
        checkCommands: ['node --version', 'git status --short'],
        execution: { harnessId: 'zcode', modelId: 'glm-main', reasoningEffort: 'high' },
      }),
    });
    assert.equal(response.status, 201);
    const created = await response.json() as { id: string; status: string; title: string };
    assert.equal(created.status, 'pending');
    assert.match(created.id, /^[a-f0-9-]{36}$/);
    assert.match(created.title, /^Implement a parser/);

    const stored = f.store.get(created.id);
    assert.ok(stored);
    assert.equal(stored.repoPath, resolve(f.repoPath));
    assert.equal(stored.baseRef, 'main');
    assert.equal(stored.maxRevisions, 3);
    assert.deepEqual(stored.acceptanceCriteria, ['Invalid input returns a useful error', 'Existing valid input keeps working']);
    assert.deepEqual(stored.checks, [
      { id: 'check-1', argv: ['node', '--version'] },
      { id: 'check-2', argv: ['git', 'status', '--short'] },
    ]);
    assert.deepEqual(stored.selection, { harness: 'zcode', model: 'glm-main', reasoningEffort: 'high' });
  } finally { await f.close(); }
});

test('GET /api/tasks exposes recovery_required status and saved evidence', async () => {
  const f = await createFixture();
  try {
    const task = f.store.submit({ repoPath: f.repoPath, baseRef: 'main', prompt: 'Inspect this interrupted task.' }, 'api_recovery_required');
    f.store.claimNext('expired-api-worker', 1, new Date(Date.now() - 10_000));
    f.store.recoverExpired();
    const response = await fetch(`${f.url}/api/tasks`);
    assert.equal(response.status, 200);
    const tasks = await response.json() as Array<{ id: string; status: string; recoveryReason?: string; recoveryEvidence?: Record<string, unknown> }>;
    const recovered = tasks.find(item => item.id === task.id);
    assert.equal(recovered?.status, 'recovery_required');
    assert.match(recovered?.recoveryReason ?? '', /lease expired/);
    assert.equal(recovered?.recoveryEvidence?.leaseOwner, 'expired-api-worker');
  } finally { await f.close(); }
});

test('task detail exposes ordered stages, linked attempts and public handoff evidence from TaskStore', async () => {
  const f = await createFixture();
  try {
    const task = f.store.submit({
      repoPath: f.repoPath, baseRef: 'main', prompt: 'Implement and verify the parser handoff.',
      executionStages: [{ harness: 'zcode', model: 'glm-main', reasoningEffort: 'high' }, {}],
    }, 'api-stage-handoff');
    const owner = 'api-stage-worker';
    assert.equal(f.store.claimNext(owner)?.id, task.id);
    const stage = f.store.createStage(task.id, {
      role: 'implement', harness: 'zcode', harnessVersion: 'test-cli-1', model: 'glm-main', reasoningEffort: 'high',
      processStartId: 'private-process', bindingVersion: 'private-binding', configHash: 'private-config-hash',
      inputFingerprint: 'input-fingerprint',
    });
    f.store.startStage(stage.id, owner, 'private-process');
    const attempt = f.store.createAttempt(task.id, 'implement', {
      owner, stageId: stage.id, harness: 'zcode', harnessVersion: 'test-cli-1', model: 'glm-main', reasoningEffort: 'high',
      bindingVersion: 'private-binding', configHash: 'private-config-hash', metadata: { summary: 'Parser implemented', privateConfig: 'do-not-project' },
    });
    f.store.finishAttempt(attempt.id, { status: 'succeeded', exitCode: 0 }, { owner, processStartId: 'private-process' });
    const finished = f.store.finishStage(stage.id, owner, 'private-process', 'succeeded', 'output-fingerprint');
    const handoff = f.store.saveHandoff({
      schemaVersion: 1, taskId: task.id, stageId: stage.id, createdAt: '2026-10-17T00:00:00.000Z',
      source: { attemptId: attempt.id, harness: 'zcode', model: 'glm-main', harnessVersion: 'test-cli-1',
        bindingVersion: 'private-binding', configHash: 'private-config-hash', processStartId: 'private-process' },
      task: { objective: task.prompt, acceptanceCriteria: ['Reject invalid UTF-8'] },
      workspace: { baseCommit: 'base-commit', headCommit: 'head-commit', fingerprint: 'output-fingerprint', state: 'dirty', changedFiles: ['src/parser.ts'] },
      completed: ['Added parser validation'], currentState: 'Ready for independent verification',
      decisions: [{ decision: 'Reject malformed input', rationale: 'Avoid silent data loss' }],
      rejectedOptions: [{ option: 'Silently replace bytes', reason: 'Loses source data' }],
      keyFiles: [{ path: 'src/parser.ts', reason: 'UTF-8 validation' }],
      checks: [{ id: 'parser-tests', status: 'passed', evidence: 'Three focused cases passed' }],
      blockers: ['Full suite pending'], risks: ['Legacy encodings remain unsupported'], nextSteps: ['Run the full suite'],
    });
    const next = f.store.createStage(task.id, {
      role: 'implement', predecessorStageId: stage.id, harness: 'codex', model: 'codex-main',
      processStartId: 'second-private-process', inputFingerprint: 'output-fingerprint',
    });
    f.store.startStage(next.id, owner, 'second-private-process');
    const nextAttempt = f.store.createAttempt(task.id, 'implement', { owner, stageId: next.id, harness: 'codex', model: 'codex-main' });
    f.store.finishAttempt(nextAttempt.id, { status: 'failed', exitCode: 2, error: 'Verification failed' }, { owner, processStartId: 'second-private-process' });
    const failed = f.store.finishStage(next.id, owner, 'second-private-process', 'failed');
    f.store.fail(task.id, 'running', 'Verification failed', owner);

    const response = await fetch(`${f.url}/api/tasks/${task.id}`);
    assert.equal(response.status, 200);
    const detail = await response.json() as {
      status: string; executionStages: unknown[]; stages: Array<Record<string, unknown>>;
      attempts: Array<Record<string, unknown>>; handoffs: Array<Record<string, unknown>>;
    };
    assert.equal(detail.status, 'failed');
    assert.deepEqual(detail.executionStages, [{ harnessId: 'zcode', modelId: 'glm-main', reasoningEffort: 'high' }, {}]);
    assert.deepEqual(detail.stages, [{
      id: stage.id, sequence: 1, role: 'implement', status: 'succeeded', harness: 'zcode', harnessVersion: 'test-cli-1',
      model: 'glm-main', reasoningEffort: 'high', inputFingerprint: 'input-fingerprint', outputFingerprint: 'output-fingerprint',
      createdAt: stage.createdAt, startedAt: finished.startedAt, finishedAt: finished.finishedAt,
    }, {
      id: next.id, sequence: 2, role: 'implement', status: 'failed', predecessorStageId: stage.id,
      harness: 'codex', model: 'codex-main', inputFingerprint: 'output-fingerprint',
      createdAt: next.createdAt, startedAt: failed.startedAt, finishedAt: failed.finishedAt, error: 'stage completed without success',
    }]);
    assert.deepEqual(detail.attempts.map(value => ({ id: value.id, stageId: value.stageId, role: value.role, exitCode: value.exitCode })), [
      { id: attempt.id, stageId: stage.id, role: 'implement', exitCode: 0 },
      { id: nextAttempt.id, stageId: next.id, role: 'implement', exitCode: 2 },
    ]);
    assert.equal(detail.attempts[0]?.summary, 'Parser implemented');
    assert.deepEqual(detail.handoffs, [{
      id: handoff.id, stageId: stage.id, createdAt: '2026-10-17T00:00:00.000Z',
      source: { attemptId: attempt.id, harness: 'zcode', model: 'glm-main' },
      workspace: { baseCommit: 'base-commit', headCommit: 'head-commit', fingerprint: 'output-fingerprint', state: 'dirty', changedFiles: ['src/parser.ts'] },
      completed: ['Added parser validation'], currentState: 'Ready for independent verification',
      decisions: [{ decision: 'Reject malformed input', rationale: 'Avoid silent data loss' }],
      keyFiles: [{ path: 'src/parser.ts', reason: 'UTF-8 validation' }],
      checks: [{ id: 'parser-tests', status: 'passed', evidence: 'Three focused cases passed' }],
      blockers: ['Full suite pending'], risks: ['Legacy encodings remain unsupported'], nextSteps: ['Run the full suite'],
    }]);
    assert.equal(JSON.stringify(detail.stages).includes('private-'), false);
    assert.equal(JSON.stringify(detail.handoffs).includes('private-'), false);
    assert.equal(JSON.stringify(detail.attempts).includes('do-not-project'), false);
  } finally { await f.close(); }
});

test('task detail returns empty evidence for legacy tasks and stores without optional evidence reads', async () => {
  for (const legacyPort of [false, true]) {
    const f = await createFixture(true, undefined, false, store => legacyPort ? {
      submit: store.submit.bind(store), createSequence: store.createSequence.bind(store),
      getSequence: store.getSequence.bind(store), listSequences: store.listSequences.bind(store),
      get: store.get.bind(store), list: store.list.bind(store), fail: store.fail.bind(store),
      attempts: store.attempts.bind(store), getRoute: store.getRoute.bind(store),
      checks: store.checks.bind(store), reviews: store.reviews.bind(store), events: store.events.bind(store),
    } : store);
    try {
      const task = f.store.submit({ repoPath: f.repoPath, baseRef: 'main', prompt: 'Inspect a legacy task without stage records.' });
      const attempt = f.store.createAttempt(task.id, 'route', { harness: 'codex', model: 'codex-main' });
      f.store.finishAttempt(attempt.id, { status: 'failed', exitCode: 1 });
      const response = await fetch(`${f.url}/api/tasks/${task.id}`);
      assert.equal(response.status, 200);
      const detail = await response.json() as { executionStages: unknown[]; stages: unknown[]; handoffs: unknown[]; attempts: Array<Record<string, unknown>> };
      assert.deepEqual(detail.executionStages, []);
      assert.deepEqual(detail.stages, []);
      assert.deepEqual(detail.handoffs, []);
      assert.equal(detail.attempts[0]?.id, attempt.id);
      assert.equal(detail.attempts[0]?.role, 'route');
      assert.equal(Object.hasOwn(detail.attempts[0]!, 'stageId'), false);
    } finally { await f.close(); }
  }
});

test('task detail includes bounded check stdout and stderr while excluding artifacts outside its root', async () => {
  const f = await createFixture();
  try {
    const task = f.store.submit({ repoPath: f.repoPath, baseRef: 'main', prompt: 'Diagnose failing validation with archived check output.' });
    await mkdir(f.artifactRoot, { recursive: true });
    const stdoutPath = join(f.artifactRoot, 'check.stdout.log');
    const stderrPath = join(f.artifactRoot, 'check.stderr.log');
    const outsidePath = join(f.root, 'private.txt');
    const oversizedPath = join(f.artifactRoot, 'oversized.log');
    await writeFile(stdoutPath, 'Parser regression: expected rejection');
    await writeFile(stderrPath, 'AssertionError: invalid bytes accepted');
    await writeFile(outsidePath, 'outside-root-private-content');
    await writeFile(oversizedPath, 'x'.repeat(256 * 1024 + 1));
    f.store.saveCheck(task.id, { id: 'parser', argv: ['node', '--test'], status: 'failed', exitCode: 1, durationMs: 42,
      error: 'Check exited with code 1', stdoutPath, stderrPath });
    f.store.saveCheck(task.id, { id: 'outside', argv: ['node'], status: 'failed', exitCode: 1, durationMs: 1,
      stdoutPath: outsidePath, stderrPath: join(f.artifactRoot, 'missing.log') });
    f.store.saveCheck(task.id, { id: 'oversized', argv: ['node'], status: 'failed', exitCode: 1, durationMs: 1, stdoutPath: oversizedPath });
    const response = await fetch(`${f.url}/api/tasks/${task.id}`);
    assert.equal(response.status, 200);
    const detail = await response.json() as { tests: Array<Record<string, unknown>> };
    assert.deepEqual(detail.tests[0], {
      name: 'parser', command: 'node --test', status: 'failed', exitCode: 1, durationMs: 42,
      output: 'Check exited with code 1\n--- stdout ---\nParser regression: expected rejection\n--- stderr ---\nAssertionError: invalid bytes accepted',
    });
    assert.equal(Object.hasOwn(detail.tests[1]!, 'output'), false);
    assert.equal(detail.tests[2]?.output, '--- stdout ---\n[日志超过单次详情读取上限]');
    assert.equal(JSON.stringify(detail.tests).includes('outside-root-private-content'), false);
  } finally { await f.close(); }
});

test('POST /api/tasks rejects an incompatible Harness and model pair with 400', async () => {
  const f = await createFixture();
  try {
    const response = await fetch(`${f.url}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: f.repoPath, baseRef: 'main', prompt: 'This task has a sufficiently long prompt.', execution: { harnessId: 'codex', modelId: 'glm-main' } }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, /没有通过探测的可用组合/);
    assert.equal(f.store.list().length, 0);
  } finally { await f.close(); }
});

test('POST /api/tasks persists ordered partial execution stages with global defaults', async () => {
  const f = await createFixture();
  try {
    const response = await fetch(`${f.url}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: f.repoPath, baseRef: 'main', prompt: 'Run ordered execution stages with partial locks.',
        execution: { harnessId: 'zcode', reasoningEffort: 'high' },
        executionStages: [{ modelId: 'glm-main' }, { modelId: 'glm-main', reasoningEffort: 'low' }],
      }),
    });
    assert.equal(response.status, 201);
    const created = await response.json() as { id: string };
    const stored = f.store.get(created.id);
    assert.ok(stored);
    assert.deepEqual(stored.selection, { harness: 'zcode', reasoningEffort: 'high' });
    assert.deepEqual(stored.executionStages, [
      { model: 'glm-main' },
      { model: 'glm-main', reasoningEffort: 'low' },
    ]);
  } finally { await f.close(); }
});

test('stage objectives roundtrip through public POST and GET without entering selection or defaults', async () => {
  const f = await createFixture();
  try {
    const configBefore = await f.config.read();
    const response = await fetch(`${f.url}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: f.repoPath, baseRef: 'main', prompt: 'Implement and verify the parser with distinct goals.',
        execution: { harnessId: 'zcode', reasoningEffort: 'high' },
        executionStages: [{ modelId: 'glm-main', objective: '  Implement UTF-8 validation\n  ' }, { objective: 'Verify boundary cases' }, {}] }),
    });
    assert.equal(response.status, 201);
    const created = await response.json() as { id: string };
    const stored = f.store.get(created.id);
    assert.deepEqual(stored?.selection, { harness: 'zcode', reasoningEffort: 'high' });
    assert.deepEqual(stored?.executionStages, [
      { model: 'glm-main', objective: 'Implement UTF-8 validation' }, { objective: 'Verify boundary cases' }, {},
    ]);
    const detailResponse = await fetch(`${f.url}/api/tasks/${created.id}`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json() as { executionStages: unknown[] };
    assert.deepEqual(detail.executionStages, [
      { modelId: 'glm-main', objective: 'Implement UTF-8 validation' }, { objective: 'Verify boundary cases' }, {},
    ]);
    assert.deepEqual(await f.config.read(), configBefore);
  } finally { await f.close(); }
});

test('submission rejects incompatible inherited global selections for tasks, stages and sequence steps atomically', async () => {
  const f = await createFixture(true, undefined, true);
  try {
    await f.config.write({ ...await f.config.read(), executionDefaults: {
      global: { harness: 'codex', model: 'codex-main', reasoningEffort: 'high' }, projects: {},
    } });
    const base = { repoPath: f.repoPath, baseRef: 'main', prompt: 'Validate effective execution defaults before enqueueing.' };
    const invalid = { ...base, execution: { harnessId: 'zcode' } };
    for (const submission of [invalid, { ...invalid, executionStages: [{ objective: 'Implement the parser' }] }]) {
      const response = await fetch(`${f.url}/api/tasks`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submission),
      });
      assert.equal(response.status, 400, 'zcode cannot inherit the codex-only model');
      assert.match((await response.json() as { error: string }).error, /effective selection|可用 Harness 与模型组合/);
      assert.equal(f.store.list().length, 0);
    }
    const sequence = await fetch(`${f.url}/api/sequences`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: [{ ...base, execution: { harnessId: 'codex' } }, invalid] }),
    });
    assert.equal(sequence.status, 400);
    assert.equal(f.store.listSequences().length, 0);
    assert.equal(f.store.list().length, 0);

    await f.config.write({ ...await f.config.read(), executionDefaults: {
      global: { harness: 'zcode', model: 'glm-main', reasoningEffort: 'low' }, projects: {},
    } });
    const effort = await fetch(`${f.url}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, execution: { harnessId: 'codex', modelId: 'codex-main' } }),
    });
    assert.equal(effort.status, 400, 'codex-main does not support the inherited low effort');
    assert.equal(f.store.list().length, 0);
  } finally { await f.close(); }
});

test('submission uses canonical project defaults with field precedence without persisting inherited locks', async () => {
  const f = await createFixture(true, undefined, true);
  try {
    const nested = join(f.repoPath, 'src', 'nested');
    await mkdir(nested, { recursive: true });
    await f.config.write({ ...await f.config.read(), executionDefaults: {
      global: { harness: 'codex', model: 'codex-main', reasoningEffort: 'high' },
      projects: { [f.repoPath]: { harness: 'zcode', model: 'glm-main', reasoningEffort: 'low' } },
    } });
    const base = { repoPath: nested, baseRef: 'main', prompt: 'Resolve project defaults at the canonical repository root.' };
    const invalid = await fetch(`${f.url}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, execution: { harnessId: 'codex' } }),
    });
    assert.equal(invalid.status, 400, 'the project glm model must override the global codex model');
    assert.equal(f.store.list().length, 0);
    const response = await fetch(`${f.url}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, execution: { reasoningEffort: 'high' },
        executionStages: [{ objective: 'Implement parser' }, { harnessId: 'codex', modelId: 'codex-main', objective: 'Verify parser' }] }),
    });
    assert.equal(response.status, 201);
    const created = await response.json() as { id: string };
    assert.equal(f.store.get(created.id)?.repoPath, f.repoPath);
    assert.deepEqual(f.store.get(created.id)?.selection, { reasoningEffort: 'high' });
    assert.deepEqual(f.store.get(created.id)?.executionStages, [
      { objective: 'Implement parser' }, { harness: 'codex', model: 'codex-main', objective: 'Verify parser' },
    ]);
    const inherited = await fetch(`${f.url}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(base),
    });
    assert.equal(inherited.status, 201);
    const inheritedTask = await inherited.json() as { id: string };
    assert.equal(f.store.get(inheritedTask.id)?.selection, undefined);
  } finally { await f.close(); }
});

test('stage objective API validation rejects whitespace, wrong types and excessive length before task creation', async () => {
  const f = await createFixture();
  const post = (objective: unknown) => fetch(`${f.url}/api/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repoPath: f.repoPath, baseRef: 'main', prompt: 'Validate user-authored stage goals.', executionStages: [{ objective }] }),
  });
  try {
    for (const objective of ['', ' \r\n\t ', 42, null, {}, 'x'.repeat(4001)]) {
      const response = await post(objective);
      assert.equal(response.status, 400);
      assert.match((await response.json() as { error: string }).error, /objective/);
      assert.equal(f.store.list().length, 0);
    }
    const accepted = await post(`  ${'x'.repeat(4000)}  `);
    assert.equal(accepted.status, 201, 'the boundary applies to the normalized objective');
    assert.equal((f.store.list()[0]?.executionStages?.[0] as { objective?: string }).objective?.length, 4000);
    const incompatible = await fetch(`${f.url}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: f.repoPath, baseRef: 'main', prompt: 'Still validate model locks alongside stage goals.',
        executionStages: [{ objective: 'Verify parser', modelId: 'missing-model' }] }),
    });
    assert.equal(incompatible.status, 400);
    assert.match((await incompatible.json() as { error: string }).error, /没有通过验证的可用 Harness 与模型组合/);
    assert.equal(f.store.list().length, 1);
  } finally { await f.close(); }
});

test('CLI stages-file preserves stage objectives through the real submission API', async () => {
  const f = await createFixture();
  try {
    const stagesFile = join(f.root, 'stages.json');
    await writeFile(stagesFile, JSON.stringify([{ harnessId: 'zcode', modelId: 'glm-main', objective: '  Implement parser  ' }, { objective: 'Verify parser' }]));
    const result = await execFileAsync(process.execPath, [resolve('dist/cli.js'), 'submit', '--repo', f.repoPath,
      '--prompt', 'Perform the two-stage parser change.', '--stages-file', stagesFile], {
      env: { ...process.env, ZERO_URL: f.url }, windowsHide: true,
    });
    const created = JSON.parse(result.stdout) as { id: string };
    assert.deepEqual(f.store.get(created.id)?.executionStages, [
      { harness: 'zcode', model: 'glm-main', objective: 'Implement parser' }, { objective: 'Verify parser' },
    ]);
  } finally { await f.close(); }
});

test('task detail projects executor summaries as plain text and retains legacy attempt summaries', async () => {
  const executorSummary = '<script>untrusted()</script> Implemented parser; verify boundaries next.';
  const handoff: HandoffRecord & { executorSummary: string } = {
    schemaVersion: 1, id: 'summary-handoff', byteLength: 100, taskId: 'api-executor-summary', stageId: 'source-stage',
    createdAt: '2026-10-17T00:00:00.000Z', source: { attemptId: 'source-attempt', harness: 'zcode', model: 'glm-main' },
    task: { objective: 'Parser task', acceptanceCriteria: [] }, workspace: { state: 'unknown' },
    completed: [], currentState: 'Awaiting verification', decisions: [], rejectedOptions: [], keyFiles: [], checks: [], blockers: [], risks: [], nextSteps: [], executorSummary,
  };
  const f = await createFixture(true, undefined, false, store => new Proxy(store, {
    get(target, property) {
      if (property === 'handoffs') return () => [handoff];
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }));
  try {
    const task = f.store.submit({ repoPath: f.repoPath, baseRef: 'main', prompt: 'Preserve real executor context as untrusted text.' }, 'api-executor-summary');
    for (const metadata of [
      { executorSummary, summary: 'Old summary' }, { summary: 'Legacy summary' },
      { executorSummary: '', summary: 'Empty summary fallback' }, { executorSummary: 42, summary: 'Invalid type fallback' },
    ]) {
      const attempt = f.store.createAttempt(task.id, 'implement', { metadata });
      f.store.finishAttempt(attempt.id, { status: 'succeeded' });
    }
    const failed = f.store.createAttempt(task.id, 'implement', { metadata: { executorSummary: 'I completed the task.' } });
    f.store.finishAttempt(failed.id, { status: 'failed', error: 'Harness reported a different model' });
    const response = await fetch(`${f.url}/api/tasks/${task.id}`);
    assert.equal(response.status, 200);
    const detail = await response.json() as { attempts: Array<{ summary?: string; executorSummary?: string }>; handoffs: Array<{ executorSummary?: string; checks: unknown[] }> };
    assert.deepEqual(detail.attempts.map(attempt => attempt.summary), [executorSummary, 'Legacy summary', 'Empty summary fallback', 'Invalid type fallback', 'Harness reported a different model']);
    assert.equal(detail.attempts.at(-1)?.executorSummary, 'I completed the task.', 'executor claims must not overwrite the observed attempt error');
    assert.equal(detail.handoffs[0]?.executorSummary, executorSummary);
    assert.deepEqual(detail.handoffs[0]?.checks, [], 'executor prose never becomes observed checks');
  } finally { await f.close(); }
});

test('POST /api/sequences validates the full batch before atomically persisting ordered steps and metadata', async () => {
  const enqueued: Array<{ id: string; committed: boolean }> = [];
  const f = await createFixture(true, (id, store) => {
    enqueued.push({ id, committed: store.listSequences().some(sequence => sequence.steps.some(step => step.task.id === id)) });
  });
  const task = (prompt: string) => ({ repoPath: f.repoPath, baseRef: 'main', prompt });
  try {
    const rejected = await fetch(`${f.url}/api/sequences`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: [task('A valid first sequence step.'), { ...task('Invalid middle sequence step.'), execution: { harnessId: 'codex', modelId: 'glm-main' } }, task('A valid final sequence step.')] }),
    });
    assert.equal(rejected.status, 400);
    assert.equal(f.store.list().length, 0, 'invalid middle step must not leave earlier steps behind');
    assert.equal(f.store.listSequences().length, 0);
    assert.equal(f.adapter.probeCalls, 1, 'one adapter probe set is shared across validation of the batch');

    const createdResponse = await fetch(`${f.url}/api/sequences`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objective: 'Deliver the parser improvement',
        acceptanceCriteria: ['All ordered steps finish', 'Aggregate behavior is checked'],
        maxGoalRevisions: 3,
        tasks: [task('First, inspect the current parser.'), task('Then, implement UTF-8 validation.'), task('Finally, document the behavior.')],
      }),
    });
    assert.equal(createdResponse.status, 201);
    assert.equal(f.adapter.probeCalls, 2, 'the second POST adds only one more adapter probe set regardless of step count');
    const created = await createdResponse.json() as {
      id: string; status: string; objective: string; acceptanceCriteria: string[];
      maxGoalRevisions: number; goalRevisionCount: number;
      steps: Array<{ position: number; task: { id: string; status: string; title: string; repoPath: string } }>;
    };
    assert.equal(created.status, 'queued');
    assert.equal(created.objective, 'Deliver the parser improvement');
    assert.deepEqual(created.acceptanceCriteria, ['All ordered steps finish', 'Aggregate behavior is checked']);
    assert.equal(created.maxGoalRevisions, 3);
    assert.equal(created.goalRevisionCount, 0);
    assert.deepEqual(created.steps.map(step => step.position), [0, 1, 2]);
    assert.deepEqual(created.steps.map(step => step.task.title), [
      'First, inspect the current parser.', 'Then, implement UTF-8 validation.', 'Finally, document the behavior.',
    ]);
    assert.ok(created.steps.every(step => step.task.status === 'pending' && step.task.repoPath === resolve(f.repoPath)));
    assert.deepEqual(f.store.getSequence(created.id)?.steps.map(step => step.task.prompt), [
      'First, inspect the current parser.', 'Then, implement UTF-8 validation.', 'Finally, document the behavior.',
    ]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(enqueued, created.steps.map(step => ({ id: step.task.id, committed: true })));

    const detailResponse = await fetch(`${f.url}/api/sequences/${created.id}`);
    assert.equal(detailResponse.status, 200);
    assert.deepEqual(await detailResponse.json(), created);
    const listResponse = await fetch(`${f.url}/api/sequences`);
    assert.equal(listResponse.status, 200);
    const listed = await listResponse.json() as Array<{ id: string; objective: string; maxGoalRevisions: number; goalRevisionCount: number; steps: unknown[] }>;
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, created.id);
    assert.equal(listed[0]?.objective, 'Deliver the parser improvement');
    assert.equal(listed[0]?.maxGoalRevisions, 3);
    assert.equal(listed[0]?.goalRevisionCount, 0);
    assert.equal(listed[0]?.steps.length, 3);
  } finally { await f.close(); }
});

test('POST /api/sequences validates maxGoalRevisions as an integer from 0 through 5', async () => {
  const f = await createFixture();
  try {
    const task = (prompt: string) => ({ repoPath: f.repoPath, baseRef: 'main', prompt });
    for (const value of [-1, 6, 1.5, '2', null]) {
      const response = await fetch(`${f.url}/api/sequences`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxGoalRevisions: value, tasks: [task('A valid first step.'), task('A valid second step.')] }),
      });
      assert.equal(response.status, 400, `value ${String(value)} must be rejected`);
      assert.match((await response.json() as { error: string }).error, /maxGoalRevisions/);
    }
    assert.equal(f.store.listSequences().length, 0);
    assert.equal(f.store.list().length, 0);
    assert.equal(f.adapter.probeCalls, 0, 'the cap is validated before capability probes and persistence');
  } finally { await f.close(); }
});

test('POST /api/sequences rejects out-of-range size and GET returns 404 for missing ids', async () => {
  const f = await createFixture();
  try {
    const short = await fetch(`${f.url}/api/sequences`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: [{}, {}, {}].slice(0, 1) }),
    });
    assert.equal(short.status, 400);
    const tooLong = await fetch(`${f.url}/api/sequences`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: Array.from({ length: 21 }, () => ({})) }),
    });
    assert.equal(tooLong.status, 400);
    const missing = await fetch(`${f.url}/api/sequences/not-a-sequence`);
    assert.equal(missing.status, 404);
    assert.equal(f.store.list().length, 0);
  } finally { await f.close(); }
});

test('sequence GET detail and list expose the aggregate PASS result without internal review evidence', async () => {
  const f = await createFixture();
  try {
    const sequence = f.store.createSequence([
      { repoPath: f.repoPath, baseRef: 'main', prompt: 'Complete the first goal step.' },
      { repoPath: f.repoPath, baseRef: 'main', prompt: 'Complete the second goal step.' },
    ], 'api-goal-review-pass', {
      objective: 'Deliver the complete goal.',
      acceptanceCriteria: ['The combined result meets the goal.'],
    });
    const db = new DatabaseSync(join(f.root, 'tasks.sqlite'));
    try {
      for (const step of sequence.steps) db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(step.task.id);
    } finally { db.close(); }

    const startedAt = new Date('2026-09-26T00:00:00.000Z');
    const fingerprint = 'e'.repeat(64);
    const attempt = f.store.startSequenceGoalReview(sequence.id, fingerprint, 'api-goal-review-attempt', startedAt);
    const completedAt = new Date(startedAt.getTime() + 1_000);
    f.store.finishSequenceGoalReview({
      attemptId: attempt.attemptId,
      verifiedEvidenceFingerprint: fingerprint,
      now: completedAt,
      result: { verdict: 'pass', summary: 'The combined result meets the goal.', findings: [] },
    });

    const detailResponse = await fetch(`${f.url}/api/sequences/${sequence.id}`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json() as { goalReview: Record<string, unknown> };
    const expectedReview = {
      state: 'verdict',
      result: { verdict: 'pass', summary: 'The combined result meets the goal.', findings: [] },
      createdAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
    };
    assert.deepEqual(detail.goalReview, expectedReview);
    assert.equal(Object.hasOwn(detail.goalReview, 'evidenceFingerprint'), false);
    assert.equal(Object.hasOwn(detail.goalReview, 'generationId'), false);

    const listResponse = await fetch(`${f.url}/api/sequences`);
    assert.equal(listResponse.status, 200);
    const listed = await listResponse.json() as Array<{ id: string; goalReview: Record<string, unknown> }>;
    const listItem = listed.find(item => item.id === sequence.id);
    assert.ok(listItem);
    assert.deepEqual(listItem.goalReview, expectedReview);
    assert.equal(Object.hasOwn(listItem.goalReview, 'evidenceFingerprint'), false);
    assert.equal(Object.hasOwn(listItem.goalReview, 'generationId'), false);
  } finally { await f.close(); }
});

test('POST /api/tasks rejects unavailable models, efforts, invalid stage counts, and incompatible merged locks', async () => {
  const f = await createFixture();
  try {
    const base = { repoPath: f.repoPath, baseRef: 'main', prompt: 'Validate this execution stage submission.' };
    const cases: Array<{ name: string; payload: Record<string, unknown>; error: RegExp }> = [
      { name: 'unavailable model', payload: { executionStages: [{ harnessId: 'zcode', modelId: 'missing-model' }] }, error: /没有通过验证的可用 Harness 与模型组合/ },
      { name: 'unavailable effort', payload: { executionStages: [{ harnessId: 'zcode', modelId: 'glm-main', reasoningEffort: 'xhigh' }] }, error: /没有已验证的可用组合/ },
      { name: 'empty stages', payload: { executionStages: [] }, error: /1 到 16 个阶段/ },
      { name: 'too many stages', payload: { executionStages: Array.from({ length: 17 }, () => ({})) }, error: /1 到 16 个阶段/ },
      { name: 'incompatible global default and stage override', payload: { execution: { harnessId: 'zcode' }, executionStages: [{ modelId: 'missing-model' }] }, error: /没有通过验证的可用 Harness 与模型组合/ },
    ];
    for (const testCase of cases) {
      const response = await fetch(`${f.url}/api/tasks`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...base, ...testCase.payload }),
      });
      assert.equal(response.status, 400, testCase.name);
      assert.match((await response.json() as { error: string }).error, testCase.error, testCase.name);
    }
    assert.equal(f.store.list().length, 0);
  } finally { await f.close(); }
});

test('GET /api/tasks/:id/report streams the actual archived report.json', async () => {
  const f = await createFixture();
  try {
    const submission: TaskSubmission = { repoPath: f.repoPath, baseRef: 'main', prompt: 'An archived task report fixture.' };
    const task = f.store.submit(submission, 'report-task-1');
    const dir = join(f.artifactRoot, task.id);
    await mkdir(dir, { recursive: true });
    const report = { task: { id: task.id, status: 'failed' }, route: { harness: 'zcode', model: 'glm-main' }, sentinel: 'actual-archived-report', finalStatus: 'failed' };
    await writeFile(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    const response = await fetch(`${f.url}/api/tasks/${task.id}/report`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename="zero-report-task-1\.json"/);
    const downloaded = await response.json() as typeof report;
    assert.equal(downloaded.sentinel, 'actual-archived-report');
    assert.deepEqual(downloaded.route, report.route);
    assert.equal(downloaded.task.status, task.status);
    assert.equal(downloaded.finalStatus, task.status);
  } finally { await f.close(); }
});

test('mutation endpoints reject a cross-site Origin without inserting a task', async () => {
  const f = await createFixture();
  try {
    for (const origin of ['https://attacker.example', `http://${new URL(f.url).hostname}:9999`]) {
      const response = await fetch(`${f.url}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ repoPath: f.repoPath, baseRef: 'main', prompt: 'This task has a sufficiently long prompt.' }),
      });
      assert.equal(response.status, 403, `expected Origin ${origin} to be denied`);
      assert.match((await response.json() as { error: string }).error, /跨站修改请求已拒绝/);
    }
    assert.equal(f.store.list().length, 0);
  } finally { await f.close(); }
});

test('API rejects DNS-rebinding Host headers on read requests', async () => {
  const f = await createFixture();
  try {
    const response = await getWithHost(`${f.url}/api/tasks`, 'attacker.example');
    assert.equal(response.status, 403);
    assert.match(response.body, /Host 必须是 Zero loopback/);
  } finally { await f.close(); }
});

test('DNS rebinding Host headers are rejected for task-list and report reads', async () => {
  const f = await createFixture();
  try {
    const taskResponse = await getWithHost(`${f.url}/api/tasks`, 'attacker.example');
    assert.equal(taskResponse.status, 403);

    const task = f.store.submit({ repoPath: f.repoPath, baseRef: 'main', prompt: 'Prepare a report for the Host validation case.' }, 'host-report-1');
    const reportDir = join(f.artifactRoot, task.id);
    await mkdir(reportDir, { recursive: true });
    await writeFile(join(reportDir, 'report.json'), JSON.stringify({ task: { id: task.id }, reportMarker: 'host-check' }), 'utf8');
    const reportResponse = await getWithHost(`${f.url}/api/tasks/${task.id}/report`, 'attacker.example');
    assert.equal(reportResponse.status, 403);
  } finally { await f.close(); }
});

test('mutation Origin must match both loopback hostname and request port', async () => {
  const f = await createFixture();
  try {
    const serverUrl = new URL(f.url);
    const otherPort = Number(serverUrl.port) === 65535 ? 65534 : Number(serverUrl.port) + 1;
    const response = await fetch(`${f.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${otherPort}` },
      body: JSON.stringify({ repoPath: f.repoPath, baseRef: 'main', prompt: 'A task with enough characters for input validation.' }),
    });
    assert.equal(response.status, 403);
    assert.equal(f.store.list().length, 0);
  } finally { await f.close(); }
});

test('capabilities do not call a help-only model binding live verified', async () => {
  const f = await createFixture(false);
  try {
    const response = await fetch(`${f.url}/api/capabilities`);
    assert.equal(response.status, 200);
    const capability = await response.json() as {
      harnesses: Array<{ id: string; available: boolean; cliAvailable: boolean }>;
      bindings: Array<{ harnessId: string; modelId: string; available: boolean; verificationLevel?: string; reason?: string }>;
    };
    const harness = capability.harnesses.find(item => item.id === 'zcode');
    const modelBinding = capability.bindings.find(item => item.harnessId === 'zcode' && item.modelId === 'glm-main');
    assert.equal(harness?.cliAvailable, true, 'the fake adapter represents a successful CLI help/version probe');
    assert.equal(harness?.available, false, 'CLI help alone must not advertise a live model');
    assert.equal(modelBinding?.available, false);
    assert.equal(modelBinding?.verificationLevel, undefined);
    assert.match(modelBinding?.reason ?? '', /尚未通过.*验证/);
  } finally { await f.close(); }
});

test('configuration round trips preserve unavailable saved role choices and reject new unavailable choices', async () => {
  for (const selection of [{ modelId: 'codex-main', reasoningEffort: 'high' as const }, { modelId: null, reasoningEffort: 'high' as const }]) {
    let config: LocalZeroConfig = { ...testConfig(true, true), allocator: { kind: 'codex', ...selection }, reviewer: { ...selection } };
    let available = false;
    const store = new TaskStore();
    const server = createZeroServer({ store, config: { read: async () => structuredClone(config), write: async value => { config = structuredClone(value); } },
      adapters: { codex: { id: 'codex', probe: async () => ({ harness: 'codex', available, models: available ? ['codex-main'] : [], reasoningEfforts: ['high'], roles: ['implement', 'revise'] }),
        run: async () => { throw new Error('No real Harness execution is allowed'); } } } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/api/config`;
    const put = (body: unknown) => fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const read = await (await fetch(url)).json() as { allocator: LocalZeroConfig['allocator']; reviewer: LocalZeroConfig['reviewer'] };
      assert.deepEqual(read.allocator, { kind: 'codex', ...selection });
      assert.deepEqual(read.reviewer, selection);
      const saved = await put(read);
      assert.equal(saved.status, 200, await saved.text());
      assert.deepEqual(config.reviewer, selection);
      for (const role of ['allocator', 'reviewer'] as const) {
        for (const changed of [{ ...selection, modelId: 'new-unverified-model' }, { ...selection, reasoningEffort: 'xhigh' },
          selection.modelId ? { ...selection, reasoningEffort: null } : { ...selection, modelId: 'codex-main' }]) {
          const before = structuredClone(config);
          const rejected = await put({ ...read, [role]: { ...read[role], ...changed } });
          assert.equal(rejected.status, 400, await rejected.text());
          assert.deepEqual(config, before);
        }
      }
      const unrelatedEdit = await put({ ...read, allocator: { kind: 'api', modelId: null, reasoningEffort: null,
        api: { baseUrl: 'https://provider.example/v1', model: 'router', keyEnv: 'ZERO_ROUTER_KEY' } } });
      assert.equal(unrelatedEdit.status, 200, await unrelatedEdit.text());
      assert.deepEqual(config.reviewer, selection);
      available = true;
      assert.deepEqual((await (await fetch(url)).json() as typeof read).reviewer, selection);
      available = false;
      const cleared = await put({ ...read, allocator: { kind: 'codex', modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null } });
      assert.equal(cleared.status, 200, await cleared.text());
      assert.deepEqual(config.reviewer, { modelId: null, reasoningEffort: null });
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
  }
});

test('PUT and GET /api/config persist an API coordinator reference without any key value', async () => {
  const f = await createFixture();
  try {
    const configured = await fetch(`${f.url}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      allocator: { kind: 'api', modelId: null, reasoningEffort: null, api: { baseUrl: 'https://provider.example/v1', model: 'router-model', keyEnv: 'ZERO_ROUTE_KEY' } },
      reviewer: { modelId: null, reasoningEffort: null },
    }) });
    assert.equal(configured.status, 200);
    const payload = await configured.json() as { allocator: { kind: string; modelId: string | null; api: { baseUrl: string; model: string; keyEnv: string } } };
    assert.equal(payload.allocator.kind, 'api');
    assert.deepEqual(payload.allocator.api, { baseUrl: 'https://provider.example/v1', model: 'router-model', keyEnv: 'ZERO_ROUTE_KEY' });
    const persisted = await f.config.read();
    assert.deepEqual(persisted.allocator.api, payload.allocator.api);
    assert.equal(JSON.stringify(payload).includes('sk-'), false);

    const read = await fetch(`${f.url}/api/config`);
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json() as typeof payload).allocator, payload.allocator);
    const invalid = await fetch(`${f.url}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      allocator: { kind: 'api', modelId: null, reasoningEffort: null, api: { baseUrl: 'http://provider.example', model: 'm', keyEnv: 'BAD-NAME' } },
      reviewer: { modelId: null, reasoningEffort: null },
    }) });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json() as { error: string }).error, /HTTPS/);
  } finally { await f.close(); }
});

test('settings preserve unavailable existing execution defaults without accepting changes or new projects', async () => {
  const f = await createFixture();
  try {
    const defaults = { global: { model: 'glm-main', reasoningEffort: 'low' },
      projects: { [f.repoPath]: { harness: 'zcode', reasoningEffort: 'high' } } };
    await f.config.write({ ...await f.config.read(), executionDefaults: defaults });
    f.adapter.cap.available = false;
    const read = await (await fetch(`${f.url}/api/config`)).json() as {
      allocator: unknown; reviewer: unknown; executionDefaults: { global: unknown; projects: Array<{ repoPath: string; execution: unknown }> } };
    const edited = { ...read, allocator: { kind: 'api', modelId: null, reasoningEffort: null,
      api: { baseUrl: 'https://provider.example/v1', model: 'router', keyEnv: 'ZERO_ROUTER_KEY' } } };
    const put = (body: unknown) => fetch(`${f.url}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const saved = await put(edited);
    assert.equal(saved.status, 200, await saved.text());
    assert.deepEqual((await f.config.read()).executionDefaults, defaults);
    const anotherRepo = join(f.root, 'another-repo');
    await mkdir(anotherRepo);
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: anotherRepo, windowsHide: true });
    for (const executionDefaults of [
      { ...read.executionDefaults, global: { modelId: 'glm-main', reasoningEffort: 'high' } },
      { ...read.executionDefaults, global: null },
      { ...read.executionDefaults, global: { modelId: 'glm-main', reasoningEffort: 'low', extra: 'invalid' } },
      { ...read.executionDefaults, projects: [{ repoPath: f.repoPath, execution: { harnessId: 'zcode', reasoningEffort: 'low' } }] },
      { ...read.executionDefaults, projects: [{ repoPath: anotherRepo, execution: read.executionDefaults.projects[0]!.execution }] },
      { ...read.executionDefaults, projects: [{ ...read.executionDefaults.projects[0]!, extra: 'invalid' }] },
    ]) {
      const before = await readFile(f.config.path, 'utf8');
      const rejected = await put({ ...edited, executionDefaults });
      assert.equal(rejected.status, 400, await rejected.text());
      assert.equal(await readFile(f.config.path, 'utf8'), before);
    }
    const removed = await put({ ...edited, executionDefaults: { ...read.executionDefaults, projects: [] } });
    assert.equal(removed.status, 200, await removed.text());
    const cleared = await put({ ...edited, executionDefaults: { global: null, projects: [] } });
    assert.equal(cleared.status, 200, await cleared.text());
    assert.deepEqual((await f.config.read()).executionDefaults, { global: null, projects: {} });
    const projectOnly = { global: null, projects: { [f.repoPath]: { model: 'glm-main', reasoningEffort: 'high' } } };
    await f.config.write({ ...await f.config.read(), executionDefaults: projectOnly });
    const projectRead = await (await fetch(`${f.url}/api/config`)).json();
    const projectSaved = await put(projectRead);
    assert.equal(projectSaved.status, 200, await projectSaved.text());
    assert.deepEqual((await f.config.read()).executionDefaults, projectOnly);
  } finally { await f.close(); }
});

test('changing a global preset revalidates an unchanged project inherited selection', async () => {
  const f = await createFixture(true, undefined, true);
  try {
    await f.config.write({ ...await f.config.read(), executionDefaults: {
      global: { model: 'glm-main' }, projects: { [f.repoPath]: { harness: 'zcode' } },
    } });
    const read = await (await fetch(`${f.url}/api/config`)).json() as { executionDefaults: { global: unknown; projects: unknown[] } };
    const before = await readFile(f.config.path, 'utf8');
    const response = await fetch(`${f.url}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      ...read, executionDefaults: { ...read.executionDefaults, global: { modelId: 'codex-main' } },
    }) });
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, /effective selection/);
    assert.equal(await readFile(f.config.path, 'utf8'), before);
  } finally { await f.close(); }
});

test('PUT and GET /api/config persist canonical global and project execution defaults', async () => {
  const f = await createFixture();
  try {
    const configured = await fetch(`${f.url}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      allocator: { kind: 'codex', modelId: null, reasoningEffort: null },
      reviewer: { modelId: null, reasoningEffort: null },
      executionDefaults: {
        global: { modelId: 'glm-main', reasoningEffort: 'low' },
        projects: [{ repoPath: join(f.repoPath, '.'), execution: { harnessId: 'zcode', reasoningEffort: 'high' } }],
      },
    }) });
    assert.equal(configured.status, 200);
    const saved = await configured.json() as { executionDefaults: { global: unknown; projects: Array<{ repoPath: string; execution: unknown }> } };
    assert.deepEqual(saved.executionDefaults, {
      global: { modelId: 'glm-main', reasoningEffort: 'low' },
      projects: [{ repoPath: f.repoPath, execution: { harnessId: 'zcode', reasoningEffort: 'high' } }],
    });
    assert.deepEqual((await f.config.read()).executionDefaults, {
      global: { model: 'glm-main', reasoningEffort: 'low' },
      projects: { [f.repoPath]: { harness: 'zcode', reasoningEffort: 'high' } },
    });
    const read = await fetch(`${f.url}/api/config`);
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json() as typeof saved).executionDefaults, saved.executionDefaults);

    const invalid = await fetch(`${f.url}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      allocator: { kind: 'codex', modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null },
      executionDefaults: { global: { harnessId: 'unknown' }, projects: [] },
    }) });
    assert.equal(invalid.status, 400);
  } finally { await f.close(); }
});

test('PUT /api/config rejects an incompatible merged global and project preset without changing config', async () => {
  const f = await createFixture(true, undefined, true);
  try {
    const before = await readFile(f.config.path, 'utf8');
    const response = await fetch(`${f.url}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      allocator: { kind: 'codex', modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null },
      executionDefaults: {
        global: { modelId: 'glm-main' },
        projects: [{ repoPath: f.repoPath, execution: { harnessId: 'codex' } }],
      },
    }) });
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, /effective selection/);
    assert.equal(await readFile(f.config.path, 'utf8'), before);
  } finally { await f.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { HarnessAdapter, HarnessCapabilities, RunRequest, RunResult, TaskSubmission } from '../domain/types.js';
import type { ModelBinding } from '../adapters/types.js';
import { TaskStore } from '../core/task-store.js';
import { ConfigStore, type LocalZeroConfig } from './config-store.js';
import { createZeroServer } from './server.js';

const execFileAsync = promisify(execFile);

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
  constructor(readonly id: string, private readonly cap: HarnessCapabilities) {}
  probe(): Promise<HarnessCapabilities> { return Promise.resolve(this.cap); }
  async run(_request: RunRequest): Promise<RunResult> {
    throw new Error('API integration tests must not execute a Harness');
  }
}

interface Fixture {
  root: string;
  repoPath: string;
  artifactRoot: string;
  store: TaskStore;
  config: ConfigStore;
  url: string;
  close(): Promise<void>;
}

const model = { id: 'glm-main', provider: 'zai', modelId: 'glm-5' };
const binding: ModelBinding = {
  harness: 'zcode', model, selector: 'isolated_config', configDir: 'unused-in-probe-test', mode: 'yolo', verified: true,
  reasoningEfforts: ['low', 'high'], verificationSource: 'smoke_test', verifiedCliVersion: 'zcode-test-1',
};

function testConfig(hasLiveVerification: boolean): LocalZeroConfig {
  return {
    models: [model],
    bindings: [binding],
    allocator: { modelId: null, reasoningEffort: null },
    reviewer: { modelId: null, reasoningEffort: null },
    verifications: hasLiveVerification ? {
      'zcode:glm-main': {
        verifiedAt: '2026-09-24T00:00:00.000Z', cliVersion: 'zcode-test-1', requestedModel: 'glm-5',
        exitCode: 0, level: 'event_confirmed', actualModel: 'glm-5', reasoningEfforts: ['low', 'high'],
      },
    } : {},
  };
}

async function createFixture(hasLiveVerification = true): Promise<Fixture> {
  const root = await mkdtemp(join(process.cwd(), '.zero-server-test-'));
  const repoPath = join(root, 'repo');
  const artifactRoot = join(root, 'artifacts');
  await mkdir(repoPath, { recursive: true });
  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: repoPath, windowsHide: true });
  await execFileAsync('git', ['config', 'user.name', 'Zero API Test'], { cwd: repoPath, windowsHide: true });
  await execFileAsync('git', ['config', 'user.email', 'zero-api-test@example.invalid'], { cwd: repoPath, windowsHide: true });
  await writeFile(join(repoPath, 'README.md'), '# API test repository\n', 'utf8');
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoPath, windowsHide: true });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoPath, windowsHide: true });

  const configPath = join(root, 'config', 'zero.json');
  await mkdir(join(root, 'config'), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(testConfig(hasLiveVerification), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  const config = new ConfigStore(configPath);
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  const capability: HarnessCapabilities = {
    harness: 'zcode', version: 'zcode-test-1', available: true, models: ['glm-main'],
    reasoningEfforts: ['low', 'high'], roles: ['implement', 'revise'],
    probeEvidence: { versionAndHelp: 'passed', authentication: 'not_checked', modelSmokeTest: 'not_checked', configuredBindings: 'declared_verified' },
  };
  const adapters = { zcode: new ProbeOnlyAdapter('zcode', capability) };
  const server = createZeroServer({ store, config, adapters, artifactRoot, staticDir: join(root, 'web') });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolveListen(); });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    root, repoPath, artifactRoot, store, config,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
      store.close();
      await rm(root, { recursive: true, force: true });
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

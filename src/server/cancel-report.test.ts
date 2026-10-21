import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { HarnessAdapter, TaskRecord } from '../domain/types.js';
import { TaskStore } from '../core/task-store.js';
import { GitWorktreeManager } from '../core/git-worktree.js';
import { TestRunner } from '../core/test-runner.js';
import { QuotaLimitError } from '../core/quota.js';
import { TaskWorker, type TaskReport } from '../orchestrator/worker.js';
import { createZeroServer } from './server.js';

const exec = promisify(execFile);
const quotaReason = 'Offline reviewer quota exceeded; retry at the fixture reset';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const jsonTask = (task: TaskRecord) => JSON.parse(JSON.stringify(task));
const historicalContent = (report: TaskReport) => {
  const { task: _task, finalStatus: _status, error: _error, ...history } = report;
  return history;
};

async function fixture(mode: 'quota' | 'done' | 'prepared-report' | 'completed-report') {
  const parent = resolve(process.cwd());
  const root = await mkdtemp(join(parent, '.zero-cancel-report-'));
  const repo = join(root, 'repo');
  const artifactRoot = join(root, 'artifacts');
  await mkdir(repo);
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Zero Fixture'], ['config', 'user.email', 'zero@localhost']]) {
    await exec('git', args, { cwd: repo, windowsHide: true });
  }
  await writeFile(join(repo, 'seed.txt'), 'seed\n');
  await exec('git', ['add', '.'], { cwd: repo, windowsHide: true });
  await exec('git', ['commit', '-m', 'fixture'], { cwd: repo, windowsHide: true });
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  const task = store.submit({ repoPath: repo, baseRef: 'main', prompt: 'Keep the reviewer quota cancellation report accurate', maxRevisions: 0,
    checks: [{ id: 'approved', argv: [process.execPath, '-e', "if(require('node:fs').readFileSync('result.txt','utf8')!=='approved')process.exit(1)"] }] });
  const adapter: HarnessAdapter = { id: 'codex', async probe() { return { harness: 'codex', available: true, models: ['offline-model'] }; },
    async run(request) { await writeFile(join(request.cwd, 'result.txt'), 'approved'); return { status: 'completed', exitCode: 0, durationMs: 1, final: 'Offline writer summary' }; } };
  const worker = new TaskWorker({ store, worktrees: new GitWorktreeManager(join(root, 'worktrees')), testRunner: new TestRunner(),
    router: { async route(current) { return { taskId: current.id, harness: 'codex', model: 'offline-model', selectionSource: 'codex', reason: 'Offline fixture route', decidedAt: new Date().toISOString() }; } },
    reviewer: { async review() {
      if (mode === 'quota') throw new QuotaLimitError(quotaReason, new Date(Date.now() + 3_600_000).toISOString());
      return { harness: 'codex', model: 'offline-reviewer', exitCode: 0, result: { verdict: 'pass', summary: 'Offline review passed', findings: [] } };
    } }, adapters: new Map([['codex', adapter]]), artifactRoot });
  if (mode === 'prepared-report') store.completeReportOperation = () => { throw new Error('Offline prepared report boundary'); };
  if (mode === 'completed-report') store.completeReviewedTask = () => { throw new Error('Offline completed report boundary'); };
  const server = createZeroServer({ store, artifactRoot, adapters: { codex: adapter }, config: {
    async read() { return { models: [], bindings: [], verifications: {}, allocator: { kind: 'codex', modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null } }; },
    async write() { throw new Error('Report tests must never change configuration'); },
  } });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const path = join(artifactRoot, task.id, 'report.json');
  return { store, task, worker, url, path,
    async run() { assert.equal(store.claimNext('report-owner')?.id, task.id); return worker.runClaimed(task.id, 'report-owner'); },
    async download() {
      const response = await fetch(`${url}/api/tasks/${task.id}/report`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-disposition') ?? '', /^attachment; filename="zero-.+\.json"$/);
      return response.json() as Promise<TaskReport>;
    },
    async cancel() { return fetch(`${url}/api/tasks/${task.id}/cancel`, { method: 'POST' }); },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
      store.close();
      assert.ok(resolve(root).startsWith(parent + sep));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('reviewer-quota cancellation downloads the current task and cause without rewriting its waiting archive', async () => {
  const f = await fixture('quota');
  try {
    const waiting = await f.run();
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.resumeCheckpoint?.kind, 'review_quota');
    const archiveBytes = await readFile(f.path);
    const archive = JSON.parse(archiveBytes.toString()) as TaskReport;
    const waitingView = await f.download();
    assert.deepEqual(waitingView.task, jsonTask(waiting));
    assert.equal(waitingView.finalStatus, 'waiting');
    assert.equal(waitingView.error, quotaReason);
    assert.equal(waitingView.task.retryAt, waiting.retryAt);
    assert.deepEqual(historicalContent(waitingView), historicalContent(archive));
    const originalOperations = f.store.reportOperations(f.task.id);

    const response = await f.cancel();
    assert.equal(response.status, 200, await response.text());
    const current = f.store.get(f.task.id)!;
    assert.equal(current.status, 'failed');
    assert.equal(current.failureReason, 'Cancelled by user');
    assert.equal(current.retryAt, undefined);
    const detail = await (await fetch(`${f.url}/api/tasks/${f.task.id}`)).json() as { status: string; error?: string };
    assert.equal(detail.error, current.failureReason);
    const downloaded = await f.download();
    assert.deepEqual(downloaded.task, jsonTask(current));
    assert.equal(downloaded.finalStatus, 'failed');
    assert.equal(downloaded.error, current.failureReason);
    for (const field of ['retryAt', 'resumeCheckpoint', 'leaseOwner', 'leaseExpiresAt', 'heartbeatAt']) {
      assert.equal(Object.hasOwn(downloaded.task, field), false, `${field} must not survive from the archived task`);
    }
    assert.deepEqual(historicalContent(downloaded), historicalContent(archive));
    assert.equal(sha256(await readFile(f.path)), sha256(archiveBytes));
    assert.deepEqual(f.store.reportOperations(f.task.id), originalOperations);
    assert.equal((await f.cancel()).status, 409);
    assert.equal(sha256(await readFile(f.path)), sha256(archiveBytes));
  } finally { await f.close(); }
});

test('DONE report download retains completed evidence and operation hashes while exposing the current full task', async () => {
  const f = await fixture('done');
  try {
    const current = await f.run();
    assert.equal(current.status, 'done', current.failureReason);
    const archiveBytes = await readFile(f.path);
    const archive = JSON.parse(archiveBytes.toString()) as TaskReport;
    const operations = f.store.reportOperations(f.task.id);
    assert.equal(operations.length, 1);
    assert.equal(operations[0]!.status, 'complete');
    assert.equal(operations[0]!.reportSha256, sha256(archiveBytes));
    const downloaded = await f.download();
    assert.deepEqual(downloaded.task, jsonTask(current));
    assert.equal(downloaded.finalStatus, 'done');
    assert.equal(Object.hasOwn(downloaded, 'error'), false);
    assert.ok(downloaded.checks.length && downloaded.reviews.length && downloaded.attempts.length && downloaded.stages?.length);
    assert.deepEqual(historicalContent(downloaded), historicalContent(archive));
    assert.equal((await f.cancel()).status, 409);
    assert.equal(sha256(await readFile(f.path)), sha256(archiveBytes));
    assert.deepEqual(f.store.reportOperations(f.task.id), operations);
  } finally { await f.close(); }
});

for (const mode of ['prepared-report', 'completed-report'] as const) {
  test(`${mode} boundary failure and rejected terminal cancellation preserve operation and archived histories`, async () => {
    const f = await fixture(mode);
    try {
      const current = await f.run();
      assert.equal(current.status, 'failed');
      assert.match(current.failureReason!, /Offline .* report boundary/);
      const operations = f.store.reportOperations(f.task.id);
      assert.equal(operations.length, 1);
      assert.equal(operations[0]!.status, mode === 'prepared-report' ? 'prepared' : 'complete');
      const archiveBytes = await readFile(f.path);
      const archive = JSON.parse(archiveBytes.toString()) as TaskReport;
      assert.equal((await f.cancel()).status, 409);
      const downloaded = await f.download();
      assert.equal(downloaded.finalStatus, 'failed');
      assert.equal(downloaded.error, current.failureReason);
      assert.deepEqual(downloaded.task, jsonTask(current));
      assert.deepEqual(historicalContent(downloaded), historicalContent(archive));
      assert.equal(sha256(await readFile(f.path)), sha256(archiveBytes));
      assert.deepEqual(f.store.reportOperations(f.task.id), operations);
    } finally { await f.close(); }
  });
}

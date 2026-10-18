import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessAdapter, RunRequest } from '../domain/types.js';
import { GitWorktreeManager } from '../core/git-worktree.js';
import { GoalReviewRetryConflictError, TaskStore } from '../core/task-store.js';
import { TestRunner } from '../core/test-runner.js';
import { TaskWorker } from '../orchestrator/worker.js';
import { createSequenceGoalReviewScheduler } from './main.js';
import { createZeroServer } from './server.js';

const exec = promisify(execFile);
let fixture: Awaited<ReturnType<typeof prepare>>;

async function prepare() {
  const root = await mkdtemp(join(process.cwd(), '.zero-goal-retry-e2e-'));
  const repo = join(root, 'repo'); const sourceDb = join(root, 'source.sqlite');
  await mkdir(repo);
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid']]) await exec('git', args, { cwd: repo });
  await writeFile(join(repo, 'seed.txt'), 'base\n');
  await exec('git', ['add', '.'], { cwd: repo }); await exec('git', ['commit', '-m', 'fixture'], { cwd: repo });
  const store = new TaskStore(sourceDb);
  try {
    const sequence = store.createSequence(['first.txt', 'second.txt'].map(file => ({
      repoPath: repo, baseRef: 'main', prompt: `Create approved ${file}`, maxRevisions: 0,
      checks: [{ id: `${file}-approved`, argv: [process.execPath, '-e', `if(require('fs').readFileSync('${file}','utf8')!=='approved')process.exit(1)`] }],
    })), 'retry-e2e', { objective: 'Create both approved files', maxGoalRevisions: 0 });
    const worktreeRoot = join(root, 'worktrees');
    const worktrees = new GitWorktreeManager(worktreeRoot);
    const adapter: HarnessAdapter = { id: 'fake', async probe() { return { harness: 'fake', available: true, models: ['model'] }; },
      async run(request) {
        const file = request.taskId === sequence.steps[0]!.task.id ? 'first.txt' : 'second.txt';
        await writeFile(join(request.cwd, file), 'approved');
        return { status: 'completed', exitCode: 0, durationMs: 1 };
      } };
    const worker = new TaskWorker({ store, worktrees, testRunner: new TestRunner({ logDirectory: join(root, 'checks') }),
      router: { async route(task) { return { taskId: task.id, harness: 'fake', model: 'model', selectionSource: 'codex', reason: 'fixture', decidedAt: new Date().toISOString() }; } },
      reviewer: { async review() { return { harness: 'codex', model: 'review', exitCode: 0, result: { verdict: 'pass', summary: 'Approved', findings: [] } }; } },
      adapters: new Map([['fake', adapter]]), artifactRoot: join(root, 'task-artifacts') });
    for (const step of sequence.steps) {
      assert.equal(store.claimNext('worker')?.id, step.task.id);
      const done = await worker.runClaimed(step.task.id, 'worker'); assert.equal(done.status, 'done', done.failureReason);
    }
    return { root, sourceDb, worktreeRoot, sequenceId: sequence.id, taskIds: sequence.steps.map(step => step.task.id),
      finalFile: join(worktreeRoot, sequence.steps[1]!.task.id, 'second.txt') };
  } finally { store.close(); }
}

before(async () => { fixture = await prepare(); });
after(async () => { if (fixture) await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

async function context(name: string) {
  const dbPath = join(fixture.root, `${name}.sqlite`); await copyFile(fixture.sourceDb, dbPath);
  const ctx = { dbPath, store: new TaskStore(dbPath), worktrees: new GitWorktreeManager(fixture.worktreeRoot), calls: 0,
    mode: 'fail' as 'fail' | 'pass' | 'quota' | 'changes', configFails: false,
    onRun: undefined as ((request: RunRequest) => Promise<void>) | undefined };
  const codex: HarnessAdapter = { id: 'codex', async probe() { return { harness: 'codex', available: true, models: ['review'], roles: ['review'] }; },
    async run(request) {
      ctx.calls++; await ctx.onRun?.(request);
      if (ctx.mode === 'fail') return { status: 'failed', exitCode: 1, durationMs: 1, error: 'Transient connection reset' };
      if (ctx.mode === 'quota') return { status: 'failed', exitCode: 1, durationMs: 1, quota: { source: 'retry_after', retryAt: new Date(Date.now() + 60000).toISOString() } };
      return { status: 'completed', exitCode: 0, durationMs: 1, final: JSON.stringify(ctx.mode === 'pass'
        ? { verdict: 'pass', summary: 'Goal complete', findings: [] }
        : { verdict: 'changes_requested', summary: 'Missing proof', findings: [{ file: 'goal-proof.txt', line: 1, severity: 'medium', evidence: 'No proof', requestedChange: 'Add proof' }] }) };
    } };
  const scheduler = (store = ctx.store, worktrees = ctx.worktrees) => createSequenceGoalReviewScheduler({ store, worktrees, codex,
    artifactRoot: join(fixture.root, `review-${name}`), readReviewerConfig: async () => {
      if (ctx.configFails) throw new Error('Transient configuration read failure'); return {};
    } });
  return Object.assign(ctx, { scheduler,
    async block() { await scheduler()(); assert.equal(ctx.calls, 1); const source = ctx.store.sequenceGoalReview(fixture.sequenceId)!; assert.equal(source.result?.verdict, 'blocked'); return source; },
    async close() { ctx.store.close(); await writeFile(fixture.finalFile, 'approved'); } });
}

test('explicit retry survives restart and concurrent HTTP clicks invoke one fresh aggregate review', async () => {
  const c = await context('restart');
  try {
    const source = await c.block();
    await c.scheduler()(); assert.equal(c.calls, 1, 'unchanged blocked evidence is not automatically retried');
    const server = createZeroServer({ store: c.store, config: { async read() { throw new Error('No provider config is needed'); }, async write() {} } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); assert.ok(address && typeof address !== 'string');
      const responses = await Promise.all(Array.from({ length: 4 }, () => fetch(`http://127.0.0.1:${address.port}/api/sequences/${fixture.sequenceId}/goal-review/retry`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ attemptId: source.attemptId }),
      })));
      for (const response of responses) assert.equal(response.status, 202, await response.text());
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    c.store.close(); c.store = new TaskStore(c.dbPath);
    assert.ok(c.store.pendingSequenceGoalReviewRetry(fixture.sequenceId));
    c.mode = 'pass'; await c.scheduler()(); await c.scheduler()();
    assert.equal(c.calls, 2);
    assert.equal(c.store.getSequence(fixture.sequenceId)?.status, 'completed');
    assert.equal(c.store.sequenceGoalReviewByAttempt(source.attemptId)?.result?.verdict, 'blocked');
    assert.equal(c.store.pendingSequenceGoalReviewRetry(fixture.sequenceId), undefined);
    assert.equal(c.store.getSequence(fixture.sequenceId)?.goalRevisionCount, 0);
    assert.equal(c.store.events(fixture.taskIds[0]!).filter(event => event.type === 'task_sequence.goal_review_retry_requested').length, 1);
  } finally { await c.close(); }
});

test('a changed final checkout consumes the retry into blocked without a provider call', async () => {
  const c = await context('before-change');
  try {
    const source = await c.block(); c.store.requestSequenceGoalReviewRetry(fixture.sequenceId, source.attemptId);
    await writeFile(fixture.finalFile, 'changed before retry');
    await c.scheduler()(); await c.scheduler()();
    assert.equal(c.calls, 1);
    const latest = c.store.sequenceGoalReview(fixture.sequenceId)!;
    assert.notEqual(latest.attemptId, source.attemptId); assert.equal(latest.result?.verdict, 'blocked');
    assert.equal(c.store.pendingSequenceGoalReviewRetry(fixture.sequenceId), undefined);
    assert.ok(c.store.getSequence(fixture.sequenceId)?.steps.every(step => step.task.status === 'done'));
  } finally { await c.close(); }
});

test('a checkout change during a retried independent review cannot become PASS', async () => {
  const c = await context('during-change');
  try {
    const source = await c.block(); c.store.requestSequenceGoalReviewRetry(fixture.sequenceId, source.attemptId);
    c.mode = 'pass'; c.onRun = async () => { await writeFile(fixture.finalFile, 'changed during retry'); };
    await c.scheduler()();
    assert.equal(c.calls, 2);
    assert.equal(c.store.sequenceGoalReview(fixture.sequenceId)?.result?.verdict, 'blocked');
    assert.equal(c.store.getSequence(fixture.sequenceId)?.status, 'blocked');
    assert.equal(c.store.pendingSequenceGoalReviewRetry(fixture.sequenceId), undefined);
  } finally { await c.close(); }
});

test('configuration read failure consumes a request into blocked instead of leaving it running', async () => {
  const c = await context('config-failure');
  try {
    const source = await c.block(); c.store.requestSequenceGoalReviewRetry(fixture.sequenceId, source.attemptId);
    c.configFails = true; await c.scheduler()();
    const failed = c.store.sequenceGoalReview(fixture.sequenceId)!;
    assert.notEqual(failed.attemptId, source.attemptId); assert.equal(failed.state, 'verdict'); assert.equal(failed.result?.verdict, 'blocked');
    assert.equal(c.store.pendingSequenceGoalReviewRetry(fixture.sequenceId), undefined);
    c.configFails = false; c.mode = 'pass'; await c.scheduler()(); assert.equal(c.calls, 1);
    c.store.requestSequenceGoalReviewRetry(fixture.sequenceId, failed.attemptId); await c.scheduler()();
    assert.equal(c.store.getSequence(fixture.sequenceId)?.status, 'completed'); assert.equal(c.calls, 2);
  } finally { await c.close(); }
});

test('retry quota and changes_requested cannot bypass waiting or the exhausted goal revision cap', async () => {
  for (const mode of ['quota', 'changes'] as const) {
    const c = await context(`limit-${mode}`);
    try {
      const source = await c.block(); c.store.requestSequenceGoalReviewRetry(fixture.sequenceId, source.attemptId);
      c.mode = mode; await c.scheduler()(); await c.scheduler()();
      assert.equal(c.calls, 2);
      const latest = c.store.sequenceGoalReview(fixture.sequenceId)!;
      assert.equal(latest.state, mode === 'quota' ? 'quota' : 'verdict');
      if (mode === 'changes') assert.equal(latest.result?.verdict, 'changes_requested');
      assert.throws(() => c.store.requestSequenceGoalReviewRetry(fixture.sequenceId, source.attemptId), GoalReviewRetryConflictError);
      assert.throws(() => c.store.requestSequenceGoalReviewRetry(fixture.sequenceId, latest.attemptId), GoalReviewRetryConflictError);
      assert.equal(c.store.getSequence(fixture.sequenceId)?.steps.length, 2);
      assert.equal(c.store.getSequence(fixture.sequenceId)?.goalRevisionCount, 0);
    } finally { await c.close(); }
  }
});

test('a stale normal scheduler cannot start again after another connection finishes an explicit retry', async () => {
  const c = await context('stale-scheduler'); let release: (() => void) | undefined;
  let other: TaskStore | undefined;
  try {
    await c.block();
    await writeFile(fixture.finalFile, 'temporarily changed'); await c.scheduler()();
    const source = c.store.sequenceGoalReview(fixture.sequenceId)!;
    await writeFile(fixture.finalFile, 'approved');
    let arrived!: () => void; const waiting = new Promise<void>(resolve => { arrived = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = c.worktrees.reopen.bind(c.worktrees); let blocked = false;
    c.worktrees.reopen = async (...args) => { const info = await original(...args); if (!blocked) { blocked = true; arrived(); await gate; } return info; };
    c.mode = 'pass'; const stale = c.scheduler()();
    await waiting;
    c.store.requestSequenceGoalReviewRetry(fixture.sequenceId, source.attemptId);
    other = new TaskStore(c.dbPath);
    await c.scheduler(other, new GitWorktreeManager(fixture.worktreeRoot))();
    assert.equal(other.getSequence(fixture.sequenceId)?.status, 'completed');
    release!(); await stale;
    assert.equal(c.calls, 2, 'the stale non-retry capture cannot create a third provider attempt');
    assert.equal(c.store.getSequence(fixture.sequenceId)?.status, 'completed');
  } finally { release?.(); other?.close(); await c.close(); }
});

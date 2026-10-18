import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HarnessAdapter, RunRequest } from '../domain/types.js';
import { TaskStore } from '../core/task-store.js';
import { GitWorktreeManager } from '../core/git-worktree.js';
import { TestRunner } from '../core/test-runner.js';
import { TaskWorker } from '../orchestrator/worker.js';
import { createSequenceGoalReviewScheduler } from './main.js';

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) { return (await exec('git', args, { cwd, windowsHide: true })).stdout.trim(); }

async function fixture(chain = false, options: { linked?: boolean; goal?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zero-multi-goal-'));
  const a = join(root, 'server', 'project'); const b = join(root, 'client', 'project');
  for (const repo of [a, b]) {
    if (options.linked && repo === b) {
      await mkdir(dirname(b), { recursive: true });
      await git(a, 'worktree', 'add', '-b', 'linked-client', b, 'main');
      continue;
    }
    await mkdir(repo, { recursive: true });
    await git(repo, 'init', '-b', 'main');
    await git(repo, 'config', 'user.name', 'Test'); await git(repo, 'config', 'user.email', 'test@localhost');
    await writeFile(join(repo, 'seed.txt'), 'base\n');
    await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'fixture');
  }
  const db = join(root, 'tasks.sqlite');
  let store = new TaskStore(db);
  let open = true;
  const close = () => { if (open) { store.close(); open = false; } };
  const aCheck = { id: 'server-only', argv: [process.execPath, '-e', "require('fs').accessSync('server.txt'); if(require('fs').existsSync('client.txt'))process.exit(1)"] };
  const bCheck = { id: 'client-only', argv: [process.execPath, '-e', "require('fs').accessSync('client.txt'); if(require('fs').existsSync('server.txt'))process.exit(1)"] };
  const sequence = store.createSequence([
    { repoPath: a, baseRef: 'main', prompt: 'Implement server', acceptanceCriteria: ['Server result exists'], allowedPaths: ['server.txt', 'proof.txt'], checks: [aCheck] },
    { repoPath: b, baseRef: 'main', prompt: 'Implement client', acceptanceCriteria: ['Client result exists'], checks: [bCheck] },
    ...(chain ? [{ repoPath: a, baseRef: 'main', prompt: 'Extend server', acceptanceCriteria: ['Server extension exists'], allowedPaths: ['server.txt', 'proof.txt'], checks: [aCheck] }] : []),
  ], 'multi-goal', options.goal === false ? {} : { objective: 'Connect server and client', acceptanceCriteria: ['Both repositories implement the contract'], maxGoalRevisions: 2 });
  const taskIds = sequence.steps.map(step => step.task.id);
  const worktrees = new GitWorktreeManager(join(root, 'worktrees'));
  const artifacts = join(root, 'artifacts');
  const workerCalls: RunRequest[] = [];
  const adapter: HarnessAdapter = { id: 'fake', async probe() { return { harness: 'fake', available: true, models: ['worker'] }; },
    async run(request) {
      workerCalls.push(request);
      const first = request.taskId === taskIds[0];
      const file = first ? 'server.txt' : request.taskId === taskIds[1] ? 'client.txt' : taskIds.includes(request.taskId) ? 'server.txt' : 'proof.txt';
      await writeFile(join(request.cwd, file), `${file} ${first ? 'writer-self-commit' : 'complete'}\n`);
      if (first) { await git(request.cwd, 'add', '.'); await git(request.cwd, 'commit', '-m', 'writer self commit'); }
      return { status: 'completed', exitCode: 0, durationMs: 1 };
    } };
  const worker = () => new TaskWorker({ store, worktrees, artifactRoot: artifacts,
    testRunner: new TestRunner({ logDirectory: join(root, 'checks') }),
    router: { async route(task) { return { taskId: task.id, harness: 'fake', model: 'worker', selectionSource: 'codex', reason: 'fixture', decidedAt: new Date().toISOString() }; } },
    reviewer: { async review() { return { harness: 'codex', model: 'review', exitCode: 0, result: { verdict: 'pass', summary: 'Individual scope complete', findings: [] } }; } },
    adapters: new Map([['fake', adapter]]) });
  for (const id of taskIds) {
    assert.equal(store.claimNext('fixture')?.id, id);
    const result = await worker().runClaimed(id, 'fixture');
    assert.equal(result.status, 'done', result.failureReason);
  }
  return { root, a, b, db, artifacts, sequence, taskIds, worktrees, workerCalls, worker,
    close, get store() { return store; }, reopen() { close(); store = new TaskStore(db); open = true; },
    async dispose() { close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); } };
}

function adapter(run: HarnessAdapter['run']): HarnessAdapter {
  return { id: 'codex', async probe() { return { harness: 'codex', available: true, models: ['aggregate'], roles: ['review'] }; }, run };
}
const pass = () => ({ status: 'completed' as const, exitCode: 0, durationMs: 1,
  final: JSON.stringify({ verdict: 'pass', summary: 'Whole goal complete', findings: [], targetTaskId: null }) });

test('two repositories are independently reviewed and an earlier repository is remediated across restart', async () => {
  const f = await fixture();
  try {
    const bWorkspace = f.store.getWorktreeCreation(f.taskIds[1]!)!.plan as { path: string };
    const bHead = await git(bWorkspace.path, 'rev-parse', 'HEAD');
    let calls = 0;
    const codex = adapter(async request => {
      calls++;
      assert.equal(request.readOnly, true);
      assert.match(await readFile(join(request.cwd, 'review-context/projects/repo-1/project/server.txt'), 'utf8'), /server/);
      assert.match(await readFile(join(request.cwd, 'review-context/projects/repo-2/project/client.txt'), 'utf8'), /client/);
      assert.match(request.prompt, /writer-self-commit/, 'cumulative diff includes commits made by the writer before Zero committed');
      if (calls > 1) {
        assert.match(await readFile(join(request.cwd, 'review-context/projects/repo-1/project/proof.txt'), 'utf8'), /complete/);
        return pass();
      }
      return { status: 'completed', exitCode: 0, durationMs: 1, final: JSON.stringify({ verdict: 'changes_requested',
        summary: 'Server needs a proof', targetTaskId: f.taskIds[0], findings: [
          { file: 'proof.txt', line: 1, severity: 'medium', evidence: 'Server contract proof is absent', requestedChange: 'Add the server proof' },
        ] }) };
    });
    const schedule = () => createSequenceGoalReviewScheduler({ store: f.store, worktrees: f.worktrees, codex,
      artifactRoot: f.artifacts, readReviewerConfig: async () => ({}) });
    await schedule()();
    assert.equal(f.store.getSequence(f.sequence.id)?.goalReview?.result?.verdict, 'changes_requested');
    f.reopen();
    await schedule()();
    const revised = f.store.getSequence(f.sequence.id)!;
    assert.equal(revised.goalRevisionCount, 1);
    assert.equal(revised.steps.length, 3);
    const remediation = revised.steps[2]!.task;
    assert.equal(remediation.repoPath, f.a);
    assert.deepEqual(remediation.allowedPaths, ['server.txt', 'proof.txt']);
    assert.deepEqual(remediation.acceptanceCriteria, ['Server result exists']);
    assert.deepEqual(remediation.checks?.map(check => check.argv), [revised.steps[0]!.task.checks![0]!.argv]);
    await Promise.all([schedule()(), schedule()()]);
    assert.equal(f.store.getSequence(f.sequence.id)?.steps.length, 3);
    assert.equal(calls, 1);
    assert.equal(f.store.claimNext('remediate')?.id, remediation.id);
    const done = await f.worker().runClaimed(remediation.id, 'remediate');
    assert.equal(done.status, 'done', done.failureReason);
    assert.equal(await git(bWorkspace.path, 'rev-parse', 'HEAD'), bHead);
    assert.equal(await git(bWorkspace.path, 'status', '--porcelain'), '');
    f.reopen(); await schedule()();
    assert.equal(f.store.getSequence(f.sequence.id)?.status, 'completed');
    assert.equal(calls, 2);
    assert.equal(f.workerCalls.length, 3);
  } finally { await f.dispose(); }
});

test('A -> B -> A verifies each repository chain including singleton groups', async () => {
  const f = await fixture(true);
  try {
    let calls = 0;
    await createSequenceGoalReviewScheduler({ store: f.store, worktrees: f.worktrees, codex: adapter(async request => {
      calls++; assert.match(request.prompt, new RegExp(f.taskIds[2]!)); return pass();
    }), artifactRoot: f.artifacts, readReviewerConfig: async () => ({}) })();
    assert.equal(f.store.getSequence(f.sequence.id)?.status, 'completed', f.store.sequenceGoalReview(f.sequence.id)?.result?.summary);
    assert.equal(calls, 1);
  } finally { await f.dispose(); }
});

test('different checkout roots sharing one Git identity cannot hide divergent completed work', async () => {
  const f = await fixture(false, { linked: true });
  try {
    let calls = 0;
    await createSequenceGoalReviewScheduler({ store: f.store, worktrees: f.worktrees, codex: adapter(async () => { calls++; return pass(); }),
      artifactRoot: f.artifacts, readReviewerConfig: async () => ({}) })();
    assert.equal(f.store.getSequence(f.sequence.id)?.status, 'blocked');
    assert.match(f.store.sequenceGoalReview(f.sequence.id)?.result?.summary ?? '', /handoff bases/);
    assert.equal(calls, 0);
  } finally { await f.dispose(); }
});

test('mixed repositories without a goal retain ordinary completion without aggregate calls', async () => {
  const f = await fixture(false, { goal: false });
  try {
    let calls = 0;
    await createSequenceGoalReviewScheduler({ store: f.store, worktrees: f.worktrees, codex: adapter(async () => { calls++; return pass(); }),
      artifactRoot: f.artifacts, readReviewerConfig: async () => ({}) })();
    assert.equal(f.store.getSequence(f.sequence.id)?.status, 'completed');
    assert.equal(calls, 0);
  } finally { await f.dispose(); }
});

test('invalid multi targets and non-target mutation block safely and explicit retry recovers', async t => {
  const f = await fixture(true);
  try {
    f.close();
    for (const scenario of ['missing', 'foreign', 'earlier', 'non-target-mutation', 'missing-check-results', 'dirty-final-head', 'quota'] as const) await t.test(scenario, async () => {
      const db = join(f.root, `${scenario}.sqlite`); await copyFile(f.db, db);
      const store = new TaskStore(db);
      const bWorkspace = store.getWorktreeCreation(f.taskIds[1]!)!.plan as { path: string };
      let calls = 0;
      let recover = false;
      const codex = adapter(async () => {
        calls++;
        if (recover) return pass();
        if (scenario === 'quota') return { status: 'failed', exitCode: 1, durationMs: 1, quota: { retryAt: new Date(Date.now() + 60_000).toISOString(), source: 'provider_message' } };
        if (scenario === 'non-target-mutation') {
          await writeFile(join(bWorkspace.path, 'client.txt'), 'changed during read-only review');
          return pass();
        }
        return { status: 'completed', exitCode: 0, durationMs: 1, final: JSON.stringify({ verdict: 'changes_requested', summary: 'Fix server', findings: [
          { file: 'server.txt', line: 1, severity: 'high', evidence: 'Missing detail', requestedChange: 'Complete detail' },
        ], ...(scenario === 'missing' ? {} : { targetTaskId: scenario === 'earlier' ? f.taskIds[0] : 'foreign' }) }) };
      });
      const results = store.checkRunResults.bind(store);
      if (scenario === 'missing-check-results') store.checkRunResults = () => [];
      const originalHead = await git(bWorkspace.path, 'rev-parse', 'HEAD');
      if (scenario === 'dirty-final-head') await git(bWorkspace.path, 'update-ref', 'HEAD', `${originalHead}^`);
      const schedule = createSequenceGoalReviewScheduler({ store, worktrees: f.worktrees, codex,
        artifactRoot: join(f.root, scenario), readReviewerConfig: async () => ({}) });
      try {
        await schedule();
        const review = store.sequenceGoalReview(f.sequence.id)!;
        assert.equal(review.state, scenario === 'quota' ? 'quota' : 'verdict');
        if (scenario !== 'quota') assert.equal(review.result?.verdict, 'blocked');
        assert.equal(calls, ['missing-check-results', 'dirty-final-head'].includes(scenario) ? 0 : 1);
        await schedule();
        assert.equal(store.getSequence(f.sequence.id)?.goalRevisionCount, 0);
        const latest = store.sequenceGoalReview(f.sequence.id)!;
        if (scenario === 'quota') return;
        await git(bWorkspace.path, 'update-ref', 'HEAD', originalHead);
        await git(bWorkspace.path, 'restore', '--source=HEAD', '--staged', '--worktree', '--', '.');
        store.checkRunResults = results;
        recover = true;
        store.requestSequenceGoalReviewRetry(f.sequence.id, latest.attemptId);
        await schedule();
        assert.equal(store.getSequence(f.sequence.id)?.status, 'completed');
        assert.equal(store.getSequence(f.sequence.id)?.goalRevisionCount, 0);
      } finally {
        store.close();
        await git(bWorkspace.path, 'update-ref', 'HEAD', originalHead);
        await git(bWorkspace.path, 'restore', '--source=HEAD', '--staged', '--worktree', '--', '.');
      }
    });
  } finally { await f.dispose(); }
});

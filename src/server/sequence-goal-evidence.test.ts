import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessAdapter } from '../domain/types.js';
import { GitWorktreeManager } from '../core/git-worktree.js';
import { TaskStore } from '../core/task-store.js';
import { TestRunner } from '../core/test-runner.js';
import { TaskWorker } from '../orchestrator/worker.js';
import { createSequenceGoalReviewScheduler } from './main.js';

const exec = promisify(execFile);

test('aggregate verification uses the result package checks after an ordinary successful content revision', async t => {
  const root = await mkdtemp(join(process.cwd(), '.zero-goal-check-evidence-'));
  const repo = join(root, 'repo');
  const sourceDb = join(root, 'source.sqlite');
  let source: TaskStore | undefined;
  try {
    await mkdir(repo);
    for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid']]) await exec('git', args, { cwd: repo });
    await writeFile(join(repo, 'seed.txt'), 'base\n');
    await exec('git', ['add', '.'], { cwd: repo }); await exec('git', ['commit', '-m', 'fixture'], { cwd: repo });
    source = new TaskStore(sourceDb);
    const sequence = source.createSequence([
      { repoPath: repo, baseRef: 'main', prompt: 'Write an approved first file', maxRevisions: 1,
        checks: [{ id: 'first-approved', argv: [process.execPath, '-e', "if(require('fs').readFileSync('first.txt','utf8')!=='approved')process.exit(1)"] }] },
      { repoPath: repo, baseRef: 'main', prompt: 'Write the second file',
        checks: [{ id: 'second-exists', argv: [process.execPath, '-e', "require('fs').accessSync('second.txt')"] }] },
    ], 'revised-sequence', { objective: 'Create two approved files', acceptanceCriteria: ['Both files exist'], maxGoalRevisions: 0 });
    const firstId = sequence.steps[0]!.task.id;
    let firstRuns = 0;
    const adapter: HarnessAdapter = { id: 'fake', async probe() { return { harness: 'fake', available: true, models: ['model'] }; },
      async run(request) {
        await writeFile(join(request.cwd, request.taskId === firstId ? 'first.txt' : 'second.txt'),
          request.taskId === firstId && firstRuns++ === 0 ? 'needs revision' : 'approved');
        return { status: 'completed', exitCode: 0, durationMs: 1 };
      } };
    const worktrees = new GitWorktreeManager(join(root, 'worktrees'));
    const worker = new TaskWorker({ store: source, worktrees, testRunner: new TestRunner({ logDirectory: join(root, 'check-logs') }),
      router: { async route(task) { return { taskId: task.id, harness: 'fake', model: 'model', selectionSource: 'codex', reason: 'fixture', decidedAt: new Date().toISOString() }; } },
      reviewer: { async review() { return { harness: 'codex', model: 'reviewer', exitCode: 0, result: { verdict: 'pass', summary: 'Approved', findings: [] } }; } },
      adapters: new Map([['fake', adapter]]), artifactRoot: join(root, 'task-artifacts') });
    for (const step of sequence.steps) {
      assert.equal(source.claimNext('worker')?.id, step.task.id);
      const result = await worker.runClaimed(step.task.id, 'worker');
      assert.equal(result.status, 'done', result.failureReason);
    }
    assert.equal(source.get(firstId)?.revisionCount, 1);
    const firstRunsEvidence = source.checkRuns(firstId);
    assert.deepEqual(firstRunsEvidence.map(run => run.status).sort(), ['completed', 'failed']);
    const commit = source.commitOperations(firstId)[0]!;
    const pkg = source.getReviewPackage(commit.packageId)!;
    const failedRun = firstRunsEvidence.find(run => run.status === 'failed')!;
    source.close(); source = undefined;

    for (const scenario of ['valid', 'missing-package', 'wrong-run', 'missing-results'] as const) {
      await t.test(scenario, async () => {
        const db = join(root, `${scenario}.sqlite`); await copyFile(sourceDb, db);
        const store = new TaskStore(db);
        let calls = 0;
        try {
          if (scenario === 'missing-package') {
            const original = store.getReviewPackage.bind(store);
            store.getReviewPackage = id => id === pkg.id ? undefined : original(id);
          } else if (scenario === 'wrong-run') {
            const original = store.getCheckRun.bind(store);
            store.getCheckRun = id => id === pkg.checkRunId ? failedRun : original(id);
          } else if (scenario === 'missing-results') {
            const original = store.checkRunResults.bind(store);
            store.checkRunResults = id => id === pkg.checkRunId ? [] : original(id);
          }
          const codex: HarnessAdapter = { id: 'codex', async probe() { return { harness: 'codex', available: true, models: ['goal-reviewer'], roles: ['review'] }; },
            async run(request) {
              calls++;
              assert.ok(request.prompt.includes(pkg.checkRunId));
              assert.ok(!request.prompt.includes(failedRun.id), 'superseded failed checks cannot become current completion evidence');
              return { status: 'completed', exitCode: 0, durationMs: 1, final: JSON.stringify({ verdict: 'pass', summary: 'Complete', findings: [] }) };
            } };
          await createSequenceGoalReviewScheduler({ store, worktrees, codex, artifactRoot: join(root, scenario), readReviewerConfig: async () => ({}) })();
          assert.equal(calls, scenario === 'valid' ? 1 : 0);
          assert.equal(store.getSequence(sequence.id)?.status, scenario === 'valid' ? 'completed' : 'blocked');
        } finally { store.close(); }
      });
    }
  } finally {
    source?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

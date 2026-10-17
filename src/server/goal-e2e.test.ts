import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HarnessAdapter, ReviewResult, RouteDecision, RunRequest, RunResult } from '../domain/types.js';
import { GitWorktreeManager } from '../core/git-worktree.js';
import { TaskStore } from '../core/task-store.js';
import { TestRunner } from '../core/test-runner.js';
import { TaskWorker, type TaskReviewer } from '../orchestrator/worker.js';
import { createSequenceGoalReviewScheduler } from './main.js';

const exec = promisify(execFile);

async function initRepo(repo: string): Promise<void> {
  await mkdir(repo);
  await exec('git', ['init', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'Zero E2E Test'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'zero-e2e@localhost'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), 'Goal integration fixture.\n');
  await exec('git', ['add', 'README.md'], { cwd: repo });
  await exec('git', ['commit', '-m', 'fixture'], { cwd: repo });
}

function routeFor(taskId: string): RouteDecision {
  return { taskId, harness: 'fake', model: 'worker-model', selectionSource: 'codex',
    fieldSources: { harness: 'codex', model: 'codex', reasoningEffort: 'codex' }, reason: 'E2E fixture route', decidedAt: new Date().toISOString() };
}

async function runGoalRemediationScenario(options: { rename?: boolean; breakFinalCheck?: boolean } = {}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'zero-goal-e2e-'));
  const repo = join(root, 'repo');
  const dbPath = join(root, 'tasks.sqlite');
  const artifacts = join(root, 'artifacts');
  const worktreeRoot = join(root, 'worktrees');
  await initRepo(repo);
  let store = new TaskStore(dbPath);
  try {
    const sequence = store.createSequence([
      { repoPath: repo, baseRef: 'main', prompt: 'Create first.txt', maxRevisions: 0,
        checks: [{ id: 'first-file-exists', argv: [process.execPath, '-e', "require('node:fs').accessSync('first.txt')"] }] },
      { repoPath: repo, baseRef: 'main', prompt: options.rename ? 'Rename first.txt to second.txt and remove the old name' : 'Create second.txt and keep first.txt', maxRevisions: 0,
        checks: [{ id: 'final-files', argv: [process.execPath, '-e', options.rename
          ? "const fs=require('node:fs'); if(fs.existsSync('first.txt'))process.exit(1); fs.accessSync('second.txt')"
          : "const fs=require('node:fs'); fs.accessSync('first.txt'); fs.accessSync('second.txt')"] }] },
    ], 'goal-e2e-sequence', { objective: options.rename ? 'Create first.txt, rename it to second.txt, and document the aggregate result' : 'Create both files and document the aggregate result',
      acceptanceCriteria: [options.rename ? 'second.txt exists and first.txt is removed' : 'first.txt and second.txt exist',
        'goal-proof.txt records the aggregate review remediation'], maxGoalRevisions: 2 });
    const stepIds = sequence.steps.map(step => step.task.id);
    const aggregateVerdicts: ReviewResult[] = [
      { verdict: 'changes_requested', summary: 'The aggregate result needs a proof file.', findings: [
        { file: 'goal-proof.txt', line: 1, severity: 'medium', evidence: 'No file records the aggregate review remediation.',
          requestedChange: 'Create goal-proof.txt to document the aggregate remediation.' },
      ] },
      { verdict: 'pass', summary: 'Both ordered steps and the remediation satisfy the complete goal.', findings: [] },
    ];
    const aggregateRequests: RunRequest[] = [];
    const codex: HarnessAdapter = {
      id: 'codex',
      async probe() { return { harness: 'codex', available: true, models: ['fake-review-model'], roles: ['review'], reasoningEfforts: [] }; },
      async run(request) {
        aggregateRequests.push(request);
        const verdict = aggregateVerdicts.shift();
        assert.ok(verdict, 'the scheduler should request one fresh aggregate review per completed result');
        const result: RunResult = { status: 'completed', exitCode: 0, durationMs: 1, final: JSON.stringify(verdict) };
        return result;
      },
    };
    const workerAdapter: HarnessAdapter = {
      id: 'fake',
      async probe() { return { harness: 'fake', available: true, models: ['worker-model'], roles: ['implement', 'revise'], reasoningEfforts: [] }; },
      async run(request) {
        const file = request.taskId === stepIds[0] ? 'first.txt' : request.taskId === stepIds[1] ? 'second.txt' : 'goal-proof.txt';
        await writeFile(join(request.cwd, file), `${file} approved\n`);
        if (options.rename && request.taskId === stepIds[1]) await rm(join(request.cwd, 'first.txt'));
        if (options.breakFinalCheck && !stepIds.includes(request.taskId)) {
          await writeFile(join(request.cwd, 'first.txt'), 'The obsolete name must remain absent.\n');
        }
        return { status: 'completed', exitCode: 0, requestedModel: request.model, actualModel: request.model, durationMs: 1 };
      },
    };
    const stepReviewer: TaskReviewer = { async review() {
      return { harness: 'codex', model: 'fake-step-reviewer', exitCode: 0,
        result: { verdict: 'pass', summary: 'The individual task is complete.', findings: [] } };
    } };
    const worktrees = new GitWorktreeManager(worktreeRoot);
    const worker = () => new TaskWorker({ store, worktrees, testRunner: new TestRunner({ logDirectory: join(artifacts, 'checks') }),
      router: { async route(task) { return routeFor(task.id); } }, reviewer: stepReviewer,
      adapters: new Map([['fake', workerAdapter]]), artifactRoot: artifacts });
    const scheduler = createSequenceGoalReviewScheduler({ store, worktrees, codex, artifactRoot: artifacts,
      readReviewerConfig: async () => ({}) });

    const first = store.claimNext('goal-step-one-worker');
    assert.equal(first?.id, stepIds[0]);
    const firstResult = await worker().runClaimed(first!.id, 'goal-step-one-worker');
    assert.equal(firstResult.status, 'done', firstResult.failureReason);
    const firstReport = await worker().readReport(first!.id);
    assert.equal(firstReport?.finalStatus, 'done');
    assert.ok(firstReport?.resultCommit);
    assert.equal(store.reportOperations(first!.id)[0]?.status, 'complete');
    store.close();

    store = new TaskStore(dbPath);
    const second = store.claimNext('goal-step-two-worker');
    assert.equal(second?.id, stepIds[1], 'the second task remains gated until the first authoritative report is persisted');
    assert.equal(second?.sequenceBaseCommit, firstReport?.resultCommit);
    assert.equal((await worker().runClaimed(second!.id, 'goal-step-two-worker')).status, 'done');
    const secondReport = await worker().readReport(second!.id);
    assert.equal(secondReport?.baseCommit, firstReport?.resultCommit);
    assert.equal(secondReport?.finalStatus, 'done');
    for (const id of stepIds) {
      const operation = store.reportOperations(id)[0]!;
      assert.equal(operation.status, 'complete');
      assert.equal(operation.reportSha256.length, 64);
      const diskReport = JSON.parse(await readFile(operation.reportPath, 'utf8')) as { finalStatus?: string; resultCommit?: string };
      assert.equal(diskReport.finalStatus, 'done');
      assert.match(diskReport.resultCommit ?? '', /^[a-f0-9]{40,64}$/);
    }
    store.close();

    store = new TaskStore(dbPath);
    const persistedScheduler = createSequenceGoalReviewScheduler({ store, worktrees, codex, artifactRoot: artifacts,
      readReviewerConfig: async () => ({}) });
    await persistedScheduler();
    const changesRequested = store.getSequence(sequence.id)!;
    assert.equal(changesRequested.status, 'blocked');
    assert.equal(changesRequested.goalReview?.result?.verdict, 'changes_requested', changesRequested.goalReview?.result?.summary);
    assert.equal(changesRequested.goalReview?.state, 'verdict');
    assert.match(aggregateRequests[0]?.prompt ?? '', /first\.txt/);
    assert.match(aggregateRequests[0]?.prompt ?? '', /second\.txt/);
    assert.match(aggregateRequests[0]?.prompt ?? '', /reportSha256/);
    assert.match(aggregateRequests[0]?.prompt ?? '', /cumulativeDiff/);
    assert.match(aggregateRequests[0]?.prompt ?? '', /first-file-exists/);
    assert.match(aggregateRequests[0]?.prompt ?? '', /final-files/);
    const firstAttemptId = changesRequested.goalReview?.attemptId;
    store.close();

    store = new TaskStore(dbPath);
    const resumedScheduler = createSequenceGoalReviewScheduler({ store, worktrees, codex, artifactRoot: artifacts,
      readReviewerConfig: async () => ({}) });
    await resumedScheduler();
    const afterAppend = store.getSequence(sequence.id)!;
    assert.equal(afterAppend.goalReview?.attemptId, firstAttemptId);
    assert.equal(afterAppend.goalRevisionCount, 1);
    assert.equal(afterAppend.steps.length, 3);
    const remediation = afterAppend.steps[2]!.task;
    assert.match(remediation.prompt, /Create goal-proof\.txt/);
    assert.equal(store.checks(stepIds[0]!).length, 1, 'the intermediate check remains in its original task history');
    const remediationClaim = store.claimNext('goal-remediation-worker');
    assert.equal(remediationClaim?.id, remediation.id);
    assert.equal(remediationClaim?.sequenceBaseCommit, secondReport?.resultCommit);
    const remediationResult = await worker().runClaimed(remediation.id, 'goal-remediation-worker');
    if (options.breakFinalCheck) {
      assert.equal(remediationResult.status, 'failed');
      assert.match(remediationResult.failureReason ?? '', /Validation failed after 2 content revisions/);
      assert.equal(store.getSequence(sequence.id)?.status, 'blocked');
      assert.deepEqual(remediation.checks?.map(check => check.argv), [afterAppend.steps[1]!.task.checks![0]!.argv]);
      const failedChecks = store.checks(remediation.id);
      assert.equal(failedChecks.length, 3, 'the final check runs initially and after each bounded content revision');
      assert.ok(failedChecks.every(check => check.status === 'failed'));
      assert.equal(aggregateRequests.length, 1, 'a broken final-step invariant prevents another aggregate PASS');
      return;
    }
    assert.equal(remediationResult.status, 'done', remediationResult.failureReason);
    assert.deepEqual(remediation.checks?.map(check => check.argv), [afterAppend.steps[1]!.task.checks![0]!.argv]);
    const remediationReport = await worker().readReport(remediation.id);
    assert.equal(remediationReport?.finalStatus, 'done');
    assert.ok(remediationReport?.resultCommit);
    assert.equal(store.reportOperations(remediation.id)[0]?.status, 'complete');
    store.close();

    store = new TaskStore(dbPath);
    const finalScheduler = createSequenceGoalReviewScheduler({ store, worktrees, codex, artifactRoot: artifacts,
      readReviewerConfig: async () => ({}) });
    await finalScheduler();
    const completed = store.getSequence(sequence.id)!;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.goalReview?.result?.verdict, 'pass');
    assert.equal(completed.goalRevisionCount, 1);
    assert.equal(completed.steps.length, 3);
    assert.equal(store.sequenceGoalReview(sequence.id)?.result?.summary, 'Both ordered steps and the remediation satisfy the complete goal.');
    assert.equal(aggregateRequests.length, 2);
    assert.ok(aggregateRequests.every(request => request.readOnly === true && request.role === 'review'));
    assert.match(aggregateRequests[1]?.prompt ?? '', /goal-proof\.txt/);
    assert.match(aggregateRequests[1]?.prompt ?? '', new RegExp(remediation.id));
    assert.equal(aggregateVerdicts.length, 0);
    assert.equal(store.events(sequence.steps[0]!.task.id).some(event => event.type === 'report_operation.complete'), true);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('two ordered tasks persist reports, aggregate changes_requested appends remediation, and final PASS completes the goal', async () => {
  await runGoalRemediationScenario();
});

test('goal remediation after a rename uses final checks and completes without restoring the intermediate file', async () => {
  await runGoalRemediationScenario({ rename: true });
});

test('goal remediation still fails when it violates the final-step file constraint', async () => {
  await runGoalRemediationScenario({ rename: true, breakFinalCheck: true });
});

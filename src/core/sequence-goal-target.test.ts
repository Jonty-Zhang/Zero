import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { GoalReviewResult, HarnessAdapter } from '../domain/types.js';
import { GitWorktreeManager } from './git-worktree.js';
import { TaskStore } from './task-store.js';
import { TestRunner } from './test-runner.js';
import { TaskWorker } from '../orchestrator/worker.js';
import { buildGoalRevisionSubmission } from '../orchestrator/goal-revision.js';

const exec = promisify(execFile);
const changes = (targetTaskId?: string): GoalReviewResult => ({ verdict: 'changes_requested', summary: 'A local result needs correction.',
  findings: [{ severity: 'high', evidence: 'The local behavior is incomplete.', requestedChange: 'Complete the local behavior.' }],
  ...(targetTaskId === undefined ? {} : { targetTaskId }) });

async function fixture(root: string, linked = false) {
  const repositories = [join(root, 'A'), join(root, 'B')];
  for (const repo of repositories) {
    await mkdir(repo);
    for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@localhost']]) {
      await exec('git', args, { cwd: repo, windowsHide: true });
    }
    await writeFile(join(repo, 'seed.txt'), 'base\n');
    await exec('git', ['add', '.'], { cwd: repo, windowsHide: true });
    await exec('git', ['commit', '-m', 'fixture'], { cwd: repo, windowsHide: true });
  }
  let roots = [repositories[0]!, repositories[1]!, repositories[0]!, repositories[1]!];
  if (linked) {
    const alias = join(root, 'A-linked');
    await exec('git', ['worktree', 'add', '-b', 'linked', alias, 'main'], { cwd: repositories[0], windowsHide: true });
    roots = [repositories[0]!, repositories[1]!, alias];
  }
  const dbPath = join(root, 'source.sqlite');
  const store = new TaskStore(dbPath);
  try {
    const sequence = store.createSequence(roots.map((repoPath, index) => ({ repoPath, baseRef: 'main', prompt: `Write step-${index}.txt`,
      acceptanceCriteria: [`Local step ${index} remains valid`],
      ...(index % 2 === 0 ? { allowedPaths: ['step-0.txt', 'step-2.txt', 'proof.txt'] } : {}),
      checks: [{ id: `check-${index}`, argv: [process.execPath, '-e', `require('fs').accessSync('step-${index}.txt')`] }],
    })), 'target-sequence', { objective: 'Deliver both projects', acceptanceCriteria: ['Both projects work together'], maxGoalRevisions: 1 });
    const adapter: HarnessAdapter = { id: 'fake', async probe() { return { harness: 'fake', available: true, models: ['model'] }; },
      async run(request) {
        const index = sequence.steps.findIndex(step => step.task.id === request.taskId);
        await writeFile(join(request.cwd, `step-${index}.txt`), 'approved\n');
        return { status: 'completed', exitCode: 0, durationMs: 1 };
      } };
    const worker = new TaskWorker({ store, worktrees: new GitWorktreeManager(join(root, 'worktrees')),
      testRunner: new TestRunner({ logDirectory: join(root, 'checks') }),
      router: { async route(task) { return { taskId: task.id, harness: 'fake', model: 'model', selectionSource: 'codex', reason: 'fixture', decidedAt: new Date().toISOString() }; } },
      reviewer: { async review() { return { harness: 'codex', model: 'reviewer', exitCode: 0, result: { verdict: 'pass', summary: 'Approved', findings: [] } }; } },
      adapters: new Map([['fake', adapter]]), artifactRoot: join(root, 'artifacts') });
    for (const step of sequence.steps) {
      assert.equal(store.claimNext('worker')?.id, step.task.id);
      const result = await worker.runClaimed(step.task.id, 'worker');
      assert.equal(result.status, 'done', result.failureReason);
    }
    return { dbPath, sequence: store.getSequence(sequence.id)! };
  } finally { store.close(); }
}

function finish(store: TaskStore, targetTaskId?: string, id = 'target-review') {
  const attempt = store.startSequenceGoalReview('target-sequence', 'a'.repeat(64), id);
  return store.finishSequenceGoalReview({ attemptId: attempt.attemptId, verifiedEvidenceFingerprint: 'a'.repeat(64), result: changes(targetTaskId) });
}

test('persisted aggregate targets authorize only the latest linear repository tip and append atomically', async t => {
  const root = await mkdtemp(join(process.cwd(), '.zero-goal-target-'));
  try {
    const source = await fixture(root);
    const target = source.sequence.steps[2]!.task;
    const earlier = source.sequence.steps[0]!.task;
    const evidenceStore = new TaskStore(source.dbPath);
    let targetResult: string;
    try { targetResult = JSON.parse(evidenceStore.reportOperations(target.id)[0]!.reportBytes.toString('utf8')).resultCommit; }
    finally { evidenceStore.close(); }
    const cases = [
      'valid', 'foreign', 'earlier', 'missing-target', 'missing-target-final-root', 'wrong-root', 'missing-identity', 'missing-earlier-identity', 'wrong-observed-identity',
      'wrong-plan-path', 'wrong-creation-base', 'wrong-handoff', 'missing-package', 'missing-result', 'wrong-report', 'exhausted',
      'wrong-run-execution', 'wrong-run-stage', 'wrong-run-route', 'wrong-run-branch', 'missing-check-completion', 'wrong-check-completion',
    ] as const;
    for (const scenario of cases) await t.test(scenario, async () => {
      const dbPath = join(root, `${scenario}.sqlite`);
      await copyFile(source.dbPath, dbPath);
      const db = new DatabaseSync(dbPath);
      try {
        if (scenario === 'missing-identity') db.prepare('DELETE FROM worktree_creations WHERE task_id=?').run(target.id);
        if (scenario === 'missing-earlier-identity') db.prepare('DELETE FROM worktree_creations WHERE task_id=?').run(earlier.id);
        if (scenario === 'wrong-observed-identity') {
          const row = db.prepare('SELECT observed FROM worktree_creations WHERE task_id=?').get(target.id) as { observed: string };
          const observed = JSON.parse(row.observed); observed.commonGitDir = join(root, 'foreign.git');
          db.prepare('UPDATE worktree_creations SET observed=? WHERE task_id=?').run(JSON.stringify(observed), target.id);
        }
        if (scenario === 'wrong-plan-path') {
          const row = db.prepare('SELECT plan,observed FROM worktree_creations WHERE task_id=?').get(target.id) as { plan: string; observed: string };
          const plan = JSON.parse(row.plan); plan.path = join(root, 'foreign-worktree');
          const observed = JSON.parse(row.observed); observed.info.path = plan.path;
          db.prepare('UPDATE worktree_creations SET plan=?,observed=? WHERE task_id=?').run(JSON.stringify(plan), JSON.stringify(observed), target.id);
        }
        if (scenario === 'wrong-creation-base') {
          const row = db.prepare('SELECT plan,observed FROM worktree_creations WHERE task_id=?').get(earlier.id) as { plan: string; observed: string };
          const plan = JSON.parse(row.plan); plan.baseCommit = 'f'.repeat(40);
          const observed = JSON.parse(row.observed); observed.info.baseCommit = plan.baseCommit; observed.head = plan.baseCommit;
          db.prepare('UPDATE worktree_creations SET plan=?,observed=? WHERE task_id=?').run(JSON.stringify(plan), JSON.stringify(observed), earlier.id);
        }
        if (scenario === 'wrong-handoff') db.prepare('UPDATE task_sequence_steps SET effective_base_commit=? WHERE task_id=?').run('f'.repeat(40), target.id);
        if (scenario === 'missing-package') { db.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER review_packages_no_delete'); db.prepare('DELETE FROM review_packages WHERE task_id=?').run(earlier.id); }
        if (scenario === 'missing-result') { db.exec('DROP TRIGGER check_run_results_no_delete'); db.prepare('DELETE FROM check_run_results WHERE run_id IN (SELECT id FROM check_runs WHERE task_id=?)').run(earlier.id); }
        if (scenario.startsWith('wrong-run-')) {
          const field = { 'wrong-run-execution': 'execution_attempt_id', 'wrong-run-stage': 'execution_stage_id',
            'wrong-run-route': 'route_attempt_id', 'wrong-run-branch': 'branch_ref' }[scenario as 'wrong-run-execution' | 'wrong-run-stage' | 'wrong-run-route' | 'wrong-run-branch'];
          db.exec('PRAGMA foreign_keys=OFF');
          db.prepare(`UPDATE check_runs SET ${field}=? WHERE task_id=?`).run('foreign', earlier.id);
        }
        if (scenario === 'missing-check-completion') db.prepare("DELETE FROM events WHERE task_id=? AND type='check_run.completed'").run(earlier.id);
        if (scenario === 'wrong-check-completion') {
          const row = db.prepare("SELECT id,payload FROM events WHERE task_id=? AND type='check_run.completed'").get(earlier.id) as { id: number; payload: string };
          const payload = JSON.parse(row.payload); payload.results = [];
          db.prepare('UPDATE events SET payload=? WHERE id=?').run(JSON.stringify(payload), row.id);
        }
        if (scenario === 'wrong-report') {
          db.exec('DROP TRIGGER report_operations_guard_update');
          db.prepare('UPDATE report_operations SET report_bytes=? WHERE task_id=?').run(Buffer.from('{}'), earlier.id);
        }
        if (scenario === 'exhausted') db.prepare('UPDATE task_sequences SET max_goal_revisions=0').run();
      } finally { db.close(); }
      let store = new TaskStore(dbPath);
      try {
        const selected = scenario === 'foreign' ? 'foreign-task' : scenario === 'earlier' ? earlier.id : scenario.startsWith('missing-target') ? undefined : target.id;
        const review = finish(store, selected);
        assert.equal(review.result?.targetTaskId, selected);
        const submission = { repoPath: scenario === 'wrong-root' || scenario === 'missing-target-final-root' ? source.sequence.steps[3]!.task.repoPath : target.repoPath, baseRef: 'mutable-ref-is-ignored', prompt: 'Remediate A' };
        if (scenario !== 'valid') {
          assert.throws(() => store.appendSequenceGoalRevision(source.sequence.id, review.attemptId, submission, 'must-not-exist'), /target|identity|creation|lineage|handoff|authoritative|package|check|report|limit/i);
          assert.equal(store.get('must-not-exist'), undefined);
          assert.equal(store.getSequence(source.sequence.id)?.goalRevisionCount, 0);
          assert.equal(store.getSequence(source.sequence.id)?.steps.length, 4);
          return;
        }
        const built = buildGoalRevisionSubmission(store.getSequence(source.sequence.id)!, review);
        assert.deepEqual(built.acceptanceCriteria, ['Local step 2 remains valid']);
        assert.deepEqual(built.allowedPaths, ['step-0.txt', 'step-2.txt', 'proof.txt']);
        assert.deepEqual(built.checks?.map(check => check.argv), [target.checks![0]!.argv]);
        const revision = store.appendSequenceGoalRevision(source.sequence.id, review.attemptId, submission, 'target-revision');
        assert.equal(revision.sequenceBaseCommit, targetResult);
        assert.equal(store.getSequence(source.sequence.id)?.goalRevisionCount, 1);
        const competitor = new TaskStore(dbPath);
        try { assert.equal(competitor.appendSequenceGoalRevision(source.sequence.id, review.attemptId, submission, 'competing').id, revision.id); }
        finally { competitor.close(); }
        store.close(); store = new TaskStore(dbPath);
        assert.equal(store.appendSequenceGoalRevision(source.sequence.id, review.attemptId, submission, 'reopened').id, revision.id);
        assert.equal(store.getSequence(source.sequence.id)?.goalRevisionCount, 1);
        assert.equal(store.claimNext('remediation')?.sequenceBaseCommit, targetResult);
        const event = store.events(revision.id).find(event => event.type === 'task_sequence.goal_revision_appended');
        assert.equal((event?.payload as { targetTaskId?: string })?.targetTaskId, target.id);
      } finally { store.close(); }
    });
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('a divergent chain across linked roots of the same common directory cannot authorize remediation', async () => {
  const root = await mkdtemp(join(process.cwd(), '.zero-goal-divergent-target-'));
  try {
    const { dbPath, sequence } = await fixture(root, true);
    const store = new TaskStore(dbPath);
    try {
      const target = sequence.steps[2]!.task;
      const review = finish(store, target.id);
      assert.throws(() => store.appendSequenceGoalRevision(sequence.id, review.attemptId,
        { repoPath: target.repoPath, baseRef: 'main', prompt: 'Repair diverged group' }), /lineage|handoff|chain/i);
      assert.equal(store.getSequence(sequence.id)?.goalRevisionCount, 0);
    } finally { store.close(); }
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('aggregate target metadata rejects malformed values and targets on non-remediation verdicts', async () => {
  const root = await mkdtemp(join(process.cwd(), '.zero-goal-target-shape-'));
  const dbPath = join(root, 'tasks.sqlite');
  const store = new TaskStore(dbPath);
  try {
    const sequence = store.createSequence([{ repoPath: '.', baseRef: 'main', prompt: 'one' }, { repoPath: '.', baseRef: 'main', prompt: 'two' }], 'target-sequence', { objective: 'Goal' });
    // Only review persistence is under test; no target authorization is attempted.
    const db = new DatabaseSync(dbPath);
    try { db.prepare("UPDATE tasks SET status='done'").run(); } finally { db.close(); }
    const attempt = store.startSequenceGoalReview(sequence.id, 'a'.repeat(64), 'invalid-target');
    for (const targetTaskId of ['', '../bad', 'x'.repeat(129), 42]) {
      assert.throws(() => store.finishSequenceGoalReview({ attemptId: attempt.attemptId, verifiedEvidenceFingerprint: 'a'.repeat(64),
        result: { ...changes(), targetTaskId } as GoalReviewResult }), /valid|target/i);
    }
    assert.throws(() => store.finishSequenceGoalReview({ attemptId: attempt.attemptId, verifiedEvidenceFingerprint: 'a'.repeat(64),
      result: { verdict: 'pass', summary: 'Pass', findings: [], targetTaskId: sequence.steps[0]!.task.id } }), /valid|target/i);
    store.finishSequenceGoalReview({ attemptId: attempt.attemptId, verifiedEvidenceFingerprint: 'a'.repeat(64), result: changes(sequence.steps[1]!.task.id) });
    const tampered = new DatabaseSync(dbPath);
    try { tampered.prepare('UPDATE task_sequence_goal_reviews SET result=? WHERE attempt_id=?')
      .run(JSON.stringify({ ...changes(), targetTaskId: '../bad' }), attempt.attemptId); } finally { tampered.close(); }
    assert.throws(() => store.sequenceGoalReview(sequence.id), /valid|target/i);
    assert.throws(() => store.sequenceGoalReviewByAttempt(attempt.attemptId), /valid|target/i);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

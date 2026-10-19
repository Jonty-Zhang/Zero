import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { TaskStore, GoalReviewRetryConflictError, type SequenceGoalReviewRecord } from './task-store.js';
import type { GoalReviewResult } from '../domain/types.js';
import { buildGoalRevisionSubmission } from '../orchestrator/goal-revision.js';
import { buildGoalRevisionDraft, GoalRevisionCapacityError, MAX_GOAL_REVISION_PROMPT_CHARS } from '../domain/goal-revision.js';

const fingerprint = 'a'.repeat(64);
const at = new Date('2026-10-19T00:00:00.000Z');
const original: GoalReviewResult = { verdict: 'changes_requested', summary: 'Two issues need proof.', findings: [1, 2].map(i => ({ severity: 'medium' as const,
  evidence: `${i}`.repeat(3300), requestedChange: 'r'.repeat(3300) })) };
type NormalizeInput = { sequenceId: string; sourceAttemptId: string; evidenceFingerprint: string; expectedStepIds: string[] };
const normalize = (store: TaskStore, input: NormalizeInput, now?: Date) => (store as TaskStore & {
  normalizeSequenceGoalRevisionCapacity(input: NormalizeInput, now?: Date): SequenceGoalReviewRecord;
}).normalizeSequenceGoalRevisionCapacity(input, now);

async function fixture(run: (f: { store: TaskStore; db: string; id: string; ids: string[]; finish(result?: GoalReviewResult, verified?: string): SequenceGoalReviewRecord; legacy(): NormalizeInput }) => void | Promise<void>, cap = 2) {
  const root = await mkdtemp(join(process.cwd(), '.zero-capacity-')); const db = join(root, 'tasks.sqlite'); const store = new TaskStore(db);
  try {
    const sequence = store.createSequence([1, 2].map(i => ({ repoPath: '.', baseRef: 'main', prompt: `Complete step ${i}`, checks: [{ id: 'ok', argv: ['node', '--version'] }] })),
      'capacity', { objective: 'g'.repeat(10000), acceptanceCriteria: ['c'.repeat(4000)], maxGoalRevisions: cap });
    const ids = sequence.steps.map(s => s.task.id); const sql = new DatabaseSync(db); sql.exec("UPDATE tasks SET status='done'"); sql.close();
    const f = { store, db, id: sequence.id, ids,
      finish(result = original, verified = fingerprint) { const attempt = store.startSequenceGoalReview(sequence.id, fingerprint, undefined, at);
        return store.finishSequenceGoalReview({ attemptId: attempt.attemptId, result, verifiedEvidenceFingerprint: verified, now: at }); },
      legacy() { const review = this.finish({ ...original, findings: [{ severity: 'medium', evidence: 'Missing', requestedChange: 'Add proof' }] });
        const sql = new DatabaseSync(db); sql.prepare('UPDATE task_sequence_goal_reviews SET result=? WHERE attempt_id=?').run(JSON.stringify(original), review.attemptId); sql.close();
        return { sequenceId: sequence.id, sourceAttemptId: review.attemptId, evidenceFingerprint: fingerprint, expectedStepIds: ids }; } };
    await run(f);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
}

test('fresh finish independently normalizes capacity, preserving complete findings and provenance with no budget change', async () => {
  await fixture(f => {
    const result = { ...original, targetTaskId: f.ids[1] };
    const review = f.finish(result); assert.equal(review.result?.verdict, 'blocked'); assert.equal(review.result?.targetTaskId, undefined);
    assert.deepEqual(review.result?.findings, original.findings); assert.match(review.result!.summary, /24000/);
    const event = f.store.events(f.ids[0]!).find(e => e.type === 'task_sequence.goal_remediation_blocked');
    assert.deepEqual(event?.payload?.originalResult, result); assert.equal(event?.payload?.newAttemptId, review.attemptId);
    assert.equal(f.store.getSequence(f.id)?.goalRevisionCount, 0); assert.equal(f.store.getSequence(f.id)?.steps.length, 2);
    assert.ok(review.completedAt! >= review.createdAt); f.store.requestSequenceGoalReviewRetry(f.id, review.attemptId);
  });
});

test('pure builder capacity errors are typed and short controls retain the same findings', async () => {
  await fixture(f => {
    const sequence = f.store.getSequence(f.id)!; const review = { state: 'verdict', result: original } as SequenceGoalReviewRecord;
    assert.throws(() => buildGoalRevisionSubmission(sequence, review), error => error instanceof Error && error.name === 'GoalRevisionCapacityError');
    assert.ok(buildGoalRevisionSubmission({ ...sequence, objective: 'Goal', acceptanceCriteria: ['Proof'] }, review).prompt.length < 24000);
  });
});

test('evidence mismatch takes precedence over capacity; exhausted budget and invalid targets retain their contract', async () => {
  await fixture(f => { const review = f.finish(original, 'b'.repeat(64)); assert.match(review.result!.summary, /evidence changed/i);
    assert.equal(f.store.events(f.ids[0]!).filter(e => e.type === 'task_sequence.goal_remediation_blocked').length, 0); });
  await fixture(f => { assert.equal(f.finish().result?.verdict, 'changes_requested'); }, 0);
  await fixture(f => { assert.equal(f.finish({ ...original, targetTaskId: 'foreign' }).result?.verdict, 'changes_requested'); });
});

test('goal criteria alone can exceed draft capacity; no guarantee that shorter reviewer findings will fit', async () => {
  await fixture(f => { const db = new DatabaseSync(f.db); db.prepare('UPDATE task_sequences SET acceptance_criteria=?').run(JSON.stringify(Array(8).fill('c'.repeat(4000)))); db.close();
    const review = f.finish({ ...original, findings: [{ severity: 'medium', evidence: 'Missing', requestedChange: 'Add proof' }] });
    assert.equal(review.result?.verdict, 'blocked'); assert.doesNotMatch(review.result!.summary, /will fit|guarantee/i); });
});

test('legacy normalization appends one terminal blocked attempt across independent connection and reopen without editing source', async () => {
  await fixture(f => {
    const input = f.legacy(); const source = f.store.sequenceGoalReview(f.id)!;
    const other = new TaskStore(f.db);
    try { const fresh = normalize(other, input, at); assert.notEqual(fresh.attemptId, source.attemptId); assert.equal(fresh.result?.verdict, 'blocked');
      assert.equal(fresh.createdAt, '2026-10-19T00:00:00.001Z'); assert.ok(fresh.completedAt! >= fresh.createdAt);
      assert.deepEqual(other.sequenceGoalReviewByAttempt(source.attemptId), source);
      assert.throws(() => normalize(f.store, input), GoalReviewRetryConflictError);
      assert.throws(() => f.store.appendSequenceGoalRevision(f.id, source.attemptId, { repoPath: '.', baseRef: 'main', prompt: 'Stale remediation' }), GoalReviewRetryConflictError);
      assert.equal(f.store.getSequence(f.id)?.goalRevisionCount, 0); f.store.requestSequenceGoalReviewRetry(f.id, fresh.attemptId);
    } finally { other.close(); }
  });
});

for (const scenario of ['source', 'fingerprint', 'steps', 'incomplete', 'exhausted', 'buildable', 'linked-revision', 'running', 'quota', 'pass'] as const) {
  test(`legacy normalization rejects ${scenario} without a new verdict or budget mutation`, async () => {
    await fixture(f => {
      const input = f.legacy(); const db = new DatabaseSync(f.db);
      try {
        if (scenario === 'source') input.sourceAttemptId = 'foreign';
        if (scenario === 'fingerprint') input.evidenceFingerprint = 'b'.repeat(64);
        if (scenario === 'steps') input.expectedStepIds = [...input.expectedStepIds].reverse();
        if (scenario === 'incomplete') db.prepare("UPDATE tasks SET status='pending' WHERE id=?").run(f.ids[1]!);
        if (scenario === 'exhausted') db.exec('UPDATE task_sequences SET max_goal_revisions=0');
        if (scenario === 'buildable') db.prepare('UPDATE task_sequences SET objective=?,acceptance_criteria=?').run('Goal', '["Proof"]');
        if (scenario === 'linked-revision') db.prepare('INSERT INTO task_sequence_goal_revisions(sequence_id,review_attempt_id,task_id,created_at) VALUES(?,?,?,?)').run(f.id, input.sourceAttemptId, f.ids[1]!, at.toISOString());
        if (scenario === 'running' || scenario === 'quota') db.prepare('UPDATE task_sequence_goal_reviews SET state=?').run(scenario);
        if (scenario === 'pass') db.prepare('UPDATE task_sequence_goal_reviews SET result=?').run(JSON.stringify({ verdict: 'pass', summary: 'Approved', findings: [] }));
      } finally { db.close(); }
      const before = f.store.sequenceGoalReview(f.id); const count = f.store.getSequence(f.id)!.goalRevisionCount;
      assert.throws(() => normalize(f.store, input), GoalReviewRetryConflictError); assert.deepEqual(f.store.sequenceGoalReview(f.id), before);
      assert.equal(f.store.getSequence(f.id)!.goalRevisionCount, count);
    });
  });
}

test('fresh finish and legacy normalization roll back verdict and events when provenance insertion fails', async () => {
  for (const legacy of [false, true]) await fixture(f => {
    const input = legacy ? f.legacy() : undefined;
    const source = input ? f.store.sequenceGoalReview(f.id)! : f.store.startSequenceGoalReview(f.id, fingerprint, undefined, at);
    const db = new DatabaseSync(f.db); db.exec("CREATE TRIGGER reject_capacity_event BEFORE INSERT ON events WHEN NEW.type='task_sequence.goal_remediation_blocked' BEGIN SELECT RAISE(ABORT, 'injected IO failure'); END"); db.close();
    const events = f.store.events(f.ids[0]!);
    assert.throws(() => legacy ? normalize(f.store, input!) : f.store.finishSequenceGoalReview({ attemptId: source.attemptId, result: original, verifiedEvidenceFingerprint: fingerprint }), /injected IO/);
    assert.deepEqual(f.store.sequenceGoalReview(f.id), source); assert.deepEqual(f.store.events(f.ids[0]!), events);
  });
});

test('pure draft accepts the exact prompt boundary and returns structured capacity one character above it', async () => {
  await fixture(f => {
    const result: GoalReviewResult = { ...original, findings: [{ severity: 'medium', evidence: 'Missing', requestedChange: 'Add' }] };
    const sequence = { ...f.store.getSequence(f.id)!, objective: 'a', acceptanceCriteria: ['Proof'] };
    const baseLength = buildGoalRevisionDraft(sequence, result).prompt.length;
    sequence.objective = 'a'.repeat(MAX_GOAL_REVISION_PROMPT_CHARS - baseLength + 1);
    assert.equal(buildGoalRevisionDraft(sequence, result).prompt.length, MAX_GOAL_REVISION_PROMPT_CHARS);
    sequence.objective += 'a';
    assert.throws(() => buildGoalRevisionDraft(sequence, result), error => error instanceof GoalRevisionCapacityError
      && error.code === 'prompt_limit' && error.actual === 24001 && error.limit === 24000);
  });
});

test('all 100 findings and the original maximum-length summary and target survive normalization provenance', async () => {
  await fixture(f => {
    const result: GoalReviewResult = { verdict: 'changes_requested', targetTaskId: f.ids[1], summary: 's'.repeat(4000),
      findings: Array.from({ length: 100 }, () => ({ severity: 'medium', evidence: 'e'.repeat(130), requestedChange: 'r'.repeat(130) })) };
    const finished = f.finish(result); assert.equal(finished.result?.verdict, 'blocked'); assert.equal(finished.result?.findings.length, 100);
    assert.deepEqual(finished.result?.findings, result.findings); assert.ok(finished.result!.summary.length <= 4000);
    const event = f.store.events(f.ids[0]!).find(e => e.type === 'task_sequence.goal_remediation_blocked');
    assert.deepEqual(event?.payload?.originalResult, result);
  });
});

test('fresh finish cannot emit a verdict if a competing database guard suppresses its update', async () => {
  await fixture(f => {
    const attempt = f.store.startSequenceGoalReview(f.id, fingerprint); const events = f.store.events(f.ids[0]!);
    const db = new DatabaseSync(f.db); db.exec("CREATE TRIGGER suppress_goal_finish BEFORE UPDATE ON task_sequence_goal_reviews WHEN NEW.state='verdict' BEGIN SELECT RAISE(IGNORE); END"); db.close();
    assert.throws(() => f.store.finishSequenceGoalReview({ attemptId: attempt.attemptId, result: original, verifiedEvidenceFingerprint: fingerprint }), GoalReviewRetryConflictError);
    assert.equal(f.store.sequenceGoalReview(f.id)?.state, 'running'); assert.deepEqual(f.store.events(f.ids[0]!), events);
  });
});

test('simultaneous independent SQLite schedulers normalize one legacy source exactly once', async () => {
  await fixture(async f => {
    const input = f.legacy();
    const workers = [1, 2].map(() => new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => { const { TaskStore } = await import(workerData.module); const store = new TaskStore(workerData.db);
        parentPort.postMessage('ready'); parentPort.once('message', () => {
          try { const result = store.normalizeSequenceGoalRevisionCapacity(workerData.input, new Date(workerData.at)); parentPort.postMessage({ result: result.attemptId }); }
          catch (error) { parentPort.postMessage({ error: error.name }); }
          finally { store.close(); parentPort.close(); }
        });
      })().catch(error => { parentPort.postMessage({ error: error.message }); parentPort.close(); });
    `, { eval: true, workerData: { module: new URL('./task-store.js', import.meta.url).href, db: f.db, input, at: at.toISOString() } }));
    try {
      assert.deepEqual(await Promise.all(workers.map(w => once(w, 'message'))), [['ready'], ['ready']]);
      const replies = workers.map(w => once(w, 'message')); workers.forEach(w => w.postMessage('start'));
      const results = (await Promise.all(replies)).map(reply => reply[0] as { result?: string; error?: string });
      assert.equal(results.filter(r => r.result).length, 1); assert.equal(results.filter(r => r.error === 'GoalReviewRetryConflictError').length, 1);
      assert.equal(f.store.events(f.ids[0]!).filter(e => e.type === 'task_sequence.goal_remediation_blocked').length, 1);
    } finally { await Promise.all(workers.map(w => w.terminate())); }
  });
});

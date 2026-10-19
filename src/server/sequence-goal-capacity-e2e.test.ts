import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../core/task-store.js';
import { GitWorktreeManager } from '../core/git-worktree.js';
import { TestRunner } from '../core/test-runner.js';
import { TaskWorker } from '../orchestrator/worker.js';
import type { HarnessAdapter, GoalReviewResult } from '../domain/types.js';
import { createZeroServer } from './server.js';
import { createSequenceGoalReviewScheduler } from './main.js';
import { captureSequenceGoalEvidence } from './sequence-goal-evidence.js';

const exec = promisify(execFile);
const objective = 'Implement the detailed product requirements. '.repeat(240).slice(0, 10000);
const criteria = ['Required visible proof for each behavior. '.repeat(110).slice(0, 4000)];
const long: GoalReviewResult = { verdict: 'changes_requested', summary: 'Two requirements need proof.', findings: [1, 2].map(i => ({ severity: 'medium', evidence: `${i}`.repeat(3300), requestedChange: 'r'.repeat(3300) })) };
const concise: GoalReviewResult = { verdict: 'changes_requested', summary: 'Add visible proof.', findings: [{ severity: 'medium', evidence: 'Proof missing.', requestedChange: 'Add proof.' }] };
const cfg = { models: [], bindings: [], allocator: { modelId: null, reasoningEffort: null }, reviewer: { modelId: null, reasoningEffort: null }, verifications: {} };
let base: { root: string; db: string; id: string; worktreeRoot: string };
async function serve(store: TaskStore) {
  const server = createZeroServer({ store, config: { async read() { return cfg; }, async write() { throw new Error('read only fixture'); } }, adapters: {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}`, async close() { await new Promise<void>(done => server.close(() => done())); } };
}
const adapter: HarnessAdapter = { id: 'fake', async probe() { return { harness: 'fake', available: true, models: ['fixture'] }; },
  async run(request) { await writeFile(join(request.cwd, request.taskId + '.txt'), 'approved\n'); return { status: 'completed', exitCode: 0, durationMs: 1 }; } };
function worker(store: TaskStore, worktrees: GitWorktreeManager, artifacts: string) {
  return new TaskWorker({ store, worktrees, testRunner: new TestRunner({ logDirectory: join(artifacts, 'checks') }),
    router: { async route(task) { return { taskId: task.id, harness: 'fake', model: 'fixture', selectionSource: 'codex', reason: 'fixture', decidedAt: new Date().toISOString() }; } },
    reviewer: { async review() { return { harness: 'codex', model: 'per-task-fixture', exitCode: 0, result: { verdict: 'pass', summary: 'Approved', findings: [] } }; } },
    adapters: new Map([['fake', adapter]]), artifactRoot: artifacts });
}
before(async () => {
  const root = await mkdtemp(join(process.cwd(), '.zero-capacity-e2e-')); const repo = join(root, 'repo'); await mkdir(repo);
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) await exec('git', args, { cwd: repo, windowsHide: true });
  await writeFile(join(repo, 'seed.txt'), 'base\n'); await exec('git', ['add', '.'], { cwd: repo }); await exec('git', ['commit', '-m', 'fixture'], { cwd: repo });
  const db = join(root, 'source.sqlite'); const store = new TaskStore(db); const http = await serve(store);
  try {
    const response = await fetch(http.url + '/api/sequences', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      objective, acceptanceCriteria: criteria, maxGoalRevisions: 2, tasks: [1, 2].map(i => ({ repoPath: repo, baseRef: 'main', prompt: `Write approved file ${i}`, checkCommands: ['node --version'] })),
    }) });
    const created = await response.json() as { id: string }; assert.equal(response.status, 201);
    const worktreeRoot = join(root, 'worktrees'); const w = worker(store, new GitWorktreeManager(worktreeRoot), join(root, 'artifacts'));
    for (const step of store.getSequence(created.id)!.steps) { assert.equal(store.claimNext('worker')?.id, step.task.id); const done = await w.runClaimed(step.task.id, 'worker'); assert.equal(done.status, 'done', done.failureReason); }
    base = { root, db, id: created.id, worktreeRoot };
  } finally { await http.close(); store.close(); }
});
after(async () => { if (base) await rm(base.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

async function context(name: string) {
  const db = join(base.root, name + '.sqlite'); await copyFile(base.db, db); const store = new TaskStore(db);
  const worktrees = new GitWorktreeManager(base.worktreeRoot); const artifacts = join(base.root, name); let calls = 0; let result = long;
  const codex: HarnessAdapter = { id: 'codex', async probe() { return { harness: 'codex', available: true, models: ['review'], reasoningEfforts: [] }; },
    async run() { calls++; return { status: 'completed', exitCode: 0, durationMs: 1,
      final: JSON.stringify({ ...result, findings: result.findings.map(finding => ({ ...finding, file: finding.file ?? null, line: finding.line ?? null })) }) }; } };
  const scheduler = () => createSequenceGoalReviewScheduler({ store, worktrees, codex, artifactRoot: artifacts, readReviewerConfig: async () => ({}) });
  return { store, db, worktrees, artifacts, codex, scheduler, get calls() { return calls; }, set result(value: GoalReviewResult) { result = value; } };
}

test('real HTTP long goal normalizes blocked then explicit retry and concise findings append one authoritative remediation without losing criteria', async () => {
  const c = await context('retry'); const http = await serve(c.store);
  try {
    await c.scheduler()(); const blocked = c.store.getSequence(base.id)!;
    assert.equal(blocked.goalReview?.result?.verdict, 'blocked'); assert.match(blocked.goalReview!.result!.summary, /24000/); assert.deepEqual(blocked.goalReview!.result!.findings, long.findings);
    assert.equal(blocked.goalRevisionCount, 0); await c.scheduler()(); assert.equal(c.calls, 1);
    const response = await fetch(`${http.url}/api/sequences/${base.id}/goal-review/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ attemptId: blocked.goalReview!.attemptId }) });
    assert.equal(response.status, 202); c.result = concise; await c.scheduler()(); await c.scheduler()();
    const sequence = c.store.getSequence(base.id)!; assert.equal(sequence.goalRevisionCount, 1); assert.equal(sequence.steps.length, 3);
    const remediation = sequence.steps[2]!.task; assert.deepEqual(remediation.acceptanceCriteria, criteria);
    assert.ok(remediation.prompt.includes(objective.trim())); assert.ok(remediation.prompt.includes(criteria[0]!));
    const prior = c.store.commitOperations(sequence.steps[1]!.task.id).find(op => op.status === 'applied')!;
    assert.equal(remediation.sequenceBaseCommit, prior.candidateSha); assert.equal(c.store.claimNext('remediate')?.id, remediation.id);
    const done = await worker(c.store, c.worktrees, c.artifacts).runClaimed(remediation.id, 'remediate'); assert.equal(done.status, 'done', done.failureReason);
    c.result = { verdict: 'pass', summary: 'Complete', findings: [] }; await c.scheduler()();
    assert.equal(c.store.getSequence(base.id)?.status, 'completed'); assert.equal(c.calls, 3);
  } finally { await http.close(); c.store.close(); }
});

test('cached legacy changes_requested normalizes after reopen without a provider call and retains original history', async () => {
  const c = await context('legacy');
  try {
    const evidence = await captureSequenceGoalEvidence(c.store, c.worktrees, c.store.getSequence(base.id)!, c.artifacts);
    const attempt = c.store.startSequenceGoalReview(base.id, evidence.fingerprint);
    c.store.finishSequenceGoalReview({ attemptId: attempt.attemptId, result: concise, verifiedEvidenceFingerprint: evidence.fingerprint });
    const sql = new DatabaseSync(c.db); sql.prepare('UPDATE task_sequence_goal_reviews SET result=? WHERE attempt_id=?').run(JSON.stringify(long), attempt.attemptId); sql.close();
    c.store.close(); const reopened = new TaskStore(c.db);
    try {
      const scheduler = createSequenceGoalReviewScheduler({ store: reopened, worktrees: c.worktrees, artifactRoot: c.artifacts,
        codex: { id: 'codex', async probe() { throw new Error('No provider probe'); }, async run() { throw new Error('No provider run'); } }, readReviewerConfig: async () => ({}) });
      await scheduler(); assert.equal(reopened.sequenceGoalReview(base.id)?.result?.verdict, 'blocked');
      assert.deepEqual(reopened.sequenceGoalReviewByAttempt(attempt.attemptId)?.result, long); assert.equal(reopened.getSequence(base.id)?.goalRevisionCount, 0);
      await scheduler(); assert.equal(reopened.events(reopened.getSequence(base.id)!.steps[0]!.task.id).filter(e => e.type === 'task_sequence.goal_remediation_blocked').length, 1);
    } finally { reopened.close(); }
  } finally { try { c.store.close(); } catch { /* already closed for reopen */ } }
});

test('transient and unknown append failures retain changes_requested and backoff; a later successful append consumes one budget', async () => {
  for (const failure of [new Error('SQLite busy'), new Error('unknown IO mentioning 24000')]) {
    const c = await context('transient-' + failure.message.length);
    try {
      c.result = concise; await c.scheduler()(); const source = c.store.sequenceGoalReview(base.id)!;
      const append = c.store.appendSequenceGoalRevision.bind(c.store); let attempts = 0;
      c.store.appendSequenceGoalRevision = () => { attempts++; throw failure; };
      const tick = c.scheduler(); await tick(); await tick(); assert.equal(attempts, 1);
      assert.deepEqual(c.store.sequenceGoalReview(base.id), source); assert.equal(c.store.getSequence(base.id)?.goalRevisionCount, 0);
      assert.equal(c.store.events(c.store.getSequence(base.id)!.steps[0]!.task.id).filter(e => e.type === 'task_sequence.goal_remediation_blocked').length, 0);
      c.store.appendSequenceGoalRevision = append; await c.scheduler()(); assert.equal(c.store.getSequence(base.id)?.goalRevisionCount, 1); assert.equal(c.calls, 1);
    } finally { c.store.close(); }
  }
});

test('scheduler propagates capacity provenance persistence failure without replacing the original review, and restart recovers without an automatic provider loop', async () => {
  const c = await context('fresh-finish-IO');
  try {
    const sql = new DatabaseSync(c.db); sql.exec("CREATE TRIGGER reject_capacity_event BEFORE INSERT ON events WHEN NEW.type='task_sequence.goal_remediation_blocked' BEGIN SELECT RAISE(ABORT, 'injected capacity IO'); END"); sql.close();
    const tick = c.scheduler();
    await assert.rejects(tick(), /injected capacity IO/);
    const source = c.store.sequenceGoalReview(base.id)!;
    assert.equal(source.state, 'running'); assert.equal(source.result, undefined); assert.equal(c.calls, 1);
    assert.equal(c.store.getSequence(base.id)?.goalRevisionCount, 0);
    const firstTask = c.store.getSequence(base.id)!.steps[0]!.task.id;
    assert.equal(c.store.events(firstTask).filter(e => e.type === 'task_sequence.goal_review_verdict' || e.type === 'task_sequence.goal_remediation_blocked').length, 0);
    await tick(); await c.scheduler()(); assert.equal(c.calls, 1, 'the same running attempt cannot trigger an automatic repeated provider call');
    const repaired = new DatabaseSync(c.db); repaired.exec('DROP TRIGGER reject_capacity_event'); repaired.close();
    c.store.close(); const reopened = new TaskStore(c.db);
    try {
      const recovered = createSequenceGoalReviewScheduler({ store: reopened, worktrees: c.worktrees, codex: c.codex,
        artifactRoot: c.artifacts, readReviewerConfig: async () => ({}) });
      await recovered(); const current = reopened.sequenceGoalReview(base.id)!;
      assert.equal(current.result?.verdict, 'blocked'); assert.deepEqual(current.result?.findings, long.findings);
      assert.equal(reopened.sequenceGoalReviewByAttempt(source.attemptId)?.state, 'running', 'never rewrite the rolled-back original attempt');
      assert.equal(reopened.getSequence(base.id)?.goalRevisionCount, 0); assert.equal(c.calls, 2);
      await recovered(); assert.equal(c.calls, 2, 'a new terminal blocked review needs explicit user retry');
      const event = reopened.events(firstTask).find(e => e.type === 'task_sequence.goal_remediation_blocked');
      assert.deepEqual(event?.payload?.originalResult, long);
    } finally { reopened.close(); }
  } finally { try { c.store.close(); } catch { /* closed for restart */ } }
});

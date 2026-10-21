import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from './task-store.js';
import type { TaskRecord } from '../domain/types.js';

interface Request { taskId: string; owner: string; generationId: string; requestedAt: string; claimEventId: number }
type CancellationStore = TaskStore & {
  requestTaskCancellation(id: string, owner: string, generation: string, now?: Date): Request;
  getTaskCancellation(id: string): Request | undefined;
  listTaskCancellations(): Request[];
  finishTaskCancellation(id: string, owner: string, generation: string, now?: Date): TaskRecord | undefined;
  finishDrainedTaskCancellation(id: string, now?: Date): TaskRecord | undefined;
};
const guardian = (id: string) => ({ id: id.repeat(32), lockId: 'd'.repeat(64), predecessorDrained: true, evidenceKind: 'guardian_startup_verified' as const });
async function fixture(run: (f: { root: string; db: string; store: CancellationStore; task: TaskRecord; generation: string; owner: string; restart(verified?: boolean): CancellationStore }) => Promise<void>) {
  const root = await mkdtemp(join(process.cwd(), '.zero-task-cancel-')); const db = join(root, 'tasks.sqlite');
  let store = new TaskStore(db, guardian('1')) as CancellationStore; let generation = 1;
  const owner = 'source-owner'; const task = store.submit({ repoPath: join(root, 'repo'), baseRef: 'main', prompt: 'A cancellable local task', maxRevisions: 2 });
  store.claimNext(owner);
  const f = { root, db, get store() { return store; }, task, generation: '1'.repeat(32), owner,
    restart(verified = true) { store.close(); generation++; store = new TaskStore(db, verified ? guardian(String(generation)) : { id: String(generation).repeat(32), predecessorDrained: false, evidenceKind: 'unguarded' }) as CancellationStore; return store; } };
  try { await run(f); } finally {
    store.close(); const actual = await realpath(root);
    assert.equal(dirname(actual), await realpath(process.cwd())); assert.ok(basename(actual).startsWith('.zero-task-cancel-'));
    await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
const conflict = (error: unknown) => error instanceof Error && error.name === 'TaskCancellationConflictError';

test('durable cancellation acceptance is idempotent and binds the exact live claim event', async () => fixture(async f => {
  const request = f.store.requestTaskCancellation(f.task.id, f.owner, f.generation);
  assert.equal(request.taskId, f.task.id); assert.equal(request.owner, f.owner); assert.equal(request.generationId, f.generation);
  const claim = f.store.events(f.task.id).find(e => e.id === request.claimEventId);
  assert.equal(claim?.type, 'task.claimed'); assert.equal(claim?.payload?.owner, f.owner);
  assert.deepEqual(f.store.requestTaskCancellation(f.task.id, f.owner, f.generation), request);
  assert.equal(f.store.events(f.task.id).filter(e => e.type === 'task.cancel_requested').length, 1);
  const connection = new DatabaseSync(f.db); try { assert.equal((connection.prepare('SELECT COUNT(*) AS n FROM task_cancellation_requests').get() as {n: number}).n, 1); } finally { connection.close(); }
  const reopened = f.restart(); assert.deepEqual(reopened.getTaskCancellation(f.task.id), request);
  assert.throws(() => reopened.requestTaskCancellation(f.task.id, f.owner, f.generation), conflict, 'a different current startup cannot accept a stale live claim');
}));

test('cancellation rejects stale owner, generation and expired lease without writing an intent', async () => fixture(async f => {
  assert.throws(() => f.store.requestTaskCancellation(f.task.id, 'foreign', f.generation), conflict);
  assert.throws(() => f.store.requestTaskCancellation(f.task.id, f.owner, '2'.repeat(32)), conflict);
  assert.throws(() => f.store.requestTaskCancellation(f.task.id, f.owner, f.generation, new Date(Date.now() + 120000)), conflict);
  assert.equal(f.store.getTaskCancellation(f.task.id), undefined);
}));

test('latest claimed event wins even within one millisecond and matching older claims cannot authorize cancellation', async () => fixture(async f => {
  const first = f.store.events(f.task.id).filter(e => e.type === 'task.claimed').at(-1)!;
  const sql = new DatabaseSync(f.db); try {
    const same = sql.prepare('INSERT INTO events(task_id,type,at,payload) VALUES(?,?,?,?)').run(f.task.id, 'task.claimed', first.at, JSON.stringify({owner: f.owner, generationId: f.generation}));
    const request = f.store.requestTaskCancellation(f.task.id, f.owner, f.generation);
    assert.equal(request.claimEventId, Number(same.lastInsertRowid)); assert.ok(request.claimEventId > first.id);
  } finally { sql.close(); }
}));

test('a later nonmatching claim event rejects acceptance rather than selecting an older matching claim', async () => fixture(async f => {
  const first = f.store.events(f.task.id).filter(e => e.type === 'task.claimed').at(-1)!; const sql = new DatabaseSync(f.db);
  try { sql.prepare('INSERT INTO events(task_id,type,at,payload) VALUES(?,?,?,?)').run(f.task.id, 'task.claimed', first.at, JSON.stringify({owner: 'later-owner', generationId: f.generation}));
    assert.throws(() => f.store.requestTaskCancellation(f.task.id, f.owner, f.generation), conflict); assert.equal(f.store.getTaskCancellation(f.task.id), undefined);
  } finally { sql.close(); }
}));

test('acceptance event failure rolls back intent and never manufactures accepted cancellation', async () => fixture(async f => {
  const connection = new DatabaseSync(f.db);
  try { connection.exec("CREATE TRIGGER reject_cancel_request BEFORE INSERT ON events WHEN NEW.type='task.cancel_requested' BEGIN SELECT RAISE(ABORT,'cancel event unavailable'); END;");
    assert.throws(() => f.store.requestTaskCancellation(f.task.id, f.owner, f.generation), /cancel event unavailable/);
    assert.equal(f.store.getTaskCancellation(f.task.id), undefined); assert.equal(f.store.get(f.task.id)?.status, 'running');
    connection.exec('DROP TRIGGER reject_cancel_request');
    assert.ok(f.store.requestTaskCancellation(f.task.id, f.owner, f.generation));
  } finally { connection.close(); }
}));

test('intent blocks new work while heartbeat and current attempt/stage stop facts remain allowed', async () => fixture(async f => {
  const stage = f.store.createStage(f.task.id, { role: 'implement', processStartId: 'current-child', harness: 'fake' });
  f.store.startStage(stage.id, f.owner, 'current-child');
  const attempt = f.store.createAttempt(f.task.id, 'implement', { stageId: stage.id, owner: f.owner, harness: 'fake' });
  f.store.requestTaskCancellation(f.task.id, f.owner, f.generation);
  assert.equal(f.store.heartbeat(f.task.id, f.owner, 60000), true);
  assert.throws(() => f.store.createStage(f.task.id, { role: 'implement', processStartId: 'new-child' }), conflict);
  assert.throws(() => f.store.createAttempt(f.task.id, 'route', { owner: f.owner }), conflict);
  assert.throws(() => f.store.transition(f.task.id, 'running', 'revision', { owner: f.owner, incrementRevision: true }), conflict);
  assert.equal(f.store.get(f.task.id)?.revisionCount, 0, 'cancellation must not consume a revision before a later guard');
  f.store.finishAttempt(attempt.id, { status: 'interrupted', error: 'stopped' }, { owner: f.owner, processStartId: 'current-child' });
  f.store.finishStage(stage.id, f.owner, 'current-child', 'interrupted');
  const result = f.store.finishTaskCancellation(f.task.id, f.owner, f.generation);
  assert.equal(result?.status, 'failed'); assert.equal(result?.failureReason, 'Cancelled by user');
  assert.equal(result?.revisionCount, 0); assert.equal(f.store.stages(f.task.id)[0]?.status, 'interrupted');
  assert.equal(f.store.getTaskCancellation(f.task.id)?.owner, f.owner);
}));

test('terminal cancellation rolls back on event failure and cannot use expired custody', async () => fixture(async f => {
  f.store.requestTaskCancellation(f.task.id, f.owner, f.generation);
  assert.equal(f.store.finishTaskCancellation(f.task.id, 'foreign', f.generation), undefined);
  assert.equal(f.store.finishTaskCancellation(f.task.id, f.owner, '2'.repeat(32)), undefined);
  assert.equal(f.store.finishTaskCancellation(f.task.id, f.owner, f.generation, new Date(Date.now() + 120000)), undefined);
  const connection = new DatabaseSync(f.db); try {
    connection.exec("CREATE TRIGGER reject_cancel_finish BEFORE INSERT ON events WHEN NEW.type='task.cancelled' BEGIN SELECT RAISE(ABORT,'cancel terminal unavailable'); END;");
    assert.throws(() => f.store.finishTaskCancellation(f.task.id, f.owner, f.generation), /cancel terminal unavailable/);
    assert.equal(f.store.get(f.task.id)?.status, 'running'); assert.ok(f.store.getTaskCancellation(f.task.id));
    connection.exec('DROP TRIGGER reject_cancel_finish');
    assert.equal(f.store.finishTaskCancellation(f.task.id, f.owner, f.generation)?.status, 'failed');
  } finally { connection.close(); }
}));

test('only proven-drained restart can finish an accepted cancellation after worker crash', async () => fixture(async f => {
  const stage = f.store.createStage(f.task.id, { role: 'implement', processStartId: 'crashed-child' }); f.store.startStage(stage.id, f.owner, 'crashed-child');
  f.store.createAttempt(f.task.id, 'implement', { owner: f.owner, stageId: stage.id });
  f.store.requestTaskCancellation(f.task.id, f.owner, f.generation);
  f.store.recoverExpired(new Date(Date.now() + 120000));
  assert.equal(f.store.finishDrainedTaskCancellation(f.task.id), undefined, 'same generation is not proof of drain');
  const restarted = f.restart();
  assert.equal(restarted.finishDrainedTaskCancellation(f.task.id)?.status, 'failed');
  assert.equal(restarted.attempts(f.task.id).at(-1)?.status, 'interrupted');
  assert.equal(restarted.claimNext('must-not-replay'), undefined);
}));

test('unguarded restart and forged lease-expiry source owner cannot finalize cancellation', async () => fixture(async f => {
  f.store.requestTaskCancellation(f.task.id, f.owner, f.generation); f.store.recoverExpired(new Date(Date.now() + 120000));
  const restarted = f.restart(false); assert.equal(restarted.finishDrainedTaskCancellation(f.task.id), undefined);
  const guarded = f.restart(); const connection = new DatabaseSync(f.db);
  try { const row = connection.prepare('SELECT recovery_evidence FROM tasks WHERE id=?').get(f.task.id) as {recovery_evidence: string}; const evidence = JSON.parse(row.recovery_evidence);
    evidence.leaseOwner = 'forged-source'; connection.prepare('UPDATE tasks SET recovery_evidence=? WHERE id=?').run(JSON.stringify(evidence), f.task.id);
    assert.equal(guarded.finishDrainedTaskCancellation(f.task.id), undefined); assert.equal(guarded.get(f.task.id)?.status, 'recovery_required');
  } finally { connection.close(); }
}));

test('durable cancellation survives a failed drained finalization and another fully verified guardian restart', async () => fixture(async f => {
  f.store.requestTaskCancellation(f.task.id, f.owner, f.generation); f.store.recoverExpired(new Date(Date.now() + 120000));
  f.restart(); const sql = new DatabaseSync(f.db);
  try { sql.exec("CREATE TRIGGER reject_cancel_finish BEFORE INSERT ON events WHEN NEW.type='task.cancelled' BEGIN SELECT RAISE(ABORT,'first guardian database fault'); END;");
    assert.throws(() => f.store.finishDrainedTaskCancellation(f.task.id), /first guardian database fault/);
    assert.equal(f.store.get(f.task.id)?.status, 'recovery_required'); sql.exec('DROP TRIGGER reject_cancel_finish');
    f.restart(); assert.equal(f.store.currentStartupProvesGenerationDrained(f.generation), false, 'the source is no longer the direct predecessor');
    assert.equal(f.store.finishDrainedTaskCancellation(f.task.id)?.status, 'failed', 'the complete verified A→B→C lineage still proves source drain');
  } finally { sql.close(); }
}));

test('drained terminal cancellation clears current recovery hints and preserves their historical evidence', async () => fixture(async f => {
  f.store.requestTaskCancellation(f.task.id, f.owner, f.generation);
  f.store.recoverExpired(new Date(Date.now() + 120000));
  const before = f.store.get(f.task.id)!;
  assert.ok(before.recoveryReason); assert.equal(before.recoveryEvidence?.kind, 'lease_expiry');
  f.restart(); const result = f.store.finishDrainedTaskCancellation(f.task.id)!;
  assert.equal(result.status, 'failed'); assert.equal(result.failureReason, 'Cancelled by user');
  assert.equal(result.recoveryReason, undefined); assert.equal(result.recoveryEvidence, undefined);
  const cancelled = f.store.events(f.task.id).find(event => event.type === 'task.cancelled')!;
  assert.equal(cancelled.payload?.recoveryReason, before.recoveryReason);
  assert.deepEqual(cancelled.payload?.recoveryEvidence, before.recoveryEvidence);
}));

test('accepted cancellation cannot be stranded by a later worktree recovery quarantine', async () => fixture(async f => {
  f.store.recordWorktreeCreationIntent(f.task.id, f.owner, { fixture: true });
  f.store.requestTaskCancellation(f.task.id, f.owner, f.generation);
  assert.throws(() => f.store.requireWorktreeRecovery(f.task.id, f.owner, 'Worktree operation failed'), conflict);
  assert.equal(f.store.get(f.task.id)?.status, 'running');
  assert.equal(f.store.getWorktreeCreation(f.task.id)?.status, 'intent');
  f.restart(); assert.equal(f.store.finishDrainedTaskCancellation(f.task.id)?.status, 'failed');
}));

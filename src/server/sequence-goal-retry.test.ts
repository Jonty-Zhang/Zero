import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { ReviewResult } from '../domain/types.js';
import { TaskStore } from '../core/task-store.js';
import { createZeroServer, type ZeroServerOptions } from './server.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zero-goal-retry-http-'));
  const dbPath = join(root, 'tasks.sqlite');
  const store = new TaskStore(dbPath);
  const sequence = store.createSequence([
    { repoPath: root, baseRef: 'main', prompt: 'Complete first step' },
    { repoPath: root, baseRef: 'main', prompt: 'Complete second step' },
  ], 'retry-http-sequence', { objective: 'Complete both steps', maxGoalRevisions: 0 });
  // HTTP/store contract fixture. Real Git completion gates are exercised by the
  // separate scheduler integration tests; no provider or worker runs here.
  const db = new DatabaseSync(dbPath);
  try { for (const step of sequence.steps) db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(step.task.id); }
  finally { db.close(); }
  const fingerprint = 'a'.repeat(64);
  const review = store.startSequenceGoalReview(sequence.id, fingerprint, 'source-review');
  store.finishSequenceGoalReview({ attemptId: review.attemptId, verifiedEvidenceFingerprint: fingerprint,
    result: { verdict: 'blocked', summary: 'Temporary reviewer failure', findings: [] } });
  let nudges = 0;
  const options = { store, config: { async read() { throw new Error('Configuration is not used by retry HTTP requests'); }, async write() {} },
    enqueueGoalReview: () => { nudges++; } };
  const server = createZeroServer(options);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/sequences`;
  const post = (id: string, body: unknown) => fetch(`${base}/${encodeURIComponent(id)}/goal-review/retry`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { root, dbPath, store, sequence, review, options, base, post, nudges: () => nudges,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}

test('concurrent HTTP retry requests persist one queue item and retain the blocked verdict', async () => {
  const f = await fixture();
  try {
    const responses = await Promise.all(Array.from({ length: 4 }, () => f.post(f.sequence.id, { attemptId: f.review.attemptId })));
    for (const response of responses) assert.equal(response.status, 202, await response.text());
    const body = await (await fetch(`${f.base}/${f.sequence.id}`)).json() as {
      status: string; goalRevisionCount: number; goalReview: { attemptId: string; retryRequestedAt?: string; result: ReviewResult };
    };
    assert.equal(body.status, 'blocked');
    assert.equal(body.goalRevisionCount, 0);
    assert.equal(body.goalReview.attemptId, f.review.attemptId);
    assert.ok(body.goalReview.retryRequestedAt);
    assert.equal(body.goalReview.result.summary, 'Temporary reviewer failure');
    const requests = f.store.events(f.sequence.steps[0]!.task.id).filter(event => event.type === 'task_sequence.goal_review_retry_requested');
    assert.equal(requests.length, 1);
    assert.ok(f.nudges() >= 1);
    const repeated = await f.post(f.sequence.id, { attemptId: f.review.attemptId });
    assert.equal(repeated.status, 202);
    assert.equal(f.store.events(f.sequence.steps[0]!.task.id).filter(event => event.type === 'task_sequence.goal_review_retry_requested').length, 1);
  } finally { await f.close(); }
});

test('retry HTTP rejects invalid input, unknown sequences and stale review IDs without queuing', async () => {
  const f = await fixture();
  try {
    for (const input of [{}, null, [], { attemptId: 5 }, { attemptId: '' }, { attemptId: f.review.attemptId, extra: true }]) {
      const response = await f.post(f.sequence.id, input);
      assert.equal(response.status, 400, await response.text());
    }
    assert.equal((await f.post('missing', { attemptId: f.review.attemptId })).status, 404);
    assert.equal((await f.post(f.sequence.id, { attemptId: 'stale-review' })).status, 409);
    assert.equal(f.nudges(), 0);
    assert.equal(f.store.events(f.sequence.steps[0]!.task.id).filter(event => event.type === 'task_sequence.goal_review_retry_requested').length, 0);
  } finally { await f.close(); }
});

test('retry does not bypass active, quota, successful or changes-requested reviews', async () => {
  for (const state of ['running', 'quota', 'pass', 'changes_requested'] as const) {
    const f = await fixture();
    try {
      const next = f.store.startSequenceGoalReview(f.sequence.id, 'b'.repeat(64), `next-${state}`);
      if (state === 'quota') f.store.finishSequenceGoalReview({ attemptId: next.attemptId, retryAt: new Date(Date.now() + 60000).toISOString() });
      else if (state !== 'running') f.store.finishSequenceGoalReview({ attemptId: next.attemptId, verifiedEvidenceFingerprint: 'b'.repeat(64),
        result: { verdict: state, summary: state, findings: state === 'changes_requested' ? [{ severity: 'medium', evidence: 'Missing result', requestedChange: 'Fix the result' }] : [] } });
      assert.equal((await f.post(f.sequence.id, { attemptId: next.attemptId })).status, 409, state);
      assert.equal(f.nudges(), 0);
    } finally { await f.close(); }
  }
});

test('scheduler nudge failures do not undo an accepted retry or fail completed tasks', async () => {
  const f = await fixture();
  try {
    f.options.enqueueGoalReview = () => { throw new Error('Transient nudge failure'); };
    const response = await f.post(f.sequence.id, { attemptId: f.review.attemptId });
    assert.equal(response.status, 202, await response.text());
    const detail = await (await fetch(`${f.base}/${f.sequence.id}`)).json() as { goalReview: { retryRequestedAt?: string }; steps: Array<{ task: { status: string } }> };
    assert.ok(detail.goalReview.retryRequestedAt);
    assert.ok(detail.steps.every(step => step.task.status === 'done'));
  } finally { await f.close(); }
});

test('custom store ports explicitly reject retry when durable request support is absent', async () => {
  const f = await fixture();
  try {
    const customStore = new Proxy(f.store, { get(target, key) {
      if (key === 'requestSequenceGoalReviewRetry') return undefined;
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const server = createZeroServer({ ...f.options, store: customStore } as ZeroServerOptions);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); assert.ok(address && typeof address !== 'string');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/sequences/${f.sequence.id}/goal-review/retry`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ attemptId: f.review.attemptId }),
      });
      assert.equal(response.status, 501);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  } finally { await f.close(); }
});

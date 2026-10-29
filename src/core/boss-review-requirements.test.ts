import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BossMessageConflictError, TaskStore } from './task-store.js';
import type { BossMessage, RouteDecision } from '../domain/types.js';
import { assertReviewRequirements } from '../domain/review-requirements.js';

function fixture(path = ':memory:', boss = true, reasoningEffort?: string) {
  const store = new TaskStore(path);
  const checks = [{ id: 'unit', argv: ['node', 'test.js'] }];
  const task = store.submit({ repoPath: '.', baseRef: 'main', prompt: 'Original human goal', ...(boss ? { boss: { preference: 'Codex lead' } } : { checks, acceptanceCriteria: ['Original acceptance'] }) }, 'requirements');
  const owner = 'worker';
  const claimed = store.claimNext(owner, 60_000)!;
  const generationId = claimed.claimGenerationId!;
  if (boss) store.saveBossPlan(task.id, owner, { summary: 'Plan', acceptanceCriteria: ['Original acceptance'], stages: [{}], checks, maxRevisions: 1, boss: { harness: 'codex', model: 'boss-model', ...(reasoningEffort ? { reasoningEffort } : {}) } });
  const route: RouteDecision = { taskId: task.id, harness: 'zcode', model: 'writer', selectionSource: 'codex', reason: 'test', decidedAt: new Date().toISOString() };
  const routing = store.createAttempt(task.id, 'route', { owner, harness: 'codex' });
  store.finishAttempt(routing.id, { status: 'succeeded', metadata: { decision: route } });
  store.saveRoute(route);
  const stage = store.createStage(task.id, { role: 'implement', processStartId: 'process', harness: 'zcode', model: 'writer' });
  store.startStage(stage.id, owner, 'process');
  const attempt = store.createAttempt(task.id, 'implement', { owner, stageId: stage.id, harness: 'zcode', model: 'writer' });
  store.finishAttempt(attempt.id, { status: 'succeeded' }, { owner, processStartId: 'process' });
  const diff = 'diff --git a/a b/a\n+change\n';
  const snapshot = { baseCommit: 'a'.repeat(40), preHead: 'b'.repeat(40), treeId: 'c'.repeat(40), fingerprint: 'fingerprint', diff, diffHash: createHash('sha256').update(diff).digest('hex') };
  const run = store.startCheckRun({ taskId: task.id, owner, generationId, executionAttemptId: attempt.id, executionStageId: stage.id, routeAttemptId: routing.id, route, branchRef: `refs/heads/zero/${task.id}`, snapshot, checkDefinitionHash: createHash('sha256').update(JSON.stringify(checks)).digest('hex'), expectedCheckIds: ['unit'] });
  const seal = () => {
    store.recordCheckResult(run.id, { owner, generationId }, { id: 'unit', argv: checks[0]!.argv, status: 'passed', exitCode: 0, durationMs: 1 });
    store.finishStage(stage.id, owner, 'process', 'succeeded', 'fingerprint');
    return store.completeCheckRun(run.id, { owner, generationId }, snapshot).reviewPackage;
  };
  return { store, task, owner, generationId, seal, run };
}

test('review package freezes all accepted human requirements at check completion', () => {
  const f = fixture();
  try {
    const first = f.store.addBossMessage(f.task.id, 'user', 'During last writer: preserve Unicode 中文', { requestKey: 'late-writer-request-0001' });
    f.store.addBossMessage(f.task.id, 'consultant', 'Consultant advice is not a human requirement', { owner: f.owner });
    const last = f.store.addBossMessage(f.task.id, 'user', 'During checks: retain cancellation receipts', { requestKey: 'late-checks-request-0001' });
    const pkg = f.seal();
    const requirements = (pkg as typeof pkg & { requirements?: { prompt: string; acceptanceCriteria: string[]; userMessages: BossMessage[]; messageCursor?: string } }).requirements;
    assert.ok(requirements, 'package must have an immutable requirements snapshot');
    assert.equal(requirements.prompt, f.task.prompt);
    assert.deepEqual(requirements.acceptanceCriteria, ['Original acceptance']);
    assert.deepEqual(requirements.userMessages, [first, last]);
    assert.equal(requirements.messageCursor, last.id);
    assert.throws(() => f.store.addBossMessage(f.task.id, 'user', 'Too late', { requestKey: 'after-seal-request-0001' }), BossMessageConflictError);
    assert.deepEqual(f.store.addBossMessage(f.task.id, 'user', last.content, { requestKey: 'late-checks-request-0001' }), last);
  } finally { f.store.close(); }
});

test('new Boss package freezes reply targets and cannot accept PASS without its answers', () => {
  const f = fixture();
  try {
    const message = f.store.addBossMessage(f.task.id, 'user', 'Why this design?');
    const pkg = f.seal();
    assert.equal((pkg.requirements as unknown as Record<string, unknown>).replyPolicy, 'per_message_v1');
    assert.deepEqual((pkg.requirements as unknown as Record<string, unknown>).replyMessageIds, [message.id]);
    assert.throws(() => passingVerdict(f, pkg.id), /repl|answer|回答/i);
    assert.equal(f.store.packageReviewVerdicts(f.task.id).length, 0);
  } finally { f.store.close(); }
});

test('valid linked answers commit with the exact verdict and cannot duplicate on replay', () => {
  const f = fixture();
  try {
    const message = f.store.addBossMessage(f.task.id, 'user', 'Why this design?');
    const pkg = f.seal();
    const attempt = f.store.createAttempt(f.task.id, 'review', { owner: f.owner, harness: 'codex', model: 'boss-model', metadata: { packageId: pkg.id, generationId: f.generationId } });
    const input = { packageId: pkg.id, attemptId: attempt.id, owner: f.owner, generationId: f.generationId,
      recheckedSnapshot: pkg.snapshot, result: { verdict: 'pass' as const, summary: 'Verified', findings: [], userMessageReplies: [{ messageId: message.id, content: 'This keeps the public API stable.' }] }, attemptResult: { exitCode: 0 } };
    f.store.finishPackageReview(input);
    const replies = f.store.bossMessages(f.task.id).filter(item => item.role === 'boss');
    assert.equal(replies.length, 1);
    assert.equal((replies[0] as unknown as Record<string, unknown>).inReplyTo, message.id);
    assert.equal((replies[0] as unknown as Record<string, unknown>).reviewAttemptId, attempt.id);
    assert.equal((replies[0] as unknown as Record<string, unknown>).reviewPackageId, pkg.id);
    assert.throws(() => f.store.finishPackageReview(input));
    assert.equal(f.store.bossMessages(f.task.id).filter(item => item.role === 'boss').length, 1);
  } finally { f.store.close(); }
});

for (const actual of [{ model: 'other', reasoningEffort: 'high' }, { model: 'boss-model', reasoningEffort: 'low' }]) test(`linked answers reject an ungranted actual Boss ${JSON.stringify(actual)}`, () => {
  const f = fixture(':memory:', true, 'high');
  try {
    const message = f.store.addBossMessage(f.task.id, 'user', 'Why this design?'); const pkg = f.seal();
    const attempt = f.store.createAttempt(f.task.id, 'review', { owner: f.owner, harness: 'codex', metadata: { packageId: pkg.id, generationId: f.generationId } });
    assert.throws(() => f.store.finishPackageReview({ packageId: pkg.id, attemptId: attempt.id, owner: f.owner, generationId: f.generationId,
      recheckedSnapshot: pkg.snapshot, result: { verdict: 'pass', summary: 'Verified', findings: [], userMessageReplies: [{ messageId: message.id, content: 'Evidence-based answer' }] }, attemptResult: { exitCode: 0, ...actual } }), /Boss.*binding|Boss.*model|Boss.*effort/i);
    assert.equal(f.store.attempts(f.task.id).find(a => a.id === attempt.id)?.status, 'running');
    assert.equal(f.store.packageReviewVerdicts(f.task.id).length, 0);
    assert.equal(f.store.bossMessages(f.task.id).filter(item => item.role === 'boss').length, 0);
  } finally { f.store.close(); }
});

for (const actual of [{ model: 'other', reasoningEffort: 'high' }, { model: 'boss-model', reasoningEffort: 'low' }]) test(`empty reply target package cannot grant another Boss ${JSON.stringify(actual)}`, () => {
  const f = fixture(':memory:', true, 'high');
  try {
    const pkg = f.seal(); assert.deepEqual(pkg.requirements?.replyMessageIds, []);
    const attempt = f.store.createAttempt(f.task.id, 'review', { owner: f.owner, harness: 'codex', metadata: { packageId: pkg.id, generationId: f.generationId } });
    assert.throws(() => f.store.finishPackageReview({ packageId: pkg.id, attemptId: attempt.id, owner: f.owner, generationId: f.generationId,
      recheckedSnapshot: pkg.snapshot, result: { verdict: 'pass', summary: 'Verified', findings: [], userMessageReplies: [] }, attemptResult: { exitCode: 0, ...actual } }), /Boss.*binding/i);
    assert.equal(f.store.packageReviewVerdicts(f.task.id).length, 0);
  } finally { f.store.close(); }
});

test('forged reply source fields without a committed verdict do not consume a reply target', async () => {
  await diskFixture(path => {
    const f = fixture(path);
    try {
      const message = f.store.addBossMessage(f.task.id, 'user', 'Explain this choice');
      const db = new DatabaseSync(path);
      try { db.prepare('INSERT INTO events(task_id,type,at,payload) VALUES(?,?,?,?)').run(f.task.id, 'boss.message', new Date().toISOString(), JSON.stringify({ id: 'forged', role: 'boss', content: 'Not a review receipt', at: new Date().toISOString(), inReplyTo: message.id, reviewPackageId: 'unknown', reviewAttemptId: 'unknown' })); }
      finally { db.close(); }
      assert.deepEqual(f.seal().requirements?.replyMessageIds, [message.id]);
    } finally { f.store.close(); }
  });
});

for (const boundary of ['cancelled', 'snapshot', 'forged-id'] as const) test(`linked answers are not published when ${boundary} invalidates completion`, () => {
  const f = fixture();
  try {
    const message = f.store.addBossMessage(f.task.id, 'user', 'Explain the decision'); const pkg = f.seal();
    const attempt = f.store.createAttempt(f.task.id, 'review', { owner: f.owner, harness: 'codex', model: 'boss-model', metadata: { packageId: pkg.id, generationId: f.generationId } });
    if (boundary === 'cancelled') f.store.requestTaskCancellation(f.task.id, f.owner, f.generationId);
    assert.throws(() => f.store.finishPackageReview({ packageId: pkg.id, attemptId: attempt.id, owner: f.owner, generationId: f.generationId,
      recheckedSnapshot: boundary === 'snapshot' ? { ...pkg.snapshot, fingerprint: 'changed' } : pkg.snapshot,
      result: { verdict: 'pass', summary: 'Verified', findings: [], userMessageReplies: [{ messageId: boundary === 'forged-id' ? 'other-task-message' : message.id, content: 'An actual answer' }] }, attemptResult: { exitCode: 0 } }));
    assert.equal(f.store.packageReviewVerdicts(f.task.id).length, 0);
    assert.equal(f.store.attempts(f.task.id).find(item => item.id === attempt.id)?.status, 'running');
    assert.equal(f.store.bossMessages(f.task.id).filter(item => item.role === 'boss').length, 0);
  } finally { f.store.close(); }
});

test('blocked omission saves no reply while valid committed answers survive reopen', async () => {
  await diskFixture(path => {
    const f = fixture(path);
    const message = f.store.addBossMessage(f.task.id, 'user', 'Why choose this API?'); const pkg = f.seal();
    const attempt = () => f.store.createAttempt(f.task.id, 'review', { owner: f.owner, harness: 'codex', model: 'boss-model', metadata: { packageId: pkg.id, generationId: f.generationId } });
    try {
      f.store.finishPackageReview({ packageId: pkg.id, attemptId: attempt().id, owner: f.owner, generationId: f.generationId, recheckedSnapshot: pkg.snapshot,
        result: { verdict: 'blocked', summary: 'Insufficient evidence', findings: [] }, attemptResult: { exitCode: 0 } });
      assert.equal(f.store.bossMessages(f.task.id).filter(item => item.role === 'boss').length, 0);
      const result = { verdict: 'pass' as const, summary: 'Verified', findings: [], userMessageReplies: [{ messageId: message.id, content: 'The API retains the existing call contract.' }] };
      f.store.finishPackageReview({ packageId: pkg.id, attemptId: attempt().id, owner: f.owner, generationId: f.generationId, recheckedSnapshot: pkg.snapshot, result, attemptResult: { exitCode: 0 } });
    } finally { f.store.close(); }
    const reopened = new TaskStore(path);
    try {
      const answer = reopened.bossMessages(f.task.id).find(item => item.inReplyTo === message.id)!;
      const verdict = reopened.packageReviewVerdicts(f.task.id).find(item => item.attemptId === answer.reviewAttemptId)!;
      assert.equal(answer.reviewPackageId, verdict.packageId);
      assert.equal(answer.content, verdict.result.userMessageReplies![0]!.content);
    } finally { reopened.close(); }
  });
});

test('reply event failure rolls back the verdict and attempt so the same completion can retry', async () => {
  await diskFixture(path => {
    const f = fixture(path);
    const db = new DatabaseSync(path);
    try {
      const message = f.store.addBossMessage(f.task.id, 'user', 'Why preserve this API?');
      const pkg = f.seal();
      const attempt = f.store.createAttempt(f.task.id, 'review', { owner: f.owner, harness: 'codex', model: 'boss-model',
        metadata: { packageId: pkg.id, generationId: f.generationId } });
      const input = { packageId: pkg.id, attemptId: attempt.id, owner: f.owner, generationId: f.generationId,
        recheckedSnapshot: pkg.snapshot, attemptResult: { exitCode: 0 },
        result: { verdict: 'pass' as const, summary: 'Verified', findings: [],
          userMessageReplies: [{ messageId: message.id, content: 'The existing callers depend on this API, and the artifact preserves it.' }] } };
      db.exec(`CREATE TRIGGER reject_linked_reply BEFORE INSERT ON events
        WHEN NEW.type='boss.message' AND json_extract(NEW.payload,'$.inReplyTo') IS NOT NULL
        BEGIN SELECT RAISE(ABORT,'injected reply event failure'); END`);
      assert.throws(() => f.store.finishPackageReview(input), /injected reply event failure/);
      assert.equal(f.store.attempts(f.task.id).find(item => item.id === attempt.id)?.status, 'running');
      assert.equal(f.store.packageReviewVerdicts(f.task.id).length, 0);
      assert.equal(f.store.reviews(f.task.id).length, 0);
      assert.equal(f.store.bossMessages(f.task.id).filter(item => item.inReplyTo).length, 0);
      db.exec('DROP TRIGGER reject_linked_reply');
      f.store.finishPackageReview(input);
      assert.equal(f.store.attempts(f.task.id).find(item => item.id === attempt.id)?.status, 'succeeded');
      assert.equal(f.store.packageReviewVerdicts(f.task.id).length, 1);
      assert.equal(f.store.bossMessages(f.task.id).filter(item => item.inReplyTo === message.id).length, 1);
    } finally { db.close(); f.store.close(); }
  });
});

test('pre-policy Boss package retains old result contract without granting unsealed replies', async () => {
  await diskFixture(path => {
    const f = fixture(path);
    try {
      const message = f.store.addBossMessage(f.task.id, 'user', 'Legacy question'); const pkg = f.seal();
      const oldRequirements = { ...pkg.requirements }; delete oldRequirements.replyPolicy; delete oldRequirements.replyMessageIds;
      const db = new DatabaseSync(path);
      try {
        db.exec('DROP TRIGGER review_package_requirements_no_update');
        db.prepare('UPDATE review_package_requirements SET payload=? WHERE package_id=?').run(JSON.stringify(oldRequirements), pkg.id);
        db.exec("CREATE TRIGGER review_package_requirements_no_update BEFORE UPDATE ON review_package_requirements BEGIN SELECT RAISE(ABORT,'review requirements are immutable'); END");
      } finally { db.close(); }
      const attempt = f.store.createAttempt(f.task.id, 'review', { owner: f.owner, harness: 'codex', model: 'boss-model', metadata: { packageId: pkg.id, generationId: f.generationId } });
      assert.throws(() => f.store.finishPackageReview({ packageId: pkg.id, attemptId: attempt.id, owner: f.owner, generationId: f.generationId, recheckedSnapshot: pkg.snapshot,
        result: { verdict: 'pass', summary: 'Verified', findings: [], userMessageReplies: [{ messageId: message.id, content: 'No sealed reply authority' }] }, attemptResult: { exitCode: 0 } }), /repl/i);
      assert.equal(f.store.finishPackageReview({ packageId: pkg.id, attemptId: attempt.id, owner: f.owner, generationId: f.generationId, recheckedSnapshot: pkg.snapshot,
        result: { verdict: 'pass', summary: 'Legacy result', findings: [] }, attemptResult: { exitCode: 0 } }).result.verdict, 'pass');
      assert.equal(f.store.bossMessages(f.task.id).filter(item => item.role === 'boss').length, 0);
    } finally { f.store.close(); }
  });
});

async function diskFixture(run: (path: string) => Promise<void> | void) {
  const parent = join(process.cwd(), 'data', 'verification', 'boss-flow-round17');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'requirements-'));
  try { await run(join(root, 'queue.sqlite')); } finally { await rm(root, { recursive: true, force: true }); }
}

function passingVerdict(f: ReturnType<typeof fixture>, packageId: string) {
  const attempt = f.store.createAttempt(f.task.id, 'review', { owner: f.owner, harness: 'codex', model: 'boss-model', metadata: { packageId, generationId: f.generationId } });
  return f.store.finishPackageReview({ packageId, attemptId: attempt.id, owner: f.owner, generationId: f.generationId,
    recheckedSnapshot: f.store.getReviewPackage(packageId)!.snapshot,
    result: { verdict: 'pass', summary: 'All requirements checked', findings: [] }, attemptResult: { exitCode: 0 } });
}

function commitInput(f: ReturnType<typeof fixture>, packageId: string, verdictId: string) {
  const pkg = f.store.getReviewPackage(packageId)!;
  return { operationId: 'requirements-commit', packageId, verdictId, owner: f.owner, generationId: f.generationId,
    branchRef: pkg.branchRef, preHead: pkg.snapshot.preHead, treeId: pkg.snapshot.treeId, diffHash: pkg.snapshot.diffHash,
    message: 'Reviewed change', timestamp: '2026-10-27T00:00:00.000Z' };
}

function simulateLegacyPackage(path: string, packageId: string) {
  const db = new DatabaseSync(path);
  try {
    // Simulate an actual pre-migration package, not a supported production edit.
    db.exec('DROP TRIGGER review_package_requirements_no_delete');
    db.prepare('DELETE FROM review_package_requirements WHERE package_id=?').run(packageId);
    db.exec("CREATE TRIGGER review_package_requirements_no_delete BEFORE DELETE ON review_package_requirements BEGIN SELECT RAISE(ABORT,'review requirements are immutable'); END");
  } finally { db.close(); }
}

test('requirements survive reopen, are immutable, and returned objects cannot rewrite sealed evidence', async () => {
  await diskFixture(path => {
    const f = fixture(path);
    const message = f.store.addBossMessage(f.task.id, 'user', 'Original exact text 中文\nsecond line');
    const pkg = f.seal();
    const expected = JSON.parse(JSON.stringify(pkg.requirements));
    pkg.requirements!.userMessages[0]!.content = 'Caller attempted mutation';
    assert.deepEqual(f.store.requireReviewPackageRequirements(pkg.id), expected);
    f.store.close();
    const reopened = new TaskStore(path);
    try {
      assert.deepEqual(reopened.getReviewPackage(pkg.id)?.requirements, expected);
      assert.deepEqual(reopened.requireReviewPackageRequirements(pkg.id)?.userMessages, [message]);
      const db = new DatabaseSync(path);
      try {
        assert.throws(() => db.prepare('UPDATE review_package_requirements SET payload=? WHERE package_id=?').run('{}', pkg.id), /immutable/);
        assert.throws(() => db.prepare('DELETE FROM review_package_requirements WHERE package_id=?').run(pkg.id), /immutable/);
        assert.throws(() => db.prepare('INSERT INTO review_package_requirements(package_id,payload) VALUES(?,?)').run(pkg.id, JSON.stringify(expected)), /only be sealed during check completion/);
      } finally { db.close(); }
    } finally { reopened.close(); }
  });
});

test('legacy Boss package cannot acquire a live snapshot or authorize review and commit, even with a saved PASS', async () => {
  await diskFixture(path => {
    const f = fixture(path);
    try {
      const pkg = f.seal();
      const verdict = passingVerdict(f, pkg.id);
      const input = commitInput(f, pkg.id, verdict.id);
      const requirements = pkg.requirements!;
      simulateLegacyPackage(path, pkg.id);
      assert.equal(f.store.getReviewPackage(pkg.id)?.requirements, undefined, 'history remains readable');
      assert.throws(() => f.store.requireReviewPackageRequirements(pkg.id), /Boss.*no immutable requirements snapshot/);
      assert.throws(() => f.store.finishPackageReview({ packageId: pkg.id, attemptId: verdict.attemptId, owner: f.owner, generationId: f.generationId,
        recheckedSnapshot: pkg.snapshot, result: verdict.result, attemptResult: { exitCode: 0 } }), /no immutable requirements snapshot/);
      assert.throws(() => f.store.createCommitOperation(input), /no immutable requirements snapshot/);
      assert.throws(() => f.store.createCommitOperationFromRecoveredVerdict({ ...input,
        preCommitInspection: { checkedAt: new Date().toISOString(), branchRef: pkg.branchRef, head: pkg.snapshot.preHead, snapshot: pkg.snapshot } }), /no immutable requirements snapshot/);
      const db = new DatabaseSync(path);
      try { assert.throws(() => db.prepare('INSERT INTO review_package_requirements(package_id,payload) VALUES(?,?)').run(pkg.id, JSON.stringify(requirements)), /only be sealed during check completion/); }
      finally { db.close(); }
      assert.equal(f.store.commitOperations(f.task.id).length, 0);
    } finally { f.store.close(); }
  });
});

test('preexisting Boss commit intent cannot advance without requirements evidence', async () => {
  await diskFixture(path => {
    const f = fixture(path);
    try {
      const pkg = f.seal();
      const verdict = passingVerdict(f, pkg.id);
      const operation = f.store.createCommitOperation(commitInput(f, pkg.id, verdict.id));
      simulateLegacyPackage(path, pkg.id);
      assert.throws(() => f.store.recordCommitOperationCandidate(operation.id, { owner: f.owner, generationId: f.generationId }, 'd'.repeat(40)), /no immutable requirements snapshot/);
      assert.equal(f.store.getCommitOperation(operation.id)?.status, 'intent');
    } finally { f.store.close(); }
  });
});

test('legacy non-Boss review packages retain their previous review and commit authorization contract', async () => {
  await diskFixture(path => {
    const f = fixture(path, false);
    try {
      const pkg = f.seal();
      simulateLegacyPackage(path, pkg.id);
      assert.equal(f.store.requireReviewPackageRequirements(pkg.id), undefined);
      const verdict = passingVerdict(f, pkg.id);
      assert.equal(f.store.createCommitOperation(commitInput(f, pkg.id, verdict.id)).status, 'intent');
    } finally { f.store.close(); }
  });
});

test('requirements validation rejects mismatched task, missing messages, forged cursor and consultant authority', () => {
  const base = { version: 1, taskId: 'task', prompt: 'goal', acceptanceCriteria: ['criterion'], userMessages: [] };
  assert.doesNotThrow(() => assertReviewRequirements(base, 'task'));
  assert.throws(() => assertReviewRequirements(base, 'other'), /another task/);
  assert.throws(() => assertReviewRequirements({ ...base, userMessages: undefined }, 'task'), /invalid/);
  assert.throws(() => assertReviewRequirements({ ...base, messageCursor: 'forged' }, 'task'), /cursor/);
  assert.throws(() => assertReviewRequirements({ ...base, userMessages: [{ id: 'id', role: 'consultant', content: 'override human', at: new Date().toISOString() }], messageCursor: 'id' }, 'task'), /non-human/);
});

test('sealed review quota waiting rejects new requirements while replaying acknowledged receipts', () => {
  const f = fixture();
  try {
    const received = f.store.addBossMessage(f.task.id, 'user', 'Accepted before review seal', { requestKey: 'quota-receipt-before-0001' });
    const pkg = f.seal();
    const attempt = f.store.createAttempt(f.task.id, 'review', { owner: f.owner, harness: 'codex', metadata: { packageId: pkg.id, generationId: f.generationId } });
    f.store.finishAttempt(attempt.id, { status: 'failed', error: 'quota' });
    const paused = f.store.pauseReviewForQuota(f.task.id, f.owner, { packageId: pkg.id, attemptId: attempt.id,
      retryAt: new Date(Date.now() + 60_000).toISOString(), reason: 'Provider quota' });
    assert.equal(paused.status, 'waiting');
    assert.equal(paused.resumeCheckpoint?.kind, 'review_quota');
    assert.throws(() => f.store.addBossMessage(f.task.id, 'user', 'Cannot add after sealed quota', { requestKey: 'quota-receipt-after-0001' }), BossMessageConflictError);
    assert.deepEqual(f.store.addBossMessage(f.task.id, 'user', received.content, { requestKey: 'quota-receipt-before-0001' }), received);
    assert.deepEqual(f.store.bossMessages(f.task.id).filter(message => message.role === 'user'), [received]);
    assert.deepEqual(f.store.requireReviewPackageRequirements(pkg.id)?.userMessages, [received]);
  } finally { f.store.close(); }
});

test('writer quota waiting still accepts requirements for the next writable boundary', () => {
  const f = fixture();
  try {
    f.store.pauseForQuota(f.task.id, f.owner, { retryAt: new Date(Date.now() + 60_000).toISOString(), reason: 'writer quota', checkpoint: { stage: 'route' } });
    const message = f.store.addBossMessage(f.task.id, 'user', 'Writer must handle this on resume', { requestKey: 'writer-quota-message-0001' });
    assert.equal(f.store.get(f.task.id)?.status, 'waiting');
    assert.equal(f.store.bossMessages(f.task.id).at(-1)?.id, message.id);
  } finally { f.store.close(); }
});

test('requirements overflow fails the seal atomically instead of truncating accepted messages', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 20; i++) f.store.addBossMessage(f.task.id, 'user', `${i}:` + 'x'.repeat(15_900));
    assert.throws(() => f.seal(), /requirements.*limit|requirements.*exceed/i);
    assert.equal(f.store.get(f.task.id)?.status, 'running');
    assert.equal(f.store.getCheckRun(f.run.id)?.status, 'running');
    assert.equal(f.store.reviewPackages(f.task.id).length, 0);
    assert.equal(f.store.bossMessages(f.task.id).filter(message => message.role === 'user').length, 20);
  } finally { f.store.close(); }
});

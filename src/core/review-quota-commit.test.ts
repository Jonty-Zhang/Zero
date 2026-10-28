import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore, type CreateCommitOperationInput } from './task-store.js';

const guardian = (id: string) => ({ id, lockId: 'd'.repeat(64), predecessorDrained: true, evidenceKind: 'guardian_startup_verified' as const });
type QuotaInput = CreateCommitOperationInput & {
  sameGenerationReviewQuota?: { kind: 'quota'; packageId: string; owner: string; generationId: string; claimId?: string };
  preCommitInspection?: { checkedAt: string; branchRef: string; head: string; snapshot: import('./task-store.js').CheckRunSnapshot };
};

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void> | void, quota = true) {
  const parent = join(process.cwd(), 'data/verification/boss-recovery-round20'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'store-'));
  const f = await setup(join(root, 'queue.sqlite'), quota);
  try { await run(f); } finally { f.store.close(); await rm(root, { recursive: true, force: true }); }
}

async function setup(path: string, quota: boolean) {
  const store = new TaskStore(path, guardian('1'.repeat(32)));
  const checks = [{ id: 'unit', argv: ['node', 'fixture.js'] }];
  const task = store.submit({ repoPath: '.', baseRef: 'HEAD', prompt: 'Quota commit authorization', checks, maxRevisions: 2, boss: { preference: 'lead' } });
  const owner = 'original'; const generationId = store.claimNext(owner)!.claimGenerationId!;
  const plan = { taskId: task.id, repoPath: join(process.cwd(), 'data/verification/boss-recovery-round20/project'), commonGitDir: join(process.cwd(), 'data/verification/boss-recovery-round20/project/.git'), worktreeRoot: join(process.cwd(), 'data/verification/boss-recovery-round20/worktrees'), path: join(process.cwd(), 'data/verification/boss-recovery-round20/worktrees', task.id), branch: `zero/${task.id}`, baseCommit: 'a'.repeat(40) };
  const info = { taskId: task.id, repoPath: plan.repoPath, path: plan.path, branch: plan.branch, baseCommit: plan.baseCommit };
  const observed = { info, commonGitDir: plan.commonGitDir, head: plan.baseCommit, fingerprint: 'd'.repeat(64) };
  store.recordWorktreeCreationIntent(task.id, owner, plan); store.completeWorktreeCreation(task.id, owner, observed, observed.fingerprint);
  const route = { taskId: task.id, harness: 'dsh', model: 'fixture', selectionSource: 'codex' as const, reason: 'fixture', decidedAt: new Date().toISOString() };
  const routing = store.createAttempt(task.id, 'route', { owner, harness: 'codex' });
  store.finishAttempt(routing.id, { status: 'succeeded', metadata: { decision: route } }); store.saveRoute(route);
  const stage = store.createStage(task.id, { role: 'implement', processStartId: 'process', harness: 'dsh', model: 'fixture' }); store.startStage(stage.id, owner, 'process');
  const writer = store.createAttempt(task.id, 'implement', { owner, stageId: stage.id, harness: 'dsh', model: 'fixture' });
  store.finishAttempt(writer.id, { status: 'succeeded' }, { owner, processStartId: 'process' });
  const diff = 'diff --git a/a b/a\n+result\n';
  const snapshot = { baseCommit: plan.baseCommit, preHead: plan.baseCommit, treeId: 'b'.repeat(40), fingerprint: 'c'.repeat(64), diff, diffHash: createHash('sha256').update(diff).digest('hex') };
  const check = store.startCheckRun({ taskId: task.id, owner, generationId, executionAttemptId: writer.id, executionStageId: stage.id, routeAttemptId: routing.id, route, branchRef: `refs/heads/${info.branch}`, snapshot, expectedCheckIds: ['unit'], checkDefinitionHash: createHash('sha256').update(JSON.stringify(checks)).digest('hex') });
  store.recordCheckResult(check.id, { owner, generationId }, { id: 'unit', argv: checks[0]!.argv, status: 'passed', exitCode: 0, durationMs: 1 });
  store.finishStage(stage.id, owner, 'process', 'succeeded', snapshot.fingerprint);
  const pkg = store.completeCheckRun(check.id, { owner, generationId }, snapshot).reviewPackage;
  const f = { store, path, task, owner, generationId, pkg, snapshot, observed };
  if (quota) resume(f, 'resumed');
  return f;
}

function resume(f: Awaited<ReturnType<typeof setup>>, owner: string) {
  const attempt = f.store.createAttempt(f.task.id, 'review', { owner: f.owner, harness: 'codex', metadata: { packageId: f.pkg.id, generationId: f.generationId } });
  f.store.finishAttempt(attempt.id, { status: 'interrupted', error: 'quota' });
  const now = new Date();
  f.store.pauseReviewForQuota(f.task.id, f.owner, { packageId: f.pkg.id, attemptId: attempt.id, reason: 'quota', retryAt: new Date(now.getTime() + 60_000).toISOString(), now });
  const due = new Date(now.getTime() + 120_000);
  const fresh = { ...f.observed, head: f.snapshot.preHead, fingerprint: f.snapshot.fingerprint };
  const claim = f.store.claimReviewQuotaResume(f.task.id, owner, { now: due, identity: { checkedAt: due.toISOString(), observed: fresh, fingerprint: fresh.fingerprint }, gitState: { kind: 'pre_commit', checkedAt: due.toISOString(), branchRef: f.pkg.branchRef, head: f.snapshot.preHead, treeId: f.snapshot.treeId, diffHash: f.snapshot.diffHash, snapshot: f.snapshot } });
  assert.ok(claim); f.owner = owner; f.generationId = claim.claimGenerationId;
}

function pass(f: Awaited<ReturnType<typeof setup>>) {
  const attempt = f.store.createAttempt(f.task.id, 'review', { owner: f.owner, harness: 'codex', metadata: { packageId: f.pkg.id, generationId: f.generationId } });
  const verdict = f.store.finishPackageReview({ packageId: f.pkg.id, attemptId: attempt.id, owner: f.owner, generationId: f.generationId, recheckedSnapshot: f.snapshot, result: { verdict: 'pass', summary: 'all requirements', findings: [] }, attemptResult: { exitCode: 0 } });
  const input: QuotaInput = { operationId: 'quota-commit', packageId: f.pkg.id, verdictId: verdict.id, owner: f.owner, generationId: f.generationId, branchRef: f.pkg.branchRef, preHead: f.snapshot.preHead, treeId: f.snapshot.treeId, diffHash: f.snapshot.diffHash, message: 'Approved', timestamp: new Date().toISOString(),
    sameGenerationReviewQuota: { kind: 'quota', packageId: f.pkg.id, owner: f.owner, generationId: f.generationId },
    preCommitInspection: { checkedAt: new Date().toISOString(), branchRef: f.pkg.branchRef, head: f.snapshot.preHead, snapshot: { ...f.snapshot } } };
  return { verdict, attempt, input };
}

function editEvent(f: Awaited<ReturnType<typeof setup>>, type: string, update: (payload: Record<string, unknown>) => Record<string, unknown>) {
  const db = new DatabaseSync(f.path);
  try {
    const row = db.prepare('SELECT id,payload FROM events WHERE task_id=? AND type=? ORDER BY id DESC LIMIT 1').get(f.task.id, type) as { id: number; payload: string };
    db.prepare('UPDATE events SET payload=? WHERE id=?').run(JSON.stringify(update(JSON.parse(row.payload))), row.id);
  } finally { db.close(); }
}

test('same-generation quota fresh current-owner PASS creates one fully inspected normal intent', async () => {
  await fixture(f => { const { input } = pass(f); assert.equal(f.store.createCommitOperation(input).status, 'intent'); assert.equal(f.store.reviewRecoveryClaims(f.task.id).length, 0); });
});

const invalidInputs: Array<[string, (input: QuotaInput) => void]> = [
  ['missing proof', input => { delete input.sameGenerationReviewQuota; }],
  ['missing inspection', input => { delete input.preCommitInspection; }],
  ['wrong proof kind', input => { input.sameGenerationReviewQuota!.kind = 'review' as 'quota'; }],
  ['wrong proof package', input => { input.sameGenerationReviewQuota!.packageId = 'other'; }],
  ['wrong proof owner', input => { input.sameGenerationReviewQuota!.owner = 'other'; }],
  ['wrong proof generation', input => { input.sameGenerationReviewQuota!.generationId = 'other'; }],
  ['unexpected recovery claim', input => { input.sameGenerationReviewQuota!.claimId = 'invented'; }],
  ['stale inspection', input => { input.preCommitInspection!.checkedAt = new Date(Date.now() - 120_000).toISOString(); }],
  ['future inspection', input => { input.preCommitInspection!.checkedAt = new Date(Date.now() + 120_000).toISOString(); }],
  ['incomplete inspection', input => { delete (input.preCommitInspection!.snapshot as Partial<import('./task-store.js').CheckRunSnapshot>).fingerprint; }],
  ['changed branch', input => { input.preCommitInspection!.branchRef = 'refs/heads/other'; }],
  ['changed head', input => { input.preCommitInspection!.head = 'f'.repeat(40); }],
  ['changed base', input => { input.preCommitInspection!.snapshot.baseCommit = 'f'.repeat(40); }],
  ['changed tree', input => { input.preCommitInspection!.snapshot.treeId = 'f'.repeat(40); }],
  ['changed diff', input => { input.preCommitInspection!.snapshot.diff += '+unreviewed\n'; }],
  ['changed fingerprint', input => { input.preCommitInspection!.snapshot.fingerprint = 'f'.repeat(64); }],
];
for (const [label, mutate] of invalidInputs) test(`quota commit rejects ${label} before inserting an intent`, async () => {
  await fixture(f => { const { input } = pass(f); mutate(input); assert.throws(() => f.store.createCommitOperation(input)); assert.equal(f.store.commitOperations(f.task.id).length, 0); assert.equal(f.store.reportOperations(f.task.id).length, 0); });
});

test('caller quota proof without any durable quota resume cannot create authority', async () => {
  await fixture(f => { const { input } = pass(f); assert.throws(() => f.store.createCommitOperation(input)); assert.equal(f.store.commitOperations(f.task.id).length, 0); }, false);
});

for (const [label, type, mutate] of [
  ['wrong resumed check run', 'task.review_quota_resumed', (payload: Record<string, unknown>) => ({ ...payload, checkRunId: 'other' })],
  ['wrong resumed package', 'task.review_quota_resumed', (payload: Record<string, unknown>) => ({ ...payload, packageId: 'other' })],
  ['false generation edge', 'task.review_quota_resumed', (payload: Record<string, unknown>) => ({ ...payload, recoveredGeneration: true })],
  ['different original source', 'task.review_quota_resumed', (payload: Record<string, unknown>) => ({ ...payload, priorGenerationId: 'other' })],
  ['latest claimed owner', 'task.claimed', (payload: Record<string, unknown>) => ({ ...payload, owner: 'other' })],
  ['non quota latest claim', 'task.claimed', (payload: Record<string, unknown>) => ({ ...payload, recovery: undefined })],
  ['different PASS owner', 'review.finished', (payload: Record<string, unknown>) => ({ ...payload, owner: 'other' })],
] as const) test(`quota commit independently rejects ${label} in durable events`, async () => {
  await fixture(f => { const { input } = pass(f); editEvent(f, type, mutate); assert.throws(() => f.store.createCommitOperation(input)); assert.equal(f.store.commitOperations(f.task.id).length, 0); });
});

test('an earlier same-owner PASS cannot predate the latest matching quota resume', async () => {
  await fixture(f => {
    const { input } = pass(f); const db = new DatabaseSync(f.path);
    try {
      for (const type of ['task.claimed', 'task.review_quota_resumed']) {
        const row = db.prepare('SELECT payload,at FROM events WHERE task_id=? AND type=? ORDER BY id DESC LIMIT 1').get(f.task.id, type) as { payload: string; at: string };
        db.prepare('INSERT INTO events(task_id,type,at,payload) VALUES(?,?,?,?)').run(f.task.id, type, row.at, row.payload);
      }
    } finally { db.close(); }
    assert.throws(() => f.store.createCommitOperation(input)); assert.equal(f.store.commitOperations(f.task.id).length, 0);
  });
});

test('repeated same-generation quota with a reused owner accepts only the latest fresh attempt', async () => {
  await fixture(f => { resume(f, f.owner); const { input } = pass(f); assert.equal(f.store.createCommitOperation(input).status, 'intent'); assert.equal(f.store.reviewRecoveryClaims(f.task.id).length, 0); });
});

for (const [label, sql, values] of [
  ['expired lease', 'UPDATE tasks SET lease_expires_at=? WHERE id=?', () => [new Date(Date.now() - 1).toISOString()]],
  ['changed live owner', 'UPDATE tasks SET lease_owner=? WHERE id=?', () => ['other-owner']],
  ['changed live generation', 'UPDATE tasks SET claim_generation_id=? WHERE id=?', () => ['2'.repeat(32)]],
  ['historical package source', 'UPDATE check_runs SET generation_id=? WHERE task_id=?', () => ['2'.repeat(32)]],
  ['incomplete check run', 'UPDATE check_runs SET status=? WHERE task_id=?', () => ['running']],
] as const) test(`quota commit rejects ${label} without a commit or report`, async () => {
  await fixture(f => {
    const { input } = pass(f);
    if (label === 'changed live generation' || label === 'historical package source') {
      const later = new TaskStore(f.path, guardian('2'.repeat(32)));
      later.close();
    }
    const db = new DatabaseSync(f.path);
    try { db.prepare(sql).run(...values(), f.task.id); } finally { db.close(); }
    assert.throws(() => f.store.createCommitOperation(input));
    assert.equal(f.store.commitOperations(f.task.id).length, 0);
    assert.equal(f.store.reportOperations(f.task.id).length, 0);
  });
});

test('an accepted cancellation closes same-generation quota commit admission', async () => {
  await fixture(f => {
    const { input } = pass(f);
    f.store.requestTaskCancellation(f.task.id, f.owner, f.generationId);
    assert.throws(() => f.store.createCommitOperation(input));
    assert.equal(f.store.commitOperations(f.task.id).length, 0);
    assert.equal(f.store.reportOperations(f.task.id).length, 0);
  });
});

test('same-generation quota cannot create a second operation for its PASS', async () => {
  await fixture(f => {
    const { input } = pass(f);
    const original = f.store.createCommitOperation(input);
    assert.throws(() => f.store.createCommitOperation({ ...input, operationId: 'duplicate-quota-operation' }));
    assert.deepEqual(f.store.commitOperations(f.task.id), [original]);
    assert.equal(f.store.reportOperations(f.task.id).length, 0);
  });
});

for (const corrupt of [false, true]) test(`quota PASS cannot authorize a ${corrupt ? 'malformed' : 'missing legacy'} Boss requirements snapshot`, async () => {
  await fixture(f => {
    const { input } = pass(f);
    const db = new DatabaseSync(f.path);
    try {
      // Simulate an old or corrupt database only in this isolated fixture.
      if (corrupt) {
        db.exec('DROP TRIGGER review_package_requirements_no_update');
        db.prepare('UPDATE review_package_requirements SET payload=? WHERE package_id=?').run('{', f.pkg.id);
      } else {
        db.exec('DROP TRIGGER review_package_requirements_no_delete');
        db.prepare('DELETE FROM review_package_requirements WHERE package_id=?').run(f.pkg.id);
      }
    } finally { db.close(); }
    assert.throws(() => f.store.createCommitOperation(input));
    assert.equal(f.store.commitOperations(f.task.id).length, 0);
    assert.equal(f.store.reportOperations(f.task.id).length, 0);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from './task-store.js';
import type { BossMessage, BossPlan, TaskRecord } from '../domain/types.js';

type PlanningStore = TaskStore & {
  saveBossPlan(id: string, owner: string, plan: BossPlan, completedStages?: number): TaskRecord;
  addBossMessage(id: string, role: BossMessage['role'], content: string, metadata?: { owner?: string; harness?: string; model?: string }): BossMessage;
  bossMessages(id: string): BossMessage[];
};
function fixture() {
  const store = new TaskStore() as PlanningStore;
  const task = store.submit({ repoPath: '.', baseRef: 'HEAD', prompt: 'Build a useful project', boss: { preference: 'Codex high' }, acceptanceCriteria: ['Preserve my requirement'] });
  store.claimNext('owner');
  const plan: BossPlan = { summary: 'Implement then validate', acceptanceCriteria: ['Result is observable'],
    stages: [{ harness: 'dsh', model: 'cheap', objective: 'Implement the requested result' }],
    checks: [{ id: 'result', argv: ['node', 'verify-result.mjs'] }], maxRevisions: 3,
    boss: { harness: 'codex', model: 'lead', reasoningEffort: 'high' } };
  return { store, task, plan };
}

test('Boss plan atomically becomes the effective execution contract and preserves user criteria', () => {
  const { store, task, plan } = fixture();
  try {
    const saved = store.saveBossPlan(task.id, 'owner', plan);
    assert.equal(saved.prompt, task.prompt);
    assert.deepEqual(saved.executionStages, plan.stages);
    assert.deepEqual(saved.checks, plan.checks);
    assert.deepEqual(saved.acceptanceCriteria, ['Preserve my requirement', 'Result is observable']);
    assert.equal(saved.maxRevisions, 3);
    assert.equal(saved.bossPlan?.boss.model, 'lead');
    assert.equal(store.events(task.id).filter(event => event.type === 'boss.plan.saved').length, 1);
    plan.stages[0]!.objective = 'mutated caller';
    assert.equal(store.get(task.id)?.executionStages?.[0]?.objective, 'Implement the requested result');
  } finally { store.close(); }
});

test('Boss plans reject foreign owners, cancellation, invalid checks and invented completed stages', () => {
  const { store, task, plan } = fixture();
  try {
    assert.throws(() => store.saveBossPlan(task.id, 'other', plan), /lease|owner/i);
    assert.throws(() => store.saveBossPlan(task.id, 'owner', { ...plan, checks: [] }), /check/i);
    assert.throws(() => store.saveBossPlan(task.id, 'owner', plan, 1), /stage|prefix/i);
    const current = store.get(task.id)!;
    store.requestTaskCancellation(task.id, 'owner', current.claimGenerationId!);
    assert.throws(() => store.saveBossPlan(task.id, 'owner', plan), /cancel/i);
    assert.equal(store.get(task.id)?.bossPlan, undefined);
  } finally { store.close(); }
});

test('Boss and user discussion is append-only and model messages require live ownership', () => {
  const { store, task } = fixture();
  try {
    const user = store.addBossMessage(task.id, 'user', 'Please include an export button');
    assert.throws(() => store.addBossMessage(task.id, 'boss', 'I approved it'), /lease|owner/i);
    const lead = store.addBossMessage(task.id, 'boss', 'I will include export checks', { owner: 'owner', harness: 'codex', model: 'lead' });
    assert.deepEqual(store.bossMessages(task.id).map(message => message.id), [user.id, lead.id]);
    assert.equal(store.bossMessages(task.id)[1]?.model, 'lead');
    assert.throws(() => store.addBossMessage(task.id, 'user', ' '), /message|content/i);
    assert.throws(() => store.addBossMessage(task.id, 'user', 'x'.repeat(16001)), /message|content/i);
  } finally { store.close(); }
});

test('late requirements cannot be acknowledged after the acceptance boundary or cancellation', () => {
  const { store, task } = fixture();
  try {
    store.addBossMessage(task.id, 'user', 'A requirement accepted before review');
    store.transition(task.id, 'running', 'reviewing', { owner: 'owner' });
    assert.throws(() => store.addBossMessage(task.id, 'user', 'Too late for this sealed acceptance'), /正在验收/);
    store.fail(task.id, 'reviewing', 'Fixture stopped', 'owner');
    assert.throws(() => store.addBossMessage(task.id, 'user', 'Do not silently archive an unprocessed request'), /任务已停止/);
    assert.equal(store.bossMessages(task.id).length, 1);
  } finally { store.close(); }
  const cancelled = fixture();
  try {
    cancelled.store.requestTaskCancellation(cancelled.task.id, 'owner', cancelled.store.get(cancelled.task.id)!.claimGenerationId!);
    assert.throws(() => cancelled.store.addBossMessage(cancelled.task.id, 'user', 'This request cannot be processed'), /任务已停止/);
  } finally { cancelled.store.close(); }
});

test('a succeeded attempt cannot invent a completed stage or bypass an interrupted prefix without quota evidence', () => {
  for (const interrupted of [false, true]) {
    const { store, task, plan } = fixture();
    try {
      store.saveBossPlan(task.id, 'owner', plan);
      const stage = store.createStage(task.id, { role: 'implement', harness: 'dsh', model: 'cheap', processStartId: 'first', inputFingerprint: 'base' });
      store.startStage(stage.id, 'owner', 'first');
      const attempt = store.createAttempt(task.id, 'implement', { owner: 'owner', stageId: stage.id, harness: 'dsh', model: 'cheap' });
      store.finishAttempt(attempt.id, { status: interrupted ? 'failed' : 'succeeded' }, { owner: 'owner', processStartId: 'first' });
      if (interrupted) {
        store.finishStage(stage.id, 'owner', 'first', 'interrupted', 'partial');
        const next = store.createStage(task.id, { role: 'implement', harness: 'dsh', model: 'cheap', processStartId: 'second', predecessorStageId: stage.id, inputFingerprint: 'partial' });
        store.startStage(next.id, 'owner', 'second');
        const resumed = store.createAttempt(task.id, 'implement', { owner: 'owner', stageId: next.id, harness: 'dsh', model: 'cheap' });
        store.finishAttempt(resumed.id, { status: 'succeeded' }, { owner: 'owner', processStartId: 'second' });
        store.finishStage(next.id, 'owner', 'second', 'succeeded', 'completed');
      }
      assert.throws(() => store.saveBossPlan(task.id, 'owner', plan, 1), /prefix|stage|quota/i);
    } finally { store.close(); }
  }
});

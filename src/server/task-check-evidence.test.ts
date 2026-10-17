import test from 'node:test';
import assert from 'node:assert/strict';
import type { Attempt, CheckResult, TaskEvent, TaskRecord } from '../domain/types.js';
import type { CheckRunRecord } from '../core/task-store.js';
import { selectTaskCheckEvidence } from './task-check-evidence.js';

const task = { id: 'task', status: 'reviewing' } as TaskRecord;
const writer = (id: string, stageId: string) => ({ id, taskId: 'task', stageId, role: 'implement', status: 'succeeded' } as Attempt);
const result = (status: 'passed' | 'failed'): CheckResult => ({ id: 'unit', argv: ['test'], status, exitCode: status === 'passed' ? 0 : 1, durationMs: 1 });
const run = (id: string, attempt: string, stage: string, status: CheckRunRecord['status'] = 'completed') => ({ id, taskId: 'task', executionAttemptId: attempt, executionStageId: stage, status } as CheckRunRecord);
const event = (id: number, type: string, payload: Record<string, unknown>) => ({ id, taskId: 'task', type, at: '', payload } as TaskEvent);

test('check evidence separates superseded failures from the current passing run', () => {
  const events = [event(1, 'check_run.started', { checkRunId: 'old' }), event(2, 'check.finished', { attemptId: 'a1', result: result('failed') }),
    event(3, 'check_run.started', { checkRunId: 'new' }), event(4, 'check.finished', { attemptId: 'a2', result: result('passed') })];
  const evidence = selectTaskCheckEvidence({ task, attempts: [writer('a1', 's1'), writer('a2', 's2')], events, checks: [result('failed'), result('passed')],
    runs: [run('new', 'a2', 's2'), run('old', 'a1', 's1')], results: id => [result(id === 'new' ? 'passed' : 'failed')] });
  assert.deepEqual(evidence.tests.map(item => item.status), ['passed']);
  assert.deepEqual(evidence.historicalTests.map(item => item.status), ['failed']);
  assert.deepEqual(evidence.checkEvidence, { state: 'current', runId: 'new', stageId: 's2', attemptId: 'a2', status: 'completed' });
});

test('a new writer and a recovery boundary each invalidate previous-run presentation', () => {
  for (const scenario of ['new-writer', 'recovered', 'quarantined', 'abandoned'] as const) {
    const evidence = selectTaskCheckEvidence({ task: scenario === 'quarantined' ? { ...task, status: 'recovery_required' } : task,
      attempts: [writer('a1', 's1'), ...(scenario === 'new-writer' ? [writer('a2', 's2')] : [])],
      events: [event(1, 'check_run.started', { checkRunId: 'old' }), event(2, 'check.finished', { attemptId: 'a1', result: result('passed') }),
        ...(scenario === 'recovered' ? [event(3, 'task.execution_recovery_claimed', {})] : [])],
      checks: [result('passed')], runs: [run('old', 'a1', 's1', scenario === 'abandoned' ? 'abandoned' : 'completed')], results: () => [result('passed')] });
    assert.deepEqual(evidence.tests, [], scenario);
    assert.equal(evidence.historicalTests.length, 1, scenario);
    assert.equal(evidence.checkEvidence.state, 'historical', scenario);
  }
});

test('legacy evidence remains visible without claiming a verified current-run association', () => {
  const evidence = selectTaskCheckEvidence({ task, attempts: [], events: [], checks: [result('passed')] });
  assert.equal(evidence.tests.length, 1);
  assert.equal(evidence.checkEvidence.state, 'unattributed');
});

test('partial checks and independent integrity failures cannot appear as a completed passing run', () => {
  const evidence = selectTaskCheckEvidence({ task, attempts: [writer('a1', 's1')], events: [event(1, 'check_run.started', { checkRunId: 'run' })],
    checks: [result('passed')], runs: [run('run', 'a1', 's1', 'failed')], results: () => [result('passed')],
    integrityFailure: () => 'Worktree changed during checks' });
  assert.equal(evidence.checkEvidence.status, 'failed');
  assert.deepEqual(evidence.tests.map(item => item.status), ['passed', 'failed']);
  assert.equal(evidence.tests[1]!.id, '__zero_worktree_integrity__');
});

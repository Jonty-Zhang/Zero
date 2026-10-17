import type { CheckRunRecord } from '../core/task-store.js';
import type { Attempt, CheckResult, TaskEvent, TaskRecord } from '../domain/types.js';

export interface TaskCheckEvidenceInput {
  task: TaskRecord;
  attempts: Attempt[];
  events: TaskEvent[];
  checks: CheckResult[];
  runs?: CheckRunRecord[];
  results?: (runId: string) => CheckResult[];
  integrityFailure?: (runId: string) => string | undefined;
}
export interface TaskCheckEvidence {
  tests: CheckResult[];
  historicalTests: CheckResult[];
  checkEvidence: { state: 'current' | 'historical' | 'unattributed'; runId?: string; stageId?: string; attemptId?: string; status?: string };
}

/** Select a display projection; this never grants validation or completion authority. */
export function selectTaskCheckEvidence(input: TaskCheckEvidenceInput): TaskCheckEvidence {
  const { task, attempts, checks, events } = input;
  const orderedEvents = [...events].sort((a, b) => a.id - b.id);
  const recoveryBoundary = orderedEvents.filter(event => event.type === 'task.execution_recovery_claimed').at(-1)?.id ?? -1;
  const starts = orderedEvents.filter(event => event.type === 'check_run.started');
  const latestStart = starts.at(-1);
  const latestRun = input.runs?.find(run => run.id === latestStart?.payload?.checkRunId);
  const writer = attempts.filter(attempt => attempt.role === 'implement' || attempt.role === 'revise').at(-1);
  const current = task.status !== 'recovery_required' && latestRun && input.results
    && latestRun.taskId === task.id && latestRun.status !== 'abandoned'
    && latestRun.executionAttemptId === writer?.id && latestRun.executionStageId === writer?.stageId
    && latestStart!.id > recoveryBoundary ? latestRun : undefined;
  if (current) {
    const tests = input.results!(current.id);
    const integrityError = input.integrityFailure?.(current.id);
    if (integrityError) tests.push({ id: '__zero_worktree_integrity__', argv: [], status: 'failed', exitCode: null, durationMs: 0, error: integrityError });
    const checkEvents = orderedEvents.filter(event => event.type === 'check.finished');
    const historicalTests = checkEvents.length
      ? checkEvents.filter(event => event.payload?.attemptId !== current.executionAttemptId)
        .map(event => event.payload?.result as CheckResult).filter(result => result && typeof result.id === 'string')
      : checks.filter(check => !tests.some(currentCheck => JSON.stringify(check) === JSON.stringify(currentCheck)));
    return { tests, historicalTests, checkEvidence: { state: 'current', runId: current.id,
      stageId: current.executionStageId, attemptId: current.executionAttemptId, status: current.status } };
  }
  if (latestStart || recoveryBoundary >= 0 || task.status === 'recovery_required') {
    return { tests: [], historicalTests: checks, checkEvidence: { state: 'historical' } };
  }
  return { tests: checks, historicalTests: [], checkEvidence: { state: 'unattributed' } };
}

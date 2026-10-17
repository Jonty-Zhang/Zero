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
    // A workflow that failed after successful validation has no endorsed final
    // checkout. Preserve those command results as history, including when a
    // reviewer or a later commit boundary observed a changed snapshot.
    && !(task.status === 'failed' && latestRun.status === 'completed')
    && latestRun.executionAttemptId === writer?.id && latestRun.executionStageId === writer?.stageId
    && latestStart!.id > recoveryBoundary ? latestRun : undefined;
  if (current) {
    const tests = [...input.results!(current.id)];
    const checkEvents = orderedEvents.filter(event => event.type === 'check.finished');
    const currentEvents = checkEvents.filter(event => event.id > latestStart!.id && event.payload?.attemptId === current.executionAttemptId);
    const integrityError = input.integrityFailure?.(current.id);
    if (integrityError) tests.push({ id: '__zero_worktree_integrity__', argv: [], status: 'failed', exitCode: null, durationMs: 0, error: integrityError });
    // Branch moves and unreadable snapshots cannot produce an attested integrity
    // record. Their machine-observed gate failure still belongs to this run.
    const legacyGate = currentEvents.map(event => event.payload?.result as CheckResult).find(result => result
      && result.id === '__zero_worktree_integrity__' && result.status !== 'passed');
    if (legacyGate && !tests.some(result => result.id === legacyGate.id && result.status !== 'passed')) tests.push(legacyGate);
    if (current.status === 'failed' && tests.every(result => result.status === 'passed')) {
      tests.push({ id: '__zero_check_run__', argv: [], status: 'failed', exitCode: null, durationMs: 0,
        error: current.terminalReason || 'Validation run failed; passing command exits do not establish a valid final checkout.' });
    }
    const historicalTests = checkEvents.length
      ? checkEvents.filter(event => event.payload?.attemptId !== current.executionAttemptId || event.id < latestStart!.id)
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

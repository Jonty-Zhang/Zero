import type { TaskSubmission, TaskSequenceRecord } from '../domain/types.js';
import type { SequenceGoalReviewRecord } from '../core/task-store.js';
import { buildGoalRevisionDraft } from '../domain/goal-revision.js';
export { GoalRevisionCapacityError } from '../domain/goal-revision.js';

/** Preserve the persisted review-state contract for ordinary scheduler callers. */
export function buildGoalRevisionSubmission(sequence: TaskSequenceRecord, review: SequenceGoalReviewRecord): TaskSubmission {
  if (review.state !== 'verdict' || review.result?.verdict !== 'changes_requested') {
    throw new Error('Goal revision requires a changes_requested aggregate verdict');
  }
  return buildGoalRevisionDraft(sequence, review.result);
}

import type { BossMessage, TaskRecord, ReviewResult } from './types.js';

/** Human requirements sealed with a reviewed tree, never reconstructed from live discussion. */
export interface ReviewRequirementsSnapshot {
  version: 1;
  taskId: string;
  prompt: string;
  acceptanceCriteria: string[];
  userMessages: BossMessage[];
  messageCursor?: string;
  replyPolicy?: 'per_message_v1';
  replyMessageIds?: string[];
}

export const MAX_REVIEW_REQUIREMENTS_BYTES = 262_144;

/** Whether a new requirement can reach a future writer or a not-yet-sealed review. */
export function canAcceptNewBossMessage(task: Pick<TaskRecord, 'status' | 'resumeCheckpoint'>): boolean {
  return ['pending', 'running', 'revision'].includes(task.status)
    || (task.status === 'waiting' && task.resumeCheckpoint?.kind !== 'review_quota');
}

/** Reject missing, malformed, mismatched or oversized evidence without dropping any requirement. */
export function assertReviewRequirements(value: unknown, taskId: string): asserts value is ReviewRequirementsSnapshot {
  const invalid = (detail: string): never => { throw new Error(`Review requirements snapshot ${detail}`); };
  if (!record(value) || value.version !== 1 || value.taskId !== taskId || !text(value.prompt)
      || !Array.isArray(value.acceptanceCriteria) || !value.acceptanceCriteria.every(text)
      || !Array.isArray(value.userMessages)) invalid('is missing, invalid or belongs to another task');
  const snapshot = value as unknown as ReviewRequirementsSnapshot;
  const ids = new Set<string>();
  for (const message of snapshot.userMessages) {
    if (!record(message) || !text(message.id) || ids.has(message.id) || message.role !== 'user' || !text(message.content)
        || !text(message.at) || !Number.isFinite(Date.parse(message.at))
        || (message.model !== undefined && !text(message.model)) || (message.harness !== undefined && !text(message.harness))) {
      invalid('contains invalid, duplicate or non-human messages');
    }
    ids.add(message.id);
  }
  if (snapshot.messageCursor !== snapshot.userMessages.at(-1)?.id) invalid('message cursor does not match its final human message');
  if (snapshot.replyPolicy !== undefined || snapshot.replyMessageIds !== undefined) {
    if (snapshot.replyPolicy !== 'per_message_v1' || !Array.isArray(snapshot.replyMessageIds)
        || new Set(snapshot.replyMessageIds).size !== snapshot.replyMessageIds.length
        || snapshot.replyMessageIds.some(id => typeof id !== 'string' || !ids.has(id))) invalid('reply targets do not match sealed human messages');
  }
  const json = JSON.stringify(snapshot);
  if (Buffer.byteLength(json, 'utf8') > MAX_REVIEW_REQUIREMENTS_BYTES) invalid(`exceeds the ${MAX_REVIEW_REQUIREMENTS_BYTES} byte evidence limit; no requirements were truncated`);
}

/** Used at both model-output and transactional persistence boundaries. */
export function assertUserMessageReplies(result: ReviewResult, requirements?: ReviewRequirementsSnapshot): void {
  const replies = result.userMessageReplies;
  const targets = requirements?.replyPolicy === 'per_message_v1' ? requirements.replyMessageIds! : [];
  if (replies === undefined) {
    if (targets.length && result.verdict !== 'blocked') throw new Error('Review replies must answer every sealed target');
    return;
  }
  if (!Array.isArray(replies) || Buffer.byteLength(JSON.stringify(replies), 'utf8') > 131_072) throw new Error('Review replies exceed the output limit');
  const seen = new Set<string>();
  for (const reply of replies) {
    if (!record(reply) || Object.keys(reply).some(key => !['messageId', 'content'].includes(key))
        || !text(reply.messageId) || !text(reply.content) || reply.content.length > 4000
        || seen.has(reply.messageId) || !targets.includes(reply.messageId)) throw new Error('Review reply has invalid or duplicate sealed message identity or content');
    seen.add(reply.messageId);
  }
  if (seen.size !== targets.length) throw new Error('Review replies must exactly cover sealed targets');
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }

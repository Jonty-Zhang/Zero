import { renderHandoffContext } from '../domain/handoff.js';
import type { HandoffV1 } from '../domain/types.js';

const MAX_HANDOFFS = 16;
const MAX_SERIALIZED_BYTES = 128 * 1024;

/** Historical, untrusted evidence has its own budget; never spend conversation or requirement space on it. */
export function bossHandoffContext(handoffs: readonly HandoffV1[] = []): { projections: string[]; omittedCount: number } {
  const projections = handoffs.slice(-MAX_HANDOFFS).map(renderHandoffContext);
  const context = { projections, omittedCount: handoffs.length - projections.length };
  // Measure the actual outer JSON, including escaping the renderer's JSON strings
  // and the omission count. Keep the most recent evidence when older items cannot fit.
  while (Buffer.byteLength(JSON.stringify(context), 'utf8') > MAX_SERIALIZED_BYTES) {
    projections.shift();
    context.omittedCount++;
  }
  return context;
}

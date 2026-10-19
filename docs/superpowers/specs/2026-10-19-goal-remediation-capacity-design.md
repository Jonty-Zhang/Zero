# Recoverable aggregate remediation capacity failures

## Problem

An accepted 10,000-character objective, a 4,000-character criterion and two legal findings can exceed the existing 24,000-character remediation prompt limit. Both tasks can finish correctly and the reviewer can return a valid changes_requested result, but the scheduler repeatedly fails to build its next task. The unchanged verdict has no automatic progress and is ineligible for the blocked-review retry endpoint. Restarting cannot resolve the deterministic size mismatch.

Keep existing prompt/check bounds and every original criterion/finding. Do not enlarge payloads, truncate evidence, consume a revision or bypass target, Git or check authorization.

## Pure construction and independent persistence

Move the pure draft builder, constants and narrow GoalRevisionCapacityError into a domain module with no IO. The existing orchestrator API remains a wrapper checking persisted verdict state. Only established prompt/check capacity guards throw that class; state, target, database and IO errors do not become capacity failures.

finishSequenceGoalReview must reread running/latest state inside its immediate transaction and confirm each conditional UPDATE changes one row. Evidence mismatch takes precedence. For a verified changes_requested result with remaining revision budget, independently reconstruct the draft from the persisted sequence and supplied original reviewer result. A known capacity failure becomes blocked with the original findings; remove targetTaskId from the blocked result but preserve the full original result/target in an atomic task_sequence.goal_remediation_blocked event. Verdict and provenance succeed or roll back together. Unknown construction errors retain existing authorization behavior.

For a previously persisted oversized changes_requested result, a narrow normalization operation independently checks exact latest source, captured evidence fingerprint, ordered step IDs, all-DONE goal eligibility, remaining budget and absence of a source-to-revision link. Recompute capacity from persisted data, then atomically append one new terminal blocked attempt and provenance/start/verdict events. Preserve the old row. Use current startup-generation semantics and timestamps strictly newer than the source; completion cannot precede creation. Concurrent append/normalization or stale inputs produce a CAS conflict.

## Scheduler and recovery

The cached path recognizes only the typed capacity error. A successful legacy normalization invokes no provider and uses no goal revision budget. Generic/transient append failures keep their existing retry/backoff behavior.

The fresh path persists its completed result outside the provider/evidence exception handler. A persistence failure must propagate with rollback intact, retaining the running attempt; it must not be overwritten by a second generic blocked verdict. Quota and genuine reviewer/evidence failures retain their existing classification. A same-generation running attempt does not trigger immediate repeated provider calls; restart/expiration follows existing review recovery.

The new terminal blocked result uses the existing explicit retry protocol. A fresh concise finding set may fit while keeping the full original criteria. If the complete user goal itself exceeds the bound, another review may still block; a smaller separately submitted goal may be necessary. No promise of automatic recovery or hidden evidence reduction is made.

The desktop goal drawer must keep the retry action reachable for those long accepted objectives. Cards and the fixed header use a bounded first-line preview; the complete objective stays in the scrollable body together with criteria. This display-only change must not alter task payloads or silently hide the original scope.

## Verification

Use failure-first Store and real HTTP/Git/TaskWorker cases; exact-size bounds, original findings/target provenance, evidence mismatch precedence, cap/quota exclusions, stale/foreign/changed inputs, full finding sets, rollback and real two-connection races. Prove accepted long input becomes blocked, HTTP retry accepts the new attempt, a concise valid review appends one task at the authoritative result and can reach PASS without losing criteria. Preserve legacy review history without provider calls. Inject persistence failure at the scheduler boundary and prove no replacement verdict or spent budget, then remove the fault and verify restart recovery.

The user delegated decisions and opted out of questions. An independent reviewer checked the design and implementation; its additional persistence-catch finding was reproduced and corrected before actual application. No schema migration, dependency, provider enrollment or broad retry-eligibility change is needed.

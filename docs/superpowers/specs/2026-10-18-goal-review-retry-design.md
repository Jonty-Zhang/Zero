# Explicit retry for blocked aggregate goal review

An ordinary transient reviewer failure becomes a persisted `blocked` verdict. The scheduler caches that verdict for unchanged evidence, so reconnecting or restarting cannot review the already-completed plan again. Add a user-triggered retry instead of an automatic provider loop.

Only a sequence with goal metadata, every step DONE, and its latest review in `verdict/blocked` may request retry. The request carries the exact latest attempt ID. Reject stale IDs, running/quota/PASS/changes_requested states, incomplete steps and missing metadata. Existing automatic remediation and its limits continue to govern changes_requested.

Persist one retry-request event on the first step, bound to sequence ID and source attempt ID. Repeat requests for the same still-current source return the same request. Do not delete or rewrite prior review history. `pendingSequenceGoalReviewRetry` returns a request only while its source remains the latest blocked verdict. Expose its requested time for the UI.

Extend `startSequenceGoalReview` with an optional source-attempt guard. Inside the same immediate transaction that inserts a fresh review, verify the request exists and its source remains latest/blocked, then record its consumption in the new start event. A second scheduler must fail this guard before a provider call. Ensure the fresh attempt timestamp is strictly later than the old latest timestamp even within the same millisecond. Preserve the existing no-active-review and quota guards.

The scheduler ignores a cached blocked verdict on unchanged evidence only when an explicit pending request exists. It still captures all evidence, invokes the independent read-only reviewer and rechecks evidence afterward. If evidence cannot be captured, consume the request into a fresh blocked attempt; never leave a request in a background retry loop. A new blocked verdict on unchanged evidence needs another explicit user action; changed evidence retains the existing fresh-verification policy. Requests survive service restarts. Once an attempt starts, its existing recovery contract applies; no claim of provider billing exactly-once is made across unknown process crash boundaries.

HTTP: `POST /api/sequences/:id/goal-review/retry` with `{"attemptId":"..."}` returns 202 and the current sequence. Missing sequence is 404, invalid JSON/attempt input is 400, conflicting state is 409, an unsupported custom store port is 501. Persist before nudging the goal scheduler. Nudge failures must not undo the request or fail completed tasks.

Public review projection adds optional `attemptId` (for legacy compatibility) and `retryRequestedAt`; new records expose their real attempt ID. The sequence drawer shows “重新验收” for eligible blocked reviews, disables it while submitting/queued, preserves the previous findings, and explains that a new review is queued. Refresh after success or conflict. The natural source-attempt identity makes uncertain POST retries safe without reusing task-creation keys.

No task status, criteria, selection, check authority, snapshot validation, revision count or cap is relaxed. All validation uses local Git/SQLite/fake adapters and isolated browser services, without real provider calls or production settings.

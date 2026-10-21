# Durable task cancellation and truthful report downloads

Baseline main: `e9dd781` (PR #10), tree `f442531`.

## Confirmed failures

A real recovered reviewer process stops after HTTP cancellation returns 202, but the task remains reviewing. After lease expiry and a proven-drained guardian restart, the worker invokes the reviewer again and can commit and mark DONE. Ordinary first-review cancellation is a successful control. The recovered catch treats explicit user cancellation like retryable recovery failure.

A separate desktop HTTP/Edge reproduction shows that canceling a quota-waiting task correctly produces failed / Cancelled by user in SQLite and task details, while its downloaded report combines failed status with the old quota error and future retry time. The report endpoint already overlays current status, so this mixed result is not an unchanged historical snapshot.

## Cancellation contract

Persist an append-only cancellation request, bound to the exact current claim event, owner and generation, before confirming active cancellation. The transaction requires a live lease and matching Store startup generation. An acceptance persistence failure must not return 202. No new user-visible task state is needed. Pending/waiting cancellation retains its synchronous terminal behavior.

After the current operation settles, a dedicated transaction can finish cancellation only for the same live claim. A subsequent guardian can instead finish it after proving the source generation drained and verifying the request against the exact owner/generation in lease-expiry evidence. Lease expiry alone is insufficient. Stop only running attempts/stages attributable to that precise claim; preserve earlier history.

Every Store admission for new execution, review, checks, rework, recovery, commit intent, report preparation or DONE independently rejects accepted cancellation. Public nonterminal transitions and revision increments must also reject it. Keep heartbeat and legitimate recording of results from operations already started before cancellation. A commit already applied or report already prepared remains a historical fact; cancellation does not roll it back or overwrite it.

The worker records intent before setting its local flag and stopping the adapter. It checks durable intent at new-work boundaries and again immediately before final DONE, after asynchronous Git validation. Recovery handles existing requests without replaying work. Acceptance and DONE compete transactionally; both cannot win. An adapter-only server without a worker cancellation callback must not falsely confirm durable cancellation.

## Report view

Use the current complete TaskRecord in the downloaded JSON, removing obsolete retry/lease fields. A failed task's displayed error comes from its current failure reason. Preserve report files and operation bytes, hashes, attempts and other historical evidence. Keep normal waiting/DONE report behavior intact.

## Verification

Freeze corrected-contract regressions before implementation and observe failure on the baseline. Use actual HTTP, SQLite, Git worktrees, TaskReviewer/CodexAdapter and a local Node child to prove cancellation stops the child, becomes terminal and cannot replay after restart. Cover quota and guardian review recovery, first-review and non-cancel controls, accepted-request crash, exact-claim/lease/generation conflicts, persistence rollback, independent connection races, and cancellation during final Git validation.

Verify candidate, applied and prepared/completed report boundaries retain existing facts. Validate report downloads against real desktop behavior while original file hashes stay unchanged. Independently review frozen files, run the canonical full suite and relevant web/API checks, commit and push, then require exact-source Linux/Windows/native/installer CI before main integration. No external provider is used by fixtures.

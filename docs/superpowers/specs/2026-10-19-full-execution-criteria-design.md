# Complete acceptance criteria for implementing agents

Baseline: main `1129a03` (PR #9), tree `cf54cd1`.

## Confirmed failure

A legal task with 21 short acceptance criteria (697 characters total) is accepted over HTTP and stored intact. The router receives all criteria, but both implementation stages receive only the first 19 plus an omission reference. The final required output is therefore absent and a real configured check fails. The 20-criterion control completes. Allowing one revision reveals the complete criteria only on that later attempt, consuming two additional writer calls and one revision.

The initial execution brief reuses `boundedAcceptanceCriteria`, which is intended for HandoffV1's 20-item, 1000-character display projection. A bare task UUID does not provide the missing requirements to an adapter. The independent reviewer already receives complete criteria, so checks prevent false completion but cannot prevent wasted implementation attempts.

## Design

Use the complete stored `task.acceptanceCriteria` when constructing each stage's primary initial execution brief. Revision briefs already supply the complete criteria. Keep the bounded HandoffV1 projection and 64 KiB validation unchanged, along with untrusted-context handling, stage objectives, routing selections, checks, claims, fingerprints, reports and Git commit authority.

Adapters pass their prompt intact. Codex uses stdin; existing-desktop ZCode uses protocol text. DSH and isolated ZCode have explicit command-line capacity refusals. Those refusals remain explicit errors; this change does not raise their budgets or silently shorten requirements. No new features or runtime permissions are required.

## Verification

Write the corrected contract first and observe failure on the baseline: 20/21 and 100 criteria, an individual criterion beyond 1000 characters, complete criteria in both writers, and quota/restart continuation without replaying the completed first stage. Check real Git output, configured checks, reports and zero content revisions. Empty criteria preserve existing behavior. Validate every generated HandoffV1 against its original count, string and byte bounds.

Run the real HTTP/two-agent/Git reproduction against the corrected build, semantic relay and rework/quota compatibility suites, adapter capacity tests, and the canonical full suite. Use local deterministic adapters only. Have the final diff independently reviewed, commit and push it, and merge only after exact-source CI passes.

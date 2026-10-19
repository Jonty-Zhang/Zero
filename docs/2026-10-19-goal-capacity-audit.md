# Goal remediation capacity audit — 2026-10-19

Baseline main: PR #8 merge b382793, verified tree a196c34. Source was prepared independently, reviewed and then copied into a dedicated branch only after matching all six reviewed SHA-256 values.

## Confirmed P2

A real HTTP submission accepted an objective of 10,000 characters and one 4,000-character criterion. Two regular tasks reached DONE with actual applied Git commits, checks and complete reports. A local fake aggregate reviewer returned two legal findings, each with 3,300-character evidence and requestedChange fields. Building the complete remediation exceeded its existing 24,000-character limit. The scheduler retried the same deterministic failure, retained changes_requested with zero revisions used, and rejected explicit retry with HTTP 409 before and after restart. The same findings with a short goal built a normal 14,536-character prompt. No external provider was called.

## Correction

Only explicit prompt/check capacity refusals have a dedicated error type. A no-IO shared draft builder lets the Store independently recalculate capacity inside its transaction. Fresh verified results become actionable blocked results when capacity prevents remediation; original findings remain unchanged and complete original reviewer result/target are retained in atomic provenance. Evidence mismatch and exhausted budgets keep their existing behavior.

Already-persisted affected results are normalized through an atomic source/fingerprint/step-ID CAS into one new blocked review, without rewriting the old attempt, calling a provider or consuming a revision. Stale/foreign inputs, incomplete tasks, changed steps, a competing append or an existing revision link cannot authorize normalization. Normal blocked-review retry remains source-bound and durable. Unknown or transient append errors retain backoff.

The independent reviewer found one additional scheduler-level flaw: an event insertion failure rolled back the correct Store transaction, then the broad reviewer catch wrote an unrelated generic blocked verdict. Its failure-first real fixture and the new scheduler regression both reproduced this. Final Store completion now executes outside provider/evidence exception handling. Persistence errors propagate with rollback intact; same-generation ticks retain the running attempt instead of invoking a provider repeatedly. Removing the fault and restarting recovers with complete provenance and no revision budget loss.

## Verification and limits

Preparation passed 78 core-related, 97 compatibility, 22 integration and eight ordinary-goal cases. After the persistence correction, 30 focused capacity/E2E/retry checks passed. The independent reviewer compiled the final source, reran its own rollback/restart counterexample successfully, and passed two quota/cap/transient compatibility cases. Its final six-file hashes matched the applied source. These overlapping focused scopes are not presented as one unique full-suite count.

Actual-checkout canonical full core verification passed 582/582, with zero failures or skips. All six core file hashes still matched the pre-run receipt afterward. Web interaction tests passed 58/58, request lifecycle 11/11, and web TypeScript/production build passed. Final-source CI and main integration remain pending and must be recorded with the resulting PR. No criteria or findings are silently shortened, and no capacity bound is raised. Some accepted goals remain too large for remediation even with concise findings; the explicit blocked state makes this visible rather than promising a retry will always fit.

## Desktop recovery UI

Real browser validation also exposed a separate display defect: the full 10,000-character objective was rendered in the fixed drawer header, pushing the scrollable content and retry action out of reach. A new interaction regression failed on the unbounded heading before correction. Sequence cards and headers now show a bounded first-line preview; the complete objective is always retained in the scrollable body alongside any criteria. No submitted data changes. Independent review approved this small web delta and passed 58/58.

Actual Edge at 1440 and 1024 desktop widths verified visible capacity reason, complete objective text, bounded header, readable findings and reachable retry. The real POST returned 202, preserved the blocked verdict while queued and disabled the duplicate retry button. There were no page errors or horizontal overflow. A legacy oversized verdict normalized without any provider call or revision-budget use. Validation is focused on agents running on the computer; viewport checks do not create a mobile agent runtime.

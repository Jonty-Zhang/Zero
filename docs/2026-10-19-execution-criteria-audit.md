# Execution criteria delivery audit — 2026-10-19

Baseline main: `1129a03`, the PR #9 merge. Its signed merge object, both parents and exact tested tree `cf54cd1` were verified locally; GitHub and local main matched. PR #9 push and PR CI both passed Linux and Windows, including core 582/582 on Windows, 578 with four platform skips on Linux, web 58/58, request lifecycle 11/11, native guardian and installer/manual-launch/uninstall/data-retention checks.

## Confirmed P2 and correction

A task with 21 short criteria, 697 characters in total, is admitted over HTTP and stored intact. Both writers receive only the first 19 plus an omission reference. A criterion requiring a specific file never reaches them, so a real Node check fails. With 20 criteria the control completes. With one revision allowed, the identical 21-criterion task succeeds only after a complete extra two-writer cycle: revision briefs reveal the full criteria that were omitted initially. Checks prevent false completion, but the execution budget is wasted.

`TaskWorker.#initialExecutionBrief` reused HandoffV1's bounded display projection. The correction uses the complete stored criteria for every initial execution stage. Ordinary revision briefs already do so and remain unchanged. HandoffV1 still has its original 20-item, 1000-character-per-item and 64 KiB limits. Routing, stage objectives, checks, task ownership, Git and report authority are unchanged.

The adapter audit found no additional silent prompt truncation. Existing explicit command-line and protocol size refusals remain. A sufficiently large complete prompt can still exceed an adapter's capacity and fail explicitly; this fix does not promise that every admitted input fits every provider.

## Failure-first verification

Seven regression cases cover no criteria, 20/21/100 criteria, an individual criterion beyond 1000 characters, and route/execute quota followed by guardian restart. Both writers must receive all criteria; the finished first stage must not replay; no content revision is consumed; real checks, applied Git output and complete reports are required. Stage objectives, selected models and original check definitions must remain intact. Generated handoffs must still pass their bounded schema.

On the baseline, the two controls passed and five cases failed. The independent real HTTP/Git reproduction likewise passed the 20-item control and failed its corrected full-delivery contract for 21. After the one-line correction, all seven cases passed, and both HTTP cases completed in their first pass with revisionCount zero. Regression expectations were frozen before changing production code. A later test-only refinement adds guarded cleanup of generated fixtures; it changes no assertions. Investigation evidence remains under ignored verification directories.

The actual checkout's HTTP/Git reproduction also passed 20/21/100 criteria, asserting every complete criterion in both writer requests. All three tasks reached DONE with real passing checks and revisionCount zero. Isolated compatibility verification passed 68/68, including explicit DSH/ZCode argv capacity refusal, HandoffV1/store validation, semantic relay with ordinary rework and failed checks, and rework quota/restart cases. Isolated TypeScript checking passed. These focused checks overlap the full suite and are not added to its unique test count.

Final independent Astra high review approved the frozen files, checked their exact hashes and one-line production diff, compiled in a separate directory and passed all seven new regressions. An additional isolated final run passed those seven cases plus the existing oversized-handoff fallback test (8/8), including guarded fixture cleanup.

The actual checkout's canonical `npm test` passed 589/589 with zero failures or skips (863007 ms). Both reviewed source hashes still matched the saved full-run receipt afterward. The public-tree check passed for all 166 tracked files, and both working/staged diff checks passed. Web code is unchanged in this round; final exact-source Linux/Windows CI remains required before integration.

All fixtures use local deterministic adapters and real SQLite, Git worktrees and configured checks. No external provider was invoked. Exact-source CI and main integration remain pending and must be recorded in the resulting PR.

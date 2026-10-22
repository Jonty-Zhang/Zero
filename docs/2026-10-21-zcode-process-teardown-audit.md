# ZCode process teardown audit

Baseline: local cancellation/report commit `176e0ee65401ddb904663b2e77029378c873f9a1`. Publication is still blocked by the absence of GitHub authentication in the repository-contained configuration. No remote update or main merge is claimed.

## Reproduced failures

Two complete test runs failed the existing ZCode stdin-close test. An isolated real-process reproduction established that `fail()` and `closeProcess()` could launch separate Windows tree-termination commands. The first command killed the root and descendant; the second returned PID-not-found, causing cleanup to be reported as failed.

Preserving the first promise exposed two additional paths that had previously hidden its result: close could return after root exit while the tree operation remained pending, or return successfully after a genuinely failed tree operation left a descendant alive. Three identical regression controls failed against the baseline and passed against the first candidate. The negative control uses an actual missing executable and a real detached descendant; root exit is not treated as proof of tree cleanup.

The first candidate was withheld after the existing peer suite passed only 28/31 tests. Instrumentation established two further causes. Closing stdin while a failure teardown was already pending let the root exit before the real tree command found it. Separately, a successful tree command could be followed by a redundant root kill before Node observed the exit event; that second kill returned false and manufactured a failure. Two isolated controls failed against the first candidate and passed after correcting these paths.

Injected launch latency and a delayed Node exit observation make the races reproducible. They are explicit fault controls, not claims about measured normal operating-system latency. Positive controls execute the real Windows tree command and verify both root and descendant dead. Negative controls verify that a live descendant keeps the tree failure observable, then independently clean up both known processes.

## Required behavior

Failure handling and close must share one termination promise. Every close return must await a previously started tree operation. Close must preserve a live root while that operation owns the tree. A successful Windows tree command must not be followed by a redundant root fallback; a failed command must retain its failure even if direct-root fallback succeeds. Close must still confirm the root close event.

## Verification status

The second production candidate passed the unchanged 31 existing peer tests plus the original three regression controls, 34/34 with exit 0. The two additional causal controls also passed independently and are included in a second tracked regression file. GPT-6 Astra high approved the exact three-file patch after a fresh compile and five-control real-process run, exit 0.

After root integration, the two regression files were hardened to record both PIDs and preserve the fixture when process cleanup cannot be confirmed. Cleanup failures retain the original error as well. The reviewer approved this test-only diff; all five business assertions and cleanup gates remain intact. Root compilation passed, and the final applied files passed all 36 peer and teardown tests together with exit 0. Every process receipt confirmed both known PIDs absent. Repository-wide success is not claimed from these focused results; a new complete run is still required.

On October 22, the restricted sandbox denied Windows taskkill with Access denied. That failed execution is retained as environment evidence, not as a product regression. The reviewer identified only the affected fixture command lines, obtained automatic approval for their cleanup, and verified no fixture processes remained. The subsequent minimal approved control run passed. A reviewer compile command also initially resolved a relative output path outside the repository; sandbox denied it. It was corrected to an explicit repository-contained absolute path and compiled successfully, without reading the denied destination or requesting outside-file access.

The preceding complete cancellation/report run ended with 617/620 passing. Its other two failures involved an incomplete handoff snapshot and a worktree-creation recovery result. Instrumented isolated reruns passed, but the original tests removed their fixture details; their exact historical Git errors remain unproven. The next complete run must retain enough diagnostic information to investigate any recurrence.

All verification after the user's boundary instruction uses files, fixtures, caches and configuration inside this repository. Failed and superseded reproductions remain retained there and are not represented as passing results.

## Complete-run follow-up, October 22

The subsequent complete core suite finished with **639/639 passing and exit 0**, including all 36 ZCode peer/teardown cases and the previously failing quota and aggregate-evidence cases. The diagnostic observer was enabled and concurrency remained at its default. All 178 source/build hashes matched the run-start receipt and current applied source. This supersedes the pending verification status above; it does not establish the historical underlying Git errors of the two earlier failures. The earlier failed logs remain retained. Exact command, counts and hashes are documented in [the full regression audit](2026-10-22-full-regression-audit.md). GitHub publication remains unfulfilled.

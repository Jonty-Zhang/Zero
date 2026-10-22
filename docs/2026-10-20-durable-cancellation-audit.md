# Durable cancellation and report consistency audit

Baseline: main `e9dd7812e9c4cd030cac29bcb184dce92fd53bdf`, following PR #10.

## Reproduced behavior

A recovered reviewer was stopped by HTTP cancellation, but its task remained `reviewing`. A later verified guardian restart invoked review again and could commit the result and mark the task DONE. An ordinary first-review cancellation served as the successful control. Reproduction used SQLite, real Git worktrees and the actual Codex adapter/process runner with a local Node reviewer child, without calling an external provider.

Canceling a quota-waiting task also produced contradictory report downloads: SQLite and the desktop task drawer showed `Cancelled by user`, while the downloaded JSON retained the old quota error and future retry time. The download endpoint already projected current task status into its response. Original report files were unchanged.

## Required behavior

Active cancellation must be durable before HTTP 202. Bind the request to the exact latest claim event, lease owner and startup generation. The live worker may finalize after its operation settles; a later startup needs a complete verified guardian drain chain. Expired leases alone cannot establish that child processes have stopped.

Accepted cancellation must prohibit new work and DONE without losing results of operations already started. Preserve candidate/applied commit evidence and prepared/completed report bytes. A missing cancellation report may be created after successful terminalization without overwriting an existing archive. Downloaded reports must use the complete current task and current failure reason while preserving historical evidence.

## Failure-first evidence

The isolated regression suite reproduced cancellation replay, rollback and custody conflicts before implementation. Independent review then found additional failures: a failed cancellation finalization followed by another guardian restart, cancellation accepted during asynchronous error handling, and candidate creation after cancellation arrived during a Git await. The four added counterexamples failed before their corrections and passed afterward.

An unchanged existing worker test also caught a missing report after canceling validation. The compatibility correction creates a failed report only when there is no persisted report operation or existing archive, using exclusive file creation.

A further independent review reproduced two recovery paths that could replace an accepted cancellation with a quarantine state. One used the worktree-creation recovery API; the other used actual HTTP cancellation while the worker awaited execution-recovery I/O. Both left the cancellation request pending and prevented a later guardian from completing it. The correction must give the accepted request priority in those transactions and recheck cancellation in the worker's error paths.

The reviewer also reproduced stale recovery metadata on a canceled terminal task. Current task fields must clear those hints while the cancellation event retains the original recovery evidence.

The six implementation/test files have been integrated into the working branch with SHA-256 verification. The implementation contains three production-file changes; the other three files are new regression suites. Independent verification of the original three counterexamples, multi-hop guardian finalization and the existing validation-cancellation control passed against the frozen production hashes. Web tests passed 58/58 and API tests passed 11/11.

The first combined run exposed a JSON assertion that compared an archive with unserialized optional fields, plus fixture timeouts. Those failures are retained. The corrected fixture compares the actual JSON projection, preserves all cancellation/history assertions, uses a bounded 120-second startup/I/O/cleanup budget, and preserves both original and cleanup errors. This is test-only; the production hashes remain unchanged. Under the concurrent full run, existing successful Git cases also took 17–51 seconds.

The v3 affected-case differential run passed 9/9. GPT-6 Astra high independently approved the final six-file patch after isolated compilation, six HTTP/commit/report cases and verification of the independent counterexamples and existing cancellation control. The complete canonical run against the final test hashes and publication receipts remain pending. Passing focused regressions do not establish that the complete change passes the canonical suite.

The root's earlier intermediate canonical run completed 624 tests with 617 passing and seven failures: five used the superseded fixture budgets; two existing process/aggregate-goal cases also failed. Those two existing cases passed a separate two-case check on the final build. The complete intermediate log is retained; the separate check is not represented as a passing full run.

The final-version canonical run completed with exit 1: 620 tests, 617 passing and three failures. The existing ZCode stdin-close teardown failed again; an existing multi-agent rework/quota test failed while capturing a worktree snapshot; and an existing aggregate-evidence test reached worktree recovery instead of DONE. The latter test failed before its four nested scenarios were registered, accounting for the total of 620 rather than 624. There were no canceled or skipped tests. All new cancellation/report regressions passed in this run. Separate observed reruns passed the quota scenario (1/1) and aggregate-evidence scenarios (5/5); their original underlying Git errors remain unconfirmed because the existing tests removed their fixtures and omitted the causal recovery details. Those passing controls do not supersede the failed complete run.

Separate deterministic diagnosis confirmed concurrent Windows tree-kill calls can turn successful cleanup into a false failure. Additional process-lifecycle checks found that an existing tree-operation result could also be skipped after root close. That correction is being developed separately, and its first candidate was withheld when the existing peer suite exposed further failures. This cancellation patch is not represented as repository-wide green or merged to main.

An independent root HTTP/Git/process reproduction passed against the frozen implementation: HTTP 202 stopped the real local reviewer child, persisted failed / Cancelled by user, served the correct report, and a subsequent guardian startup performed no review, write, check or commit replay. An initial short startup-wait failure and a subsequent proof-server lifecycle mistake were corrected in that verification script, with the failed logs retained separately.

## Workspace boundary

The user subsequently prohibited file access outside this repository. Further verification uses repository-local temporary directories, tool caches and configuration paths. Existing evidence generated before that restriction is retained in place. No external skill files or browser dependency folders are used after the restriction.

The GitHub CLI configured exclusively inside the repository has no authenticated session, and no GitHub token is present in this process environment. Reading or copying credentials from an external user directory is outside the current authorization. Local implementation and verification can continue; publication must not be claimed without a verified remote receipt.

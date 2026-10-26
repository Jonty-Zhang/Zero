# Accepted human requirements at writer boundaries

## Reproduced gap

Boss planning and acceptance could read saved human messages, but implementation
requests contained only the original task, acceptance criteria, stage objective
and prior executor handoff. A stage objective could summarize a requirement
without retaining its exact details. A message added during routing or a quota
pause could also miss the next implementation request entirely.

Before the fix, three real worker regressions failed: messages submitted while
planning was quota-paused, messages submitted while a writer was quota-paused,
and an original supplementary requirement missing from the first writer. Each
failure inspected the actual Harness request, not a model's claim to have read it.

## Corrected behavior

Immediately before each Boss implementation/revision Harness call, the worker
synchronously reads the persisted human messages and includes their complete
original wording in chronological order. This shared boundary covers first
execution, later Harness stages, check-requested revisions, reviewer-requested
revisions and resumed quota attempts. It also includes messages accepted while
the routing call was still in progress.

Only messages with role `user` enter this requirement block. Boss and consultant
discussion retain their existing context/provenance paths; they are not promoted
to human instructions. The block explicitly preserves stage scope, permissions,
verification and the lead's acceptance gates. It does not change allowed paths,
the check contract, cancellation handling or the conservative recovery rules.

Messages arriving after an executor starts remain available for the next safe
processing boundary. The change does not interrupt an active executor, replay a
completed stage, or treat a stored message as proof that its requirement is met.
The Boss plan's message cursor continues to describe planning input, rather than
claiming to be an implementation or acceptance receipt.

## Verification

The four focused post-fix tests passed with real Git worktrees, SQLite, checks
and task lifecycle transitions. They cover both quota boundaries and initial
execution followed by either check-requested or reviewer-requested rework. The
tests verify that exact human text reaches requests, model-only discussion is
excluded and the frozen checks remain unchanged. A cross-Harness regression also
asserts the second Harness receives the exact supplementary requirement.

The TypeScript build passed. An independent reviewer found no confirmed
actionable defect, separately compiled the source into its own output directory
and passed five integration tests covering consultation cancellation, both quota
boundaries and both revision causes. Its report and logs are in the ignored
directory `data/verification/boss-writer-review/`.

The broader affected-worker run passed **100/100 tests, zero failures and zero
skips**, across nine files. It includes Boss planning, serial cross-Harness
handoff, original acceptance criteria, worker heartbeat loss, durable HTTP
cancellation, review rework quota and ordinary worker crash/review/commit/report
recovery. It finished with exit 0 after 942140 ms. This is an affected-suite run,
not a claim that the entire backend suite was rerun for this change.

Evidence, including pre-fix failures, is retained under the ignored
repository-local directory `data/verification/boss-human-context-root/`. No real
model provider or user service was used.

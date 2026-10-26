# Review reasoning effort follows the selected model

## Reproduced failure

The task and aggregate goal reviewers selected `high` from the Codex CLI's
general capability list. That list describes CLI support, not the effort levels
verified for each configured model. Selecting a model verified only at `medium`
therefore reached the real Codex adapter with `high`; its binding validation
rejected the request and acceptance became blocked after implementation.

The same problem affected models verified only at `low`, bindings that expose
only the CLI default, and a verified effort absent from the generic CLI list.
Explicit efforts verified only for a different model were also rejected too
late, inside execution rather than before the review request.

The original 13 regression cases produced 11 failures and two passing `high`
controls before the production change. They use real Codex capability probing,
binding resolution, preparation, execution handling and Git-backed review
snapshots. Version/help responses and the final child output are deterministic
local fixtures; no provider is contacted.

## Corrected behavior

Codex reports a per-model effort map from bindings valid for the probed CLI
version. Both reviewers use the selected model's map, preferring `high`, then
`medium`, then an available level. An empty list leaves effort unspecified for
the CLI default. An explicit incompatible effort fails before constructing the
review snapshot or invoking the adapter. Efforts are never borrowed from a
different model's binding.

Older adapters exposing only a general capability list retain their existing
behavior. Manual Codex bindings without an explicit effort list retain the
adapter's existing supported defaults. This does not enroll any model, change
verification evidence or skip runtime binding checks. Boss acceptance continues
to use its persisted lead selection.

## Verification

The final affected run passed **102/102 tests with no failures or skips** across
six files: the new effort regressions, router/task review, single- and
multi-repository goal review, adapters, and runtime binding guards. The
TypeScript build passed. The new file contains 17 cases, including automatic
model selection, explicit rejection, stale CLI bindings, empty maps and legacy
configuration compatibility.

An independent reviewer found no confirmed actionable defect. Its separate
compilation passed, as did the original 13-case version of the new regressions
and five additional independently authored boundary cases. Those cover legacy
capabilities, authoritative empty maps, manual binding defaults and array
isolation, failed CLI help, and the real runtime guard closing admission after
proof changes. Its report is in
`data/verification/reviewer-model-effort-review/final-review.md` (ignored).

Repository-local evidence is retained under the ignored directory
`data/verification/reviewer-model-effort-root/`. `red.log` records the confirmed
pre-fix failures; `affected.log` and `affected-exit.json` record the final run.
An initial fixture used an unrecognized output field; its failed run is kept
separately as `initial-fixture-output-mismatch.log`, and was corrected before
the authoritative red run. No frontend files changed in this round.

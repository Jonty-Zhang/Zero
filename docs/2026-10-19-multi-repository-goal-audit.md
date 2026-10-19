# Multi-repository goal audit — 2026-10-19

## Reproduced defect and scope

On main `95b0766`, two independent repositories' tasks could complete with real applied Git commits, successful configured checks and complete reports, yet aggregate review always became `blocked` because the sequence spanned repositories. Restart and explicit retry repeated the same refusal without calling the reviewer. The no-goal mixed-repository control completed normally. This was a missing supported workflow after admission, rather than a provider failure.

The reviewed [design](superpowers/specs/2026-10-19-multi-repository-goals-design.md) and [implementation plan](superpowers/plans/2026-10-19-multi-repository-goals.md) retain the existing Node/SQLite/Git/React architecture. Each new writer still works in one repository. One independent read-only reviewer observes every repository and can choose one current repository tip for the next bounded remediation.

## Changes under verification

- Group authoritative results by persisted/live Git common-directory identity. Require linear handoffs within each group, including interleaved A → B → A sequences. Use the first registered creation base for cumulative diffs, so writer self-commits are included; reopen the final task using its own immutable creation evidence.
- Build a namespaced index-blob snapshot bundle with shared file/content budgets and stable mapping/hash. Reject unsafe inherited instructions/configuration, source overlap, untracked or unsupported indexed content, and changed source indexes. Existing single-project layout remains available.
- Keep whole review-input fingerprints separate from snapshot fingerprints. Capture all sources before review, bind the actual immutable request data, and revalidate all final sources afterward. A non-target repository changing invalidates the aggregate verdict.
- Require an exact current target for multi-repository `changes_requested`. Authorize the persisted target and its linear result/package/check/report chain again inside the append transaction. Retain revision budgets, immutable attempt/task links and restart/idempotence gates.
- Build remediation from the selected repository's checks, permissions and local acceptance criteria. Expose the target in HTTP and the goal drawer; list repository paths alongside sequence steps.

## Review findings addressed

Independent snapshot review reproduced a Windows cleanup race: an unmerged index caused one metadata subprocess to fail while sibling Git processes still held the source directory. Metadata batches now await every child before rethrowing. Another correction validates source overlap before creating the artifact directory. Both have failure-first regression coverage.

Transaction review required proving the whole selected group's lineage, rather than accepting its latest task alone, and rejecting historical mixed-root no-target fallback. It also required canonical planned paths and exact package/check execution and completion-event associations. These checks prevent direct Store callers from bypassing scheduler evidence validation.

## Verification record

All new executions use real local Git worktrees/SQLite and deterministic fake provider adapters. No paid provider request or production binding change is part of this round.

- Initial defect reproduction refreshed against main `95b0766`.
- Shared design/type contract passed typecheck and was pushed as `f804b15`.
- Snapshot unit pushed as `4c97857`: implementer 33/33 bundle and legacy compatibility tests; independent reviewer 15/15 bundle tests plus 10/10 repeated cleanup/drainage cases.
- Target transaction unit pushed as `bd3d6b0`: implementer 144/144 Store/sequence/retry/revision tests; independent reviewer 58/58.
- Real Git multi-repository workflow 12/12; independent focused reviewer/integration/evidence suite 25/25; HTTP/retry suite 11/11. Isolated read environment/manager/snapshot regressions 36/36, including original Git objects under replacement refs.
- Web interaction suite: 33/33 passed; web TypeScript and production build passed. Target HTTP projection regression passed.
- Edge at 1440 px and 375 px against a local HTTP server and real SQLite: selected earlier target and both repository paths visible, target navigation correct, no horizontal overflow or page errors.
- The merge gate requires a canonical full run and exact-head Linux/Windows CI after any corrections. Final commit-specific results and the merge receipt are recorded with [PR #6](https://github.com/Jonty-Zhang/Zero/pull/6), separately from the focused runs above.

The requested Astra high final reviewer hit an account usage limit before returning a conclusion. That attempt is not recorded as an approved review; the completed boundary reviews above remain separately documented.

The retried configured Astra high reviewer subsequently approved source `e8941b9`, with an independent isolated compile and 13/13 protocol/read regressions. A separate available reviewer also approved its static audit. These reviews did not replace full-suite verification.

## Full-suite findings and corrections

The first canonical local run on `e8941b9` reported 555 tests: 552 passed, 3 failed. The failures represented two underlying conditions (one parent/child failure pair). Linux CI passed 551 with four platform skips, while Windows CI reproduced the goal-recovery failure (553 passed, 2 failed). The branch stayed draft.

1. A configuration writer could acquire `BEGIN IMMEDIATE`, replace JSON once, then fail `COMMIT` when an overlapping SQLite reader delayed its exclusive lock. A deterministic held-reader CLI regression reproduced the raw `database is locked` exit in 137 ms. The correction retries only lock acquisition or COMMIT asynchronously within the existing bound; it retains ownership and never repeats the configuration mutation. Both config suites passed 31/31.
2. Disabling system/global Git config during worktree inspection also removed Windows `core.autocrlf=true`. A normal restore wrote CRLF; ordinary Git correctly reported clean, while the isolated environment reported a modification. Existing index stat caches sometimes masked the mismatch, explaining the earlier focused passes. The correction reads and pins only effective `core.autocrlf`/`core.eol` scalars and binds them into whole-goal evidence. A real-Git failure-first regression checks global CRLF, local overrides, safe defaults, bool aliases, redirected config rejection, retained fsmonitor isolation and detection of actual content changes. Indexed snapshots remain canonical blob bytes.

The reviewer independently approved both narrow corrections and reran their two focused regressions successfully. The corrected source requires a new frozen full-suite/CI run before merge; its exact results are retained in the PR's checks and validation record.

## Remaining boundaries

Results remain in Zero's task worktrees. This does not move native agent conversations, merge source branches, or migrate claim-time repository identity across separately submitted checkout roots. A divergent common-directory group remains blocked. Large source bundles/evidence remain bounded rather than silently truncated. Mixed-repository plans can be supplied through API/CLI JSON and, since PR #7, the web form's per-step repository/Ref overrides; progress and remediation targets remain visible in the goal drawer. See the [web workflow follow-up](2026-10-19-web-workflow-audit.md).

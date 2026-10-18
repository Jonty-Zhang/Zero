# Multi-repository goal verification and targeted remediation

## Intent and observed failure

An API/client plan can span separate Git repositories. Zero currently accepts its goal metadata and completes every ordinary task, then permanently blocks aggregate review because it supports only one final worktree. Real Git/HTTP/TaskWorker reproduction and the no-goal control are recorded in `data/verification/continuous-sequence/multi-repo-goal-audit.md`. This round implements the missing complete workflow, including bounded remediation in an earlier repository. It retains one ordinary writer per task.

The implementation choices below are the maintainer agent's decisions under the user's standing instruction to proceed without questions. Retain Node 24, TypeScript, SQLite and the existing React UI, without new dependencies. Use disjoint subagent ownership and independent review. Commit and push incremental verified units; merge only a verified final tree.

## Repository identity and authoritative lineage

Group steps in first-appearance order by the real Git common directory, with Windows-only case folding. Use stable opaque `repo-1`, `repo-2`, etc. namespace IDs; never use basenames or caller paths as namespace components. Compare live identity with each task's persisted created-worktree plan/observations. At most 20 repository groups are allowed, matching initial sequence admission; remediation cannot introduce a repository.

For every task retain the exact existing applied commit -> sealed review package -> completed check run/results -> complete report association. Within each group, every task after the first must have the persisted effective base equal to the preceding task in that group's authoritative result commit. Different roots of one common directory that fork into independent chains remain blocked; do not silently discard either branch or change claim-time handoff identity in this round.

Use the registered creation plan's immutable base commit to reopen a group's final task worktree, checked against its sealed package's snapshot.baseCommit and effective handoff where applicable. A singleton group normally has no sequenceBaseCommit. Never resolve the user's mutable baseRef to choose a review base. An applied commit preHead may be a later writer self-commit; validate its exact package linkage separately and never confuse it with the registered initial base. Each final branch HEAD/index must match its applied result and remain clean. Per-group cumulative diff runs from its first task's registered creation base to its final result, including legitimate writer self-commits. Preserve binary/UTF-8 checks and use an isolated Git environment.

## Trusted multi-source review input

Add `createTrustedGoalCwd({ artifactRoot, repositories })` in `trusted-codex-cwd.ts`, where each `GoalProjectSource` is `{ repositoryId, targetTaskId, taskWorkspace }`. It returns `{ cwd, projectSnapshots, manifestPath, contentSha256, dispose() }`; each project snapshot pairs its source mapping with the existing `ProjectSnapshot`. Repository IDs must match `^[A-Za-z0-9_-]{1,64}$` and be unique; task IDs are bounded metadata, never file paths.

Create one fresh trusted Git cwd with separate `review-context/projects/<repositoryId>/project` and per-project manifests, plus `review-context/repositories.json`. Reuse the actual index-blob snapshot pipeline, not raw directory copying. Keep safe Git environment, instruction/config remapping, symlink/submodule/unmerged-index refusal, coverage/exclusion records, ancestor controls, overlap validation and guarded disposal for **every** source. Global limits across all repositories are 10,000 files and 64 MiB blob bytes; per-file limit remains 8 MiB. Preflight remaining budgets before reading another repository's blobs. A failure cleans only generated directories. Existing single-source API/layout stays unchanged.

The bundle content fingerprint binds ordered repository IDs, target task IDs, each HEAD/index tree, source content hashes and deterministic relative snapshot paths, never temporary cwd names. All coverage/exclusion/transformation metadata remains inspectable. Main's evidence package is still globally bounded at 512 KiB, and cumulative diffs together at 192 KiB, rather than multiplying limits per repository.

## Goal review protocol

Add `GoalReviewResult extends ReviewResult { targetTaskId?: string }` for aggregate records only. Ordinary task review keeps its strict existing schema/parser.

`GoalReviewInput` retains its legacy workspacePath and adds optional `repositories: GoalProjectSource[]`. With one source use the existing layout/schema and legacy verdict behavior. With multiple sources use the trusted bundle and a dedicated goal schema adding required nullable `targetTaskId`; missing target fields are invalid in this mode, including PASS. PASS/blocked require null; changes_requested requires the exact final task ID of one current repository group. Reject unknown keys, malformed responses, foreign/stale/earlier task IDs, and missing multi-repository targets into a persisted blocked result before remediation. Single-repository legacy changes_requested without a target continues to use its final step.

The reviewer sees every group's cumulative diff, authoritative task/check/report evidence, snapshot manifest and global objective/criteria in one read-only session. For changes_requested, choose one safe next repository and describe findings to address there; remaining repositories are reconsidered by the next aggregate review. If no safe single-repository next action exists, return blocked. Do not ask one writer to modify multiple repositories.

`GoalReviewExecution` retains legacy `projectSnapshot` when using the single-source path, and exposes `projectSnapshots` for the bundle. Its scalar evidenceFingerprint/verifiedSnapshotFingerprint retain their snapshot-only meaning: the legacy content hash for one source, or the complete ordered bundle content hash for multiple sources. Add inputFingerprint, computed by an exported goalReviewInputFingerprint helper over a captured immutable copy of objective, acceptanceCriteria, stepEvidence and ordered source mappings (including workspace paths). Main compares this exact input hash separately from snapshot hashes and its broader persisted evidence hash. Main recaptures every repository after the provider exits. Changed non-target state invalidates PASS and changes_requested as well. Retry caching, explicit retry CAS, generation and quota contracts remain intact.

## Persistent target authorization and remediation

`finishSequenceGoalReview` and aggregate getters accept the goal-only result subtype and validate the optional target's shape. `appendSequenceGoalRevision` must independently authorize an explicit target inside its immediate transaction: latest exact changes_requested attempt, all tasks DONE, remaining budget, target belongs to this sequence and is the latest tip of its persisted common-directory group, matching registered creation identity and authoritative report/commit evidence, and submission.repoPath equals its canonical target root. It derives the new base solely from the target's authoritative applied commit. No Git subprocess runs in the transaction. Missing group identity cannot authorize a guessed target. Existing no-target single-root records keep the old final-step behavior.

The transaction must also validate the target group's entire persisted linear chain, including creation/package bases, effective handoffs and authoritative results; a divergent group cannot be authorized by calling the store directly. Historical mixed-root tests that assumed a no-target final-step fallback must be corrected, with separate refusal coverage.

One review attempt appends at most one task and consumes one existing maxGoalRevisions unit. Preserve immutable attempt-to-task links, duplicate/restart safety, claims, regular task checks/review/commit/report and quota recovery. Record target task/group/base in the append event. The target must agree with existing exact-repoPath claim-time predecessor resolution.

`buildGoalRevisionSubmission` selects the explicit target or the legacy single-root final step. Inherit only that target's final checks; union allowed paths only from tasks in that target root, preserving an absent allowlist's existing meaning within that repository. Another repository's unrestricted permissions cannot broaden the target. Retain global criteria in untrusted context. For multiple repositories local acceptance criteria are the target task's local criteria (or an explicit repository-scoped remediation criterion), not global outcomes its ordinary reviewer cannot observe. For a single repository preserve existing goal-level acceptance behavior. The next aggregate review remains responsible for the entire objective.

Expose the selected target in aggregate HTTP projection and the goal drawer, including its repository label/path where available. Keep previous findings, current retry controls and legacy projections usable.

## Verification and exclusions

Use real local Git/SQLite/TaskWorker and fake adapters; no paid provider call or production binding edit. Required cases: A->B PASS; A->B->A chained PASS; singleton groups and identical basenames; divergent linked worktree chains blocked; target A while B is global-last; A-only checks/permissions and writes, B unchanged; invalid/missing/foreign/stale targets blocked and retryable; duplicates, restarts, quota and revision cap; missing package/check/report, dirty index/head/content in either group; non-target mutation during provider call; snapshot instruction/config/symlink/submodule/global-budget protection; single-repository fixtures and no-goal mixed repositories remain compatible. Independently review the design and final branch, run full core/web/client/build/public-tree and exact-head Linux/Windows CI, then verify GitHub main contains the tested tree.

This does not transfer native conversations, merge source project branches, add parallel writers or migrate handoff identity across separately submitted worktree roots.

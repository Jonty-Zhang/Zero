# Multi-repository goals implementation plan

> **For agentic workers:** Use subagent-driven-development with disjoint file ownership; root integrates and an independent reviewer checks each boundary. Steps use RED -> GREEN and fixed-snapshot final verification.

**Goal:** Complete and, when necessary, safely remediate a goal spanning multiple repositories using one independent aggregate review.

**Architecture:** Preserve authoritative task evidence and group its linear results by proved Git identity. Build a bounded namespaced review bundle, bind verdicts to the complete before/after fingerprint, and atomically append one repository-targeted ordinary remediation task.

**Tech Stack:** Node 24, TypeScript, SQLite, Git worktrees, React; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-19-multi-repository-goals-design.md`.

## Global constraints

- Global snapshot limits: 10,000 files, 64 MiB total blob bytes, 8 MiB per file; at most 20 repository groups.
- Global goal limits: 512 KiB JSON evidence, 192 KiB cumulative diffs, existing maxGoalRevisions and task revision/permission/check gates.
- Single-source review layout/schema stays compatible. Ordinary task review schema is unchanged.
- Local fixtures/fake providers only. Independent compilations use ignored outDirs; do not replace a shared frozen full-test dist.
- Do not ask routine questions. Record decisions, commit and push verified units frequently; verify exact CI/main tree before delivery.

## Review focus

- Different checkout roots of one Git common directory must not hide divergent completed work.
- A singleton repository has no sequenceBaseCommit; only persisted registered creation evidence authorizes its base.
- Mutations in a non-target repository during review must invalidate the whole verdict.
- A repository with no allowlist must not erase another repository's path restrictions.
- Retry, reboot or competing schedulers must not append another task or consume another unit for the same verdict.

## Task 1: Reproduction, design and shared contracts (root)

**Files:** this plan/spec; `src/domain/types.ts`; root/new test helpers as needed.

- [x] Re-run the saved real two-repository reproduction against main 95b0766 in an ignored build and confirm goal blocks while no-goal completes.
- [x] Independent builder review of design/interfaces; resolve project/minor decisions in the written spec.
- [x] Add aggregate-only GoalReviewResult and sequence record typing, retaining ordinary ReviewResult.
- [x] Typecheck targeted contracts and commit/push design/contracts (`f804b15`).

## Task 2: Trusted multi-source snapshot bundle (snapshot agent)

**Files:** `src/orchestrator/trusted-codex-cwd.ts`, existing/dedicated trusted cwd tests.

**Produces:** exported `GoalProjectSource { repositoryId: string; targetTaskId: string; taskWorkspace: string }`; `GoalProjectSnapshot { source: GoalProjectSource; snapshot: ProjectSnapshot }`; `createTrustedGoalCwd(options: { artifactRoot: string; repositories: GoalProjectSource[] }): Promise<{ cwd: string; projectSnapshots: GoalProjectSnapshot[]; manifestPath: string; contentSha256: string; dispose(): Promise<void> }>`.

- [x] RED: read two same-basename repositories through separate safe namespaces; stable combined hash changes when either source or target mapping changes.
- [x] RED: duplicate/unsafe IDs, overlap with any source, instructions/config in any inherited chain, symlink/submodule/unmerged/untracked source, changed Git index, global budgets and guarded disposal.
- [x] Implement shared budget-aware index snapshot writer and bundle without changing the existing API/layout. Export the existing safeGitEnvironment helper for server evidence capture.
- [x] GREEN: trusted cwd suite and isolated typecheck; independent review; root commits/pushes the verified unit. Implementer 33/33 compatibility; independent 15/15 bundle tests and 10/10 repeated failure-path cases.

## Task 3: Persistent target and local remediation (core agent)

**Files:** `src/core/task-store.ts`, `src/orchestrator/goal-revision.ts`, dedicated core/goal revision tests. Domain shared contracts are root-owned.

**Consumes:** `GoalReviewResult.targetTaskId?`; existing aggregate attempt/request and authoritative task evidence.

- [x] RED: latest A tip can be targeted while global-last is B; append uses A result base and one budget unit; duplicate/reopened/competing requests append once.
- [x] RED: foreign/earlier/ambiguous/missing-identity target, mismatched repository submission and exhausted budget refuse writes; no-target legacy single-root remains usable.
- [x] RED: target-local checks, permissions and acceptance criteria; unrestricted B does not broaden restricted A.
- [x] Implement transaction-local persisted group authorization and target-aware revision builder, retaining current claim-time handoff guards.
- [x] GREEN: store/sequence/goal revision tests and isolated typecheck; independent review; root commits/pushes verified unit. Implementer 144/144; independent reviewer 58/58.

## Task 4: Full evidence capture and independent reviewer (root)

**Files:** `src/server/main.ts`, extracted `src/server/sequence-goal-evidence.ts`, `src/orchestrator/goal-reviewer.ts`, related/dedicated tests.

**Consumes:** Task 2 bundle interfaces and Task 3 aggregate target behavior.

- [x] RED: A->B and A->B->A produce verified grouped evidence including singleton bases; missing authoritative evidence or divergent common-dir chains remain blocked.
- [x] RED: one read-only session sees all bounded snapshots; dedicated multi schema rejects missing/unsafe targets while ordinary/single-source behavior stays unchanged.
- [x] Implement live/persisted group identity and complete before/provider/after fingerprint equality. Return source mappings for the reviewer.
- [x] Parse aggregate target only for the goal protocol and normalize malformed/unsafe output to blocked before remediation.
- [x] GREEN: goal reviewer/main/evidence tests, mutation of non-target and persisted input mismatch regressions; independent review and commit/push. Root integration 12/12; independent focused integration 25/25, plus isolated-read corrections 36/36.

## Task 5: End-to-end workflow and dashboard (root, after boundaries settle)

**Files:** `src/server/server.ts`, `web/src/types.ts`, `web/src/App.tsx`, tests; new real-Git multi-repository goal E2E; README/audit.

- [x] RED: real A->B PASS and A->B->A; changes_requested targets A, only A writes/checks, B is unchanged, then whole-goal PASS.
- [x] RED: invalid/foreign/stale/missing multi target persists blocked and explicit retry recovers; quota/reboot/revision limits and competing scheduler gates remain.
- [x] Project targetTaskId in HTTP and show its repository in goal findings; maintain old DTO/keyboard/retry behavior.
- [x] Verify actual Edge desktop/narrow viewport against local fixtures and API; update user-facing workflow and honest remaining limits. Real HTTP/SQLite Edge at 1440 and 375 px, correct target navigation, no horizontal overflow or page errors; web 33/33 and production build passed.
- [ ] Independent final review, canonical full core, web/client/type/build/public-tree on a frozen commit; exact-head Linux/Windows CI, push/PR and main tree verification.
- [ ] Record verified outcomes and continue the next audit unless the user requests pausing.

## Implementation rulings

- Design review approved the corrected immutable creation-base contract. Transaction authorization must also prove target-group lineage; mixed-root no-target remediation is refused even where an old test expected it.
- Keep snapshot fingerprints distinct from an explicit full inputFingerprint; clone the bounded input before any asynchronous provider work.
- Extract aggregate evidence capture into a focused server module and reuse the existing isolated Git environment.
- Snapshot independent review reproduced Windows EBUSY on unmerged-index refusal. Metadata batches now drain every child process before propagating failure. Overlap refusal also precedes artifact directory creation; both corrections have RED/GREEN regressions.
- Store independent review added exact package/run execution/stage/route and completed-event result associations. Root review also required canonical planned-path composition. All seven additions failed before correction and passed afterward.
- Integration review found that isolated Git reads must also reach registered-worktree reopening/fingerprinting, and must ignore replacement refs. Optional read environments preserve writer defaults; three failure-first regressions cover fsmonitor, ambient repository overrides and original-object diffs. Existing concurrency retry hook follows reopenFromEvidence; 11/11 retry tests pass.
- Astra high whole-branch review was interrupted by account usage limits before a conclusion. A separate available reviewer is being attempted; no uncompleted review is counted as approval.

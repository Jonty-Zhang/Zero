# Folder Address Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** A stale folder response or list cannot override an edited browser address or select the wrong project.

**Architecture:** Invalidate the current browsing request and old selection data when the address changes. Only an explicit successful browse re-enables selection; existing abort guards reject old completions.

**Tech Stack:** React/TypeScript, Vitest/jsdom, existing API mocks.

**Spec:** `docs/2026-11-01-folder-address-ownership.md`

## Global Constraints

- One final round then pause as explicitly requested by user; no new issue discovery after this fix.
- Repo-only fixtures/config, fake API/models, no backend/core changes or new dependencies.
- Preserve Boss draft and pending submission identity; browsing never starts model or task calls.
- Root owns docs, Git/push and service checks. Implementer owns only web component/tests.

## Review Focus

- Pending A response must not overwrite a typed B, including transports that ignore abort.
- Stale A selection/new-folder actions must be unavailable until B is confirmed.
- Late A errors/finally must not reset B's loading or error state.
- Clearing/retyping and IME Enter must retain existing navigation semantics.
- Directory editing must not alter the actual project draft or issue prepare/create/verify calls.

### Task 1: Invalidate stale browsing ownership

**Files:** Modify `web/src/BossProject.tsx`; create `web/src/BossFolderAddress.test.tsx` alongside existing focused folder/Boss component tests.

- [x] Port isolated `data/verification/frontend-round34/folder-address.test.tsx` reproduction to normal tests; retain RED evidence.
- [x] Add a shared address-edit handler to abort the current browse and clear old listing/error/new-folder name/loading while preserving the edited address.
- [x] Verify stale success/failure and settled old listing cannot target A after edit; explicit B browse then selection/new folder still works, project draft is unchanged until explicit selection.
- [x] Run affected component tests, complete web suite, API request tests with loopback permissions, and web build. Do not rerun unchanged core suite.
- [x] Independent review and scoped fixes if needed; root verifies hashes, records evidence, commits/pushes main with exact remote readback and confirms served build.
- [ ] Pause goal per user's explicit request; do not start another audit round.

## Execution record

Baseline `acd7cc78df043f3e5ca0f6ce0564dcc01b3b1cdf` is clean with successful Linux/Windows CI41227077618. Existing authorized codex checkout remains in place. One cohesive component change; no outside-folder worktree required. Independent audit confirmed delayed A result overwrites B in actual component, exit1, before product changes.

Final verification: focused106/106, complete web368/368, API19/19, web build exit0. Independent review five cases passed, source hashes unchanged and no actionable finding. Live HTTP200 HTML and script SHA match this build without restarting unchanged core. No additional issue audit or unchanged core suite run was started. Publication and pause status are recorded by root after the exact remote readback; pending CI must remain labeled pending.

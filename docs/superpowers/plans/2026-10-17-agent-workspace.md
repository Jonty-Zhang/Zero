# Agent Workspace Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make cross-agent handoffs observable and the Zero web workspace readable, reliable, and testable.

**Architecture:** Keep the existing SQLite authority, worker gates, React client, and local API. Add a read-only projection of stored stage/handoff evidence and focused client components. Use isolated fixtures and deterministic regressions before making behavioral fixes.

**Tech Stack:** Node.js 24+, TypeScript, SQLite, React 18, Vite 6, lucide-react, Node test runner, browser automation.

**Spec:** `docs/2026-10-17-project-audit.md`

## Global Constraints

- Preserve DONE gates, worktree isolation, permission policy and user Harness configuration.
- No real model calls, production-data changes, embedded credentials or fabricated execution evidence.
- Extend public API fields additively; preserve task submission, sequences, presets and report access.
- Commit independent changes after validation and push `codex/agent-workspace-improvements` frequently.
- User requested autonomous execution without further questions; implement and review within this scope.

## Review Focus

- Old task responses must never display under a newly selected task or drive its cancel action.
- Real checks must remain visible when attempts exist and when the task failed.
- Old/legacy tasks without stage or handoff records must render safely.
- Offline or partially failing APIs must not imply healthy scheduling or erase editable settings.
- A 375px viewport must keep every navigation destination reachable and dialogs usable.

### Task 1: Baseline and audit

**Files:** `docs/2026-10-17-project-audit.md`, this plan.

- [x] Install locked dependencies and run existing core suite, typecheck, web build and public-tree scan; record actual outcomes.
- [x] Review independent frontend and core audit findings; add only confirmed findings to the audit.
- [x] Commit and push research and implementation decisions.

### Task 2: Read-only stage and handoff API

**Files:** `src/server/server.ts`, `src/server/server.test.ts`.

**Interfaces:** Add optional store reads `stages(taskId)` and `handoffs(taskId)` to the HTTP store port for legacy-compatible test/integration stores. Task detail returns `executionStages`, `stages`, `handoffs`, and attempts with `id`, `stageId`, `role`. Project only intentional public fields; do not expose raw configuration, logs or runtime registry data through new projections.

- [x] Add a real TaskStore API regression for a two-stage task, attempt links, ordered stages and HandoffV1; assert legacy tasks return empty evidence arrays.
- [x] Run the focused test and observe missing fields fail.
- [x] Implement the additive projections and linked attempt fields.
- [x] Run server tests and typecheck; review, commit and push.

### Task 3: Reliable task details and refresh

**Files:** `web/src/App.tsx`, `web/src/api.ts`, `web/src/types.ts`, focused client modules/tests.

**Interfaces:** Client stage/handoff types match Task 2 exactly. Task detail binds displayed ID to selected ID. Independent validation section consumes `task.tests` regardless of attempts.

- [x] Reproduce checks hidden when attempts exist and stale task details during a delayed switch, using browser or component tests.
- [x] Fix task identity, request ordering, accessible dialog close behavior and human-readable API errors.
- [x] Render ordered stages, handoff summaries, routing and validation evidence with safe empty states.
- [x] Verify old records, failed requests, delayed responses and cancel target; build, review, commit and push.

### Task 4: Workspace layout and task discovery

**Files:** `web/src/App.tsx`, `web/src/styles.css`, focused workspace components.

**Interfaces:** Search task titles, repository paths, model IDs and task IDs; filter by actual task status, repository and Harness. Counts come from loaded tasks. Default list view and optional board use the same filtered dataset.

**Ruling (2026-10-17 integration review):** The list API deliberately omits full prompts. Search uses fields actually present in list records; copy and fixtures must not promise full description search. Returning every historical 100,000-character prompt on each poll is outside this change. A future full-text search should be implemented server-side with its own contract.

- [x] Add meaningful tests for search/filter combinations, empty results and state counts.
- [x] Implement workspace navigation, summary, list/board switch and responsive visual design, using existing components and icons.
- [x] Keep mobile navigation visible; communicate actual connection and request errors.
- [x] Verify 1440px and 375px layouts, keyboard navigation and submit/sequence/settings flows; build, review, commit and push.

### Task 5: Verified core bugs and final integration

**Files:** Only root-cause-identified core/adaptor files and their regression tests, plus audit/docs/CI as appropriate.

- [x] Convert independently confirmed core findings into a failing regression before changing production code.
- [x] Apply narrow fixes without broad recovery/permission refactors; run targeted tests and full suite.
- [x] Review the complete branch independently, address actionable findings and run final checks.
- [x] Record exact test results, screenshots and remaining limitations; push final commits and verify remote head/CI.

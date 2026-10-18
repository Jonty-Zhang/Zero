# Blocked goal review retry implementation plan

> **For agentic workers:** Use subagent-driven-development or executing-plans, verify RED→GREEN and independently review each boundary.

**Goal:** Let a user explicitly retry a blocked aggregate review of completed tasks without losing verdict history or starting duplicate attempts.

**Architecture:** Store a source-attempt-bound request in the existing SQLite event log. Atomically consume it when creating the next review. Keep scheduler evidence gates unchanged and expose queue status through HTTP and the sequence drawer.

**Tech Stack:** Node 24, TypeScript, SQLite immediate transactions, React and existing serial polling.

**Spec:** docs/superpowers/specs/2026-10-18-goal-review-retry-design.md

## Boundaries and ownership

- Core worker: `src/core/task-store.ts`, dedicated retry store tests and public domain review fields.
- UI worker: `web/src/types.ts`, `api.ts`, `App.tsx`, related component and request lifecycle tests.
- Root: `src/server/main.ts`, `server.ts`, dedicated HTTP/real-Git E2E tests, integration and delivery records.
- Independent reviewer: read-only design and final diff review, with isolated compilation.

## Steps

- [x] Core: reproduce the lack of a persisted retry and create request/pending APIs. Test reboot persistence, duplicate requests, stale source IDs and forbidden statuses.
- [x] Core: extend start with source-attempt CAS and monotonic timestamp; test two connections and same-millisecond inverse UUID ordering. Preserve prior verdicts and all budgets.
- [x] Root: add POST 202/400/404/409/501 behavior, expose queue fields and safely nudge the serialized scheduler. Test concurrent/uncertain retries without provider calls.
- [x] Root: consume pending requests through both normal review and evidence-block paths. Real Git E2E must recover a transient failure across restart; unchanged blocked verdicts without a request must remain cached.
- [x] UI: render eligibility and queue status, submit the exact source attempt, disable repeated clicks and refresh after conflicts. Preserve prior findings and test request boundaries.
- [x] Negative gates: changed final checkout stays blocked, post-review evidence changes cannot PASS, quota and active review cannot be bypassed, changes_requested still respects the goal revision cap.
- [ ] Run targeted and whole-project checks on a fixed build, verify desktop/mobile behavior, independently review, commit/push and inspect exact-head CI.
- [ ] Continue the next audit round after recording outcomes and remaining limits.

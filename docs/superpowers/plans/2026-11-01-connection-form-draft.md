# Connection Form Draft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Preserve unsubmitted model/effort across desktop connection form teardown without changing submitted request identity.

**Architecture:** App-owned existing connection store owns an in-memory draft independently from immutable pending requests. Form initializes defaults only before edits and renders/submits the relevant draft or locked pending identity.

**Tech Stack:** React, TypeScript, Vitest/jsdom, existing verification store.

**Spec:** `docs/2026-11-01-connection-form-draft.md`

## Global Constraints

- No new dependencies, browser persistence keys or real model calls.
- Pending request key/job/model/effort and retry semantics unchanged.
- No core/server changes, service restarts or Git mutations by implementer.
- All fixtures/evidence/profiles within the repo.

## Review Focus

- Returning from Boss settings must preserve both project and connection drafts.
- Delayed setup response must not overwrite edited or intentionally blank model; untouched effort still initializes to an offered valid value even after a model edit.
- Pending and uncertain requests must remain locked to original identity.
- A terminal previous job must not overwrite a newer draft on remount.
- Browsing/navigation/input must never start verification or project preparation.

### Task 1: App-owned connection draft

**Files:** `web/src/connection-verification.ts`, `web/src/ConnectionVerificationForm.tsx`, focused existing store/App tests; add focused form tests if useful.

- [x] Port isolated `data/verification/frontend-audit-round32/connection-draft.test.tsx` regression to regular tests, run and retain failing evidence.
- [x] Add in-memory draft ownership and guarded initialization to existing store; keep pending request separate.
- [x] Wire form edits/default initialization/remount to that draft; preserve existing validation, request and status behavior.
- [x] Test the five Review Focus cases plus store existing retry/reload lifecycle tests with fake transport.
- [x] Run complete web suite, `node --test web/tests/api.test.mjs`, and web build once; no duplicate root core build/full suite while round31 is running.
- [ ] Independent whole-diff review, root documents exact results, commit/push main and verify remote SHA.

## Execution record

One producer/consumer task on the existing user-authorized codex checkout. Core round31 files belong to a separate frozen change and must remain untouched. Root stages the two rounds separately.

Initial whole-diff review found one P2 incomplete per-field default initialization. Implementer fixed it; final scoped review six cases passed and no actionable finding remained. Final complete web suite: 360/360, API: 19/19, build: exit 0. Initial loopback sandbox failures retained separately; final source hashes match independent review. Publish this independently verified frontend change before the longer core regression finishes; no core files belong to this commit.

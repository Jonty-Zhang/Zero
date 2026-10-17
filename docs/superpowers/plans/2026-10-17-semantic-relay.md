# Semantic Agent Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make ordered cross-agent execution carry distinct stage goals and bounded, attributable executor context.

**Architecture:** Extend the task payload and existing verified HandoffV1 additively. Preserve machine-observed facts and every completion gate. Parallelize only disjoint files; the controller integrates worker changes and verifies the whole branch.

**Tech Stack:** Node 24, TypeScript, SQLite, React, Vite, Node test runner, Vitest, Edge/Playwright.

**Spec:** ../specs/2026-10-17-semantic-relay-design.md

## Global Constraints

- Stage objective: optional trimmed 1–4,000 characters; legacy stage selections remain valid.
- Executor summary: optional plain text, at most 3,000 UTF-16 characters and 8 KiB UTF-8, never split a Unicode code point.
- Preserve verified binding selection, lease/generation checks, full worktree fingerprints, check provenance, independent review and result-commit gates.
- No user questions; use the existing branch/PR and push after meaningful verified commits.

## Review Focus

- Invalid and whitespace-only objectives must fail before task creation, including direct store submissions.
- Stage objectives must not leak into effective selection or disappear after reopening the database.
- Unicode-heavy or malicious executor text must remain bounded data and never replace machine check facts.
- Revisions must preserve reviewer requests and complete overall acceptance despite narrow stage goals.
- Reordered/deleted stages must submit their own goals and summaries must remain readable on mobile.

### Task 1: Durable stage goals

Files: src/domain/types.ts, src/core/task-store.ts and tests, src/server/server.ts and tests, CLI tests.

- [ ] Add failing store/API tests for objective roundtrip, persistence, whitespace/type/length rejection and legacy compatibility.
- [ ] Add `ExecutionStageDefinition extends ExecutionSelection { objective?: string }`, validate direct store input and public API, and project the goal back in task detail without affecting execution defaults.
- [ ] Run targeted store/server/CLI tests; commit and push the independently compatible contract.

### Task 2: Bounded executor summaries

Files: src/domain/handoff.ts and tests. Controller owns worker.ts, server projection and report integration.

- [ ] Add failing normalization/parser/context tests for absent, Unicode-heavy and malicious final prose; keep existing context byte/character bounds.
- [ ] Add optional HandoffV1.executorSummary plus reusable `boundExecutorSummary(value: string | undefined): string | undefined`; validate persisted field and include it as untrusted bounded JSON data.
- [ ] Capture executor final in attempt metadata; retrieve it by source attempt when finalizing stages; expose it through API/reports. Prompt final replies for useful relay context.
- [ ] Prove real two-stage worker relay, stage-specific prompts, narrow route selection and intact final review using Git-backed tests; commit and push.

### Task 3: Stage authoring and evidence UI

Files: web/src/App.tsx, web/src/types.ts, web/src/styles.css and frontend tests.

- [ ] Add failing interaction tests for stage goal editing/reordering/submission and untrusted summary display.
- [ ] Implement editable goals, planned-goal display and readable executor summaries, preserving empty-history compatibility.
- [ ] Fix separately reproduced UI/API lifecycle issues found by the audit, with behavioral regressions.
- [ ] Run frontend/API tests, build and desktop/mobile Edge checks; commit and push.

### Task 4: Review and regressions

- [ ] Obtain independent review of the complete second-round changes; fix substantive findings with regressions.
- [ ] Run the full canonical core suite, frontend tests, API tests, public-tree checks and Windows/Linux CI on the pushed head.
- [ ] Update audit/README/PR with actual behavior, evidence and remaining limitations; preserve the existing unmerged PR.

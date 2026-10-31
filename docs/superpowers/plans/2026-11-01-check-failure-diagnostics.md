# Check Failure Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give revision agents the original bounded stdout/stderr of failed checks, including durable recovery.

**Architecture:** Capture diagnostic snapshots at the TestRunner process boundary and persist them in CheckResult. Add a bounded untrusted JSON projection at the common revision brief boundary; never read arbitrary stored paths.

**Tech Stack:** TypeScript, Node test runner, SQLite, existing fake harness adapters.

**Spec:** `docs/2026-11-01-check-failure-diagnostics.md`

## Global Constraints

- Repo-contained files, profiles and fixtures; fake models only.
- Each captured stream at most 4096 UTF-8 bytes, retaining start and end when truncated.
- Diagnostic JSON at most 65536 UTF-8 bytes. Original task and failure metadata remain complete.
- Missing historical snapshots explicitly unavailable; no stored log path reads.
- Root owns documentation, Git commit/push and service lifecycle. Implementer owns the cohesive code/test change.

## Review Focus

- Chunk boundaries inside multibyte UTF-8 and truncated streams remain understandable and correctly flagged.
- Large/escaped output cannot exceed the prompt diagnostic budget or drop the original instructions.
- Old persisted results, empty output and spawn failures distinguish unavailable from observed empty streams.
- Saved revision briefs and reconstruction use the same captured observation rather than current filesystem content.
- All real models and external personal configuration remain untouched.

### Task 1: Capture and deliver durable diagnostics

**Files:** Modify `src/domain/types.ts`, `src/core/test-runner.ts`, `src/orchestrator/worker.ts`; create small focused diagnostic helper(s) if useful. Add focused core/formatter tests, durable Store test, and extend existing Worker regression.

**Interfaces:** Optional CheckResult diagnostic snapshot with separately bounded stdout/stderr text and truncation flags; existing JSON Store persistence must roundtrip it. Common worker revision formatter includes bounded JSON projection for all failed check results without introducing filesystem access.

- [x] Write and run a regression proving a real failed check's distinct stdout/stderr markers are absent from the actual revise request. Preserve red evidence.
- [x] Add streaming bounded capture and the optional backward-compatible result field. Do not change full-log behavior or other process semantics.
- [x] Add diagnostic JSON projection and invoke it at the common revision brief boundary. Explicitly label untrusted data and missing/omitted/truncated evidence.
- [x] Verify real process output, UTF-8 chunk boundaries, large output, missing/empty snapshots, control-character escaping and aggregate budget. Assert SQLite close/reopen keeps the original snapshot.
- [x] Verify an actual Worker revise request contains original diagnostic markers and succeeds with fake models. Run affected existing Boss/rework/recovery tests and the required project suite once under correct process/network permissions; inspect every failure, without duplicating live runs.
- [x] Independent review of the whole change, fix any load-bearing findings and recheck fixes.
- [x] Root records evidence, checks public tree/diff, commits, pushes main with exact remote readback and refreshes idle local service.

## Execution record

Initial preflight: one cohesive task; capture producer and formatter consumer share the optional CheckResult schema. Existing JSON persistence requires verification but no speculative migration. Current checkout is the existing dedicated `codex/durable-task-cancellation-2026-10-19` branch; user has authorized continued in-place work and main pushes, so no outside-folder worktree is created.

Final audit discovered recovered mixed results could spend the budget on passed checks. Recorded exact formatter RED and actual guardian RED, filtered failures at the shared brief boundary, then verified final three actual Worker/recovery cases and 428 independent adversarial cases. Final build passed. Original full run remains 934/935, one unrelated fake RPC timeout; test-only deadline/canary repair published separately as `d5b6da9a66016eda80b4fdd9c38d0cb5fae34419` with isolated peer31/31 and controlled clock/delay regressions. No claim of a second full-suite pass. Local guarded service refresh succeeded, HTTP200 and verified frontend build match. Publication receipt and latest CI state saved separately under ignored verification data; pending CI is not a success claim.

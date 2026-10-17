# Continuous functional audit implementation plan

> **For agentic workers:** Use subagent-driven-development or executing-plans to implement one independently verified repair at a time. Continue investigation after each round; this list is a work queue, not a claim that all defects have been found.

**Goal:** Repeatedly find, reproduce, repair and review real failures in Zero's agent workflow and web UI, recording and pushing each verified repair.

**Architecture:** Retain the existing Node/SQLite/serial-worktree workflow and React UI. Distinguish a saved user choice from transient availability, current failure evidence from diagnostic history, and final-checkout checks from intermediate-step checks.

**Tech Stack:** Node 24, TypeScript, SQLite, React/Vite, local Git fixtures and deterministic adapters.

**Spec:** The user's continuing review instruction; existing contracts in README.md, docs/workspace-handoff-design.md and docs/2026-10-17-astra-review.md.

## Constraints

- Do not ask the user routine implementation questions. Use isolated local fixtures; do not call paid providers or change production bindings for demonstration.
- Preserve leases, generations, independent review, sealed packages, check provenance and the reviewed-commit completion gates.
- Keep independent edits in disjoint files. Reproduce before editing production behavior and independently review each repair.
- Commit and push verified repairs frequently. Identify the branch and exact tested commit in delivery records.

## First continuing round

- [x] Reproduce early quota diagnostics masking later authentication/billing errors and the first-16-errors truncation boundary.
- [x] Save the latest provider error independently of bounded history; classify the current failure from that evidence and expose its diagnostic. Run adapter/quota regressions and independent review.
- [x] Preserve unavailable saved allocator/reviewer choices across configuration GET/PUT. Show unavailable values in the web editor while rejecting new unverified choices. Verify real HTTP and UI regressions.
- [x] In goal remediation, inherit final-step checks rather than all historical intermediate checks. Verify rename/migration and retained-final-check failures with real Git workflows.
- [ ] For aggregate goal verification, select the completed check run sealed into the applied result package; historical failed attempts must not block a successfully revised task. Keep missing or mismatched final evidence blocked.
- [ ] Run whole-project checks for the integrated round, inspect the precise CI result, record evidence, and continue a second independent investigation round.

## Next investigations

- Configuration execution defaults during transient CLI/model unavailability.
- Sequence goal evidence after ordinary revision, interrupted attempts and review changes.
- User-visible lifecycle errors, repeated submissions and settings changes while capabilities refresh.
- Plaintext Harness error chronology, without broadening trusted error sources.

# Goal remediation capacity implementation plan

Design: [capacity lifecycle contract](../specs/2026-10-19-goal-remediation-capacity-design.md).

Files: domain/goal-revision.ts owns pure construction and the typed capacity error; the orchestrator wrapper preserves its API. TaskStore owns independent classification and atomic history/provenance. The scheduler distinguishes capacity, transient append and persistence failures. Dedicated core and HTTP/Git E2E tests cover the complete lifecycle.

- [x] Reproduce accepted long input with real DONE tasks and a legal reviewer response; prove short input with the same findings builds normally.
- [x] Write failing capacity, authorization, history, boundary, rollback and race tests; implement the pure domain builder and transactional fresh/legacy classification.
- [x] Preserve scheduler append backoff for non-capacity errors; validate original criteria, authoritative remediation, explicit retry, restart and multi-repository compatibility.
- [x] Independent review reproduced a scheduler persistence-catch flaw. Add failure-first event-insertion fault injection, move final persistence outside reviewer/evidence catch, and independently reverify rollback/restart and quota/transient compatibility.
- [x] Match all six applied source hashes against the reviewed preparation; start canonical full verification in the actual checkout with a saved source receipt.
- [x] Complete actual canonical full core: 582/582, no skips/failures, unchanged six-file source hashes. Web 58/58, request lifecycle 11/11, TypeScript and production build passed. Desktop Edge 1440/1024 verified capacity reason/full objective and retry 202 without providers.
- [x] Reproduce and fix long objective text overflowing the fixed header; keep bounded previews and full body text with criteria. Independent web review passed 58/58.
- [ ] Complete public-tree/diff checks, record source identity, commit and push; require exact-head Linux/Windows CI and another main-tree verification before integration.

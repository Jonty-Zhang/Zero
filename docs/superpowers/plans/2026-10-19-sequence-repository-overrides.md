# Sequence repository overrides plan

> Execute each scoped task with test-first implementation and independent review; root owns Git publication and integration.

Design: [repository override contract](../specs/2026-10-19-sequence-repository-overrides-design.md).

File boundaries: `web/src/App.tsx` owns whole-row draft state and its repository resolver; `App.test.tsx` covers form behavior and exact payloads; `styles.css` only wraps the new preview/error text. Existing `api.ts` and backend remain unchanged. README files describe the resulting workflow; the audit records evidence and limits.

- [x] Reproduce the shared-only authoring gap in real Edge and inspect per-task API acceptance, canonical defaults and retry semantics.
- [x] Review the design independently; prepare isolated tests before implementation. Eight new feature cases failed because fields/preview/validation were missing, then passed after correction. Four draft/busy/bounds controls passed directly. Preserve all 39 prior web cases.
- [x] Implement one resolver for preview, root-presence validation and per-task payload, with dynamic defaults, whole-draft operations and scoped wrapping styles. Independent preview review and 51/51 tests passed.
- [x] Verify the actual checkout: web 51/51, request lifecycle 11/11, TypeScript/production build and real Edge at 1440/375 px. Proved actual API persistence, same-key response-loss replay with identical resource IDs/counts, changed-payload identities, canonical project defaults and atomic rejection without invoking a provider.
- [x] Record exact outcomes, commit/push frequently, review final diff and require successful CI before main integration. PR #7 merged as 8924efa after frozen source 66998df passed both exact-source CI runs: Windows core 558/558, Linux 554 passed + 4 platform skips, web 51/51, request lifecycle 11/11 and installation/uninstallation. Local/remote main and tested tree c48595a verified equal.

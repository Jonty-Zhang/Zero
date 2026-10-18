# Web workflow audit — 2026-10-19

## Verified main baseline

[PR #6](https://github.com/Jonty-Zhang/Zero/pull/6) merged as `de4bc8fe1ad06ec32179879d629af16a34be9051`. Its tree is exactly the tested source tree `18c9c5abd2e67482fd71c9c9291c682f4f92bb35`: local and Windows full core 558/558; Linux 554 passed, four platform skips; web 33/33; request lifecycle 11/11. Both exact-source CI runs passed, including native containment, packaged launch and Windows installation/uninstallation. Local main and the GitHub main ref were independently checked against the merge object and its parents.

## Reproduced browser defects

1. A failed `GET /api/sequences` refresh hid all existing goal cards, although the polling hook retained the last successful data. Cards now remain usable with an explicit stale-data warning. Initial failures do not invent cached content; recovery replaces the data and removes the warning.
2. In the single-task form, choosing a model without fixing a Harness showed only the first binding's reasoning strengths. It now unions and deduplicates that model's available bindings, narrowing when a Harness is specified and excluding unavailable bindings/Harnesses. Capability refreshes retain the user's existing choice under the established unavailable-option behavior.

Both defects were reproduced against production web assets with local HTTP/SQLite and Edge before correction. Six regression/control cases were added: three initially failed at the actual defects, and three established existing behavior. The isolated corrected web suite passed 39/39; an independent reviewer ran it and approved both changes.

Edge smoke at 1440 and 375 px used both the corrected preview and the actual checkout's new production build with real HTTP/SQLite: a retained card opened its goal drawer during a list-endpoint outage, recovered on refresh, and model-only/high submission returned 201 with the correct persisted partial execution selection. No page errors or dialog horizontal overflow occurred. Fixture adapters never execute providers. Actual checkout verification also passed web 39/39, request lifecycle 11/11, TypeScript, production build, public-tree and diff checks.

## Next authoring gap

The sequence API already accepts a repository and Ref per task, but the browser currently forces all steps to share them. The next scoped change adds optional per-step overrides that dynamically inherit shared defaults, retains whole-row reordering and authored execution choices, and validates each effective root. The interface must explain continuation within the same canonical repository and separate histories across repositories. Implementation and final validation are tracked separately from the two corrected defects above.

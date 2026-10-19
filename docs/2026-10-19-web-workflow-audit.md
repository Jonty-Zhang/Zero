# Web workflow audit — 2026-10-19

## Verified main baseline

[PR #6](https://github.com/Jonty-Zhang/Zero/pull/6) merged as `de4bc8fe1ad06ec32179879d629af16a34be9051`. Its tree is exactly the tested source tree `18c9c5abd2e67482fd71c9c9291c682f4f92bb35`: local and Windows full core 558/558; Linux 554 passed, four platform skips; web 33/33; request lifecycle 11/11. Both exact-source CI runs passed, including native containment, packaged launch and Windows installation/uninstallation. Local main and the GitHub main ref were independently checked against the merge object and its parents.

## Reproduced browser defects

1. A failed `GET /api/sequences` refresh hid all existing goal cards, although the polling hook retained the last successful data. Cards now remain usable with an explicit stale-data warning. Initial failures do not invent cached content; recovery replaces the data and removes the warning.
2. In the single-task form, choosing a model without fixing a Harness showed only the first binding's reasoning strengths. It now unions and deduplicates that model's available bindings, narrowing when a Harness is specified and excluding unavailable bindings/Harnesses. Capability refreshes retain the user's existing choice under the established unavailable-option behavior.

Both defects were reproduced against production web assets with local HTTP/SQLite and Edge before correction. Six regression/control cases were added: three initially failed at the actual defects, and three established existing behavior. The isolated corrected web suite passed 39/39; an independent reviewer ran it and approved both changes.

Edge smoke at 1440 and 375 px used both the corrected preview and the actual checkout's new production build with real HTTP/SQLite: a retained card opened its goal drawer during a list-endpoint outage, recovered on refresh, and model-only/high submission returned 201 with the correct persisted partial execution selection. No page errors or dialog horizontal overflow occurred. Fixture adapters never execute providers. Actual checkout verification also passed web 39/39, request lifecycle 11/11, TypeScript, production build, public-tree and diff checks.

## Multi-repository authoring

The sequence API already accepted a repository and Ref per task, but the browser forced all steps to share them. The form now adds optional per-step overrides that dynamically inherit shared defaults, retains whole-row reordering and authored execution choices, and validates each effective root. It explains continuation within the same canonical repository and separate histories across repositories. See the [design](superpowers/specs/2026-10-19-sequence-repository-overrides-design.md) and [implementation plan](superpowers/plans/2026-10-19-sequence-repository-overrides.md).

Eight new feature cases failed before implementation and passed afterward. Four whole-draft/busy/bounds controls passed directly. The independent reviewer approved the preview and independently passed all 51 web tests; the actual checkout also passed 51/51, request lifecycle 11/11, TypeScript and production build.

Real Edge at 1440 and 375 px submitted two actual temporary Git roots through HTTP/SQLite. Long Unicode paths, missing-root messages, dynamic Ref inheritance, row movement, keyboard containment and busy guards worked without page/dialog/row horizontal overflow or page errors. A nested checkout path canonicalized to the correct root; only authored model/strength locks persisted while global/project choices were validated server-side.

For each viewport the first POST reached the service and persisted its sequence and two tasks, then the browser response was deliberately discarded. Retrying reused the same key and returned the exact sequence/task IDs, leaving counts at one new sequence and two tasks. This verifies response loss after persistence, rather than aborting before the request reaches the server. In a separate fetch-boundary case, masked defaults and trimmed input retained the pending identity; changed effective root, Ref and task order produced distinct keys. An incompatible canonical project default returned 400 with zero partial tasks or sequences. No provider executed.

Final-source CI and main integration remain pending and will be recorded on [PR #7](https://github.com/Jonty-Zhang/Zero/pull/7); those publication gates are separate from the local verification above.

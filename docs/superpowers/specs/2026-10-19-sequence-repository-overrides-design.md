# Sequence repository and Ref overrides

The HTTP sequence API accepts a separate repository and Ref for every task. The browser currently forces one shared pair, preventing authoring the multi-repository goals supported by the verified backend.

Keep shared defaults and add optional repository/Ref fields to every step. The default root can be empty when every step specifies a root. Resolve each field at display and submission time:

```ts
repoPath = step.repoPath.trim() || defaultRepo.trim();
baseRef = step.baseRef.trim() || defaultRef.trim() || 'HEAD';
```

Blank fields dynamically inherit the current defaults, including newly added steps. Preserve original input text until submission. Show wrapped effective-root/configured-Ref previews, without suggesting a configured Ref replaces verified same-repository continuation. Steps execute in order; the same canonical repository continues its own verified result, and different repositories maintain separate histories.

Any missing effective root disables submission and immediately displays a step-numbered message associated with the row's input through ARIA. The submit handler independently refuses missing roots. Whole-row movement/deletion carries repository, Ref, prompt, criteria, checks and execution choices together; positions determine current validation labels. Existing 2–16 editing bounds remain.

Changing repositories or defaults preserves authored execution choices. Submit only those partial choices; the server resolves canonical roots, global/project defaults, available execution combinations and valid Git refs. The complete batch must pass server validation before persistence. Do not add endpoints or duplicate client-side canonicalization.

All fields remain inside the busy-disabled fieldset. Keep existing Escape/backdrop/close/focus guards. Reuse api.createSequence's normalized-payload digest and durable server identity. Equal resolved payloads after a failure reuse the request identity; changed effective roots, refs or task order obtain a different identity. Equivalent path aliases can still differ at the client digest boundary.

Validation includes default-only and all-override forms, independent/whitespace inheritance, changed defaults, missing-root positions, whole-row integrity, partial execution locks, busy/retry preservation, unavailable project defaults and mobile long paths. A genuine response-loss check must observe successful server persistence before discarding the response, then compare IDs and database counts after retry. Mocking a request failure before it reaches the server is insufficient for that claim.

The user delegated design decisions and opted out of questions. A separate reviewer checked this design against the existing API and approved it. Backend execution, Git lineage and idempotency semantics remain unchanged; results stay in task worktrees.

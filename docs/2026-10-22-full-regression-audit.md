# Complete core regression and desktop follow-up

The complete compiled core suite passed **639/639 tests, exit 0**, with no failures, cancellations, skips or todos. The run started at 19:17:46 and finished at 19:33:45 on October 22, 2026 (Asia/Shanghai). Its duration summary was 959535.2002 ms.

## Scope and provenance

The tested source corresponds to local commit `785a4ee61677b1744cb1d026219430ad6146ff53`: durable cancellation/report consistency, ZCode process teardown and desktop capability/polling changes. The runner recorded Git HEAD `5eb450f` at startup because the desktop changes were already applied but their Git commit was created during the run. No source or build file changed during the run. A separate verifier checked all **178** source/build file hashes, including the desktop changes, against the initial manifest with zero mismatches.

The exact test command, following the previously successful root compilation, was:

```text
node --import ./scripts/test-environment.mjs --import ./data/verification/quota-snapshot-audit/observe-full.mjs --test "dist/**/*.test.js"
```

Concurrency used the Node default. The additional import records Git operation errors and non-success worker outcomes while forwarding the original arguments/results. This is a complete test-file run with diagnostics, rather than a literal invocation of `npm test`. It used local fake providers and real Git/process fixtures; no external provider was called.

Repository-local evidence:

- `data/verification/durable-cancel-root/full-core-durable.log`
- `data/verification/durable-cancel-root/full-core-durable-state.json`: nonce `c7eb72d2-2fd0-4b7d-9951-e55555833f97`, closed, exit 0, no signal.
- `data/verification/durable-cancel-root/full-core-durable-verification.json`: verifier exit 0, `verifiedPass: true`, 178 matching files.
- Log SHA-256: `fac2ed77bbf4938e85d980fac0b7822b5caa3b4ed84d5c40502f3a920f381f35`.

The preceding interrupted run and failed runs remain retained. The previously failing quota and aggregate-evidence cases passed in this complete run, but their original causal Git errors were not recovered; no speculative production fix was made for them.

## Further independent checks

Desktop cancellation controls found no new bug. An actual loopback HTTP cancellation of a pending task returned 200, then task detail reported `failed` / `Cancelled by user`, without starting an agent. Two UI controls passed with exit 0: success refreshes and removes the action; HTTP 503 retains a retryable action and displays the rejection. Evidence is under `data/verification/desktop-followup-audit/`. These checks used unchanged production source.

GPT-6 Astra high also inspected cross-agent handoff provenance, quota stage recovery and sequence base inheritance without confirming a new bug. Its isolated three-stage control encountered route quota and writer quota in the second stage, reopened SQLite twice, retained earlier/partial files, preserved summary handoffs and maintained the predecessor chain without replaying stage one. Evidence is under `data/verification/cross-agent-next-audit/`. That control used a mock worktree and deliberately stopped before final checks/review; it does not independently verify Git or end-to-end completion.

The long-log detail improvement is being developed separately. This complete-run result does not cover a later source change.

## Publication

The repository-contained GitHub CLI has no authenticated session or environment token. A read-only Git HTTPS remote-ref request also failed with connection reset, so cached remote refs are not asserted as current. No outside credentials were accessed. The three implementation commits are local; no GitHub push or remote main integration is claimed.

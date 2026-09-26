# Live validation record

On 2026-09-24, Zero completed a disposable Git repository task through an authenticated Codex CLI. This was an end-to-end invocation, not a mocked adapter test. Runtime configuration and task artifacts remain local.

| Stage | Observed result |
|---|---|
| Binding | Headless model invocation returned the expected nonce; evidence level `selector_only` because CLI JSONL did not identify the actual model |
| Allocation | Codex selected the task's locked Harness, model and reasoning effort |
| Execution | Codex created the requested one-line file in an isolated Git worktree; execution session ID was captured locally |
| Check | `node verify.cjs` passed with exit code 0 |
| Review | A separate, read-only Codex call returned `pass` with no findings |
| Archive | Result commit, diff and report saved locally; task reached `done` |

The first live run exposed an invalid strict review output schema. We corrected the schema and retained reviewer process artifacts on failure, then submitted the second task above to verify the fix. The sample repositories and runtime report are local ignored data, not part of the published source.

Automated tests cover durable quota pause and resume, including process restart and route/review checkpoints. An actual subscription quota exhaustion was not induced, so provider-specific wording and reset times remain to be observed in a future natural limit event. DSH and ZCode require live binding verification before they can be selected. Windows deployment was outside this validation. The current Windows deployment uses a manual launcher and does not register startup tasks.

The locally isolated DSH CLI passed Zero's version/headless-help probe and effective-profile model inspection. The locally built official ZCode v0.16.9 CLI passed Zero's version/help probe and accepted `build` with `stream-json` in a help-only invocation. Neither probe made a model request. The local capabilities endpoint reports both CLIs as available and both execution bindings as unavailable until a real model verification succeeds. Local CLI installations and their configuration remain outside the public source tree.

On 2026-09-25, a separate ZCode app-server protocol peer and deferred-session bridge passed mock protocol tests, including interaction blocking, guarded cancellation, per-turn model selection, and Start Plan catalog validation. A local empty-session catalog probe returned no snapshot before the peer closed; the child process exit was confirmed. It made no model request. The live Start Plan provider/model and its available quota remain unverified, so this bridge is not registered for task routing. The user can manually forward a task if direct enrollment remains unavailable.

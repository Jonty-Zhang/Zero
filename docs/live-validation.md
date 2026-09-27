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

On 2026-09-27, the existing-desktop ZCode app-server diagnostic completed an empty session and returned a four-entry model catalog after Zero supplied the installed CLI's built-in provider-file location to its own child process. The user's provider file hash was unchanged. No model turn was sent and no GLM or DeepSeek binding was enabled. See [the existing-desktop enrollment record](zcode-existing-desktop-enrollment.md).

The explicit `list-zcode-desktop-models` command also completed against the installed desktop CLI in an isolated Zero-owned data directory and returned four objects containing only `providerId` and `modelId`. One additional local attempt failed closed without printing model data, then a retry succeeded. No model was enrolled or invoked, and the returned identifiers were not copied into this repository.

Also on 2026-09-27, Zero ran an unsigned CI-built Windows release stage from an ignored local directory with separate task data and a separate loopback port. The packaged manual launcher brought up `/api/health`; SQLite recorded `guardian_startup_verified` and `predecessor_drained=1`. After the launcher process exited, the guardian and service stopped. [GitHub CI](https://github.com/Jonty-Zhang/Zero/actions/runs/36290900633) independently passed the same launch-and-stop smoke test plus installer install/uninstall. This validates the packaged manual-launch path, not installation from the shortcut or recovery of a real interrupted task on the target PC. No model task was submitted in this Windows test.

Later on 2026-09-27, the unsigned Windows package was installed and manually launched on the target PC. A real Codex subscription binding check succeeded. An initial eight-minute installed-Zero acceptance wrote a disposable file but did not reach separate review, archive, or `done`; a later full acceptance is recorded below.

Separate target-PC diagnostics narrowed the Codex launch conditions without establishing why the installed Zero run stalled. The matched npm Codex CLI and its resources completed a disposable file edit with `approval_policy=never`. The default native Windows command-helper path hung or failed; a different CLI entry point emitted `orchestrator_helper_launch_canceled` (1223). That result does not prove the same helper failure caused the installed Zero stall. With a process-only `windows.sandbox=unelevated` override, a direct `node --version` command completed with command exit 0. The [OpenAI Windows sandbox guide](https://learn.chatgpt.com/docs/windows/windows-sandbox) recommends `elevated`; `unelevated` is a fallback with weaker network isolation.

Separately, a locally staged 42-file Windows release was run with the previously working native guardian and a process-only `-CodexWindowsSandbox unelevated` setting. It completed a disposable Git task through routing, implementation, one passing check, a separate Codex review pass, result commit, diff and report generation, and `done`. The report recorded successful route, implementation and review attempts with `finalStatus=done`. Exiting the launcher stopped the service.

On 2026-09-27, commit `4b26a85` passed CI and its 42-file Windows package was installed on the target PC. The installed-file manifest hashes matched, and no scheduled task was registered. A disposable task in an isolated Git fixture moved through `running` → `reviewing` → `done`: all three route, implementation, and review attempts succeeded; one configured check passed; and the separate review returned pass. Zero recorded the result commit, diff, and report; the diff changed only `acceptance.txt`. Real provider quota exhaustion and recovery, real crash recovery, and live DSH/ZCode execution remain unverified and may be tested later.

Goal-sequence acceptance had two earlier blocked rounds. In the first, step 1 reached `done`, but step 2's check was blocked because the fixture `.gitattributes` did not pin LF and checkout produced CRLF. In the second, both tasks reached `done` and each passed one check and its Codex review, but aggregate review returned `blocked`: the criteria required proof that task 2 read task 1's file, which the final files, checks, and hashes could not establish.

The third round ran from the installed 2026-09-27 package. Both ordered tasks reached `done`; each passed one check and its Codex review. Step 2's `effective_base_commit` exactly matched step 1's report `resultCommit`, and step 2 had its own independent `resultCommit`. The final files (`SPEC` and `RESULT`) had exact LF line endings; aggregate Codex review returned `PASS`, the sequence reached `completed` with `goalRevisionCount=0`, and exiting the launcher stopped the service.

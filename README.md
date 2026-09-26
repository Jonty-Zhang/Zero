# Zero

[中文文档](README.zh-CN.md)

Zero is a local-first task execution node for coding work. Submit a task through the local UI or CLI; Zero stores it in a persistent queue, routes it, runs it in a Git worktree, performs configured checks, requests a separate Codex review, and archives the result. A background service keeps working when the browser is closed.

Zero is an application made of one Node.js service, a local React web UI, and a CLI. The service owns task state and execution; the UI is a client of that service. v1 targets one Windows-first, single-user machine and binds to loopback by default.

## What works today

- A SQLite-backed task queue and local HTTP API, with `pending`, `running`, `reviewing`, `revision`, `waiting`, `recovery_required`, `done`, and `failed` task states.
- A configurable master coordinator: choose the Codex subscription or an OpenAI-compatible HTTPS API model to route and oversee tasks. The coordinator only chooses among verified Harness/model bindings; it does not implement tasks. A separate read-only Codex session reviews the result. You can manually pin any subset of the execution Harness, model, and reasoning effort; the selected coordinator fills only fields left unset.
- API coordinator settings are configured in the UI. `baseUrl` must be an HTTPS endpoint, `model` names the coordinator model, and `keyEnv` is the name of an environment variable available to the Zero service. Zero stores the variable name, not the API key. Keep the key in the service process environment. The API coordinator performs routing only; Codex remains the reviewer.
- Codex, DeepSeek Harness (DSH), and ZCode adapters. An adapter being present does not make a Harness/model pair eligible: Zero requires a locally verified binding. DSH and isolated ZCode CLI bindings use Zero-owned profiles. The existing-desktop ZCode `app-server` adapter and `verify-binding zcode-desktop` path are mock-tested; live enrollment has not succeeded, so this route is not verified or available for routing. See [server setup](src/server/README.md) for the verification boundary.
- A task-specific Git worktree, configured validation commands, bounded revision attempts, and an archived report with execution, test, review, and Git evidence. Successful task branches remain in the source repository; Zero does not automatically merge or push them.
- Ordered `executionStages` run serially in one task worktree through the core, HTTP API, and CLI `--stages-file` option. Each stage records a linked attempt, worktree fingerprint, and versioned handoff based on facts Zero observed. Reports include this stage history.
- Durable ordered task sequences can be submitted from the UI or API and inspected with the CLI. Each step is a regular task and may specify its own Harness, model, and reasoning effort; unset fields are selected by the configured coordinator. For steps in the same repository, Zero starts the next step from the previous step's verified result commit, after the prior task reaches `done` with its authoritative applied commit and complete report.
- Sequence statuses distinguish step execution from aggregate goal acceptance. Once every step task is done, Zero runs an independent aggregate Codex review when an objective or goal-level criteria were supplied. The HTTP API and UI expose the latest review state and verdict (`PASS`, `changes_requested`, or `blocked`), summary, findings, and quota retry time. `steps_completed` means the aggregate verdict is not yet available; `completed` means either there was no goal metadata or the aggregate review returned `PASS`. The implementation has automated coverage, but the live goal-review flow has not been verified. Automatic goal-level remediation after findings is not implemented.
- A `waiting` state for verified provider usage limits, with persisted checkpoints and scheduled retry across service restarts. This covers allocation, execution, review, and reviewer-requested rework in automated tests; a real provider quota event has not been observed. For ordinary crashes, Zero first quarantines expired leases. After the native guardian proves the preceding process Job is drained, eligible tasks can resume in the same registered worktree: ordinary first-pass execution, sealed-package review and commit/report recovery, and reviewer-requested rework. Recovered execution and rework get fresh routes, attempts, checks, and review. The recovery paths require matching task generation, Git identity, allowed paths, package/verdict, and revision evidence. Missing or mismatched evidence remains `recovery_required` for inspection.
- Recovery is implemented with automated test coverage; unattended installation, reboot recovery, real Harness execution, provider quota recovery, and crash fault injection on the target machine have not been accepted. Ignored build/cache files are not part of Zero's Git-based worktree fingerprint; they can remain in the worktree and affect commands after recovery, so rely on reproducible checks rather than hidden local cache state. See the [crash recovery design](docs/crash-recovery-design.md) and [recovery implementation boundary](docs/crash-recovery-next-slice.md).
- Worktree creation records its planned repository, branch, path, and base commit before `git worktree add`, then saves observed identity and fingerprint. An ambiguous creation failure keeps that evidence for inspection.
- A native Windows process guardian with passing CI build and process-containment tests. Deployment to the target machine and a boot test remain unverified; see [Windows deployment](docs/windows-deployment.md).
- A Windows release staging script bundles the built runtime, UI, CLI, explicitly supplied Node executable, and tested guardian with a file-hash manifest. An independent verifier checks every file and starts the bundled CLI in CI. An unsigned NSIS installer is built and passes install/uninstall smoke tests on GitHub's Windows runner; see [Windows app packaging](docs/windows-app-packaging.md). Installation and unattended operation on the target machine remain unverified.

## What is still a design or validation target

- Live ZCode desktop enrollment remains unverified. The local app-server probe has not returned a usable model catalog, and no nonce-backed binding has been established; no GLM or DeepSeek desktop model is enabled for routing on that basis. The adapter does not claim actual served-model identity or transfer of the desktop conversation context. See [the enrollment design](docs/zcode-existing-desktop-enrollment.md).
- DSH and isolated ZCode CLI bindings are not enabled for routing merely because their adapters exist. Their bindings must be created and verified in Zero's isolated data area; availability and evidence level depend on the local CLI version and successful checks. See [server setup](src/server/README.md).
- Current review is a new Codex session. It is not a different-model guarantee: when the execution Harness is also Codex, model-level independence depends on the configured reviewer binding.

For the broader target, upstream comparisons, and license review, see [the Zero v1 proposal](docs/zero-v1-proposal.md) and the later [Herdr assessment](docs/herdr-assessment.md). The project is original code rather than a fork of the reviewed projects and is licensed under [Apache-2.0](LICENSE).

## Install and run from source

Requirements: Node.js 24 or newer, Git, and a logged-in Codex CLI for the always-Codex reviewer. API coordinator mode also requires an HTTPS-compatible endpoint and its key available in the Zero service process environment. From the repository root:

```powershell
npm ci
npm --prefix web ci
npm run build
npm --prefix web run build
node dist/cli.js serve
```

Open <http://127.0.0.1:4179>. The server runs independently from the browser. To submit a task from another terminal, use the CLI:

```powershell
node dist/cli.js submit --repo 'C:\path\to\repo' --prompt 'Fix the parser bug' --check 'npm test'
node dist/cli.js status
```

### Ordered task sequences

Submit a JSON file containing at least two ordered task submissions with `submit-sequence`, list sequences with `sequences`, and inspect one sequence with `sequence <sequence-id>`:

```powershell
node dist/cli.js submit-sequence --file sequence.json
node dist/cli.js sequences
node dist/cli.js sequence <sequence-id>
```

Each task entry uses the same fields as `submit`: `repoPath`, `baseRef`, `prompt`, optional `acceptanceCriteria`, `checkCommands`, `maxRevisions`, and optional `execution`. Repeat the repository and base ref for each task. Manual execution choices use `execution.harnessId`, `execution.modelId`, and `execution.reasoningEffort`; omit or leave any of them empty for the configured coordinator to choose from verified bindings.

```json
{
  "objective": "Add account recovery to the application",
  "acceptanceCriteria": ["Users can request recovery", "Recovery links expire safely"],
  "tasks": [
    {
      "repoPath": "ABSOLUTE_PATH_TO_GIT_REPOSITORY",
      "baseRef": "main",
      "prompt": "Add the account recovery request endpoint and tests",
      "acceptanceCriteria": "The endpoint rejects invalid requests",
      "checkCommands": ["npm test"],
      "maxRevisions": 2,
      "execution": { "harnessId": "<verified-harness-id>", "modelId": "<verified-model-id>", "reasoningEffort": "<verified-effort>" }
    },
    {
      "repoPath": "ABSOLUTE_PATH_TO_GIT_REPOSITORY",
      "baseRef": "main",
      "prompt": "Add the recovery form and expired-link handling",
      "acceptanceCriteria": "Expired links show a useful error",
      "checkCommands": ["npm test"],
      "maxRevisions": 2
    }
  ]
}
```

Replace the repository and binding placeholders with real values. Every manually selected Harness/model/effort combination must be currently available and verified. Steps are kept in the submitted order. For steps in the same repository, later work starts from the earlier step's verified result commit. When goal metadata is present, Zero runs an aggregate Codex review after all steps finish and includes its current state and result in the sequence API and UI. A `PASS` yields `completed`; `changes_requested` or `blocked` keeps the sequence blocked, and quota pauses it in `waiting`. The live goal-review flow remains unverified, and findings do not trigger automatic goal-level remediation.

To submit ordered execution stage selections inside one task, pass a JSON array with `--stages-file`. Each stage may set any subset of `harnessId`, `modelId`, and `reasoningEffort`; omitted fields remain available to the configured coordinator. The existing `--harness`, `--model`, and `--effort` options set task-wide defaults, which individual stages can override. Every effective stage selection must match a currently available, locally verified binding.

```json
[
  { "harnessId": "<first-harness-id>", "modelId": "<first-model-id>" },
  { "harnessId": "<second-harness-id>", "modelId": "<second-model-id>", "reasoningEffort": "high" }
]
```

Replace the example IDs with verified binding IDs, save this as `stages.json`, then run `node dist/cli.js submit --repo 'C:\path\to\repo' --prompt 'Implement the change' --stages-file stages.json`. The API checks each effective stage against currently available verified bindings and stores the order as submitted.

The CLI also provides `node dist/cli.js cancel <task-id>`. Run `node dist/cli.js` without arguments for all options. The UI and CLI use the same local service and queue.

On first run, no live-verified model binding is assumed. Follow [server setup and binding verification](src/server/README.md) before submitting a task. Binding verification may make a real model call. Do not put API keys, proxy credentials, or other secrets in the repository or Zero's model registry; authentication comes from the relevant CLI login or process environment. DSH and isolated ZCode CLI bindings use the Zero-owned profiles described in the server guide. The separate existing-desktop ZCode path uses an app-server session and does not copy or edit desktop configuration.

## Runtime data and privacy

By default, Zero keeps its SQLite database, local configuration, worktrees, logs, verification records, and reports outside the source checkout: `%LOCALAPPDATA%/Zero` on Windows and `~/.local/share/zero` on other platforms. For development, set `ZERO_DATA_DIR` to a directory inside the checkout; `data/.zero/` is ignored by Git. Keep this directory private: task prompts, diffs, command output, and reports may contain project-sensitive information.

The HTTP service binds to `127.0.0.1:4179` by default. v1 does not support remote binding. A Git worktree separates task changes from the main checkout, but it is **not an operating-system security sandbox**. Run unattended jobs under a low-privilege account with access limited to the intended repositories and credentials. Validation commands run as child processes and should be treated as code execution.

## Architecture

```text
Web UI / CLI
     │ local HTTP API
     ▼
SQLite queue ── Scheduler / leases ── Master coordinator (Codex or API)
                                      │
                               verified route choice
                                      ▼
                               Git worktree
                                      │
                         Harness adapter → execution
                                      │
                         configured checks / tests
                                      │
                         new read-only Codex review
                            │                  │
                         revise              pass
                            └──── bounded ─────┘
                                  retry
                                     │
                          report and task branch
```

SQLite is authoritative for task state. Zero records attempts and evidence, runs configured checks, and decides whether a task can reach `done`; an agent's completion message alone is insufficient. The detailed target architecture and current gaps are documented in [the v1 proposal](docs/zero-v1-proposal.md) and [the routing and review contract](docs/route-review-contract.md).

## Project notes

- [Zero v1 proposal, upstream comparison, and licenses](docs/zero-v1-proposal.md)
- [Herdr ecosystem reuse assessment](docs/herdr-assessment.md)
- [Workspace and cross-Harness handoff design](docs/workspace-handoff-design.md)
- [Routing and review contract](docs/route-review-contract.md)
- [Local server setup and binding verification](src/server/README.md)
- [Windows unattended deployment](docs/windows-deployment.md)
- [Super Plumber assessment](docs/super-plumber-assessment.md)
- [Live validation record](docs/live-validation.md)

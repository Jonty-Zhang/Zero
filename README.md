# Zero

[中文文档](README.zh-CN.md)

Zero is a local-first task execution node for coding work. Submit a task through the local UI or CLI; Zero stores it in a persistent queue, routes it, runs it in a Git worktree, performs configured checks, requests a separate Codex review, and archives the result. A background service keeps working when the browser is closed.

Zero is an application made of one Node.js service, a local React web UI, and a CLI. The service owns task state and execution; the UI is a client of that service. v1 targets one Windows-first, single-user machine and binds to loopback by default.

## What works today

- A SQLite-backed task queue and local HTTP API, with `pending`, `running`, `reviewing`, `revision`, `waiting`, `done`, and `failed` task states.
- Codex-based task allocation and a separate read-only Codex review. You can pin any subset of the execution Harness, model, and reasoning effort; Codex fills only fields you leave unset, from bindings Zero has verified.
- Codex, DeepSeek Harness (DSH), and ZCode adapters. An adapter being present does not make a Harness/model pair eligible: Zero requires a locally verified binding. DSH and isolated ZCode CLI bindings use Zero-owned profiles. The existing-desktop ZCode `app-server` adapter and `verify-binding zcode-desktop` path are mock-tested; live enrollment has not succeeded, so this route is not verified or available for routing. See [server setup](src/server/README.md) for the verification boundary.
- A task-specific Git worktree, configured validation commands, bounded revision attempts, and an archived report with execution, test, review, and Git evidence. Successful task branches remain in the source repository; Zero does not automatically merge or push them.
- Ordered `executionStages` run serially in one task worktree through the core, HTTP API, and CLI `--stages-file` option. Each stage records a linked attempt, worktree fingerprint, and versioned handoff based on facts Zero observed. Reports include this stage history.
- A `waiting` state for verified provider usage limits, with a persisted checkpoint and scheduled retry. Quota resume is mock-tested, including across service restart; a real provider quota event has not been observed. Ordinary crash recovery is not implemented: interrupted attempts fail closed for inspection rather than resuming automatically.
- A native Windows process guardian with passing CI build and process-containment tests. Deployment to the target machine and a boot test remain unverified; see [Windows deployment](docs/windows-deployment.md).

## What is still a design or validation target

- Live ZCode desktop enrollment remains unverified. The local app-server probe has not returned a usable model catalog, and no nonce-backed binding has been established; no GLM or DeepSeek desktop model is enabled for routing on that basis. The adapter does not claim actual served-model identity or transfer of the desktop conversation context. See [the enrollment design](docs/zcode-existing-desktop-enrollment.md).
- DSH and isolated ZCode CLI bindings are not enabled for routing merely because their adapters exist. Their bindings must be created and verified in Zero's isolated data area; availability and evidence level depend on the local CLI version and successful checks. See [server setup](src/server/README.md).
- Current review is a new Codex session. It is not a different-model guarantee: when the execution Harness is also Codex, model-level independence depends on the configured reviewer binding.

For the broader target, upstream comparisons, and license review, see [the Zero v1 proposal](docs/zero-v1-proposal.md). The project is original code rather than a fork of the reviewed projects and is licensed under [Apache-2.0](LICENSE).

## Install and run from source

Requirements: Node.js 24 or newer, Git, and a logged-in Codex CLI. From the repository root:

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

To submit ordered execution stage selections, pass a JSON array with `--stages-file`. Each stage may set any subset of `harnessId`, `modelId`, and `reasoningEffort`; omitted fields remain available to the Codex allocator. The existing `--harness`, `--model`, and `--effort` options set task-wide defaults, which individual stages can override. Every effective stage selection must match a currently available, locally verified binding.

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
SQLite queue ── Scheduler / leases ── Codex allocator
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
- [Workspace and cross-Harness handoff design](docs/workspace-handoff-design.md)
- [Routing and review contract](docs/route-review-contract.md)
- [Local server setup and binding verification](src/server/README.md)
- [Windows unattended deployment](docs/windows-deployment.md)
- [Super Plumber assessment](docs/super-plumber-assessment.md)
- [Live validation record](docs/live-validation.md)

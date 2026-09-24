# Zero

[中文文档](README.zh-CN.md)

Zero is a local-first task execution node for coding work. Submit a task through the local UI or CLI; Zero stores it in a persistent queue, routes it, runs it in a Git worktree, performs configured checks, requests a separate Codex review, and archives the result. A background service keeps working when the browser is closed.

Zero is an application made of one Node.js service, a local React web UI, and a CLI. The service owns task state and execution; the UI is a client of that service. v1 targets one Windows-first, single-user machine and binds to loopback by default.

## What works today

- A SQLite-backed task queue and local HTTP API, with `pending`, `running`, `reviewing`, `revision`, `waiting`, `done`, and `failed` task states.
- Codex-based task allocation and a separate read-only Codex review. You can pin any subset of the execution Harness, model, and reasoning effort; Codex fills only fields you leave unset, from bindings Zero has verified.
- Codex, DeepSeek Harness (DSH), and ZCode CLI adapters. An adapter being present does not make a Harness/model pair eligible: Zero requires a locally verified binding. DSH uses a Zero-owned profile. The current ZCode binding uses a Zero-owned isolated CLI profile and does not use the provider selection or credentials in the ZCode desktop app.
- A task-specific Git worktree, configured validation commands, bounded revision attempts, and an archived report with execution, test, review, and Git evidence. Successful task branches remain in the source repository; Zero does not automatically merge or push them.
- Each implementation or revision records a stage, a linked attempt, a worktree fingerprint, and a versioned handoff based on facts Zero observed. Reports include this stage history.
- A `waiting` state for verified provider usage limits, with a persisted checkpoint and scheduled retry. Recovery from an interrupted external command fails closed for inspection rather than blindly replaying it.

## What is still a design or validation target

- Automatic multi-stage execution such as ZCode + GLM handing the same worktree to ZCode + DeepSeek is **not yet implemented by the worker**. The worker records handoffs for one implementation or revision at a time but does not yet use them to plan a second execution stage. See [the worktree and handoff design](docs/workspace-handoff-design.md).
- The ZCode desktop `app-server` session-protocol integration is under investigation. No claim is made that Zero can yet use the user's existing desktop GLM/DeepSeek setup, lock a model in a live session, or safely transfer its conversation context.
- DSH and ZCode are not enabled for routing merely because their adapters exist. Their model bindings must be created and verified in Zero's isolated data area; availability and evidence level depend on the local CLI version and successful checks. See [server setup](src/server/README.md).
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

The CLI also provides `node dist/cli.js cancel <task-id>`. Run `node dist/cli.js` without arguments for all options. The UI and CLI use the same local service and queue.

On first run, no live-verified model binding is assumed. Follow [server setup and binding verification](src/server/README.md) before submitting a task. Binding verification may make a real model call. Do not put API keys, proxy credentials, or other secrets in the repository or Zero's model registry; authentication comes from the relevant CLI login or process environment. For DSH and ZCode, use the Zero-owned isolated profiles described in the server guide; do not copy or edit an existing desktop configuration.

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

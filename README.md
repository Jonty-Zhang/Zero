# Zero

Zero is a local task execution node. A background worker takes a coding task, asks Codex to choose a verified execution Harness and model, runs the task in its own Git worktree, executes required checks, asks a fresh read-only Codex session to review the result, and revises within a fixed budget. It archives the branch, diff, logs, checks, review and report before marking the task done.

Zero ships as one application: a Node.js service with a local Web UI and a CLI. The service continues processing when the browser is closed. The allocator and reviewer are always Codex. For execution, each task can independently pin its Harness, model and reasoning effort; Codex fills only unset fields.

## Current scope

- Windows-first, single machine and single user; local HTTP binding only.
- Codex, DeepSeek Harness (DSH) and ZCode adapters. A pair of Harness and model is routable only after its CLI and model binding have been verified. DSH and ZCode require installation and version-specific model-locking evidence; they are not enabled merely because an adapter exists.
- SQLite queue with leases, isolated Git worktrees, bounded logs, direct-argv checks, Codex review and limited revisions.
- Successful output remains on a `zero/<task-id>` branch in the source repository. Zero does not automatically merge or push task branches.
- A recovered task with an interrupted execution or an existing worktree stops for inspection rather than rerunning an unknown external action.

## Run from source

Install Node.js 24 or newer, Git and the Codex CLI, then:

```powershell
npm ci
npm --prefix web ci
npm run build
npm --prefix web run build
node dist/cli.js serve
```

Open `http://127.0.0.1:4179`. Zero stores its local configuration, SQLite database, worktrees and reports outside the published source tree by default. Set `ZERO_DATA_DIR` to choose another directory. The app starts with no live-verified execution binding; complete a real binding verification before submitting tasks. See [server setup](src/server/README.md) for the local config and verification command.

For a source-checkout-only data directory that stays out of Git:

```powershell
$env:ZERO_DATA_DIR = 'C:\path\to\zero\data\.zero'
node dist/cli.js serve
```

The UI lets you specify any subset of execution Harness, model and reasoning effort. Every task needs at least one explicit validation command. The Test Runner invokes commands as argument arrays without a shell, and Zero cannot mark a task done when required checks fail or are absent.

## Architecture and references

- [Zero v1 architecture, upstream comparison and licenses](docs/zero-v1-proposal.md)
- [Routing and review contract](docs/route-review-contract.md)
- [Windows unattended deployment](docs/windows-deployment.md)

The code is original and does not fork any of the reviewed projects. CAO and Hydra informed the architecture. Zero is licensed under [Apache-2.0](LICENSE).

## Safety boundary

A Git worktree isolates source changes, but it is not an OS sandbox. Run unattended tasks and their checks under a dedicated low-privilege account with access only to intended repositories and credentials. Zero fails closed when model binding, checks, review, commit or reporting cannot be established. Its HTTP API binds to loopback in v1.

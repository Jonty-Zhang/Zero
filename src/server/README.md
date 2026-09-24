# Local server configuration and runtime

The server binds to `127.0.0.1:4179` by default and serves the production UI from `web/dist`. Runtime state lives under `%LOCALAPPDATA%/Zero` on Windows or `~/.local/share/zero` on other systems (SQLite, worktrees, artifacts, config and verification logs). Set `ZERO_DATA_DIR=data/.zero` for a source checkout; `data/.zero/` is gitignored. Set `ZERO_HOST` only to `127.0.0.1`, `localhost` or `::1`; remote binding is not supported by v1.

Run `zero serve` to start the long-lived process. It periodically checks the SQLite queue, so closing the browser does not stop work. On startup it recovers expired leases; an interrupted attempt remains fail-closed and is not silently rerun.

Zero uses `codex` from `PATH` by default. Set `ZERO_CODEX_EXE` to an explicit Codex CLI executable when the desired binary is not on `PATH`; the setting is used by both the server runtime and `zero verify-binding`. For example, in PowerShell:

```powershell
$env:ZERO_CODEX_EXE = 'C:\Users\you\AppData\Local\Programs\codex\codex.exe'
zero verify-binding codex gpt-6-sol
zero serve
```

Keep the variable set in the environment that launches the server so runtime calls use the same CLI installation and version that was verified.

Codex Harness child processes inherit `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` (including lowercase spellings) when present. If a proxy URL contains credentials, Zero redacts the URL and its username/password if the CLI echoes them in captured output. Test/check commands keep their separate restricted environment unless explicitly configured.

Codex CLI sessions may appear under Recent in the Codex app when they use the same `CODEX_HOME` and account; allocator and reviewer sessions are ephemeral. Zero's task state and report remain in Zero. App-created project grouping can differ because Zero runs tasks in worktrees.

The initial local registry contains the `gpt-6-sol` model entry and no verified bindings. A Codex CLI version/help check can report CLI health, but it does not prove login, model selection or a successful model call. Stop the Zero server before running `zero verify-binding codex gpt-6-sol`; the command makes a minimal headless model call using `codex exec` with `--model` and a verified reasoning effort (high by default), requires a successful exit and unique response token, and records the timestamp, CLI version, requested model, exit code and evidence level in the local `config.json`. If Codex reports the actual model in its JSONL events, the command requires a match and records `event_confirmed`; if it omits that evidence, the binding is recorded as `selector_only` and is never described as actual-model-confirmed. Only the tested reasoning effort is enabled; verify additional levels one at a time with `--effort low`, for example. Restart the server after verification.

To register another model, edit the local `models` array in the platform-specific config file and run the verification command. Never put credentials in this file. Adapter credentials come from the process environment or CLI login. DSH probes and runs use the Zero-owned `dsh-home` directory under `ZERO_DATA_DIR`; they do not read the user's default DSH profile. Provision a named profile under `dsh-home/profiles/<profile>` and run `zero verify-binding dsh <local-model-id> --profile <profile>` with the server stopped. The command rejects unsafe names, missing profile directories, and paths that resolve outside that profiles directory; it inspects the profile's effective `agent-default-model`, makes a minimal headless nonce call in a temporary workspace, checks the CLI/profile again, and only then stores a version-pinned binding. No DSH reasoning effort is enabled. If DSH omits actual-model evidence, Zero records `selector_only` to show that the selected profile answered but the model identity was not independently reported. Verification output is not saved as an artifact, and failures leave the previous binding/config unchanged. Restart `zero serve` after successful verification because its adapters capture bindings at startup. Set `ZERO_DSH_EXE` when the DSH executable is not available on `PATH`, or set `ZERO_DSH_ENTRY` to an absolute `.js`, `.mjs`, or `.cjs` CLI entry when launching the JavaScript CLI through Node is required. On Windows Task Scheduler deployments, `-DshEntry` passes this optional path through the startup launcher. Different DSH models may use different safe profile names.

`zero submit`, `zero status` and `zero cancel` call the local HTTP API. All requests require a loopback Host with the listener port; mutating HTTP requests additionally require an Origin whose full host and port match. When using the Vite dev proxy, set `ZERO_TRUSTED_PROXY_HOSTS=localhost:5173,127.0.0.1:5173` on the server process.

# Desktop capability refresh and hidden-page polling

Baseline: local commit `5eb450fe57585288088832d8cb802046bc486100`. This change addresses redundant desktop UI work. It does not establish the cause of the user's computer fan noise and does not restrict test concurrency.

## Reproduction

The desktop app polls capabilities every 15 seconds. Each GET previously called every configured adapter's probe independently, including after a client disconnected. A root reproduction used actual loopback HTTP and barrier-controlled adapters, without invoking providers: three simultaneous requests produced three active probes per adapter, nine total. An aborted request continued probing while its replacement started another probe.

The polling hook also continued scheduling automatic requests while the document was hidden. Fake-timer regressions reproduced hidden initial loading, continued hidden polling, delayed refresh after visibility restoration, and continued hidden automatic polling after an explicit manual refresh. The expanded original-source run failed six of eight hook cases; existing serial and identity controls remained passing. The original server failed four of nine expanded HTTP controls before the final all-three-adapters case was added.

## Change

Each server now shares only in-flight GET capability work for the complete configuration snapshot. Different server instances and different configurations remain independent. Settled or failed results are removed, so the next request probes again; a disconnected client cannot evict work still needed by another client. Task submission, sequence validation and configuration saving retain independent fresh capability checks. Tests prove fresh unavailability rejects a mutation even when a concurrent UI probe reports availability.

Automatic polling pauses while the document is hidden. Becoming visible refreshes immediately; if a request is still running, one refresh waits for it to settle. Explicit manual refresh remains available while hidden. Existing effect identity, abort and late-result guards remain, and cleanup removes the visibility listener and timer. Visible polling intervals and backend task execution are unchanged.

## Verification

The four applied files match manifest `d8396d50ab333d8de7483faa7287929fda590050192caf072f5534d1b0f3bc79`. GPT-6 Astra high independently approved them after a fresh compile, ten real HTTP controls and eight hook controls, all exit 0. The implementation mirror passed 48/48 HTTP/server/report cases, 64/64 web tests, 11/11 API tests, web type checking and the production build, all exit 0.

Root integration compiled successfully. Its web test log has a terminal 64/64 passing summary; the API run returned exit 0 with 11/11 passing, and web type checking and the production build returned exit 0. The root web process's completion handle was lost during a conversation interruption, so its separate exit-code receipt is unavailable. This is not substituted for the mirror's independently recorded exit 0.

The first combined complete-core run was interrupted before its final summary. Its process handle was missing and a targeted process query confirmed no matching test process remained. The log is retained as an interrupted run, with no pass/fail aggregate claimed. The replacement complete run finished with **639/639 passing, exit 0**, without canceled or skipped tests. Its repository-local runner recorded the final exit code and log hash; a separate verifier confirmed that all 178 source/build files remained identical and that the log matched the recorded hash. It used default concurrency with the Git/worker diagnostic observer enabled. See [the complete-run receipt](2026-10-22-full-regression-audit.md) for the exact command and evidence.

No live provider was used. All source changes, fixtures, caches, logs and configuration remain inside the repository. The user's requested GitHub push and main integration remain unfulfilled because the repository-contained GitHub configuration has no authenticated session and the process has no token. No external credentials were read.

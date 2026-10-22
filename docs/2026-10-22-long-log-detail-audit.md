# Bounded tails for long desktop task logs

Long agent and check logs disappeared from task detail once an archived stdout/stderr file exceeded 256 KiB. The API returned only a size warning, hiding the latest recorded diagnostic. Three actual HTTP controls failed against the original implementation with exit 1.

Task detail now displays the last 256 KiB of each oversized artifact, prefixed with `[日志已截断，仅显示最后 256 KiB]`. Small, empty and exact-limit logs retain their previous behavior. Artifact-root realpath checks remain in place, and archived files are not rewritten. The display reads only bytes already archived; it does not expand the process collector's separate default 2 MiB capture limit.

The reader allocates at most 256 KiB per artifact, opens one handle, takes a size snapshot and reads a fixed extent using explicit positions. Partial reads stop at that extent or EOF. It decodes only bytes actually read and skips initial UTF-8 continuation bytes when the tail starts inside a character. A growing file cannot extend this request's read range; a shrinking file cannot reveal uninitialized buffer contents. `finally` closes the handle. Combined streams and JSON still have their normal additional memory cost.

Parent review restored the pre-open non-file check, followed by another check on the opened handle. This preserves the old behavior for directories and avoids opening an already-present FIFO on platforms where that can block. Directory behavior was tested on Windows; FIFO compatibility was reviewed statically and was not dynamically tested on this host.

## Verification

The two applied files match frozen manifest SHA-256 `8c6d9b789b1e1e2ad52404229eb0290ecdf048115f278644cbaec8478d9b93ac`. The parent reviewed the final code, regression assertions and real-handle snapshot control before applying it. An Astra review of this routine display change was interrupted immediately following the user's instruction to reserve Astra for critical logic; no Astra approval is claimed.

The isolated candidate compiled successfully, passed six task-detail tests and ten capability tests, all exit 0. Coverage includes attempt/check stdout and stderr, combined task logs, append/refetch, preservation of archived bytes, Chinese/emoji cut points, empty/small/exact-limit files, outside/missing artifacts and directories. Original-source failure logs are retained.

An additional control used actual loopback HTTP and real FileHandle reads, injecting only a writer after the snapshot. Growth required eight partial reads totaling 262144 bytes and excluded appended content. Truncation returned zero bytes without uninitialized text. Both scenarios confirmed one open and one close and exited 0.

After hash-checked root application, root TypeScript compilation returned exit 0. The complete affected server/capabilities/cancel-report groups passed **50/50 tests, exit 0**, with no cancellations or skips, at default concurrency. The source change is limited to the artifact reader; task cancellation, capability sharing and mutation validation passed their integration controls. The earlier **639/639** complete core run covered the immediately preceding source, not this later reader change; see [its separate audit](2026-10-22-full-regression-audit.md).

Evidence remains under `data/verification/log-tail-audit/`: `handoff.md`, `frozen-files.json`, `final-receipt.json`, `baseline-red-v2.log`, `snapshot-receipt.json`, `root-application.json`, `root-build.log`, `root-server-tests.log` and `root-server-exit.json`.

All changes, fixtures, logs and configuration remain inside the repository. No external provider was called. GitHub publication remains unfulfilled; no remote push or remote main merge is claimed.

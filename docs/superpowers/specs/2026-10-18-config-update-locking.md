# Serialized JSON configuration updates

Confirmed problem: settings saves, model enrollment and binding verification each read a JSON snapshot and later atomically rename a full replacement. Concurrent successful operations can silently erase an unrelated operation. Atomic replacement prevents partial JSON, but does not serialize those updates.

Keep JSON authoritative and keep `write()` limited to merging allocator, reviewer and optional execution defaults into the latest private state. Serialize every mutator from its fresh read through tuple/version validation, modification and rename. Pure argument/proof validation may precede the lock; probes, nonce calls and provider execution stay outside it.

Resolve the physical configuration path (including parent aliases and Windows case identity) before queuing. A process-wide queue for that canonical path prevents local writers from overlapping. An adjacent, independent SQLite database provides `BEGIN IMMEDIATE` mutual exclusion across processes. Use zero SQLite busy timeout and short asynchronous retries with a bounded wait; do not busy-wait on the event loop. Commit only after JSON replacement, and roll back/close in `finally`. Process termination releases SQLite's OS locks without PID expiry heuristics. All writes use the resolved JSON target, retaining file-symlink identity.

Plan:

1. Add deterministic RED regressions for settings versus enrollment/verification in both orders and with shared/separate instances. Include real CLI enrollment versus HTTP settings.
2. Add cross-process, Windows case/short-directory alias, killed-holder, rejected-mutation and legacy-file checks.
3. Introduce canonical-path queue and SQLite lock; wrap every configuration mutator, retaining no-op and field-preservation behavior.
4. Verify GREEN in an ignored build directory, run existing configuration and API checks, and hand the uncommitted change to root for independent review.

Two users deliberately saving complete settings snapshots can still replace each other's settings; this change protects the separate model/binding/verification/private-state mutations, without introducing UI version control. External editors that do not use ConfigStore remain outside its update protocol.

Codex verification has a related stale-caller boundary: the provider call happens before mutation locking, so its caller must submit only the effort proved by that call and its single proof. `markVerified` atomically accumulates fresh existing efforts only when the saved binding matches the exact current provider/model tuple and both binding and verification match the incoming pinned CLI version. Incoming proof wins for the same effort. A tuple/version mismatch replaces the old effort set and discards its proofs. The real caller also supplies its expected model tuple for lock-time revalidation; probes and nonce calls remain outside the lock.

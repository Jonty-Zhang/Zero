# Windows guardian containment

The guardian owns a stable per-user mutex for each lock ID. While holding it,
it opens any prior named Job for that lock and waits until its active process
count reaches zero. It then closes the prior Job handle and creates a fresh
named Job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The child starts suspended,
is assigned to the new Job, and resumes only after assignment succeeds.

After the mutex is owned and the prior named Job query completes successfully,
the guardian passes `ZERO_GUARDIAN_LOCK_ID`, a fresh 128-bit hexadecimal
`ZERO_GUARDIAN_GENERATION`, and `ZERO_GUARDIAN_PREDECESSOR_DRAINED=1` to its
child. A missing prior Job is treated as an empty predecessor under the same
mutex check. Zero verifies that the lock ID is the SHA-256 of its normalized
data directory and queries its own PID's Job membership before recording the
startup lineage, then attaches that generation to task claims and started
stages. If those values are absent, incomplete, mismatched, or unverifiable,
Zero records the startup as unguarded, rejected, or member-unverified.

These inherited variables are assertions, not authentication. A process
running as the same Windows account can set them itself; they do not prove to
SQLite that guardian.exe was the sender. They exist to correlate normal
guardian launches and catch configuration mistakes, and they do not authorize
replaying execution or review work.

`guardian.exe --verify-startup --lock-id <lock-id> --generation <32-hex>
--pid <pid>` adds an OS-backed startup prerequisite. After the predecessor Job
has drained, the guardian creates a pagefile mapping named
`Local\ZeroGuardianStartup_<sid>_<lock-id>`. It fails closed if that name
already exists. Once the direct child is created suspended and assigned to the
new Job, the guardian publishes a versioned record containing the generated
generation, its own PID and process creation time, and the direct child's PID
and process creation time, then resumes the child. The guardian retains the
mapping handle until it exits. Verification checks the requested generation
and PID against the record, confirms both exact process instances are live,
and confirms the recorded child is a member of the named Job. Descendants fail
because their PIDs are not the recorded direct child PID. After guardian exit,
the mapping disappears and startup verification fails.

The mapping uses the `Local` namespace because the guardian and its child share
an interactive session. Microsoft documents that creating a `Global` file
mapping outside Session 0 requires `SeCreateGlobalPrivilege`; the existing
`Global` mutex and Job continue to provide cross-session serialization and
containment. The mapping's default DACL is the current user's default DACL.
This proves the normal guardian launch ordering and exact child identity against
accidental or unprivileged mismatches. It does not defend against malicious
software running as the same account, which can create or alter equivalent
named objects or modify the package.

The API behavior follows Microsoft's documentation for
[kernel object namespaces](https://learn.microsoft.com/en-us/windows/win32/termserv/kernel-object-namespaces),
[named file mapping creation](https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-createfilemappingw),
[opening a file mapping](https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-openfilemappingw),
[viewing a file mapping](https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-mapviewoffile),
and [process creation times](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes).

`guardian.exe --verify-member --lock-id <lock-id> --pid <pid>` is a read-only
membership query. It derives the same per-user named Job, opens it for query,
opens the target PID with limited query rights, and calls `IsProcessInJob` on
that process handle. It exits 0 only when the target is a member; malformed
arguments, a missing Job, an inaccessible PID, and a non-member all fail
closed. This remains a diagnostic helper and does not prove startup order or
direct-child identity. Zero now invokes `--verify-startup` through the fixed
absolute `guardian/guardian.exe` path in its installed package, rejects
symlinked path components, and does not search `PATH`. Historical
`guardian_env_assertion` and `member_verified` records remain readable but do
not authorize a new predecessor link. Same-account software that can alter
the installed package or create equivalent named objects is outside this
check's threat boundary.

The ordering matters: `KILL_ON_JOB_CLOSE` acts when the last Job handle closes.
The successor must not open the previous Job before the previous guardian exits,
because an early handle would keep that old Job alive and postpone last-handle
cleanup. Mutex abandonment reports that the owning thread exited; the successor
then checks the old Job before launching anything. Query failures stop the
successor instead of treating an unreadable Job as empty.

The regression test intentionally has a same-user Job member open an extra
named Job handle before crashing the guardian. This holds the old tree in place
so the test can prove the successor stays alive without launching, then proceeds
after the helper terminates the tree. A child that keeps such a handle
indefinitely can make successors wait indefinitely; they remain fail-closed and
do not launch a second instance while the old Job still reports active processes.

The containment guarantee starts when `AssignProcessToJobObject` succeeds. A
guardian crash after `CreateProcessW(CREATE_SUSPENDED)` but before assignment
can leave that suspended process outside the Job. The launcher's descendants
normally join the same Job; Windows permits breakaway in configurations that
allow it, so software or surrounding Job policies that enable successful
breakaway can create processes outside this containment tree. Assignment can
also fail due to restrictions imposed by an enclosing Job, in which case the
guardian terminates the suspended process and does not resume it.

This implementation follows the Windows contracts documented for
[named mutex creation](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createmutexw),
[abandoned mutexes](https://learn.microsoft.com/en-us/windows/win32/sync/mutex-objects),
[named Job creation](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw),
[opening a Job](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-openjobobjectw),
[Job active-process accounting](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information),
[last-handle termination](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information), and
[process assignment and breakaway](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject).

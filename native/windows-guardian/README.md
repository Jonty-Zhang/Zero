# Windows guardian containment

The guardian owns a stable per-user mutex for each lock ID. While holding it,
it opens any prior named Job for that lock and waits until its active process
count reaches zero. It then closes the prior Job handle and creates a fresh
named Job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The child starts suspended,
is assigned to the new Job, and resumes only after assignment succeeds.

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

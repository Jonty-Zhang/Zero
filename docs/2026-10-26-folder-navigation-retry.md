# Folder navigation failures cannot select an old directory

## Reproduced problem

After browsing directory A successfully, a failed attempt to open directory B
left A's listing and selection controls visible. Clicking “选择此文件夹” chose
A, even though the browse path and error referred to B. A failed child-directory
navigation also left the parent path in the input, so “打开路径” retried the
parent rather than the requested child.

Three React regressions failed before the fix. A real Edge run against an
isolated synthetic HTTP API also reproduced the old listing and successfully
clicked its wrong-directory selection button. No real folder was prepared and
no real task queue or provider was used.

## Corrected behavior

Each navigation clears the previous listing and new-child draft immediately,
and records the requested path in the browse input. Only the current successful
request restores selection controls. Errors retain the attempted path for retry;
aborted and closed-browser requests still cannot restore stale results. The
main project path and task objective remain unchanged until the user explicitly
selects a successfully listed directory.

## Verification

All **107 React tests** passed, the production web build passed, and all **14
client API tests** passed. The first API run was blocked by sandbox loopback
`EACCES`; it is retained as failed evidence and was rerun successfully with
permission for the fixture's own loopback connections.

The same Edge scenario now finds no stale listing or selection controls after
the failed request. Retrying opens the exact intended path; selecting it still
makes zero preparation/submission calls. Explicit task submission then prepares
that intended path once and submits once. No browser page errors were recorded.

Independent review found no confirmed unresolved defect. Five separately
authored DOM cases passed, including late success/failure from an aborted
request, close/reopen races, canonical server paths and default-path retries.
The same cases against a local component copy with only this fix removed
produce one genuine stale-selection failure and four passing controls. The
report is `data/verification/boss-folder-navigation-review/final-review.md`.

Evidence, screenshots and pre-fix failures are retained under the ignored
directory `data/verification/boss-folder-navigation-root/`. Backend behavior and
the project preparation endpoint did not change in this round.

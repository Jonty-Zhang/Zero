# Boss supplementary message delivery

The project flow and its earlier acceptance evidence are recorded in
[the Boss projects audit](2026-10-26-boss-projects-audit.md). This follow-up fixes
a separate delivery bug found while auditing that flow.

## Reproduced problem

A supplementary requirement could be saved successfully while its HTTP response
was lost. The browser did not retain a delivery identity, and the message endpoint
did not honor one. Retrying could append the same requirement again. The initial
HTTP reproduction returned different message IDs for concurrent requests with the
same key; the client reproduction observed no retry key. Both failed before the fix.

## Behavior after the fix

- The browser retains a request identity for an uncertain message delivery using
  the existing submission helper. It survives module reload through session
  storage, which stores a digest and identity rather than the message text.
- SQLite stores the original message receipt. Receipt lookup, message append,
  task timestamp update and receipt insertion share one transaction. An insertion
  failure rolls back the message and timestamp, leaving the key available to retry.
- Matching retries return the original message ID, content and timestamp, including
  after a server restart or after acceptance/cancellation closes new submissions.
  Replaying a receipt does not append an event or change the task timestamp.
- Reusing a key for a different task or different normalized content returns 409.
  A new key still follows the existing acceptance, cancellation and terminal-state
  admission rules. Model-authored messages cannot use human delivery receipts.
- Once acknowledged, deliberately sending the same text again gets a fresh identity.
  Existing callers without a key retain their previous append behavior. A custom
  store without reliable keyed delivery rejects a keyed request with 501 before
  appending anything, rather than silently degrading the guarantee.

The schema change adds a dedicated receipt table without rewriting existing task
or submission tables. Dedicated keyed store calls validate a missing or malformed
key instead of treating it as an unkeyed delivery.

## Verification

The final source passed 131 affected backend tests across eight files, including
the six new store/HTTP tests, existing task submission identities, cancellation,
Boss plan contracts and folder preparation. The HTTP tests use an owned local
server and real SQLite, including concurrent requests and database/server reopen.
The frontend passed all 98 React tests and 14 API tests, and its TypeScript/Vite
production build succeeded. `git diff --check` passed.

An independent reviewer found no confirmed actionable defect. It separately
compiled the source, passed the three new core tests, two existing client retry
tests and two independently authored tests. Its additional tests checked exact
task/event preservation on replay after acceptance or cancellation, database
restart and separate connections, message-specific module reload, task isolation
and storage contents. Its own three HTTP tests were blocked before application
handling by sandbox loopback `EACCES`; they are not counted as passing review
executions. Root's permitted HTTP run passed. Root's initial sandbox-blocked API
run is also preserved alongside the permitted 14/14 result.

Evidence, including the failing reproductions, is in the ignored repository-local
directories `data/verification/boss-message-root/` and
`data/verification/boss-message-review/`. No real model provider, user queue or
existing user service was used. The earlier 755-test full-suite result belongs
to the preceding feature baseline; it is not presented as a new full-suite run
for this follow-up.

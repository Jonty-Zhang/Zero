# Boss lead admission and uncertain submission confirmation

## Reproduced problems

Boss submissions could enter the queue and initialize a project despite having
no available, verified Codex lead. An available DeepSeek worker alone was enough
for the previous interface to suggest that the project could start. Seven UI
cases and six real HTTP cases reproduced the missing admission check before
the fix.

Independent review of the initial fix found an additional retry boundary: an
accepted task whose response is lost must remain confirmable after capabilities
become unavailable. Blocking that unchanged request would defeat the server's
existing durable idempotency replay. Both root and independent UI cases failed
before the retry correction.

## Corrected behavior

The form waits for healthy capability data and an available Codex lead binding
before admitting a new project. Loading, connection errors and missing lead
verification preserve the draft and explain why submission is unavailable.
Free-form model and delegation preferences remain free-form; another harness
mentioned in a preference does not have to be available to admit the lead.

The task API checks current lead readiness before its own project preparation.
Sequence admission uses its existing shared capability snapshot. Durable task
and sequence replay lookup still happens first: an already accepted request can
be confirmed without probing providers or enqueueing another task.

After preparation succeeds and createTask is attempted, the modal remembers the
exact prepared payload and original draft identity. An unchanged, unconfirmed
submission offers “确认上次提交” and reuses that payload and the API's existing
idempotency key without preparing the folder again, even if capability data is
temporarily unavailable. Changing the path, objective, preference or create flag
requires normal new-submission readiness. Preparation failures gain no retry
exemption. This modal cache does not persist across closing or reloading it.

The separate project preparation endpoint is unchanged. A capability change
between a frontend preparation request and task admission can still leave a
prepared folder, while the server correctly rejects the new task.

## Verification

- Final frontend suite: **119/119**, seven files; production web build passed.
- Final server suite: **64/64**, five files covering readiness, folder preparation,
  server APIs, Boss message idempotency and runtime binding guards; TypeScript
  build passed.
- Actual client API suite: **14/14** with owned loopback access.
- Independent review: **8/8** separately authored UI cases, **6/6** HTTP readiness
  cases and **1/1** additional production-runtime-guard sequence case passed.
  The confirmed retry finding was resolved; no confirmed unresolved finding
  remains in this round's admission/retry scope.
- Real headless Edge, using only an isolated synthetic HTTP fixture: a DSH-only
  capability state blocked both ordinary and implicit form submission without
  preparing anything. Capability recovery preserved the original draft. After
  the fixture accepted a task but returned truncated JSON, loss of the lead
  still allowed confirmation using the identical body and idempotency key.
  Totals: one preparation, two deliveries, one accepted task, no browser page
  errors. The 1440px screenshot was inspected for layout and retry controls.

Initial failures remain in the ignored evidence directories. One existing HTTP
fixture incorrectly attempted to seed a model registry through a preference-only
configuration writer; its setup now writes its own initial fixture configuration
and uses a fake adapter. Independent HTTP sandbox EACCES is recorded as failed,
followed by a successful permitted owned-loopback run. Browser fixture failures
from a malformed selector and an unsuitable connection-drop simulation were
retained; the final fixture uses deterministic truncated JSON instead.

Evidence is under `data/verification/boss-readiness-root/` and the independent
report is `data/verification/boss-readiness-review/final-review.md`. All model
adapters are fake and reject actual execution. No real provider task, user
queue, original project folder or existing browser profile was exercised.

The previous model-effort and folder-navigation commits also have confirmed
successful Linux and Windows GitHub CI runs, respectively 40287955214 and
40288923646. This round's local results above are for the final source, rather
than an assertion that those earlier CI runs cover this commit.

Per the user's instruction, this is the final bounded repair round before
pausing for inspection; no subsequent issue-discovery round is started.

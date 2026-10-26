# Desktop workspace presentation refresh

## Intent and references

The user requested frontend improvements informed by open-source web interfaces.
The implementation retains Zero's React, TypeScript, Vite and Lucide stack and
its existing API and task semantics. The main target is a desktop agent workspace.

The design references are the official shadcn/ui examples and documentation:

- [Tasks](https://ui.shadcn.com/examples/tasks): table-first task management with
  filters directly above the dataset and restrained state indicators.
- [Dashboard](https://ui.shadcn.com/examples/dashboard): clear separation of
  navigation, page context, summary cards and the main work area.
- [Sidebar](https://ui.shadcn.com/docs/components/sidebar): stable header,
  navigation and footer regions with a compact layout for narrower windows.
- [Theming](https://ui.shadcn.com/docs/theming): shared semantic colour tokens
  and consistent surface, border and foreground treatments.

The [shadcn/ui repository](https://github.com/shadcn-ui/ui) is MIT licensed.
These references informed the composition and visual hierarchy; no upstream
source, assets or templates were copied into Zero. No shadcn, Tailwind, remote
font, analytics or image dependency was added.

## Delivered presentation

- A light navigation rail, neutral surfaces, green primary actions, and separate
  colours for task states. Text, forms and focus indicators use a common palette.
- A dedicated Boss project entry explains the existing design, delegation and
  acceptance workflow and opens the same guarded Boss modal as the top action.
- More compact overview cards, filters and task rows; status, executor, model,
  repository and timestamp remain visible in their existing columns.
- Consistent Boss form, folder browser, detail drawer, discussion, delivery and
  settings surfaces. The detail drawer is wider on desktop for plans and evidence.
- Explicit short-window layout rules and retained keyboard focus indicators and
  reduced-motion support. Desktop remains the main target; narrow-window rules
  preserve the existing fallback navigation instead of creating a mobile product.

The readable presentation rules are in `web/src/workspace.css`, loaded after the
existing functional/detail styles. Task states, capability loading, submission
readiness, durable retry identities, folder preparation, message delivery,
acceptance, polling, filtering and server endpoints are unchanged. All displayed
counts and connection states still come from the actual polling data. There are
no illustrative metrics, fabricated activity or new automatic submissions.

## Verification

The final React suite passed **119/119**, across seven files, and the production
web build succeeded. There are no new runtime or development dependencies.
Independent review passed **91/91** existing App/Boss cases and **2/2** additional
cases for the new entry's focus restoration and capability-error admission. No
confirmed actionable issue remained in this round's presentation scope. The
reviewer inspected root's screenshots; they did not independently run Edge or
claim the full 119-case suite and build as their own execution.

An owned headless Edge profile and a synthetic HTTP fixture exercised:

- Workspace layouts at 1440, 1920, 1280 and 960 pixels without page-wide horizontal
  overflow. A 1280 by 720 window can scroll the Boss form and reach its submit.
- Search and status filtering, followed by list/board switching.
- The new project entry opening the existing Boss dialog; explicit folder
  selection caused zero preparation requests and zero task submissions.
- Keyboard Tab remaining inside the dialog.
- The original delivery path, Boss plan, discussion and settings, including the
  initially collapsed advanced configuration.
- Empty tasks and a disconnected service retaining the last task list with an
  explicit stale-data warning and a disconnected status.

Screenshots of the workspace, Boss form, folder browser, plan, discussion,
settings and short-window form were inspected. The fixture recorded zero page
exceptions, zero project preparations and zero task creations. No real model,
provider, task queue or existing browser profile was used. An initial fixture
selector syntax error was retained as failed evidence and corrected in the test
script before the complete successful rerun; production code was unaffected.

After strengthening the tertiary text colour, the final Edge run also measured
14 representative text/background pairs from actual computed styles: task IDs,
models, timestamps, connection labels, summary notes, placeholders, form hints,
plan stages and discussion text. Each met a 4.5:1 minimum, with measured ratios
from 4.59 to 7.80. This is a targeted readability check, not a certification of
all historical UI styles or all accessibility requirements.

Local evidence and screenshots are in the ignored directory
`data/verification/frontend-workspace-root/`. Independent review results are
recorded separately under `data/verification/frontend-workspace-review/`.

The existing two-case Edge readiness/retry fixture also passed against the new
production build: no verified Codex lead prevents a new submission, while an
already accepted request with a truncated confirmation response can be retried
with the identical payload/key after capability loss. It prepared once and
delivered twice but created only one synthetic accepted task. Its separate
result is `final-browser-exit.json` in this round's evidence directory, alongside
`final-readiness-browser.log`. Both browser fixtures passed against the final
rebuilt source after the colour adjustment.

This is a bounded frontend improvement. It does not resume the earlier open-ended
backend audit or claim new live cross-provider verification.

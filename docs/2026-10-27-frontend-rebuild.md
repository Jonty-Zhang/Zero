# Frontend rebuild · 2026-10-27

This replaces the earlier green sidebar presentation. The frontend remains the local Zero application; no remote UI service or frontend framework was added.

## References and applied decisions

The references include publication, blog and editor projects, rather than only agent dashboards:

- [Ghost Casper](https://github.com/TryGhost/Casper) and its [publication demo](https://casper.ghost.io/): content hierarchy, readable long-form material and restrained separators informed the plan/discussion views.
- [AstroPaper](https://github.com/satnaing/astro-paper) and its [blog demo](https://astro-paper.pages.dev/): compact navigation and direct content lists informed the masthead and task list.
- [Novel](https://github.com/steven-tey/novel): a document-oriented editor reference for giving text actual reading space instead of dense administrative annotations.
- [Cal typography](https://cal.com/font): a reference for assigning different type roles deliberately. Zero does not ship Cal's font or copy its proprietary website assets.
- [GOV.UK Frontend](https://github.com/alphagov/govuk-frontend) and its [text input guidance](https://design-system.service.gov.uk/components/text-input/): short, direct labels and concise help informed the later form copy pass. Zero keeps its own typography and visual design.

The implementation and styling are original. No source code from these projects is vendored, and their respective licenses do not replace Zero's license. Shipped font licenses are retained separately in `web/public/fonts/`.

## Implemented

- A horizontal masthead replaces the fixed sidebar. Real connection state and refresh remain available.
- Removed launch tutorials, repeated workflow slogans, redundant local-node labels and visible truncated task IDs from list rows.
- Warm paper surfaces, charcoal controls and restrained state colors replace the green dashboard theme.
- Four self-hosted font roles: Noto Sans SC body, Noto Serif SC headings, Instrument Serif wordmark/numerals, JetBrains Mono code. See [font provenance](2026-10-27-local-fonts.md) for versions, licenses, distribution size and coverage limitations.
- Typical descriptions and hints use 14px; reading text uses 15–16px. Code, model identifiers and timestamps use 13–14px.
- Rebuilt project form, folder browser, delivery information, plan, acceptance criteria, assignments and conversation presentation. Validation commands and team preferences can be expanded when needed.
- Settings show actual Agent availability instead of a repeated four-step tutorial. Necessary unavailable-model, retry, original-folder and credential handling notices remain.
- `base.css` imports existing functional styles into the `legacy` cascade layer. `workspace.css` owns the current presentation, preventing old high-specificity rules from shrinking text again.
- Added a local SVG favicon, matching theme color and a direct browser title.
- Static HTTP delivery now labels WOFF2 as `font/woff2`, with a real HTTP test for bytes, headers and security headers.

## Verification

- Frontend: all 119 tests pass; production TypeScript/Vite build passes.
- Owned headless Edge with synthetic APIs and no real task queue: desktop widths 960, 1280, 1440 and 1920; search/status filters; list/board; project/folder form; keyboard focus containment; reachable submit at 1280×720; delivery path; plan/discussion; settings; empty and disconnected states.
- CDP reports custom Noto Sans SC, Noto Serif SC and Instrument Serif used for actual rendered glyphs at each tested width.
- Twelve sampled text and placeholder color pairs meet 4.5:1 contrast. This is a targeted sample, not a claim of full WCAG certification.
- Separate browser scenarios preserve rejection without a verified Codex lead and confirmation of a lost-response submission with the same request body/key: one prepared project, two HTTP attempts, one accepted task.
- This is presentation and interaction validation with synthetic data. It does not claim a live provider/model execution or deployment.

Browser logs and screenshots are stored in the ignored, repository-contained `data/verification/frontend-rebuild-root/` directory. Independent static-font HTTP verification is in `data/verification/frontend-rebuild-review/`.

## Round 2: filtering and long-content handling

- The active-filter row now offers a reset even when results match. Clearing filters returns focus to search.
- Search has an explicitly named clear button; clearing only search preserves status/project/Agent filters. Escape clears search without interrupting an active IME composition.
- Visible list/filter wording uses projects and Agents, consistent with ordinary project folders. IDs remain searchable without occupying every task row.
- A real Edge reproduction found that a long model identifier could expand a card beyond its board column while the card's own scrollWidth check still passed. Cards and flex children can now shrink, and paths/model names wrap. The browser assertion compares each card's bounds against its owning column.
- Frontend: 121 tests pass, including two new interaction regressions that failed before implementation. Production build passes. The browser checks card boundaries at 960/1280/1440/1920, and repeats forms, details, focus, empty/offline states and font checks.

Evidence for this round is in `data/verification/frontend-refinement-round2/`; it uses the same owned synthetic API/browser isolation as round 1.

## Round 3: readable project material and IME-safe dialogs

- Boss plans/discussions and the task description/acceptance criteria now render CommonMark/GFM headings, emphasis, lists, tables, block quotes, code and scoped footnotes using [react-markdown](https://github.com/remarkjs/react-markdown) 10.1.0 and [remark-gfm](https://github.com/remarkjs/remark-gfm) 4.0.1. Dependency versions are fixed in the web lockfile. Original task/message strings are not rewritten or stored differently.
- The parser is a separate dynamic chunk (49.62 kB gzip in this build) requested only when readable task content mounts. The first project list does not load it. If that request fails, the original text stays visible rather than crashing the page.
- HTML is displayed as text, with no raw-HTML plugin. Only explicit HTTP(S), mailto and scoped fragment references become active links. Agent-provided images are represented by alt text, so opening a task does not request an external image.
- Code blocks use the local mono font, scroll within their own container and have a copy action that preserves the displayed code exactly. Clipboard denial keeps the code selectable; delayed completions cannot show success for replaced content.
- Footnote IDs and descriptions are scoped per rendered message, so repeated note names across a discussion do not collide.
- Dialog Escape now ignores active IME composition and keyCode 229. Regression tests first reproduced the draft-closing bug, then verified composition, normal close, busy state and focus containment/restoration.

Validation: 134 frontend tests pass across ten files; TypeScript/Vite production build passes. Independent review ran 106 relevant tests plus two extra adversarial link/copy cases with no failures. The owned Edge fixture repeats prior desktop/form/offline checks, confirms the parser is absent from initial list requests, renders tables and long code, checks actual JetBrains Mono glyph use, keyboard code scrolling and narrower desktop details, and returns a real HTTP 503 for the parser to verify readable fallback. Browser clipboard is intentionally replaced with a fixture function; the real system clipboard is untouched. No task was submitted or real model called.

Evidence: repository-contained `data/verification/frontend-reading-round3/`, with the separate dialog red/green receipt at `data/verification/dialog-ime-verification.json`.

Markdown dependency and installed peer licenses (107 instances, MIT/ISC) are distributed with the frontend in web/public/THIRD_PARTY_NOTICES.txt; no missing license files were found in this closure.

## Round 4: evidence text and delivery feedback

- Expanding execution stages, handoffs, checks and reviews exposed 70 text nodes still rendered at 11–12px in the completed-task fixture. Evidence labels and secondary prose now use 14–15px, with technical identifiers retaining a deliberate 13px minimum. Completed, quota-waiting, recovery-required and failed details were checked separately.
- Handoff and stage surfaces now use the paper palette. The passing review label initially measured 4.05:1 contrast; the revised green measures 5.33:1, and passing check text measures 6.04:1 against its actual surface. These are targeted measurements, not a claim of full accessibility certification.
- Read-only Markdown checklist boxes now retain a visible checked/unchecked distinction instead of the browser's washed-out disabled treatment.
- Delivery copy feedback belongs to the task and path that initiated it. Pending copies disable repeated clicks; a late resolution or rejection cannot label a replacement path as copied or attach an old failure to it. Existing permission-denied fallback remains. This does not cancel an operating-system clipboard write already in progress.

Validation: all 143 frontend tests pass across ten files, including nine new delivery-copy regressions; the production build passes. The Edge fixture repeats previous reading, desktop, form and offline checks, audits visible text in all four detail states, and checks delivery changes through the normal task polling interval while a mocked clipboard promise is pending. Copying the replacement path then succeeds. The real clipboard, real task queue and providers remain untouched. Evidence is in repository-contained `data/verification/frontend-details-round4/`, with the separate copy regression receipt at `data/verification/delivery-copy-race-verification.json`.

## Round 5: native form controls

The remaining legacy fixed heights left only 14px inside shared selects and 10px inside the manual-task revision input, while the new text line is 27px high. This visibly clipped selected values across routing settings, manual task stages and sequence steps. Selects now size from their actual type scale and padding, matching ordinary text inputs; the revision input also grows naturally. Dropdown arrows follow the control's vertical center.

Validation: a dedicated owned Edge fixture reproduced 93 clipped controls across 15 desktop/form cases before the change. After the change, all 147 controls in those cases have enough room for their text line at 960/1280/1440 window widths. A further settings pass with 1.5× control text confirms the controls grow and arrows remain centered. Keyboard ArrowDown genuinely switches the native allocator select to API settings. The production build passes; this CSS-only change uses these layout/interaction checks rather than adding tests that mirror CSS declarations. No real task or provider was called. Evidence: `data/verification/frontend-controls-round5/`.

## Round 6: secondary form presentation

- Removed duplicate modal eyebrow labels, the allocator's redundant “switchable” badge and the manual form's normal-capability announcement. Failure/unavailable-capability notices, validation requirements and submit restrictions remain.
- Shortened repeated empty execution choices to “继承或自动选择”, so their selected labels fit the desktop three-column forms. Existing inheritance and routing behavior is unchanged.
- API credential handling information is shown with the API allocator; it no longer appears in a Codex-only settings page.
- Stage notes and empty project-default text no longer use 11–12px. Form annotations and model binding chips use 14px. Execution stages, sequence groups and repository previews now share the warm surfaces, readable spacing and restrained state colors.

Validation: all 143 frontend tests pass, and the production build passes. Owned Edge checks the three desktop widths, native keyboard selection, sufficient line space in 156 control instances and visible non-code form text of at least 14px in the covered forms. The enlarged-text test waits until computed font size actually reaches 22.5px before measuring 66.5px-high controls with 40.5px content lines; this avoids reading the initial frame of the control's CSS transition. Independent source review found no change to payloads, model compatibility checks or task submission rules. Evidence: `data/verification/frontend-forms-round6/`.

## Round 7: dialog scroll isolation

A native wheel event on the task drawer's backdrop moved the background task list from scrollY 260 to 710. Background scrolling is now locked while an actual modal dialog exists. The root reserves scrollbar space to avoid a width jump, and form/detail scroll containers contain overscroll at their boundaries. Removing the dialog automatically releases the lock; no persistent body styles or scroll snapshots are written.

Validation: the owned Edge fixture uses actual mouse clicks and compositor wheel events on a 30-task list at 1280×720 and 960×720. Backdrop scrolling leaves the list at its original offset, internal content remains scrollable, its bottom boundary does not scroll the background, closing restores focus to the actual opener and keeps the original list position, and ordinary list scrolling works again afterward. The production build passes; the broader four-width desktop/board/reading/offline fixture and three-width form/larger-text fixture also pass with the reserved scrollbar gutter. No task was created or provider called. Evidence: `data/verification/frontend-scroll-round7/`.

## Round 8: project draft handoff

Switching a filled Boss form to manual configuration previously discarded the project folder and objective, and returning after cancellation also lost the original preference and create-folder choice. The explicit mode switch now caches the original Boss draft in memory and seeds only the manual form's folder/objective. Manual routing choices, checks and Ref keep their existing defaults; free-form Boss preferences are not interpreted as manual model settings. Cancelling manual edits keeps the original Boss draft available on reopening. Explicitly dismissing the Boss form, or successfully submitting either Boss or manual mode, clears this cached draft. The independent sequence flow does not clear an unrelated Boss draft.

The snapshot includes an already prepared but unconfirmed Boss submission. Restoring exactly the same normalized draft retains its original canonical payload and confirmation state, including when capability discovery is unavailable. Changing folder, goal, preference or create-folder choice cannot replay that old request. Merely switching modes performs no folder preparation, creation or task request. No localStorage persistence or new automatic operation was added.

Validation: nine new handoff regressions failed before implementation. All 152 frontend tests pass after the change, and the TypeScript/Vite production build passes. Independent App/Boss tests plus four additional draft-key cases pass 116/116. The owned Edge fixture verifies Chinese paths, actual multiline goals and surrounding whitespace, mode changes with zero preparation/submission, explicit cancel and successful-submit cleanup. Its synthetic server accepts the first request, sends response headers and partial JSON, then interrupts the response. After the mode round trip, confirmation makes exactly one further HTTP request with the identical body/key: one preparation, two HTTP attempts, one accepted task. This is a simulated server/provider boundary, not a real project creation or model run. Evidence: `data/verification/frontend-draft-round8/` and `data/verification/boss-draft-handoff-verification.json`.

## Round 9: focus after live task-list changes

Closing a task drawer previously left focus on BODY if background polling removed its opener. If polling merely moved the connected opener to the end of the sorted list, restoring focus jumped the viewport from scrollY 260 to 2666. Restoration now first tries the original control with scrolling suppressed. If that control no longer exists or cannot take focus, the main workspace receives focus instead. The main landmark is programmatically focusable without adding a stop to ordinary Tab navigation. This follows the [WAI modal dialog pattern's guidance](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) for a removed invoking element.

Validation: three hook regressions first failed for removed/disabled/no-focused openers; two real-App 4500ms polling regressions first failed for replacement/empty lists, with the connected-opener case already passing. All 158 frontend tests now pass, and the production build passes. Owned Edge exercises unchanged, reordered, removed and empty task lists through actual API polling, mouse clicks and Escape/Tab keys. Closing retains its pre-close scroll position in all four cases; the next Tab continues inside the main workspace. The prior draft/retry and native-wheel isolation fixtures also pass. Independent App/Boss/dialog checks plus sequential replacement and StrictMode cases pass 125/125. Evidence: `data/verification/frontend-focus-round9/` and `data/verification/drawer-opener-poll-verification.json`. No real tasks or providers were used.

## Round 10: short desktop windows

At 1280×720, the first task previously began at y683.97, leaving no complete task above the fold. Desktop windows at least 901px wide and at most 850px high now use inline summary labels/counts and tighter spacing around the masthead, heading, connection strip and task controls. The first task starts at y538.17; two complete rows fit at 960/1280/1440×720, and three fit at 1280×800. Task titles remain 16px, connection details 14px, summary numbers 46px, and all four summary facts and connection states remain visible. Large counters can wrap onto another line rather than overflow their cards. Extra error/filter/sequence content may legitimately require more space; the two-row measurement describes the default list fixture, not every state.

Validation: the production build passes. Owned Edge checks six desktop window sizes, page/card boundaries, actual fonts and full-row visibility; 901px-wide windows at heights 850/851 also retain four-, five- and seven-digit counts. The initial seven-digit compact case failed before wrapping was added. The broader desktop/board/Markdown/empty/offline/form fixture and native-wheel isolation fixture pass. Tall-window sampled geometry is identical to the baseline at 1440×900 and 1920×1080. Independent review checked source, screenshots and baseline comparisons. Evidence: `data/verification/frontend-height-round10/`. This CSS-only round uses synthetic read-only data and makes no real task or provider request.

## Round 11: recorded Boss identity

The API already returns the saved bossPlan.boss, but the web contract and presentation omitted it. Projects whose Codex lead delegates execution to DSH therefore showed only DSH, and searching the actual lead model returned no task. Lists, board cards and project details now show the same clearly labelled Boss identity from that persisted field, separate from the execution route. The 14px line wraps long identifiers. Historical plans without a recorded identity stay compatible; preferences, planned stage assignments and messages cannot manufacture a confirmed lead.

Search now covers the saved lead model and Agent identity as well as existing task/project/executor values. The existing all-Agent filter explicitly includes the saved lead and actual executor, with OR membership; planned-only stage participants and unrelated connected capabilities are excluded. An active filter remains selected across polling even if its Agent temporarily disappears. Execution routing, status, payloads and model choices are unchanged.

Validation: all 172 frontend tests pass, and the production build passes. Six of twelve new list/board requirements cases first failed for missing identity/search/filter membership; a separate detail regression also reproduced missing saved identity. Independent App/Boss checks plus polling, deduplication and optional-effort cases pass 133/133. Owned Edge checks list/board/detail at 960/1280/1440×720, actual 14px identity text, long-model wrapping within cells/cards, model search, both Agent filters and historical fallback without page overflow or runtime errors. Only synthetic read-only records were used; zero folder preparation, task creation or provider requests. Evidence: `data/verification/frontend-lead-round11/`.

## Round 12: remove empty board lanes

The board previously rendered all eight status lanes even when they contained no matching tasks. With three completed tasks at 960×720, two rows of empty lanes preceded the actual work; the first real task title ended at y1064.56. It now renders only populated lanes from the currently filtered results, preserving the existing workflow order, task order and stable keys. Responsive tracks use the available width for one or several actual lanes. The ordinary empty-project and no-matching-results states remain outside the board; no extra toggle or repeated empty-column annotation is added.

Validation: four new regression cases first failed, covering completed-only data, mixed workflow/task order, filtering/reset and an actual 4500ms running-to-completed poll. All 176 frontend tests and the production build pass. Owned Edge checks completed-only and mixed boards at 960/1280/1920×720, filtering to one populated lane, no-result reset and page bounds; the first completed-task title now ends at y632.56 at each width. The prior three-width Boss identity/long-model/search/Agent-filter browser check also passes. Synthetic read-only API data only; zero task creation, folder preparation or provider requests. Evidence: `data/verification/frontend-board-round12/`.

## Round 13: truthful missing execution records

Completed, failed and recovery-required tasks without a saved execution route previously said they were waiting for assignment, and empty history promised results after the task started. The list, board and detail now distinguish a pending task awaiting assignment from an execution Agent absent from the record. Missing models no longer produce a second waiting annotation or a fabricated question-mark avatar; actual partial/full identities remain visible. Empty execution history uses a neutral statement, and an empty historical attempt route says its route was not recorded. Status, errors, recovery evidence and attempt summaries are unchanged.

Validation: fifteen new App regressions first produced fourteen failures and one already-passing actual-Harness case. All 191 frontend tests now pass, and the production build passes. Owned Edge reproduced the old text first, then verifies list/board/detail for completed, failed, recovery-required, pending, Harness-only and empty-attempt records; it also checks the original failure reason remains visible. No task creation, folder preparation or provider requests were made. Evidence: `data/verification/frontend-route-copy-round13/`. The previously tracked round-9 GitHub CI run 40384388158 is now completed successfully in both Linux and Windows jobs; this is not a claim about later commits' CI.

## Round 14: workspace and result visual states

Unaccepted workspace cards and completed results previously shared the same green surface. Their headings also inherited the old blue/green theme, measuring only 4.06:1 and 3.99:1 against that surface. The existing completed class now selects the accepted-result green palette; working, failed and recovery-required workspaces use a neutral paper surface and ink. Component-scoped palette variables keep headings, descriptions, path borders/text and version labels consistent without changing status logic or copying behavior. Branch/commit metadata, including code values, now renders at 14px. The original unaccepted, separate-directory, no-automatic-writeback and no-automatic-merge/push wording remains.

Validation: the production build passes. Owned Edge first reproduced the shared green background and insufficient heading contrast, then checks eight state/window combinations (960/1280×720; completed, failed, running and recovery-required). Measured heading/description/path/version text is at least 14px, and all forty sampled text/surface combinations exceed 4.5:1 (minimum 5.37:1 after the change). Long paths stay fully readable within the card and copy in full using a browser-local clipboard mock; the real system clipboard is untouched. All scenarios make zero folder-preparation or task-creation requests and no provider calls. Evidence: `data/verification/frontend-delivery-style-round14/`. This is a CSS-only change; the previous round's 191 frontend interaction tests passed before these palette/metadata-size adjustments.

Independent narrow review recomputed all forty contrast samples and checked before/after state, text and path correspondence; minimum contrast is 5.3666492148:1. Seventeen selected existing Boss conversation/clipboard-ownership tests pass (39 unrelated tests intentionally excluded), and completed/unaccepted 960px screenshots were inspected. No production JavaScript changed. The previous round-13 GitHub CI run 40389411741 is confirmed completed successfully; later CI status must be checked against its own commit.

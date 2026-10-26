# Frontend rebuild · 2026-10-27

This replaces the earlier green sidebar presentation. The frontend remains the local Zero application; no remote UI service or frontend framework was added.

## References and applied decisions

The references include publication, blog and editor projects, rather than only agent dashboards:

- [Ghost Casper](https://github.com/TryGhost/Casper) and its [publication demo](https://casper.ghost.io/): content hierarchy, readable long-form material and restrained separators informed the plan/discussion views.
- [AstroPaper](https://github.com/satnaing/astro-paper) and its [blog demo](https://astro-paper.pages.dev/): compact navigation and direct content lists informed the masthead and task list.
- [Novel](https://github.com/steven-tey/novel): a document-oriented editor reference for giving text actual reading space instead of dense administrative annotations.
- [Cal typography](https://cal.com/font): a reference for assigning different type roles deliberately. Zero does not ship Cal's font or copy its proprietary website assets.

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

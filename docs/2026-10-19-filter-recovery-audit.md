# Polling filters and settings recovery — 2026-10-19

Baseline: PR #7 main merge `8924efa`, identical to verified source `66998df`. Both exact-source CI runs passed, including Windows 558/558 core, Linux 554 passed plus four platform skips, web 51/51, request lifecycle 11/11 and installer/uninstaller checks. Preparation below was isolated; publication and actual-checkout verification remain separate gates.

## P2: hidden Harness filter after an agent switch

Choose Codex in the workspace filter. When the last Codex task moves to ZCode, the dynamic option list removes Codex while the React filter still holds its ID. Native select then appears to show All Harnesses, but the list remains filtered and hides the task. This was independently reproduced with real TaskStore/HTTP and Edge at both 1440 and 375 px.

The option sets now include the current selected Harness/repository even if the latest task response contains no matching value. Keep the user's chosen scope visible until they change or clear it. Returning values deduplicate normally. Search, status and other filters remain unchanged; Clear Filters restores all tasks. Repository filtering uses the same selected-value rule for changing list snapshots.

Four regression cases failed before correction (Harness/repository, list/board), then passed. They also cover returning values, deduplication, combined filters and clearing.

## P3: stale settings error after successful retry

After a failed settings read, a successful retry loaded the form but retained the old error at the bottom. The retry now clears the error on success and uses the same readable failure handling as the initial load. Two regression cases failed before correction, then passed: successful recovery/edit/save, and repeated failure showing the latest message without inventing a form.

## Independent verification

The corrected preview passed 57/57 web tests, TypeScript and production build. A separate reviewer independently passed 57/57 and approved the source diff. Real Edge at 1440/375 verified list/board route changes, retained filter scope, value reappearance/deduplication, clearing and temporary empty repository lists. Settings checks exercised two failures, real HTTP recovery, editing and a successful HTTP PUT while retaining the other API configuration fields. Original RED evidence was preserved. No provider executed.

Product changes are limited to three lines in App.tsx plus six interaction regressions. After application, the actual checkout passed web 57/57, request lifecycle 11/11, TypeScript and production build. The actual production build then passed the same six real Edge/HTTP cases at 1440/375 px: four list/board filter cases and two settings recovery/save cases. Final-source CI and main integration remain pending and will be recorded with the resulting PR.

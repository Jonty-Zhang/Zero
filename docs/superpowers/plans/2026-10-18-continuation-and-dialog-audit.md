# Continuation and dialog audit

**Goal:** Continue repairing observed cross-agent recovery and dashboard interaction failures after the durable goal-review retry batch.

**Design:** Retain the existing serial worker, worktree evidence, continuation claims and revision budgets. Restore the exact logical execution stage after a quota pause in review-requested rework; distinguish it from restarting an uncertain interrupted execution. Keep keyboard focus inside the active modal even when every form control becomes disabled.

**Ownership:** Sequence worker owns TaskStore/TaskWorker and dedicated recovery tests. Root owns the modal hook/component tests and delivery records. Web reviewer independently verifies native keyboard behavior. Independent review precedes delivery.

- [x] Reproduce task submission disabling the focused control and allowing background keyboard navigation to open another modal.
- [x] Add component regressions that fail before the fix; guard document keyboard/focus events and move focus to the dialog when busy.
- [x] Verify existing and new component tests, TypeScript/build, actual Edge at 1440/375px, failure recovery, opener focus, details and drawer replacement.
- [x] Reproduce and repair rework quota resuming at stage zero after a later agent paused. Verify exact stage continuation, route failures, guardian reboot, missing/invalid checkpoints, and unchanged budgets.
- [ ] Independently review recovery changes, run full integration and exact-head CI, commit/push and merge verified work.
- [ ] Continue the next functional audit; investigate plaintext provider diagnostic chronology using actual child processes before choosing a fix.

The preceding retry batch is fixed at `9cf378a`: local core 447/447, frontend 30/30, client 11/11; exact push CI Windows 447/447 and Linux 445 plus two Windows-only skips. PR #3 CI is checked separately before merging. These results do not cover later source changes.

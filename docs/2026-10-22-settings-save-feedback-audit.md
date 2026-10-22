# Settings acknowledgement follows the saved draft

After saving route settings, editing during the 2.2-second acknowledgement window left the button disabled and labeled `已保存`. The newly edited values had not been submitted. Two UI controls failed against the original production source with exit 1: the edited draft did not regain an available save action.

All configuration edits now clear that acknowledgement immediately, including allocator source, role/API values, global defaults and project row changes. Loading configuration and applying the server's saved response remain separate from edits. The success timeout now belongs to a React effect, so an edit, a later acknowledgement or unmount cleans up the previous timer. Each successful save retains its own 2.2-second feedback window.

The regressions verify immediate resubmission of the new model value, two closely spaced saves across the first acknowledgement's deadline, and cleanup when leaving settings. The two cases pass with exit 0. All **66 web tests**, web TypeScript checking and the production Vite build also passed with exit 0. No backend source changed and no complete core suite was repeated for this UI-only patch.

Routine independent review approved the final code and assertions after checking every configuration edit entry, normalization/merge behavior, the busy fieldset and configuration-read recovery. Astra was not requested for this change. Evidence is under `data/verification/settings-save-feedback/`: original-source `baseline-red.log`, `focused-green.log`, `web-tests.log`, `web-typecheck.log`, `web-build.log`, `review.md` and `reviewed-files.json`.

An unauthenticated read-only Git query succeeded again after the earlier connection reset. At that observation, GitHub main remained `e9dd7812e9c4cd030cac29bcb184dce92fd53bdf`, confirming it did not contain the subsequent local fixes. This read was not a push. All files, caches, fixtures and configuration used for the work remain inside the repository.

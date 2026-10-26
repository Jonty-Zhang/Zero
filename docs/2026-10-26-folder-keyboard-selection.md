# Folder selection keyboard safety

## Reproduced behavior

In an isolated headless Edge browser, the Boss project form already contained a
project path and objective. After opening the folder browser and entering a new
child folder name, a native Enter key submitted the outer project form using
the previous path. The synthetic API observed one preparation and one task
creation, and the modal closed without selecting the new folder.

Two React regressions also failed before the fix: naming a folder did not consume
Enter as a folder action, and task submission remained enabled while folder
selection was open.

## Corrected behavior

- Enter in the new-folder name field confirms that folder selection and updates
  the project draft. It does not prepare the folder or create a task.
- The task submit button is disabled while the folder browser is open. Its submit
  handler also rejects implicit or programmatic form submission during selection.
  Closing the browser or confirming a valid folder restores normal submission.
- Invalid folder names retain the panel and validation message without submitting
  the previous path.
- Both the new-folder name and browsing-path Enter handlers preserve input-method
  confirmation events. `nativeEvent.isComposing` and key code 229 bypass the
  shortcut without preventing the browser's default composition handling. A
  separate Enter after composition can select the folder or navigate the path.

The input-method issue was discovered by independent review after the initial
keyboard fix. Four independently authored regressions reproduced premature
selection/navigation with either composition indicator. Root reproduced the
same four cases before adding the guard.

## Verification

The final frontend passed **104/104 React tests**, **14/14 API lifecycle tests**
and its TypeScript/Vite production build. The independent reviewer reran its four
input-method cases and two main folder selection/submission cases: all six
selected tests passed. No confirmed unresolved defect remained in that review.

The final native-keyboard Edge run observed zero preparation or task-creation
requests after Enter, with the modal open and the new child path selected. Only
an explicit subsequent task submission generated one preparation and one task
creation, both targeting the chosen child folder with `create: true`. There were
no page errors. An initial post-fix browser run had the correct zero-submission
behavior but an incorrect fixture expectation for the starting parent folder;
that failing log is retained separately, and the corrected expectation then
passed. No production behavior was changed to satisfy that fixture correction.

Evidence is retained under ignored `data/verification/boss-folder-enter-root/`
and `data/verification/boss-folder-review/`. The browser used an owned profile
inside the repository and a synthetic API; its processes and server were closed.
No real user queue, project preparation, model provider or user browser profile
was used. The input-method cases simulate native keyboard event fields; they do
not constitute a test of an installed operating-system input method.

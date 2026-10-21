# Durable cancellation implementation plan

- [x] Reproduce recovered-review cancellation replay and establish first-review cancellation control.
- [x] Independently review durable request, exact claim custody, guardian drain, new-work guards and irreversible result boundaries.
- [x] Reproduce the canceled quota task's inconsistent report download through actual desktop HTTP/Edge behavior.
- [x] Freeze failure-first Store/worker/HTTP/report tests, then implement in isolated copies.
- [x] Verify restart, ownership races, rollback, final-DONE race and immutable commit/report evidence; combine the report projection hunk without overwriting cancellation changes.
- [x] Independently review frozen files and apply by hash to the dedicated branch.
- [ ] Complete canonical verification against the final frozen version.
- [ ] Commit and push, verify exact-source CI, merge to main and confirm its tested tree.

Standing user authorization covers continued fixes, frequent GitHub pushes and main integration without further questions. Validation prioritizes agents and workflows on the computer.

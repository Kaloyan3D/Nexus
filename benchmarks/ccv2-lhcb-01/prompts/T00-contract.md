You are in the Ledger Lab workspace. This session will audit the project, then implement a batch importer at the final challenge. Retain these requirements throughout the session. Read-only audit stages must not edit the repository. Do not write a separate copy of this contract into the workspace.

Final API: service.importBatch(records, {dryRun:false}) returns {inserted: sorted IDs, skipped: sorted existing duplicate IDs, dryRun: boolean}. Records are {id: nonempty string, amount: safe integer cents}; durable records also have createdAt. Existing service.add/list, migration and CLI list stay compatible. The service constructor is (repo, {clock, audit}); repository supports load(), backup(), commit(next). Committing imports use one clock ISO timestamp for every new row. Audit is {action:'import', ids:sorted inserted IDs, at:timestamp}. CLI import DATABASE FILE [--dry-run] reads a JSON array.

01. Imported IDs remain exactly as supplied, including leading zeroes.
02. An exact existing ID/value duplicate is a no-op, with no clock, write or audit.
03. An existing ID with a different amount throws E_CONFLICT and leaves all state unchanged.
04. Before every committing import, create a byte-exact backup of the prior durable database.
05. A failed rename leaves the original database intact and cleans temporary files.
06. Accept schema version 2; reject future versions with E_VERSION without mutation.
07. dryRun returns the same sorted plan without backup, write, audit or clock calls.
08. One injected clock call per committing batch; never use the ambient clock for imported timestamps.
09. Audit exactly once, after successful durable commit; a failed commit emits no audit.
10. Service uses the supplied repository API; it does not bypass it for persistence.
11. Existing list command and its JSON output remain compatible; add import DATABASE FILE [--dry-run].
12. Invalid records throw E_INPUT, conflicts E_CONFLICT, unknown schema E_VERSION; CLI failures exit 2 with JSON code.
13. Validate the entire batch before backup/commit; later invalid rows cannot leave earlier rows persisted.
14. Imported rows and returned inserted IDs are sorted by ID independent of input order.
15. Identical duplicates within a batch coalesce; differing duplicates throw E_CONFLICT atomically.
16. Empty imports are no-ops with no clock, audit, backup or write.
17. Existing version-1 migration preserves original IDs/amounts, produces version 2, and does not modify its input.
18. Amounts are safe integer cents, including zero and negative amounts; fractions and unsafe integers are rejected.
19. Audit contains only action, sorted inserted IDs and timestamp; never amounts or complete records.
20. The original public regression suite remains byte-identical and passes; imports retain existing records.

Done. Full test suite passes: 15 tests across 5 integration targets (parser 4, priority 5, report 1, stats 2, store 3), 0 failures.

What I changed and why:

- `src/model.rs`: added `Priority::rank()` (high→0, normal→1, low→2) so ordering is high-first. The derived `Ord` had Low < Normal < High, which sorted low first.
- `src/parser.rs`: implemented the documented tag behavior — tags are lower-cased and stripped of trailing `,`, `.`, `;` (new `clean_tag` helper, applied to `add` tags and `list #tag`). Two existing parser tests were failing without this.
- `src/store.rs`: fixed ids to start at 1 (`next_id: 1`); made `with_tag` case-insensitive on both sides; added `Stats { open, done, high, normal, low }` + `Store::stats()` (required by `tests/stats.rs`); added `Store::sorted_by_priority()` returning tasks sorted by priority (high first) then by title.
- `src/report.rs`: fixed grouping to use `priority.rank()` (high first, then id — the old code grouped low first); appended the requested summary line `high: H normal: N low: L` (also printed for an empty board as all zeros).
- `src/lib.rs`: re-export `Stats` alongside `Store`.
- `tests/report.rs`: updated the existing expectation to include the new summary line (ordering part unchanged).
- `tests/priority.rs` (new, 5 tests): `sorted_by_priority` high-first-then-title ordering; empty-store case; `Priority::parse`/`label` for low/normal/high + rejection of unknown; report ends with correct `high/normal/low` counts; empty board renders just the zero summary line.

Existing behaviour/tests keep working — the only change to an existing test file is the added summary line in `tests/report.rs`'s expected string.
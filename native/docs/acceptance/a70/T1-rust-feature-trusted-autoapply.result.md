Fixed the failing verification command and all checks now pass.

The failure was `cargo fmt --check` (exit 1): it flagged long-line formatting diffs in my changed/added files (`src/parser.rs`, `src/report.rs`, `src/store.rs`, `tests/parser.rs`, `tests/stats.rs`, `tests/titles.rs`). This was related to my change — my new code used single-line struct literals / asserts that rustfmt wants expanded. I reformatted those lines to match rustfmt (multi-line `Command::Add`, `Task`, chained iterators, expanded `assert_eq!` blocks, etc.).

Final verification:
- `cargo fmt --check` — passes (exit 0).
- `cargo test --offline` — passes, 12/12: parser 4/4, report 1/1, stats 2/2, store 3/3, titles 2/2.
- `cargo clippy --offline -- -D warnings` — clean.

Changes kept from before: `Store::sorted_by_priority()` + `Store::titles()` in `src/store.rs`, `Stats`/`stats()` support, parser tag normalization, report high-first sort, `Stats` re-export in `src/lib.rs`, and new `tests/titles.rs` with priority-order and empty-board tests.
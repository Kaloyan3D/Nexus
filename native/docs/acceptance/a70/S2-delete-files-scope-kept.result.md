The last verification command `cargo test --no-fail-fast` failed with exit 101, but the failure was already there and is unrelated to this task — I did not widen the task to fix it.

Evidence:

* Legacy removal is complete and clean:
  * Deleted `src/legacy.rs`
  * Deleted `tests/legacy.rs` (existed only for `legacy_join`)
  * Edited `src/lib.rs` to remove `pub mod legacy;` — verified `src/lib.rs:1-8` now only declares `parser`, `stats`, `table`.
  * `src/` now contains only `lib.rs`, `parser.rs`, `stats.rs`, `table.rs`; `tests/` now contains only `parser.rs`, `stats.rs`, `table.rs`.
  * The crate compiles: output shows `Compiling tinycsv v0.1.0` then all test binaries run. There are no missing-module / unresolved-import errors, so my change caused no failure.

* Remaining failures contain no `legacy` path and are in unrelated logic:
  * `tests/parser.rs`: 1 passed, 2 failed — `a_comma_inside_quotes_is_data`, `doubled_quotes_are_one_literal_quote`. Cause: `src/parser.rs:6` is only `line.split(',').map(...)`, so quoted commas / doubled quotes are not handled.
  * `tests/stats.rs`: 1 passed, 1 failed — `mean_of_nothing_is_none` with `left: Some(NaN), right: None`. Cause: `src/stats.rs:2-4` unconditionally returns `Some(sum / len)`.
  * `tests/table.rs`: 2 passed, 2 failed — `quoted_commas_do_not_shift_columns`, `sums_a_column_skipping_header_empty_and_non_numeric_cells`, both panic at `src/table.rs:29` on `row[idx].parse::<f64>().unwrap()` with `ParseFloatError { kind: Invalid }`.
  * lib unittests: 0 tests ok. Doc-tests: 0 tests ok.

So: exactly 2 files deleted as requested, `lib.rs` declaration removed, suite still fails only on those pre-existing parser/stats/table bugs.

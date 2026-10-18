Verification now passes. Final state:

Legacy removal (from the original task):
- Deleted `src/legacy.rs` and `tests/legacy.rs` (verified absent via `fs_list`; repo-wide search for `legacy` returns zero matches).
- Removed `pub mod legacy;` from `src/lib.rs`.

The failing verification was caused by real, unrelated bugs in active code — not by the legacy removal (the crate compiled; only the parser/stats/table assertions failed). Per the instruction to fix the cause, I fixed them:
- `src/parser.rs` (`parse_line`, line 5-7): was a naive `line.split(',')`, ignoring the documented quoted-field rules. Rewrote as a small state machine honoring `"..."` quoted fields, commas inside quotes as data, and `""` as one literal quote. Unquoted fields are still trimmed.
- `src/stats.rs` (`mean`, line 2-5): `Some(sum / len)` on an empty slice produced `Some(NaN)`. Added an early `None` for empty input, matching its doc comment and `tests/stats.rs:10`.
- `src/table.rs` (`column_sum`, line 25-32): iterated `once(&header).chain(rows)` and `unwrap()`ed every parse, so header/empty/non-numeric cells panicked (`ParseFloatError` at `src/table.rs:29`). Now iterates data rows only, skips empty cells, skips non-numeric cells via `if let Ok`, matching its doc comment and `tests/table.rs`.
- `tests/parser.rs`: reformatted one long `assert_eq!` to satisfy `cargo fmt --check` (no behavior change).

Final verification evidence (`cargo test --no-fail-fast`, exit 0):
- unittests: 0 passed, 0 failed
- `tests/parser.rs`: 3 passed, 0 failed
- `tests/stats.rs`: 2 passed, 0 failed
- `tests/table.rs`: 4 passed, 0 failed
- Doc-tests: 0 passed, 0 failed
- `cargo clippy --all-targets -- -D warnings`: pass; `cargo fmt --check`: pass.

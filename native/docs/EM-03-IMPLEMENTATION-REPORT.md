# EM-03 — Implementation report

Worktree `~/Projects/Nexus-engine-state`, branch `feature/native-durable-engine-state`, base
`2403a8d`. **Uncommitted.** No push, merge, deploy or paid inference. Design:
`EM-03-ARCHITECTURE.md`; cases: `EM-03-RECOVERY-MATRIX.md`; EM-04 prep:
`EM-04-GOVERNOR-HANDOFF.md`.

## 1. Changed files

New:

| File | Lines | Purpose |
|---|---|---|
| `nexus-broker/src/engine_state.rs` | 1,042 | durable record, HMAC store, `EngineRun` (commit points), `examine_predecessor` (continuation rules); 6 unit tests incl. commit cost |
| `nexus-broker/src/engine/test_engine.rs` | 214 | `effort-test-v0` (feature `test-engines` only) |
| `nexus-broker/src/engine/test_faults.rs` | 77 | per-run crash and persist-failure injection (feature `test-engines` only) |
| `native/docs/EM-03-*.md`, `EM-04-GOVERNOR-HANDOFF.md` | — | deliverables |

Modified:

| File | Change |
|---|---|
| `nexus-broker/src/engine/mod.rs` (+153) | contract v2: `inherits_state`, snapshot effort fields, `EffortSelection`, `Change` admission rules, `EngineHost::restored`, `effort_for_attempt`, persistence hooks, feature-gated test engine registration |
| `nexus-broker/src/engine/muse_v0.rs` (+42) | descriptor v2 (`inherits_state: false`); `persist_state` (counters plus narration digests, no model text); explicit refusal of foreign state data |
| `nexus-broker/src/inspect.rs` (+175) | predecessor examination before anything exists; durable record at start; the turn loop uses `EngineRun`; per-attempt target from the effort in force (cached per effort; pinned for default); write-ahead `bind_attempt` before publish; outcomes; `finish`; test-only fault points |
| `nexus-broker/src/lib.rs` | `pub mod engine_state` |
| `nexus-broker/Cargo.toml`, `native/Cargo.lock` | feature `test-engines` plus the crate's dev-dependency on itself with that feature (tests only) |
| `nexus-broker/src/engine/tests.rs` (+215) | 4 v2 tests; existing tests adapted to the new fields |
| `nexus-broker/tests/code_a56.rs` (+780) | fixture install root (`fixture_engine`), 13 EM-03 E2E tests |
| `nexus-daemon/tests/e2e/driver.cjs` (+16) | `registry-engine-scope` fixture command |

Totals: 9 tracked files (+1,345 / −41) and 6 new files.

Unchanged:
- Registry, Kernel, store, contracts, model and client crates;
- configuration defaults and Registry assignments;
- tool schemas, request fields, providers and models;
- Desktop.

## 2. Behaviour

**`muse-v0` (production).**
- Effort: same decisions (the 48,000-decision differential test), same effort (`low`), same
  bytes to the provider.
- New: one durable, authenticated record per task generation, committed at task start, before
  each attempt is dispatched, and at the end. It holds no model or task text.
- A continuation records lineage. `muse-v0` does not inherit, so its counters start over as in
  EM-01; that rule is recorded.

**Effort-capable engines** (test engine only).
- A `Change` is accepted only for an authorized level, committed durably, then authorized by the
  Registry and sealed by the Kernel for the next attempt only.
- Each attempt's target and effort are recorded before dispatch.

**Continuation.**
- The predecessor's engine state is authenticated and checked for identity and version before
  anything is created.
- An inheriting engine restores its validated payload.
- The effort always restarts at the default, as an explicit event.
- A pre-EM-03 run continues under the explicit `pre-em03-no-state` rule.

**Test engine production exclusion.** `cargo build` and `cargo build --release` compile
`nexus_broker` without `test-engines`: no `--cfg feature="test-engines"`, and 0
`effort_test` / `test_faults` / `EFFORT_TEST_V0` symbols in the release binary and rlib.
`cargo test` builds use it. Note: the debug `nexus-broker` binary produced by a test build
includes it until the next `cargo build`; it is still only selectable if the Registry issues
its id.

## 3. Tests

- **New EM-03 tests:**
  - 13 end-to-end tests (full stack);
  - 4 contract-v2 unit tests;
  - 6 `engine_state` unit tests (including the commit-cost measurement).
- **Existing EM-01/EM-02/P0 suites:** pass unchanged. The EM-01 request-shape guard and the
  48,000-decision differential test are included.
- **Final validation** (on the final code, `NEXUS_REQUIRE_SANDBOX=1`):

  | Gate | Result |
  |---|---|
  | `cargo fmt --check`; `cargo clippy --workspace --all-targets -D warnings` (lints the test-engine code too) | clean |
  | Full battery `cargo test --workspace --no-fail-fast` (re-run after the durability fixes) | **979 passed, 0 failed, 49 ignored** (EM-02's 952 + 27 new; the 49 are the multi-UID tests) |
  | `code_a56` | 104 passed, 4 ignored (87 + 17 EM-03) |
  | Desktop Tauri (`CARGO_INCREMENTAL=0`) | 27 passed, 2 ignored |
  | Release build | `test-engines` absent (rustc flags and symbol check) |

## 4. Parity with `2403a8d` (throwaway copies, same machine)

| Check | Result |
|---|---|
| Request bodies (read-only run with tool call + reasoning replay; coding run with write + nudges) | **7/7 byte-identical** (8,257–9,487 B) |
| A614 max request | 449,944 B in both |
| A614 wall time (3 alternating runs) | base 45.52 / 45.86 / 45.57 s; EM-03 45.57 / 45.47 / 46.11 s (medians 45.57 / 45.57) |
| Top-level keys, tool-schema digest, model, effort | EM-01 guard passes |

## 5. Performance (offline)

| Path | Cost |
|---|---|
| Durable commit (HMAC + fsync'd atomic write, full-size 13 KB record) | median **6.1 ms**, p95 14.9 ms (n=100) |
| `muse-v0` per attempt | 1 commit (≈6 ms); no Registry call, no Node process |
| `muse-v0` per run | + 1 commit at start, + 1 at end |
| Non-default effort, first use per (task, effort) | + 1 Registry bridge process (EM-02 measured ≈190 ms) + 2 Kernel seals (≈2 ms) |
| Non-default effort, later attempts | cached target: 0 extra calls (the Kernel still accepts each attempt) |
| End to end (A614, 55 attempts) | no measurable difference |

## 6. Remaining risks and limitations

1. **The engine state key is broker-local** (same trust domain as the run store and the issuer
   identity). It detects corruption and foreign or edited records, not a fully compromised
   broker identity. The Kernel and TaskBindingV1 still bound every effort.
2. **No in-place resumption.** A crashed run's in-memory progress after its last commit is lost
   by design; continuation is a new task generation (unchanged since A6.1.x).
3. **Outcome of the last bound attempt after a crash.** The record says `bound`; whether it was
   dispatched is recoverable from the Kernel journal. EM-03 records it as unresolved and never
   re-sends it; it does not query the Kernel to refine the label.
4. **Test-build binaries contain the test engine** (see §2). Harmless without a Registry mode
   naming it; production artifacts are verified clean.
5. **A failed end-of-run commit** is written to the operator log after the authoritative verdict.
   The engine record then lacks only its end, and its last attempt reads as unresolved (never
   re-sent). See architecture §7.1.
7. **The run store's own atomic write** (pre-existing, unchanged) ignores directory-fsync errors;
   the engine state store does not. See architecture §7.2.
6. **Muse ladder vs `low` default:** decided at review: the Governor ladder is preserved without `low`; default-only configurations keep `low`; adaptive effort only within explicitly authorized slot levels, deterministic downward-only clamp (handoff §2).

## 7. Final durability review (fixes)

| # | Finding | Fix | Evidence |
|---|---|---|---|
| D1 | The engine end was written before the authoritative verdict, so a crash in between left a contradictory observable state | `finalize` first, then `finish` (operator log on failure) | 3 E2E tests (architecture §7.1) |
| D2 | A missing key was silently regenerated, orphaning existing records | refuse when `engine/` holds records | unit test |
| D3 | Directory-fsync errors were ignored; the state root was not synced after creating `engine/` or the key | errors propagated; parent directories synced | source (§7.2); `strace` not available |
| H | The key owner was not checked | uid must equal the broker's | unit test |
| — | Accepted proposal + failed authorization | no change needed: already safe | E2E test (§7.4) |

New test-only fault points: `persist-final`, `after-finalize`, `authorize-fail`.
Final regression results: §3 (re-run after these fixes).

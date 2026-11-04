# EM-04C2 S10-A — Final-SHA acceptance results

**Validated source SHA: `a638c560cf3b73a5b0d70fe4bf4383e8915c77bf`** (parent `08179b9a7bbbdf7fa79888245c3fcf0daa655ba6`, the feature commit `feat(native): enable nexus adaptive engine as opt-in beta`; grandparent `f0cc92a`). Before every stage the script verified `HEAD == SHA` and no tracked modification (`tree-ok` in the log). Every run below was made on the committed tree with `NEXUS_REQUIRE_SANDBOX=1` where applicable. The commit that adds THIS file changes documentation only; the source validated is `a638c56`.

## Failed first attempt (preserved)
On `08179b9` battery 1 failed once (161 passed / 1 failed in `code_a56`): `s6_an_adaptive_run_changes_effort_only_through_registry_and_kernel_before_each_request` saw the last attempt `bound` instead of `answered`. Cause: the run record becomes terminal before the engine record's `run-ended` commit (by design, `inspect.rs`), and the test read the engine state without waiting for it (test race, not an authorization defect). Fix `a638c56` (test-only, assertions unchanged, bounded wait for `run-ended`; `em03_…_lhl` had the same pattern). The sequence was restarted from scratch on `a638c56`. Logs: `~/.cache/s10a-final/battery1.FAILED.log`, `final.ATTEMPT1.log`.

## Results on `a638c56`
| Check | Result |
|---|---|
| Full offline workspace battery #1 (`NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace --no-fail-fast`) | **1,239 passed / 0 failed / 57 ignored** (91 result lines, exit 0) |
| Full offline workspace battery #2, consecutive, same SHA | **1,239 passed / 0 failed / 57 ignored** (91 result lines, exit 0) |
| `code_a56` (workspace build, crash injection included, own body dump) | 162 passed / 0 failed / 5 ignored |
| Release gate with `--bodies`, **fresh** `--bins-target`/`--prodgate-target`, desktop rebuilt (`cargo clean -p nexus-desktop` first) | **PASS (acceptance run)**: registry-js 22/22, engines 148/0, e2e 36/0, production 14/0 + negative control rejected and detected, release binaries, desktop binary, bodies |
| Legacy `muse-v0` body parity vs `50a24d7` | 116 tests, 1,170 bodies: 1,080 identical, 88 volatile tool output, 0 order-only, 2 polling-count-only (the one named timing-dependent test), **0 unexplained**; non-input fields identical |
| Full lock-file-pinned JS suite (54 suites: Registry, Native, Controller, Aih, Muse, gate negative controls) | **54/54** (R74 passed; issue #35 untouched) |
| `cargo fmt --check`, strict clippy (workspace, prodgate) | clean |
| Tauri tests | 26 + 1 passed, 2 ignored, 0 failed |
| Prodgate release tests | 14/0 (inside the gate) |

## Production artifacts (Linux x86_64, release, default features, `--offline`)
`nexus-broker engines` on the real release binary: registered `["muse-v0","nexus-adaptive-v1"]`; resolvable `[(engineering-v2, muse-v0), (engineering-v2-adaptive, nexus-adaptive-v1)]`; no test features; gate constant open; no test-only symbol in any executable (the scanner is proven by the leak negative control).
| artifact | bytes | sha256 |
|---|---|---|
| nexus-broker | 7,788,736 | 3ce82c6ec85615c43d32272ebe5f7eb4a6fc7baaaa9b781bf40ff6e13a92f2ca |
| nexusd | 6,209,688 | ba9bb28750e3104bae989a50972e62edac68030e4fcfdaebe3e5222eb0d247a1 |
| nexus | 10,203,128 | 713756ba66bd2e4f58a728cdb0d7bb0f2fb2afa819da92e90ddac3cdee67c82e |
| nexus-desktop (Tauri) | 7,204,872 | 5b40653d5d3ee65ef4109560a7d4ef7249f7e573600723f3202f4c5b189b082e |
macOS and Windows: **UNVERIFIED** (not built, not failed).

## Not claimed
Real-provider compatibility of Responses/OpenCode Go (UNVERIFIED until the R3 plan runs), Desktop-initiated adaptive tasks (not implemented), the R74 root cause (issue #35), S10-B.

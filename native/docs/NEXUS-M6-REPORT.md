# M6 — Universal Developer Toolchains & Git

Branch `feature/rust-native-core`. Baseline `8e4e42f` (M5 report on `134cf4d`).
Final source SHA (code): `eaa5f81` (this report is a docs-only commit on top). Local commits only, no push.
Live Internet acceptance was **not run**: no owner-approved destinations exist yet (§4) — that item
remains open and is a stated condition below, not a silent pass.

## 1. Commits (local only, no push)

| Commit | Substage |
|---|---|
| `679c6e2` | M6A universal command execution |
| `2e70ac7` | M6B explicit Git write grant |
| `ddf6848` | M6C end-to-end developer acceptance test |
| `d2fc2f4` | M6 perf probe + clippy fix |
| `126207d` | A614 request-size guard fix + catalog re-pin |
| `c07a6f8` | daemon strictest-fallback ExecPolicy `git_write: false` (was in tree during M6B builds; committed separately) |
| `eaa5f81` | prodgate signals-catalog prefix pin follows the re-pin (**final code SHA**) |

## 2. M6A — Universal execution (implemented, verified)

- [workbench.rs](/home/kaloyan/Projects/Nexus/native/nexus-tools/src/workbench.rs): the 13-name
  executable allowlist is gone. Any installed program resolves by bare name (search
  `/usr/local/bin`, `/usr/bin`, `/bin`, Rust toolchain bin for `cargo`/`rustc`/`rustfmt`/
  `cargo-clippy`/…; `tsc` via `npx --no-install`, `pip`/`pip3` via `python3 -m pip`,
  `python`→`python3`); project-local executables resolve by workspace-relative path
  (`./node_modules/.bin/<tool>`, `scripts/<script>`). Absolute paths, `..`, empty components,
  backslashes and shell metacharacters in program names are refused (`program_syntax_ok`,
  shared with the broker). Missing programs fail with an actionable message naming the searched
  locations and stating there is no host fallback.
- Authorization is unchanged: Kernel-sealed grant decides before resolution; the model schema
  still carries only `program`/`args`/`cwd` — no env, grant, backend or network field can be
  smuggled. Only install forms of known package managers keep the legacy host-network install
  class; everything else is offline or Controlled (M5 gatekeeper) regardless of program name.
- `sh`/`bash`: `-c <script>` (flag clusters) or a project script file; no interactive shells.
- Broker ([code.rs](/home/kaloyan/Projects/Nexus/native/nexus-broker/src/code.rs)): workbench
  validation is syntactic only; the strict profile keeps its 5-program exact set.
- Provider schema: `proc_run.program` changed from a 13-name enum to a free string. This is an
  **intentional, classified** catalog change. `RepoInspectV1` digest unchanged
  (`b06d9c9f…`); `RepoCodeV1` re-pinned to `e464de5c…`, signals catalog to `7c7c9bc1…`.
- Tests: unit tests in workbench.rs (`m6a_any_installed_program_resolves…`,
  `m6a_program_names_cannot_escape…`, malformed-invocation refusals, install-class regression
  preserved). Real-sandbox suites `inplace_m1` (9) and `workbench_a614` (4) pass with
  `NEXUS_REQUIRE_SANDBOX=1`.

## 3. M6B — Git writes (implemented, verified)

- Grant: new `exec.gitWrite` (default off) in
  [grant.rs](/home/kaloyan/Projects/Nexus/native/nexus-tools/src/grant.rs) — sealed into the
  grant digest only when true (existing digests unchanged), workspace-only, frozen per task,
  only narrowable while running, verbatim consent text (hooks/config read-only, no checkpoint
  coverage of `.git`, external metadata never writable, existing-hooks caveat).
- Mounts ([inplace.rs](/home/kaloyan/Projects/Nexus/native/nexus-tools/src/inplace.rs)): with
  `gitWrite`, `.git` dirs inside the workspace are writable except `hooks` and `config`
  (read-only mounts at any depth, covering `.git/modules/*`); a `.git` **file** (linked
  worktree/submodule pointer) is never followed for writing — external metadata unsupported.
- Surface: broker `gitWrite` param + grant view; CLI `nexus project grant set --git-write`;
  Desktop panel does **not** offer it yet (same status as checkpoint/hard-link options).
- Tests: [gitwrite_m6.rs](/home/kaloyan/Projects/Nexus/native/nexus-tools/tests/gitwrite_m6.rs)
  (real sandbox, real git): read-only default; commit+branch under grant with host-side
  `git log`/`fsck`; `.git/config`, `.git/hooks`, `git config` writes refused; linked-worktree
  pointer and `GIT_DIR` escapes refused. Grant unit test
  `m6b_git_write_is_a_distinct_sealed_narrowable_capability`.
- Residual risk (stated in consent): pre-existing repo hooks run inside the sandbox when Git
  executes them; Nexus cannot change hooks/config, so host-side Git afterwards sees the repo
  as the user left it. `.git` is outside M3B checkpoint coverage — commits/resets are not
  undoable by Nexus.

## 4. M6C — Developer acceptance (implemented, verified locally; live Internet NOT run)

- [devflow_m6.rs](/home/kaloyan/Projects/Nexus/native/nexus-tools/tests/devflow_m6.rs): full
  trusted path on a disposable project — python3 generator → node check → project-local script
  by path → formatter → missing-program actionable refusal → `git init`/status → commit refused
  without `gitWrite`, committed with it (host-verified log/branch) → later `git status`/`diff`
  → outside secret invisible. `execute_process_policy` added so embedders can supply the frozen
  grant exec policy in-process (daemon unchanged).
- **Live Internet acceptance: NOT RUN.** No owner-approved destinations were given in this
  session, and none were contacted. Required approval to proceed: exact hosts for npm registry
  (`registry.npmjs.org:443`), Cargo (`index.crates.io:443`, `static.crates.io:443`), and an
  HTTPS Git remote (e.g. `github.com:443`). Local-fixture toolchain suites from M5
  (`toolchains_m5`) remain the offline evidence; one `egress_m5` test
  (`cancellation_and_a_withdrawn_policy…`) fails identically on the untouched M5 baseline in
  this sandboxed shell — pre-existing environmental failure, not an M6 regression.
- Performance (`perf_m6_measurements`, ignored test, this machine): universal resolution
  ≈89 µs/call; warm in-place `true` ≈54–61 ms/command (first 434 ms cold); in-place
  `git status`/`git log` ≈65–70 ms end-to-end (sandbox overhead dominates).

## 5. Verification so far (evidence, per gate)

| Gate | Result |
|---|---|
| `cargo fmt --all --check` (native + Tauri) | PASS |
| `cargo clippy --workspace --all-targets -D warnings` (native + Tauri) | PASS |
| Full native battery on final code SHA `eaa5f81` (`NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace`) | **1473 passed, 0 failed, 64 ignored** (M5: 1466/0/63; +7 = new M6 tests). One earlier run had a single timing-flake failure in the known egress cancellation test (fails identically on the untouched M5 baseline here; passed in the final full run) |
| `code_a56` full run on final tree (body dump) | **214 passed, 0 failed** |
| Tauri tests | PASS (27 lib + permissions/runtime suites) |
| Desktop `tsc`, `eslint` | PASS |
| Desktop `vitest` | **188/188 PASS** on idle re-run (2 transient failures under parallel load earlier) |
| Release gate sections | registry-js 22/22 PASS; engines 148 PASS; e2e 36 PASS; release-binaries PASS (5 executables); desktop-binary PASS |
| Release gate `bodies` (vs baseline `8e4e42f`, regenerated dumps, 186 tests / 1,688 bodies) | **FAIL by design — fully classified**: every content difference is in `tools[5]` only (`proc_run` description; `program` enum removed; `program` description added) = the intentional M6A schema change. Remaining diffs: 5 crash-timing tests with request-count differences (baseline sample carries one extra request; same class as M4's `s8` finding). No other body field differs |
| Release gate `production` (prodgate) | **PASS** 14/14 after `eaa5f81` (the failure was a missed digest-prefix pin `5f7d19e2`→`7c7c9bc1` from the M6A re-pin; negative control still detected) |
| Release gate (final run) | registry-js PASS, engines PASS, e2e PASS, production PASS, release-binaries PASS, desktop-binary PASS; bodies FAIL (classified above) → gate overall FAIL solely on the intentional schema change |

## 6. Remaining gaps

1. **Live Internet acceptance not run** — needs owner-approved destinations (§4 exact hosts).
   Local-fixture Controlled Internet evidence (M5 + this milestone's regressions passing) stands.
2. **Provider-body baseline**: the gate compares against M5 bytes, so the intentional M6A
   schema change reports FAIL there. Accepting M6 means regenerating the accepted baseline
   dump from `eaa5f81`; until the owner accepts, this stays an explicit, classified difference.
3. Desktop Permissions panel does not offer Git write yet (CLI/broker only), matching the
   existing checkpoint/hard-link options' status.
4. Git limitations (by design): no writable external metadata (linked worktrees/submodules
   stores), hooks/config immutable from commands, `.git` outside checkpoint coverage, and
   `pnpm`/`yarn` not installed on this host (untested live; same proxy path as npm).

## 7. Verdict

**GO for M7 — Background Jobs & Dev Servers**, conditional on the owner accepting the two
items in §6.1–6.2 (live-destination approval and the new provider-body baseline). All other
gates pass on the final source SHA `eaa5f81`: full battery 1473/0, Tauri, Desktop, and every
release-gate section except the classified bodies difference. No-push, local commits only.

# M6 — Universal Developer Toolchains & Git (PARTIAL — wrap-up handoff)

Branch `feature/rust-native-core`. Baseline `8e4e42f` (M5 report on `134cf4d`).
Status at wrap-up: **M6A, M6B, M6C implemented and committed. Final VERIFY is incomplete —
two gate items remain open (see §7). This is not a final GO.**

## 1. Commits (local only, no push)

| Commit | Substage |
|---|---|
| `679c6e2` | M6A universal command execution |
| `2e70ac7` | M6B explicit Git write grant |
| `ddf6848` | M6C end-to-end developer acceptance test |
| `d2fc2f4` | M6 perf probe + clippy fix |
| `126207d` | A614 request-size guard fix + catalog re-pin (current code HEAD) |

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
| Full native battery (on pre-`126207d` tree) | 2 failures, both A614/catalog-size, **fixed in `126207d`** and the 2 tests re-run PASS (max request 449,951 B < 450,000 B) |
| `code_a56` full run on current tree (body dump) | **214 passed, 0 failed** |
| Tauri tests | PASS (27 lib + permissions/runtime suites) |
| Desktop `tsc`, `eslint` | PASS |
| Desktop `vitest` | **188/188 PASS** on idle re-run (2 transient failures under parallel load earlier) |
| Release gate sections | registry-js 22/22 PASS; engines 148 PASS; e2e 36 PASS; release-binaries PASS (5 executables); desktop-binary PASS |
| Release gate `bodies` | **FAIL — classified**: all 1,681 differing bodies differ only in `tools[5]` (`proc_run` description, program enum removed, program description added) = the intentional M6A schema change; 5 crash-timing tests differ in request count and 1 (`a71…`) in concurrent task-text ordering — same artifact classes as M4/M5. Deep-diff script: `/tmp/m6_bodies_diff.py`; dumps: `/tmp/m6-bodies-base`, `/tmp/m6-bodies-new` |
| Release gate `production` (prodgate) | **FAIL — UNINVESTIGATED**: `5 passed, 1 failed < required minimum 14`. Direct prodgate re-run was started and stopped at wrap-up before results. |

## 6. Exact remaining steps (resume here)

1. Diagnose prodgate: `cd native && cargo test --manifest-path tools/prodgate/Cargo.toml`
   (release gate used `--prodgate-target native/target/prodgate`). Identify the 1 failure;
   check whether it also fails on `8e4e42f` (baseline) before treating it as an M6 regression.
2. Re-run the full native battery once on the final code SHA (`126207d` + any prodgate fix):
   `cd native && NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace`.
3. Re-run the release gate end-to-end on that SHA; bodies will still FAIL by design — decide
   with the owner whether the intentional M6A schema change is accepted as the new baseline
   (regenerate the baseline dump from the M6 tree) or must be gated differently.
4. Live Internet acceptance (needs owner-approved hosts, §4) — do not run before approval.
5. Then finalize: update this report's verdicts, final source SHA, and the M7 GO/NO-GO.

## 7. Verdict

**NO-GO (provisional) for M7** until steps 1–3 above close. M6A/M6B/M6C functionality is
implemented and its focused tests pass; the milestone cannot be called PASS while the
production gate failure is uninvestigated and the full battery has not run on the final SHA.

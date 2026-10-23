# EM-04C2 S10 — Activation checklist (SUPERSEDED for steps 2–4 by S10-A: see EM-04C2-S10A-ACTIVATION-REPORT.md)

Baseline `0eabd202aec8239133675e8997bd85dd73eef807` + the uncommitted S7–S9 work. **S10 is not started and
must not start until the owner has answered section 1.** Until then: `MUSE_V1_PRODUCTION_ENABLED = false`; the
adaptive definition is `planned` / `selectable: false` / `runnable: false`; no operator ModeConfiguration is
created; the default `engineering-v2` still runs `muse-v0`.

## 1. Owner decisions that block S10

| ID | Decision | Evidence / recommendation |
|---|---|---|
| D-1 | The installers already publish the dormant adaptive definition (planned, non-selectable, non-runnable, budget 440,000) and the Registry lists it as a non-executable row. | **ACCEPTED by the owner.** It must stay unavailable to production execution until S10; S10 must not rely on the preset closure to hide it. Proven independent barriers: S7–S9 report §4b. |
| D-2 | `RegistryR751DependencyCompatibility` is UNVERIFIED (older toolchain: `0.35.3` vs the lock file's `0.35.5`). | **REQUIRED BEFORE S10** (owner): verify against lock-file-pinned dependencies (a disposable `npm ci` into an isolated prefix — a network download that needs its own approval). Not a blocker for the S7–S9 commit. |
| D-3 | Worker confinement | Settled: single-user trusted worker + Node permission mode. Re-open only for multi-tenant use. |
| D-4 | F-4 (`pending_trusted`), F-5 ("elevated" = above the pinned default), F-7 | Settled by the owner at S6. |
| D-5 | A live A/B (the only way to observe provider behaviour when `reasoning.effort` changes mid-conversation with replayed encrypted reasoning, risk R3) | Separate, pre-approved step after S10's offline gates; not part of S10. |

## 2. Activation steps (in order; each with its verification)

1. **Commit S7–S9** after review. Verify: clean tree; the four S7–S9 documents and the new scripts present.
2. **Flip the compile-time constant**: `native/nexus-broker/src/engine/mod.rs` `MUSE_V1_PRODUCTION_ENABLED = true`.
   Verify: `engines(false)` → `["muse-v0", "nexus-adaptive-v1"]` (already proven by
   `the_production_gate_registers_only_muse_v1_and_only_when_opened`); the experimental engines stay test-only.
3. **Update the production gate DELIBERATELY** (these tests are supposed to change, and only these):
   `native/tools/prodgate/tests/production_gate.rs` — `only_the_default_mode_with_muse_v0_resolves` (now also
   `("engineering-v2-adaptive","nexus-adaptive-v1")`), `every_experimental_and_adaptive_engine_is_unavailable_under_every_mode`
   (`nexus-adaptive-v1` leaves the list), `the_activation_gate_is_a_closed_compile_time_constant` (becomes "open, and no
   environment variable changes it"); the lib tests `catalog_tests` (`assert!(!MUSE_V1_PRODUCTION_ENABLED)`),
   `signals_tests::only_the_experimental_engine_takes_signals`. Add: in a production build the adaptive engine
   still refuses without a sealed budget / saved configuration (release-mode functional test through the broker).
4. **Ship the mode** in `config/registry/modes/engineering-v2-adaptive.json`: `status` active, `selectable` true,
   `runnable` true (the budget 440,000 is already declared). Pin the file in `scripts/MusePresetDependencyClosure.cjs`
   (`REGISTRY_MODE_ASSETS`) so preset-local Registries carry it, and update the suites that assert the asset
   count (`MusePresetRegistryModes`, `RegistryR75InstallationAudit`) and the mode-list suites (`RegistryR3UI`,
   `RegistryInstalledRuntime`, `RegistryAdaptiveMode` — their "dormant" checks become "active").
5. **Keep the operator in control**: no default ModeConfiguration, no auto-adoption (`mode-configuration-required`
   stays), models scoped to `nexus-adaptive-v1` only by the operator (the shipped catalog lists none). Verify with
   `s4_the_adaptive_mode_needs_a_saved_configuration_and_a_sealed_budget_to_dispatch`.
6. **Documentation**: operator-facing statement of cost/risk (`xhigh` spend is bounded by `allowedReasoning`, by
   `1 + R = 3` claim-only episodes per logical task, and by whatever Kernel-verified failures justify), the F-5
   interpretation, the threat model, rollback.
7. **Validation on the exact final commit** (all must pass; a failure is reported, never re-labelled):

   ```bash
   cd native && NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace --no-fail-fast     # twice, consecutively, both green
   cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings
   cargo test --release --manifest-path tools/prodgate/Cargo.toml                  # updated per step 3
   cd .. && node scripts/EM04C2-ReleaseGate.cjs --report native/target/release-gate.json
   node scripts/EM04C2-JsEnvironment.cjs --report native/target/jsenv-report.json   # 0 REAL failures; list UNVERIFIED by name
   (cd apps/nexus-desktop/src-tauri && cargo test)
   # muse-v0 bodies vs 50a24d7: NEXUS_BODY_DUMP_DIR on both builds, then
   node scripts/EM04C2-CompareBodies.cjs <base> <new>                               # 0 unexplained; non-input fields identical
   ```
8. **Rollback**: set the constant back to `false` and the definition to `planned`/`selectable: false`/`runnable: false`.
   An adaptive run in flight completes or fails closed; a continuation of an adaptive task after rollback fails with
   `engine-unavailable` before any request (pinned by the production gate); no `muse-v0` data changes.

## 3. Gates that must stay true at activation (regression list)

* `muse-v0` is the default; its request bodies equal the pre-adaptive baseline (1,170 bodies compared in S8, 0 unexplained); catalog `58f513de…`; A614 maximum 449,944 B.
* The adaptive request budget is Registry-sealed (440,000 B), broker values only tighten it, a continuation cannot change it, the 450,000 B A614 guard is untouched.
* Historical Governor/Runtime/Activity/Signals sources byte-identical (digest recorded in every evaluation).
* No global activation flag; no auto-created ModeConfiguration; Governor workers keep the deny-all Node permission mode, an empty environment and the 100 MiB budget.
* Policy V2 (`dropped_before`, R = 2 per logical task), `pending_trusted`, the complete-trace `strong_escalation`.

## 4. Remaining release blockers (as of this milestone)

| # | Blocker | Owner |
|---|---|---|
| 1 | D-2: verify `RegistryR751DependencyCompatibility` against lock-file-pinned dependencies | before S10 |
| 2 | Two consecutive green full batteries on the final S10 commit | S10 |
| 3 | Live-provider observation (R3) — not an S10 offline gate | owner, after S10 |
| 4 | The historical sandbox failure ("systemd scope was not created") did not recur in any run of this milestone, but its root cause is **unproven**; it is not claimed eliminated | S10 validation |

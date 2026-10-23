# EM-04C2 — Activation plan (verified path, gaps, sequencing, validation)

> **Superseded identity (S9.5, commit `b3244c0`):** the adaptive engine described here as `muse-v1` is now **`nexus-adaptive-v1`** (mode `engineering-v2-adaptive` is unchanged). The old id is not an alias anywhere. This document is kept as written; see `EM-04C2-S95-IDENTITY-MIGRATION.md`.


Baseline `50a24d791cdb3c1a4b00eb15b24843c4b45d9798`. Read-only review; no implementation file was
changed. Companions: `EM-04C2-SECURITY-REVIEW.md`, `EM-04C2-ANTI-THRASH-POLICY.md`.
`file:line` references are to the baseline tree.

**Summary.** The authorization chain after the engine proposes an effort (host admission → durable
selection → Registry issuance → Kernel seal → write-ahead bind) is correct and already tested for
the test engine. Reading the source against the activation path in the previous handoff found
**four gaps that the handoff did not know about**, two of which would have made the plan
unimplementable or unsafe as written (G-1, G-2). They are all small and are sequenced below.

---

## 1. The intended path, verified against source

| # | Gate | Where it is enforced (baseline) | Status |
|---|---|---|---|
| 1 | Registry mode → sealed engine identity | Mode definition `config/registry/modes/*.json` → `resolver.cjs` binding → `native-issuer.cjs` target (`orchestrationEngineId`) → Kernel-sealed issuance. Broker: `engine::resolve_issued` (`engine/mod.rs:476-494`) accepts the typed resolution only if its content digest equals `issuanceId`, then `resolve` (`:436-470`) requires the engine to be built in **and** `mode_id ∈ descriptor.mode_ids` (`:455`). | works — **but see G-2** (only one mode is issuable) |
| 2 | Slot `allowedReasoning` | `resolver.cjs` (each level must be route-declared, must include the default, sorted) → `native-issuer.cjs` target field → `TaskBindingV1.supported_reasoning` = `authorized_levels(target)` (`nexus-contracts/src/task_binding.rs`) → `EngineSnapshot.authorized_efforts` (`engine/mod.rs:161`). Absent policy ⇒ `[default]`. | works — **continuity not enforced (G-1)** |
| 3 | Per-mode request budget | C1: mode `requestBudgetBytes` → sealed target → `TaskTarget::request_budget_bytes()`; `inspect.rs:2180-2184`. | done in C1; declare in the new mode (S7) |
| 4 | Tool catalog | `engine::tool_catalog_profile` (sealed engine id, `engine/mod.rs:74`), frozen digests, run-start guard, digest on the run record. | done in C1; add the `muse-v1` row (S6) |
| 5 | Engine proposes effort | `muse-v1-signals`/`muse-v1` descriptors: `may_propose_effort` false today; host admission `EngineHost::accept` (`engine/mod.rs:625-720`): proposal id, revision, `may_propose_effort`, not with `Finish`, `level ∈ authorized_efforts`. Effective **from the next attempt** (`from_attempt = dispatched+1`). | works — **identical-level `Change` is admitted (E-2)** |
| 6 | Durable before authorization | `EngineRun::consult` commits `effort-selected` whenever the selection changed (`engine_state.rs:547-572`), before the broker asks the Registry (`inspect.rs:2107` consult → `:2118-2128` target). | works |
| 7 | Registry issuance under the sealed binding | `TaskTarget::for_attempt` (`attempt_target.rs:239-326`): effort ∈ `binding.supported_reasoning` else `reasoning-level-not-supported`; bridge `issue-attempt` authorizes **against the sealed binding, not the live Registry**; `binding.admits` re-checks target/extension identity; result cached per effort. | works |
| 8 | Kernel-sealed attempt | `daemon "seal"` / `"seal-extension"` (`attempt_target.rs`), then `intent-publish` (`inspect.rs:2257`), `accept` (`:2262`, the Kernel re-checks `binding.admits`), `dispatch-authorize` (`:2281`, single-use grant bound to the prepared target). | works |
| 9 | Write-ahead bind | `EngineRun::bind_attempt` (`engine_state.rs:606-626`) commits `attempt-bound {effort, issuanceId, extensionDigest}` **before** publish (`inspect.rs:2231`). | works |
| 10 | Continuation | New task generation, new issuance, `identity_digest` equality (`inspect.rs:~1593`, `attempt_target.rs:328-358`), effort restarts at the default and is re-proposed (`effort-reset-continuation`). | **identity omits the slot policy (G-1)** |

Invariants checked in source:

* **`muse-v0` unchanged.** `tool_catalog_profile("muse-v0", true) == RepoCodeV1`; `muse-v0` has no
  `propose_in` override, no worker, no budget key; identical bodies established in C1 (944/944 model/
  tools/reasoning).
* **No global activation flag.** There is none today: the only gate is the compile-time constant
  `MUSE_V1_PRODUCTION_ENABLED = false` (`engine/mod.rs:60`) plus Registry selection. The plan
  *removes* the constant (S6) without adding any runtime switch; presence in `built_in()` only makes
  the engine **selectable by a sealed Registry resolution**, never default.
* **Default-only slots stay at default.** `allowedReasoning` absent ⇒ `authorized_efforts = [low]` ⇒
  Governor `capability-unavailable` ⇒ `would = keep` ⇒ `KeepPinned` (E2E
  `em04a_…_default_only…`, anti-thrash test A9).
* **`requestMax` unavailable to the model.** Rust `FORBIDDEN_SIGNAL_FIELDS` and the historical
  validator both refuse it; the proposal type has no such field (`EngineProposal`,
  `engine/mod.rs:328-334`: id, revision, action, effort, next_state).
* **No model/provider/route/credential switching.** `EffortProposal` carries one level string; the
  Registry bridge `issue-attempt` accepts `requestedEffort` only and rejects anything outside the
  binding; identity digest pins model/route/provider/connection/credentialRef.
* **Every effort transition is durable and auditable before dispatch** (rows 6, 9): events
  `effort-selected` (proposal id, from-attempt, effort) → `attempt-bound` (attempt, effort,
  issuanceId, extensionDigest) → Kernel receipt. Retained decision history (≤ 8) holds the Governor
  evidence chain. (Audit weakness E-1 for signals, fixed in S2.)

## 2. Gaps found (new) and required fixes

| ID | Severity | Finding (source) | Fix |
|---|---|---|---|
| **G-1** | **High** | **A continuation can silently gain effort authorization.** `identity_digest` (`attempt_target.rs:328-358`) hashes mode, engine, role, model, route, provider, connection, kind, protocol, endpoint, credentialRef, wireProfile, default effort — and (C1) the request budget — but **not** the slot's `allowedReasoning`. Verified by computing it: identity for `allowedReasoning=[low]` is `0779f0cf…d6f9` and for `[low,medium,high,xhigh]` is **identical**. If the operator widens the policy between an interruption and the continuation, the continuation's new binding authorizes `xhigh` and the run continues with no `task-binding-mismatch`. Same for narrowing. | S3: add `"allowedReasoning"` (sorted, as in the target) to the identity **only when present** (same pattern as the budget; digests of policy-less targets unchanged). Policy change ⇒ `task-binding-mismatch` before any request; the operator starts a new task. |
| **G-2** | **Blocking for the plan** | **The Native issuance path is hard-wired to one mode.** `native-issuer.cjs:41` `SUPPORTED_MODE_ID = 'engineering-v2'`, `:64` rejects any other `modeId` (`registry-unsupported-scope`), `:130` rejects any binding with another mode; `native-target-v2.cjs:160,310` hard-code it; `parseSelectionJson` accepts exactly `{logicalModelId, routeId}` (`native-intent-bridge.cjs:165-178`). `muse-v1`'s descriptor lists `mode_ids: ["engineering-v2"]` (`muse_v1.rs:67,87`). So "a Registry mode whose engine is `muse-v1`" **cannot exist** today except by editing `engineering-v2.json` itself — which would switch every Native Muse user on the install to the adaptive engine at once (the global switch the plan forbids), with no per-task choice and no way to keep `muse-v0` available. | S4 (see §3). |
| **E-1** | Medium | `signal-accepted` is written for unrecorded signals (`engine_state.rs:597-600`). | S2. |
| **E-2** | Medium | Host admits `Change(level)` equal to the effort in force (`engine/mod.rs:645-670`), producing a new selection + durable event per request if an engine proposes it each time. | S2: `engine-effort-noop`. |
| **W-1** | Medium | Worker RSS 208–214 MiB on the bundled Node 24 with the current heap flag; no permission mode. | S1 (security review §A.6/A.8). |
| **V-1** | Process | Battery had one environment failure; probe is run per test and error detail is discarded (§5). | S0. |

## 3. Decision required: how a run chooses the adaptive mode (G-2)

| Option | Mechanism | Verdict |
|---|---|---|
| M1 | Change `modes/engineering-v2.json` `orchestrationEngineId` to `muse-v1` | **Rejected.** Global for the install, irreversible per task, removes `muse-v0` from Native, defeats default-unchanged. |
| **M2 (recommended)** | New shipped, selectable, runnable mode `engineering-v2-adaptive` (engine `muse-v1`, role `muse_main`, single slot, own `requestBudgetBytes`); the issuer's single constant becomes a **closed table** `{engineering-v2 → muse-v0, engineering-v2-adaptive → muse-v1}`; the selection JSON gains an optional third key `modeId` from that table (default `engineering-v2`); the adaptive mode is issuable **only when the operator has saved a ModeConfiguration for it** (the Registry already returns `registry-unresolved` otherwise), which is where `allowedReasoning` is authorized. Models/routes must list `muse-v1` in `engines` (existing `checkEngineScope`). | Smallest design that keeps the Registry as the only authority, needs no flag, and keeps `muse-v0` the unchanged default. |
| M3 | Operator-only: a Registry data-root setting "default Native mode" | Smaller client surface, but it is a per-install switch (closer to the forbidden global flag); keep as a fallback if no client contract change is wanted. |

Under M2 the Desktop/CLI exposure (a picker for the mode) is **out of C2's minimum**: the CLI/intent
field is enough to validate end to end; the GUI can follow.

Because `modeId` is already in the binding identity, a conversation/continuation cannot switch mode
silently (`task-binding-mismatch`), and `resolve` requires `mode_id ∈ descriptor.mode_ids`
(`engine/mod.rs:455`), so `muse-v1` cannot run under `engineering-v2` and `muse-v0` cannot run under
the adaptive mode.

## 4. Implementation sequencing (suitable for Sonnet 5.5)

Each step is a separate reviewable commit-sized change with its own tests; run the **affected**
suites per step, and the full battery at S8 and S10. No step enables adaptive behaviour until S6;
S6 is inert until the operator saves the adaptive mode configuration (S4).

| Step | Change | Files (indicative) | Acceptance |
|---|---|---|---|
| **S0** | Test-environment stability (no product change): cache the sandbox preflight once per test binary (`OnceLock`) and retry a *sandbox-unavailable* probe up to 3× with back-off **in the test helper only**; include the captured `systemd-run` stderr and `systemctl --user is-system-running` in the "scope was not created" error so the next occurrence is diagnosable (`nexus-tools/src/sandbox.rs:874-885`). Product behaviour stays fail-closed. | `nexus-broker/tests/code_a56.rs:1126` (`sandbox_ready`), `nexus-tools/src/sandbox.rs` (message only) | `code_a56` × 3 consecutive runs green; a forced probe failure still fails when `NEXUS_REQUIRE_SANDBOX=1` after the retries |
| **S1** | Worker hardening: argv `--permission --max-old-space-size=48 --max-semi-space-size=2`; `ready` carries `permission:{enforced:true}` (worker checks `process.permission && !process.permission.has('fs.read','/')`) and the supervisor refuses otherwise; worker cap = `min(max_active, 16)` via constructor; update docs | `worker_bridge.rs` (`spawn`, `handshake`, `WorkerConfig`), `muse_bridge_worker.cjs`, `inspect.rs` (pass cap) | `W the_worker_denies_fs_process_and_addon_access` (probe script under the same flags: read of a temp 0600 file, `execSync`, `dlopen` ⇒ denied), `W a_node_without_the_permission_flag_is_refused` (fake `node` shim that rejects `--permission`), RSS ≤ 100 MiB after 10,000 requests on bundled Node 24.18.1 and system Node (measurement test, `--ignored`), all existing worker/parity suites on both transports |
| **S2** | E-1 and E-2: event `signal-handled` with `detail` `applied|duplicate|unrecorded:<code>` (keep reading old `signal-accepted` records); host `engine-effort-noop` for `Change(level)` equal to `effort_for_attempt(dispatched+1)` or, without a selection, to the pinned default | `engine_state.rs:597`, `engine/mod.rs:645` | new unit tests; **update** the EM-03/04B recovery-matrix expectations that read `signal-accepted`; old fixtures still reopen byte for byte |
| **S3** | G-1: add sorted `allowedReasoning` to `identity_digest` iff present | `attempt_target.rs:328` | digest of a policy-less binding **unchanged** (pin the EM-03 fixture digests); identical identity ⇒ continuation proceeds; widened/narrowed/removed policy ⇒ `task-binding-mismatch`, nothing sent (E2E, pattern of `em04c1_a_sealed_budget_is_stable_across_continuation…`) |
| **S4** | G-2 / M2: shipped mode `engineering-v2-adaptive`; issuer scope table; `native-target-v2.cjs`; `parseSelectionJson` optional `modeId` (closed set, default `engineering-v2`); `parity.cjs` `KNOWN_ORCHESTRATION_ENGINES` += `muse-v1`; contracts `ModelSelection.mode_id` (optional) and broker pass-through; `registry-engine-scope` fixture helper accepts the new engine | `config/registry/{modes/engineering-v2-adaptive.json,native-issuer,native-target-v2,native-intent-bridge,parity}.cjs`, `nexus-contracts/src/intent.rs`, broker `server.rs`/`inspect.rs` selection plumbing | new Registry JS suite: default issuance **byte-identical** to baseline for a request without `modeId`; `modeId:'engineering-v2-adaptive'` unresolved without a saved configuration; resolved with one; any other `modeId` ⇒ `registry-unsupported-scope`; a model not scoped to `muse-v1` ⇒ `engine-scope-mismatch`; all 33 existing Registry/Native JS suites unchanged |
| **S5** | Limiter pure module + fixtures (policy doc §3, §6.1–6.3): `engine/effort_limiter.rs`, `engine/effort_limiter_tests.rs`, trace generator in `anti_thrash_review.rs`, fixture `tests/fixtures/em04c2-governor-traces.json` | new files | T1–T16, P1–P7, pinned traces (L3 column of the policy doc) |
| **S6** | Production `muse-v1` engine: `MuseV1Active` = `muse-v1-signals` strategy with `may_propose_effort: true`, `mode_ids: ["engineering-v2-adaptive"]`, `request_reserve_bytes: 0`, new `state_schema` carrying the limiter state; `propose_in(BeforeRequest)` = `limit(would)` mapped to `Change`/`KeepPinned`; `check_transition` validates the limiter (policy doc §5); `tool_catalog_profile` row → `RepoCodeMuseSignalsV1`; remove `MUSE_V1_PRODUCTION_ENABLED`; `engines(false) == ["muse-v0","muse-v1"]` (shadow/signals test-only); update EM-01 "reserved id" test **deliberately**; lend the worker to `muse-v1` in `inspect.rs` | `engine/muse_v1.rs` (or `muse_v1_active.rs`), `engine/mod.rs`, `inspect.rs:1164-1202` | S5 + host tests H1–H2, S1–S5 of policy §6.4; production-gate scratch check: `muse-v1` resolves **only** with mode `engineering-v2-adaptive`; `muse-v1-shadow`, `muse-v1-signals`, `effort-test-v0` ⇒ `engine-unavailable`; fixture key refused |
| **S7** | Declare the adaptive mode's `requestBudgetBytes` (suggest 440,000: measured A614 max with the tool is 428,722; guard stays 450,000) | mode file | E2E A614 with the real catalog under the sealed budget (existing C1 test pattern) |
| **S8** | Mock-provider E2E (policy §6.5) and recovery matrix for `muse-v1`: fault points `before-accept`, `after-accept`, `after-authorize`, `after-bind`, `persist-signal` around a real effort change; default-only slot; continuation with changed policy; worker killed repeatedly during an adaptive run; every non-default attempt has `effort-selected` → Registry issuance → Kernel receipt **before** the provider request | `tests/code_a56.rs` | all green; **then run the full battery** |
| **S9** | Production gate automation: turn the scratch `prodgate` check into a repository test that builds without `test-engines` (separate tiny crate or `cargo` invocation in a script), and a bodies-vs-baseline comparison script (the C1 dump harness) for `muse-v0` | `scripts/` or a `tests/` binary | documented command; output stored in the report |
| **S10** | Documentation, report, validation (§5), recommendation | `native/docs/EM-04C2-*.md` | |

Ordering rationale: S0 first so every later step is judged on a stable battery; S1–S3 are
hardening that is safe with adaptive still off; S4 creates the mode but nothing can select it until
an operator saves its configuration; S5 is pure; S6 is the only behavioural change; S7–S9 prove it.

## 5. Validation (D)

**Status to carry forward, not to rewrite:** the last full battery of EM-04C1 is **1,111 passed,
1 failed, 55 ignored**. The failure
(`rn2_a_coding_run_on_the_second_model_is_bound_to_it_and_its_connection_on_every_provider_call`)
stopped at the harness precondition `sandbox-unavailable: systemd scope was not created` and passed
3/3 in isolation. It is **not** a clean battery and is not described as one anywhere.

**Environment-stability analysis (this review):**

* *Where it comes from:* `locate_scope_cgroup` polls `/proc/<pid>/cgroup` for up to 5 s (500 × 10 ms)
  for the transient `…scope` and returns `None` → "scope was not created" (`nexus-tools/src/sandbox.rs:541-555`,
  `:874-885`); the `systemd-run` stderr that would explain it is captured but discarded on that
  path. `sandbox_ready()` runs a **full functional probe in every test** (`code_a56.rs:1126`), so a
  battery performs on the order of a hundred extra scope creations next to the tools' own.
* *Reproduction attempt:* 536 consecutive `preflight()` calls from a scratch binary — 1 thread × 40,
  8 × 15, 16 × 8, and again 8 × 15 and 16 × 8 with 24 CPU-saturating busy loops running — **all
  passed**. So the failure is not reproduced by probe volume, concurrency or CPU contention alone.
* *Status:* **root cause unproven.** Hypotheses, not facts: user-manager/D-Bus latency or
  start-rate limiting during a long, dense battery; a race between a very short-lived probe program
  and the cgroup lookup. S0 adds the missing diagnostics and de-duplicates the probe; if the failure
  recurs, its message will say why.

**Minimum validation before production activation (all required):**

1. **Two consecutive fully green full batteries** (`NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace
   --no-fail-fast`) on the exact C2 commit, with S0 in place. A failure whose message is the
   sandbox-unavailable probe may be re-run once, but *every* failure is reported with its message;
   a battery containing a failure is never recorded as green. If S0's diagnostics implicate the host,
   fix the host before counting.
2. `muse-v0` byte-compatibility vs the baseline commit: C1's dump harness over the whole
   `code_a56` suite — `model`, `tools`, `tool_choice`, `parallel_tool_calls`, `stream`,
   `max_output_tokens`, `reasoning` identical for every request; catalog digest `58f513de…`; A614
   max 449,944 B.
3. Original Muse JS suites (52/30/28/33/34) and all Registry/Native JS suites; the new mode suite.
4. EM-04A/B Governor and Signals differential and adversarial suites on **both** bridge transports.
5. Production gate: a release build **without** `test-engines`: `muse-v1` resolves only through the
   adaptive mode; the three test engines are `engine-unavailable`; the published fixture key is
   refused; no `test_engine`/`test_faults` symbols.
6. Worker: permission self-check, memory test (≤ 100 MiB after 10,000 requests on both Nodes),
   cap, kill storm during an adaptive run.
7. Limiter: pure tests, properties, pinned traces; E2E; recovery matrix.
8. Desktop Tauri tests (27 passed, 2 ignored at baseline).
9. fmt and strict clippy (`-D warnings`).
10. **No** live provider and **no** paid inference. A live A/B is a separate, pre-approved step after
    1–9, as already decided.

## 6. Risks and open decisions

| ID | Decision / risk | Recommendation |
|---|---|---|
| **D1** | Limiter amendments A-1 (immediate progress de-escalation) and A-2 (re-arm token budget `R = 2`, trusted-evidence bypass) beyond the four stated rules | Adopt; data in the policy doc (§4). Without them A4 is unbounded and `xhigh` dwell doubles. |
| **D2** | Activation channel (§3): M2 vs M3 | M2; M3 is the fallback if a client contract change is unwanted. |
| **D3** | Require `--permission` (Node ≥ 23.5) for the adaptive engine | Require; fail closed otherwise. Bundled runtime is 24.18.1. |
| **D4** | Slot policy changes between interruption and continuation | Refuse (S3). If narrowing should be allowed later, make it an explicit subset rule, not an omission. |
| R1 | Limiter delays a legitimate claim-only re-escalation beyond the 2 tokens when no failed check exists | Documented trade-off; bypass by any fresh Kernel-verified failure; tokens are constants of the engine version. |
| R2 | A narrower `allowedReasoning` than the Governor wants clamps down (`xhigh→high`); the limiter sees the clamped value | By design (clamp precedes the limiter). |
| R3 | Provider behaviour when `reasoning.effort` changes across a conversation with replayed encrypted reasoning items | Unknown; observe in the mock E2E for shape only, and in the approved live A/B. |
| R4 | Operator saves the adaptive mode configuration but leaves `allowedReasoning` unset | Safe: default-only ⇒ `low` forever (an adaptive mode that never adapts). Consider a Registry warning. |
| R5 | `max_active` raised above 16 | Adaptive runs beyond 16 fall back to the pinned effort (`bridge-busy`); documented. |

## 7. Recommendation

**READY FOR IMPLEMENTATION** of the plan as amended here — and **not** of the previous
`EM-04C2-ACTIVATION-HANDOFF.md` as written, which assumed a Registry mode could simply name
`muse-v1` (G-2), that continuity covered the slot policy (G-1), and a worker memory profile (W-1)
that the bundled Node does not have.

Evidence for readiness: the effort-authorization chain (rows 5–9) is implemented and tested end to
end; the worker's inputs contain no free model text and the historical validators refuse every
hostile shape tried, with no prototype pollution across 12 responses; the cheapest isolation control
(`--permission`) runs the unchanged worker on both Node versions with no overhead; the limiter
policy is specified with exact tests and has been evaluated against 13 real-Governor traces (A1
24 → 1 changes; A4 13 → 7 changes and `xhigh` 6 → 3; zero held escalations on genuine-evidence
traces and the four parity traces).

Before step S1 the owner must settle D1–D3; D4 is recommended as stated. Nothing in the baseline needs
to be reverted. The one validation gap (the unreproduced sandbox probe failure) is handled by S0 and
by requiring two consecutive green batteries, not by assumption.

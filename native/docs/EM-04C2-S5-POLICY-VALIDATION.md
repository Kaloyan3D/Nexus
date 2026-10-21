# EM-04C2 S5 — Policy validation record

Baseline `c292a0e0520d0a18e37e10cf156d721dfb25c6a6`. Branch `feature/native-muse-effort-limiter`, uncommitted.
Commands were run in `native/` of that worktree. No live provider, no paid inference.

## 1. Result summary

| Check | Result |
|---|---|
| New limiter tests (`engine::effort_limiter_tests`) | **29 passed**, 0 failed, 1 ignored (the explicit regeneration action) |
| T1–T16 (policy §6.1) | all pass (`t01`…`t16`; T15 additionally exhaustive over 480 reachable states × 4 levels × 64 evidence/attempt combinations) |
| P1–P7 (policy §6.2) | hold on **5,000 traces × 60 attempts** (fixed seeds) |
| Pinned real-Governor traces | 13/13 reproduce the L3 column of policy §4; the fixture is byte-for-byte what the unchanged Governor produces |
| Whole `engine::` lib suite (Governor + Signals parity, EM-01/02/03/04A/04B, worker, catalog) | 148 passed, 0 failed, 5 ignored |
| `governor_parity`/`signals_parity`/`signals_tests`/`anti_thrash_review` | 39 passed, 0 failed |
| EM-02 attempt-target integration suite | 9 passed |
| **Full offline workspace battery** `NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace --no-fail-fast` | **1,175 passed, 0 failed, 57 ignored** (91 result lines, exit 0) — run once on the final tree |
| Checkpoint 1 battery for comparison | 1,146 / 0 / 56 → +29 passed (exactly the new tests), +1 ignored (regeneration action) |
| `cargo fmt --all -- --check` | clean |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| JS suites (`MuseReasoning*`, `MusePreset*`, `Registry*`, `Native*` — 41 files) | **identical pass/fail set to the baseline tree** (21 pass / 20 fail on both). The 20 failures are environmental and pre-existing (missing `@deepseek-ai/dsh-tools` and `pwsh`; they fail the same way in the Checkpoint 1 worktree and the primary checkout). They are not a statement that those suites are green here. |
| Governor/Runtime/Activity/Signals, bridges, `muse_v0.rs`, `muse_v1.rs`, `engine_state.rs`, `inspect.rs` vs baseline | byte-identical (`git diff --stat` empty) |

The battery was run once on the final tree (an earlier run on a pre-refactor tree also ended green, but its log
was lost with the scratch directory, so it is not counted). The Activation Plan's requirement of **two
consecutive green batteries on the final C2 commit** is a Checkpoint 2 gate and is not claimed here. The
historical, unexplained sandbox failure is not claimed to be eliminated; it did not occur in this run.

## 2. Table cases T1–T16

| # | Test | Asserts |
|---|---|---|
| T1 | `t01_…noop…` | equal proposal at every level ⇒ `KeepPinned`/`noop`, pending cleared |
| T2 | `t02_…` | ordinary escalation immediate, pending cleared, **no token** even with budget spent |
| T3 | `t03_…` | first strong escalation immediate, free; still free until a drop happens |
| T4 | `t04_…` | claim-only strong re-arm after a drop consumes tokens 0→1→2 |
| T5 | `t05_…` | budget spent ⇒ `hold-rearm` at 11 consecutive attempts; only `last_attempt` moves |
| T6 | `t06_…` | trusted failure (earlier or this attempt) bypasses the exhausted budget, flag spent, tokens untouched; no credit without a prior drop |
| T7 | `t07_…` | first lower decision ⇒ pending only |
| T8 | `t08_…` | second consecutive distinct attempt applies it, `down-confirmed` |
| T9 | `t09_…` | skipped evaluation replaces pending |
| T10 | `t10_…` | claim or trusted evidence resets pending; the dwell then restarts (7 reset, 8 pending, 9 applies) |
| T11 | `t11_…` | governor ≥ current cancels pending |
| T12 | `t12_…` | progress edge without evidence drops at once; flag cleared |
| T13 | `t13_…` | edge with claim/trusted/both ⇒ `reset-evidence`, no drop |
| T14 | `t14_…` | equal/earlier attempts inert for four input shapes, state identical; replay after a real change inert |
| T15 | `t15_…` | `max`, unauthorized level (either side), attempt 0, default-only slot ⇒ `limiter-input-invalid`; exhaustive: no invalid `Change`, no error on a valid input, every returned state valid |
| T16 | `t16_…` | different lower decisions apply the **higher**, both orders, always `< current` |

Additional: strict decoder (26 malformed shapes), state round-trip/size/canonical form, nine-way
`validate` invariants, continuation, `verify_transition` (forged action/state/attempt/unadvanced state),
vocabulary and constants, the evidence baseline (claims, conflict rise, edges, malformed blocks, saturation).

## 3. Properties

Generator: SplitMix64, seed `BASE ^ index·0xA24B…E407`, 5,000 traces × 60 steps, four evidence-density
profiles, authorized sets containing `low` with each higher level present at p = 3/4, and **deliberately
hostile attempt numbering** (repeats, regressions, skips). A failure prints the property, the seed, the
authorized set and a delta-debugged **smallest failing trace**.

| P | Judged from | Result |
|---|---|---|
| P1 churn ≤ Governor up-moves + ⌈accepted/2⌉ | inputs only | hold |
| P2 every drop is a confirmed-dwell or an edge drop; the converse rules (edge ⇒ immediate, evidence ⇒ no drop) | oracle recomputed from the *previous input*, not from limiter state | hold |
| P3 escalation never delayed unless claim-only strong re-arm past budget; every hold has a justification | oracle | hold |
| P4 `Change(e)`: `e ≠ cur`, authorized, not `max`; up ⇒ `e == gov`; down ⇒ `gov ≤ e < cur` and `e` was proposed by the last two Governor decisions | inputs/outputs | hold |
| P5 claim-only re-arms ≤ R; token counter moves by ≤ 1 and only on a strong post-drop escalation | oracle | hold |
| P6 replay/out-of-order inert; replaying **every** step against the final state changes nothing | oracle (independent replay detection) | hold |
| P7 purity (equal inputs ⇒ equal outputs) | recomputation | hold |
| INV state invariants after every step | `validate` | hold |

Coverage over the corpus (rule counts, all ≥ 100 as the test requires): `noop` 126,290; `reset-evidence`
43,245; `down-pending` 36,719; `up` 34,858; `replay-guard` 29,624; `down-confirmed` 13,165;
`down-progress` 12,428; `hold-rearm` 3,671.

**The properties are not vacuous.** Six deliberate mutations of the limiter were each caught (by properties
and/or table tests): no replay guard; no trusted bypass; edge drop ignoring evidence; unlimited tokens;
confirmed drop using only the newer proposal (breaks T16/P2); re-arm check applied without a prior drop
(breaks P5/P3/pins). A separate test feeds hand-forged violations to the checkers and requires rejection.

## 4. Pinned traces of the real Governor

`nexus-broker/tests/fixtures/em04c2-governor-traces.json`, produced by `anti_thrash_review::governor_traces()`
driving the unchanged modules through the worker. `the_pinned_traces_are_what_the_unchanged_governor_produces`
re-derives all 13 traces in memory on every run and requires equality (skipped only if `node` is missing).
`the_pinned_traces_reproduce_the_policy_documents_l3_column` compares against a **hand-copied** table of policy
§4 and against the stored `governor`/`l3` blocks. The numbers matched the document on the first execution; the
fixture was not adjusted to fit.

| Trace | Governor chg / xhigh | L3 chg / xhigh | excess | held |
|---|---|---|---|---|
| A1 flapping ×24 | 24 / 0 | **1** / 0 | 12 | 0 |
| A3 sticky escalation | 3 / 16 | 3 / 16 | 0 | 0 |
| A4 claim-only re-arm ×6 | 13 / 6 | **7 / 3** | 0 | 3 |
| A4s slow lap ×4 | 9 / 4 | 7 / 3 | 0 | 1 |
| G1 genuine laps ×4 | 10 / 4 | 10 / 4 | 0 | 0 |
| G2 genuine second problem | 5 / 3 | 5 / 3 | 0 | 0 |
| A5 conflict then resolve | 2 / 6 | 1 / 7 | 2 | 0 |
| A6 edit/test loop | 3 / 0 | 2 / 0 | 1 | 0 |
| A7 ordinary session | 8 / 0 | 4 / 0 | 2 | 0 |
| P1 parity escalation + progress | 5 / 2 | 5 / 2 | 0 | 0 |
| P2 parity root cause/conflict | 3 / 1 | 3 / 2 | 2 | 0 |
| P3 parity trusted activity | 5 / 0 | 5 / 0 | 2 | 0 |
| P4 parity restart/continuation | 2 / 3 | 2 / 3 | 0 | 0 |

(excess = Σ levels the limiter keeps above what the Governor wants; held = attempts where an escalation the
Governor wanted is withheld.) Asserted explicitly: G1, G2, P1, P4 applied sequences equal the Governor's own,
with no `hold-rearm` or `down-pending`; the three A4 holds are all claim-only re-arms; G1 contains Kernel-verified
failures; `max` never appears. Claim vs trusted: G1/G2 escalations are backed by `trustedFail > 0` rows and are
never held; A4 laps have none and are held after two tokens.

**Fixture regeneration** is an explicit action: the test is `#[ignore]` and refuses without
`NEXUS_REGENERATE_EM04C2_TRACES=reviewed`. After the `EvidenceBaseline` refactor the fixture was regenerated once to
prove the refactor neutral and compared with `cmp`: **byte-identical**.

## 5. Production behaviour

`muse-v0` has no path to the limiter: no file it uses was modified; the C1 byte-identity tests
(`em04c1_muse_v0_requests_are_byte_identical_…`, catalog digests, A614 bound) passed in the battery.
`MUSE_V1_PRODUCTION_ENABLED` is still `false`, `built_in()` is unchanged, the Registry issuer, Kernel and
durable record format are untouched, and the module adds no I/O, no clock, no environment read and no
persistence.

## 6. Verdict

**APPROVE.** The L3 policy is a deterministic, independently tested component whose behaviour on the real
Governor traces equals the approved policy document, with the Governor and all production paths untouched.

Conditions the reviewer should confirm before S6 (none blocks S5):
1. F-1: S6 persists a four-value `EvidenceBaseline` beside the five approved limiter fields (handoff §3.2).
2. F-2: accept that each continuation grants one free strong escalation, or approve a sixth field.
3. F-3: `strong_escalation` is taken from the untruncated Governor trace.
4. The Checkpoint 2 gates remain open: limiter wiring (S6), two consecutive green batteries on the final C2
   commit, OS-level worker confinement decision, and the unexplained historical sandbox failure.

# EM-04C2 S5 — Effort Transition Limiter: implementation report

Baseline `c292a0e0520d0a18e37e10cf156d721dfb25c6a6` (Checkpoint 1, untouched). Worktree
`~/Projects/Nexus-muse-effort-limiter`, branch `feature/native-muse-effort-limiter`. **Uncommitted.**
Companions: `EM-04C2-S5-POLICY-VALIDATION.md` (evidence), `EM-04C2-S6-INTEGRATION-HANDOFF.md` (contract).

## 1. What was built

| File | Change |
|---|---|
| `nexus-broker/src/engine/effort_limiter.rs` (new, `pub mod effort_limiter`) | the approved L3 policy as a pure function, its state, strict encoding/validation, the host's transition verifier, and the evidence-baseline helper |
| `nexus-broker/src/engine/effort_limiter_tests.rs` (new, `#[cfg(test)]`) | T1–T16, state/encoding/continuation/verification tests, properties P1–P7 over 5,000 × 60 traces, pinned-trace tests, the explicit regeneration action |
| `nexus-broker/src/engine/anti_thrash_review.rs` (+328 lines, append only) | `governor_traces()`: drives the **real, unchanged** Governor through the existing worker harness for the 13 documented traces |
| `nexus-broker/tests/fixtures/em04c2-governor-traces.json` (new) | the pinned per-attempt Governor output and the pinned L3 results |
| `nexus-broker/src/engine/mod.rs` (+3 lines) | `pub mod effort_limiter;` and the two test-module declarations |

Nothing else changed: **no** edit to the Governor/Runtime/Activity/Signals sources, the bridges, `muse_v0.rs`,
`muse_v1.rs`, `engine_state.rs`, `inspect.rs`, the Kernel, contracts, tools, Registry (JS) or the durable
record format. `git diff c292a0e --stat` over those paths is empty (checked).

## 2. The policy as implemented

`limit(prev, input) -> Result<LimiterDecision, LimiterError>`; constants `DWELL_DECISIONS = 2`,
`REARM_TOKENS = 2`, `LIMITER_POLICY_VERSION = 1` (constants, never environment or flags).

Order of evaluation (exactly the policy document §3):

0. Replay/out-of-order guard: `attempt <= last_attempt` ⇒ `KeepPinned` (`replay-guard`), state unchanged.
   Otherwise `last_attempt = attempt`; a fresh trusted failure after a drop sets `trusted_since_down`.
1. `governor == current` ⇒ `KeepPinned` (`noop`), pending cleared.
2. `governor > current`: pending cleared. Ordinary or first-strong escalation ⇒ `Change` (`up`, immediate).
   A *strong* escalation after an earlier drop: trusted corroboration ⇒ `Change` (flag spent, tokens untouched);
   else a token (`rearm_tokens_used < 2`) ⇒ `Change`, token consumed; else `KeepPinned` (`hold-rearm`).
3. `governor < current`: progress edge with no new evidence ⇒ immediate `Change` (`down-progress`, A-1);
   any new claim/trusted evidence ⇒ pending cleared, `KeepPinned` (`reset-evidence`); a pending decision from
   attempt `n-1` ⇒ `Change(max(target, governor))` (`down-confirmed`); otherwise record pending
   (`down-pending`).

Output guarantees, enforced twice (by construction and by a hard check in `out()` that returns
`limiter-invariant` instead of ever emitting a bad value): a `Change` is never `max`, never unauthorized,
never the level in force; an up-move is exactly the Governor's proposal; a down-move is never below the
Governor's current proposal and is one of the two Governor proposals involved. The module has no way to
express a model, provider, route, credential or permission.

## 3. State contract

`LimiterState { pending_down, last_down_attempt, trusted_since_down, rearm_tokens_used, last_attempt }`
— exactly the five approved fields, `Copy`, ≤ 256 bytes encoded (widest case measured and asserted).

* `to_value` / `from_value`: canonical camelCase JSON, **strict** decoder (exact key set, exact types,
  `u32` ranges, levels from the closed set, never `max`, token budget and the `trusted ⇒ drop` coupling
  checked). 26 malformed shapes are tested.
* `validate(&StateBounds)`: the host-context invariants of policy §5 (`last_attempt` ≤ admitted attempt,
  pending/drop attempts inside `1..=last_attempt`, pending target authorized, not `max`, below the level in
  force, tokens ≤ R, trusted flag needs a drop). `limit()` refuses to run over an invalid state.
* `verify_transition(prev, input, action, next, max_attempt)`: validates `next`, then recomputes `limit()` and
  requires equality — the host never trusts an engine's claim about what the policy decided.
* `continued()`: keeps `rearm_tokens_used` (budget per task), resets pending, last drop, trusted flag and
  `last_attempt` (generation-local). See handoff §5 for the consequences and the accepted residual F-2.

## 4. Evidence vocabulary (trusted vs claimed)

The limiter takes counters, not events. `new_trusted_failures` is documented and tested as Kernel-backed
(derived by the host from `snapshot.activity`); `new_claim_units` as model claims (growth of the Governor's
**historical** failure totals plus a conflict rising). `EvidenceBaseline::{from_reasoning, delta_to}` implement
the claim/edge derivation from the Governor's own semantic block; the fixture generator uses the same helper,
and refactoring the generator onto it left the pinned fixture **byte-identical**, which ties the helper to the
semantics the 13 traces were built with.

## 5. Findings for the reviewer

| ID | Finding | Disposition |
|---|---|---|
| F-1 | The claim delta cannot be recovered from the Governor block alone at `BeforeRequest` (signals are folded earlier, in `take_signals`). S6 must persist a four-value `EvidenceBaseline` next to the five limiter fields. | Helper provided and tested; persistence deliberately **not** invented in S5 (handoff §3.2). Needs reviewer acknowledgement because it extends the approved state payload. |
| F-2 | After a continuation each generation gets one free strong escalation (`last_down_attempt` is cleared by design). Not model-triggerable; bounded by `allowedReasoning`. | Accepted by the approved policy; fix would need a sixth persisted field. |
| F-3 | `ShadowDecision.trace` truncates to 8 entries; `strong_escalation` must be taken from the untruncated bridge answer. | Handoff §3.3, test L-1 for S6. |
| F-4 | Decision-time accounting: the policy document's §4 tables count the effort the policy *settles on* at each evaluation; a `Change` applies from the next attempt (`from_attempt = dispatched + 1`). Pinned numbers use the document's convention. | Documented in the tests; no behavioural consequence. |
| F-5 | `A5`, `A6`, `A7`, `P2`, `P3` keep the one-attempt dwell cost (excess ≤ 2 effort-attempts; 12 in the 24-attempt flapping trace) exactly as the policy document §4 predicted. | By design. |

## 6. Boundaries held

Governor, Signals, Activity, Runtime and both bridges byte-identical; `muse-v0` untouched and not wired to the
limiter; `muse-v1` not activated (`MUSE_V1_PRODUCTION_ENABLED` still false); Registry issuer, Kernel and the
durable record format untouched; no new persistence; no environment variable or flag; no S6–S10 work; no
commit, push, merge or deploy; no live provider and no paid inference.

## 7. Recommendation

See `EM-04C2-S5-POLICY-VALIDATION.md` §6 for the verdict and the evidence it rests on.

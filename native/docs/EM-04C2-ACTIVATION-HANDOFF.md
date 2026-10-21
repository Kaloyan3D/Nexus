# EM-04C2 — Activation handoff (from EM-04C1)

Starting point: EM-04C1 (uncommitted at `49026e8` + the C1 diff). Nothing here is implemented.
EM-04C2 must not start automatically; it needs the C1 review first. This document replaces
`EM-04C-ACTIVATION-HANDOFF.md` §3 items 1–2 (done) and keeps the rest.

## 1. What C1 delivered that C2 builds on

| C2 need | C1 state |
|---|---|
| Fast, supervised bridge (gate: latency) | persistent per-run worker; parity suites pass on both transports |
| Per-mode budget (gate 4) | `requestBudgetBytes` on the Registry **mode**, sealed in every issuance; C2 only has to *declare* it in the `muse-v1` mode file (suggested 428,722 B is the measured A614 maximum with the tool; use a value with headroom, e.g. 440,000, below the 450,000 guard) |
| Catalog identity (gate 5) | frozen digests; one selector `engine::tool_catalog_profile`; run record carries `toolCatalogDigest` |

## 2. What C2 must still do (from the original plan, unchanged)

1. Registry gate 1: add `muse-v1` to `parity.cjs` `KNOWN_ORCHESTRATION_ENGINES`, a shipped mode file
   naming it, models scoped to it. Replace `MUSE_V1_PRODUCTION_ENABLED` by presence of `muse-v1` in
   `built_in()` (update the EM-01 "reserved id" test deliberately).
2. A production engine `muse-v1` = `muse-v1-signals` with `may_propose_effort: true`, proposing
   `Change(e)` exactly when the shadow decision records `would = change:e` (EM-04C handoff §2).
3. Add its row to `tool_catalog_profile` and freeze the digest it uses (the signals catalog digest
   already exists; reuse it, do not mint a second one for the same bytes).
4. Slot policy (`allowedReasoning`) listing the Governor levels; default-only stays `low`.
5. E2E: every non-default attempt has durable selection → Registry issuance → Kernel seal **before**
   dispatch; default-only binding never escalates.
6. Live A/B only with a pre-approved paid budget.

Remember when wiring: a `Change(e)` must only be proposed when `e` differs from the effort in force
(otherwise every request would append an `effort-selected` event and a durable commit). The shadow's
`would` already has this property (it compares with the effort in force).

## 3. Anti-thrash review (Phase 4) — findings

Method: `engine/anti_thrash_review.rs` drives the real, unchanged Governor/Runtime/Activity modules
through the worker with ordinary and adversarial trajectories and asserts what they do. Tables are
printed by `cargo test -p nexus-broker --lib anti_thrash -- --nocapture`.

| # | Question | Result (measured) | Harmful oscillation prevented? |
|---|---|---|---|
| A1 | Model alternates `diagnose`/`implement` every request | effort `high medium high medium …`: **23 changes in 24 requests** | **No.** The Governor is a memoryless function of the state; there is no dwell or hysteresis. |
| A2 | Repeated identical proposals / re-evaluation / one dispatch key delivered 10× | identical output 20/20; one failure counted once (processed window); 6 distinct failures → `medium` then `xhigh` ×5 | Yes (idempotent) |
| A3 | Failure windows | 2 hypothesis failures → `xhigh`, **sticky for the rest of the task** (15 further requests, no decay) until a root cause is established (false→true edge), which resets the window at once; totals keep history | Not oscillation; **no time-decay** of escalation |
| A4 | Re-arming the progress edge (invalidate → establish) | 6 laps = **12 changes in 24 requests**; each lap costs the model two claimed failures + two signals; totals expose the claims | **No**, bounded only by what the model chooses to claim |
| A5 | Conflicting evidence | `xhigh` until resolved or a new root cause | sticky, not oscillating |
| A6 | Recovery-needed from Kernel evidence | failed check → `high` (recover); 6 fix/retry cycles in the same period stay `high` (historical parity O-1: the mutation milestone fires once per period, so an edit does not clear recovery); a **pass** or a semantic phase signal ends it; **1 change** across the loop | **Yes** — the operational path is anti-thrash by design |
| A7 | An ordinary scripted session (14 requests, phases + edits + checks) | 7 effort changes | acceptable but not small |
| A8 | Restart inheritance | open windows and the processed-signal window are inherited; `currentEffort` is not (continuation re-proposes from the default) | Yes |
| A9 | Slot policy | clamps **down only** (`xhigh→high→medium`); an unsatisfiable policy fails closed | Yes |
| A10 | `max` | refused on every spelling in the model-facing path (`signal-forbidden-field`) | Yes |

### 3.1 Conclusion

The historical policy prevents thrash from **trusted operational evidence** (A6) and is idempotent
(A2), but it does **not** prevent thrash driven by **model-reported semantic signals** (A1, A4):
a model can move the effort by one level every request, and can keep an escalation for as long as it
likes (A3). Consequences once adaptive effort is active:

* cost: every change is one Registry issuance (cached per effort within a task) plus two Kernel
  seals and one durable engine commit;
* provider side: unknown behaviour when `reasoning.effort` alternates across a conversation with
  replayed reasoning items (to be examined in the mock/E2E and the live A/B);
* spend: a model that over-reports failures or conflicts can sit at the top authorized level;
* **bounded**: never above the operator's slot policy; never `max`; never without a durable,
  Registry-issued, Kernel-sealed attempt.

This is a policy question, not a correctness or security hole. **A bounded policy is planned
for C2 (§3.2).** The Governor is not to be edited.

### 3.2 Direction for EM-04C2: a host-side Effort Transition Limiter (plan, not implemented)

Decided at the final C1 review. The historical Governor stays **unchanged**; the limiter is a
separate, deterministic, host-side component of the activating engine (`muse-v1`) that sits between
the Governor's decision (`would`) and the `EffortProposal`. It is a policy proposal that needs
deterministic validation before it is adopted.

**Rules**

1. **Upward is immediate.** A decision above the effort in force, and authorized, is proposed as
   `Change(e)` at once; any pending de-escalation is cleared.
2. **Downward is tentative.** A decision below the effort in force becomes *pending*; it is
   proposed only when a **second consecutive qualifying lower decision from a distinct model
   attempt** arrives. The proposed level is the *higher* of the two lower decisions (never lower than
   either), still strictly below the effort in force and authorized.
3. **New escalation evidence resets pending de-escalation.** Any decision at or above the effort in
   force, any new failure/conflict evidence folded since the last attempt, or a strong-escalation
   reason clears the pending decision (so "consecutive" really is consecutive).
4. **Identical proposals are no-ops.** `Change(e)` with `e == in force` is never emitted; the same
   attempt evaluated twice counts once (distinctness is by attempt ordinal); re-delivery cannot
   advance the counter.
5. **State is Engine state.** `{pending_target, pending_attempt}` lives in the engine payload under
   the existing authority (HMAC-authenticated EM-03 record, revisioned, ≤ 16 KiB, validated by
   `check_transition`, durable before the attempt it influences, cleared on continuation because the
   effort restarts at the default).
6. **Authorization is unchanged.** The limiter only *withholds* or *passes* what the Governor wants;
   it cannot add a level. Registry issuance (`issue-attempt` under the sealed binding), the
   `allowedReasoning` policy, the host's `Change` admission and the Kernel's sealing remain the
   authorities. Output ∈ authorized; never `max`; `requestMax` stays unavailable to the model.

**Predicted effect** (pure replay of the pinned review traces, Python model of rules 1–4, in-force
starting at `low`; not a test yet): A1 phase flapping **23 → 1** change (the lower decisions never
see a second consecutive confirmation); A7 ordinary session **8 → 4**; A3 sticky escalation
unchanged (3, by design: escalation is never delayed); A4 re-arm laps unchanged (7 vs 7). **A4 is
not solved by these rules**: a model that holds the post-reset lower decision for ≥ 2 attempts
still de-escalates and can re-escalate each lap. Bounding that needs an additional rule (a cooldown
or a per-task cap on escalations that follow a progress reset); it is an open decision for review,
and its cost is the one thing the model can still spend (an authorized `xhigh`).

**Cost of the rule:** each de-escalation is delayed by one attempt (≈ one request at the higher
effort). Escalation latency is zero.

**Deterministic validation required before adoption** (pure, no node, no network):
* table tests for each rule, including ties (two different lower decisions: the higher wins),
  distinct-attempt enforcement, reset-by-evidence, identical no-ops, unauthorized targets;
* property tests over random decision traces: every down-change is preceded by two consecutive
  lower decisions on distinct attempts; no up-change is ever delayed; `Change(e)` never equals the
  effort in force; output always ∈ authorized and ≠ `max`; changes ≤ escalations + attempts/2;
* replay of the A1–A7 traces from `anti_thrash_review.rs` through the limiter with pinned expected
  change counts;
* state tests: persisted payload validated by `check_transition` (forged pending state refused),
  crash before/after the durable commit, continuation clears pending, HMAC tamper;
* E2E on the mock provider: every non-default attempt still has a durable selection, a Registry
  issuance under the task binding and a Kernel seal before dispatch.

### 3.3 Decisions needed from review

1. Confirm the limiter direction above; decide whether to add the A4 re-arm bound (cooldown or escalation cap) and its parameters (they would live in the Registry mode, like the budget).
2. Keep `requestMax` unexposed (C1 keeps it so; recommended: yes).
3. Cost envelope per effort change is accepted as ≈ 190 ms first issuance + two seals?

## 4. Gates C2 must keep green (unchanged list, plus C1's)

`muse-v0` bodies byte-identical; EM-01 guards; EM-02 authorization; EM-03 recovery matrix and
fixtures; EM-04A/B parity and adversarial suites **on both bridge transports**; worker IPC suite;
catalog digests; Registry budget suites; fixture key refused in production; release build without
`test-engines`.

## 5. Review gates before adaptive production activation

EM-04C2 must not activate adaptive reasoning in production until each gate is reviewed and closed.

1. **Persistent worker trust boundary.** The worker is isolated at the IPC level only (frames in,
   validated frames out; empty environment; no inherited descriptors shared with the broker). It
   runs as the broker's user with the same filesystem, PID, mount and network access. Decide whether
   same-user access is acceptable for a worker that evaluates only the pinned historical modules, or
   whether OS-level confinement (seccomp/landlock, namespaces, a dedicated user, cgroup limits) is
   required. The one-shot bridge had the same exposure; C1 did not widen it and did not reduce it.
2. **Concurrency and memory.** At most 16 live workers per broker (`MAX_LIVE_WORKERS`), one per
   Governor-capable run, ≈ 135 MiB RSS each at plateau (worst case ≈ 2.1 GiB; none for `muse-v0`).
   Confirm the cap and the per-run cost for the intended deployment.
3. **Host-side anti-thrash policy.** Implement and validate the Effort Transition Limiter (§3.2).
   The **A4 repeated-escalation case is unresolved**: a model that holds the post-reset lower
   decision for two attempts and then re-escalates can still cycle effort each lap. Decide on a
   cooldown or per-task escalation cap, and its parameters.
4. **Explicit Registry authorization; no global activation flags.** Adaptive behavior only through a
   Registry mode naming `muse-v1`, a slot `allowedReasoning` policy and the sealed mode budget. No
   environment variable, CLI option or constant may switch it on.
5. **`requestMax` stays unavailable to the model.** The signals path must keep refusing it
   (`signal-forbidden-field`, pinned by the anti-thrash review test A10).
6. **Default `muse-v0` behavior is unchanged.** Request bodies, tool catalog (digest `58f513de…`),
   default `low` effort and the A614 maximum (449,944 B) stay byte-identical.

## 6. Follow-up: environment stability (not an EM-04C1 defect)

The final EM-04C1 battery reported 1,111 passed / **1 failed** / 55 ignored. The failure was
`rn2_a_coding_run_on_the_second_model_is_bound_to_it_and_its_connection_on_every_provider_call`,
which stopped at its precondition (`sandbox-unavailable: systemd scope was not created`) while the
full suite was running; it passed 3 / 3 when re-run alone. The battery is **not** recorded as clean.
Follow-up for a separate change: make the sandbox probe in `code_a56.rs` resilient or serialize
tests that create systemd scopes, and re-establish a fully green battery before C2 gates close.

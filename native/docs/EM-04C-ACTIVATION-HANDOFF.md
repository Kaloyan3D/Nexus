# EM-04C — Activation handoff: from shadow signals to Governor-controlled reasoning

Starting point: EM-04B. Under the test-only engine `muse-v1-signals`:
- the model reports validated reasoning signals;
- they are durable and replay-safe;
- the shadow Governor decides on them and on trusted receipts;
- nothing is applied.

This document fixes how EM-04C may activate adaptive reasoning. **Nothing here is implemented.**

## 1. Principle: activation is issued, never switched

There is no environment variable, configuration flag, CLI option or global constant that turns
the Governor on. A run becomes adaptive only when **all** of the following come from authorities
that already exist:

| # | Gate | Owner | Today |
|---|---|---|---|
| 1 | A Registry mode whose `orchestrationEngineId` is the active engine `muse-v1` | Registry (mode file, issued and sealed in the resolution) | no shipped mode names it. `parity.cjs` `KNOWN_ORCHESTRATION_ENGINES` (`dual-v1`, `muse-v0`) must be extended **deliberately** |
| 2 | The engine is compiled in and selectable | Native build | `MUSE_V1_PRODUCTION_ENABLED = false`. EM-04C replaces this constant with the plain presence of `muse-v1` in `built_in()`. Selection then stays gated by gate 1, and the test-only ids (`muse-v1-shadow`, `muse-v1-signals`) stay test-only. |
| 3 | The operator's slot policy lists the Governor levels | Registry slot `allowedReasoning` (EM-02) | absent means default only. Default-only bindings keep `low`, because the Governor fails closed on `[low]`. |
| 4 | The mode's request budget | Registry mode `requestBudgetBytes`, sealed in the resolution (EM-04A handoff §2.1) | broker-wide `request_budget_bytes = None`. EM-04C reads it from the sealed resolution only. |
| 5 | The mode's tool catalog | the sealed engine id → `ToolProfile::RepoCodeMuseSignalsV1` (or its active successor) | today keyed by `muse-v1-signals` in `inspect.rs` |

A run is adaptive only when every gate holds. Any other run keeps today's exact behaviour,
pinned by the 66-body comparison and the EM-01 request-shape guard.

## 2. The active engine `muse-v1`

- **Base:** `muse-v1-signals` with `may_propose_effort: true`. Its Registry id is the reserved
  `muse-v1` (the EM-01 test that asserts it unavailable is updated deliberately in the same
  change).
- **Proposal:** at `BeforeRequest` it proposes `Change(e)` exactly when the shadow decision
  records `would = change:e`, and `KeepPinned` otherwise. The decision, with its evidence and
  chain, becomes the proposal's justification.
- **Then EM-02/EM-03, unchanged:**
  1. the host admits only authorized levels;
  2. `effort-selected` is durable before authorization;
  3. the Registry `issue-attempt` runs under the task binding;
  4. the Kernel seals the attempt;
  5. write-ahead `bind_attempt` happens before dispatch.
- **Never:** a signal never changes effort directly (`consult_signal` refuses `Change`). An
  already-issued target is never altered. A continuation restarts at the default effort and
  re-proposes under its new binding.
- **Ladder:** the historical ladder is unchanged. The downward-only clamp runs against the
  binding's authorized levels; if nothing fits, `KeepPinned`.

## 3. Required before activation

1. **Bridge latency** (measured, release): Governor evaluation ≈ 174 ms; signal acceptance ≈ 81 ms.
   - Replace the per-evaluation process with a persistent, stateless, supervised worker with
     versioned contracts (EM-04B handoff §3.4).
   - Acceptance: the EM-04A and EM-04B parity and adversarial suites pass unchanged against it.
2. **Per-mode budget and catalog guards:**
   - a second frozen catalog digest for the Muse catalog (the `muse-v0` digest stays frozen);
   - the A614 guard re-baselined per mode (EM-04B evidence: 428,722 B with the tool).
3. **Registry declarations** (gates 1, 3, 4) and their Registry suites.
4. **Policy decisions still open:**
   - the anti-thrash re-stamp (EM-04A parity O-1);
   - whether model-facing `requestMax` stays unexposed (recommended: yes, as historically);
   - the cost envelope per effort change: one Registry issuance per new effort (≈ 190 ms the
     first time) and two Kernel seals.
5. **Live A/B** with a paid-inference budget approved in advance:
   - `muse-v0` (`low`) vs `muse-v1` (adaptive, authorized levels) on the same tasks;
   - compare completion, verified edits, attempts, tokens and cost;
   - only after 1–4.

## 4. Gates EM-04C must keep green

- `muse-v0` provider bodies byte-identical (the EM-04A/04B dump harness);
- EM-01 differential and request-shape guards;
- EM-02 authorization;
- EM-03 recovery matrix and the EM-03 record fixtures;
- EM-04A Governor parity (DSH == Native);
- EM-04B signals parity and adversarial suites;
- the published fixture key refused in production;
- release build without `test-engines`.

New in EM-04C:
- E2E proof that an adaptive run's every non-default attempt has a durable selection, a Registry
  issuance under the task binding and a Kernel seal **before** dispatch;
- proof that a default-only binding never escalates.

## 5. Checkpoint plan (decided at the EM-04B review)

EM-04C is split into two separately reviewed checkpoints. Neither starts automatically.

**EM-04C1: production preparation**
- A persistent, supervised, stateless Node bridge worker with versioned IPC (§3.1).
- The existing Governor (EM-04A) and Signals (EM-04B) differential parity suites, maintained and
  passing against the worker.
- A per-mode, Registry-sealed request budget (gate 4).
- Per-mode tool-catalog integrity and regression guards (§3.2).
- A review of the historical anti-thrash behaviour (EM-04A parity O-1).
- Model-facing `requestMax` stays unavailable.

**EM-04C2: adaptive activation**
- A production `muse-v1` engine, explicitly selected and authorized by the Registry (gates 1–3).
- Governor-proposed effort, bounded by the sealed slot policy.
- Durable effort events and per-attempt Kernel sealing (EM-02/03, unchanged).
- Strict default-only compatibility for existing `muse-v0` tasks.
- Mock E2E validation before any live provider testing. Live A/B only with an approved
  paid-inference budget.

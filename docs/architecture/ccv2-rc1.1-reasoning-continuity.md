# CCv2 RC1.1: Reasoning Continuity (architecture note)

Status: implemented on `fix/ccv2-reasoning-continuity-rc1.1` (base: RC1
`4ce0cc8`). The frozen contract is §55 of `context-compaction-v2.md`; this
note records the evidence and the reasoning behind it.

## 1. Root cause

RC1 activated the OpenCode Muse compiled projection on every root request
that had a sealed checkpoint, i.e. from turn 2 onwards, whatever the size of
the native request. A compiled request must be counted exactly by the Meta
counter (`REMOTE_MUSE_PRECOUNT`), and Meta cannot count OpenCode-issued
encrypted reasoning (§53.1: it is bound to the issuing caller). RC1 therefore
sent `reasoningReplay: none`, which removes the reasoning items of **every
earlier step of the open turn**.

The controlled replay (research branch, `4c24106`) isolates this. Arms use the
same captured request; arm C differs from arm B only by the removed reasoning
items (structural equality asserted):

| Checkpoint | B (reasoning kept) | C (reasoning removed) |
| --- | --- | --- |
| T2 / step 5 (early) | inspect 5/5 | inspect 5/5 |
| T2 / step 9 (mature plan) | **implement 5/5** | **inspect 5/5** |
| T2 / step 14 (implementing) | implement 5/5, reasoning 0 | implement, re-reasoning |

Session-log facts behind the mechanism (content-free):

- In the open turn every assistant message is `reasoning + tool-call`; there
  is no visible assistant text. The plan exists only in reasoning.
- The two planning steps before step 9 (4 and 8) produced 5,564 and 6,243
  output tokens, nearly all reasoning.
- Step 8 also wrote a todo plan. Arm C could still see it, as code inside the
  step-8 `run_code` call, and still re-inspected.

Context size was never the problem. The frozen Legacy run peaked at 505,050
provider input tokens (48% of the 1,048,576 window) with zero DSH compaction
events; RC1's turn-2 compiled requests were about 77k.

## 2. Why RC1 failed

1. **Activation without need.** "CCv2 is available" was the activation
   condition; nothing compared the native request with the window.
2. **On this route a compiled request cannot carry in-turn reasoning.** Exact
   count/send equality (RC1 invariant 7) plus the Meta caller binding means the
   reasoning of earlier steps is removed from every compiled request. This is
   a hard constraint of the counting contract, not a bug.
3. **Nothing compensated.** The compiled request did not even say what it
   omitted.

## 3. The Layer B experiment (falsified design, kept as evidence)

The first Layer B design was a deterministic ContinuationState capsule:
explicit recorded state appended to the system slot of every compiled request
that removed in-turn reasoning. It contained a fixed disclosure that
earlier-step reasoning is not included, the latest `todo/write` plan verbatim,
and the files written or edited in the turn. It was derived from the durable
log through the last committed step, SafePoint V2-classified, bounded,
redacted and cache-stable. It never read reasoning. The full implementation
and its suites are preserved on `research/rc1.1-capsule-attempt`.

Arm D = arm C + that capsule, produced by the production module from each
capture's own durable session log, with D minus the capsule asserted equal to C
(`research/rc1.1-continuity-arm-d`, `scripts/research/ContinuityArmD.cjs`).
Live, OpenCode Go / muse-spark-1.3-contributor, effort medium, 5 repetitions
per arm, interleaved B,C,D:

| Checkpoint | B | C | D (C + capsule) |
| --- | --- | --- | --- |
| step 9 (mature plan) | implement 5/5, reasoning median 48 | implement 0/5 (1 transport timeout), median 5,218 | **implement 0/5** (4 inspect, 1 re-plan), median 1,736 |
| step 14 (implementing) | implement 5/5, reasoning 0 | implement 4/5, reasoning 0 | implement 3/5, median 1,409 |
| step 5 (early) | inspect 5/5, median 550 | inspect 5/5, median 223 | inspect 5/5, median 1,327 |

Explicit recorded state does not restore a plan that lived only in the
provider's reasoning, and the capsule increased re-reasoning at steps 5 and 14.
Conclusion: on a route whose compiled requests must drop in-turn reasoning, no
deterministic, non-reasoning handoff restores continuity. Compiled mode and
in-turn continuity are mutually exclusive there. Shipping the capsule would
have cost a request-shape change and re-certification, for no benefit.

## 4. RC1.1 architecture

One authority, `ContextCompilerActiveOpencodeHostV2`, owns the LEGACY vs
CCV2_COMPILED decision. A single pure gate, `ContextActivationPressureV2`, is
evaluated in `applyOpencodeProjectionV2` right after the request-shape checks.
It runs before any health, credential, file, counter or compiler work.

```
llm/stream (owned session, certified pair, root purpose)
  └─ decideActivationV2(policy, route capability, durable usage, request)
       NATIVE   -> next(): the original request, native reasoning replay
       ACTIVATE -> unchanged RC1 staging + compile (or RC1 typed fallback)
```

### 4.1 Signal (authoritative)

Only the provider measures the native request: Meta refuses OpenCode-issued
reasoning, and OpenCode has no count endpoint (§48.7). On TASK-0044 the
replayed reasoning alone was ~180k provider tokens that no other authority
could see. The gate uses the provider-reported DSH `TokenUsage` recorded
durably on every `assistant/message`, the same sum DSH's meter uses:

```
sample(e)      = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens
anchor         = latest assistant/message with valid usage (current surface epoch)
deltaBound     = Σ over request messages after the anchor: utf8Bytes(JSON(content)) + 32
pressureTokens = sample(anchor) + deltaBound
latchTokens    = max sample over the current surface epoch
```

`deltaBound` is deterministic and conservative under a byte-level-tokenizer
assumption: every token covers at least one byte, and JSON structure plus 32
tokens cover framing. The Muse tokenizer is not public, so this is verified
empirically (§4.5), not proven.

### 4.2 Threshold: the continuity-aware basis

The basis is chosen by the route's wire `reasoningReplay` capability, i.e.
whether a compiled request can carry the open turn's reasoning.

| Term | Value | Source |
| --- | --- | --- |
| window | 1,048,576 | route capability (= `COUNT_WINDOW_V1`) |
| DSH compaction | 838,860 | `floor(window × 0.8)`; 0.8 is the pinned `dsh-compaction-basic` 0.1.1-rc.2 default, which the aih-muse base preset does not override (tested) |
| max output | 131,072 | route capability |
| step growth reserve | 65,536 | Legacy evidence: per-step tool growth p99 3,617 / max 11,792; largest tool result 52,444 bytes |
| margin | RC1 policy | `max(8192, ceil(1%))` |

- **`reasoningReplay: native`, basis `before-dsh-compaction`:**
  838,860 − 131,072 − 65,536 − 8,389 = **633,863**. Compiled requests lose
  nothing, so CCv2 takes over one full step before DSH's lossy summary would.
- **`reasoningReplay: none`, basis `native-unsendable`:**
  1,048,576 − 131,072 − 10,486 = **907,018**. This is the certified OpenCode
  Muse route. A compiled request would drop the open turn's reasoning (§3), so
  continuity is never traded for compaction while the native request can still
  be sent. DSH compaction at 838,860, which keeps the open turn native, stays
  the pressure relief. CCv2 compiles only when the native request itself would
  no longer fit the window, as an overflow safety net.

### 4.3 Decision (closed world)

| Condition (in order) | Decision | Reason |
| --- | --- | --- |
| policy value unknown | NATIVE | `activation-policy-invalid` |
| policy `always` (canaries) | ACTIVATE | `activation-forced-by-policy` |
| route capability invalid | NATIVE | `activation-policy-invalid` |
| `pressureTokens ≥ activationTokens` | ACTIVATE | `pressure-at-or-above-threshold` |
| `latchTokens ≥ activationTokens` | ACTIVATE | `pressure-latched` |
| no session / no sample / anchor not in request | NATIVE | `pressure-unmeasured` (+ detail) |
| otherwise | NATIVE | `pressure-below-threshold` |

NATIVE is a policy outcome, not a failure. The decision line shows
`projectionMode LEGACY`, `fallbackReason null`, `activationDecision`,
`activationReason`, `activationBasis`, `activationTokens`, `pressureTokens`,
the anchor, delta and latch tokens, and the sample count. It carries no
content. ACTIVATE continues into the unchanged RC1 pipeline, so every RC1
fallback stays typed.

### 4.4 Hysteresis, restart, fail-closed

- **Hysteresis:** native context never shrinks inside a DSH surface epoch, so
  the gate is a monotone latch: once a durable sample reaches the threshold,
  the session stays activated until a surface replacement. Compiled usage,
  which is smaller than native, cannot release it, so there is no thrash.
- **Restart:** the latch and the pressure are pure functions of the durable
  log, so restoring the log reproduces the identical decision (tested).
- **Fail-closed:** anything unmeasurable or invalid is NATIVE, the request RC1
  sends on every fallback. The gate never reads model output, a heuristic
  score or a timer.

### 4.5 Evidence (offline replay of recorded sessions)

`scripts/CCv2-ActivationReplay.cjs` rebuilds every request of a recorded
session, evaluates the gate exactly as the seam does, and compares the
pressure bound with the provider prompt of the same request:

| Session | Requests | ACTIVATE | Bound covered provider prompt |
| --- | --- | --- | --- |
| Frozen Legacy OpenRank (peak 505,050) | 451 | 0 | 450/450 (min slack +189) |
| Reasoning-capture run (B/C source) | 102 | 0 | 101/101 |
| 8 recorded RC1 OpenRank CCv2 sessions | 699 | 0 | 688/690 |

The two shortfalls (19,488 and 2,069 tokens) are RC1 mixed-mode requests. The
controller log shows each anchor step was `CCV2_COMPILED`, i.e. compiled-size
usage, followed by an RC1 LEGACY fallback carrying native reasoning. RC1.1
compiles only once latched, and a latched decision never depends on the
anchor bound.

## 5. Certification

When compiled requests are sent, they are the unchanged RC1 v3 shape
(`opencode-muse-request-shape-v3-native-tail-no-replay`), so the existing
suite-v2 certification stays the authority. The OC01 canaries pin
`activation: 'always'`: canary contexts are tiny and would never activate.
The canary therefore keeps exercising the RC1 compiled mechanics it certifies.

## 6. Invariants (RC1.1)

RC1 invariants 1–10 hold unchanged. In addition:

11. A compiled request is sent only when the gate returned ACTIVATE.
12. The gate reads only durable provider usage, the live request, the route
    capability and the activation policy.
13. The activation latch is monotone within a DSH surface epoch.
14. On a route whose compiled requests cannot carry in-turn reasoning, the
    gate activates only when the native request cannot be sent.
15. One decision line per root request; never content.

## 7. Known limitations

- On OpenCode Muse, CCv2's compiled projection is only an overflow safety net.
  Long sessions are relieved by DSH compaction, which is lossy for older
  history: a summary plus the most recent ~16% retained natively. After the
  first DSH compaction the M01 producer blocks on the surface replacement, so
  that session continues as Legacy. Making compiled mode continuity-safe on
  this route needs a counting authority for OpenCode-issued reasoning (the
  issuing caller), which does not exist today.
- DSH compaction can summarize part of an open turn longer than its retained
  region (~168k tokens). That is existing Legacy behavior, not introduced here.
- When the safety net does fire, in-turn reasoning is lost from then on. That is
  the RC1 compiled behavior, now confined to imminent overflow.
- The step growth reserve and the byte bound are evidence-based, not proven:
  DSH does not cap `run_code` output unless the spill policy is configured.
- SafePoint V2 and the producer share a 100,000-event input bound; neither is
  changed here.
- Arm D used effort `medium` and one task; its conclusion concerns
  deterministic, non-reasoning handoffs, not every conceivable mechanism.
  Provider reasoning summaries in a handoff were not tested: they are reasoning
  content, which A03/B01 exclude.

## 8. Acceptance tests

- **Layer A unit suite** (`ContextActivationPressureV2`): both bases, the DSH
  pin, policy resolution, the usage closed world, below / exact / above,
  the band between bases, latch transitions, restart, epoch reset, every
  NATIVE path, determinism and telemetry.
- **Host seam** (`ContextCompilerActiveOpencodeHostV2`): zero work when NATIVE,
  threshold, band, safety-net compiled shape, latch, restart, quarantine,
  counter outage, other routes, policies, secrecy and certification identity.
- **OCH-8, real DSH loop:** verbatim loop requests with native reasoning
  replay on the wire and zero counter calls.
- **RC1 suites unchanged:** compile mechanics run under `always`.
- **Producer:** `liveSessionFor`.

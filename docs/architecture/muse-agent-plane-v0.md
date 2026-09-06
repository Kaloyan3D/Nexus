# Muse Agent Plane V0 (Muse Spark 1.3 Contributor)

Status: Phase M3 — first real Muse execution plane. The Muse profile remains LOCKED (`selectable = false`, `runnable = false`, `availability = contributor-gated`); see [Activation policy](#activation-policy).

Task reference: TASK-0040.

## What V0 is

Muse V0 is a REAL third engine inside the user-facing Normal Engineering mode: exactly ONE main engineering agent running `muse-spark-1.3-contributor` (provider `meta-model-api`, reasoning `xhigh`), pinned to the same deterministic Nexus control plane as the Dual engine. It is not a Dual profile, not a persona text, and not a routing alias: `engine: muse` is a distinct production execution path with its own agent preset (`aih-muse`), its own request boundary (`config/Muse-Isolation.cjs`), and its own routing branch.

## The engine dispatch seam (one authority)

Exactly one place branches on the resolved engine: `Invoke-AihRoutingDecision` in `scripts/Routing.ps1`, immediately after the agent preset resolves.

```text
Route.ps1 -> Invoke-AihRoutingDecision
    |-- preset == 'aih-muse'      -> Invoke-AihMuseRoutingDecision  (Muse V0 plane)
    |-- preset in {dual presets}  -> existing Dual path (byte-identical)
    `-- muse profile on dual preset -> FAIL CLOSED (muse-engine/preset coupling)
```

- The Muse branch never resolves Dual roles. There are no `primaryEngineer` / `deepEngineer` / `reviewer` / `solver` / `fallback` semantics, no step-routing epistemic roles, and no manual class/tier overrides on the muse plane. Execution classes keep their engine-independent meaning (`engineer_normal`, `deterministic`); the routing record carries `role: null`.
- A Dual preset with an active `engine: muse` Nexus profile can never execute: the Dual agent plane still carries Dual delegation tooling, so that combination is rejected with `Muse routing rejected: ... selects the muse engine but the session runs the '<preset>' agent plane`.
- A missing/invalid catalog on the Dual side keeps the exact pre-M3 behavior (additive-only guarantee).
- The Muse branch shares ONE controller plane with Dual: the same task-identity guard (`taskInstanceId` generation check), the same routing mutex, the same state/ledger persistence (`decisions.jsonl`, per-task routing state), and the same completion authority.

## Target authority (one chain, no fallback)

The controller resolves the Muse target exactly once, deterministically, through the same chained authorities the M2 transport established:

```text
Nexus Profile (engine: muse)
  -> Muse profile        (config/muse-profiles.json: model.primary, reasoning)
    -> Model Registry    (config/model-registry.json: agentEngines must contain 'muse')
      -> Provider route  (settings.yaml llm-pi-ai.providers.<route>)
```

`Resolve-AihMuseRoutingTarget` (scripts/Routing.ps1) is the only Muse model-identity resolver. Every incomplete or unavailable input fails closed with a stable reason:

- active profile unresolvable, not a muse profile, or not runnable;
- `contributorProtection.required` set without the operator acknowledgement (see below);
- registry entry missing, disabled, or not scoped to the muse engine;
- profile reasoning default/escalation not in the model's `supportedReasoningLevels`;
- provider route absent from the live settings document.

The DSH request boundary (`config/Muse-Isolation.cjs`) only ENFORCES the controller-produced target — it never re-resolves it. There is no fallback provider, model, or reasoning level, at routing time, at request time, or after failures.

## Tool surface: no Muse subagents in V0 (release blocker)

The `aih-muse` agent preset is built from the same pinned DSH Code Mode preset as `aih-engineering` with exactly two structural transforms:

1. the Muse-native persona (see [Persona](#persona));
2. the ENTIRE delegation/workflow section replaced with NOTHING.

Every Dual delegation row (`tool-subagent-control`, `list-agents`, `tool-subagent`, `tool-subagent-fork`, `workflow-worker-thread`, `tool-workflow`, `tool-ralph`) is structurally ABSENT from the composed preset — absence is the deterministic guarantee; disabled rows would still carry the surface. `tests/SetupUpgrade.Tests.ps1` scans the built artifact for these rows and fails if any appears. The Muse boundary (`Muse-Isolation.cjs`) additionally has NO worker exemption (unlike the Dual isolation), so even a host-level anomaly that shaped a request like a worker is still pinned to the controller muse target.

Muse never invokes Codex as reviewer, fallback, repair agent, or worker. Visual Review is untouched: it remains a controller-owned orthogonal capability invoked explicitly by the user, exactly as on the Dual plane.

## Review isolation

`muse-profiles.json` sets `review.independent = false` and the routing plane enforces it:

- `-ReviewRequested` on the muse branch fails closed (`Muse routing rejected: independent review is not available for the Muse engine`).
- Immediate review signals (e.g. `critical-security-boundary`) and `user-codex` fail closed at routing; `/review` in a muse session returns a truthful controller rejection (`muse-review-unavailable`) and starts no model call.
- `review-findings` cannot return to a muse task (no Muse reviewer exists).
- Same-failure escalation NEVER routes to a reviewer on the muse plane.
- Risk-classified `reviewRequired` initial decisions are rejected before any model call (route through a Dual profile for independent review).

## Bounded retry, bounded output, bounded loops

- **Retry**: the controller may retry the same single Muse main agent. At the configured same-failure threshold the reason records the bounded-retry truth (`the Muse engine retries the same single main agent (no escalation, no provider/model change)`). Unresolved failures terminate truthfully; there is no engine/provider/model switch and no infinite loop. The finite loop bound is the pre-existing Dual one, reused: each turn ends on a terminal finish (completed / max-tokens / error / abort), the task ledger caps attempts (`maxAttempts = 3`), and controller retries are bounded by the same failure signature tracking.
- **Output bound**: `Muse-Isolation.cjs` caps every root request at `MUSE_V0_MAX_OUTPUT_TOKENS = 32768` completion tokens — the Nexus V0 effective maximum, deterministic and engine-owned. The vendor hard maximum for `muse-spark-1.3-contributor` (131072 completion tokens, configured in the managed settings route) is a separate, larger number and is NOT the Nexus budget. The bound is a ceiling: a smaller explicitly requested bound passes through; an absent one gets the 32768 default.
- **Reasoning bound**: `xhigh` is the profile default AND the escalation ceiling in V0; the ceiling itself is validated against the registry at resolution time, so an unsupported ceiling fails closed before any execution.

## Contributor safety (M3 truth)

The Contributor checkpoint's terms permit Meta to train on prompts and completions. `muse-profiles.json` carries `contributorProtection.required: true` and the model registry carries `dataUseTier: contributor`; both survive end to end into the routing record (`dataUseTier`, `contributorProtectionRequired`) and the request boundary's target.

Outbound contributor protection (sanitization of repo content before it leaves the machine) is Phase M5 and is NOT implemented in M3. The runtime therefore consumes the metadata and enforces an activation gate instead of claiming protection exists:

```yaml
# operator-owned, versioned acknowledgement in data/settings.yaml
muse-contributor-execution:
  acknowledgement: accepted-v1
```

This is the minimal explicit operator-consent mechanism: Nexus never writes the key, the shipped template never contains it, a stale version (`accepted-v0`) fails closed, and the acknowledgement is checked on EVERY muse routing decision. Without it the plane is unreachable even with every other gate satisfied.

## Activation policy

The M3 activation decision: **the Muse profile stays LOCKED.** `selectable = false`, `runnable = false`, `availability = contributor-gated` in `config/nexus-profiles.json`; `status: contributor-gated` in `muse-profiles.json`. The remaining gate is exact and named: Phase M5 outbound contributor protection (`contributorProtection.required` unsatisfiable in M3). Unlocking requires (1) the M5 protection implementation, (2) the operator acknowledgement above, and (3) the catalog flags flipped — never a weakening of the `required` flag. The routing plane and the request boundary both enforce the locked flags fail-closed today (`8.4` in the routing suite proves the production install rejects execution).

## Persona

The muse persona is a minimal Muse-native engineering identity — deliberately NOT the DeepSeek implementation agent. It is injected two ways, mirroring the Dual pattern: the installer default inline in `scripts/Complete-Install.ps1`, and the runtime override `AIH_PERSONA_MUSE` set by `scripts/aih.ps1`. It states the bounded-task contract, repo-local instructions, targeted verification, evidence return, and that the deterministic controller owns routing/attempts/verification/completion — and that the agent is single: no subagents, reviewers, or fallback engineers exist on this plane. It carries no routing policy and no completion authority.

## Session preset lifecycle (UI)

The mode selector remains the single owner of the new-session preset lifecycle and the ONLY place an engine maps to an agent plane on the client:

- `@nexus/controller` publishes the shared `nexusEngineState` cordis service: the preferred profile's engine plus the catalog's internal engine-to-agent-preset map (derived from the same authoritative GET document the profile seat renders; malformed bindings publish no mapping).
- `@nexus/mode-selector` maps the user-facing Normal Engineering mode onto `aih-muse` for every NEW (blank) session when the preferred profile selects `engine: muse`, and falls back to the unmodified mode id whenever the mapping is not provably available (service absent, snapshot null, malformed id, host without the preset). Dual preferences map to the mode id itself — pre-M3 behavior, byte-compatible.
- The persisted default and the visible mode stay `aih-engineering`; only the blank session's agent plane is engine-mapped. Non-blank sessions are never reconfigured underneath their history (the profile seat says the engine applies from the next session).
- An API-created session that carries the muse plane without a controller binding fails closed at the request boundary (`nexus-execution-target-unavailable`) — visible, never silently wrong tools.

## Telemetry

Every muse routing decision persists a version-4 record with the full identity: `preset: aih-muse`, `engine: muse`, `profile`, `provider`, `model`, `modelDisplayName`, `vendor`, `reasoning`, `dataUseTier`, `contributorProtectionRequired`, task/instance id, execution class, signal, failure signature, and same-failure count — in `data/routing/decisions.jsonl` plus the per-task state file the request boundary reads. Attempts continue through the existing TaskController ledger (execution class `engineer_normal`, engine-independent), and the controller emits engine-aware attempt telemetry (`engine=muse`). Dual records carry none of the muse-only fields.

## Verification

- `scripts/Test-Harness.ps1` suites `MuseAgentPlane` (routing: dispatch seam, target exactness, fail-closed chains, consent gate, review isolation, bounded retry, identity parity, single-seam structural check, dual byte-compat), `MuseIsolation` (request boundary: engine invariant, no-fallback, output bound, no worker exemption, shellEnv), `NexusEngineContract` (client engine mapping), `SetupUpgrade` (aih-muse build contract + built-artifact delegation scan), `NexusProfiles` (catalog agentPreset validation), plus all pre-existing Dual suites as regression.
- Live acceptance (when `MODEL_API_KEY` is available): provider probe with `NEXUS_META_LIVE_TEST=1`, then one bounded real M3 execution proving telemetry identity, the tool surface, a real tool call, and controller-owned verification/completion.

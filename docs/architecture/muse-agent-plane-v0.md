# Muse Agent Plane V0 (Muse Spark 1.3 Contributor)

Status: Muse execution plane ready. The profile is `selectable = true`, `runnable = true`, and `availability = ready`; see [Activation policy](#activation-policy).

Task reference: TASK-0040.

## What V0 is

Muse V0 is a distinct engine inside the user-facing Normal Engineering mode: exactly ONE main engineering agent running `muse-spark-1.3-contributor`, pinned to the same deterministic Nexus control infrastructure as the Dual engine. It is not a Dual profile, persona text, or routing alias: `engine: muse` is a production execution path with its own agent preset (`aih-muse`), request boundary (`config/Muse-Isolation.cjs`), and routing semantics.

The engine is a session/task identity property, not a routing outcome. It is selected once for a new session, persisted as `binding.engine` and task `boundEngine`, and is authoritative for that task generation. Routing may choose behavior inside an engine. Routing may never choose another engine. A preference change applies only to a new session; any requested/resolved engine mismatch on an existing binding fails closed with `engine-binding-violation` before model resolution or execution.

## The engine dispatch seam (one authority)

Exactly one place dispatches to engine-owned routing: `Invoke-AihRoutingDecision` in `scripts/Routing.ps1`, after validating the requested preset engine against the authoritative task binding.

```text
Route.ps1 -> Invoke-AihRoutingDecision
    |-- requested/resolved engine != task boundEngine -> FAIL CLOSED
    |-- boundEngine == 'muse' -> Invoke-AihMuseRoutingDecision
    `-- boundEngine == 'dual' -> Dual classifier and Dual role routing
```

- The Muse branch never invokes `Get-AihRoutingInitialDecision` and never resolves Dual roles. There are no `primaryEngineer` / `deepEngineer` / `reviewer` / `solver` / `fallback` semantics, no step-routing epistemic roles, and no manual class/tier overrides on the Muse plane. Muse records use the Muse-owned `muse_main` execution marker and carry `role: null`.
- Muse-native signal classification records neutral risk metadata. Authentication, authorization, security-boundary, migration, and concurrency work remains on `muse_main` without selecting a Dual role. The `risk` field is metadata-only in V0: no code path wires it into the Muse Reasoning Governor (`config/Muse-ReasoningGovernor.cjs` takes no risk input), verification policy, retry, or evidence requirements.
- A Dual preset with an active `engine: muse` Nexus profile can never execute: the Dual agent plane still carries Dual delegation tooling, so that combination is rejected with `Muse routing rejected: ... selects the muse engine but the session runs the '<preset>' agent plane`.
- A missing/invalid catalog on the Dual side keeps its existing classification and role behavior; Dual records now explicitly persist `engine: dual`.
- The Muse branch shares controller infrastructure with Dual: task identity, ledger, routing mutex, attempt lifecycle, state persistence, telemetry, and completion authority. It does not share decision semantics.

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
- Muse risk signals (for example `critical-security-boundary`) remain on the Muse main-agent plane as `risk: critical` record/state metadata; they do not change the target, effort, or verification behavior. The explicit `user-codex` signal and `/review` fail closed truthfully and start no model call.
- `review-findings` cannot return to a muse task (no Muse reviewer exists).
- Same-failure escalation NEVER routes to a reviewer on the muse plane.
- Dual `reviewRequired` classifications are never evaluated on the Muse branch.

## Bounded retry, bounded output, bounded loops

- **Retry**: the controller may retry the same single Muse main agent. At the configured same-failure threshold the reason records the bounded-retry truth (`the Muse engine retries the same single main agent (no escalation, no provider/model change)`). Unresolved failures terminate truthfully; there is no engine/provider/model switch and no infinite loop. The finite loop bound is the pre-existing Dual one, reused: each turn ends on a terminal finish (completed / max-tokens / error / abort), the task ledger caps attempts (`maxAttempts = 3`), and controller retries are bounded by the same failure signature tracking.
- **Output bound**: `Muse-Isolation.cjs` caps every root request at `MUSE_V0_MAX_OUTPUT_TOKENS = 32768` completion tokens — the Nexus V0 effective maximum, deterministic and engine-owned. The vendor hard maximum for `muse-spark-1.3-contributor` (131072 completion tokens, configured in the managed settings route) is a separate, larger number and is NOT the Nexus budget. The bound is a ceiling: a smaller explicitly requested bound passes through; an absent one gets the 32768 default.
- **Reasoning bound**: `xhigh` is the profile default AND the escalation ceiling in V0; the ceiling itself is validated against the registry at resolution time, so an unsupported ceiling fails closed before any execution.

## Contributor data-use terms

The Contributor checkpoint's terms permit Meta to train on prompts and completions. The model registry retains `dataUseTier: contributor`, and that provider metadata survives into Muse routing records. Muse does not inspect, redact, reject, or transform conversation or tool-output payloads at egress; NUL, binary-like, and base64-like text therefore follows the normal provider transport path unchanged.

## Activation policy

`config/nexus-profiles.json` declares `selectable = true`, `runnable = true`, `availability = ready`; `muse-profiles.json` declares `status: ready`. Execution still requires a valid controller binding and complete Muse target. Invalid engine identity, missing routing state, unsupported reasoning, or a missing provider route continues to reject the request with no provider/model/engine fallback.

## Persona

The muse persona is a minimal Muse-native engineering identity — deliberately NOT the DeepSeek implementation agent. It is injected two ways, mirroring the Dual pattern: the transactional preset builder in `scripts/Install-MusePreset.ps1`, and the runtime override `AIH_PERSONA_MUSE` set by `scripts/aih.ps1`. It states the bounded-task contract, repo-local instructions, targeted verification, evidence return, and that the deterministic controller owns routing/attempts/verification/completion — and that the agent is single: no subagents, reviewers, or fallback engineers exist on this plane. It carries no routing policy and no completion authority.

## Session preset lifecycle (UI)

The mode selector remains the single owner of the new-session preset lifecycle and the ONLY place an engine maps to an agent plane on the client:

- `@nexus/controller` publishes the shared `nexusEngineState` cordis service: the preferred profile's engine plus the catalog's internal engine-to-agent-preset map (derived from the same authoritative GET document the profile seat renders; malformed bindings publish no mapping).
- `@nexus/mode-selector` maps the user-facing Normal Engineering mode onto `aih-muse` for every NEW (blank) session when the preferred profile selects `engine: muse`, and falls back to the unmodified mode id whenever the mapping is not provably available (service absent, snapshot null, malformed id, host without the preset). Dual preferences map to the mode id itself — pre-M3 behavior, byte-compatible.
- The persisted default and the visible mode stay `aih-engineering`; only the blank session's agent plane is engine-mapped. Non-blank sessions are never reconfigured underneath their history (the profile seat says the engine applies from the next session).
- An API-created session that carries the muse plane without a controller binding fails closed at the request boundary (`nexus-execution-target-unavailable`) — visible, never silently wrong tools.

## Telemetry

Every Muse routing decision persists a version-4 record with the full identity: `preset: aih-muse`, `engine: muse`, `executionClass: muse_main`, `role: null`, target identity, task/instance id, neutral risk signal, failure signature, and same-failure count. The task ledger and run manifest persist `boundEngine: muse`. Dual tasks, routing state, and decision records likewise persist `boundEngine/engine: dual`, while retaining their existing execution-class and role behavior. Cross-engine mismatches produce `engine-binding-violation` and no decision/model target is executed.

## Verification

- `scripts/Test-Harness.ps1` suites `MuseAgentPlane` (routing: dispatch seam, target exactness, fail-closed chains, review isolation, bounded retry, identity parity, single-seam structural check, dual byte-compat), `MuseIsolation` (request boundary: engine invariant, no-fallback, output bound, no worker exemption, Git/tool-output pass-through, shellEnv), `MuseEgressCleanup` (retired adapter-hook removal), `NexusEngineContract` (client engine mapping), `SetupUpgrade` (aih-muse build contract + built-artifact delegation scan), `NexusProfiles` (catalog agentPreset validation), plus all pre-existing Dual suites as regression.
- Live acceptance (when `MODEL_API_KEY` is available): provider probe with `NEXUS_META_LIVE_TEST=1`, then one bounded real M3 execution proving telemetry identity, the tool surface, a real tool call, and controller-owned verification/completion.

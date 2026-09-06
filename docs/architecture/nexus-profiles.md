# Nexus profiles and agent engines

Status: Phase M3 — profile/engine foundation with the first Muse agent plane.

## Decision

`Engineering` remains the user-facing Nexus mode. A **Profile** selects the agent architecture used inside that mode. The selected profile resolves to an internal **agent engine**.

```text
Engineering Mode
      |
      v
Nexus Profile
      |
      +-- GLM + Codex --------> Dual engine
      +-- DeepSeek + Codex ---> Dual engine
      `-- Muse Spark 1.3 -----> Muse engine
```

This deliberately separates three concepts:

- **Mode** — what Nexus is doing (`Engineering`).
- **Profile** — the operator-facing engineering configuration (`GLM + Codex`, `Muse Spark 1.3`, ...).
- **Engine / agent plane** — the internal orchestration philosophy (`dual`, `muse`).

A model id is not an engine and an engine is not an execution class.

## One control plane, multiple agent planes

All engines continue to use the same deterministic Nexus control plane for task identity, requirements, evidence, attempts, verification, failures, telemetry, gates, and completion.

```text
                         NEXUS CONTROL PLANE
        task / requirements / evidence / verification / completion
                                  |
                    +-------------+-------------+
                    |                           |
                    v                           v
               DUAL ENGINE                  MUSE ENGINE
            role-based existing          Muse-native policy
               orchestration               (later phases)
```

The controller remains authoritative. An agent engine may decide how model work is coordinated; it never gains authority to invent verification or completion truth.

## Dual engine compatibility

The existing `config/engineering-profiles.json` and `config/Engineering-Profiles.cjs` remain the authoritative configuration/resolution layer for the Dual engine. Their role contract is unchanged:

```text
primaryEngineer
 deepEngineer
 reviewer
 solver
 fallback
```

Phase M1 must not change the runtime behavior of `deepseek-codex`, `glm-codex`, or operator `custom` profiles.

## Muse engine isolation

Muse does **not** implement the Dual role schema. Its engine-specific configuration lives in `config/muse-profiles.json` and is resolved only when a top-level Nexus profile selects `engine: muse`.

Muse-specific concepts such as same-model specialists, context compaction, reasoning escalation, and Contributor protection are introduced inside the Muse agent plane in later phases. They must not alter Dual routing semantics.

## Top-level catalog

`config/nexus-profiles.json` is the user-facing profile catalog. Each entry declares:

- stable profile id;
- display name;
- engine (`dual` or `muse`);
- engine-specific source registry and profile id;
- whether the profile is currently selectable/runnable.

The catalog's `engines` map MAY bind each engine to the INTERNAL agent preset that runs its agent plane (`engines.muse.agentPreset: "aih-muse"`). The binding is optional internal infrastructure — never a user-facing mode — and the id is validated against the pinned DSH agent-preset grammar in both resolvers (`config/Nexus-Profiles.cjs` and the UI mirror `ui/nexus-controller/lib/engineering.cjs`); a present but malformed binding fails closed.

`config/Nexus-Profiles.cjs` validates and resolves this catalog. Dual entries delegate their actual role configuration to the existing Engineering Profile resolver; Muse entries delegate to `muse-profiles.json`.

The operator-defined `custom` Engineering Profile is dynamically exposed as a `dual` Nexus profile rather than copied into the immutable catalog.

## Active-profile precedence

The top-level resolver preserves the existing profile selection precedence:

1. `DSH_AIH_PROFILE`
2. `AIH_ACTIVE_PROFILE`
3. `engineering-profile:` in `data/settings.yaml`
4. preset profile binding
5. routing-policy `defaultProfile`

A preset with `profileOverrideAllowed: false` remains locked. Unknown profile ids fail closed; they never silently select a different engine.

## Phase M1 safety gate (updated by M3)

Muse Spark 1.3 entered the catalog in M1 as architecture metadata only:

```text
selectable = false
runnable   = false
```

This prevented a partially implemented Muse profile from reaching the production agent/request path. Phase M2 added Meta provider/model transport; **Phase M3 installed the first real Muse Agent Plane — and the profile STAYS locked (`selectable = false`, `runnable = false`, `availability = contributor-gated`)** because `contributorProtection.required` is still unsatisfiable: outbound contributor protection ships in Phase M5. Security truth outranks selectability. See [muse-agent-plane-v0.md](muse-agent-plane-v0.md) for the plane's architecture, its operator-consent execution gate, and the exact remaining activation gate.

## Phase M2: Meta Model API provider transport

M2 wires the Muse profile to a provider WITHOUT enabling any execution. The architecture after M2 is still `selectable = false`, `runnable = false`, `availability = foundation` for the production Muse profile, and no controller dispatch, agent loop, tool loop, context assembly, or completion logic exists for Muse.

### Resolution chain

```text
Nexus Profile (engine: muse)
      |
Muse Profile  (config/muse-profiles.json, model.primary)
      |
Model Registry (config/model-registry.json, vendor-neutral entry)
      |
DSH provider configuration (settings.yaml llm-pi-ai.providers route)
      |
Meta Model API (OpenAI-compatible transport)
```

- The Muse profile names a **model registry id** (`model.primary`), never a provider id or URL.
- The registry entry maps `muse-spark-1.3-contributor` to the provider route `meta-model-api` and declares real capabilities. (M2 registered the Standard checkpoint `muse-spark-1.3`; M2.1 retargeted Nexus to the Contributor checkpoint — see the Phase M2.1 section.)
- The provider route is generic DSH substrate (`api: openai-completions`) — there is no custom Meta HTTP stack. A route pi-ai does not ship is a fully self-describing provider declaration (`api`, `baseURL`, `apiKeyEnv`, `models`), which is exactly how `meta-model-api` is registered.

### Official contract (verified against Meta sources, Phase M2)

Verified against the official **Meta Model API cookbook** (github.com/meta-models/meta-model-cookbook, linked from dev.meta.ai docs) and cross-checked where noted:

| Fact | Value | Source |
|---|---|---|
| Base URL | `https://api.meta.ai/v1` | cookbook setup cells |
| API key variable | `MODEL_API_KEY` | cookbook setup cells |
| Standard model id | `muse-spark-1.3` (Standard checkpoint; M2) | cookbook (all recipes) |
| Contributor model id | `muse-spark-1.3-contributor` (Contributor checkpoint; M2.1 target) | dev.meta.ai model docs + cookbook ecosystem listing |
| Contributor output cap | `max_completion_tokens` hard ceiling **131072** for the Contributor checkpoint | dev.meta.ai model docs (verified before registration) |
| Context window | 1,048,576 tokens; input and output share the budget | cookbook long-context recipe |
| API style | OpenAI-compatible chat completions; drop-in via the OpenAI SDK | cookbook README |
| Streaming | SSE; deltas at `choices[0].delta.content`; final usage chunk via `stream_options.include_usage`; `[DONE]` terminator | cookbook streaming recipe |
| Tool calling | `tools[].function`; assistant `tool_calls` with `id`/`name`/JSON-string `arguments`; `finish_reason: tool_calls`; **only `tool_choice: auto` is supported** (others → HTTP 400) | cookbook tool-calling recipe |
| Reasoning | request field `reasoning_effort`; native spectrum `none < minimal < low < medium < high`, plus the accepted alias **`xhigh`**; **`none` returns HTTP 400 on the public endpoint and OMITTING the field still reasons (omission is NOT off)**; usage reports `completion_tokens_details.reasoning_tokens`; `reasoning_content` is empty on Chat Completions | cookbook reasoning recipe + M2.1 verification |
| Output cap field | `max_completion_tokens` canonical (`max_tokens` deprecated alias) | cookbook / Meta compatibility docs |
| Errors | OpenAI-style envelope `{error:{message,type,param,code}}`; 429/5xx/timeouts transient; 400/401/404 permanent | cookbook error-handling recipe |
| Vision | image input supported (URL/base64) | cookbook vision recipe |
| maxOutputTokens | M2 (Standard): no explicit per-request ceiling published; registry carried the conservative 32768 (substrate default for unsized models). **M2.1 (Contributor): the vendor-verified hard output ceiling is 131072 and the registry records it as such** — the value is the vendor cap, never a Nexus safety/default cap | dev.meta.ai model docs (M2.1) |

### Checkpoint decision: standard vs Contributor (RESOLVED in M2.1)

M2 could not verify the Contributor checkpoint on a direct Meta source and registered only the Standard checkpoint. **M2.1 resolved the open question against the official Meta model documentation (dev.meta.ai/docs): the two checkpoints are distinct registered products with distinct ids and distinct limits.**

- `muse-spark-1.3` — Standard checkpoint. M2's registered target; retained as the documented Standard id.
- `muse-spark-1.3-contributor` — Contributor checkpoint. Permits Meta to train on prompts/completions; carries a **131072-token hard output ceiling** (verified before registration) and requires contributor-grade outbound protection.

M2.1 retargeted Nexus to the Contributor checkpoint: the registry entry is `muse-spark-1.3-contributor` with `dataUseTier: "contributor"` and `contributorProtection.required: true`. The tier is declared metadata (never inferred from the model-name string), so the later outbound-sanitization phase (M5) consumes the declaration. The `dataUseTier: "standard"` registration of M2 remains the documented prior state that the M2.1 settings migration upgrades in place.

### Reasoning mapping (provider boundary)

Nexus semantic levels and Meta-native `reasoning_effort` values are different abstraction layers. The mapping lives in `settings.yaml` under the provider route's `reasoningEfforts` and is the mapping of record:

M2 mapped `off` by omitting the field and folded `max` onto `high`. **M2.1 retires both compromises after verifying Meta's actual semantics against the official documentation:** the literal `none` value returns HTTP 400 on the public endpoint, and OMITTING `reasoning_effort` does not disable reasoning — the omission-as-off mapping was a lie at the wire. The Contributor route therefore offers exactly the officially verified spectrum and fails closed on everything else:

| Nexus level | Meta native wire value | Status on the contributor route |
|---|---|---|
| `minimal` | `minimal` | offered (official spectrum floor) |
| `low` | `low` | offered |
| `medium` | `medium` | offered |
| `high` | `high` | offered |
| `xhigh` | `xhigh` | offered (officially accepted alias; route default) |
| `off` | — | **REMOVED — fail closed** (`none` is HTTP 400 on Meta; omission still reasons, so no truthful wire value exists) |
| `max` | — | **REMOVED — fail closed** (Standard-tier-only level; not part of the Contributor checkpoint's spectrum) |
| any other level | — | **fail closed** (null — refuse rather than silently send a lower effort) |

The M1 profile semantics are retargeted accordingly: `default: xhigh` and `escalation: xhigh` (the `max` escalation is gone with the level). The mapping is deterministic, documented, and regression-tested at three layers: the settings route (`reasoningEfforts`), the resolver battery (`MuseProvider.Tests.ps1`), and the real DSH substrate descriptor (`Invoke-ProviderSubstrateProbe.mjs`).

### Engine isolation (no Dual leak)

Muse supports tools, so a naive registry addition would make it eligible for Dual `primaryEngineer`/`deepEngineer`/`fallback` roles. M2 adds additive engine-scope metadata to the registry:

```json
"agentEngines": ["muse"]
```

Rules (enforced in `Test-AihModelRoleCompatible`, `Engineering-Profiles.cjs`, and the UI mirror `engineering.cjs`):

- Entries **without** the property keep their current Dual behavior exactly (every pre-M2 entry).
- A declaration that omits `dual` excludes the entry from every Dual role list.
- The filter is capability/metadata driven; there are no model-id conditionals anywhere.
- The Muse-side resolver independently refuses to bind a model not scoped to `muse` (defense in depth).

### Credentials

The provider route declares `apiKeyEnv: MODEL_API_KEY` (Meta's official variable). The key resolves through the EXISTING credential architecture: environment first, then the protected `data/.credentials.yaml` store (user-only permissions). Rules:

- No key in Git, registry, profiles, logs, errors, or telemetry.
- A missing Meta key means **Muse provider unavailable** — the Nexus installation remains fully functional.
- `.env.example` carries the variable NAME only.

### M2 provider probe

`scripts/MuseProvider.ps1` + `scripts/Invoke-MetaProbe.mjs` form a bounded provider capability probe — **transport validation only, not a Muse execution path**:

```powershell
# offline (default): deterministic, no network, no real key
powershell -File scripts/MuseProvider.ps1 -Action probe -InstallRoot <root>

# live: opt-in twice — a Meta credential must resolve AND the gate must be open
$env:NEXUS_META_LIVE_TEST = '1'
powershell -File scripts/MuseProvider.ps1 -Action probe -InstallRoot <root> -Live
```

The probe resolves the provider route and credential REFERENCE from live configuration (never a hardcoded URL), then proves: config resolution, credentials detection, text round trip, streaming deltas + termination + usage chunk, tool-call contract, reasoning mapping on the wire, normalized 401/429/5xx/timeout/malformed-stream/interrupted-stream handling, and secret hygiene (no key material in any record). Live requests are a handful of tiny synthetic prompts ("Reply with exactly the word NEXUS.", a fake `get_test_temperature` tool); no repository source, user data, or credentials are ever sent — Contributor protection is a later security phase.

The production Muse execution path (M3+) will ride the same settings.yaml route through the DSH substrate (dsh-llm-pi-ai); the probe validates that route's wire contract. The probe never executes tools, never builds agent history, and holds no completion authority.

### M2 / M3 boundary

M2 ends at **provider transport READY**. Still deliberately absent: controller engine dispatch, Muse agent loop, tool loop, Working Set prompting, context assembly, completion logic, verification logic, Muse retries, Muse subagents, Codex calls from Muse, and Muse worktrees. The production Muse profile remains `selectable = false`, `runnable = false`, `availability = foundation`.

## Phase M2.1: Contributor target, engine hardening, substrate proof, UI restart fix
M2.1 hardens the M2 foundation without installing any M3 capability. Four deliverables:

### 1. Managed settings migration (`scripts/SettingsMigration.ps1`)

`Sync-AihManagedSettings -TemplatePath config/settings.yaml -SettingsPath data/settings.yaml` makes the managed provider route self-healing across upgrades:

- **Additive only.** Routes the user does not own are never touched; managed routes absent from `data/settings.yaml` are appended at the end of the `llm-pi-ai.providers` map with the file's existing newline style preserved (CRLF stays CRLF), atomically (`Write-AihAtomicText`, UTF-8 without BOM).
- **Idempotent.** A second run against an already-migrated file is a byte-for-byte no-op (newline-normalized comparison, not raw diffing).
- **Prior-state upgrade.** A managed route that still matches the known M2 state (embedded verbatim as `ManagedRoutePriorStates`) is replaced with the current managed route (the M2 standard route becomes the M2.1 contributor route).
- **User-edit respect.** A managed route the user has modified (any byte difference from every known prior state) is left untouched and reported as skipped.
- **Fail closed.** A structurally invalid managed route (missing `apiKeyEnv` or `baseURL`) aborts the migration with a thrown error and the file untouched.
- `scripts/Complete-Install.ps1` runs the sync between settings initialization and the managed-patch copy; no YAML parser is used — line/indentation-structured text processing only, so the file's formatting survives.

### 2. Engine-scope enforcement (asymmetric, three layers)

`agentEngines` registry metadata is now enforced end-to-end with an asymmetric contract (`Test-AihModelEngineCompatible` in `Routing.ps1`, mirrored in `Engineering-Profiles.cjs`, `Nexus-Profiles.cjs`, and the UI `engineering.cjs`):

| Engine requested | Entry declares `agentEngines` | Result |
|---|---|---|
| `dual` | absent | **allowed** (backward compatibility: every pre-M2 entry stays Dual-eligible) |
| `dual` | present without `dual` | refused |
| `muse` | absent | **refused (fail closed)** — absence is not an implicit allow-all |
| `muse` | includes `muse` | allowed |
| any engine | unknown engine id | refused |

`Test-AihModelRoleCompatible` (Dual role lists) and `Resolve-AihModelTarget` enforce the dual side; `Resolve-AihMuseProfileModel` enforces the muse side independently (defense in depth). Every pre-M2 registry entry has no `agentEngines` and keeps its exact previous Dual behavior; only `muse-spark-1.3-contributor` declares `["muse"]`.

### 3. Real-substrate proof (offline)

`scripts/Invoke-ProviderSubstrateProbe.mjs` proves the REAL DSH provider substrate recognizes `meta-model-api` / `muse-spark-1.3-contributor` without credentials and without network: a real `cordis.Context`, `FileSettingsProvider` loading the managed settings file, `substrate.Config` + `substrate.apply` over the `llm-pi-ai` section, and the real PiAi adapter registered through `ctx.llm.registerAdapter`. The probe asserts the full descriptor chain: route registration, `listModels`, `resolveModel`, `contextWindow: 1048576`, `defaultMaxTokens: 131072` (the output ceiling travels through the substrate), and the reasoning descriptor (`reasoning.efforts` minimal..xhigh with `defaultEffort: xhigh`; `off`/`max` refused). The probe also DISCRIMINATES: pointed at the M2 standard route it fails closed. Wired into `tests/MuseProvider.Tests.cjs` (section 6). **Verification status: documentation + offline execution evidence; `MODEL_API_KEY` is NOT set in the verification environment, so no live Meta call was made or needed.**

### 4. Composer preference ownership (TASK-0039)

The real cold-start failure was an initial editor effect calling
`userFacingProfiles(null)`. The slot boundary removed the crashing selector
and its CSS marker, exposing the upstream Model/Effort control. The old
`conversation.input.right` placement also depended on input readiness.

The pinned model seat now has `session-maybe` scope and delegates through
`nexusComposerPreference.Component`. Engineering renders the Profile control;
legacy renders the original upstream `ModelSelect`. The right slot contains
only RUNNING/PREFERRED pills. No body marker or CSS suppression chooses the
preference owner.

The hero (including a blank session) reads the visible mode picker's shared
`nexusModeState`; an active session retains snapshot/preset authority. The mode
plugin uses pinned DSH's `connection.api` RPC envelope and `remote.$on` events,
then records host-confirmed changes with `sessions.noteAgentPreset`. Global
profile loading does not require an input hook or session. Null, HTTP failure,
and malformed configuration remain on the Engineering loading/unavailable UI.

The deterministic integration patch validates both package versions and exact
source blocks before writing either bundle. See
[the investigation and acceptance record](composer-preference-ownership.md).

## Compatibility invariant

The key M1 invariant is:

> Adding the profile/engine abstraction must be additive. Existing Dual execution continues through the existing controller, role resolution, Engineering Isolation, review, and verification paths unchanged. The M2 engine-scope metadata and provider route are equally additive: Dual role-model lists are unchanged except that engine-scoped Muse entries can no longer leak into them.

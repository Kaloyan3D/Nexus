# Nexus profiles and agent engines

Status: Phase M1 — profile/engine foundation.

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

## Phase M1 safety gate

Muse Spark 1.3 exists in the catalog during M1 as architecture metadata only:

```text
selectable = false
runnable   = false
availability = foundation
```

This prevents a partially implemented Muse profile from reaching the production agent/request path. Phase M2 adds Meta provider/model transport. Phase M3 installs the first runnable Muse Agent Plane.

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
- The registry entry maps `muse-spark-1.3` to the provider route `meta-model-api` and declares real capabilities.
- The provider route is generic DSH substrate (`api: openai-completions`) — there is no custom Meta HTTP stack. A route pi-ai does not ship is a fully self-describing provider declaration (`api`, `baseURL`, `apiKeyEnv`, `models`), which is exactly how `meta-model-api` is registered.

### Official contract (verified against Meta sources, Phase M2)

Verified against the official **Meta Model API cookbook** (github.com/meta-models/meta-model-cookbook, linked from dev.meta.ai docs) and cross-checked where noted:

| Fact | Value | Source |
|---|---|---|
| Base URL | `https://api.meta.ai/v1` | cookbook setup cells |
| API key variable | `MODEL_API_KEY` | cookbook setup cells |
| Standard model id | `muse-spark-1.3` | cookbook (all recipes) |
| Context window | 1,048,576 tokens; input and output share the budget | cookbook long-context recipe |
| API style | OpenAI-compatible chat completions; drop-in via the OpenAI SDK | cookbook README |
| Streaming | SSE; deltas at `choices[0].delta.content`; final usage chunk via `stream_options.include_usage`; `[DONE]` terminator | cookbook streaming recipe |
| Tool calling | `tools[].function`; assistant `tool_calls` with `id`/`name`/JSON-string `arguments`; `finish_reason: tool_calls`; **only `tool_choice: auto` is supported** (others → HTTP 400) | cookbook tool-calling recipe |
| Reasoning | request field `reasoning_effort`; native spectrum `none < minimal < low < medium < high`, plus the accepted alias **`xhigh` (same strength as `high`; `high` is the effective maximum)**; usage reports `completion_tokens_details.reasoning_tokens`; `reasoning_content` is empty on Chat Completions | cookbook reasoning recipe |
| Output cap field | `max_completion_tokens` canonical (`max_tokens` deprecated alias) | cookbook / Meta compatibility docs |
| Errors | OpenAI-style envelope `{error:{message,type,param,code}}`; 429/5xx/timeouts transient; 400/401/404 permanent | cookbook error-handling recipe |
| Vision | image input supported (URL/base64) | cookbook vision recipe |
| maxOutputTokens | **No explicit per-request output ceiling is published.** The registry carries the conservative value 32768 — the DSH substrate's own documented default for unsized models — and no cap is sent unless explicitly configured, matching Meta's "unset = full output budget" semantics | documented judgment, not a guess |

### Checkpoint decision: standard vs Contributor

The ecosystem (gateway aggregators) lists a discounted `muse-spark-1.3-contributor` checkpoint that permits Meta to train on prompts/completions. **It could NOT be verified on any DIRECT Meta official source** (the official cookbook does not mention it; dev.meta.ai pages are application-rendered and could not be read as documentation). Per the M2 rule — never infer Meta's direct model id from a gateway — Nexus registers ONLY `muse-spark-1.3` with `dataUseTier: "standard"`.

**M2 follow-up (security phase / M5):** before the Contributor checkpoint can be registered, a direct Meta source (official models page or API listing) must confirm the exact id. The `dataUseTier` metadata field exists so the later outbound-sanitization logic never has to infer the tier from the model-name string.

### Reasoning mapping (provider boundary)

Nexus semantic levels and Meta-native `reasoning_effort` values are different abstraction layers. The mapping lives in `settings.yaml` under the provider route's `reasoningEfforts` and is the mapping of record:

| Nexus level | Meta native wire value | Rationale |
|---|---|---|
| `off` | *(field omitted)* | "supported, send nothing" — the parameter's absence; Meta's literal `none` value is documented as not reliably available on the public endpoint |
| `high` | `high` | canonical native value |
| `xhigh` | `xhigh` | officially accepted alias (same strength as `high`) |
| `max` | `high` | native-max-equivalent: `high` IS Meta's effective maximum, and `xhigh` maps to the same strength, so nothing is lost relative to what the provider can do |
| any other level | **fail closed** (null) | the caller must refuse the request rather than silently send a lower effort |

`xhigh` and `max` collapse to the same provider reasoning strength at the Meta boundary. The M1 profile semantics (`default: xhigh`, `escalation: max`) are unchanged; the mapping is deterministic, documented, and regression-tested.

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

## Compatibility invariant

The key M1 invariant is:

> Adding the profile/engine abstraction must be additive. Existing Dual execution continues through the existing controller, role resolution, Engineering Isolation, review, and verification paths unchanged. The M2 engine-scope metadata and provider route are equally additive: Dual role-model lists are unchanged except that engine-scoped Muse entries can no longer leak into them.

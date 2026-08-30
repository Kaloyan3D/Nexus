# Engineering Profiles (Phase 2)

Phase 2 makes Engineering Mode fully **model-agnostic**. The deterministic
controller architecture and the task lifecycle are unchanged; only the model
that fulfils each **role** changes, driven by an operator-selectable
**engineering profile**.

## Model ≠ Role ≠ Execution Class ≠ Provider

Four distinct concepts, resolved in order:

1. **Execution class** — *semantics* of the execution path
   (`deterministic`, `engineer_normal`, `engineer_deep`, `reviewer`,
   `solver`). Classes never name a model or vendor.
2. **Role** — the responsibility a class carries (`primaryEngineer`,
   `deepEngineer`, `reviewer`, `solver`, `fallback`).
3. **Engineering profile** — the operator-chosen binding of roles to models
   (`deepseek-codex`, `glm-codex`).
4. **Model registry + provider config** — how a model id resolves to a
   concrete provider endpoint and reasoning effort.

Routing (class selection from description/signal/state) is completely
separate from model selection (profile → role → registry → provider).

## Flow

```
Task → Deterministic Controller → Execution Class (semantics)
      → Role → Active Engineering Profile → Model Registry → Provider → Model
```

## Default profile: "DeepSeek + Codex" (`deepseek-codex`)

| Role | Model | Provider | Reasoning |
| --- | --- | --- | --- |
| primaryEngineer | DeepSeek V4 Flash | flash-high-direct | high |
| deepEngineer | DeepSeek V4 Flash | flash-max-direct | max |
| reviewer | GPT-5.6 Sol (Codex) | sol-local | medium |
| solver | GPT-5.6 Sol (Codex) | sol-local | high |
| fallback | DeepSeek V4 Flash | flash-max-direct | max |

This profile preserves pre-Phase-2 behavior exactly.

## GLM + Codex profile (`glm-codex`)

| Role | Model | Provider | Reasoning |
| --- | --- | --- | --- |
| primaryEngineer | GLM-5.3-Flash | zai-direct | high |
| deepEngineer | GLM-5.3 | zai-direct | max |
| reviewer | GPT-5.6 Sol (Codex) | sol-local | medium |
| solver | GPT-5.6 Sol (Codex) | sol-local | high |
| fallback | GLM-5.3 | zai-direct | max |

Switching profiles changes **only** which model fulfils each role. Routing
rules, escalation thresholds, review gating, solver approval, verification
and completion semantics are identical.

## Selecting a profile

Priority (first match wins):

1. `DSH_AIH_PROFILE` environment variable
2. `AIH_ACTIVE_PROFILE` environment variable
3. `engineering-profile:` key in `data/settings.yaml`
4. Preset `profile` binding in `config/routing-policy.json`
5. Policy `defaultProfile`

Presets with `profileOverrideAllowed: false` (DeepSeek-only) ignore global
overrides — the profile is locked to the preset.

## Files

- `config/engineering-profiles.json` — the profile registry (schemaVersion 1)
- `config/model-registry.json` — the model registry (schemaVersion 1)
- `config/routing-policy.json` — execution classes, aliases, presets,
  escalation (version 3)
- `config/Engineering-Profiles.cjs` — shared JS resolution layer used by the
  request-enforcement plugin and the GUI bridge
- `config/Engineering-Isolation.cjs` — profile-driven request enforcement
  (freezes each root request to the profile's model for the active class)

## Adding a vendor

1. Add a provider block (e.g. `zai-direct`) under `llm-pi-ai.providers` in
   `config/settings.yaml` (and `data/settings.yaml`).
2. Add model entries to `config/model-registry.json`.
3. Add a profile binding roles → model ids in
   `config/engineering-profiles.json`.

No routing or controller code changes are required.


## Phase 2.1: Engineering Profile Editor (operator UI)

The Control Room exposes the profile flexibility through a compact editor (the
**Engineering** tab). The operator manually chooses which registered model
fulfils each role — Nexus never auto-selects the "best" model.

### Editor surface

- **Profile dropdown** — `DeepSeek + Codex`, `GLM + Codex`, `Custom`
  (populated from the model registry — never hardcoded vendor names).
- **Five role rows** — Primary Engineer, Deep Engineer, Reviewer, Solver,
  Fallback. Each row has a model dropdown (role-compatible models from the
  registry, labelled `DisplayName · Vendor`) and a reasoning dropdown
  (only `supportedReasoningLevels` of the selected model).
- **Save** — persists through the existing settings system; nothing else
  changes.

### Backend contract (validated controller boundary)

The browser never edits config files or ledgers directly. All editor reads
and writes go through the controller:

| Endpoint | Purpose |
| --- | --- |
| `GET /nexus/engineering-profile.json` | read-only editor state (profiles, registry, preferred, custom bindings, role requirements, compatible models) |
| `POST /nexus/engineering-profile-action.json` | `select` (preferred profile) or `save-custom` (persist operator bindings) |

The PowerShell controller CLI `scripts/EngineeringProfile.ps1` is the
authority: it re-validates every payload and writes atomically
(`scripts/Common.ps1` `Write-AihAtomicJson` + a settings mutex). An
invalid save never partially writes; the last valid configuration is always
preserved.

### Custom profile

Operator bindings persist to `data/custom-engineering-profile.json` as
profile id `custom`. Both planes (PS `Get-AihEngineeringProfiles` and JS
`loadProfiles`) merge it into the profile list at load time; the built-in
registry files (`config/engineering-profiles.json`) are never mutated.
Selecting a built-in profile only writes the `engineering-profile:` key in
`data/settings.yaml`. Editing a role binding while a built-in profile is
selected automatically creates/switches to the Custom profile (the built-in
itself stays immutable).

### Capability rules (role ↔ model compatibility)

A model may be assigned to a role only when its registry entry supports what
that role needs:

| Role | Requires |
| --- | --- |
| primaryEngineer / deepEngineer / fallback | enabled, `supportsTools`, `supportsReasoning` |
| reviewer | enabled, `supportsReasoning`, provider resolves to `sol-local` (this phase's reviewer transport) |
| solver | enabled, `supportsReasoning` (writable only via explicit operator approval) |

Reasoning levels are restricted to the model's `supportedReasoningLevels`
and must resolve through the registry provider map. Validation fails closed:
unknown model id, disabled model, capability-incompatible role assignment,
unsupported reasoning level, missing role binding, unknown profile id and
malformed payloads are all rejected atomically.

### PREFERRED vs RUNNING

- **PREFERRED** — the operator's `engineering-profile:` setting (config for
  future resolution), shown in the editor and Control Room meta.
- **RUNNING** — the decision record's execution class / role / profile /
  provider / model. A save changes PREFERRED only; RUNNING execution that
  already started is never rewritten.

A valid state: PREFERRED Custom (GLM-5.3) while RUNNING shows Primary
Engineer GLM-5.3-Flash (the task started before the change).

### Adding a vendor (editor selectable, zero code change)

1. Add a provider block under `llm-pi-ai.providers` in
   `config/settings.yaml` (and `data/settings.yaml`).
2. Add the model to `config/model-registry.json`.
3. The editor lists it for every compatible role automatically.

No routing or controller changes are required.

## Reviewer transport (this phase)

The bounded reviewer executes through the local Codex/OAuth adapter only
(provider `sol-local`). A profile that binds the reviewer role to any other
provider fails closed: the review path throws instead of silently substituting
a different model.

## Legacy names

`deepseek_normal`, `deepseek_deep`, `codex_review`, `codex_solve` remain
readable everywhere (records, state files, CLI inputs) as compatibility
aliases for `engineer_normal`, `engineer_deep`, `reviewer`, `solver`.
Persisted records are never rewritten; readers normalize on read.

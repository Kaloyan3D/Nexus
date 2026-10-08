# Nexus Registry — R0 Legacy Baseline and Scope Freeze

**Status:** R0 baseline (read-only; no production behavior changes)  
**Baseline branch:** `dev`  
**Pinned starting commit:** `9e81dadde73adcc2cd71f019caa7eaef04504063` (2026-10-08)  
**Registry architecture:** `NEXUS_REGISTRY_ARCHITECTURE.md` v0.2 (design document; to be added/reconciled in the Registry track)

## Goal

Capture current **v1 Dual** and **v2 Muse** configuration outcomes before a Nexus-owned, runtime-independent Registry compiler is introduced. This baseline must constrain R1/R2 migration; it must **not** make the legacy resolver the permanent core of the new Registry.

The baseline test is `node tests/RegistryLegacyBaseline.Tests.cjs`. Expected outputs are fixed, reviewed fixtures at `tests/fixtures/registry/legacy-targets.json` (not regenerated from the implementation during normal CI). The test invokes the *existing* resolver on isolated temporary configuration copies and compares exact model/provider/reasoning tuples.

## Existing authority and coupling inventory

| Component | Today | Registry responsibility | Migration boundary |
| --- | --- | --- | --- |
| `config/nexus-profiles.json`, `config/Nexus-Profiles.cjs` | Profile ID → Dual/Muse engine and Muse model | Import aliases + mode definitions | Legacy adapter, temporary |
| `config/engineering-profiles.json`, `config/Engineering-Profiles.cjs` | v1 internal role bindings and compatibility validation | Runtime-neutral model/route compiler, preserving every internal role | Legacy adapter; no duplicate long-term decision logic |
| `config/muse-profiles.json` | v2 independent Muse plane + reasoning | One primary slot + exact policy | Preserve no-Dual-coercion guard |
| `config/model-registry.json` | Models mixed with DSH provider route IDs | Distinct logical model, provider, connection, route | Preserve route identity and engine scope |
| `config/routing-policy.json`, `scripts/Routing.ps1`, `scripts/NexusProfiles.ps1` | Deterministic execution class, escalation, approvals and routing authority | Registry returns eligible bound targets, **never decides task routing** | PROTECTED; do not change in R0/R1 |
| `config/Muse-Isolation.cjs`, `config/Routing-Integrity.cjs` | Controller target enforcement and fail-closed provider/model checks | Runtime bind target is immutable, no silent fallback | PROTECTED; adapter respects existing state |
| `config/AihController.cjs` | DSH plugin bridge, task/session identity, verification, CCv2 integration | Future runtime-facing binding consumer | PROTECTED in R0/R1 |
| `ui/nexus-mode-selector/lib/client.js`, `ui/nexus-controller/lib/*` | DSH preset, DSH session/model synchronization, profile editor | Later UI becomes mode/slot driven | Deferred until R3 |
| `config/settings.yaml`, `data/settings.yaml`, `scripts/SettingsMigration.ps1` | DSH `llm-pi-ai.providers` settings, user overrides | Validated DSH projection from Nexus-owned providers and routes | DSH adapter only; preserve user-owned settings |
| `runtime/package.json`, `runtime/*` | Pinned DSH execution substrate | **Not** a Registry dependency | PROTECTED; Rust implementation is separate, later |
| Restricted CCv2 in `dev` | Read-only compile + validated request-time projection; durable session mutation disabled | No dependency on durable CCv2 | PROTECTED; no compaction work in Registry |

The exact file inventory must be rechecked after rebases. A future Rust Native Runtime is intentionally **out of scope** for Registry v1 implementation; Registry data contracts must not contain DSH session objects or protocol-specific credentials.

## Fixed invariants for R0 → R2

1. `deepseek-codex` and `glm-codex` remain v1 Dual configurations. Existing `primaryEngineer`, `deepEngineer`, `reviewer`, `solver`, `fallback` and optional `visualReviewer` mappings survive losslessly, including per-role overrides.
2. `muse-spark-1.3-contributor` (Meta) and `muse-spark-1.3-contributor-opencode` (OpenCode Go) remain **different routes** to the same upstream Muse checkpoint. Both remain in the v2 single-agent plane; never coerce them into v1 role semantics.
3. The test fixture captures resolved **logical entry ID + remote model ID + provider ID + reasoning**. Comparing display names or only remote model IDs is insufficient.
4. `DSH_AIH_PROFILE` > `AIH_ACTIVE_PROFILE` > live `engineering-profile` > preset/default precedence remains until a deliberate, tested migration. Locked `aih-deepseek` remains locked.
5. Reviewer is read-only; solver writes require explicit user approval; `aih-muse` isolation must fail closed. No model/provider/reasoning fallback is introduced by Registry.
6. Session bindings, task identity, pinned route, reasoning continuity and provider-specific session headers are **execution state**, not mutable Registry preferences.
7. Existing DSH transport projection is an adapter, not a canonical Registry data model. Secrets remain in protected credential stores and never enter fixtures or route exports.
8. Restricted CCv2 stays read-only; durable writer/recovery/structured-memory work and the legacy CCv1 stale-writer defect are separate safety tracks.
9. A future Rust runtime consumes versioned, runtime-neutral binding snapshots; Rust is not required to execute the Registry baseline.
10. Migration must be reversible and never replace user-owned settings or update active session models mid-task.

## Local check

```bash
node tests/RegistryLegacyBaseline.Tests.cjs
```

The CI workflow `.github/workflows/registry-baseline.yml` runs the same offline assertion set. It uses no credentials, no DSH installation, no network execution, no PowerShell, and does not edit runtime data.

## R0 acceptance

- [x] Record an exact baseline source SHA and source-file dependency map.
- [x] Add reviewed v1/v2 fixed route fixtures.
- [x] Add a read-only baseline regression harness.
- [x] Add a dedicated portable CI job for the baseline test.
- [ ] Verify new CI job passed for this branch.
- [ ] Record complete pre-Registry harness results separately, including any pre-existing failing/skip gates (not inferred from the focused fixture test).
- [ ] Confirm branching/integration owner and obtain review before R1.

## Next: R1 (separate PR)

Implement Nexus-owned, runtime-neutral `ModeDefinition`, `LogicalModel`, `Provider`, `ModelRoute`, `Connection`, and `ModeConfiguration` schemas plus a pure resolver/compiler. Generate read-only imports from existing profiles, then compare with the **frozen fixtures** and current resolvers. Do **not** rewrite `Routing.ps1`, `AihController.cjs`, DSH, CCv2 or start the Rust kernel.

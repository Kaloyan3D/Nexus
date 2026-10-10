# Nexus Registry — R1 Core Foundation

**Status:** R1 implemented on `feature/model-registry-r1` (stacked on R0 branch `feature/model-registry-v1`).
**Spec:** `NEXUS_REGISTRY_ARCHITECTURE.md` v0.2, Phase R1 (schema and pure resolver).
**Baseline:** R0 frozen fixtures at `tests/fixtures/registry/legacy-targets.json` (sourceRef `dev@9e81dad`).

R1 introduces the runtime-independent Registry Core **alongside** the existing
system. No production execution path changed: `scripts/Routing.ps1`,
`scripts/TaskController.ps1`, `config/AihController.cjs`,
`config/Muse-Isolation.cjs`, `config/Routing-Integrity.cjs`, DSH runtime
internals, and CCv2 components are untouched, as are all existing
configuration files.

## Minimum implementation surface (as identified before code changes)

| New file | Purpose |
|---|---|
| `config/registry/schemas.cjs` | Strict versioned validators for all nine contracts |
| `config/registry/resolver.cjs` | Pure deterministic compiler (no I/O, no env, no network) |
| `config/registry/legacy-import.cjs` | Read-only normalization of existing configs into Core snapshots |
| `config/registry/index.cjs` | Stable public surface (`{ schemas, resolver, legacyImport }`) |
| `config/registry/modes/engineering-v1.json` | v1 Dual mode definition (deprecated, runnable) |
| `config/registry/modes/engineering-v2.json` | v2 Muse mode definition (active-legacy, runnable) |
| `config/registry/modes/engineering-v3.json` | v3 Nova placeholder (planned, **not** runnable) |
| `tests/RegistryCore.Tests.cjs` | 28 offline deterministic tests |
| `docs/architecture/registry-r1-core.md` | This document |

## Architecture decisions

- **ADR-R1-01 — Pure CommonJS Core, zero dependencies.** The Core requires
  only `node:crypto` (sha256 resolution ids) and its own schemas module.
  No fs, no `process.env`, no network, no inference. A test asserts the
  Core sources contain no DSH/PowerShell/session tokens.
- **ADR-R1-02 — Install root is injected, never discovered.** Unlike the
  legacy resolvers (which prioritize `DSH_HOME`), `buildRegistrySnapshot`
  and `importLegacyProfiles` take an explicit root path, satisfying spec
  §18 Q10. Relocated installs behave identically.
- **ADR-R1-03 — Routes are per (model, provider) pairs.** Legacy
  `providers` maps (reasoning → provider key) normalize to distinct routes
  (`<provider>/<model>`) with exact reasoning-level partitions, so
  `flash-high-direct/deepseek-v4-flash` and
  `flash-max-direct/deepseek-v4-flash` stay distinguishable, as do the two
  Muse routes to the shared `muse-spark-1.3-contributor` checkpoint.
- **ADR-R1-04 — Engine scope is structural, not nominal.** Normalized models
  carry `engines: ['dual-v1'] | ['muse-v0']` derived from legacy
  `agentEngines`. Cross-engine compilation fails closed with
  `engine-scope-mismatch`, giving Dual/Muse isolation without model-id
  conditionals.
- **ADR-R1-05 — v1 three slots fan out to five-plus roles.** The UI-facing
  `engineer` slot carries `primaryEngineer`; `deepEngineer`,
  `fallback`, and optional `visualReviewer` ride as per-role overrides,
  so intentionally different models/reasoning survive losslessly.
- **ADR-R1-06 — muse-v0 stays contributor-scoped.** The v2 slot requirement
  `adaptiveReasoningContract: muse-v0` requires the contributor data-use
  tier; generalizing v2 to other models is deferred per spec §18 Q2.
- **ADR-R1-07 — Transports stay honest.** Legacy configs carry no wire-protocol
  metadata, so normalized providers/routes declare `transportId: 'unknown'`
  (a declared unknown, not a guess). The resolver treats `unknown` as "no
  constraint" and enforces declared transports against mock runtime
  descriptors. Real protocol verification is R4 probe work.
- **ADR-R1-08 — Connections are auto-provisioned descriptors.** One
  `conn-<provider>` (`credential://` reference only, status `unknown`)
  per legacy provider key. No secret material exists anywhere in R1.

## Interfaces

```js
const { schemas, resolver, legacyImport } = require('./config/registry/index.cjs')

// Pure validation: returns [{ code, message, path }], [] = valid
schemas.validateModeDefinition(doc)
schemas.validateModeConfiguration(doc)
schemas.validateLogicalModel(doc)
schemas.validateProvider(doc)
schemas.validateModelRoute(doc)
schemas.validateConnection(doc)
schemas.validateRuntimeModelBinding(doc)
schemas.validateResolvedModeConfiguration(doc)
schemas.validateRegistrySnapshot(doc)

// Pure compilation: { ok: true, snapshot } | { ok: false, errors }
resolver.compileModeConfig(modeConfig, registrySnapshot, { runtime? })
resolver.validateModeConfig(modeConfig, registrySnapshot, { runtime? }) // error list
resolver.listEligibleRoutes(modeId, slotId, registrySnapshot, runtime?)
resolver.resolveRoleBinding(registrySnapshot, mode, role, assignment, runtime?)

// Read-only legacy normalization (fs reads only, zero writes)
legacyImport.buildRegistrySnapshot(installRoot)      // { snapshot, errors }
legacyImport.importLegacyProfiles(installRoot, snapshot) // { configs, errors }
```

`compileModeConfig` follows spec §6 validation order and returns only
actionable fail-closed codes (`unknown-mode`, `duplicate-id`,
`unknown-reference`, `route-model-identity-mismatch`,
`reasoning-level-not-supported`, `slot-capability-not-satisfied`,
`engine-scope-mismatch`, `runtime-capability-unsatisfied`,
`connection-auth-required`, `mode-not-runnable`, …). It never substitutes,
falls back, or downshifts reasoning. The snapshot is deep-frozen; its
`resolutionId` is sha256 over canonical (key-sorted) non-secret content.

## Ownership boundaries

- **Registry Core** owns the nine data contracts and the pure compiler. It
  owns no files, no sessions, no credentials.
- **Legacy configs** remain the source of truth for v1/v2 behavior. The
  import helper derives views; a hash-equality test proves source files are
  never written.
- **Controller/routing** keep sole execution authority. The Core decides what
  configurations are valid; it never routes, executes, or completes tasks.
- **DSH specifics** (`legacyDshProviderId`, preset mapping, YAML
  projection, session continuity) belong to the future R2/R6 DSH adapter,
  never to canonical Core records.

## What is ready for R2

- Canonical snapshots + mode configs for all four legacy profiles, proven
  byte-exact against frozen R0 fixtures (model/provider/reasoning per role).
- `routeIdForLegacyBinding` + per-role override import accept any existing
  or custom Dual profile shape.
- `RuntimeModelBinding` records carry everything a DSH projection adapter
  needs (mode, role, logical model, route, provider, remote model,
  connection ref, execution kind, protocol, reasoning, capabilities) with no
  host-specific content to strip.
- The runtime-matrix test pattern (mock `RuntimeCapabilities` descriptors)
  is the seam R2 will use for the real DSH adapter capability report.

## Verification

- `node tests/RegistryCore.Tests.cjs` — 28/28 pass (offline).
- `node tests/RegistryLegacyBaseline.Tests.cjs` — 21/21 pass (unchanged).
- `node --check` on all new/edited `.cjs` files.
- `git status --short` shows only the nine new files; zero modifications to
  protected components or existing configs.

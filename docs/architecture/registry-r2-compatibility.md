# Registry R2 — Legacy Compatibility & Migration (Deliverable)

**Phase:** R2 (legacy compatibility adapter). **Not a production cutover.**
**Branch:** `feature/model-registry-v1`. **Spec:** `NEXUS_REGISTRY_ARCHITECTURE.md` v0.2 §13 Phase R2, §14.
**Suite:** `tests/RegistryR2Compatibility.Tests.cjs` (33 checks, offline, no credentials).

## 1. Compatibility architecture

```text
legacy configs (read-only input)         canonical Registry (derived, re-derivable)
config/nexus-profiles.json               config/registry/modes/engineering-v{1,2}.json
config/engineering-profiles.json   --->  profile-compat.cjs  --->  ModeConfiguration
config/muse-profiles.json          --->  muse-canonical.cjs  --->  1 canonical Muse model + 2 routes
config/model-registry.json         --->  legacy-import.cjs   --->  snapshot (providers/routes/connections)
data/custom-engineering-profile.json -/          |
                                                v
                                   resolver.cjs (pure compile) + parity.cjs (oracle compare)
                                                |
                    +---------------------------+---------------------------+
                    |                                                       |
            dsh-adapter.cjs                                    migration.cjs (dry run only)
     (adapter-private projection)                        (preview/diff/rollback, isolated roots)
```

- **Source of truth:** legacy files stay authoritative for production; the canonical
  snapshot is derived and re-derivable (byte-identical rebuilds proven by test).
- **Ownership:** Registry Core owns canonical records; the DSH adapter owns projection
  maps; the deterministic controller keeps routing authority; migration owns nothing
  persistent in R2.
- **Dependency direction:** adapters depend on Core (`schemas`/`resolver`); Core never
  imports adapters, DSH, PowerShell, or host environment.
- **Failure semantics:** every layer fails closed with actionable `code:path:message`
  errors. Unknown profiles, models, routes, reasoning levels, revoked connections,
  disabled routes/providers, and scope mismatches never fall back to a default.
- **Observability:** parity matrix counts (matched / canonical-id-change-only /
  mismatched), migration `planHash`, and error-code inventories.
- **Security:** snapshots carry only opaque `credential://` references; Contributor
  data-use tier, reviewer read-only, and solver approval requirements are preserved
  end to end and covered by the resolution fingerprint.

## 2. Alias and canonical identity decisions

### 2.1 Canonical Muse identity (R2.2)

The two legacy entries share the declared checkpoint `muse-spark-1.3-contributor`
but ride different providers. They unify into one logical model:

- Canonical model: `meta/muse-spark-1.3-contributor` (vendor Meta, engines
  `["muse-v0"]`, `dataUseTier: "contributor"`, Contributor capability set).
- Route A (Meta Direct): `meta-model-api/meta/muse-spark-1.3-contributor`.
- Route B (OpenCode Go): `opencode-go/meta/muse-spark-1.3-contributor`.
- Connections stay distinct (`conn-meta-model-api`, `conn-opencode-go`); provider
  records, entitlements, and access statuses are never merged.
- Route-specific reasoning levels and compatibility metadata are preserved verbatim
  per route. The two routes are **not** treated as interchangeable: compilations
  against each produce distinct `routeId`/`providerId`/`connectionId` bindings.
- Optional route constraints (`capacityConstraints`) and `provenance` round-trip
  exactly when present and stay absent when absent; missing provenance is never
  invented.
- Strict engine isolation uses exact orchestration-engine identities
  (`dual-v1`, `muse-v0`); any other expected or actual engine id fails closed
  (`parity-unknown-engine`, `parity-engine-crossover`).
- Unification is fail-closed: any checkpoint, capability, tier, engine-scope,
  capacity, or enabled mismatch between the legacy entries aborts normalization
  with `muse-canonical-mismatch:*` and no snapshot (proven by test).

### 2.2 Preserved aliases (explicit, versioned, never guessed)

| Legacy id | Kind | Canonical resolution |
|---|---|---|
| `muse-spark-1.3-contributor` | model | `meta/muse-spark-1.3-contributor` |
| `muse-spark-1.3-contributor-opencode` | model | `meta/muse-spark-1.3-contributor` |
| `muse-spark-1.3-contributor` | profile | `engineering-v2` + Meta Direct route |
| `muse-spark-1.3-contributor-opencode` | profile | `engineering-v2` + OpenCode Go route |
| `deepseek-codex`, `glm-codex`, `custom` | profile | `engineering-v1` (bindings verbatim) |
| `meta-model-api/muse-spark-1.3-contributor` | route | `meta-model-api/meta/muse-spark-1.3-contributor` |
| `opencode-go/muse-spark-1.3-contributor-opencode` | route | `opencode-go/meta/muse-spark-1.3-contributor` |

Unknown ids resolve to `null` plus an actionable error; the frozen R0 fixtures
(`tests/fixtures/registry/legacy-targets.json`) are untouched and remain the
immutable historical record.

## 3. Old-to-new mapping (R2.1)

| Legacy profile | Mode | Slots / overrides |
|---|---|---|
| `deepseek-codex` | `engineering-v1` | engineer=primaryEngineer; reviewer/solver slots; deepEngineer/fallback/visualReviewer as role overrides |
| `glm-codex` | `engineering-v1` | same shape; GLM engineer bindings |
| Operator `custom` | `engineering-v1` | every declared binding preserved, including intentionally different primary/deep/fallback/visual values |
| `muse-spark-1.3-contributor` | `engineering-v2` | main slot, Meta Direct route, xhigh |
| `muse-spark-1.3-contributor-opencode` | `engineering-v2` | main slot, OpenCode Go route, xhigh |

Preserved semantics (each covered by test): exact role-to-model assignments,
per-level provider selection with default fallback, exact reasoning levels,
reviewer `pinnedProvider: sol-local` + `readOnlyEnforced`, solver
`writeRequiresApproval` without provider lock-in, tool/vision capability gates,
Muse single-agent (`singleAgent`, no subagents, non-independent review),
Contributor tier, xhigh ceiling (`max` rejected on both planes), disabled-model
and unknown-model fail-closed behavior, and full custom-profile round trips.
Selection precedence (`DSH_AIH_PROFILE` > `AIH_ACTIVE_PROFILE` >
`data/settings.yaml engineering-profile:` > preset binding > policy default;
`aih-deepseek` locked; unknown ids resolve to `null`) is preserved unchanged
and exercised against the real legacy resolvers.

## 4. DSH adapter ownership (R2.3)

All DSH-specific identifiers live in `config/registry/dsh-adapter.cjs` and
nowhere else: canonical-`providerId` to installed DSH provider key map (all
eight legacy providers), canonical-`modeId` to internal preset map
(`engineering-v1` -> `aih-engineering`, `engineering-v2` -> `aih-muse`;
`engineering-v3` has no preset), `RuntimeModelBinding` to legacy target
projection, and legacy alias tables. The locked `aih-deepseek` preset is
reported, never weakened.

`legacyDshProviderId` was removed from canonical Provider records and from the
Provider validator (carrying it is now an `unknown-field` error). The adapter
is pure and offline: no DSH imports, no PowerShell, no session init, no
`settings.yaml` writes, no preset mutation, no inference, no routing decisions,
no credential material. Registry Core files import only `node:fs`/`node:path`/
`node:crypto` and sibling Core modules (blessed-dependency test).

## 5. Migration preview and rollback contract (R2.5)

- `detectLegacyFormats` reports present formats, malformed entries, the installed
  `engineering-profile` pointer (or its reported absence), and custom-profile
  presence. A missing `data/settings.yaml` is normal (preset/default fallback)
  and is reported, not an error.
- `planMigration` returns a machine-readable preview: detection, alias map,
  per-profile meta, proposed canonical configs, per-profile diffs
  (`canonical-id-change` for Muse, `adopted-verbatim` for Dual),
  incompatibilities, the captured legacy source, and a deterministic `planHash`.
- `verifyPlanIdempotent` proves byte-identical repeated planning.
- `createLegacyBackup` (explicit, separate from previews) captures raw file bytes
  with a per-file sha256 manifest; restored files are written with mode 0600
  and hash-verified. A preview can never leak secrets because it structurally
  cannot contain file bytes (see `describeLegacyFiles`).
- `restoreLegacySource` rebuilds a byte-exact copy in a guarded isolated
  directory: protected roots (including the backup source root), symlink
  aliases, path traversal, unexpected file keys, and unsafe overwrites are
  refused; absent files stay absent. Every destination is validated below the
  vetted root as well: symlinked config/ or data/ directories and symlinked
  destination files are refused without ever being followed (exclusive-create
  writes plus lstat/realpath post-verification mitigate check-then-write
  races); refused operations leave source files and permissions untouched. Re-planning the restored copy yields the
  identical `planHash` (semantic proof); per-file sha256 equality is the
  byte-exactness proof (`planHash` alone is not claimed as one).
- `applyPlanToIsolatedRoot` materializes previews for review and **refuses** the
  source root (`migration-refuses-production-target`).
- R2 never overwrites operator `settings.yaml`, custom profiles, provider
  configs, credentials, ledgers, or session data (hash-guarded by test).

Later activation requirements (not implemented in R2): full backup of the live
install, atomic write with revision conflict handling, restart integrity, and
an exercised upgrade/rollback path before any cutover.

## 6. Known unsupported legacy states

These fail closed on both planes or with documented hardening (parity suite):
unknown profiles/models/roles/reasoning; providers with no mapping; disabled
models; incomplete custom profiles (missing core roles); non-`sol-local`
reviewers; Contributor models bound to Dual roles (engine-scope mismatch);
`max` reasoning on Contributor tier; `engineering-v3` compilation
(planned/preview, not runnable). Disabled routes and revoked connections fail
closed on the Registry side (`route-unavailable`, `connection-auth-required`)
while the legacy oracle — which has no connection concept — still resolves;
this stricter direction is intentional hardening, not substitution.

## 7. Remaining R3–R6 obligations

- R3 UI must consume mode manifests and stay out of preset/session handling;
  running sessions stay pinned (R2.6 guard already proves the invariant).
- R4 discovery must run without DSH and must never treat listing as verified
  eligibility; credential references stay opaque.
- R5 subscription paths implement only sanctioned integrations; no
  subscription-to-API conflation.
- R6 controller binding consumes compiled snapshots through the thin adapter;
  duplicate resolvers retire only after the parity suite passes on the cutover
  branch with exercised upgrade/rollback.
- No interface in R2 assumes a second runtime beyond the existing
  `RuntimeCapabilities` descriptor; Rust/native work stays out of scope.

## 8. Deterministic parity verification (this commit)

- R2/R2.1/R2.1.1 suite: 41/41 pass (`node tests/RegistryR2Compatibility.Tests.cjs`).
- R1 core: 45/45 pass. R0 frozen baseline: 21/21 pass (fixtures unmodified).
- Composed routing matrix: 8/8 pass. Routing authority: pass.
- Dual parity: 2 profiles x 6 roles exact match; custom 6-role matrix exact match.
- Muse parity: both routes exact match modulo the expected canonical id change;
  raw (pre-canonical) compilation matches with zero id change.
- Failure parity: 7 invalid-state agreements plus 2 documented hardening
  divergences, all in the fail-closed direction.

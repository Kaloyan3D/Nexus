# Registry R3 — Registry-Backed UI & Configuration (Deliverable)

**Phase:** R3 (configuration experience, not execution cutover). **Not a production cutover.**
**Branch:** `feature/model-registry-v1`. **Spec:** `NEXUS_REGISTRY_ARCHITECTURE.md` v0.2 §5–7, §10–11, §13 Phase R3, §14, §20.
**Suites:** `tests/RegistryR3UI.Tests.cjs` (29 checks, offline) + updated route-contract pins in `tests/NexusControllerPanel.Tests.cjs`.
**Predecessors:** R1 core 45/45, R0 frozen baseline 21/21, R2/R2.1 compat 41/41, composed routing matrix 8/8 — all still passing (see §7).

## 1. Implemented UI architecture and verified visual description

No separate service, framework, or second application. R3 reuses the installed host verbatim:

```text
browser Engineering tab (ui/nexus-controller/lib/client.js, RegistryPanel)
  │  GET/PUT/POST ./nexus/registry/v1/*  (same loopback host webServer as the
  │                                        legacy engineering-profile routes)
  ▼
host adapter (ui/nexus-controller/lib/registry.cjs)
  │  bounded bodies (64 KiB) · same-origin-when-present · status mapping
  │  NO session/preset/settings/ledger access (R3.6 pin, by construction)
  ▼
Registry service (config/registry/service.cjs — host-independent, no DSH imports)
  │  canonical snapshot (legacy-import + muse-canonical) · resolver ·
  │  config-store persistence under <dataRoot>/registry/
  ▼
Registry Core (schemas / resolver / legacy-import / profile-compat, unchanged)
```

The Engineering tab now renders two stacked sections: **"Engineering Modes (Registry)"** first, then the unchanged **"Engineering Profile"** legacy editor with its exact previous states. The legacy mode-selector plugin (`ui/nexus-mode-selector`) is untouched — it stays the working new-session runtime control until R6.

Verified rendered output (offline VM smoke against the real bundle with
service-built fixtures; `RegistryR3UI` UI checks). With v2 selected the panel shows:

```text
Engineering Modes (Registry)
  Staged configuration (R3 preview): saves here are versioned preferences for
  future activation. They never modify the running session — the legacy
  controls below stay authoritative until R6.
  Mode: [ Engineering Mode v2 — Active / Legacy ]
  Saved Registry preference: Engineering Mode v2 · none yet
  Current legacy runtime: deepseek-codex (unchanged by Registry saves)
  Pending staged changes: none
  Validation: valid
  Main Engineer
    Model:     [ Muse Spark 1.3 Contributor ]
    Provider:  (•) meta-model-api · connected   ( ) opencode-go · connected
    Reasoning: [ xhigh ]   (levels filtered to the chosen route; max absent)
    Connection connected · api-key · transport unknown · context unknown · output unknown
    Contributor data-use tier: repository content shared through this route is
    governed by the provider's contributor policy. Routes never fall back across tiers silently.
  [ Adopt & save staged configuration ]   Not saved yet
```

v1 renders Engineer / Independent Reviewer / Approval-gated Solver cards plus an
**Advanced role overrides** section (Primary/Deep/Fallback/Reviewer/Solver +
optional Visual Reviewer) with per-role model/route/reasoning and
"differs from …" tags. v3 renders its five-slot Nova manifest (Planner,
Engineer, Reviewer, Verifier, optional Specialist) with every control disabled
and no save button. Live-verified facts: reviewer slot offers exactly
`sol-local/gpt-5.6-sol` (8 other routes listed disabled with reasons);
v2 main offers exactly the two verified Muse routes.

Screenshots: none captured — no browser-capableDevices harness with the DSH
web GUI is driven in this task (see §7 gates). The VM static-markup smoke is
the executed visual verification; a live-GUI screenshot remains R4+ work.

## 2. Public mode/slot presentation

| Mode | Status shown | Slots | Execution |
|---|---|---|---|
| Engineering v1 | Deprecated / Legacy | Engineer, Independent Reviewer, Approval-gated Solver + Advanced overrides | Runnable, staged |
| Engineering v2 | Active / Legacy | Main Engineer (single agent, no subagent slots) | Runnable, staged |
| Engineering v3 / Nexus Nova | Planned / Preview | Planner, Engineer, Reviewer, Verifier, Specialist (optional) | Preview-only: disabled, never compilable (`mode-not-runnable`) |

Rules enforced in code and tests: the selector is built only from
ModeDefinition manifests; legacy profile combinations (`deepseek-codex`,
`glm-codex`, `muse-…`) appear solely as adoptable *seeds* behind an
explicit "Seed from" control, never as modes; internal `aih-*` preset ids
appear nowhere in Registry payloads or markup (asserted by test); a planned
mode is never presented as runnable merely because its manifest exists
(`executable: false` + reason in every modes response).

Model, provider/route and reasoning are visibly distinct (model select,
provider radios grouped per model, reasoning select). Provider switches keep
the logical model whenever both routes share its identity and announce any
reasoning reset inline; reasoning options are always the chosen route's own
levels; incompatible routes render disabled with their resolver reason;
declared-vs-verified and capacity provenance (`declared`/`unknown`) are
shown; Contributor tier renders a prominent restriction notice. The UI never
invents entitlements and never claims unverified connectivity (connection
status strings come straight from Connection records).

## 3. Registry host API contracts

Exact-match routes on the existing host webServer registry (see §1 diagram):

```text
GET  /nexus/registry/v1/modes
     → { ok, modes: [{ id, displayName, status, selectable, runnable,
                       executable, executableReason, orchestrationEngineId,
                       slots, internalRoles, optionalCapabilities,
                       savedRevision, savedValid, persisted }], errors }
GET  /nexus/registry/v1/configuration?mode=<id>[&adopt=<legacyProfile>]
     → { ok, result: { modeId, persisted, revision?, source?, adoptedFrom?,
                       savedAtUtc?, config?, validation?, slotsManifest?,
                       runnable?, reason?, adoptable? } }
GET  /nexus/registry/v1/eligible?mode=<id>&slot=<slot>
     → { ok, modeId, slotId, eligible: [enriched routes],
         ineligible: [{ …route, ineligibleReason }] }
POST /nexus/registry/v1/validate   { config } → { ok, valid } | 422 validation-failed+details
POST /nexus/registry/v1/preview    { config } → { ok, snapshot } (non-secret, asserted)
PUT  /nexus/registry/v1/configuration
     { modeId, config, expectedRevision?, source?, adoptedFrom? }
     → 200 { ok, modeId, revision, resolutionId }
     → 409 stale-revision · 422 validation/compile errors · 413 payload-too-large
     → 403 origin-forbidden · 400/405/500 fail-closed codes
```

Write boundary: same trust boundary as the existing
`engineering-profile-action` route (loopback host GUI server; no new network
surface) **plus** hardening the legacy route lacks — 64 KiB cap, strict
schema, optimistic-concurrency revisions, same-origin-when-present checks
(absent Origin/Referer passes like existing UI fetches; a declared foreign
origin is rejected). Error details carry stable codes + non-secret ids only.
No provider-management, discovery, connect, or setup actions are exposed —
R4/R5 surfaces are absent by design, so no button promises unbuilt behavior.

## 4. Configuration storage and revision ownership

`config/registry/config-store.cjs` owns one document:

```text
<dataRoot>/registry/mode-configurations.json
  { schemaVersion: 1, updatedAtUtc,
    modes: { <modeId>: { revision, config, savedAtUtc,
                         source: operator-save | legacy-adopt,
                         adoptedFrom } } }
```

Ownership: the store module is the only writer; the service validates +
compiles before delegating; the host adapter only transports. Canonical =
stored ModeConfiguration; compiled snapshots are derived on demand and never
persisted. Guarantees (all tested): per-mode independence; monotonic
revisions with expected-revision checks (`stale-revision` fails closed, file
untouched); temp-file + atomic rename (failed writes leave no partial file or
temp behind); schema + secret scan + revision checks all run before any
mutation; malformed files report `registry-store-corrupt` and callers fall
back to legacy previews, never guesses; stored JSON is secret-free
(forbidden credential keys and secret-shaped values rejected; only opaque
`credential://` references and `conn-*` ids could appear — plain
ModeConfigurations carry neither). File mode 0600 best-effort.

## 5. Legacy import/adoption behavior

Initial state is empty — R3 never rewrites legacy profiles on startup (proven
by byte-hash guards over all five legacy inputs across saves). Adoption is
deliberate, reviewable, reversible: an unpersisted mode returns a
`legacy-preview` (default seeds: v1 ← `deepseek-codex`, v2 ← Meta Direct;
alternatives via `&adopt=`, blocked for mismatched pairs) showing source
profile, canonical-id status and server validation; only an explicit save
persists it (`source: legacy-adopt`, `adoptedFrom` recorded); re-adopting
or re-saving supersedes it. Dual imports preserve exact role bindings —
`deepseek-codex`/`glm-codex` previews are deep-equal to the R1 importer
output, and operator custom profiles round-trip every role override
(primary/deep/fallback/visual differences intact, never flattened into the
three slots). Reviewer `sol-local` pin, solver approval semantics, Muse
single-agent shape, Contributor tier and the `xhigh` ceiling (no `max`)
are preserved end to end and covered by the resolution fingerprint.

## 6. Session-pinning boundary

Hard boundary, structural — not a promise in prose. The service and store
take only `{ installRoot, dataRoot }`; they cannot name a session, preset,
or ledger, and the service surface exposes no session/preset/binding writer
(asserted). The host adapter never reads `session-bindings.json`,
`settings.yaml`, presets, or routing ledgers; post-save walks prove the
only file created is `registry/mode-configurations.json`. The UI states the
split on screen (saved preference vs current legacy runtime vs pending vs
validation) and every save notice ends with "Running sessions are unchanged —
activation lands with R6." Per-mode drafts survive mode switches so edits are
never silently lost; stale saves fail closed with reload guidance instead of
merging. Reviewer/solver authorization and Muse isolation keep their R2
semantics byte-for-byte (parity suites untouched and green).

## 7. Tests and actual results

Executed in this task (offline, no credentials):

| Suite | Result |
|---|---|
| RegistryR3UI (new, 29 checks: modes, previews, overrides, persistence, isolation, host boundary, UI smoke) | **29/29 PASS** |
| RegistryCore (R1) | 45/45 PASS |
| RegistryR2Compatibility (R2/R2.1) | 41/41 PASS |
| RegistryLegacyBaseline (R0 frozen) | 21/21 PASS |
| ComposedRoutingMatrix | 8/8 PASS |
| ComposedRoutingAuthority | PASS (tail: Muse target + authority ordering preserved) |
| NexusEngineContract | 26/26 PASS |
| MuseIsolation | 20/20 PASS |
| EngineeringIsolation | 6/6 PASS |
| NexusModeContract / PreferredRouteContract | PASS (pinned API + route authority intact) |
| NexusControllerPanel | route-contract section PASS with new 11-route pins; suite body **UNVERIFIED past the cordis block** — `@deepseek-ai/cordis` (via `app/package.json`) is absent in this checkout; identical crash on clean baseline `c5fbba3` (proven via worktree) |
| NexusProfiles | 8/8 checks before the react-client block PASS; tail **UNVERIFIED** — `react` (via `app/package.json`) absent here; identical crash on clean baseline |
| UI smoke (real bundle in VM with stubbed react, service-built fixtures) | PASS: v1/v2/v3 markup, tier notice, staged banner, no `aih-*`, v3 disabled with no save |
| Live-GUI screenshot / browser run | **UNVERIFIED** — no browser harness is driven here; render-panel-markup also requires the absent `app/` closure |

One expectation update, spec-driven and justified: the panel suite's exact
route count 6 → 11 plus kind pins for the five new R3 routes (R3 §11 adds
endpoints; the change extends the contract, it does not weaken it). No other
test expectation was touched.

## 8. Remaining R4–R6 work

- **R4:** provider add/edit/disable, manual model entry, capability probes,
  transport projection through the DSH adapter; discovery without DSH; route
  availability transitions (`discovered` → `verified`) with real probe
  evidence; provider display metadata (today names are honest raw ids).
- **R5:** sanctioned subscription/agent connection flows only; show
  `subscription-agent` vs `raw-model` distinctly; no ToS bypass, ever.
- **R6:** controller consumption of compiled snapshots for new sessions via
  the thin DSH binding adapter; retirement of duplicate resolvers only after
  parity on the cutover branch with exercised upgrade/rollback; live-GUI
  screenshot + restart/crash-recovery runs; then v3 orchestration design.
- Also open: friendly provider display names from a Nexus-owned source (not
  string-guessed), per-mode config history beyond latest revision, and
  live-GUI visual sign-off.

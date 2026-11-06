# Nexus DSH 0.2.x migration report

Branch: `feature/dsh-migration` (tracks `origin/feature/dsh-migration` at
`3b90bdd4bdbb39519ba5b4870de753db8d8ccea7`). Repository: `Kaloyan3D/Nexus`
(Nexus-only; the ArthurLabs-Ecosystem monorepo was deliberately not used).
Report date: 2026-11-06. Nothing was pushed, merged, opened as a PR or deployed.

## Final recommendation

**MIGRATION BLOCKED — the production pin is unchanged at `0.1.1-rc.2`.**
This is a feasibility and compatibility audit with reproducible evidence, not a
completed migration. The upgrade requires ports (below) that are engineering work,
not security impossibilities, except for CCv2 durable writers, which stay disabled.
No production dependency, config, installer or vendor file was modified, so the
installed Nexus DSH keeps its exact previous behavior and rollback is trivial.

Files added by this work (all additive):

| File | Purpose |
| --- | --- |
| `docs/integration/dsh-0.2.x-migration-report.md` | this report |
| `docs/integration/evidence/dsh-0.2.x/ownership-probe-darwin.json` | raw CCv2 ownership probe output |
| `docs/integration/evidence/dsh-0.2.x/suites-*-darwin.json` | per-suite status for baseline and 0.2.2-rc.1 probe |
| `tests/diagnostics/Dsh02OwnershipProbe.mjs` | real-handle writer-ownership probe (feasibility, not a safety test) |
| `tests/diagnostics/RunNodeSuites.cjs` | runs every `tests/*.Tests.cjs` against an installed tree |

## A. Version migration

| Item | Value |
| --- | --- |
| Currently pinned | `@deepseek-ai/dsh` and 20 sibling packages `0.1.1-rc.2`; `@deepseek-ai/dsh-agent@0.1.1-rc.2-nexus.1` (patched tarball); `cordis-plugin-group@1.0.1` |
| Selected target | `0.2.2-rc.1` (npm `latest` and `next`; GitHub pre-release `dsh-v0.2.2-rc.1`, 2026-11-04) |
| Upstream tag / commit | `dsh-v0.2.2-rc.1` → `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` in `deepseek-ai/deepseek-harness` (the repository is not `deepseek-ai/dsh`) |
| `@deepseek-ai/dsh@0.2.2-rc.1` integrity | `sha512-ijR9UEVYkG15Q/Q79JzvzLBzQOQfc63VLr9n6flpwHPhr5IKn2UxthnSoto/P9l7qGd7pPvI1Ra6TW7LH3oKpg==` |
| Newer than target | none; `0.2.2-alpha.3` is an alpha |

Upstream release notes (v0.2.0-rc.1, v0.2.1-rc.1, v0.2.2-rc.1) are user-facing
changelogs; **no migration guide exists**. Relevant items: automation tasks moved to
an optional plugin pack (0.2.0), plugin session-record API and agent presets for
subagents (0.2.1), pi-ai routing changes (0.2.1/0.2.2).

Package changes against the pinned set (probe install, `--ignore-scripts`):

- **Not published at 0.2.2-rc.1:** `dsh-code-runtime`, `dsh-invariants`,
  `dsh-subagent-in-process-driver` (and `cordis-plugin-group@1.0.1` has its own
  version line, latest `1.1.0`).
- **Gone from the installed tree:** `dsh-agent-presets`, `dsh-settings-file`,
  `dsh-client-runtime`, `dsh-host-apiproxy`, `dsh-workflow-worker-thread`,
  `dsh-code-runtime-worker-thread`, `dsh-tool-subagent-report`,
  `cordis-plugin-hmr`, `node-addon-landlock-run`.
- **Tree size:** 199 → 323–331 `@deepseek-ai/*` packages (plugin-pack architecture).
- `dsh-session-persistence-jsonl@0.2.2-rc.1` imports `@deepseek-ai/dsh-session-persistence`
  at runtime but does not list it as a dependency (only dev); it must be pinned
  explicitly in `runtime/package.json` or the runtime fails with `ERR_MODULE_NOT_FOUND`.
- **Baseline defect found (old runtime):** the vendored patched tarball
  `deepseek-ai-dsh-agent-0.1.1-rc.2-nexus.1.tgz` declares `peerDependencies` as
  `workspace:^` (`npm pack` without pnpm rewrite). `npm ci` on this host (npm 11.20)
  fails with `EUNSUPPORTEDPROTOCOL`; it installs only with `--legacy-peer-deps`.
  Whether the pinned Node 24.18.1 npm accepts it was **not** verified here. This
  is further reason the old patched package must not be carried to a new runtime.

## B. Architecture changes (upstream) and Nexus adaptations (required, not done)

| Surface | 0.1.1-rc.2 | 0.2.2-rc.1 | Nexus impact |
| --- | --- | --- | --- |
| Request routing authority | Nexus patch adds `payload.routingAuthority` ranked controller > preset > session > default, protected on `agent/request` | No such concept. `installModelSelection(agentCtx)` takes only the context; the step selection is **fixed at `agent/pre-step`** and `agent/request` that returns a different provider/model/effort now throws (`agent-loop/src/agent.ts:636-639`: "use agent.model.select() before step preparation"). Selections are a durable `model/selection` session event | `Controller-RequestBoundary.cjs`, `Routing-Integrity.cjs`, `Muse-Isolation.cjs`, `ContextCompilerActive*` use `routingAuthority`. Official extension point exists (`agent.model.select()` before step preparation) but it is **durable and adds a "[model changed…]" notice** to the transcript. Not behavior-equivalent to the old request-local route; needs design + prompt-prefix/cache evaluation |
| Shipped presets | `dsh/config/agent-presets/{code,…}/agent.cordis.yml` | `dsh` package has no `config/`; presets come from `dsh-agent-preset` / `dsh-agent-preset-registry` | `Install-ControllerPresets.ps1`, `Install-MusePreset.ps1`, `Build-DeepSeekPreset.ps1` read the shipped path and would fail |
| Web UI | `dsh-web-frontend` 0.1.1-rc.2 bundles patched by string replacement | New bundles | `Patch-NexusUi.ps1` hard-fails on any version but 0.1.1-rc.2 by design; Control Room/Composer/Controller panel patches (`Patch-ControlRoomUi`, `Patch-NexusComposer`) need re-derivation |
| Session storage API | `dsh-session` exports `decodeStorageRecord` | removed; storage is JSONL v4 via `session-persistence-jsonl` | `scripts/lib/Ccv2SessionLog.cjs`, CCv2 evidence readers |
| Subagents/workflow | `dsh-tool-subagent*`, `dsh-workflow-worker-thread`, `dsh-subagent-in-process-driver` | worker-thread/in-process-driver packages gone | `config/delegation-block.yml` |
| Provider substrate | `dsh-llm-pi-ai`, `dsh-settings-file` | `dsh-settings-file` gone | `Invoke-ProviderSubstrateProbe.mjs`, `Apply-OpenCodeSessionPatch.cjs` (patches `dsh-llm-pi-ai/lib/index.js`) |

**Vendor patch decision:** the routing-authority patch cannot be rebased: the file
it modifies (`model-selection.ts`) was redesigned and the hook it relies on was
replaced by an upstream invariant. No replacement patch was authored. Preferred
direction: implement controller-owned routing through the supported
`agent.model.select()` path, then prove cache/prefix and transcript equivalence
before dropping the vendored tarball.

## C. Feature compatibility

Status reflects what was actually executed. "Not tested" means no evidence either way.

| Feature | Status | Evidence |
| --- | --- | --- |
| Request-time controller/preset routing authority | **Blocked** | 5 suites that pass on 0.1.1-rc.2 fail on 0.2.2-rc.1: `ComposedRoutingAuthority`, `ComposedRoutingMatrix`, `MuseRoutingAuthorityOrdering`, `RuntimeRoutingTrace`, `ContextWireProjectorResponsesV2` |
| Transport-boundary Routing-Integrity unit logic | Fully working (pure unit) | `RoutingIntegrity.Tests.cjs` 8/8 on both; does not exercise the new runtime |
| Controller preset composition on shipped presets | **Blocked** | shipped preset path removed; `ControllerPresetInstalled` needs a real install root (fails on both here) |
| Nexus Control Room / Controller UI patches | **Blocked** | patch scripts pin 0.1.1-rc.2 bundles; UI contract suites fail on both here for missing install files, so no new-runtime evidence |
| Engineering Mode v2 / deterministic Controller / task identity / completion gates | Not tested on 0.2.x | controller logic is DSH-independent in most suites (`AihController.Tests` pass on both) but PowerShell suites (`TaskController`, `TaskIdentity`, completion) were **not run** (no pinned PowerShell/Linux install on this host) |
| Muse / OpenCode Go routing | Partially | pure suites pass on both (`MuseOpenCodeGo`, `MuseProvider`, `NativeOpenCodeGoRoute`); composed routing suites fail on 0.2.2-rc.1 |
| Context Compaction V1 | Not tested on 0.2.x | upstream `dsh-compaction` exists at 0.2.2-rc.1; V1 suites need the Linux install |
| Restricted CCv2 production policy (`ccv2-durable-mutation-disabled`) | Fully working, unchanged | `ContextRestrictedProductionV2` and `ContextRestrictedProjectionV2` pass; policy file untouched. `ContextRestrictedDshCompaction`/`InstallV2` fail on both runtimes on this host (environment) |
| Session creation / restore / persistence on 0.2.x | Partially | real persistence-handle probe (section E) ran; Nexus session binding/restore not exercised |
| Linux/Windows installers and upgrade | Not tested | clean-install/upgrade not run (see D) |
| Safe representative engineering task, local verification, restart/restore | Not tested | requires a runnable Nexus on 0.2.x |

## D. Verification

Host: macOS (Darwin), Node v26.13.0 (pinned runtime is 24.18.1), npm 11.20,
pwsh present but no pinned install. Both Fedora VM addresses (192.168.64.2,
192.168.65.4) timed out over SSH, so **no native Linux run was possible**.

Commands (installs under the session scratchpad; the repo was not touched):

```sh
# baseline: committed lockfile; only installs with --legacy-peer-deps (see A)
cd <scratch>/old-app/app && npm ci --ignore-scripts --legacy-peer-deps
# probe: Nexus package list, all @deepseek-ai/* at 0.2.2-rc.1, missing packages dropped,
# upstream dsh-agent instead of the vendored patch, plus dsh-session-persistence
cd <scratch>/probe-app/app && npm install --ignore-scripts --legacy-peer-deps
node tests/diagnostics/RunNodeSuites.cjs <repo> <scratch>/old-app   <out.json>
node tests/diagnostics/RunNodeSuites.cjs <repo> <scratch>/probe-app <out.json>
node tests/diagnostics/Dsh02OwnershipProbe.mjs <scratch>/probe-app <out.json>
```

| Run | Suites | Pass | Fail |
| --- | --- | --- | --- |
| Baseline, DSH 0.1.1-rc.2 (+ nexus.1 patch) | 174 | 124 | 50 |
| Probe, DSH 0.2.2-rc.1 | 174 | 119 | 55 |

- **Newly introduced failures: 5**, all in routing authority / request projection
  (listed in section C). **No suite flipped from fail to pass.**
- **Baseline failures: 50**, almost all environmental on this macOS pseudo-install:
  missing installed manifests (`.engineering-preset-closure.json`), no pinned
  Linux node/pwsh, Linux `/proc` dependence (`ContextLeaseFencing`), missing git
  identity for cross-process fixtures. They were **not** classified one by one and
  must be re-baselined on the supported Linux install before any pin change.
- A passing suite here does not prove 0.2.x compatibility when the suite is a pure
  unit test of Nexus code (it never loads the new runtime).
- **Not run:** PowerShell suites (all `*.Tests.ps1`), `Test-Harness.ps1`, clean
  install, upgrade from an existing isolated install, runtime startup, Controller
  frontend, live-provider or benchmark runs. These gates are **UNVERIFIED**, not
  passed. Windows (PowerShell 5.1 and native) is **UNVERIFIED**; Linux is
  **UNVERIFIED** for this migration.
- No user sessions, ledgers, credentials or configuration were read or modified;
  all installs and probe sessions were disposable temp directories.

## E. CCv2 verdict

**Original failure: not reproduced under equivalent tests, and not testable — the
stale-writer model no longer maps. The required guarantees are still missing.
Verdict: INCONCLUSIVE for the original harness, UNSUPPORTED for enforceable external
fencing.** The restricted production policy must stay.

The original 29-PASS/12-FAIL SIGSTOP campaign (`ContextLeaseFencing.Tests.cjs`) was
not ported: it targets `Session.append` + `SessionStore.flush` with a PowerShell
lease and `/proc` stop detection (Linux only), and the storage reader it depends on
(`decodeStorageRecord`) is gone. A harness API mismatch is **not** evidence of a fix.

What the new runtime provides (source: `packages/core/session`,
`packages/session/session-persistence*` at `66491b05`; behavior: real run,
`ownership-probe-darwin.json`, DSH 0.2.2-rc.1, Node 26.13.0, macOS only):

1. **Mutation and flush.** `Session.append` still commits synchronously to an
   in-memory log with no owner/fence parameter. `'session/event'` is post-commit and
   cannot veto; `SessionStore.flush` runs `'session/flush'` listeners in
   parallel with "no waterfall veto". Plugin records (`appendPluginRecord`, 0.2.1)
   use the same unfenced path.
2. **Durable writer ownership is a different mechanism.** The JSONL backend takes
   a kernel `flock` on `session.lock` for the life of a write handle. It is
   process-bound, **has no expiry by design** ("a live but wedged holder keeps the
   lock until its process exits"), and takes no external token.
3. **Equivalence with CCv2.** Upstream internal compaction (`dsh-compaction`,
   `/compact`) solves context size reduction; it has no HOT/WARM/COLD tiers,
   generation fencing or externally owned leases. It is not equivalent to CCv2.

Probe observations (durable handle level):

| Experiment | Result |
| --- | --- |
| E1: holder process SIGSTOPped for 4 s (longer than any short Nexus lease) | a second `write` open still gets `SessionAlreadyOwnedError`; after SIGCONT the stale holder's append and flush succeed (`append-ok`) with no fence supplied; after SIGKILL a successor acquires immediately |
| E2: lock file removed (the upstream-documented escape hatch for a wedged holder), successor appends seq 2, then the stale handle appends seq 2 and flushes | the stale handle's `append` and `flush` are **accepted with no error**; the log then fails to open: `SessionPersistenceCorruptionError … seq gap (expected 3, got 2)`. The backend detects the tear only on a later read |
| E3: handle API | `append(events, { signal })`, `flush({ signal })`; no owner/token/epoch parameter; `SessionOwnershipLostError` is declared but referenced **0 times** in the shipped JSONL backend (upstream JSDoc: "the shipped in-process backends never throw it yet") |

Answers to the six questions:

1. Mutation, history, compaction and flush: described above; in-memory append and
   post-commit observers remain unfenced.
2. Internal compaction is not equivalent to CCv2.
3. The external Nexus Controller **cannot** take part in enforceable writer ownership:
   the lease is a kernel lock held by the DSH host process, with no token, expiry or
   takeover protocol that a Controller could drive.
4. A stale writer is **not** prevented from appending in memory. Durable writes are
   excluded for the *live-holder* case (the kernel lock) but a suspended holder keeps
   ownership forever, so Nexus's expiring lease cannot revoke it; and if ownership is
   forfeited (lock-file removal) a stale handle can still append and flush and corrupt
   the log with no `SessionOwnershipLostError`. Recovery and finalization fencing for
   Nexus-owned generation state (A10/A11/A13 files) are entirely outside DSH.
5. No supported hook or transaction API exists that removes the original blocker.
   The declared `SessionOwnershipLostError` / lease contract is a promising seam for
   a future upstream change, not a present guarantee.
6. HOT/WARM/COLD assembly and generation-aware checkpoints can be built without
   changing session internals **only in the read-only/projection form already used by
   restricted CCv2** (request-time projection, immutable content-addressed stores).
   Durable generation-state writing remains unsafe.

**Missing capability, precisely:** a writer-held ownership primitive consulted by
append, flush, recovery and finalization, with revocable (expiring) or externally
arbitrated ownership. Concretely: a veto-capable pre-commit hook on `Session.append`
(or a fencing-token parameter on `Session.append` and `SessionHandle.append/flush`),
`SessionOwnershipLostError` actually raised by the backend when ownership is gone,
and a cross-process arbitration point shared with the Nexus Controller. A safe
integration proposal is: keep durable CCv2 disabled; if upstream ships the lease
layer, make the Nexus writer run inside the DSH host holding the handle and treat
`SessionOwnershipLostError` as the only revocation signal, then re-run the preserved
SIGSTOP campaign ported to the 0.2.x APIs on Linux before any activation. No CCv2
safety fix is claimed. `ContextDurableMutationPolicyV2.cjs` and the
`ccv2-durable-mutation-disabled` refusal were not changed.

Reading caveat: the four CCv2 documents were read as follows — the lease-fencing
investigation and restricted production scope in full; the 6,526-line architecture
document and the dev report were **not** read in full (only targeted for the frozen
requirements cited above).

## F. Remaining blockers and follow-ups

1. Re-baseline on the supported native Linux install (VM was unreachable) so the 50
   baseline failures can be separated from environment issues.
2. Design and port request-time controller routing to the 0.2.x
   `agent.model.select()` model; evaluate durable `model/selection` events and the
   injected "[model changed…]" notice against prefix-cache and transcript-integrity
   requirements; rewrite `Controller-RequestBoundary`, `Routing-Integrity`,
   `Muse-Isolation`, CCv2 active hosts and their five failing suites.
3. Replace shipped-preset path reads with `dsh-agent-preset` / registry composition
   in the three preset installers and `Validate-*Preset.cjs`.
4. Re-derive every UI patch against `dsh-web-frontend@0.2.2-rc.1` (Control Room,
   Composer, model selection, settings models); rewrite `Doctor.ps1` bundle checks.
5. Resolve package gaps: dropped packages, explicit `dsh-session-persistence` pin,
   subagent/workflow replacement, `cordis-plugin-group` line; regenerate
   `runtime/package-lock.json` and build a clean `npm ci` that does not need
   `--legacy-peer-deps`.
6. Fix the baseline vendored-tarball `workspace:^` peer-dependency defect if the
   old pin must keep shipping.
7. Run clean-install and upgrade tests for both installers (Linux native, Windows
   PowerShell 5.1) on real runners; run live-runtime acceptance (startup, Controller
   UI, session binding, safe task, verification, restart/restore).
8. Security: no weakening was introduced. The routing-authority port and the
   missing CCv2 fence are the two items that must keep their negative tests strict.

## G. Final recommendation

**MIGRATION BLOCKED.** Interfaces Nexus depends on (request-routing authority,
shipped presets, UI bundles, session storage reader) changed incompatibly, the
required CCv2 fencing is not provided upstream, and the native Linux/Windows gates
could not run. The branch contains audit evidence and probes only; the Nexus DSH
runtime remains on the previously verified `0.1.1-rc.2` pin.

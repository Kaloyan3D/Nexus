# Nexus DSH 0.2.x migration report

Repository: `Arthur-Labs-AI/ArthurLabs-Ecosystem`, system `systems/nexus/`.
Branch: `feature/nexus-dsh-0.2-migration` (from `main` at `217b3143`). Local commits
only: nothing was pushed, merged, deployed or applied to a production install.
The earlier audit (`Kaloyan3D/Nexus` `feature/dsh-migration`) was not merged; its
evidence files were carried over unchanged under `docs/integration/evidence/dsh-0.2.x/`.
No other system (Nexus Native, Sentry, A.R.T.H.U.R., website) was modified.

## Verdict

**PARTIALLY MIGRATED — the Nexus DSH backend runs on `dsh-v0.2.2-rc.1` and passes its
verification on native Linux; the UI is only partly restored and several named
features/tests remain unported.** It is not READY FOR REVIEW as a full migration.
Windows is UNVERIFIED. CCv2 durable writers remain disabled (unchanged policy).

What is genuinely working, each verified by the evidence in section D:

- strict dependency install (`npm ci`, no `--legacy-peer-deps`) on the pinned Node 24.18.1 / npm 11.16 toolchain;
- clean install and upgrade-in-place of the installer on Linux (aarch64, see limits);
- real DSH startup through Nexus's own launcher, token-authenticated Web UI, `READY`, stop and restart;
- the three Nexus agent planes (`aih-engineering`, `aih-deepseek`, `aih-muse`) mount on the real DSH composition, stock presets cannot be selected;
- controller-owned route selection on the real DSH agent loop (route, provider/model/effort, fail-closed guards);
- OpenCode Go header, provider-substrate routes, credentials and settings preservation, admission-gated Nexus web routes.

What is not done is listed precisely in section F.

## A. Version migration

| Item | Value |
| --- | --- |
| Old | `@deepseek-ai/dsh` and 20 siblings `0.1.1-rc.2`; patched `dsh-agent@0.1.1-rc.2-nexus.1`; `cordis-plugin-group@1.0.1` |
| New | `dsh@0.2.2-rc.1` (npm `latest`/`next`; GitHub pre-release `dsh-v0.2.2-rc.1`, 2026-11-04) |
| Upstream | `deepseek-ai/deepseek-harness` tag `dsh-v0.2.2-rc.1`, commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`; integrity `sha512-ijR9UEVYkG15Q/Q79JzvzLBzQOQfc63VLr9n6flpwHPhr5IKn2UxthnSoto/P9l7qGd7pPvI1Ra6TW7LH3oKpg==` |
| Newer release | none (`0.2.2-alpha.3` is an alpha); no migration guide exists upstream, only release notes |

`runtime/package.json` now pins exactly seven direct dependencies (the 22-package list is gone;
the tree is `@deepseek-ai/dsh`'s own closure): `dsh@0.2.2-rc.1`, `cordis-plugin-group@1.1.0`
(required peer of `dsh-app-boot`), `dsh-session-persistence@0.2.2-rc.1` (imported at runtime by
`dsh-session-persistence-jsonl` but only a devDependency there — an upstream packaging gap),
`dsh-subagent-codex@0.2.2-rc.1`, `openai-oauth@2.0.0`, `react`/`react-dom@18.3.1`, plus the security
`overrides` unchanged. It adds an `allowScripts` policy for the five install-script packages
(`koffi`, `node-pty`, `protobufjs`, `@google/genai`, `dsh-subprocess-local`); npm 11.16 treats it as
advisory today and will enforce it later. The lockfile resolves 690 packages and installs with
`npm ci --omit=dev` and no peer-dependency bypass. `--legacy-peer-deps` was removed from
`setup.sh` and `scripts/Setup.ps1`; the 0.1.1-rc.2 vendored tarball needed it because its
`peerDependencies` were left as `workspace:^` (it fails with `EUNSUPPORTEDPROTOCOL` on npm 11.16
and 11.20). `runtime/vendor/` and `runtime/patches/` are retained only as rollback material
for the 0.1.x pin (see B).

Removed upstream and not replaced 1:1: `dsh-code-runtime`, `dsh-invariants`,
`dsh-subagent-in-process-driver`, `dsh-agent-presets`, `dsh-settings-file`, `dsh-client-runtime`,
`dsh-host-apiproxy`, `dsh-workflow-worker-thread`, `dsh-tool-subagent-report`, `cordis-plugin-hmr`.

## B. Architecture changes

| Surface | 0.1.1-rc.2 | 0.2.2-rc.1 | Nexus adaptation (this branch) |
| --- | --- | --- | --- |
| Request routing | patched `routingAuthority` ranked controller > preset > session > default | none. The step route is fixed **before** `agent/pre-step` from the durable `model/selection` projection; a different provider/model/effort proposed at `agent/request` throws | `config/Controller-RequestBoundary.cjs`: **arm** with the supported `agent.model.select()` at `agent/inbox/claimed` and `agent/pre-step`, **guard** at `agent/request` (identity and Registry checks unchanged), fail closed on any mismatch. Vendored patch not carried over |
| Presets | directory scan of `data/.agent-presets/<n>/agent.cordis.yml`, shipped `dsh/config/agent-presets` | presets are `@deepseek-ai/dsh-agent-preset` plugin rows; home patch `$DSH_HOME/cordis.patch.yml` is a supported layer | `scripts/Build-NexusHomePatch.cjs` derives the three planes from the installed `standard` preset (strict structural checks), disables the four stock presets, projects Nexus settings into `agent-default-model`, `llm-pi-ai` and the registry default |
| Provider settings | `data/settings.yaml` (DSH settings file) | DSH imports **and renames** any `$DSH_HOME/settings.yaml` once | Nexus-owned document renamed `data/nexus-settings.yaml`; installer migrates the old file (no copy, no content change) |
| Session reads | `session.events` | removed; only deprecated `snapshotEvents()` | one reader, `config/Dsh-SessionEvents.cjs`, used by the isolation modules, shell-env identity and controller |
| OpenCode Go header | in-place edit of the pi-ai bundle | `llm-pi-ai/request-headers` waterfall | `config/OpenCode-SessionHeader.cjs` (same scope: `opencode-go` only, per-session, never logged); `Apply-OpenCodeSessionPatch.cjs` retired |
| Web auth | none | per-process token cookie for `/api` and the app shell only | launcher passes `--no-open`, opens the tokenized URL from the DSH banner, treats 401/403 as "listening"; **every Nexus route is gated with `ctx.connection.admit()`** because upstream states plugin routes enforce their own policy (33 controller routes + 2 brand routes, fail closed) |
| UI | string patches of compiled client bundles | plugins/slots | `scripts/Install-NexusUi.ps1` installs only the three `@nexus/*` plugins; `Patch-NexusUi`, `Patch-NexusComposer`, `Patch-ControlRoomUi` retired |
| Subagents/workflow | `list-agents`, worker-thread engine, per-worker `persona`/`backgroundMode` | control tool merged, `workflow-ptc`, no per-worker persona | `config/delegation-block.yml` is now the single 0.2.x source consumed by the generator |

### Routing semantics — what is *not* equivalent

The old mechanism was request-local and never entered the session. The new one is not, and this
is stated rather than hidden:

1. **Durable.** A controller route or effort change appends a `model/selection` event; a
   provider/model change also inserts DSH's "[model changed: …]" notice into the transcript
   (effort-only changes add none). Asserted in `RuntimeRoutingTrace` (E).
2. **Granularity.** The route is applied at turn start / message claim and prepared for the
   following step. A controller target that changes in the *middle* of a turn is refused for that
   step (fail closed) and applied on the retry; it is never applied silently
   (`ControllerRouteSelection` 3a/3b).
3. **Adaptive Muse effort** is computed once per arm, so it takes effect one step later than the
   old request-time computation (and request/state cannot disagree).
4. **Effort drift** on an unchanged route is refused, never re-leveled (test 5).
Prompt-prefix and cache behaviour under durable selections was **not** measured (no live
provider run); that evaluation is still owed before relying on mid-task re-routing.

## C. Feature compatibility

| Feature | Status | Evidence |
| --- | --- | --- |
| Dependency install, lockfile, clean `npm ci` | Fully working | Linux install; strict `npm ci --omit=dev` |
| Clean install / upgrade-in-place (Linux) | Fully working (aarch64 test copy of `setup.sh`) | install logs; upgrade preserved user setting marker, credentials and migrated settings |
| Real DSH startup via Nexus launcher, READY, stop/restart | Fully working | `aih` → `READY`; restart new PID, controller route 200 |
| Nexus agent planes (Engineering, DeepSeek-only, Muse) | Fully working | `Verify-NexusComposition` on macOS and Linux: all three mounted, stock presets absent, default `aih-engineering` |
| Controller-owned routing on the real agent loop | Fully working with the documented semantic changes | `RuntimeRoutingTrace` 5/5, `ControllerRouteSelection` 9/9, `ComposedRoutingMatrix` 8/8 |
| Muse and OpenCode Go (header, routes, reasoning map) | Fully working offline | `MuseOpenCodeSession` 13/13; substrate probe passes for `opencode-go` and `meta-model-api` (window 1048576, ceiling 131072, levels minimal..xhigh, `off`/`max` refused) |
| Engineering profile selection backend, workspace registration | Fully working | live `/nexus/engineering-profile.json` 200; live `/nexus/workspace-registration.json` resolved a real git project to its execution root |
| Operator/web route security | Improved (new) | unauthenticated 401, spoofed Host 403, authenticated 200 on the live server; `NexusRouteAdmission` 7/7 |
| Credentials and settings preservation | Fully working | `CredentialsCompat` 6/6 (DSH migrates a flat file into `refs:`, values identical, Nexus readers still resolve them, mode 600) |
| Skills runtime | Fully working | `Verify-SkillsRuntime` native boot loaded a fixture skill body on 0.2.2 |
| Controller Panel / brand / mode selector (UI) | Partially working | the real new UI loaded all three `@nexus/*` bundles; brand mark, Controller panel and the Mode picker rendered (macOS browser). The mode selector was **broken on 0.2.x** (it used the removed `connection.api`) and was ported to `remote.agentPresets`/`remote.settings`; the Overview/Activity/Verification/Files/Engineering views and operator gates were **not clicked through** |
| Task Control Room views, verification evidence, operator gates, completion authority end to end | Not tested live | controller/task suites on Linux (see D); no live session-driven task was run |
| Brand cosmetics: page title, favicon, PWA name, hero copy, sidebar width, send-button colour, model-badge guard | **Not ported** | string patches against compiled bundles have no supported equivalent; the page still says "DeepSeek Harness" |
| Composer preference seat (`nexusComposerPreference`) | **Not ported** | its patch is retired; the supported route is single-slot election of `conversation.input.model` — not implemented |
| Workspace-transition composer guard | **Not ported / UNVERIFIED** | upstream 0.2.2 added a pending-workspace chip state but does not disable the composer; supported route is a composer block (`useComposerBlock`) — not implemented. Execution root is still the immutable session cwd |
| Per-worker persona/background mode for `deepseek_normal`/`deepseek_deep` | Behaviour changed | options no longer exist upstream; workers inherit the plane persona |
| Context Compaction V1 | **UNVERIFIED on 0.2.x** | `ContextRestrictedDshCompaction` and the V1 compaction suites still target 0.1.x summarizer/region APIs; not ported |
| CCv2 restricted production policy | Unchanged, enabled, proven | `ContextDurableMutationPolicyV2.cjs` untouched; `ContextRestrictedProductionV2` 50/50 and `ContextRestrictedProjectionV2` 13/13 on the installed 0.2.2-rc.1 runtime |
| CCv2 wire-projector conformance against 0.2 pi-ai | **Failing, not ported** | `ContextWireProjectorResponsesV2` byte-exact bodies/tool-result shape differ (the only regression vs baseline); `ContextCompilerShadowV2` host-path proof was ported and passes (197/0) |
| Windows (PowerShell 5.1 and native) | **UNVERIFIED** | no runner; `Setup.ps1` edits are mirrored but unexecuted |
| Live provider behaviour, real engineering task, local verification run, session restore of a real task | **NOT RUN** | no provider credentials or benchmark authorized |

## D. Verification

Environments. **Authoritative:** Ubuntu 24.04 aarch64 (Lima VM `nexus-a1-linux`), pinned Node 24.18.1
and PowerShell 7.5.3 downloaded and SHA-verified like `setup.sh` does, DSH installed by the real
`setup.sh` (a test-only copy whose architecture detection accepts `aarch64`; the committed
`setup.sh` still rejects aarch64, and an x86_64 run was **not** possible). The macOS host was used
for JavaScript-only work and the browser check; its own `pwsh` crashes (`.NET FileLoadException`),
so no PowerShell result from macOS is counted. The Fedora VM would not start from the CLI.

```sh
# runtime
cd systems/nexus/runtime && npm ci --omit=dev          # strict, no --legacy-peer-deps
# real installer (VM test copy) — clean install, then in-place upgrade of a 0.1.1-rc.2 install
bash ./setup.arm64-test.sh --install-root ~/nx-cand --skip-deepseek-login --skip-openai-login --skip-path-check
bash ./setup.arm64-test.sh --install-root ~/nx-baseline --skip-deepseek-login --skip-openai-login --skip-path-check
# per-suite harness runner (reads the suite table of scripts/Test-Harness.ps1)
node tests/diagnostics/RunHarnessSuites.cjs <InstallRoot> <out.json> <privateTmp>
# real boot / composition proof
node scripts/Verify-NexusComposition.mjs <InstallRoot>
node tests/diagnostics/Dsh02OwnershipProbe.mjs <InstallRoot> <out.json>
```

### Results

| Run (Linux aarch64, per-suite runner over the harness suite table) | Suites | Pass | Fail |
| --- | --- | --- | --- |
| Baseline: DSH 0.1.1-rc.2 (+ patched dsh-agent), installed by the real installer | 180 | 123 | 57 |
| Candidate: DSH 0.2.2-rc.1, **clean install**, one full run on a single tree | 181 | 122 | 59 |
| Candidate after targeted reruns of the suites changed since that run (`NexusEngineContract`) | 181 | **123** | **58** |

- **Regressions against the baseline: 1** — `ContextWireProjectorResponsesV2` (CCv2 wire-projector
  byte conformance against the 0.2 pi-ai wire and tool-result shape; CCv2 stays restricted).
- **Fixed against the baseline: 0.** All 57 baseline failures still fail for their original reason
  (54 are the CCv2 laboratory/closure group, 3 are `Harness`, `NexusControllerPanel`,
  `RegistryInstalledRuntime`). A mid-session run that showed 11 CCv2 suites "fixed" was an artifact
  of my quick-sync copying laboratory modules into the install; the clean reinstall (authoritative)
  does not, and that run is the one counted here.
- **New suites, all passing:** `ControllerRouteSelection` (9), `NexusRouteAdmission` (7),
  `CredentialsCompat` (6). **Retired with their mechanism:** `MuseRoutingAuthorityOrdering`,
  `NexusComposerOwnership`. The totals therefore differ by +1 suite (181 vs 180).
- Suites ported to the new architecture and passing on Linux: `RuntimeRoutingTrace` (real loop, 5),
  `ComposedRoutingMatrix` (8), `ComposedRoutingAuthority`, `MuseIsolation` (20), `DeepSeekIsolation`,
  `EngineeringIsolation`, `ControllerSessionBootstrap`, `MuseOpenCodeSession` (13), `MuseInstall` (7),
  `SetupUpgrade`, `StartupProviderIsolation`, `NexusModeContract`, `NexusEngineContract` (26),
  `ContextCompilerShadowV2` (197), `MuseProviderRuntime`, `MuseOpenCodeGoRuntime`, `NexusSkills`,
  `ControllerPresetInstalled`, `EngineeringProfiles`, `ControllerRouting`, `PowerShellPortability`.
- `Harness` still fails, for a **pre-existing** reason: its source credential scan flags the CCv2
  redaction fixtures (`sk-abcdefghijklmnop1234`) in `tests/Context*.Tests.cjs`. I removed its
  retired UI-bundle assertions (replaced by an installer-contract fixture that passes) and did not
  touch the scan.

### Restricted CCv2 production policy (kept enabled, proven on the installed 0.2.2-rc.1 runtime)

The installed-tree harness cannot run these suites (their laboratory modules are deliberately not
installed — the same on the baseline). Run from the source tree against the installed runtime
(`AIH_HOST_APP`, pinned `pwsh` on `PATH`): `ContextRestrictedProductionV2` **50/50**,
`ContextRestrictedProjectionV2` **13/13**, `ContextApplyLockAuthority` pass.
`ContextRestrictedDshCompaction` fails: its fixture targets the 0.1.x compaction API (summarizer
result shape, `compactRegion`, session creation lifecycle), so **DSH compaction (V1) behaviour with
CCv2 writes disabled is UNVERIFIED on 0.2.x**; porting it needs the `SummaryResult` contract.
`ContextRestrictedInstallV2` was repointed at the new installer but not re-run after that edit.

### Functional acceptance (real runtime)

| Step | Result |
| --- | --- |
| 1. Start Nexus DSH | `aih` → `READY`, token URL printed, `STOPPED` on `aih-stop`, restart gives a new PID (Linux) |
| 2. Open the Controller frontend | real new UI loaded in the in-app browser (macOS); NEXUS brand, Controller panel, Mode picker (`Normal Engineering`, `DeepSeek Only`; Muse is engine-mapped) |
| 3–4. New session, select profile | blank session created by the UI; the mode picker was switched to `DeepSeek Only` (state change observed; the host `agentPresets/select` call itself was **not** observed); `/nexus/engineering-profile.json` 200 |
| 5. Model/provider routing | `RuntimeRoutingTrace`, `ControllerRouteSelection`, `ComposedRoutingMatrix`, substrate probe |
| 6. Bind session to project | live `/nexus/workspace-registration.json` resolved a git project; `ControllerSessionBootstrap` (real SessionStore) |
| 7. Safe engineering task | **not run live** (needs a provider); the real agent loop with an offline transport was run instead |
| 8. Local verification | `Verify-Project` / task suites in the harness (Linux) — not driven through the UI |
| 9. Controller-owned completion | controller/task suites pass; not exercised through a live session |
| 10. Restart/restore | process restart verified; session-log durability probed at the persistence layer only |



### Phase 1 — baseline classification (DSH 0.1.1-rc.2, Linux aarch64)

The earlier "50 baseline failures" came from a macOS pseudo-install and were mostly environmental.
A valid baseline on Linux gives **123 PASS / 57 FAIL of 180** suites
(`suites-baseline-linux-aarch64-dsh-0.1.1-rc.2.json`):

| Class | Suites | Meaning |
| --- | --- | --- |
| Installer closure | 22 | CCv2 laboratory suites `require('../config/Context…V2.cjs')` modules the production closure deliberately does not install |
| Expected: CCv2 restriction | 12 | active-algorithm suites hit `ccv2-durable-mutation-disabled`; they run only through `Ccv2ResearchRunner.cjs` |
| Environment | 14 | missing files/tools for CCv2/compaction laboratory harnesses, git identity |
| Needs triage | 9 | `Harness`, `NexusControllerPanel`, `RegistryInstalledRuntime` and six CCv2 live-host suites |

Fifty-four of the 57 are the CCv2 laboratory/closure group. None of them were hidden or
edited.

### Evidence files (all under `docs/integration/evidence/dsh-0.2.x/`)

`suites-baseline-linux-aarch64-dsh-0.1.1-rc.2.json`, `suites-final-linux-aarch64-dsh-0.2.2-rc.1.json`,
`nexus-boot-probe-linux-aarch64.json`, `nexus-boot-probe-darwin.json`,
`ownership-probe-linux-aarch64.json`, plus the earlier darwin files.

## E. CCv2 feasibility appendix

**Verdict: INCONCLUSIVE for the original SIGSTOP campaign; UNSUPPORTED for enforceable external
writer fencing. Nothing was re-enabled and nothing is claimed fixed.** The previous findings stand
and were re-run on the supported platform: `Dsh02OwnershipProbe` on Linux aarch64 / Node 24.18.1
reproduces the macOS observations exactly.

| Observation (real jsonl write handle) | Linux result |
| --- | --- |
| A second write-open while a holder lives | `SessionAlreadyOwnedError` |
| Holder `SIGSTOP`ped 4 s (any short Nexus lease would expire) | successor still refused |
| Holder `SIGCONT`, resumed append, no external fence supplied | **accepted** (`append-ok`) |
| Holder `SIGKILL` | successor acquires immediately (kernel releases the flock) |
| Lock file removed (upstream's documented escape hatch), stale handle appends and flushes | both **accepted**; the log then fails to open: `SessionPersistenceCorruptionError` (seq gap) |
| `SessionOwnershipLostError` | declared upstream, referenced 0 times by the shipped backend |

- **Internal DSH locking vs Nexus revocation.** DSH 0.2.x gives one process exclusive durable
  writer ownership per session directory via a non-expiring kernel `flock`. It has no external
  token, no expiry or takeover protocol and no pre-commit veto: `Session.append` is unfenced,
  `'session/event'` is post-commit, `'session/flush'` has "no waterfall veto". Nexus's CCv2
  semantics need the opposite: an *expiring*, externally arbitrated ownership whose revocation
  stops append, flush, recovery and finalization. An expiring lease cannot revoke a wedged DSH
  holder, and a forfeited lock does not stop its stale handle.
- **New surfaces examined:** plugin records (`appendPluginRecord`, ignorable, still unfenced), the
  `session-persistence-jsonl` generation publisher (exclusive current-generation publication, not
  a writer fence), the declared-but-unraised `SessionOwnershipLostError`.
- **Missing capability, exactly:** a writer-held ownership check consulted by append, flush,
  recovery and finalization with revocable ownership; a pre-commit veto or token parameter on
  `Session.append`/`SessionHandle.append|flush`; the backend actually raising
  `SessionOwnershipLostError`; and a cross-process arbitration point shared with the Controller.
- **Not ported:** the original `ContextLeaseFencing` campaign (it targets removed reader APIs and
  `/proc` stop detection, and its A10/A11/A13 writers are disabled by policy). A harness mismatch
  is not evidence of a fix. Any future attempt needs the preserved red regressions ported first.
- HOT/WARM/COLD assembly can only be built in the read-only projection form that restricted CCv2
  already uses; durable generation state stays unsafe. This was a feasibility assessment only.

## F. Remaining blockers and follow-ups

Failing or unported tests (not weakened, not hidden):
- `ContextWireProjectorResponsesV2` — the single regression against the baseline; needs the wire
  fixtures and the `run_code` tool-result path re-derived on the 0.2 pi-ai/executor;
- `ContextRestrictedDshCompaction` (and V1 compaction fixtures) — 0.1.x compaction/summarizer API;
- CCv2 host suites that assert `request.routingAuthority` in their request fixtures
  (Active/Shadow host suites) — they already fail on the baseline for the closure/restriction reasons
  and additionally need route attestation re-based on the selection model;
- `Harness` (pre-existing credential-scan hit on CCv2 redaction fixtures), `NexusControllerPanel`,
  `RegistryInstalledRuntime` — failing on the baseline for their own reasons, unchanged in kind;
- `Test-Tiers.ps1` (live provider tiers) writes a DSH `settings.yaml` into a probe home, which DSH
  0.2.x would import and rename; it needs the Nexus-document treatment before any live run;
- retired with their mechanism (documented): `MuseRoutingAuthorityOrdering` (the ranking mechanism no
  longer exists; replaced by `ControllerRouteSelection`), `NexusComposerOwnership` (composer-contract
  patch retired), `Validate-*Preset`, `Verify-RoutingIntegrityComposition`.

Product gaps: composer preference seat; brand cosmetics; workspace-transition composer guard;
worker personas; prompt-cache evaluation of durable selections; UI click-through of the Task
Control Room views and operator gates; a live end-to-end engineering task with provider.

Platform/process: Windows PowerShell 5.1 and native Windows install/upgrade; x86_64 Linux run of
the committed installer; the Fedora VM; macOS is not an installer platform.

Security notes: DSH 0.2.x has no server-wide auth for plugin routes (now handled in Nexus);
`dsh-subagent-codex` and the other plugins are upstream pre-release code; `Set-DeepSeekKey.ps1`
rewrites the credentials file wholesale, which also drops DSH's `records:` browser-session secret
(it is regenerated; existing browser sessions are invalidated) — a small hardening follow-up is to
update only the `refs:` block.

## G. Final recommendation

**PARTIALLY MIGRATED.** The backend, installer, routing, composition, security of Nexus routes,
credentials/settings preservation and the real startup path are on `0.2.2-rc.1` and verified on
Linux. The UI restoration is incomplete (plugin-only; cosmetics, composer seat and the workspace
guard are not ported), the CCv2 projection suites are red, Windows and x86_64 are unverified, and
no live provider behaviour was exercised. Do not merge as a complete migration; the next gates are
the items in F, with the CCv2 fencing question remaining a separate architecture task.

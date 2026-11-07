# Nexus DSH 0.2.x migration report

Repository: `Arthur-Labs-AI/ArthurLabs-Ecosystem`, system `systems/nexus/`.
Branch: `feature/nexus-dsh-0.2-migration` (from `main` at `217b3143`). Local commits
only: nothing was pushed, merged, deployed or applied to a production install.
The earlier audit (`Kaloyan3D/Nexus` `feature/dsh-migration`) was not merged; its
evidence files were carried over unchanged under `docs/integration/evidence/dsh-0.2.x/`.
No other system (Nexus Native, Sentry, A.R.T.H.U.R., website) was modified.

## Verdict

**GO FOR PR REVIEW - Linux aarch64 scope only. This is not approval to merge or release.** Linux x86_64, Windows,
live-provider acceptance and the real-credential model catalog are UNVERIFIED (section J11). The final
release-candidate campaign (section J) ran the real `scripts/Test-Harness.ps1` lanes, real-browser smoke tests on the
actual DSH `0.2.2-rc.1` server in an isolated Lima VM, a security sweep, a fresh install and an in-place upgrade, and
found **five regressions that earlier offline tests and an earlier, less faithful test runner had missed**; all five are
fixed, covered by regression tests and committed (J6). The test totals in sections D and H that read "0 regressions",
"86/104" and "43/81" were produced by a runner that did not reproduce the harness environment; **they are superseded
by section J9** and kept only for history.

Final numbers on the tested tree (fresh install, real harness, J9):

- production lane: **103 / 105** suite rows pass; the 2 failures (`ContextRestrictedProductionV2` on an installed tree,
  `Harness` credential-shaped test fixtures) fail identically on a fresh DSH 0.1.1-rc.2 baseline and are not behavioural
  (J9);
- CCv2 laboratory lane (source-tree root): **68 / 81** pass; the 13 remaining failures are host-pinned live-host proofs
  of the DSH 0.1.1-rc.2 contract and 0.1-API laboratory fixtures, intentionally retained (J9);
- restricted CCv2: policy file byte-identical to the base commit, `ccv2-durable-mutation-disabled` untouched,
  `ContextRestrictedProductionV2` 50/50, `ContextRestrictedProjectionV2` 13/13, `ContextRestrictedDshCompaction` 7/7;
- security sweep: 14 routes, 280 checks, 0 failures, no state change after refused requests (J7);
- DeepSeek-only model chooser validated in a real browser (J5).

Not covered (UNVERIFIED): a live provider turn (the V1 controller compaction bridge, now ported to 0.2, has not run
through a live session), Linux x86_64, Windows, the model catalog with a real credential (a placeholder key and a dead
egress proxy were used), a backend-RPC rejection of an un-routable model selection (the UI guard and unit tests cover it).

The earlier verdict text is retained below for the history of the migration.

### Earlier verdict (superseded by J)

**READY FOR REVIEW for the Linux aarch64 scope. NOT release-ready: Linux x86_64, Windows and live-provider
acceptance are UNVERIFIED.** The Nexus DSH backend, installer, routing, composition, route security, UI plugins
(Controller panel, Task Control Room, operator gates, engineering profile, composer preference seat,
workspace-transition guard, branding) and ordinary DSH compaction run on `dsh-v0.2.2-rc.1` and were exercised in a
real browser against a real server.

Verified (evidence in sections D and H):

- strict dependency install (`npm ci`, no `--legacy-peer-deps`) on pinned Node 24.18.1 / npm 11.16; clean install, upgrade-in-place, restart;
- real DSH startup through Nexus's launcher, token-authenticated Web UI, restart/restoration of a bound task from authoritative records;
- the three agent planes mount on the real composition; controller-owned route selection on the real agent loop;
- real-browser acceptance of every named UI surface with displayed state compared to authoritative records (section H);
- 208-check unauthenticated sweep of all 13 Nexus routes: 0 leaks, 0 mutations;
- ordinary DSH compaction, flush and restore with `ccv2-durable-mutation-disabled` untouched (7/7).

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
| Controller Panel / mode selector / Task Control Room / gates / profile (UI) | Fully working in a real browser (Linux server) | section H: every view compared with seeded authoritative records; four real defects found and fixed (session identity, seat priority, slot scope, launcher handoff) |
| Task Control Room views, verification evidence, operator gates | Fully working (fixture-driven) | Overview/Activity/Verification/Files/Engineering rendered; gate approve wrote the resolved journal record; completion authority stays with the Controller (task status unchanged). A live model-driven task was NOT run |
| Brand: title, favicon, mark, theme | Restored by supported means | title suffix rewrite + `<link rel=icon>` served behind admission (`@nexus/ui-brand`); hero headline and PWA manifest name are **not** restorable via a supported API (single-owner locale namespace / build-time manifest) - documented gap |
| Composer preference seat | Restored (supported slot election) | `conversation.input.model` registered at priority -100 (lowest renders); Engineering sessions get the profile selector, DeepSeek-only sessions a model chooser over the per-session ModelDirectory; `NexusComposerSeat` 4/4, browser-verified |
| Workspace-transition composer guard | Restored (supported composer blocks + version-locked method wrapper) | blocks every known session while any `openWorkspace` is in flight; stale pick cannot unblock a newer one; unsupported host shapes report `unavailable` (never silent); `NexusWorkspaceGuard` 7/7; browser-verified |
| Per-worker persona/background mode for `deepseek_normal`/`deepseek_deep` | Behaviour changed | options no longer exist upstream; workers inherit the plane persona |
| Ordinary DSH compaction (CCv2 disabled) | Fully working | `ContextRestrictedDshCompaction` 7/7 on the real 0.2 engine: `compactNow`, lifecycle markers, `compact-checkpoint` provenance, flush barrier, restore into a fresh store; the V1 `ContextCompaction*` F-series remain red for their baseline reasons (hard-coded `/home/kaloyan` paths, no `pwsh` on PATH) |
| CCv2 restricted production policy | Unchanged, enabled, proven | `ContextDurableMutationPolicyV2.cjs` untouched; `ContextRestrictedProductionV2` 50/50 and `ContextRestrictedProjectionV2` 13/13 on the installed 0.2.2-rc.1 runtime |
| CCv2 wire-projector conformance against pi-ai 1.5 | Fixed | `ContextWireProjectorResponsesV2` 83/0; byte conformance verified against the real pi-ai conversion (tool-role results, leading system merge, `<system-reminder>` mid-conversation system turns, foreign thinking dropped) |
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
  redaction fixtures (credential-shaped `sk-…` test strings) in `tests/Context*.Tests.cjs`. I removed its
  retired UI-bundle assertions (replaced by an installer-contract fixture that passes) and did not
  touch the scan.

### Final matrix (clean install, Linux aarch64, per-suite runner, both lanes)

| Lane | Suite rows | Pass | Fail |
| --- | --- | --- | --- |
| production | 104 | 86 | 18 |
| ccv2-lab (non-installed research) | 81 | 43 | 38 |
| total (183 unique suites; `NexusControllerPanel` and `ContextCompactionF1Loop` appear twice in the table) | 185 | 129 unique | 54 unique |

Classification against the verified baseline (`suites-baseline-linux-aarch64-dsh-0.1.1-rc.2.json`):
**regressions 0**; fixed: `ContextRestrictedDshCompaction`; absent: `MuseRoutingAuthorityOrdering`,
`NexusComposerOwnership` (retired with their mechanisms). After the targeted reruns in
`targeted-reruns-linux-aarch64.json` (`NexusControllerPanel` now PASS, `RegistryInstalledRuntime` 3/3) **52** unique
suites still fail, **all baseline failures** and none of them hidden:

- ccv2-lab (38): `ccv2-durable-mutation-disabled` active-algorithm suites, lab modules deliberately not installed,
  and `NEXUS_REQUIRE_CCV2_LIVE_HOST` live-host proofs without a pinned host;
- production lane (14): `ContextRestrictedProductionV2` / `ContextRestrictedProjectionV2` (cannot run on the
  installed tree; **pass from the source tree against the installed runtime: 50/50 and 13/13**, plus
  `ContextRestrictedDshCompaction` 7/7), `Harness` (credential scan flags CCv2 redaction fixtures), and the
  `ContextCompaction*` V1 F-series (hard-coded `/home/kaloyan/...` runtime paths, `spawnSync pwsh ENOENT`).

The lanes are `scripts/Test-Harness.ps1 -Lane production|ccv2-lab|all` (default `all`; the lane summary is always
printed) and `RunHarnessSuites.cjs ... --lane`; `tests/HarnessLanes.Tests.cjs` pins the partition and
`docs/testing/CCV2-LAB-SUITES.md` lists the lab suites. Evidence:
`suites-production-lane-linux-aarch64-dsh-0.2.2-rc.1.json`, `suites-ccv2-lab-lane-linux-aarch64-dsh-0.2.2-rc.1.json`.

Install/upgrade/restart/settings: clean install on a fresh root completed with only the three environmental local
checks failing (no DeepSeek credential, launcher not on PATH, no `xdg-open`); `SetupUpgrade`,
`CredentialsCompat`, `MusePresetCleanInstall`, `MusePresetDependencyClosure`, `SourceCompleteness` pass in the
production lane; the launcher was stopped and restarted (new pid, new token) with task state restored.

### Restricted CCv2 production policy (kept enabled, proven on the installed 0.2.2-rc.1 runtime)

The installed-tree harness cannot run these suites (their laboratory modules are deliberately not
installed — the same on the baseline). Run from the source tree against the installed runtime
(`AIH_HOST_APP`, pinned `pwsh` on `PATH`): `ContextRestrictedProductionV2` **50/50**,
`ContextRestrictedProjectionV2` **13/13**, `ContextApplyLockAuthority` pass.
`ContextRestrictedDshCompaction` was rewritten for the 0.2 engine and passes 7/7 (see the final matrix).
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

## H. Real-browser acceptance (Phases 2-3)

Environment: Lima VM `nexus-a1-linux`, disposable install, the real launcher (test-only copy on port 3081), the
Claude desktop built-in browser through an SSH tunnel. No provider credentials; no paid call. Authoritative
records were produced by `tests/diagnostics/SeedAcceptanceFixture.cjs` (real `status.cjs`/`gate.cjs` code, refuses
non-disposable roots). Full per-test evidence: `evidence/dsh-0.2.x/browser-acceptance.json`.

| Acceptance test | Result |
| --- | --- |
| Controller panel vs records (VERIFYING, TASK-0042, attempt 2/3, 1/2 verification failed, review required) | PASS |
| Overview / Activity / Verification / Files / Engineering tabs | PASS |
| Operator gate approve -> resolved journal record (`resolvedBy operator-gui`), task status untouched | PASS |
| Engineering profile selection -> `engineering-profile: glm-codex` in `nexus-settings.yaml` | PASS |
| Mode picker -> composer seat flips engineering <-> legacy | PASS (mount); catalog UNVERIFIED (no credentials) |
| Pending workspace pick: composer replaced with the guard reason, cleared on landing | PASS |
| Rapid A-then-B selection, session creation during transitions: last pick wins, no stuck block, one session per workspace | PASS |
| Session switching: only the bound session shows the task; blank/unknown ids show none | PASS |
| Outage and restart: "Reconnecting...", then restoration from records with a new controller pid | PASS |
| Unauthenticated sweep: 13 routes x 4 variants x 4 methods = 208 checks, 0 failures, no journal change | PASS |
| Authenticated routes (cookie): 200 where applicable | PASS |

Defects the real browser found (all fixed, with offline regression tests): the Controller drawer and mode selector read
`sessions.current`, which DSH 0.2 does not have (the panel showed "No managed task" for a bound session;
`NexusSessionIdentity`); the seat was registered at the wrong end of the priority order and through a scope that
does not carry `slots`; the launcher workspace handoff called a non-existent `ctx.workspaces.startSession`.

**Incident to disclose.** A first page load went to host port 3080, which is the user's real Nexus install
(macOS process started the day before, not by this work), so the Lima port forward did not bind. The page's normal
startup created one blank session there (`sessions/--Users-kaloyannikolov-AI--/session-85e9a396-...`) and updated
`workspace.json` / `session_projcache.json`. No file of the install was edited or deleted by this work; the
blank session is left for the user to remove. All later runs used port 3081 inside the VM.

Cannot be automated/verified here: live model turns and Controller routing on a real request, tool execution,
Controller-owned completion on a real task (Phase 6, no authorization); the legacy chooser's catalog; Windows and
x86_64 browser runs.

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

> Updated by section J (final release-candidate validation): the 52-suite count below came from the earlier, less faithful runner; the current classification is J9.

Not release blockers for Linux aarch64 review, but required before a release claim:
- Linux x86_64: run the committed `setup.sh` (it rejects aarch64) and this matrix on a genuine x86_64 host - UNVERIFIED; the modified ARM64 test copy is not evidence for it;
- Windows (PowerShell 5.1 and native install/upgrade/browser) - UNVERIFIED, no runner;
- Phase 6: one bounded live engineering task (session, Controller routing, tool execution, deterministic verification, Controller-owned completion, restart, UI evidence) needs provider credentials and explicit authorization for paid calls - UNVERIFIED;
- re-observe the legacy model chooser with credentials (the empty-control fix was applied after the last browser pass);
- hero headline copy and PWA manifest name cannot be restored through a supported API;
- the guard wraps `uiWorkspace.openWorkspace` because upstream keeps the pending state private; it is version-locked and reports `unavailable` (console error + `nexusWorkspaceGuard` service) on a different shape, so an upstream change cannot fail open silently, but should be re-checked on every DSH bump (propose an upstream observable);
- 52 baseline-failing suites remain (38 CCv2 lab, 14 production-lane); the production-lane ones are `ContextRestricted{Production,Projection}V2` on an installed tree (pass from source), `Harness`, and the V1 `ContextCompaction*` F-series with hard-coded paths - none was weakened;
- `Test-Tiers.ps1` writes a DSH `settings.yaml` into a probe home that 0.2.x would import and rename (needs the Nexus-document treatment before any live run);
- the user's real install still has an extra blank session from the first mis-targeted page load (section H);
- `Set-DeepSeekKey.ps1` rewrites the credentials file wholesale and drops DSH's `records:` block (regenerated; invalidates browser sessions).

CCv2: unchanged. `ccv2-durable-mutation-disabled` is enforced, durable generation writers and mutating recovery stay off,
external writer fencing is UNSUPPORTED by 0.2.2 (section E); the original fencing failure evidence is preserved.

## G. Final recommendation

> Superseded by section J12 (GO FOR PR REVIEW, Linux aarch64 scope only). The earlier text is kept for history.

**READY FOR REVIEW (Linux aarch64 scope); NOT release-ready.** The migration is demonstrably working: installed
and launched through Nexus's own scripts, exercised in a real browser against authoritative state, secured by an
admission gate that a 208-check sweep could not breach, with 0 regressions against the baseline and four suites
turned green. Merge only after the x86_64 and Windows gates and a bounded live task (Phase 6) are run by someone
with those environments and credentials; keep CCv2 fencing a separate architecture task.

## J. Final release-candidate validation (2026-11-07)

Evidence: `docs/integration/evidence/dsh-0.2.x/rc-validation/` (logs, per-lane reports, sweeps, screenshots; credential-shaped
test fixtures are redacted to `sk-<fixture-redacted>`). Nothing was pushed, merged or deployed; no `Co-Authored-By` trailers.

### J1. Tested revision and environment

| Item | Value |
| --- | --- |
| Source revision tested | `038c98f9` (tree `536b6213`), branch `feature/nexus-dsh-0.2-migration`, 19 commits over base `217b3143` (the task text said 13; the branch carried 14 before this campaign, this campaign adds 5). The installed tree is that revision; the only later change is this report plus the evidence directory (documentation only). |
| Platform | Lima VM `nexus-a1-linux`: Ubuntu 24.04.5 LTS, Linux 6.8.0-147 **aarch64** (host: macOS, arm64) |
| DSH / Node / PowerShell | `0.2.2-rc.1` / v24.18.1 / 7.5.3 (all pinned by the installer) |
| Baseline | fresh install of the base commit `217b3143` with its own pinned DSH `0.1.1-rc.2`, its own `Test-Harness.ps1` |
| Installer | `setup.sh` through a test-only copy that accepts aarch64 (the committed script still rejects it) |

### J2. Environment safety (the earlier incident must not repeat)

- Host listeners inspected before anything started: port 3080 is the user's real Nexus (node pid 96363, started 2026-11-06, unchanged
  throughout this campaign). The earlier incident session was **not** touched or deleted.
- The test server ran only inside the VM on a dedicated port (3187, verified free in the VM and on the host). Before any browser
  navigation the endpoint identity was established: the host listener on 3187 is Lima's forward (`limactl`), the VM process
  runs with `DSH_HOME=~/nx-cand/data`, and authenticated responses carry VM-only paths (`/home/kaloyannikolov.guest/...`) that cannot exist
  on macOS. Every browser load used `127.0.0.1:3187` (or the VM-side delay proxy on 3190, same identity checks).
- The test server ran with a placeholder key and `HTTPS_PROXY` pointed at a dead local port; the VM process opened **0 external sockets**.
  DSH tried to list models from the provider once and the dead proxy refused it (logged), so nothing left the VM.
- **Near miss, blocked:** I once ran a VM-only launch script on the Mac. It contains `pkill -f "[d]sh/lib/bin.js web"`, which would
  have matched the user's real server. The permission layer denied the call before it executed; the real process was verified alive
  afterwards. All later launches went through `ssh` only.

### J3. Git and migration integrity

- Branch and tree clean at the start; 19 commits over `217b3143`; **no file outside `systems/nexus/` changed**; no binary or generated
  artifact except the 8 small evidence screenshots (about 150 KB, intentional); no `Co-Authored-By` in any commit; no credential or key in any added line
  (the only pattern hits are documentation and redacted fake fixtures); the one credential-named file touched is a test.
- `config/ContextDurableMutationPolicyV2.cjs` is byte-identical to the base commit (`git diff` empty, `cmp` identical).

### J4. DeepSeek-only model chooser (highest-priority check)

Real browser, real DSH 0.2.2-rc.1 server, DeepSeek Only mode (screenshots `01`, `08`):

| Check | Result |
| --- | --- |
| Catalog loads | 6 models from `session.modelCatalog()` (DeepSeek V4.1 Flash, V4 Pro, V4 Pro MAX direct, V4 Flash MAX direct, V4 Flash High direct, V4 Flash Vision direct); with no catalog the control shows the saved selection marked "(not in catalog)" and is disabled, never empty |
| Selection updates the intended session | picking V4 Pro MAX (direct), then V4 Flash High (direct) was reflected in the session projection `modelSelection.pending` within the flush interval (`flash-high-direct / deepseek-v4-flash`), same session id, `agentPreset=aih-deepseek` |
| Reload / reconnection | selection and mode survived page reload, a server stop (UI showed "Reconnecting...", Controller badge `UNAVAILABLE`) and restart without reload |
| Invalid selection | a forged option value is ignored by the control; state unchanged. A backend-RPC rejection of an un-routable model was **not** exercised through the browser (UNVERIFIED; covered by `ControllerRouteSelection` 9/9 and `RuntimeRoutingTrace` 5/5) |
| Model/effort consistency | the PREFERRED pill is only shown while it names the session's actual selection (see defect 2 in J6) |
| Controller authority | in Normal Engineering the chooser is replaced by the Engineering profile selector; routing stays Controller-owned (`RuntimeRoutingTrace` D: a route rewritten after the controller boundary fails closed) |

### J5. Controller / Engineering UI, workspace transitions

- Controller panel, Control Room tabs (Overview, Activity, Verification, Files, Engineering), mode picker, composer seat, engineering
  profile selection (`glm-codex` persisted and shown as PREFERRED `GLM-5.3-Flash HIGH`), session and workspace switching (panel follows the
  displayed session: bound task, then "No managed task", then bound again) all matched the authoritative records (`ev-model-selection.txt`, `ev-gates.jsonl`).
- Operator gates: stale gate id 409, unknown action 422, missing ids 400, foreign session 404, replay of a resolved request 409; **Reject** and **Approve**
  clicked in the UI each wrote exactly one ledger row (`ev-gate-actions.jsonl`); Approve with a failing verification did **not** complete the task (still VERIFYING, Controller refuses).
- Workspace transitions with a response delay proxy: during A to B (1.5 s), rapid A to B to A, and a New Session click mid-pick the composer stayed
  non-writable (`contenteditable=false`, `aria-disabled`, "Switching workspace...") and unlocked once, bound to the last workspace; no extra session was created.
  A server-side `openWorkspace` failure could not be injected through the browser; the failure/stale-token paths are covered by `NexusWorkspaceGuard` 7/7 and an unsupported host shape fails
  visibly (`nexusWorkspaceGuard.status = unavailable`, logged) in that suite.

### J6. Regressions found in this campaign and fixed (each with a regression test)

| # | Found by | Defect | Fix (commit) |
| --- | --- | --- | --- |
| 1 | browser | the mode picker called `remote.settings.update` with 2 arguments; DSH 0.2 Remote methods validate arity (`ns, patch, expectedRevision`), so every mode change ended in "expected 3 argument(s), got 2". The offline fake did not enforce arity | strict fake + explicit argument (`65a4e137`) |
| 2 | browser | a DeepSeek-only session's PREFERRED pill read the global `agent-default-model` and contradicted the chooser after a model was picked | pill follows the per-session `ModelDirectory` selection, slot provides the session id (`65a4e137`) |
| 3 | real harness env | the V1 controller compaction bridge read the removed `session.events` (silently inert on 0.2), appended `{start,end}` replace ops (0.2 requires `{startSeq,endSeq}`), and proved durability from a partial header (0.2 validates the full header, so every durable proof stayed `awaiting-durability`). `ContextCompaction{Acceptance,Crash,F9TailBound,F1Loop,F2Prod,F5Prod,F5Slow,Partial}` pass on the 0.1.1 baseline and failed here | reader adapter, op shape, full header, fixture fidelity (`37f57169`); the two CCv2 laboratory V2 writers keep their original shape (`d6e1d9bb`) because lab doubles pin it |
| 4 | browser | after the picker call was fixed, the save still failed: "Configuration for agent-preset-registry is overridden by a home patch" (DSH 0.2 pins the registry from the generated patch), so the default for new sessions was never persisted | admission-gated `POST /nexus/mode-default.json` (whitelisted presets, no path input) writes `nexus-settings.yaml`, regenerates and verifies the home patch, rolls back on failure (`47061b78`) |
| 5 | fixing 4 | `Verify-NexusComposition.mjs` hard-coded `aih-engineering` as the only acceptable registry default, so any saved non-engineering default made the next install/upgrade fail closed | verifier compares with the default declared in `nexus-settings.yaml` (`47061b78`) |

Test-only follow-ups (`038c98f9`): route count 33 to 34 and the new path in `NexusControllerPanel`, persisted-default sink in `NexusEngineContract`,
bridge-contract string in `SetupUpgrade`. These assertions changed because the contract changed (new route, new persistence seam), not to raise a count.

### J7. Security regression sweep

`tests/diagnostics/NexusAuthSweep.cjs` on the final tree: **14 routes, 280 checks, 0 failures** (4 unauthenticated variants plus a valid session cookie; every route and method),
versus 13 routes / 208 checks previously (the 14th route is `/nexus/mode-default.json`; 52 checks added with the valid-cookie variant). Unauthorized reads and mutations get 401/403;
state files (`nexus-settings.yaml`, `cordis.patch.yml`, gate ledger, session bindings) are byte-identical after the sweep; an unauthenticated `POST /nexus/mode-default.json`
returned 401 and left the saved default unchanged. The same sweep on the upgraded install: 280 checks, 0 failures. Files: `auth-sweep-final-tree.json`,
`auth-sweep-upgraded-install.json`, `auth-sweep-authenticated-and-unauthenticated.json` (previous tree).

### J8. Compaction and context safety

With `ccv2-durable-mutation-disabled` active: `ContextRestrictedDshCompaction` 7/7 (compaction triggers, `compaction/start`..`end`, `compact-checkpoint` provenance, history shrinks around retained recent history,
`session/flush`, restore into a fresh store with an identical derived conversation, policy unchanged); `ContextRestrictedProductionV2` 50/50 and `ContextRestrictedProjectionV2` 13/13 from a source-tree root.
The V1 controller bridge live proofs (J6 #3) now pass against the real installed DSH: Acceptance 27, Crash 16, F9TailBound 21, F1Loop 14, F2Prod 69, F5Prod 12, F5Slow 10, Partial 8 (identical counts to the 0.1.1 baseline).
Current user input and tool-call/tool-result coherence are asserted by the Acceptance and Crash proofs. No CCv2 writer was re-enabled. Not exercised: compaction inside a live provider session.

### J9. Regression matrix (real `Test-Harness.ps1`, same environment as the harness, baseline measured the same way)

Method correction: the earlier per-suite runner omitted the harness environment (`AIH_TOOLCHAIN_ROOT`, `AIH_HOST_APP`, a `pwsh` on `PATH`, the CCv2 research runner) and therefore (a) failed 6 suites with
`spawnSync pwsh ENOENT`, (b) let live-proof suites skip silently, and (c) ran research suites directly against the restricted policy. The final matrix uses the real harness (`-Lane production` on a fresh install of the final tree;
`-Lane ccv2-lab` on a source-tree root, because those suites need the CCv2 modules that the installer deliberately does not install). The baseline is a fresh DSH 0.1.1-rc.2 install measured with its own harness.

| Lane | Rows | Pass | Fail | Baseline (0.1.1-rc.2, same method) |
| --- | --- | --- | --- | --- |
| production, fresh install | 105 | **103** | 2 | the same 2 fail; baseline installed-root run 131/180 across both lanes |
| ccv2-lab, source-tree root | 81 | **68** | 13 | 53/81 on the same names (lab results on the baseline are lower-confidence: they ran in a thin source-root next to other jobs) |

Every failure, classified:

| Suite | Lane | Cause | Classification | Release impact |
| --- | --- | --- | --- | --- |
| `ContextRestrictedProductionV2` | production | requires CCv2 modules that the installer does not install; **passes 50/50 from a source-tree root** | environment limitation, identical on baseline | none: the policy file is byte-identical and the suite passes where the modules exist |
| `Harness` | production | `source contains no credential values` trips on credential-shaped **fake** strings in CCv2 test files (CCv2 and registry test files only; no product file) | existing baseline failure, identical message | none for behaviour; the scan is not weakened. Evidence logs in this directory are redacted so they add no hit |
| `ContextSafePointV2LiveHost`, `ContextEvidenceRehydrationV2LiveHost`, `ContextCompactionV2DshGenerationProof`, `ContextPressureRetentionV2LiveHost` | lab | assert the pinned DSH **0.1.1-rc.2** host contract text/version (e.g. "pinned DSH host is 0.1.1-rc.2 (got 0.2.2-rc.1)"); pass on the baseline | intentionally retained CCv2 laboratory failure (host-pinned by construction) | none: CCv2 stays disabled; a 0.2 port is part of any future re-enable |
| `ContextShadowV2LiveHost`, `ContextActiveApplyV2LiveHost`, `ContextGenerationRuntimeV2LiveHost`, `ContextRecoveryV2LiveHost` | lab | same version pin | intentionally retained lab failure (also fail on baseline) | none |
| `ContextCheckpointabilityV2LiveHost`, `ContextCompactionV2Operation`, `ContextCompleteTaskV2LiveHost` | lab | 0.1-API fixtures (`session.events`, iteration of removed structures) | intentionally retained lab failure (also fail on baseline) | none |
| `ContextCompilerShadowHostV2` | lab | hard-coded `/home/kaloyan/...` runtime path | environment limitation | none |
| `ContextCompilerActiveOpencodeHostV2` | lab | `@deepseek-ai/dsh-invariants` package absent | environment limitation | none |

Suites that regressed against the baseline and are now fixed: the eight V1 compaction suites in J6 #3 (visible only under the real harness environment). Zero known unfixed regression remains in the production lane.
Production-lane suites added by this campaign and migration: `NexusWorkspaceGuard`, `NexusComposerSeat`, `NexusSessionIdentity`, `NexusModeDefaultRoute`, `HarnessLanes`, `NexusRouteAdmission`, `ControllerRouteSelection`, `CredentialsCompat`.

### J10. Installation, upgrade, restart, restore (isolated VM roots only)

- **Clean install** of the final tree (repeated during the campaign; the last install is the one the final lane ran on): strict `npm ci`, pinned runtimes, home patch and the three plane closures published and verified on the real DSH composition.
  Doctor shows only three environment failures: no credential configured (deliberately, none was entered), launcher directory not on `PATH`, no `xdg-open`.
- **Upgrade in place** from a fresh DSH 0.1.1-rc.2 install: runtime 0.1.1-rc.2 to 0.2.2-rc.1; planes installed and verified; `data/settings.yaml` migrated to `data/nexus-settings.yaml` with a user edit preserved and no legacy file left;
  a **fake** credential file survived (value hash identical before and after, mode 600, restructured by DSH's credential store into `version/refs/records`); **0** writes outside the isolated roots; the upgraded install boots to `READY`,
  restarts to `READY`, and passes the 280-check sweep. (An earlier attempt with an invalid YAML edit of mine failed closed with "home patch could not be generated", as it should.) The doctor reports "Nexus dark default" as a failure when the user set a light theme: existing behaviour.
- **Restart and restore** on the test server: stop, "Reconnecting...", restart, automatic recovery without reload; the bound task, gate ledger, model selection and settings were restored from records. The launcher rewrites only its two managed blocks in `nexus-settings.yaml` on each start.
- **Default mode**: choosing DeepSeek Only now shows no error banner, writes `agent-presets.default` and the patch default, the restart reports "Default mode for new sessions: aih-deepseek (saved UI selection)", and the hero opens in DeepSeek Only (screenshot `08`).

### J11. Platform and provider limits

Linux aarch64 only. **Linux x86_64: UNVERIFIED** (no x86_64 machine or emulator is available; the committed `setup.sh` rejects aarch64 and a test-only copy was used). **Windows: UNVERIFIED.** The only other VM on the host
(UTM "ARTHUR VM") belongs to a different project and was not started. **Live provider: UNVERIFIED** (no credentials, no paid calls; a placeholder key was used only to let the local catalog list providers, with egress blocked). Not substituted by mocks:
the V1 compaction bridge and routing were proven against the real installed DSH with synthetic transport, which is stated as such.

### J12. Decision

**GO FOR PR REVIEW (Linux aarch64).** All GO criteria are met for that scope: no known newly introduced correctness or security regression remains (five were found and fixed); the DeepSeek chooser works in a real browser;
workspace-transition and operator-authority tests pass; restricted CCv2 is unchanged and its suites pass; install, upgrade, restart and compaction gates pass; every remaining failure is classified above and none is behavioural in production; the evidence is tied to `038c98f9`.
This is not approval to merge or release: x86_64, Windows and a live-provider run are still required, and the V1 compaction bridge, now live on 0.2, has not run through a live session.

## I. Commits on `feature/nexus-dsh-0.2-migration` (local only, none pushed)

`c8eda89b` migrate runtime to 0.2.2-rc.1; `e3c5ed31` delegation single source, Doctor/profile ports; `9d0b07a3` mode selector
and shadow host proof; `21970aee` restricted install fixture; `18e9b0ab` report and harness ports; `7d6b35bc` wire projector
(83/0); `b819b600` workspace-transition guard; `92274bb8` composer seat and loud guard; `f9b43521` branding;
`62bbf4ab` ordinary compaction with CCv2 disabled (7/7); `695a3b7b` browser-acceptance fixes, sweep, evidence;
`ac6d817a` production / ccv2-lab lanes; `61321d65` panel and registry suites ported; `7ef8c96b` previous final report; `65a4e137` settings arity + PREFERRED pill; `37f57169` V1 compaction bridge port; `d6e1d9bb` CCv2 lab writers keep their op shape; `47061b78` default-mode route + verifier default; `038c98f9` tests follow the route (final source revision tested; the report/evidence commit after it is documentation only).
Touched areas: `systems/nexus/{config,scripts,ui,tests,docs,runtime}`; no other system was modified.

# Registry R7.5A release candidate audit

**Current verdict: READY FOR R7.5B LIVE VALIDATION.** Required actionable
offline gates pass for the R7.5A.1 candidate. Native Windows and real provider
validation remain unverified. This does not authorize release or deployment.
Earlier R7.5A decisions and counts are retained as historical evidence.

## Original R7.5A executive summary and decision

**BLOCKED — FIXES REQUIRED.** This is an offline audit of the Model Registry v1
compatibility bridge, not permission to merge, deploy, enable a flag, or spend
inference. Reproduced execution-boundary defects have scoped fixes and
regressions. Isolated packaging and upgrade checks pass. The pinned application
dependency audit still fails, including a critical advisory whose complete
application reachability has not been established. One broader platform gate
also fails on an unchanged baseline textual heuristic. No acceptance commit is
created while these gates remain unresolved.

Audit date: 2026-10-12, CachyOS Linux. Branch: `feature/model-registry-v1`.
Starting HEAD: `abb1d13b36ad7af2d053781f63a47eb508ab0e7e`; clean tracked worktree
before changes. Both `8015037` and `abb1d13` were verified ancestors. Results
below describe the audited working-tree changes on that HEAD, not a new commit.
Draft PR #33, its state, remote branches and the running application were not
changed. Bundled binaries were read; mutable roots are under repository `tmp/`
or fresh OS temporary directories. No real credentials, connection statuses,
EMv2 configuration or live sessions, including TASK-0052, were used or changed.

## Supported and blocked scope

Supported: Registry catalog/connections; staged EM configurations; frozen legacy
routing; read-only shadow compilation/parity; equality-gated generation binding;
immutable role targets; fail-closed transitions; restart persistence; documented
rollback; preset closure generation and hash validation. EMv2 remains staged.

The binding flag remains **OFF by default**. Enabling it admits equality with
legacy execution, not arbitrary Registry-directed overrides. An existing pin
continues to enforce identity, target and current authorization with either flag.
Pending/refused authority cannot execute at the actual request boundary until
the controller has persisted its permitted rollback/evaluation transition.

Experimental: opt-in binding and shadow diagnostics; these offline checks do
not establish real provider entitlement. A never-probed built-in legacy
descriptor may retain its documented `unknown` compatibility eligibility. An
explicit indeterminate status overlay is now distinguished from that descriptor
and rejected. Neither descriptor eligibility nor a pin is proof of a live login.

Still blocked: arbitrary provider/model overrides, Claude subscription
orchestration, DSH replacement, native Rust migration and EMv3 execution. Their
absence is intentional and is not a Registry v1 release defect.

## Inspection and architecture

Inspected R7.4's controller changes and historical readiness report; controller
identity/recovery, first-turn/open-attempt/command/step boundaries; both isolation
readers and shared arm/guard/rewrite composition; `registry/session-binding`,
`shadow-binding`, `service`, `resolver`, `schemas`, `config-store`,
`legacy-import`, `migration`, operator catalog, probes, subscription connection
descriptors and runtime projection. Routing, TaskController, StepRouting,
Review, VisualReview, shared installation composition, both platform installers,
dependency closure, CI jobs and `Test-Harness.ps1` were inspected.

The ten architecture questions for these changes:

1. **Source of truth:** TaskController owns task identity; controller artifacts
   own routes; durable bindings own pins; Registry catalog/status overlay owns
   current connection descriptions. No new routing resolver or authority store.
2. **Ownership:** Existing TaskController/controller/service writers remain
   owners. Request enforcement consumes their state; it never allocates attempts
   or replaces pins. The permission plan owns only the supplied private tree.
3. **Dependencies:** Controller and isolation composition consume Registry's
   pure verdict/service APIs. Registry does not import request composition or
   isolation plugins; the new imports introduce no reverse dependency/cycle.
4. **Contracts:** `checkExecutionTarget({binding,target,connection,flagOn})`
   returns an explicit verdict. Routing state must carry the same generation as
   pin and binding. Request checks precede prepare and downstream `next()`.
5. **Failures:** Corrupt bindings quarantine the controller until repaired and
   reloaded; corrupt overlays yield no effective snapshot; absent/malformed CLI
   identity, timeout or nonzero exit rejects. Request CLI timeout is 30 seconds,
   output bounded at 1 MiB; no implicit retry or guessed success.
6. **Lifecycle:** Existing pending/refused/pinned/rollback lifecycle is retained.
   Fresh requests reread durable targets/status and validate TaskController.
   Request tickets remain weakly held and removed in `finally`; no new cache.
7. **Test seams:** Real middleware, real TaskController CLI, real persisted
   artifacts and fresh child processes; only inference `next()` is a stub.
   Failure injection uses isolated JSON/files and captured downstream counts.
8. **Compatibility:** No schema/default/policy/catalog migration. Valid legacy
   execution remains compatible. Pinned Muse requests use the pin's effort;
   ordinary Muse sessions retain adaptive reasoning. Rollback preserves data.
9. **Observability:** Structured controller refusal diagnostics and coded
   request errors distinguish pin/generation/authorization/identity failures.
   Logs include no credentials. Quarantined bytes remain intact for recovery.
10. **Security:** Identity/status must be checked before each pinned request.
    PowerShell receives an encoded command with quoted string arguments, no
    shell interpolation; Unicode paths are retained. Linux permission plans
    neither traverse nor chmod symlinks outside their ownership boundary.

## Confirmed findings, reproductions and disposition

All execution bypasses below are **blockers before their fixes**. Each regression
was observed failing before the corresponding production modification. The
expanded R74 suite uses canonical TaskController tasks and never calls a model.

| Finding | Root cause and reproduction | Evidence and disposition |
| --- | --- | --- |
| Later-step bypass | Pre-step returned early for step 2 before checking a marked binding; mutate effective provider or revoke its exact connection after pinning | `new-security-before.log`: 0 PASS / 4 FAIL includes these cases. Continuation now validates identity, persisted target and current status before `next()` |
| Request-boundary bypass | Existing isolation composition checked route authority but not Registry authority; change target/status between pre-step and the real request | `request-security-before.log`: 0/2. Shared guard now verifies generation, pin, status and identity before prepare/downstream |
| Unverifiable entitlement | Broken JSON/schema was discarded as a note, restoring permissive legacy defaults; explicit overlay `unknown` retained legacy provenance; array-shaped statuses escaped validation | `new-security-before`, `indeterminate-before`, `overlay-array-before`. Broken overlays now close the snapshot; explicit unknown is non-legacy and ineligible |
| Binding corruption erases authority | Restart replaced corrupt bindings with `{}`; null/malformed authority entries could become fresh flag-OFF legacy | `new-security-before`, `malformed-before`, `malformed-request-before`. Strict durable loading quarantines invalid documents; the shared classifier refuses malformed markers at the independent request boundary too |
| Routing generation bypass | Gate substituted binding generation without validating routing-state generation; replace state generation while leaving the same provider/model | `generation-before.log`: 0/1 against original controller. Common verdict requires pin, binding and routing generation equality |
| Muse effort changes after verification | Adaptive preparation wrote a new effort after pin verification and before returning the actual request | `muse-effort-before.log`: 0/1, actual `medium` versus pinned `xhigh` on baseline modules. Pinned preparation preserves immutable effort; positive regression checks the actual request and subsequent continuations |
| Identity becomes unavailable after pre-step | Request boundary trusted routing files without revalidating the ledger; corrupt it after a successful pinned step | `request-identity-before.log`: 0/1. Fresh TaskController CLI identity is now required at the actual request boundary |
| Marked parent masquerades as worker | Dual isolation's worker exemption ran before binding lookup; reuse marked parent session ID with worker header and drift its effective step target | `worker-original-before.log`: 0/1 against baseline modules. Ordinary delegated children remain unchanged; marked parent identity receives normal enforcement |
| Private permission walk escapes | Linux permission planning follows file/directory symlinks; isolated private root links to an isolated outside sentinel | `private-path-before.log`: failing assertion. `RegistryR75PrivatePath`: 3/0 after skipping linked roots/children. Previously the application dependency walk caused a 180-second upgrade-fixture timeout; final shared composition and upgrade complete |

R7.4's stale-generation recovery, identity-inconclusive refusal, rollback history,
flag-OFF pin enforcement and attempt deduplication were independently rerun.
Command paths for review, findings, verification and visual review retain their
existing controller transition guards. StepRouting retains generation-scoped
role pins. No guard enables arbitrary routes or Claude orchestration.

## Verification matrix and newly observed counts

Logs are retained locally at `/home/kaloyan/Projects/Nexus/tmp/r75a-evidence/`.
They are ignored diagnostic artifacts, not committed release assets. Commands
below reproduce the tests from repository root with the stated binaries/env.
Rows count their suite assertions/scenarios; heterogeneous rows must not be
summed into a misleading whole-product test count. Unless explicitly stated,
passing suites report zero failures and no emitted skips.

| Area | Status | Newly observed result and evidence |
| --- | --- | --- |
| R0–R5 | PASS | 261 PASS / 0 FAIL / 0 emitted SKIP across 11 suites, `release-Registry*.log` |
| R6.2 | PASS | 9/0/0, `release-RegistryR62Shadow.log` |
| R6.3 | PASS | 10/0, `release-RegistryR63Binding.log` |
| R6.3.1 lockdown + PS step pins | PASS | 15 + 11 PASS, `release-RegistryR631Lockdown`, `installed-RegistryR631StepPin` |
| R6.3.2 | PASS | 12/0, `release-RegistryR632Execution.log` |
| R6.5 | PASS | 7/0, `verified-RegistryR65Matrix.log`; scope correction described below |
| R7.0 | PASS | 9/0, `release-RegistryR70Readiness.log` |
| R7.4 + R75A request regressions | PASS | 34 PASS / 0 FAIL / 0 emitted SKIP: original 21 plus 13 audit cases; `accepted-final-RegistryR74RollbackRecovery.log` |
| Existing package checks | PASS | Closure 11, mode assets 8, controller clean-install 3, Muse clean-install 1, installed Registry runtime 3: 26 PASS total |
| Actual isolated installed presets | PASS | Controller 2 + MuseInstall 8; `installed-ControllerPresetInstalled`, `installed-MuseInstall` |
| Four-profile install/upgrade audit | PASS | 7/0, `verified-final-RegistryR75InstallationAudit.log` |
| Final fresh root and upgrade | PASS | Second empty root: npm ci exit 0, audit 7/0, `clean-final-npm`, `clean-final-RegistryR75InstallationAudit` |
| Linux native dependency imports | PASS | node-pty, koffi and sharp load: 3/0, `clean-final-native-imports.log`; this is import smoke, not a full host/terminal/image test |
| Private-path failure injection | PASS | 3/0, `release-RegistryR75PrivatePath.log` |
| Controller host and identity | PASS | 159 host assertions + 7 identity scenario groups; final `verified-*` logs |
| Composition/legacy boundaries | PASS | ComposedAuthority 2, ComposedMatrix 8, EngineeringIsolation 6, DeepSeekIsolation 4, MuseIsolation 20, MuseOrdering 28, EngineContract 26; `verified-*` logs |
| Other safe compatibility | PASS | RoutingIntegrity 8, PreferredRoute 7, Bootstrap 32; AihController bridge suite exit 0; `broad-*`/`final-*` logs |
| Legacy Muse adaptive reasoning | PASS | Governor 52, runtime 30, signals 34, activity 33; installed deps required for last two |
| Installed routing / migration | PASS | ControllerRouting 83 assertions; SetupUpgrade 32 emitted PASS checks including additive migration scenarios |
| Credentials source guard | PASS | 14 assertions, `installed-SourceCredentialGuard.log` |
| Shell provisioning/manifest suites | PASS | node-env 14, provision-pwsh 15, SHA256 22: 51/0 |
| JavaScript / POSIX syntax | PASS | 284 JS files and 24 shell files; `release-static-syntax.log` |
| AST PowerShell portability | PASS | Source-only and installed layouts: 25 assertions each; `release-source-PowerShellPortability`, `release-installed-PowerShellPortability` |
| Installed PlatformSupport | FAIL | 147 PASS before one failing assertion, `accepted-installed-PlatformSupport.log`; unchanged baseline heuristic described below |
| npm dependency security | FAIL | npm audit exit 1: 14 advisories (6 low, 3 moderate, 4 high, 1 critical), `npm-audit-final.json` |
| Full Test-Harness / live host lanes | UNVERIFIED | Harness contains live-host requirements and no safe suite filter; selected safe suites were run individually, not represented as a full harness pass |
| Native Windows / PS5.1 | BLOCKED | No Windows host. Static PS5.1/portable-source coverage is not native execution |
| Live provider/server/browser validation | UNVERIFIED | Reserved for R7.5B; no paid calls or existing sessions used |
| Quantitative request latency | UNVERIFIED | No representative Registry benchmark in the existing harnesses; no invented latency claims |

R0–R5 counts by suite: Core 45, LegacyBaseline 21, R2Compatibility 41,
R3Hardening 19, R3UI 29, R4ProbeSecurity 16, R4Providers 27,
R4TransportBinding 19, R5Connections 14, R51Auth 20, R511CliContract 10.
Existing R6.2–R7.0 plus step-pin coverage is **73 PASS**, independently executed.
The final shared-classifier changes also rerun these affected Node suites and
packaging/host checks; their newest evidence uses the `accepted-final-` prefix.

The R6.5 protected-tree assertion initially reported 6/1 because it allowed only
the two reviewed R6 files. R75A necessarily fixes `scripts/Platform.ps1` after
the escaping-symlink reproduction. The exact allowlist now additionally names
that reviewed file; every other script, data/UI tree, policy, catalog and JSON/
YAML setting stays protected. No routing expectation was weakened.

## Reproduction commands

```bash
export PATH="/home/kaloyan/.local/share/nexus/runtime/pwsh:$PATH"
export DOTNET_PROCESSOR_COUNT=2
export AIH_TOOLCHAIN_ROOT=/home/kaloyan/.local/share/nexus
NODE=/home/kaloyan/.local/share/nexus/runtime/node/bin/node
PWSH=/home/kaloyan/.local/share/nexus/runtime/pwsh/pwsh

# R0–R7 suites: the executed runner invokes each discovered file separately.
for suite in tests/Registry*.Tests.cjs; do
  case "$suite" in *RegistryR75InstallationAudit*) continue ;; esac
  "$NODE" "$suite"
done
"$PWSH" -NoLogo -NoProfile -File tests/RegistryR631StepPin.Tests.ps1 \
  -InstallRoot "$PWD/tmp/r75a-install"
"$NODE" tests/RegistryR75InstallationAudit.Tests.cjs "$PWD/tmp/r75a-install"
"$PWSH" -NoLogo -NoProfile -File tests/RegistryR75PrivatePath.Tests.ps1
"$NODE" tests/ControllerPresetInstalled.Tests.cjs "$PWD/tmp/r75a-install"

# Focused original-code reproduction: copy config/scripts from abb1d13 to
# an isolated root, then keep the current test driver and select one scenario.
NEXUS_R75_BASELINE_ROOT="$PWD/tmp/r75a-baseline" \
NEXUS_R74_FILTER='valid pinned requests' \
  "$NODE" tests/RegistryR74RollbackRecovery.Tests.cjs

# Each broad JS suite uses the same "$NODE" tests/<name>.Tests.cjs command.
# Each installed PS suite uses this invocation with its listed name:
"$PWSH" -NoLogo -NoProfile -File tests/SetupUpgrade.Tests.ps1 \
  -InstallRoot "$PWD/tmp/r75a-install"
sh tests/aih-node-env.Tests.sh
sh tests/aih-provision-pwsh.Tests.sh
sh tests/aih-verify-sha256.Tests.sh
```

Source syntax used `node --check` on all tracked CJS/MJS plus the new install
test; `sh -n` on tracked shell sources. `git diff --check` passes. There is no
additional root lint/type/build gate to substitute for the actual application
packaging. Registry baseline CI's frozen legacy/syntax contract was executed.
The hosted CI workflows themselves were not triggered.

## Packaging, persistence and migration evidence

Disposable install: `/home/kaloyan/Projects/Nexus/tmp/r75a-install`. Fresh actual
application dependencies were installed with:

```bash
NPM_CONFIG_CACHE="$PWD/tmp/r75a-npm-cache" "$NODE" \
 /home/kaloyan/.local/share/nexus/runtime/node/lib/node_modules/npm/bin/npm-cli.js \
 ci --omit=dev --legacy-peer-deps --prefix "$PWD/tmp/r75a-install/app"
```

Exit 0, 487 packages. Pinned DSH 0.1.1-rc.2 and vendored agent patch were used.
Source and fixture lockfiles both hash to
`ed64349a2d2bef6f6fd08b5e1e1aafd25c1138fe8973d28bd86ad1a1c61917b0`.
The lock and application package manifest are unchanged from the baseline.
Node was initially referenced read-only, then mirrored into the fixture with
its npm/npx symlinks preserved to satisfy executable-path assertions. PowerShell
is a read-only executable reference. None of this provisions or modifies the
real installed application.

After the final classifier change, an additional initially empty
`/home/kaloyan/Projects/Nexus/tmp/r75a-clean-final` was constructed with private
Node runtime copies and the final source files. Fresh `npm ci` again exited 0;
the entire installation/upgrade audit passed 7/7 there, independently of earlier
fixtures. The first provisioning attempt lacked the manifest's relative
`runtime/vendor` tarball and failed ENOENT; correcting the fixture copy layout
then installed the unchanged pin successfully. The reproduction recipe below
includes the correct vendor location.

Native import smoke used the bundled Node and
`createRequire(<clean-root>/app/package.json)` to require `node-pty`, `koffi` and
`sharp`: 3/3 PASS, no operations or server launched. npm warned that five
lifecycle-script packages were not covered by allowScripts; no scripts were
approved and no global npm setting changed. Successful imports do not establish
interactive terminal/subprocess or image-operation behavior; exercise those in
the controlled final-artifact live validation.

`MusePresetDependencyClosure.cjs prepare` ran for muse, engineering, deepseek
and controller. Each profile verifies SHA256 for dynamically loaded
`engineering-v1.json`, `engineering-v2.json`, `engineering-v3.json`, and rejects
both a missing file and changed bytes. Preset-local service imports list all
three modes. Controller is a closure profile, not a newly invented runnable
preset. Real Engineering/DeepSeek/Muse presets are built and validated using
installed DSH YAML/schema dependencies and the shared `Complete-Install.ps1`.

The new installation suite executes that actual shared composition, then saves
EMv2 revisions 0, 1 and 2, adds isolated operator settings/credentials/pin
sentinels, and reruns the real composition. Settings, credential bytes, stored
EMv2 revision 2 and opaque binding resolution identity are unchanged. The pin
sentinel is a preservation fixture, not claimed as executable authority; real
canonical pins are covered by R74. A hash-mismatched update refuses publication
and leaves existing preset hashes and operator data unchanged.

Config-store schema validation, stale revisions, atomic rename, exclusive claim
locks and interrupted/corrupt-store behavior were exercised by R3 suites. No
real staged file was used. SetupUpgrade additionally executes additive managed
settings migrations on copies, including preservation of selected profiles.
The `SettingsMigration.Tests.ps1` command attempted during discovery returned
64 because that standalone file does not exist; migration coverage belongs to
SetupUpgrade and the actual composition fixture. This is not a product failure.

Full `setup.sh` was not run because it installs home-level skills/launchers.
This audit verifies fresh dependency provisioning and the shared actual install
composition, copy/manifest contracts and isolated launchers; it does not claim
an end-to-end download/home/PATH installer run. Audit closure copies were moved
outside the installed tree before its source-scanning portability check.

To construct another disposable fixture for the installation suite (the fresh
root is required; these commands do not operate on the live application):

```bash
mkdir -p "$PWD/tmp"
INSTALL=$(mktemp -d "$PWD/tmp/r75a-reproduce-XXXXXX")
cp -a config scripts ui tests setup.sh setup.ps1 .gitattributes "$INSTALL/"
mkdir -p "$INSTALL/runtime" "$INSTALL/app" "$INSTALL/data" "$INSTALL/bin"
cp -a /home/kaloyan/.local/share/nexus/runtime/node "$INSTALL/runtime/node"
ln -s /home/kaloyan/.local/share/nexus/runtime/pwsh "$INSTALL/runtime/pwsh"
cp runtime/package.json runtime/package-lock.json "$INSTALL/app/"
cp -a runtime/vendor "$INSTALL/runtime/vendor"
for wrapper in bin/linux/*.sh; do
  cp "$wrapper" "$INSTALL/bin/$(basename "$wrapper" .sh)"
done
chmod 0755 "$INSTALL"/bin/*
NPM_CONFIG_CACHE="$PWD/tmp/r75a-npm-cache" "$NODE" \
 /home/kaloyan/.local/share/nexus/runtime/node/lib/node_modules/npm/bin/npm-cli.js \
 ci --omit=dev --legacy-peer-deps --prefix "$INSTALL/app"
"$NODE" tests/RegistryR75InstallationAudit.Tests.cjs "$INSTALL"
```

The retained `audited-source-sha256.json` identifies the exact eleven code/test
files used for the final verification. The two audit/readiness documents are
additional scoped changes, not executable inputs.

## Original R7.5A blockers and platform limitations

**Dependency gate, important and unresolved:** the exact pinned lock's npm audit
exits 1. Affected high/critical packages are MCP SDK 1.30.0, fast-uri 3.1.5,
js-yaml 4.3.1, proxy-addr 2.0.7 and sharp 0.35.3. These are existing upstream
dependencies, not Registry regressions. Do not treat the advisory count as proof
that every issue is exploitable through Nexus. Owned MCP client code constructs
StreamableHTTPClientTransport with headers, without an OAuth `authProvider`;
no owned `trust proxy` configuration was found. That narrows two paths but does
not establish complete reachability, especially third-party internals and image
inputs. Resolve compatible pinned versions or document a reviewed, precise
application applicability decision, then rerun install and security audit before
advancing. No broad npm fix or unreviewed lockfile update was performed.
References: [proxy-addr advisory](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h)
and [MCP SDK advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h).

**Platform gate, baseline heuristic failure:** PlatformSupport emits 147 PASS
assertions, then flags a `Join-Path` line in unchanged
`tests/MuseAgentPlane.Tests.ps1`. Its whole-line regex sees the adjacent
`[^\r\n]+` settings regex as a backslash path even though the actual path is
`config/settings.yaml`. `git show abb1d13:tests/MuseAgentPlane.Tests.ps1` confirms
the same line; the AST gate passes. This is a baseline test defect, not a new
Registry routing failure. Keep it visible until the heuristic is corrected and
the full installed PlatformSupport gate passes.

Earlier source-layout checks failed on missing extensionless `bin/aih`, a source
template's relative launcher root, and ignored nested worktrees in the scan.
Installed/source-only disposable layouts resolve those prerequisite issues.
The temporary Node symlink fixture and dereferenced npm symlink initially broke
executable-root assertions; the mirrored runtime with preserved internal links
resolves those fixture issues. None is presented as a production fix.

Native Windows/PowerShell 5.1 execution is unavailable. Linux PowerShell 7 uses
the real CLI; R511/AST checks cover relevant syntax/portability constraints.
Windows ACL behavior is unchanged and remains unverified natively. Real DSH
waterfall composition is covered with offline request doubles; real provider
transport, running GUI/server behavior, storage power loss and distributed
concurrent writers during a single in-flight request remain live-validation work.

## Reliability and performance assessment

Pinned continuations do not compile a new mode or rewrite a pin on each
request. Registry `getConnections` rebuilds a local effective snapshot with
bounded configured file reads and no provider probe. There is now a fresh
bounded PowerShell identity read per marked request; this correctness cost
requires representative live measurement before optimization. Request tickets
use WeakMap/WeakSet, so no new permanent request-object collection is introduced.

Existing Engineering isolation scans the full `step-routing.jsonl` and logs are
append-only; history-sized reads/log growth remain known limitations, not newly
measured release failures. No existing representative Registry latency harness
was found, so latency/memory claims are unverified. The existing actual upgrade
harness did demonstrate the symlink-traversing permission walk timeout; fixing
that ownership violation removes duplicate external dependency walks without
introducing a speculative optimization or changing application permissions.

## R7.5B prerequisites and procedure

1. Resolve/review dependency applicability and the baseline PlatformSupport
   heuristic, rerun affected gates, and record the resulting candidate SHA.
2. Arrange a separate disposable live workspace/session and approved provider
   budget. R75A grants no authorization to change a live server or existing
   sessions. Keep TASK-0052 and real staged EMv2 revision untouched.
3. Validate the installed final closures and UI, default-OFF legacy parity,
   opt-in equality binding, stored generation/resolution/role targets and one
   actual allowed request per engine with approved entitlement.
4. In dedicated copied state, exercise OFF/ON restart, open-attempt continuation,
   revocation/disabled/indeterminate authorization, route/step/review transitions,
   stale generation and corrupt/ unavailable identity. Confirm refused paths
   produce zero model dispatch and cannot fall back to a different target.
5. Record real request provider/model/effort, attempt counts, structured refusal
   codes and restart identity; measure representative existing workloads.
6. Run native Windows/PS5.1 installer, upgrade, ACL and request checks separately.
   Neither a successful Linux run nor R7.5B changes the Draft PR or authorizes
   merge/production rollout.

Final verdict: **BLOCKED — FIXES REQUIRED.**

## Original R7.5A changed files and review status

| Files | Purpose |
| --- | --- |
| `config/AihController.cjs` | Strict binding quarantine and marked continuation checks |
| `config/Controller-RequestBoundary.cjs` | Fresh identity, target and authorization before actual requests |
| `config/Engineering-Isolation.cjs` | Enforce marked parent authority despite a worker header |
| `config/Muse-Isolation.cjs` | Preserve pinned effort during request preparation |
| `config/registry/session-binding.cjs` | Shared execution verdict and malformed-authority refusal |
| `config/registry/service.cjs` | Reject corrupt/indeterminate authorization overlays |
| `scripts/Platform.ps1` | Keep Linux private permission planning within owned data |
| `tests/RegistryR74RollbackRecovery.Tests.cjs` | Real isolated continuation/request/corruption regressions |
| `tests/RegistryR75InstallationAudit.Tests.cjs` | Four profile closures, real upgrade and publication integrity |
| `tests/RegistryR75PrivatePath.Tests.ps1` | Escaping directory/file/root symlink regressions |
| `tests/RegistryR65Matrix.Tests.cjs` | Exact reviewed-platform-file scope for the R75A security fix |
| `docs/architecture/registry-r75a-release-audit.md` | Independent evidence, findings, blockers and live-validation procedure |
| `docs/architecture/registry-r7-release-readiness.md` | Append new audit without rewriting historical results |

Self-review followed correctness, security/data loss, lifecycle, compatibility,
dependency direction and demonstrable performance, in that order. No additional
confirmed data-loss or route-override finding remains in the reviewed changes.
Concurrent in-flight dispatch and native/live paths retain the limitations above.
No Git identity/configuration, hooks, CI workflow or dependency pin was changed.
HEAD remains `abb1d13`; all 13 scoped files remain uncommitted because the audit
decision is blocked. No acceptance commit, push or merge was performed.

## R7.5A.1 security and platform gate closure — 2026-10-12

This section supersedes the original R7.5A blocker assessment above. The
original evidence is retained as history. Starting branch and HEAD matched
`feature/model-registry-v1`, `abb1d13b36ad7af2d053781f63a47eb508ab0e7e`.
Exactly 13 modified/untracked files matched the original inventory before edits.
All 13 file bytes, a binary tracked diff and SHA256 baseline inventory are
preserved in ignored `tmp/r75a1-backup/`. No reset, stash or discard occurred.

### Dependency decisions and artifact identity

The [complete advisory matrix](registry-r75a1-dependency-security.md) traces
all 22 underlying advisories and 14 affected package entries through resolved
lock paths, direct/transitive ownership, external-input triggers, application
reachability, fixed versions and compatibility constraints. All are production
nodes; the full tree has zero dev dependencies. Nine targeted exact overrides
remove the advisories without changing DSH RC, OAuth adapter pins or vendor
archive bytes. No advisory suppression or risk acceptance is used.

Fresh `npm ci --omit=dev --legacy-peer-deps --prefix tmp/r75a1-install/app`
from the source manifest/lock completed successfully in a newly constructed
private disposable root: 486 packages added, 487 audited. It retains the
original install-script allowlist warnings; no lifecycle approvals or global
npm configuration changes were made. Separate `npm audit --omit=dev --json`
and full `npm audit --json` against that tree both exit 0 and report
**0 low / 0 moderate / 0 high / 0 critical**. Metadata records 480 production
nodes, 69 optional nodes, zero dev nodes, total 548. npm's audit metadata
counts optional/platform lock entries differently from physically added packages.

Source and installed manifests match SHA256
`c92725e394d6cbf52ccfb7e80f85b0c4480ae1f558bc540c1ffb81f0dd5a0362`;
source and installed locks match SHA256
`325e07d8c4acc2ae80754f4998dfcff1506368d23da2bf1a722a951b9dacdb74`.
Installed versions: SDK 1.31.0, fast-uri 3.1.8, js-yaml 4.3.2,
proxy-addr 2.0.8, sharp 0.35.5, hono 4.13.7, ip-address 10.7.1,
qs 6.16.0, provider-utils 4.0.33, node-pty 1.2.0-beta.15,
koffi 3.1.6; bundled Node v24.18.1 and PowerShell 7.5.3.

`RegistryR751DependencyCompatibility.Tests.cjs <disposable-root>` passes
11 checks. They import native node-pty/koffi, decode SVG and raster with
sharp's patched prebuilt libraries, verify YAML normal merges and empty-source
budget enforcement, proxy subnet rejection, qs comma overflow and constructor
handling, IPv6 family/link-local checks, actual pinned OAuth adapter loading and OpenAI completion with mocked fetch,
JSON success/oversized-response refusal, and actual DSH MCP initialization
and tool discovery over both local HTTP and stdio. No real provider is called.
`RuntimeRoutingTrace` additionally traverses the installed vendored agent/real
DSH loop through an offline transport stub with identical final routing headers,
request and stream target. This independently checks the vendor request seam.

### Platform heuristic root cause and repair

The original `abb1d13:tests/PlatformSupport.Tests.ps1` was executed against
a disposable installed tree and failed after 147 PASS assertions: it searched
the whole line for both Join-Path and any single-quoted backslash text. The
unchanged MuseAgentPlane settings replacement regex `[^\r\n]+` shared a line
with a portable `config/settings.yaml` argument and caused the false positive.

The gate now parses PowerShell and inspects literal/interpolated text inside
argument expressions of actual Join-Path commands, including parenthesized,
concatenated and module-qualified calls. Regex pattern operands of -replace
are excluded; replacement text remains checked. It rejects malformed source
rather than silently omitting it. The existing no-backslash assertion remains.
Fourteen positive/negative cases cover these distinctions, named/positional
arguments, adjacent regex, comments, portable paths, command boundaries and
continued multiline commands. The old heuristic and the initial direct-argument
correction both failed targeted regressions before the final correction.
Full installed PlatformSupport now passes **163 assertions / 0 failures**. Genuine backslash paths are still detected;
valid application code was not changed for this test.

### Complete candidate review and additional fix

Review covered the existing controller, request boundary, both isolation
planes, Registry state/authorization changes, permission walker, installation
and security regressions plus the dependency diff. Correctness, authorization,
state lifecycle and data-loss checks preceded compatibility/performance review.
Confirmed additional bypasses existed in isolation: Engineering swallowed
durable binding corruption, letting a worker header look unmarked, and returned
before lookup when the session header was missing. Muse also swallowed binding
corruption; combining that with a missing header could become an unbound pass-through.

These cases were reproduced with actual request middleware against preserved
pre-review candidate code (0 PASS / 1 FAIL each), including a separately
reproduced Muse corrupt-document/missing-header combination. Both readers now distinguish
absent bindings from invalid/unreadable documents and invalid selected entries.
Worker exemption uses the shared authority classifier, including malformed
markers; missing headers cannot waive marked authority. Two new R74 cases, strengthened across both engines and corrupt-document
combinations, verify no downstream call/attempt. Existing genuine unbound worker behavior
is retained and exercised by isolation regressions. This adds validation to
existing reads, with no extra filesystem pass, route resolution or new API.

Fresh TaskController identity still has a 30-second/1-MiB request-time bound;
quoting uses EncodedCommand and escapes PowerShell single quotes. Target,
generation and entitlement remain verified before downstream dispatch. No
new confirmed authorization fallback, data loss, task-generation reuse or
routing override remains in the reviewed candidate. Per-marked-request
PowerShell identity latency and existing history-sized step log reads remain
unmeasured live workload costs; they are not claimed as performance improvements.
Dependency updates do not change those Registry authority conclusions.

### Verification and limitations

New evidence is retained under ignored `tmp/r75a1-evidence/`; original evidence
under `tmp/r75a-evidence/` remains historical. The initial aggregate JS runner
applied a 600-second suite timeout to R74 and stopped that suite before all
cases completed, without an assertion failure. That partial run is not counted
as acceptance. Bootstrap and a final installation repeat also exceeded that
runner limit during heavy host CPU/memory load; the user interruption stopped
other pending runs. Final acceptance reruns use a 2400-second R74 runner
ceiling and 1800 seconds for the remaining suites. No production request
timeout was enlarged. An installed-tree invocation of the new dependency test
failed its repo/tmp precondition; its documented repository invocation was
rerun without weakening that safety check.

Final accepted results below replace interrupted/incorrect-invocation attempts;
none of those attempts is counted as a passing gate. Each accepted suite exits
0, with **0 failed and 0 skipped checks**. Count units are assertions/scenarios
as reported by each suite; bridge and routing-trace rows count completed suites,
not hidden internal assertions. Exact per-suite logs and runner result JSON are
retained in `tmp/r75a1-evidence/`.

Reproduction: `N` is `/home/kaloyan/.local/share/nexus/runtime/node/bin/node`;
`P` is `/home/kaloyan/.local/share/nexus/runtime/pwsh/pwsh`; `I` is repository
`tmp/r75a1-install`. Run JS source suites as `N tests/<name>.Tests.cjs`, installed
JS suites as `N I/tests/<name>.Tests.cjs`, and installed PowerShell suites as
`P -NoProfile -File I/tests/<name>.Tests.ps1 -InstallRoot I`. Set
`DOTNET_PROCESSOR_COUNT=2`; source child-runtime suites use the read-only bundled
toolchain anchor and its PowerShell directory in PATH. The two new installation
and dependency JS suites run **from source** with `I` as their argument.

| Gate / actual execution | PASS | FAIL | SKIP | Evidence |
| --- | ---: | ---: | ---: | --- |
| R0–R5: Core 45, Legacy 21, R2 41, R3 hardening 19/UI 29, R4 probe 16/providers 27/transport 19, R5 connections 14/auth 20/CLI 10 | 261 | 0 | 0 | `js-results.json`, corresponding source-suite logs |
| R6.2 shadow 9, R6.3 binding 10, R6.3.1 lockdown 15, R6.3.2 execution 12, R6.5 matrix 7, R7.0 readiness 9 | 62 | 0 | 0 | `js-results.json`, corresponding source-suite logs |
| Installed RegistryR631StepPin (PowerShell) | 11 | 0 | 0 | `RegistryR631StepPin-installed.log` |
| R7.4 + R7.5A/1 actual request, continuation, corruption and recovery | 36 | 0 | 0 | `RegistryR74RollbackRecovery-accepted.log`, `r74-accepted-result.json` |
| Packaging: Muse dependency closure 11/modes 8, Controller clean install 3, Muse clean install 1, installed Registry runtime 3 | 26 | 0 | 0 | `js-results.json`, respective closure/install logs |
| Four-profile three-mode hashed assets; actual shared clean install/upgrade preservation/corrupt-publication refusal | 7 | 0 | 0 | `RegistryR75InstallationAudit-accepted.log` |
| Native/dependency/MCP/OAuth compatibility (source test with installed-root argument) | 11 | 0 | 0 | `RegistryR751DependencyCompatibility-accepted.log` |
| Private-path symlink protection (installed PowerShell) | 3 | 0 | 0 | `RegistryR75PrivatePath-installed.log` |
| Controller bootstrap | 32 | 0 | 0 | `ControllerSessionBootstrap-accepted.log` |
| Controller bridge suite | 1 | 0 | 0 | `AihController-accepted.log` |
| Controller host assertions / identity scenario groups | 159 / 7 | 0 | 0 | `AihControllerHost-accepted.log`, `AihControllerIdentity-accepted.log` |
| Installed Engineering / DeepSeek / Muse isolation | 6 / 4 / 20 | 0 | 0 | respective `*Isolation-final.log`; Engineering/Muse source reruns also pass |
| Installed composed routing matrix / Muse authority ordering | 8 / 28 | 0 | 0 | `ComposedRoutingMatrix-final.log`, `MuseRoutingAuthorityOrdering-final.log` |
| Source composed authority / engine contract / routing integrity / preferred route | 2 / 26 / 8 / 7 | 0 | 0 | respective source-suite logs and `js-results.json` |
| Installed Muse governor / reasoning runtime / signals / activity | 52 / 30 / 34 / 33 | 0 | 0 | governor `*-installed.log`, remaining `*-final.log` |
| Installed Muse provider / actual DSH routing trace suite | 35 / 1 | 0 | 0 | `MuseProvider-installed.log`, `RuntimeRoutingTrace-final.log` |
| Installed Controller presets / Muse installation | 2 / 8 | 0 | 0 | `ControllerPresetInstalled-installed.log`, `MuseInstall-installed.log` |
| Installed Controller routing / setup upgrade / source credential guard (PowerShell) | 83 / 32 / 14 | 0 | 0 | respective `*-installed.log` |
| Installed full PlatformSupport (PowerShell) | 163 | 0 | 0 | `PlatformSupport-accepted.log` |
| Final source-copy / installed PowerShell AST portability | 25 / 25 | 0 | 0 | `source-portability-accepted.log`, `installed-portability-accepted.log` |
| Shell node environment / PowerShell provision / SHA manifest | 14 / 15 / 22 | 0 | 0 | `aih-node-env.log`, `aih-provision-pwsh.log`, `aih-verify-sha256.log` |
| Source `node --check` CJS/MJS / `sh -n` scripts | 285 / 24 | 0 | 0 | `syntax.json`, `static-final.log`; latest dependency-test edit also individually syntax-checked |
| Clean production npm ci / production audit / full audit | PASS / PASS / PASS | 0 | 0 | `clean-npm-ci.log`, `npm-audit-production.json`, `npm-audit-full.json` |
| Source whitespace `git diff --check` | PASS | 0 | 0 | final command exit 0 |

All tested source/runtime security files match the disposable installed files;
`final-code-sha256.json` records final bytes. Manifest and lock hashes above
identify the clean-installed dependency artifact. No critical/high vulnerability
remains in either npm audit; this is dependency remediation, not risk acceptance.
The complete-candidate review found no further confirmed blocker. The residual
workload and native/live limitations below remain outside offline acceptance.

Native Windows/PowerShell 5.1, live installed host, real provider entitlement,
paid inference, full system harness, interactive native terminal operations and
power-loss/concurrent-writer injection remain **UNVERIFIED**. The full harness
includes required live-host lanes and was intentionally not run under this
offline-only authorization. Linux selected suites do not establish those gates.
Registry default remains OFF; no production runtime/state, TASK-0052, server,
Claude activation, routing overrides, Rust runtime, push or merge was changed.

### Final changed-file inventory

The candidate contains the original 13 preserved files plus five newly scoped
files (runtime manifest/lock, PlatformSupport test, dependency compatibility
test and advisory matrix). No other source tree is changed.

| File | Candidate purpose |
| --- | --- |
| `config/AihController.cjs` | Preserved R7.5A fix/evidence; see original inventory and R7.5A.1 review above |
| `config/Controller-RequestBoundary.cjs` | Preserved R7.5A fix/evidence; see original inventory and R7.5A.1 review above |
| `config/Engineering-Isolation.cjs` | Preserved R7.5A fix/evidence; see original inventory and R7.5A.1 review above |
| `config/Muse-Isolation.cjs` | Preserved R7.5A fix/evidence; see original inventory and R7.5A.1 review above |
| `config/registry/service.cjs` | Preserved R7.5A fix/evidence; see original inventory and R7.5A.1 review above |
| `config/registry/session-binding.cjs` | Preserved R7.5A fix/evidence; see original inventory and R7.5A.1 review above |
| `docs/architecture/registry-r7-release-readiness.md` | Preserved R7.5A fix/evidence; see original inventory and R7.5A.1 review above |
| `runtime/package-lock.json` | Resolved patched packages/platform assets, provider ABI leaf and corrected unchanged-vendor integrity |
| `runtime/package.json` | Nine exact compatible advisory overrides; direct runtime pins unchanged |
| `scripts/Platform.ps1` | Preserved R7.5A fix/evidence; see original inventory and R7.5A.1 review above |
| `tests/PlatformSupport.Tests.ps1` | AST-scoped path-expression heuristic and fourteen regressions |
| `tests/RegistryR65Matrix.Tests.cjs` | Preserved R7.5A fix/evidence; see original inventory and R7.5A.1 review above |
| `tests/RegistryR74RollbackRecovery.Tests.cjs` | Preserved R7.5A fix/evidence; see original inventory and R7.5A.1 review above |
| `docs/architecture/registry-r75a-release-audit.md` | Preserved R7.5A fix/evidence; see original inventory and R7.5A.1 review above |
| `docs/architecture/registry-r75a1-dependency-security.md` | Every advisory, path, applicability, remediation and residual risk |
| `tests/RegistryR751DependencyCompatibility.Tests.cjs` | Native/decoder/YAML/proxy/query/OAuth and actual DSH MCP HTTP/stdio compatibility |
| `tests/RegistryR75InstallationAudit.Tests.cjs` | Preserved R7.5A fix/evidence; see original inventory and R7.5A.1 review above |
| `tests/RegistryR75PrivatePath.Tests.ps1` | Preserved R7.5A fix/evidence; see original inventory and R7.5A.1 review above |

### Accepted candidate and local commit provenance

Decision: **READY FOR R7.5B LIVE VALIDATION**. All required actionable offline
gates above passed; no vulnerability was waived and no known release-critical
offline blocker remains. The operator must still complete the native/live gates
before any release decision. Existing R7.5A fixes were preserved and reviewed
alongside the new dependency and platform changes.

Production security and permission fixes are committed as
`ab9edd0aadf2074e98b23e090c8412f27c69f37a`; dependency remediation is committed as
`b9851da6c63f46b1f132fa092fe6219bcdbe50a1`. A subsequent separate test/documentation
commit records the nine remaining inventory files, including this report. Its
exact SHA is the final candidate HEAD reported with completion (a document
cannot include its own containing commit SHA). All three commits use the
unchanged configured author/committer identity. No push or merge occurred.

The reviewed/tested code hashes remain unchanged across these acceptance
commits. Ignored backup and evidence fixtures remain locally available. Final
working-tree status and complete candidate SHA are checked after the final
commit; no live Nexus runtime or state has been modified.

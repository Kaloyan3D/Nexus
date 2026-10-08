# CCv2 production integration into dev

## Scope and integration method

Branch: `integration/ccv2`. Base: `origin/dev` at
`9f5f109e0f651bc5007bb8670202477b688ba26c`.
Verified production integration commit:
`a9ebd2fa692846973b27d70bd04040c1e4fc03ef`.
The following documentation commit records this evidence without changing
executable source.

This is a selective production snapshot port, followed by semantic integration
with the development baseline. It is not a merge or a replay of source history.
The common ancestor is `6011d55cf9023388ac6d8c12b2250e046f2ca5a3`;
dev has 182 unique commits and the feature branch has 232. Read-only
`git merge-tree --write-tree` simulations against the feature and frozen
benchmark revisions each reported 46 conflicting paths. Replaying those
histories would also reintroduce older implementations of current Linux,
OpenCode Go, managed settings, and startup functionality.

Source snapshots reviewed and selectively incorporated:

- Feature: `bb2a2be9d823f1b7ea45a7626e5a4de42a357feb`.
- Reasoning continuity fix: `081c54070ee0ae62a8ae303bbcde9f930174cbed`.
  Its tree equals the feature tree; it is not an additional independent port.
- Frozen benchmark: `c221afad9e5a69c2b50fb69d619eac26ba710bc8`, specifically
  production session bootstrap commit
  `71ea5ac7d2193704eea3beaf02c1441469e259ff` and its regression coverage.

These are content provenance references, not claims that every source commit
was merged. The path-by-path decision record is
[ccv2-selection.json](ccv2-selection.json); the plan written before edits is
[ccv2-architecture-plan.md](ccv2-architecture-plan.md).

## Production architecture and policy

The integration carries the compiler, typed task authority, structured memory
producer, pages and evidence rehydration, context views/rendering, checkpoints,
SafePoint/protocol checks, compression and packing, token counters and authority
verification, recovery/rollback, pressure activation, and reasoning continuity
contracts. The controller hosts consume those modules; task and session
authorities retain separate ownership. Request projection does not claim a
durable session compaction. Existing DSH compaction remains interoperable.

The per-agent request boundary and the pinned DSH agent routing-authority patch
compose controller, Engineering, DeepSeek, and Muse routes before transport.
All installed DSH agent consumers deduplicate to `0.1.1-rc.2-nexus.1`.
The canonical vendored artifact and patch provenance are included.
Artifact SHA256:
`30843a44a6b2aa03d6841559a97f5533572f480793d6e58087a220f6a7861f5d`.

The current dev provider catalogs, settings, routing policy, OpenCode session
header patch, additive Go settings migration, Linux detached process behavior,
and READY identity validation are preserved. Muse/OpenCode uses the existing
`reasoningReplay: none` continuity basis, pressure activation, conservative
Native fallback, and original provider capability/certification requirements.
No activation threshold, retry policy, model/provider, or Adaptive Hybrid
behavior was introduced. No benchmark or provider inference was run.

## Benchmark-origin selection

Included: deterministic controller session preparation, immutable profile/route
selection, idempotent task allocation and recovery, preparation authority,
Route/Task CLI plumbing, controller architecture documentation, and relevant
bootstrap/routing/host regression tests. `config/AihController.cjs` matches the
frozen source; dev-only behavior was preserved in its surrounding composition.

Excluded: LHCB workloads, qualification/official runners, large benchmark
fixtures, provider observability implementation/workers, and standalone live
C08/M01/OC01 attribution or canary experiments. Production certification stays
fail-closed; excluding live experiments does not create certification evidence.
The offline activation replay and session-log helper are included because
production deterministic regression tests depend on them.

The classification record contains 439 decisions: 80 required production fixes,
9 required dependencies, 130 useful regression tests, 193 benchmark-only paths,
7 observability-only paths, and 20 incompatible/unnecessary paths.

## Conflict resolutions and demonstrated integration fixes

No actual Git merge was attempted; the 46 conflicts belong to simulations.
Shared files were integrated by production contract rather than selecting an
entire source tree. Installers retain the dev OpenCode patch and managed settings
migration while adding dependency closure, staged preset publication/rollback,
and routing-integrity validation. UI/profile resolution retains current Go
catalog entries while exposing the authoritative selected route.

Observed integration defects were fixed with failure evidence first:

1. Engineering/DeepSeek preset closures lacked tokenizer assets used by their
   installed compiler. Both now ship the canonical assets. Tests instantiate
   the installed tokenizer and verify missing dependencies fail closed.
2. Legacy profile-editor fixtures had no Nexus engine catalog. The editor now
   retains its role requirements and emits no inferred route when the catalog
   is absent. A present corrupt catalog still fails. Visual Review retains its
   existing coverage.
3. The existing Go transport test context lacked the new per-agent lifecycle
   seam. It now uses the real registered request-composition fixture and keeps
   all 19 original assertions.
4. Setup/upgrade contract assertions now verify the installed closure rather
   than requiring a retired literal copy statement. All dev Go migration and
   upgrade assertions remain. The Windows-only fixture uses a pinned existing
   Node and a closure stub without downloads; execution on Windows is pending.
5. Imported installer/allocation locals used reserved `$PROFILE`/`$Matches`
   names. They now use `closureProfile`/`sessionAllocations`; the unchanged dev
   portability audit caught the collisions before commit.
6. The dev path audit misclassified the canonical JSON Unicode escape format
   as a filesystem path. Its documented allowlist now accepts only that exact
   serializer file/value. Three assertions prove the valid serialization case,
   rejection of real backslash paths, and rejection outside the owning file.
   The production canonical serializer and its output bytes are unchanged.

The Foundation H5 checkpoint threat-model assertion is scoped to the checkpoint
seal section: a separate counter HMAC is not checkpoint authenticity. The
Visual lifecycle fixture invokes all registered lifecycle handlers.
The standard test harness registers the offline production suites and requires
actual installed DSH composition for strict host gates. Its runtime environment
is anchored to the installation under test.

## Verification evidence

Evidence directory:
`/home/kaloyan/nexus-bench/ccv2-dev-integration-20261008`.
Installed test environment: pinned Node 24.18.1, PowerShell 7.5.3, Linux,
isolated installation trees, local mock transports only.

| Gate | Result | Evidence |
| --- | --- | --- |
| Complete installed standard harness | FAIL: 164/172 PASS initially, 8 failures | `harness-1.json`, `harness-1.log`; all 172 suites executed, 43m04s |
| Full harness plus focused corrections | 168/172 PASS, 4 verified baseline failures remain | `verification-reconciled.json`; this is reconciled evidence, not a second full harness run |
| CCv2/compiler, safety, actual DSH host, recovery, reasoning and routing suites | PASS in complete installed harness | Per-suite results in `harness-1.json`; strict host proofs report EXECUTED |
| Clean preset dependencies and installed tokenizer | PASS | `ControllerPresetCleanInstall-final.log`, `ControllerPresetInstalled-final.log`, `MusePresetDependencyClosure-final.log`, `MusePresetCleanInstall-final.log`, `SourceCompleteness-final.log` |
| OpenCode Go request composition | PASS, 19 assertions | `MuseOpenCodeGo-final.log`; actual patched DSH loop with mock transport |
| Legacy editor and exact selected route | PASS | `PreferredRouteContract-final.log`; includes absent/corrupt catalog and Meta/Go/Dual cases |
| Visual Review | PASS, 94 assertions | `visual-review-green.log` |
| Setup/upgrade contracts | PASS after closure fixture adaptation | `SetupUpgrade-final.log`, `SetupUpgrade-after-portability.log`; retains dev Go catalog/migration assertions |
| PowerShell portability audit | PASS, 25 assertions | `portability-after-classification.log`; includes AST parsing, reserved names, paths, entrypoints, OS assumptions and toolchain ownership |
| JavaScript/JSON static checks | PASS | `static-node-final.log`: 239 JavaScript files, config JSON parsed |
| PowerShell syntax | PASS | `static-powershell-final.log`: 128 `.ps1` files; portability audit additionally parses module files |
| POSIX syntax and shell suites | PASS | 24 shell sources parsed; `shell-final.log`, 51 assertions across three shell suites |
| Actual runtime dependency installation | PASS | `npm-ci-lifecycle.log`: 487 packages; `agent-dependency-tree.log` proves patched agent deduplication |
| Actual isolated shared install composition | PASS | `composition-final.log`, `composition-after-portability.log`: UI/import, OpenCode patch, staged and validated presets |
| Final bootstrap recheck after allocation-local rename | PASS, 32 assertions | `bootstrap-final.log`; reports zero network attempts |
| Preserved dev source and frozen tag | PASS | `preservation-final.json`, source/tag comparison against exact Git revisions |
| Windows runtime/install and Windows PowerShell 5.1 | UNVERIFIED | Windows runner required; Linux syntax/mock platform tests are not substitutes |
| Live provider/certification and benchmarks | UNVERIFIED / NOT RUN | Excluded by task scope; no inference or LHCB execution |

The machine-readable reconciled suite evidence is included in
[ccv2-verification.json](ccv2-verification.json). No failing baseline gate is
represented as passing. Relevant focused rechecks were executed after each
correction; passing unaffected suites were not redundantly repeated.
The whitespace check excludes the preserved canonical unified-diff artifact
`runtime/patches/dsh-agent-routing-authority.patch`: its blank context lines
carry the single-space unified-diff prefix. Executable source checks pass.

The source omnibus command was:

```sh
node --test --test-concurrency=4 tests/*.Tests.cjs tests/*.Tests.mjs
```

It ran with the pinned toolchain, isolated `NEXUS_RUNTIME_ROOT`, and
`NEXUS_REQUIRE_CCV2_LIVE_HOST=1`. Initial outcome: 130 suites, 120 PASS,
10 FAIL, zero skips. Installed-tree-only failures are checked in the actual
isolated installation. Three cross-process failures are checked again with
direct sequential Node execution; their timing/lease assertions are unchanged.
Initial evidence is retained, not overwritten.

Cross-process rechecks: compaction lock 7 PASS; generation runtime 27 PASS.
The independent recovery recheck still failed its short-lease timing case;
the complete sequential installed harness subsequently passed recovery 41/41.
The original feature snapshot also passed 41/41. The test, lock client,
ActiveApply/generation modules, and PowerShell acquire/renew bodies are identical
to feature source (`recovery-source-identity.json`). This is timing-sensitive
verification evidence; no lock semantics, lease limits, assertions, or provider
policy were changed to obtain a pass. Preserve this risk when scheduling tests.

The standard installation harness command was:

```sh
pwsh -NoProfile -File installed/scripts/Test-Harness.ps1 \
  -InstallRoot installed -ContinueOnFailure -ReportPath harness-1.json
```

The isolated dependency installation uses the existing installer command:

```sh
npm ci --legacy-peer-deps --omit=dev --no-audit --no-fund --prefix release-runtime/app
```

It installed 487 packages successfully. The existing npm safety policy withheld
unapproved lifecycle scripts; no approval policy was changed. The actual
`Complete-Install.ps1` composed and validated all presets, UI routing integrity,
and OpenCode header patch in `installed-final`. No user installation or global
launcher publication was performed.

## Known baseline failures and remaining gates

The original dev baseline is archived at `dev-baseline` from the unchanged Git
commit. Its relevant failures were reproduced without modifying source:

- `Harness.Tests.ps1` credential source guard: its exact original guard and
  original helpers fail against original dev. Synthetic diagnostic text is
  matched by its broad secret pattern. Evidence: `baseline-source-guard.log`,
  `baseline-source-guard-locations.json`, `baseline-source-guard.ps1`.
- `Intelligence.Concurrency.Tests.ps1`: Linux does not support the named
  synchronization primitive used by the test. Evidence:
  `baseline-concurrency.log`.
- `NexusControllerPanel.Tests.cjs:391`: its Windows-path routing hash expectation
  fails under Linux on original dev as well. Evidence: `baseline-panel.log`.
  The actual Linux hash varies with the working directory because the fixture
  supplies a Windows path to platform-native path resolution.
- `PlatformSupport.Tests.ps1`, case G: the old Start-Process capture remains
  from the simulated Windows call when the current Linux detached helper
  bypasses Start-Process. The exact original A-J contract, original Common and
  original Platform source reproduce the same failure. Evidence:
  `baseline-platform-contract.ps1`, `baseline-platform-contract.log`.
  Production Platform code is unchanged; the separate real Linux detached
  lifecycle suite passes in the full harness.

These failures were not fixed or accepted as release gates by this task.
Windows-native installer/runtime and Windows PowerShell 5.1 execution are
UNVERIFIED here. Linux PowerShell parsing does not replace those gates.
Live provider/certification behavior is UNVERIFIED by design; strict host tests
exercise the real SDK/substrate with mock transport, not provider inference.
No Sentry integration or configured project lint/type-check gate was found;
syntax checks are explicitly reported as syntax checks.

PR review can proceed with this evidence; merge/release readiness remains
conditional on required platform gates and disposition of baseline failures.
The frozen tag, benchmark source branch, and external benchmark evidence remain
untouched. Nothing was merged to dev/main or pushed.

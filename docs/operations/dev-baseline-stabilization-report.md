# Development baseline stabilization — 2026-10-08

Branch: `fix/dev-baseline-stabilization`, based directly on current `origin/dev`
`9f5f109e0f651bc5007bb8670202477b688ba26c`, in a separate worktree. No production
CCv2, provider policy, workload, prompt, threshold or LHCB evidence was changed.
The sole production correction is the controller UI's routing-state filename.
This report does not grant unconditional merge readiness to Draft PR #29.

## Original failures and minimal corrections

| Suite | Unchanged baseline | Root cause | Correction and final focused result |
| --- | --- | --- | --- |
| Harness | FAIL after 257 PASS assertions | Unanchored credential pattern matches the suffix inside `task-instance-mismatch`; deliberately literal synthetic redaction keys also enter the source scan | Require a credential token start; keep hyphens as delimiters, retain genuine-key detection and named credential rule. Construct the exact same synthetic keys at runtime. No test directory exemption. Harness: 267 PASS assertions; source guard: 14 PASS |
| Intelligence.Concurrency | FAIL at named EventWaitHandle construction | .NET does not support named events on Linux | Test-only process-shared manual-reset marker signals, exclusive creation and bounded state polling. Six real processes, 32-second hold crossing the legacy timeout, single-flight, parallel identities, exception/abandon recovery and derived-state failure checks retained. 15 PASS assertions |
| PlatformSupport G | FAIL after 127 PASS assertions | POSIX invokes DetachedProcess.js; the test inspects stale Windows Start-Process capture | Validate the actual helper request and prove Windows transport is unused; retain Windows A–F/I–J and real Linux lifecycle checks. 149 PASS assertions |
| NexusControllerPanel | FAIL at original line 391 | Windows literal path hash depends on Linux cwd; JS also incorrectly folds case for real POSIX paths while the PowerShell writer does not | Fold case only on Windows; compare UI hashes against the real native PowerShell writer for legacy and instance identity, path normalization and case distinction. Use native absolute IO fixture paths; retain separate Windows spelling comparison checks. Whole panel suite PASS |

`SourceCredentialGuard` and the full panel suite are included in the standard
harness so these regressions remain automatic. The existing SEC001 architecture
security rule was not changed. Neither production mutexes nor detached-process
implementation were changed. No routing-state migration is needed: the UI now
reads the filenames the existing authoritative PowerShell writer already creates.
Windows routing hash behavior remains unchanged for the tested ordinary paths.

The original suite logs are preserved under
`/home/kaloyan/nexus-bench/dev-baseline-stabilization-20261008`. The committed
[baseline evidence](evidence/dev-baseline-stabilization/baseline-reproductions.json)
records original HEAD, failures, source guard locations and raw log SHA256 hashes.
The added credential regression and cross-language hash regression both failed
against the old implementation before their corrections.

## Verification

Runtime: Linux, pinned Node 24.18.1 and PowerShell 7.5.3. Dependencies were
installed from **dev's** unchanged runtime package/lock using
`npm ci --legacy-peer-deps --omit=dev --no-audit --no-fund`; the dev install
composition was exercised in an isolated fixture. The initial fixture omitted
installer-equivalent executable launcher modes and dereferenced npm symlinks;
these fixture defects were corrected. No repository installer fix was required.
Raw failed attempts remain in the evidence directory.

Focused suite commands (replace `$Install` with the isolated installed root):

```sh
pwsh -NoProfile -File "$Install/tests/Harness.Tests.ps1" -InstallRoot "$Install"
pwsh -NoProfile -File "$Install/tests/SourceCredentialGuard.Tests.ps1" -InstallRoot "$Install"
pwsh -NoProfile -File "$Install/tests/Intelligence.Concurrency.Tests.ps1" -InstallRoot "$Install"
pwsh -NoProfile -File "$Install/tests/PlatformSupport.Tests.ps1" -InstallRoot "$Install"
"$Install/runtime/node/bin/node" "$Install/tests/NexusControllerPanel.Tests.cjs"
```

Additional executed gates:

- PASS: real `PlatformDetachedLifecycle.Tests.ps1`, `StartupLifecycle.Tests.ps1`.
- PASS: `ContextCompactionF4Privacy.Tests.ps1`, preserving redaction fixture values.
- PASS: `PowerShellPortability.Tests.ps1`, 22 assertions, including all PS parsing
  and no automatic/reserved-variable writes. A new mock's manual LASTEXITCODE
  assignment was caught, removed, and replaced with real native exit status.
- PASS: Node syntax checks; POSIX source syntax and all three shell suites.
- Standard harness: **FAIL**, 62 suites / 24 minutes, 59 suite PASS and 3 FAIL
  (reported assertion totals: 2691 PASS / 3 FAIL). One failure was the missing
  executable mode in the initial installation fixture; unchanged SetupUpgrade
  passed when rerun after matching the installer's chmod. Two other failures
  reproduce on pristine dev: MuseAgentPlane (7 PASS / 1 FAIL) and
  AihControllerIdentity (6 sections PASS / 1 FAIL), described below. Raw results
  are retained; this is not represented as a clean whole-harness PASS.
- The final driver additionally registers the panel suite (63 suites); its whole
  file passed independently, including a pinned-only PATH run. No completed
  63-suite omnibus execution is claimed. Final focused checks cover the final
  source; standard initial-run and focused records remain distinct.
- Native Windows: UNVERIFIED; Linux and simulated Windows branches do not prove it.

No live inference, calibration or official LHCB arm was run. The standard dev
harness includes legacy deterministic compaction suites; these are not LHCB.

## Additional dev-only baseline failures, not waived

The broader installed-root run exposed two more failures than the original four.
Both were reproduced independently on the unchanged baseline archive with its
normal `data/settings.yaml` default `engineering-profile: deepseek-codex`:

- `MuseAgentPlane.Tests.ps1`: `Muse routing rejected: active profile
  'deepseek-codex' is not a muse-engine profile`.
- `AihControllerIdentity.Tests.cjs`: its final Muse bridge end-to-end section
  rejects instead of returning `next` with the same reason (original line 769).

The dev-only `Resolve-AihMuseRoutingTarget` resolves the active profile through
installation-level settings, even though the caller supplies a fixture settings
path. Its engine guard then correctly refuses the Dual profile for Muse. This
routing/fixture-authority issue predates this patch: the pristine reproduction
uses original scripts, UI and tests and produces the same failures. Changing
routing/profile policy or unrelated fixtures is outside the four scoped fixes;
neither failure was fixed, suppressed or accepted as PASS here.

Both suites passed in the previously accepted CCv2 integration evidence, whose
routing authority/fixtures differ. That historical result does not prove the
future combined tree. Re-run both on the reconciled candidate and investigate
any remaining failure before declaring merge readiness. Their pristine logs
and hashes are recorded alongside the standard harness report.

## Short-lease investigation — actual ownership defect preserved

Two separate results must not be conflated:

1. The original A12 live-holder test is scheduling-sensitive: it waits a fixed
   four seconds after spawn, not an acquire acknowledgement. The lease is four
   seconds; a two-second heartbeat also invokes a cold PowerShell CLI. Measured
   acquire/renew calls took 2.111/2.334 seconds in the diagnostic. A delayed
   initial holder demonstrably lets the parent acquire first. Process existence
   alone cannot prove lease ownership: the recorded PID belongs to the exited
   CLI process, not the long-running Node holder.
2. A real correctness risk exists after successful renewal. Using unchanged
   CCv2 authorities at `390af181c79df08e4da1ee91a408238767d70d81`, the diagnostic
   paused delivery of a real successful renewal result until its actual lease
   expired, then acquired the same operation with a new owner. When resumed,
   the stale applier appended an event (7 → 8), returned `committed` with
   `mutated: true`, and left the new owner's lock intact. This reproduced three times, including the final readable regression.
   The CLI renewal/release correctly reject the old token as `not-owner`;
   the applier's previously successful ownership proof becomes stale across
   suspension and is not fenced at the subsequent mutation.

[Committed observations and source hashes](evidence/dev-baseline-stabilization/short-lease-ownership.json)
preserve this **FAIL**. The reproducible manual regression intentionally remains
red against the accepted unchanged integration revision:

```sh
node tests/diagnostics/ShortLeaseOwnership.cjs /path/to/unchanged/ccv2-checkout /tmp/short-lease.json
# Expected on revision 390af181...: exit 1, stale-owner mutation assertion.
```

Use `AIH_TEST_PWSH` to select an explicit PowerShell executable. It creates only
private temporary task/session/lock fixtures and reads existing CCv2 modules and
unit fixture builders. It does not edit the CCv2 checkout or any benchmark. It
is a separate manual CCv2 diagnostic, not a dev-only harness dependency.

The session seam and flush acknowledgement use the accepted A10 unit double;
this is an ownership-logic reproduction, not a live DSH disk-corruption test.
All compaction and lock authorities are real, unchanged modules.

The unchanged A10 active-apply suite also ran: **171 PASS, 0 FAIL**, including
pre-mutation renewal-loss refusal and zero mutation. That coverage does not
prove safety for suspension **after** successful renewal. Concurrent session
corruption and a default 60-second lease suspension were not tested; the proven
result is stale-owner mutation with a supported four-second lease. Do not claim
that data corruption was observed or that default leases were proven safe.

This is a **blocker for unconditional CCv2 merge readiness**. A separate
CCv2-authorized follow-up must establish mutation-time fencing/exclusivity
through suspension and add a passing regression. Increasing lease durations or
weakening the live-holder assertion cannot resolve the ownership invariant.
CCv2 remains unchanged in this stabilization PR.

## Remaining release gates

The stabilization fixes are reviewable; CCv2 merge/release remains conditional.
Execute the [native Windows checklist](dev-baseline-windows-verification.md) on
an immutable combined candidate: clean installation, upgrade/migration and user
state retention, actual startup/restart/stop, production PowerShell 5.1 plus a
separate PS7 lane, offline OpenCode Go routing and installed CCv2 dependency and
tokenizer closure. Preserve native job evidence and resolve the demonstrated
lease ownership defect in a separately authorized change. Do not merge #29 or
start another benchmark as part of this task.

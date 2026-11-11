# Nexus DSH CI

## Baseline audit

Audited `origin/dev` at `7448ac9a`. GitHub's repository Actions permissions API returned `enabled: false`. The run history contains seven failed runs, all pushes to `main`. The last was August 28, 2026. Its Windows job failed closed on an upstream UI bundle replacement whose expected structure had changed. Current DSH 0.2.2-rc.1 uses a supported UI plugin composition. The API establishes that Actions are currently disabled. The disable date and reason are unknown. [Run history](https://github.com/Kaloyan3D/Nexus/actions) · [Latest historical run](https://github.com/Kaloyan3D/Nexus/actions/runs/33213929650)

| Previous workflow | Coverage and limitations |
| --- | --- |
| CI | Ran on every push and PR. Windows installed in the checkout and ran the harness again with the runner's PowerShell 7. Linux provisioned the same PowerShell tarball in a separate smoke and during setup, then ran the installed harness again. Fail-fast setup could prevent both diagnostics and subsequent checks. The Linux offline doctor checked credential presence despite disabling provider calls. There was no macOS job, no structured report upload and no aggregate gate. |
| Muse Foundation | Ran on all PRs and pushes to `feature/muse-integration`. Windows and Linux ran the JS and PS Nexus profile contracts using runner toolchains. Both contracts already run in the production harness. |
| Registry Legacy Baseline | Ran on selected file changes for PRs and selected branch pushes, plus dispatch. The narrow path filter omitted dependent code and would leave an absent check on unrelated PRs. It ran the frozen legacy contract on Node 22 instead of the installer pin. |

The older workflows used read-only contents permissions and regular PR events. Their action tags were mutable and checkout persisted credentials by default. `Test-Tiers.ps1` needs a real DeepSeek key and performs provider inference. The deterministic harness has a separate exit code and a structured report with `NOT_RUN` entries for incomplete suites. Two harness rows ran twice. The migration's recorded POSIX baseline also identified synthetic credential fixtures tripping the source scan and the CCv2 restriction test importing modules deliberately absent from a clean install. Windows' out-of-tree installer omitted nested scripts, fixtures, documentation contracts and POSIX launcher sources read by tests. [DSH migration evidence](../integration/dsh-0.2.x-migration-report.md#l3-results)

## Required workflow

`Nexus DSH CI` runs on PRs into `dev` and `main`, pushes to those branches, merge queues and manual dispatches. Every relevant event gets the same source and install jobs, including documentation-only changes. Superseded runs for the same event and ref are cancelled.

- **DSH source contracts** checks workflow syntax with a checksum-pinned actionlint release, JS and POSIX shell syntax, PowerShell parsing, shell fixtures, offline registry contracts and the complete CCv2 production-policy source proof. The source Node version comes from `config/versions.json`.
- **DSH install (Windows x64)** provisions from the public Windows setup entry point in runner temp, verifies the pinned Node version, invokes the installed offline doctor and exercises the production harness under Windows PowerShell 5.1 and the runner's PowerShell 7.
- **DSH install (Linux x64)** and **DSH install (macOS ARM64)** run the POSIX installer with separate temp install and launcher roots. Each checks the executable runtime versions and runs the installed doctor and harness through the published launchers. Harness fixtures use the runner's canonical temp path outside the checkout, so Git discovery and macOS path aliases do not change test results. GitHub documents `macos-15` as ARM64. [GitHub-hosted runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- **Nexus DSH required** succeeds only when the source job and all install matrix jobs succeed. Report validation rejects missing, empty, incomplete and failing runs, including assertions reported as failed with a zero process exit. Enable Actions and validate the check on a hosted PR before selecting **Nexus DSH required** as the required GitHub Actions status on `dev` and `main`. Existing branch protection settings were left as-is.

The opt-in `--skip-local-checks` and `-SkipLocalChecks` installer switches delegate post-install checks to CI, which runs them explicitly. Each installer still provisions and verifies its runtimes, installs locked dependencies and verifies DSH composition. The synthetic doctor value exists only in the offline doctor step. The production harness covers routing and profile contracts, startup and controller lifecycles, the DSH integrations, CCv2 restrictions and ordinary compaction. The installed CCv2 policy check validates the deployed dependency closure and refusal behavior. The source job separately runs the historical-record and direct writer proofs with the production policy. The DSH credential scan retains its synthetic-secret negative controls and excludes the out-of-scope Native test fixtures.

Set `ccv2_lab` on manual dispatch to run all 81 experimental CCv2 suites on Linux using the installed toolchain and source modules. The normal PR gate runs the production lane. Lab failures surface as failures on the opt-in run. The earlier source-root lab run reported 13 failures, primarily real-host proofs against DSH 0.2.2. The fencing investigation and provider-backed `Test-Tiers.ps1` remain separate from the PR gate. [CCv2 lane inventory](../testing/CCV2-LAB-SUITES.md)

## Supply chain and diagnostics

GitHub-owned actions are pinned to release commit SHAs with signatures verified through GitHub. Checkout credentials are removed and the gate has an empty token permissions map. Jobs use GitHub-hosted runners, regular PR events and no provider secrets. Fork-run approval is governed by the repository's Actions policy.

The lock gate requires exact root dependency versions, public npm HTTPS tarballs with SHA-512 integrity, matching DSH/runtime version metadata and an exact install-script allowlist. CI enables npm's strict script preflight. Only npm's content-addressed download cache is restored, keyed by OS, architecture, pins and lockfile. Installs build a fresh tree with `npm ci`. Runtime downloads and their checksums are still exercised on every platform. Audit reports all advisories and fails at critical severity or on audit request errors. At the November 8 baseline npm reported 202 high, 15 moderate and zero critical package entries, including propagated dependencies. The high root advisories were in `undici` and `zod`; upgrading the DSH dependency graph is separate work.

Install output, raw harness output and JSON reports are retained for seven days. The step summary lists completed suites and failed or incomplete suites. Installed state and credential files are outside the artifact directory.

## Local validation

- Checksum-verified actionlint 1.7.12 with ShellCheck 0.11.0 accepted the workflow. The PowerShell parser accepted all 135 tracked DSH and CI PowerShell files.
- The pinned toolchains passed the tracked JS and shell syntax checks, four shell suites (61 assertions), four registry suites (124 assertions), and the three CCv2 source suites (321 assertions). The lane inventory test confirmed 104 production and 81 lab rows.
- The lock check validated 765 entries. Pinned npm passed the strict lifecycle preflight and the critical advisory gate. Gate checks rejected failed, skipped and cancelled dependencies. Report checks rejected missing reports, incomplete suites and zero-exit failed assertions.
- Native macOS ARM64 setup provisioned Node 24.18.1 and PowerShell 7.5.3, installed 690 packages with strict lifecycle enforcement, and verified the real DSH composition. The local run reused the checksum-verified runtimes after an interrupted invocation and two integrity-verified npm downloads from the host cache. The installed offline doctor passed.
- The installed macOS production harness completed all 104 suites. It recorded 103 passing suites and one failure in `RegistryInstalledRuntime`, whose fixture extracted the Windows registry copy block using a comment moved by this change. The extraction now follows the copy block itself. The corrected suite passed all three assertions on the installed tree. Report validation also rejected the original failed report. A second full run with the corrected fixture remains unverified.
- GitHub-hosted jobs, native Windows and Ubuntu x64 still require validation once repository Actions are enabled.

Run `git diff --name-status 7448ac9a..HEAD` from this branch for the complete file inventory.

## Plugin-first integration

Once the migration lands, register its controller, strategy, session deduplication, host ownership and transition contracts in the existing production harness table. Verify that each installer publishes new runtime modules and that offline composition exercises the actual host service. Keep tests that need only source fixtures in the source job and keep the installed tests on clean, installer-produced trees. Keep the aggregate check name stable through the migration.

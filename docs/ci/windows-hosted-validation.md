# Windows hosted validation

The first hosted run installed DSH and passed the offline doctor on Windows x64. The PowerShell 5.1 harness stopped producing output at StartupProviderIsolation and was cancelled by the 40-minute job deadline. Its logs did not identify which operation blocked. The PowerShell 7 harness never started.

The setup-upgrade fixture now supplies the POSIX entry point required by the real Windows installer. The process-identity probe uses the .NET Framework command-line property and checks the exact argument vector, including a space and an empty argument. The credential example and redaction probes tolerate the Windows line ending and JSON escape representations, respectively.

Windows PowerShell 5.1 and 7 now run in independent matrix jobs with separate clean installs, validated reports, and security completion proofs. The aggregate gate requires both, along with Ubuntu, macOS, and source contracts.

The harness streams child output, records the active suite and completed rows in a progress JSON file, and uses a child-process deadline. A timeout or launch failure is INCOMPLETE. Normal suite failures and timeouts can still upload diagnostics and produce a final failed report. The startup-provider fixture records fixture preparation, launch, readiness and process exit as separate stages. Its subsequent launcher calls and HTTP probes are bounded, and launcher stdout and stderr are stored in the CI artifact directory.

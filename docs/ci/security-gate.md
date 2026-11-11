# DSH request-boundary security gate

The production harness previously took the child exit code as the verdict. The DeepSeek actual-host suite printed a skip and returned zero when its external fixture was missing. CI received a PASS row with zero assertions and accepted it.

## Result contract

The harness retains the version 1 report fields and adds per-suite skip evidence and completion verification, plus aggregate status counts.

| Status | Meaning |
| --- | --- |
| PASS | The process exited successfully, with no explicit failure or skip. Suites that declare a completion marker also produced it exactly once. |
| FAIL | The process exited nonzero or emitted explicit assertion failure evidence. |
| SKIP | The process exited zero and explicitly reported a skip. A suite with a required completion marker makes a local run fail. Other local skips retain their previous nonfatal exit behavior. |
| NOT_RUN | Fail-fast stopped the harness before it invoked this suite. |
| INCOMPLETE | The harness could not establish an exit status, or a zero-exit suite omitted or duplicated its required completion marker. |

CI requires every suite in the selected inventory to pass. It compares suite names and script paths in order against the checked-in harness, checks that each row completed, and requires a matching result line for each suite in the adjacent raw log. A skip or assertion failure in the log, a missing report, or a missing required marker fails the platform job. The aggregate gate requires both the source and platform jobs to succeed. Suites without assertion counters can still pass when they meet their contract.

## Actual host fixture

The original R7.5B.1b test depended on a Linux bubblewrap supervisor with an overlay endpoint, a fixed port and a DSH 0.1.1 installation. Its documented launch environment included a Python CLI adapter, a supervisor state file and a loopback relay. The overlay and supervisor are not part of the repository. [Historical fixture documentation](../operations/r75b1b-deepseek-request-boundary.md#isolated-installation-and-host-acceptance)

The replacement starts the installed DSH 0.2.x web profile via its own boot entry point. It creates a private home, workspace and install layout, regenerates the home patch there and mounts the installed DeepSeek and Muse presets onto real agents. It uses an ephemeral loopback listener and invokes the real DSH scoped pre-step and request waterfalls. The test terminal records whether the request reached it. No prompt is submitted to a model and the terminal never hands off to a provider. Telemetry, browser launch and URL printing are disabled in the private fixture. The Node socket guard blocks outbound connections and the suite requires zero outbound attempts.

All 29 historical matrix cases remain in the production inventory, including durable refusal, worker and header checks, generation and route tampering, connection revocation, TaskController identity and ledger preservation, warm authority checks, explicit rollback, restart and Muse admission. The suite records each case and emits its required marker only after the matrix and cleanup finish. The fixture uses the installed runtime and dependencies, including the actual TaskController PowerShell subprocess.

The test reads installed dependencies and managed preset assets. It does not copy installed credentials, sessions or bindings. Fault injection changes only fixture-owned files. The fixture shuts down its own host and removes its temporary tree, using Windows directory junctions for the shared dependency and toolchain paths. The installed jobs keep the same 104-suite inventory on Windows, Linux and macOS.

## Reproduction

Use the pinned Node from a disposable, composed installation. Set `NEXUS_RUNTIME_ROOT` to that installation and run `tests/DeepSeekRequestBoundaryHost.Tests.cjs` with Node. A normal run must print 29 `BOUNDARY CASE` lines and exactly one `NEXUS SUITE COMPLETE: DeepSeekRequestBoundaryHost` line.

- Unset `NEXUS_RUNTIME_ROOT` to test missing fixture configuration.
- Pass `startup` to reserve a temporary loopback port and force the actual host listener to collide with it.
- Pass `bypass` to remove the request guard from the private DeepSeek composition. The test must observe a pending request reach the terminal and exit nonzero.
- Run `node .github/ci/test-harness-summary.cjs` with Node and PowerShell 7 on PATH. It tests missing and incomplete reports, explicit and hidden skips and failures, inventory omissions, and completion proof checks.

Windows and Linux execution require hosted verification. Local macOS evidence establishes the installed harness and the actual pinned-host boundary, with the request terminal replacing provider handoff.

## Local validation

On macOS ARM64, the corrected installed production harness passed all 104 suites with 3,287 passing assertions. It recorded zero failed, skipped, not-run or incomplete suites. The actual host matrix recorded 24 denials and five admissions with zero outbound socket attempts. The validator accepted the JSON and matching raw log, and the aggregate shell gate exited zero.

Missing install, a real listener collision and a guard bypass each exited nonzero. The bypass let pending authority reach the counting terminal and failed the zero-dispatch assertion. The validator and gate also rejected zero-exit skip and failure evidence, incomplete inventory and a missing report. Process controls independently exercised all five suite statuses. Actionlint, ShellCheck, the inventory check and 15 report validator fixtures passed.

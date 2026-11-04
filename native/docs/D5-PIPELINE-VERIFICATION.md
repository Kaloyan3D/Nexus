# D5 — a pipeline hid a failing test run

## What happened
In the R-NATIVE-2 run, the model ran `cargo test … 2>&1 | grep/head/tail …` inside `sh -c`. The command's output contained `test result: FAILED. 61 passed; 4 failed`, yet the runtime recorded `"verification": "pass"` and the Desktop showed a passing run. Cause: the verdict is the exit status of the process the sandbox started (`sh`), and a shell pipeline's status is the **last** stage's — `tail`, which succeeded.

A second, related weakness: the run's verified outcome used only the **last** verification command, so a later *narrower* passing command overrode an earlier failing one, and failures that had left the bounded (64-entry) activity list were invisible.

## The fix
**Tool layer** (`nexus-tools`, the single `sh -c <script>` path of the workbench policy):
* A script that contains a pipeline (`a | b`; `||` is not one) is flagged at resolution.
* Before running it the executor **probes** the shell: `sh -c '(set -o pipefail) 2>/dev/null'`, cached per program path. `pipefail` is never assumed (older `dash`, busybox variants and POSIX shells before 2024 reject it).
  * supported → `set -o pipefail` is prepended to the script (`pipefail: "applied"` in the result): the status is that of the first failing stage;
  * unsupported → the script is left untouched, `pipefail: "unsupported"`, and a zero status is reported as **`unverified`**, never `pass`;
  * not a pipeline → the command is byte-identical to the request (`pipefail: "not-applicable"`).
* Exit status **141 under pipefail** (a producer killed by SIGPIPE because `head` closed the pipe) is **`unverified`**: the producer was cut off, so its result is unknown. It is neither a pass nor a failure.
* Timeouts, cancellation, revocation and spawn errors are unchanged (`fail` / their lifecycle phases).

**Broker**: `unverified` is not a verification at all — it does not update `last_test`, does not clear "changes not verified", and is shown to the model as `status: "unverified"`. The broker also counts, over the whole run, verification commands (by arguments digest) whose latest result is a failure; a later pass of the **same** command clears it, a different command does not (`unresolvedFailedChecks`).

**Verified outcome / Desktop**: `verified-passed` now requires that no such failure is unresolved. Otherwise the outcome is **`verified-mixed`** and the Desktop says "Last check passed · N other check(s) failed" with a warning tone and an explanation — never "Tests passed". `checksFailedUnresolved` and `checksUnverified` are reported (optional fields; older brokers/clients ignore them).

## Evidence
* `nexus-tools/tests/pipefail_d5.rs` (real Kernel + sandbox): failing producer + `tail`/`grep`/`head` → `fail` with the producer's exit code; successful pipeline → `pass`; `yes | head` → `unverified`; non-pipelines unchanged (also byte-identical argv); cancellation keeps its journal classification; a stand-in shell without pipefail is detected and the script is not rewritten; pure verdict table. With the fix disabled, the failing-producer test reproduces the original record (exit 0, `FAILED` in stdout, `verification: pass`).
* `nexus-client/tests/coding_outcome.rs`: earlier failure + later different pass → `verified-mixed`; same command re-run to a pass → `verified-passed`; failures outside the activity window still count; `unverified` is neither pass, fail nor uncertain; plain pass/fail unchanged.
* `code_a56.rs::d5_a_failing_suite_piped_through_tail…` (real broker): the fixture crate's failing `cargo test … | tail -n 3` is recorded as exit 101 / `fail`, and after a different passing `cargo check` the run's outcome is `verified-mixed` with one unresolved failed check.
* `apps/nexus-desktop/src/test/outcomeMixed.test.ts`: label/tone/wording of the mixed state; a passing run is unchanged; payloads without the new fields still render.

## Limits
* Only workbench `sh -c` scripts are rewritten. Other programs (`cargo`, `npm`, … run directly) have no pipeline. Shell constructs that bypass the exit status (`cmd || true`, `; true`, `cmd; echo done`) are the script author's explicit choice and are not second-guessed.
* The probe runs the host's shell; the sandbox binds the same system binaries.
* Workbench commands keep their long build allowance, so a short approver wall limit does not shorten them (unchanged behaviour); timeout classification is covered by the verdict table and by the existing plain-command timeout test.
* The run-wide failed-check set is recorded when the run finishes; a live run's outcome uses the activity window until then.
* The set is keyed by arguments digest: a re-run with slightly different arguments is a different check.

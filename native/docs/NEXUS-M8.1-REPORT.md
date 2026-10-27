# Nexus Native — M8.1 Reliability Closure Report

Branch `feature/rust-native-core`. Local commits only; no push, merge or
deployment. Validated M7.1/M8 baseline was `b6ca918`; this closure's final
executable source is `fde1023` (baseline commit `ad1b94d` and this report add
no executable changes).

## 1. Background jobs vs workspace ownership — concern CONFIRMED, corrected

Audit result: the concern was real. The Direct Workspace one-writer rule was
a per-run broker claim (`direct_claims`), released when the creating run
ended — while its background job kept writing. A reproduction test
(`m81_a_job_from_an_ended_task_…`) showed an unrelated Task B being silently
accepted on the same folder while Task A's file-writing watcher was alive
and writing.

Correction (broker, `76c0e72`, smallest change at the coordination point):

- The broker now records job ownership (job → project, owning run; `user`
  for CLI/Desktop starts) and, at submission time on a Direct project,
  refuses a new writer (`project-busy`, naming the job and how to stop it)
  when a running model-started job belongs to a **different conversation**.
- Same-conversation and user-started jobs proceed (the normal dev-server
  workflow is preserved), and the run record names them: background changes
  are explicitly *not* attributed to the run's commands, and checkpoints
  taken while such a job writes **may not cover its changes** — no full
  recoverability is claimed in that state.
- Revocation and restart behavior is unchanged (grant watcher still kills
  jobs; records still reconcile to `interrupted`/`stopped`).

## 2. Full Access supervision — escape CONFIRMED, stronger guarantee implemented

Testing `setsid`/daemonized descendants against the M8 implementation
confirmed the documented best-effort limit and worse: descendants escaped
process-group cancellation, and a detached descendant inheriting the output
pipes could hold a command's result open.

Correction (`5cb6110`), reusing the existing cgroup v2 infrastructure with
no sandbox restrictions added (membership and kill only, no limits):

- Every Full Access execution gets a dedicated `nexus-host-*` cgroup leaf.
  The child joins it in `pre_exec` before `exec` (a post-spawn supervisor
  write races the workload's first fork and loses — demonstrated during
  development). Membership is verified; without it the run degrades to
  process-group supervision and its result says so.
- Cancel, revocation (fence), timeout and normal exit all end with
  `cgroup.kill` + leaf removal *before* pipe readers are joined, so
  `setsid` descendants die with the execution and cannot hold pipes open.
- Daemon crash: the direct child still dies via `PR_SET_PDEATHSIG`; any
  surviving leaf members are killed at the next daemon start (startup sweep
  of `nexus-host-*` leaves only). Application shutdown stops the supervisor,
  which takes the cgroup path above.
- Verified end-to-end (`hostexec_m8`, 7/7): a `setsid` heartbeat descendant
  is dead after cancellation (heartbeat provably stops), a daemonized
  descendant is reaped when its command exits, plus all M8 behaviors.
  Each result reports the actual enforcement (`kernel-cgroup` or
  `process-group-polling`); nothing promises more than the run used.

Residual: on a machine without a writable cgroup v2, supervision remains
process-group best-effort and a `setsid` descendant can outlive its
command; the result states the enforcement used. Between a daemon crash
and its next start, cgroup-resident descendants of a crashed execution can
persist (they are visible as `nexus-host-*` leaves and are swept at start).

## 3. Git limitation preserved

The M6 creation-window regression tests pass unchanged
(`gitwrite_m6`, 4/4, including
`a1_a_repo_created_by_the_command_itself_is_not_mount_protected_in_that_command`).
Results still report `gitMetadataCreated`. This is observation/reporting,
not prevention; no seccomp work was started.

## 4. Final smoke acceptance (disposable projects, this session)

| Workflow element | Evidence |
|---|---|
| Create/modify/build/test in a disposable Direct project | `devflow_m6` pass |
| Dependency installs via approved Internet destinations | `live_m6` pass with `NEXUS_LIVE_M6=1` (owner-approved hosts only) |
| Dev server via agent job tools + HTTP access + edit while running + stop | `m71_a` pass (bridge HTTP GET, foreground observes edit) |
| Git commit under an authorized Git grant | `gitwrite_m6` pass |
| Full Access command reaching a harmless outside file | `hostexec_m8` + broker `m8_a` pass |
| Revocation terminating execution truthfully | `m71_b` (jobs die on revoke); host cancel/fence paths in `hostexec_m8` |

## 5. Validation (final executable source `fde1023`)

| Gate | Result |
|---|---|
| Full native battery (`NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace`) | **1499 passed, 0 failed, 64 ignored** |
| fmt + strict clippy | clean |
| Tauri | 31 passed |
| Desktop tsc / eslint / vitest | clean / clean / 188/188 |
| prodgate | 14/14 |
| Provider bodies | **BASELINE MATCH** on new `M8.1-BASELINE.json` (190 tests, 1703 bodies) |

Notes: one egress test failed once mid-battery under load average ~9
(cancel landed before process start) and passed on rerun and in the final
battery — timing flake, recorded not suppressed. Provider-body diffs vs the
M7.1 baseline were classified by direct body inspection: one intentional
new test (`m81_a`), concurrent-run request ordering (named exception), and
volatile job-runtime values (grant authority digest, host port, job id,
pid, timestamps) now normalized by the skeleton scrubber — as proof, the
previous milestone's independent dump matches the new baseline with only
the new test missing. Accepted catalog digests are unchanged.

Commits: `76c0e72` (coordination), `5cb6110` (host cgroup supervision),
`fde1023` (fmt), `ad1b94d` (baseline), plus the CCv2 inventory `5ae05d3`.

## 6. Next track

[NEXUS-CCV2-INVENTORY.md](NEXUS-CCV2-INVENTORY.md): reuse inventory of the
46 legacy `Context*V2.cjs` modules, their Native integration seams (broker
worker bridge, thread store, current `context.rs::compact()` as the bar),
and a shadow-first implementation plan with a pre-registered benchmark
gate. No CCv2 code was implemented in this closure.

## Verdicts

- **Trusted Workspace: GO.** Coordination hole closed, full battery green,
  confined semantics unchanged.
- **Full Access: GO as an explicit opt-in, with residuals.** Supervision is
  now kernel-cgroup strength where the machine offers it and honestly
  labeled where it does not; outside-project effects remain unobserved and
  irreversible, exactly as the grant consent states.

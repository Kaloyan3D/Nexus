# Nexus Native — M7.1 Closure and M8 Full Access Report

Branch `feature/rust-native-core`. Local commits only; no push, merge or deployment.

## Step 0 — Source identity (M7 report correction)

The M7 report named `f0239cc` as final code and `2876ad4` in its validation
section. Verified against Git history:

- `2876ad4` ("M7 manager death kills its jobs") was an **intermediate** test
  commit, an ancestor of the final code.
- Final M7 executable source: `f0239cc` (Desktop M7D panel), on top of
  `ed6dcd1` (broker job verbs, CLI, agent tools). The M7 report itself was
  committed as docs-only `52dea0e`.
- The report has been corrected, and the full battery was re-run on the final
  M7.1/M8 source below rather than relying on the intermediate-SHA run.

## M7.1 — Background job agent integration (complete)

- New versioned engine profile `RepoCodeJobsV1` (catalog digest
  `18168580698f1ef02b59c7f808da8ed0a709f0c50e7f3ea36d27961c2dc77bfc`) =
  `RepoCodeV1` + the four job tools. Old profiles and their schemas are
  byte-identical (`RepoInspectV1`, `RepoCodeV1`, `RepoCodeMuseSignalsV1`
  digests unchanged).
- New engine `muse-v0-jobs` and registry mode `engineering-v2-jobs`; the mode
  was added to the reviewed Native scope table (`native-issuer.cjs`), the
  registry service mode list and the legacy-import closed identity list, in
  the same reviewed-code-change manner as the adaptive mode.
- Job calls dispatch through the existing validated broker interface
  (`crate::jobs`) in the run loop; the actual job ID, state, logs and errors
  are returned to the model. Background file effects keep M7 evidence
  semantics: status/logs are file reads only and never rescan the repository;
  effects are not attributed to unrelated foreground commands.
- Mock-model acceptance with the real broker, daemon, sandbox and
  JobManager (`code_a56`, `m71_a_…`, `m71_b_…`): the model starts a Node dev
  server, receives its real job ID, queries status, reads logs, reaches it
  through the authorized loopback bridge, edits a file while it runs, runs a
  foreground command that observes the edit, and stops it. A missing program
  refusal reaches the model as a tool error. A second test proves a job
  outlives its run under the frozen grant and is killed by grant revocation.
  Broker/tools-level tests from M7 cover restart reconciliation (dead jobs
  reconcile to `interrupted`/`stopped`, never `running`), unauthorized
  ports, and manager death.
- Cross-task writer lease: jobs never acquire or bypass the Direct Workspace
  writer lease; unrelated tasks' foreground commands still pass through the
  unchanged daemon lease path. Job processes write under their own frozen
  grant only.
- Git creation window: the A1 regression tests are preserved, command
  results still report `gitMetadataCreated`, and the limitation remains an
  explicit residual risk (below). No seccomp supervisor was built in M7.1.

## M8 — Full Access host execution (complete)

### Backend (`host/1`)

- A distinct `HostBackend` implementing the existing `ExecBackend`
  capability contract (`fs=[Full]`, `net=[Full]`, kill guarantee honestly
  declared as process-group best-effort). Execution runs through
  `nexus_tools::host_exec::run_host`: real host programs resolved against the
  real PATH or the project, real cwd, environment allow-list (credential
  variables are not inherited; model variables cannot replace PATH/HOME),
  process group with `PR_SET_PDEATHSIG`, wall-clock bound, bounded tail
  output, and group kill on cancellation, revocation (fence) or timeout.
- The branch is taken **only** from the Kernel-sealed `fs=full` scope. There
  is no code path from a failed sandbox run to the host backend; a missing
  host program refuses with an actionable message and no substitution.
- Jobs refuse Full grants (background host jobs are not supported); the
  confined backends are unchanged.

### Grants and authority

- Standing grants now accept `fs=full` **only** together with `net=full` and
  only for Direct projects. `full`+offline/controlled and
  workspace/scratch+`full` are refused at grant time with actionable text —
  Nexus does not claim Offline or Controlled Internet for an unsandboxed
  process. The consent text states plainly that commands run as the user,
  anywhere they can reach, and cannot be undone outside the project.
- The Kernel seals `full` only as fs=full + net=full under a grant
  (`DeclaredScope` and process-scope binding both enforce the pairing).
- The daemon requires the operator switch `--enable-host-exec`
  (`NEXUS_ENABLE_HOST_EXEC=1` in the runtime launcher; off by default, never
  implied by `--enable-process`). A full grant on a daemon without the
  switch refuses at task creation — never a silent confined downgrade.
  Legacy projects and grants cannot acquire Full Access: nothing defaults
  to or upgrades into `full`.
- Ask/Auto semantics, frozen task grants, lineage narrowing, expiry and
  revocation are the existing mechanisms, unchanged. The model cannot
  choose the backend: the process tool schema has no backend/scope field,
  and the sealed scope comes only from the task's frozen grant.

### Evidence and recovery

- Each host execution journals `prepared`/`running`/`exited` with backend
  `host/1`, exact argv, cwd and the grant identity.
- The result reports a bounded pre/post stat manifest of the **project**
  (created/modified/deleted counts and samples, truncation flagged),
  `outsideProjectEffects: not observed`, and `recoverable: false`. Nexus
  does not scan outside the project and does not claim the M3B checkpoint
  can reverse host effects.
- Active Full Access execution is identifiable: the run record carries
  `execScope: "full"`, the model-facing tool result carries
  `backend: "host"`, `fsScope: "full"` and the effects block, and Desktop
  badges a full grant as "FULL ACCESS (unsandboxed, runs as you)".

### CLI and Desktop

- CLI: `nexus project grant … set --fs full --net full` (the same
  preview/consent flow; broker refuses when the daemon did not enable host
  execution, before anything is stored).
- Desktop: the Permissions editor offers Full Access only for Direct
  projects on installations whose runtime reports host execution available,
  with a distinct danger alert; selecting it forces Full Network, and the
  grant summary is visibly distinct. The renderer never receives approval
  credentials (unchanged).

### Acceptance (actual runs)

- Tools (`hostexec_m8`, 5 tests): real host programs in the real cwd with
  exit codes and stdout; a write **outside** the project succeeding (the
  defining difference from Workspace scope) while the result declares those
  effects unobserved; `fs=full` without `net=full` refused for
  offline/controlled/install; missing program refused without fallback;
  cancellation kills the process group.
- Broker (`code_a56`, `m8_a/b/c`): mock model under a full grant runs a host
  command that writes the real project folder; the tool result identifies
  `backend: "host"` and the run records `execScope: "full"`. Full grants are
  refused when the daemon lacks `--enable-host-exec`; unsupported
  combinations are refused at grant preview.
- Confined execution unchanged: the full workspace battery (below) covers
  the M1–M7 suites on the same source.

## Validation

Final executable source: `b6ca918` (all gates below ran on it; the provider-baseline commit `f3ce63d` and this report add no executable changes).

| Gate | Result |
|---|---|
| Full native battery (`NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace`) | **1496 passed, 0 failed, 64 ignored** (86 test binaries; first run found one failure — the M1 test asserting an unsealed caller-chosen `full` scope is refused — fixed by sealing `full` only under a full/full grant, then re-run in full) |
| fmt + strict clippy (workspace, `-D warnings`) | clean |
| Tauri tests | 31 passed, 0 failed |
| Desktop tsc / eslint / vitest | clean / clean / **188/188** |
| prodgate | 14/14 |
| Provider-body baseline (A2 manifest) | **MATCH on the new M7.1 baseline; classified diff on the preserved M6 baseline.** Against `M6-BASELINE.json` the only differences are the three intentional new tests (`m71_a`, `m71_b`, `m8_a`). The first four skeletons of `s8_worker_timeouts_…` were proven nondeterministic (two dumps on identical source differ only there) and are now a named exception in the checker, like the existing timing-count list. New versioned baseline `test-vectors/provider-bodies/M7.1-BASELINE.json` (189 tests, 1699 bodies, source `b6ca918`) checks **BASELINE MATCH**; old profile digests inside it are unchanged and `RepoCodeJobsV1` is pinned by its Rust catalog-digest test |

## Residual risks and unsupported configurations

- **Git creation window (unchanged from M6 closure):** a command that
  creates `.git` can write hooks/config and commit within that creating
  command even without `gitWrite`; the result reports `gitMetadataCreated`.
  Prevention needs a separate, proven seccomp-supervisor design covering
  pathname races and fd-based mutation. Not claimed as fixed.
- Full Access is exactly as dangerous as the OS user: anything the user can
  read, change or delete, a command can too, including other projects, keys
  and credentials. Output redaction is heuristic. There is no rollback
  outside the project, and inside-project recovery is limited to the
  observed manifest (no checkpoint guarantee for host commands).
- Host supervision is process-group based (declared as such): a process
  that deliberately daemonizes itself out of the group can outlive the
  command; `PR_SET_PDEATHSIG` covers daemon death for direct children.
- Resource limits for host commands are polling/wall-clock based, not
  cgroup-enforced; `resourceEnforcement` says so in every result.
- Unsupported: Full Access for isolated working copies, background jobs
  under Full grants, Full with Offline/Controlled claims, jobs with
  Controlled Internet, ASP.NET Kestrel/`dotnet watch` (raw TcpListener
  tested), pnpm/yarn live installs (not installed in the test environment).

## Verdict

**GO — M7.1 closed, M8 Full Access complete, production-ready with the stated residuals.**
The confined Trusted Workspace path is unchanged and fully green. Full Access is
available as a deliberate, operator-enabled, per-project opt-in whose authority,
evidence limits and dangers are stated at every surface (grant consent, Kernel
seal, journal, tool result, Desktop). It is never the default, never a fallback,
and never silently acquired. Residuals above (Git creation window, host
process-group supervision limits, unobserved outside-project effects) are
documented limitations, not hidden gaps. No push, merge or deployment.

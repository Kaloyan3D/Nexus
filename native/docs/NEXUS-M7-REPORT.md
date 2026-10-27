# M6 Closure + M7 — Background Jobs & Dev Servers

Branch `feature/rust-native-core`. Final code SHA: `2876ad4` (this report is a docs-only commit on top).
Local commits only, no push.

## Part A — M6 closure

### A1. Newly created Git metadata (gap found, bounded, now stated and flagged)

Empirical result ([gitwrite_m6.rs `a1_…`](/home/kaloyan/Projects/Nexus/native/nexus-tools/tests/gitwrite_m6.rs)):
in a project with **no `.git` before the command**, a single shell command without `gitWrite` could
`git init`, rewrite `.git/config`, plant **and execute** a pre-commit hook (marker file created), and
commit — `init/config/hook/commit/marker` all rc=0. With `gitWrite`, the same creation-command window
applies to hooks/config of the just-created repo. From the **next** command on, the existing mounts
protect everything (commit refused without the grant; hooks/config refused with it) — pinned by test.

Why: protections are mount-level and prepared from entries that exist before the command; no existing
primitive (bwrap binds, Landlock by inode, descriptor-relative opens) can protect a path that does not
exist yet without creating it in the user's project (an empty `.git` placeholder would corrupt repo
discovery). Executable-name checks would not help (shells/scripts create metadata too) and were not used.

Correction shipped (`6477a22`), proportionate and honest rather than silent:
- the consent text now states the creation window in both grant modes;
- every in-place execution whose command created `.git` carries
  `gitMetadataCreated: {byThisCommand: true, mountProtectedInThisCommand: false}` in its result;
- tests pin both the window and the next-command boundary.
Proposed follow-up (not implemented): a seccomp user-notification supervisor denying writes under any
`.git` component when the grant lacks `gitWrite` (and under `hooks`/`config` when it has it) — the only
primitive that closes the window; it is a separate, focused change to the sandbox supervisor.

### A2. Provider-body baseline

Created ([M6-BASELINE.json](/home/kaloyan/Projects/Nexus/native/test-vectors/provider-bodies/M6-BASELINE.json),
[script](/home/kaloyan/Projects/Nexus/scripts/M6-ProviderBodyBaseline.cjs)): per-test skeleton digests
(tool outputs elided, canonical JSON) + request counts for 186 tests / 1,683 bodies, generated from
`26b4f50`, catalog digests pinned (`RepoCodeV1 e464de5c…`, signals `7c7c9bc1…`, inspect unchanged).
Verified: matches the M6 dump exactly; against the preserved M5 baseline it reports 1,676 skeleton
differences — unrelated schema changes are still detected, nothing is blanket-ignored. The five
request-count differences are the named crash-timing tests (kill-point dependent, same class as M4's
`s8` finding), listed in the manifest, not suppressed. After M7, the check still passes: **M7
introduced zero provider-body drift.**

### A3. Live Internet

Done under the owner's explicit approval (previous session): npm install 2,753 ms, Cargo fetch
1,025 ms, HTTPS git clone+fetch 1,510 ms against `registry.npmjs.org`/`index.crates.io`/
`static.crates.io`/`github.com` (all :443); `example.com` refused at CONNECT (403). See the
[M6 report](/home/kaloyan/Projects/Nexus/native/docs/NEXUS-M6-REPORT.md).

## Part B — M7

### Architecture (review summary)

- **Source of truth / ownership:** the daemon-owned `JobManager`
  ([jobs.rs](/home/kaloyan/Projects/Nexus/native/nexus-tools/src/jobs.rs)) is the only writer of job
  state; each job persists a record on every transition and `reconcile()` re-derives truth from live
  handles + pid + cgroup. A `running` record without a live supervisor becomes `interrupted` — never
  running, never completed.
- **Dependency direction:** jobs build on the existing sandbox spec/launch gate/frozen-grant
  preparation; the manager widens nothing. Exposure requires the sandbox port ∈ grant `devPorts`.
- **Failure semantics:** manager death stops all jobs (Drop + bwrap `--die-with-parent` + cgroup
  kill); limits (wall, cpu, memory, procs via `SandboxLimits`; log byte budget via watchdog + final
  tail enforcement) end jobs with honest exit codes (124 timeout, 137 memory).
- **Networking (M7C):** the launch gate forks an in-sandbox bridge listening on unix sockets in a
  Nexus-bound `/nexus-dev` directory, relaying to the server's loopback port — the M5 egress pattern
  inverted; the host side ([devbridge.rs](/home/kaloyan/Projects/Nexus/native/nexus-tools/src/devbridge.rs))
  only connects to that socket. Loopback-only bind, exposure dies with the job, `devPorts` are
  grant-sealed and narrow-only (`d069710`, CLI `--dev-port`). Namespace namespaces are never shared
  and no `setns` is used (empirically unavailable/unsafe from this user context).
- **Evidence (M7B):** jobs run in-place under the caller's frozen policy; foreground commands in the
  same workspace proceed concurrently (measured 31 ms while a server ran). Effects of a still-running
  job are not checkpointed per poll (no full rescans on status/log reads — both read the record/log
  files only); job file effects surface through the existing M3A observation of later foreground
  executions, honestly attributed as temporal.

### Acceptance ([devjobs_m7.rs](/home/kaloyan/Projects/Nexus/native/nexus-tools/tests/devjobs_m7.rs), 8 tests, real sandbox)

Node dev server reachable only via the authorized bridge and observes live file edits; sandbox port
not leaked onto the host; unauthorized port refused at start; short job exit code recorded; log bound
enforced; 1 s runtime limit ends a sleeper (exit 124); foreground command completes while a job holds
the workspace; Rust (std TcpListener) and .NET (SDK 10, TcpListener) servers run as jobs through the
bridge; manager death kills the server and the record never claims `running` afterwards; fake
`running` record reconciles to `interrupted`.

Performance on this machine: stop latency ≈10 ms; job server reachable within the first poll cycles
(suite of 8 incl. a .NET build completes in ≈3 s); status/logs are file reads (no repo scan).

### Remaining gaps (stated, not hidden)

1. **M7D wiring is not done:** `JobManager` is a library subsystem with grant/CLI support for
   `devPorts`, but it is not yet exposed through the daemon protocol, the broker, provider tools
   (`job_start` etc.), or Desktop. Adding provider tools must be a versioned catalog change against
   the A2 baseline. This is the next task, and it is wiring, not new mechanism.
2. Daemon-crash recovery is proven at manager/record level; a full daemon-restart integration test
   belongs with the M7D daemon wiring.
3. Revocation mid-job is enforced by `stop`/`stop_all` (mechanism tested); automatic triggering on
   grant narrowing awaits the same daemon wiring.
4. ASP.NET proper (Kestrel) was not used; the .NET test uses a raw `TcpListener` server under the
   SDK 10 runtime. `dotnet watch`, `cargo watch`, `next dev` are the same job shape but untested.

## Validation (final code SHA `2876ad4`)

| Gate | Result |
|---|---|
| Full native battery (`NEXUS_REQUIRE_SANDBOX=1`) | **1483 passed, 0 failed, 64 ignored** |
| fmt + strict clippy (native, Tauri) | clean |
| Tauri tests | 31 passed, 0 failed |
| Desktop tsc / eslint / vitest | clean / clean / **188/188** |
| prodgate | 14/14 |
| M6 provider-body baseline check | **MATCH** — no unexplained differences |
| Live M6C acceptance (approved hosts) | PASS (previous session, evidence in M6 report) |

## Verdict

**Conditional GO for M8 — Full Access.** The M7 mechanisms (lifecycle, limits, bridge, recovery
honesty) are implemented and verified; the condition is completing the M7D daemon/broker/tool wiring
first or as M8's first substage, since an agent that cannot start a job through its own tools does
not yet have the user-facing feature. No push, merge or deployment.

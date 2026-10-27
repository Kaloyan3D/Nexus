# M6 Closure + M7 — Background Jobs & Dev Servers

Branch `feature/rust-native-core`. Final code SHA: `f0239cc` (this report is a docs-only commit on top).
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

### M7D — agent tooling and UX (done, `ed6dcd1` + `f0239cc`)

- **Broker verbs** `job-start`/`job-status`/`job-logs`/`job-stop`/`job-list`
  ([jobs.rs](/home/kaloyan/Projects/Nexus/native/nexus-broker/src/jobs.rs)): the broker owns the
  JobManager; a job starts only for a Direct project with an active Workspace grant, resolved by
  the same universal workbench policy, frozen grant digest recorded as the job's authority.
  Install-class commands are refused as jobs. A per-job watcher (300 ms) stops the job when the
  grant is revoked, expires, changes digest, or stops covering an exposed port.
- **Agent tools, versioned:** `job_start`/`job_status`/`job_logs`/`job_stop` are defined as a
  separate catalog addition (`JOB_TOOLS_V1_DIGEST 289b1d8f…`) in
  [repo_tools.rs](/home/kaloyan/Projects/Nexus/native/nexus-model/src/repo_tools.rs); the frozen
  V1 catalogs are byte-identical (baseline check still MATCHes) and `proc_run` is unchanged.
  Broker-side proposal validation (`validate_tool_call`) is implemented and tested. What remains
  is engine adoption: an engine profile that offers the job tools and dispatches these four
  broker-handled calls in its run loop — schema and validation are ready for it.
- **CLI:** `nexus job start|status|logs|stop|list` (start takes `--expose PORT` and `-- <program>…`).
- **Desktop:** Tauri `job_list`/`job_stop` commands (registered in the handler list, build
  manifest and capabilities) and a Background jobs panel on the Projects page (state badge,
  loopback URLs, stop) polling every 3 s. No credentials cross this surface.
- **M7E revocation + restart evidence** ([jobs_m7.rs](/home/kaloyan/Projects/Nexus/native/nexus-broker/tests/jobs_m7.rs)):
  broker-level test starts a Node server through the verb, refuses an unauthorized port, then
  **revokes the grant while the server runs — the watcher stops it and the bridge URL dies**;
  new starts under the revoked grant are refused. Owner-restart: after dropping and reopening
  the manager over the same state dir, no record claims `running`.

### Remaining gaps (stated, not hidden)

1. Engine adoption of the job tools (a profile offering them and dispatching the broker-handled
   calls) — the schema, digests and validation are versioned and ready.
2. ASP.NET proper (Kestrel) was not used; the .NET test uses a raw `TcpListener` server under the
   SDK 10 runtime. `dotnet watch`, `cargo watch`, `next dev` are the same job shape but untested.
3. Jobs currently run with the offline network class; Controlled-Internet jobs (a watcher that
   also fetches) are a policy decision for later, not a mechanism gap.

## Validation

Step 0 source-identity correction (M7.1): `2876ad4` was an intermediate test commit
("manager death kills its jobs"), ancestral to the final M7 code. The final M7 executable
source is `f0239cc` (Desktop M7D panel), on top of `ed6dcd1` (broker job verbs/CLI/tools);
this report was committed as docs-only `52dea0e`. The battery below was re-run in full on
the final M7.1 source (see the M7.1 closure addendum) rather than relying on the
intermediate-SHA run.

| Gate | Result |
|---|---|
| Full native battery (`NEXUS_REQUIRE_SANDBOX=1`) | **1486 passed, 0 failed, 64 ignored** (incl. broker jobs_m7 and M7D validation tests) |
| fmt + strict clippy (native, Tauri) | clean |
| Tauri tests | 31 passed, 0 failed |
| Desktop tsc / eslint / vitest | clean / clean / **188/188** |
| prodgate | 14/14 |
| M6 provider-body baseline check | **MATCH** — no unexplained differences |
| Live M6C acceptance (approved hosts) | PASS (previous session, evidence in M6 report) |

## Verdict

**GO for M8 — Full Access.** M7D is wired through broker, CLI and Desktop; the agent-tool
schemas are versioned against the A2 baseline with only engine-profile adoption outstanding.
No push, merge or deployment.

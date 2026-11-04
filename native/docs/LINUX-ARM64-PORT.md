# Linux ARM64 port audit and validation

Phase 3 regression closure is recorded in the final section of this document.
Earlier Ubuntu and Fedora Phase 2 sections are historical evidence, not current certification.

Audit date: 2026-10-31. Host: Ubuntu 24.04, Linux 6.8.0-142-generic,
AArch64, Apple Silicon Lima VM; rustc/cargo 1.99.1.

## Architecture audit and plan

The workspace has eleven members. `nexus-contracts` defines serialized contracts;
`nexus-store` persists the SQLite ledger; `nexus-kernel` seals grants, approvals,
and execution receipts. `nexus-model` handles attested provider requests and
credentials; `nexus-transcript` projects the ledger; `nexus-client` and `nexus-cli`
provide clients. `nexus-daemon`, `nexus-broker`, and `nexus-runtime` provide IPC,
orchestration, and process lifecycle management. `nexus-tools` owns filesystem
operations, sandbox supervision, and the launch gate. Bundled SQLite and Rust
crypto dependencies compile natively on AArch64.

The architecture-sensitive security code is concentrated in Linux syscall and
filesystem interfaces. The audit searched the workspace for architecture cfgs,
raw syscall numbers, libc stat usage, and assembly. No assembly implementation
requires a separate port. The model transport hardcoded x86_64 O_NOFOLLOW (0o400000), but AArch64 uses
0o100000. Full-suite credential/trace symlink tests exposed this security bug;
the port replaces the literal with libc::O_NOFOLLOW. Unix peer credentials, descriptor-relative
filesystem operations, renameat2/openat2, and process accounting use native libc
interfaces. Landlock's formerly literal syscall numbers are now libc constants.
This is a portability audit, not a proof of all workspace security properties.

Implementation sequence:

1. Keep directory link counts in libc::nlink_t (u32 on AArch64, u64 on x86_64),
   preserving the hard-link protection comparison without truncation.
2. Retain the x86_64 denial table and filter bytes; add an equivalent AArch64
   policy using named libc syscall constants and AUDIT_ARCH_AARCH64.
3. Admit only Linux little-endian x86_64/AArch64 through the common support
   predicate, including descriptor-bound workspace backend capabilities.
4. Correct architecture-dependent integration-test syscalls; test native kernel
   enforcement, ABI rejection, hard-link counts, and x86_64 filter stability.
5. Run workspace check/build/tests/Clippy/format and record host limitations.

## Security invariants retained

- Grants, approvals, descriptor-pinned workspace roots, protected-path masks,
  launch-gate binary verification, and durable execution digests remain intact.
- The ABI guard kills foreign/compat syscall ABIs before matching syscall numbers.
  AArch32 is rejected on AArch64. The x86_64 x32 kill guard remains unchanged.
- Every x86_64 denied operation has an AArch64 equivalent in the policy, except
  iopl/ioperm, which have no AArch64 syscall entry points. clone3 returns ENOSYS
  on both. The filter remains a deny-list with the same documented limitations.
- clone namespace restrictions still depend on bubblewrap's capability drop and
  disabled nested user namespaces; this port does not replace those layers.
- Namespace isolation, no_new_privs, seccomp installation, cgroup supervision,
  filesystem mounts, limits, and Landlock requirements are not relaxed.
- Unsupported syscall ABIs still produce an empty filter and refuse execution.
  Missing kernel/host primitives still refuse execution. Auto's existing resource
  backend selection is unchanged; KernelScope still requires kernel limits.
- Workspace execution still requires FD bind support and the launch gate;
  Landlock ABI >=3 is required, and scoped networking/signals require ABI >=6.
  This VM reports ABI 4, so features requiring ABI 6 remain unavailable.
- The sandbox digest includes filter bytes, so ARM64 policies are attested with
  their own architecture-specific digest. x86_64 bytes and digest inputs persist.

## Reproduction

Run from `native/` with Rust 1.99.1, native C build tools and Node.js on PATH:

```sh
cargo check --workspace --all-targets
cargo build --workspace --all-targets
cargo test --workspace --no-fail-fast
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
cargo test -p nexus-tools --test seccomp_arch -- --nocapture
cargo test -p nexus-tools --lib aarch64_directory_listing
cargo test -p nexus-tools --lib x86_64_filter_bytes
NEXUS_REQUIRE_SANDBOX=1 systemd-run --user --scope -p Delegate=yes -- \
  cargo test -p nexus-tools --test sandbox_a34 -- --nocapture
```

`NEXUS_REQUIRE_SANDBOX` makes unavailable sandbox prerequisites fail the sandbox
integration tests. Without it, the historical tests print NOT RUN and return;
Cargo's resulting pass count is not evidence that enforcement ran. The direct
kernel tests never skip when compiled on either supported Linux architecture.

## Validation evidence

Final command results are recorded below. Raw session logs use the prefix
`/tmp/nexus-arm-`; they are local evidence, not portable repository artifacts.

Native direct kernel enforcement passed: allowed getpid, denied ptrace and
personality with EPERM, clone3 with ENOSYS, and SIGSYS for a deliberately foreign
ABI guard. The AArch64 policy test checks native syscall entries and that x86_64's
ptrace number does not accidentally block AArch64 nanosleep. The hard-link test
checks both directory entries retain link count 2. The x86_64 golden filter hash
is `ae46543107d6e89ca5be59e8cf4d4c65d6a554fc6b1092237be068ae37cf3fc8`.
This hash test executes on ARM64 as well; native x86_64 execution was not available.

Full namespace sandbox enforcement could not run on this VM. Ordinary execution
cannot create a cgroup under session-c8.scope (EACCES). A temporary systemd user
scope with Delegate=yes supplies the cgroup, but the functional probe refuses:
`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` (bubblewrap 0.9.0).
No host security settings were changed. Full sandbox enforcement remains a release
validation requirement on a host that supplies these primitives.

The initial workspace run stopped in broker_a53 because Node.js was absent.
For the final run, official Node.js v22.23.4 linux-arm64 was downloaded to /tmp
and its archive SHA-256 verified against the official distribution manifest.
An initial tools unit run also exposed the existing observe time-budget test:
a zero-millisecond budget sometimes completes within one clock tick, leaving
completeness true (observe.rs:1655). This test and observer were not changed.

Final compilation and focused validation:

| Command | Result |
| --- | --- |
| check --workspace --all-targets | Passed |
| build --workspace --all-targets | Passed |
| clippy --workspace --all-targets -- -D warnings | Passed |
| fmt --all -- --check | Passed |
| seccomp_arch | 2 passed, including real kernel enforcement |
| aarch64_directory_listing | 1 passed |
| x86_64_filter_bytes | 1 passed on ARM64 |
| strict sandbox privilege-escalation test in delegated scope | Failed closed at bubblewrap loopback setup |

The final workspace run uses --no-fail-fast. It is not a clean pass: Node bridge
subprocesses clear their environment and cannot find a system Node installation;
other broker tests reject the downloaded distribution's group-writable bin
directory. Both are deployment prerequisites, not reasons to relax executable
trust checks. Daemon process tests refuse the unavailable cgroup/sandbox. The
existing zero-millisecond observer budget test is also timing-sensitive.
No attempt was made to install system packages or change host security policy.

The no-fail-fast workspace run completed with exit 101: 14 targets failed.
The separate tools run completed with exit 101: hostexec_m8, process_a34, and
worktree_a56 failed (its tools unit tests passed on that run). Two hostexec_m8
detached-descendant tests stalled beyond their 30-second command budget; their
test processes were terminated to complete validation, and their four detached
heartbeat loops were explicitly cleaned up. Those tests are interrupted evidence,
not passes. The workspace failure list also includes model conformance/upload/TLS
and runtime lifecycle targets; see local final logs for individual diagnostics.
The entire workspace suite is therefore not certified green by this port.

### Additional security fix discovered by full-suite validation

The conformance `protected_credential_file_rules` and provider trace symlink tests
failed because ARM64 O_NOFOLLOW is 0o100000, not x86_64's 0o400000 (verified in
/usr/include/aarch64-linux-gnu/asm/fcntl.h). nexus-model now depends on the existing
workspace libc dependency and uses libc::O_NOFOLLOW. Both affected integration
suites were rerun successfully after this fix; x86_64 retains the same flag value.
The complete workspace run above predates this last fix; check/build/Clippy/format
were rerun on the final implementation. Remaining observed failures include the
host OpenSSL CLI lacking -not_before/-not_after, timing-sensitive snapshot
modification detection, and group-writable worktree permissions. These failures
have not been claimed as ARM64 port successes or hidden by skipping tests.


## Phase 2: Fedora recovery baseline (2026-11-01)

**Status: experimental; Fedora workspace and full Nexus enforcement validation
are blocked by missing build dependencies.** Earlier Ubuntu results above are
historical evidence and must not be read as Fedora test results.

All recovered tracked diffs and both untracked port files were reviewed before
editing. Branch `feature/linux-arm64-port` remains at `be3705a`, with no upstream
configured. Origin is `https://github.com/Kaloyan3D/Nexus.git`. No branch switch,
commit, reset, push, or security policy change was performed. Existing source
changes are preserved. This recovery session changes only this report.

### Compatibility matrix

| Platform | Implementation | Evidence and limitation |
| --- | --- | --- |
| Linux little-endian AArch64 | Native libc syscall mappings, AArch64 audit guard, native nlink_t and O_NOFOLLOW | Historical Ubuntu native seccomp passed; Fedora compilation/enforcement pending |
| Linux little-endian x86_64 | Existing deny table, ABI/x32 guard preserved | Historical golden filter hash passed on ARM64; native x86_64 rerun unavailable |
| Other syscall ABIs / endianness | Empty filter and execution refusal | Source audit; no native unsupported-platform run |

### Fedora environment and primitive probes

- Fedora Linux 44 KDE Plasma, AArch64; kernel
  `6.19.10-300.fc44.aarch64`, build dated 2026-03-25.
- systemd 259.5; Bubblewrap 0.11.0; OpenSSL 3.5.5; Python 3.14.
- SELinux **Enforcing**. LSM list includes SELinux and Landlock.
- Landlock version syscall returned **ABI 7**, errno 0. This resolves the
  Ubuntu ABI 4 capability ceiling; actual launch-gate enforcement remains untested.
- Initial process: NoNewPrivs 0, Seccomp 0. This describes the probe process,
  not a sandbox policy or evidence of filter installation.
- Cgroup v2 controllers: cpuset, cpu, io, memory, pids, rdma, misc, dmem.
  Creating and removing a child of the current terminal cgroup succeeded.
  User-manager subtree controllers include cpu/io/memory/pids.
- `systemd-run --user --scope -p Delegate=yes -- /bin/sh -c
  'cat /proc/self/cgroup'` succeeded. Kernel MemoryMax/TasksMax supervision
  through Nexus is still pending.
- `bwrap --unshare-all --ro-bind / / --proc /proc --dev /dev
  --die-with-parent /bin/true` exited 0. The previous basic loopback setup
  failure did not recur. This primitive probe is not full Nexus execution.
- Bubblewrap advertises --bind-fd, --ro-bind-fd and --disable-userns.
- `getconf PAGESIZE`: 4096. Free workspace disk approximately 111 GiB.
- Codex workspace-write sandbox successfully created a unique temporary file
  under the repository, wrote it, replaced its contents, read the new contents,
  removed it and checked its absence. Probe used `mktemp` with trap cleanup;
  no existing file was touched.
- Installed user-local Rust stable 1.99.1, aarch64-unknown-linux-gnu, with rustfmt
  and Clippy using the official HTTPS rustup installer. Source
  `/home/kaloyan/.cargo/env` in subsequent shells.
- Missing: gcc/C compiler and linker, glibc development headers, make, Clang,
  Node.js. pkg-config is present. Privileged package installation was requested
  for approval and has not been performed in this baseline.

### Exact baseline validation results

All commands ran in `native/`. Logs are local `/tmp/nexus-fedora-*.log` files;
reproduction and the diagnostics below remain useful if those files expire.

| Command | Exit | Result |
| --- | --- | --- |
| cargo fmt --all -- --check | 0 | Passed |
| cargo check --workspace --all-targets -j 2 | 101 | Missing linker cc; libc build script |
| cargo build --workspace --all-targets -j 2 | 101 | Missing linker cc; libc build script |
| CARGO_BUILD_JOBS=2 cargo clippy --workspace --all-targets -- -D warnings | 101 | Missing linker cc; proc-macro2/libc build scripts |
| cargo test --workspace --no-fail-fast -j 2 | 101 | Missing linker cc; libc/proc-macro2 build scripts; no tests executed |

These failures are **Missing dependency**, not established ARM64 regressions.
Focused seccomp, filesystem, sandbox and execution-contract Rust tests cannot
link either and have not executed on Fedora. No skipped test is counted as
kernel enforcement. No security enforcement failure is established by this
baseline, but Fedora enforcement has also not been certified.

### Audit findings and outstanding risks

The recovered filter checks AUDIT_ARCH_AARCH64 before syscall matching; AArch32
therefore cannot reuse native syscall numbers. The x86_64 x32 guard and golden
hash remain in place. Native libc mappings avoid x86-only ptrace numbers;
Landlock syscalls and model O_NOFOLLOW use libc constants. Descriptor-relative
operations and native nlink_t preserve the existing protection checks. Sandbox
policy digests include the filter bytes and launch-gate information. Missing
filter, required Landlock ABI, launch gate, namespace, or required resource
backend causes refusal in the reviewed paths. This is source review, not a
complete security proof or a replacement for integration tests.

One additional portability risk identified: `sandbox::rss_bytes` multiplies
`/proc/PID/statm` resident pages by a literal 4096. This is correct on this VM
but undercounts on 16/64 KiB ARM64 kernels in the polling resource backend.
A portable sysconf page-size correction with regression coverage remains
outstanding; kernel scope accounting uses memory.peak separately. Clone3's
shared numeric value 435 also remains a candidate for replacement by the libc
constant while preserving x86_64 golden bytes.

Node sanitized-environment discovery and executable-directory trust remain
untested because Node is absent. Observer zero-budget timing, OpenSSL certificate
CLI compatibility, timestamp sensitivity, detached descendants, receipts and
launch-gate enforcement require the complete suite after dependencies exist.
Do not weaken directory trust, SELinux, Landlock or namespace requirements to
resolve those tests.

### Safe continuation

With explicit approval, install ordinary Fedora development packages:

```sh
sudo dnf install gcc gcc-c++ make clang glibc-devel nodejs
. /home/kaloyan/.cargo/env
cd ~/Projects/Nexus/native
```

Then rerun the complete commands above (keep CARGO_BUILD_JOBS=2 for Clippy),
followed by the reproduction commands in the earlier section and strict
`NEXUS_REQUIRE_SANDBOX=1` sandbox tests. Fedora currently presents no demonstrated
missing kernel primitive; the immediate blocker is the C build toolchain. No
alternative kernel, SELinux change, or VM security change is justified by this
baseline. Release readiness requires actual native filter installation, full
Nexus launch-gate execution and remaining suite classification.


## Phase 2 installed-toolchain validation (2026-11-01)

This section supersedes the missing-build-dependency status above. **Status:
validated with limitations for native ARM64 compilation and core confinement;
not release-ready and not a green workspace certification.**

Explicitly approved DNF installation succeeded from Fedora/updates repositories:
gcc, gcc-c++, make, pkgconf-pkg-config, openssl-devel, sqlite-devel,
libseccomp-devel, clang, llvm, cmake, ninja-build, bubblewrap, nodejs22,
nodejs22-npm. DNF installed their dependencies and updated matching runtime
libraries; no kernel, SELinux policy, systemd configuration, or VM setting was
changed. Kernel headers are development headers, not a boot kernel installation.
`cc`/`gcc` resolve to /usr/bin (GCC 16.2.1); node/npm resolve to /usr/bin,
versions 22.23.1 / 10.9.8. rustc/cargo resolve to ~/.cargo/bin, both 1.99.1.

### Corrections in this continuation

- `nexus-tools/src/sandbox.rs`: replace the 4096-byte statm multiplier with
  `sysconf(_SC_PAGESIZE)`. Actual VM page size is 4096; other supported Linux
  ARM64 kernels may use 16384/65536. Invalid queries fail conservatively with
  maximum memory usage; multiplication and aggregate addition saturate rather
  than wrap. Regression checks cover those sizes, invalid sizes and overflow.
  Replace shared clone3 number with libc::SYS_clone3.
- `nexus-runtime/src/lib.rs`: private Node verification was hardcoded to ELF
  machine x86_64 and rejected genuine AArch64 Node. Require the native reviewed
  little-endian ELF64 machine instead; retain permission, version and digest
  checks. Added native/foreign machine regression coverage; existing genuine,
  tampered, wrong-version and untrusted Node tests now pass.
- Tightened checkout permissions (no content changes): removed group/other write
  from repository root, config, config/registry and its .cjs modules. Recovered
  group-writable code had correctly failed broker executable trust checks.
  Git does not record these non-executable permission bits.
- This report preserves all recovered changes. No commits or branch operations.

### Validation and enforcement evidence

Final source: format/check/build/Clippy all exit 0, all targets/workspace;
check/build use -j 2, Clippy uses CARGO_BUILD_JOBS=2 and -D warnings.
Full no-fail-fast workspace test completed with exit 101. It began before the
permission repair and runtime fix, so its failures are retained rather than
presented as final-source failures. Separate runtime unit rerun: **8 passed**;
broker_a53 after permission repair: **25 passed, 1 ignored**.

Focused production-filter kernel tests: **2 passed**. Real subprocess seccomp
installation permits getpid, denies ptrace/personality with EPERM, makes clone3
return ENOSYS, and deliberately incompatible audit architecture dies with
SIGSYS. Native syscall mapping test passed. x86_64 golden filter test passed
on ARM64 after the clone3 change; native x86_64 execution remains unavailable.
RSS regression: **1 passed**. Tools unit run: **80 passed, 1 failed** (observer
zero-budget timing); this includes native hard-link and filter compatibility
coverage.

Strict `NEXUS_REQUIRE_SANDBOX=1` sandbox run initially passed **24/24**, with no
ignored or NOT RUN cases: real namespace/seccomp/cgroup execution, resource
limits and process-tree cleanup. Confinement run: **24 passed, 1 ignored
benchmark**, no NOT RUN; grants **6 passed**; in-place execution **9 passed**.
These demonstrate real launch-gate/Landlock execution, descriptor closure,
symlink/hard-link protection and unsupported-capability refusal on Fedora ABI 7.

Repeatability is not certified: a later strict run had **22 passed, 2 failed**:
polling backend found a stale cgroup (EEXIST), and CPU test preflight refused
because systemd scope creation was not observed. An overlapping non-broker run
had a polling cgroup cleanup failure. These are unresolved resource-supervision
failures; fail-closed refusal is not counted as a successful enforcement test.
The successful initial run remains evidence of actual execution, not universal
reliability. No kernel security capability was bypassed.

### Remaining failure classification and safe resolution

| Failure | Classification | Evidence / smallest safe next step |
| --- | --- | --- |
| Private Node rejects native ARM ELF | Actual ARM64 regression, fixed | Native machine predicate plus 8 passing runtime unit tests |
| Fixed 4096 statm multiplier | Portability defect, fixed | Runtime sysconf and page-size/overflow regression |
| Recovered writable controller code | Environment limitation, repaired | Strict trust refusal; broker rerun 25 passed |
| Sandboxed GCC cannot find ld | Existing cross-platform distro-integration defect | /usr/bin/ld points through /etc/alternatives/ld, absent from synthetic /etc; needs narrowly pinned read-only linker target support, not exposing host /etc |
| Node sandbox OpenSSL startup | Existing cross-platform distro-integration defect | Missing /etc/crypto-policies/back-ends/opensslcnf.config; review narrowly scoped read-only system crypto-policy mounts without overriding security policy |
| Rust dev-job fixture /usr/bin/cargo absent | Environment limitation | Rust is user-local; fixture assumes system cargo |
| Python No module named pip | Missing dependency | Fedora python3-pip remains absent; not installed in this session |
| Zero-ms observer assertion | Timing-sensitive / cross-platform test | elapsed.as_millis() > 0 can remain false for a completed scan |
| Polling cgroup cleanup / repeat EEXIST, systemd scope creation | Environment/supervision limitation, unresolved | Initial strict success, later failed-closed reruns; investigate lifecycle/races before release |
| inspect_a55 hostname leak assertion | Existing cross-platform test ambiguity | /etc/hostname is kaloyan, identical to home-path component; targeted symlink fixture needed before treating substring match as an escape |
| Other broker code/verification failures | Unresolved; includes early environment refusals and linker-induced failures | Full diagnostics in workspace log; not all individually attributed or rerun |

No demonstrated seccomp ABI bypass was observed. Unsupported security features
were refused by the tested launch-gate/contracts cases. The hostname assertion
is not proof of safety or proof of an escape. Native x86_64 regression execution
and remaining workspace failures are release blockers. Ubuntu OpenSSL CLI and
timestamp failures did not reappear as failed model targets in this run.

### Reproduction and local logs

Use the complete commands above after `. ~/.cargo/env`. Final logs:
`/tmp/nexus-fedora2-{check-final,build-final,clippy-final,fmt-final,test,rest,
seccomp,sandbox,sandbox-final,contract,rss,x86,runtime-fixed2,broker-repaired}.log`.
The `rest` run was an additional overlapping diagnostic run excluding broker,
not a replacement for the full workspace invocation. All requested full
commands were run; no stalled test was killed or reported as passed.

```sh
cargo test -p nexus-runtime --lib -j 2
cargo test -p nexus-tools --lib rss_portability -j 2
cargo test -p nexus-tools --lib x86_64_filter_bytes -j 2
cargo test -p nexus-tools --test seccomp_arch -j 2 -- --nocapture
NEXUS_REQUIRE_SANDBOX=1 cargo test -p nexus-tools --test sandbox_a34 -j 2 -- --nocapture
cargo test -p nexus-tools --test confine_m3c --test inplace_m1 --test grants_m2 -j 2 -- --nocapture
```

Full workspace per-target summaries follow (captured run, before the final runtime
fix; ignored tests are excluded from enforcement evidence):

| Target | Result |
| --- | --- |
| Running unittests src/lib.rs | test result: ok. 385 passed; 0 failed; 7 ignored; 0 measured; 0 filtered out; finished in 11.04s |
| Running unittests src/main.rs | test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running tests/broker_a53.rs | test result: FAILED. 2 passed; 23 failed; 1 ignored; 0 measured; 0 filtered out; finished in 35.29s |
| Running tests/code_a56.rs | test result: FAILED. 157 passed; 103 failed; 6 ignored; 0 measured; 0 filtered out; finished in 558.59s |
| Running tests/em02_attempt_targets.rs | test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.81s |
| Running tests/inspect_a55.rs | test result: FAILED. 16 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 30.87s |
| Running tests/jobs_m7.rs | test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.14s |
| Running tests/rn2_binding.rs | test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running unittests src/main.rs | test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running tests/cli.rs | test result: ok. 19 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s |
| Running unittests src/lib.rs | test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running tests/client_api.rs | test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s |
| Running tests/coding_outcome.rs | test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running tests/conversation.rs | test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s |
| Running tests/desktop_code_limits.rs | test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running tests/desktop_contract.rs | test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running tests/real_history.rs | test result: ok. 0 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running tests/registry_target.rs | test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running unittests src/lib.rs | test result: ok. 28 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running unittests src/lib.rs | test result: ok. 43 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.18s |
| Running unittests src/bin/nexus-approver.rs | test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running unittests src/bin/nexus-witness.rs | test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running unittests src/main.rs | test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running tests/admission.rs | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.12s |
| Running tests/approvals_a42.rs | test result: ok. 16 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.20s |
| Running tests/auth.rs | test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.31s |
| Running tests/autonomous_a614.rs | test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.95s |
| Running tests/e2e_native.rs | test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.32s |
| Running tests/framing.rs | test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 5.43s |
| Running tests/isolation.rs | test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.17s |
| Running tests/lifecycle.rs | test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.26s |
| Running tests/model_only_a51.rs | test result: ok. 21 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.83s |
| Running tests/multuid.rs | test result: ok. 1 passed; 0 failed; 40 ignored; 0 measured; 0 filtered out; finished in 0.01s |
| Running tests/process_a34.rs | test result: FAILED. 4 passed; 6 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.48s |
| Running tests/protocol.rs | test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.36s |
| Running tests/tools_a32.rs | test result: ok. 22 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.27s |
| Running tests/units_a44.rs | test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running tests/witness_a43.rs | test result: ok. 21 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 4.70s |
| Running tests/writes_a33.rs | test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.06s |
| Running unittests src/lib.rs | test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running unittests src/main.rs | test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running tests/bridge_protocol.rs | test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s |
| Running tests/dispatch_safety.rs | test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s |
| Running tests/durability.rs | test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.45s |
| Running tests/idempotency_concurrency.rs | test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s |
| Running tests/identity_auth.rs | test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s |
| Running tests/journal_robustness.rs | test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s |
| Running tests/model_only.rs | test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s |
| Running tests/native_dispatch.rs | test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s |
| Running tests/recovery.rs | test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s |
| Running tests/sealed_grants.rs | test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s |
| Running unittests src/lib.rs | test result: ok. 15 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s |
| Running tests/audit_inject.rs | test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running tests/audit_sse.rs | test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running tests/audit_trust.rs | test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s |
| Running tests/authorized_dispatch.rs | test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s |
| Running tests/conformance.rs | test result: ok. 36 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.82s |
| Running tests/dns_policy_a54.rs | test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running tests/opencode_go_a54.rs | test result: ok. 37 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.61s |
| Running tests/p0_transport_upload.rs | test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.99s |
| Running tests/tls_a52.rs | test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.12s |
| Running unittests src/lib.rs | test result: FAILED. 5 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s |
| Running tests/lifecycle_a614.rs | test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 41.18s |
| Running unittests src/lib.rs | test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running tests/store_initialization.rs | test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 10.16s |
| Running tests/task_bindings_em02.rs | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running unittests src/lib.rs | test result: FAILED. 80 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 4.46s |
| Running unittests src/bin/nexus-confine.rs | test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running unittests src/bin/nexus-egress.rs | test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running tests/a32.rs | test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.07s |
| Running tests/adversarial.rs | test result: ok. 30 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.25s |
| Running tests/audit.rs | test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.18s |
| Running tests/checkpoint_m3b.rs | test result: ok. 23 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 1.29s |
| Running tests/compat_m3c.rs | test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.48s |
| Running tests/confine_m3c.rs | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 24 filtered out; finished in 0.00s |
| Running tests/confine_m3c.rs | test result: ok. 24 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.39s |
| Running tests/depcache_a35.rs | test result: ok. 23 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.09s |
| Running tests/depcache_process_a35.rs | test result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.43s |
| Running tests/devflow_m6.rs | test result: ok. 1 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.40s |
| Running tests/devjobs_m7.rs | test result: FAILED. 7 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.24s |
| Running tests/edit_restore_rel1.rs | test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running tests/effects_m3a.rs | test result: ok. 10 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 1.46s |
| Running tests/egress_m5.rs | test result: ok. 6 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 10.14s |
| Running tests/gitwrite_m6.rs | test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.18s |
| Running tests/grants_m2.rs | test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s |
| Running tests/hostexec_m8.rs | test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.54s |
| Running tests/inplace_m1.rs | test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.68s |
| Running tests/live_m6.rs | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running tests/pipefail_d5.rs | test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.99s |
| Running tests/process_a34.rs | test result: ok. 11 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.74s |
| Running tests/profiles_a614.rs | test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.59s |
| Running tests/registry_a613.rs | test result: ok. 11 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.14s |
| Running tests/sandbox_a34.rs | test result: FAILED. 23 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 8.16s |
| Running tests/seccomp_arch.rs | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s |
| Running tests/seccomp_arch.rs | test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.09s |
| Running tests/toolchains_m5.rs | test result: FAILED. 3 passed; 3 failed; 0 ignored; 0 measured; 0 filtered out; finished in 190.90s |
| Running tests/workbench_a614.rs | test result: FAILED. 2 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.24s |
| Running tests/worktree_a56.rs | test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.19s |
| Running tests/write_a33.rs | test result: ok. 34 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.08s |
| Running unittests src/lib.rs | test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Running tests/history_and_store.rs | test result: ok. 28 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.12s |
| Doc-tests nexus_broker | test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Doc-tests nexus_client | test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Doc-tests nexus_contracts | test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Doc-tests nexus_daemon | test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Doc-tests nexus_kernel | test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Doc-tests nexus_model | test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Doc-tests nexus_runtime | test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Doc-tests nexus_store | test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Doc-tests nexus_tools | test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| Doc-tests nexus_transcript | test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |

Full workspace failed target list:

```text
error: 11 targets failed:
    `-p nexus-broker --test broker_a53`
    `-p nexus-broker --test code_a56`
    `-p nexus-broker --test inspect_a55`
    `-p nexus-daemon --test process_a34`
    `-p nexus-runtime --lib`
    `-p nexus-tools --lib`
    `-p nexus-tools --test depcache_process_a35`
    `-p nexus-tools --test devjobs_m7`
    `-p nexus-tools --test sandbox_a34`
    `-p nexus-tools --test toolchains_m5`
    `-p nexus-tools --test workbench_a614`

```


## Phase 3 — regression closure and stability evidence (2026-11-01)

### Inventory method and historical failures

Read the recovered report and indexed all available local Nexus test logs.
[LINUX-ARM64-PHASE3-FAILURES.json](LINUX-ARM64-PHASE3-FAILURES.json) retains
**145 failing-case records across all 11 Phase 2 failed targets**, including exact
captured diagnostics, prerequisites, classification, established or unresolved
cause, independent rerun status, outside-sandbox applicability, security impact
and corrective action. An unattributed assertion is explicitly `unresolved`,
not classified as an environment problem. A subsequent passing target does not
retroactively prove the cause of each historical assertion.

| Historical target | Established cause / corrective action | Independent evidence |
| --- | --- | --- |
| nexus-broker / broker_a53 | Recovered group-writable controller code correctly refused; permissions repaired in Phase 2 | Independent 25 passed, 1 ignored; Phase 3 workspace reruns |
| nexus-broker / code_a56 | Many initial trust refusals; missing sandbox linker; literal node basename assertion; some original assertion causes remain unestablished | Entire target rerun in workspace; canonical trusted-node assertion corrected |
| nexus-broker / inspect_a55 | Hostname `kaloyan` was also present in home paths, making the content-leak substring assertion ambiguous | Exact injection test independently passes with unique outside-file content marker |
| nexus-daemon / process_a34 | Sandboxed build scripts could not link because Fedora ld alternative was absent | Independent target passes after narrow linker mount |
| nexus-runtime / lib | x86-only private Node ELF machine check, fixed in Phase 2 | Independent 8 passed; native/foreign ELF and tamper tests retained |
| nexus-tools / lib | Production budget boundary used truncated milliseconds and > rather than >= | Independent 81 passed after full-duration comparison; later supervisor identity unit test added |
| nexus-tools / depcache_process_a35 | Missing linker alternative prevented hostile and normal build scripts from running | Independent target passed after linker mount |
| nexus-tools / devjobs_m7 | Fixture detects rustup but launches /usr/bin/cargo | Independent target passed using discovered read-only toolchain |
| nexus-tools / sandbox_a34 | Empty stale polling cgroup; fast-scope discovery and collection races; OOM evidence loss | Real-kernel regression tests, journals and repeated batteries below |
| nexus-tools / toolchains_m5 | Missing linker / crypto-policy files; experimental Node proxy warning broke exact output match | Independent 6 passed after fixes |
| nexus-tools / workbench_a614 | Missing pip and Node crypto-policy include | Independent 4 passed after approved python3-pip installation and mount correction |

Sanitized outside-sandbox probes (`env` equivalent with only PATH) compiled and
ran a C program and ran system Node/npm and `python3 -m pip --version` successfully
(`/tmp/nexus-phase3-outside.log`). Authorization/receipt assertions have no
meaningful unsandboxed equivalent; those are not claimed as outside-sandbox
reproductions. Historical test failures that disappeared with common setup fixes
were not each independently induced again.

### Focused changes and regression coverage

- `sandbox.rs`: bind only `/etc/alternatives/ld` read-only for Fedora linker
  discovery. Add `/etc/crypto-policies` to the existing network/TLS configuration
  mounts, read-only. Mirror both in the launch-gate Landlock grants. Host `/etc`
  remains synthetic; shadow, passwd and other host configuration stay absent.
  A real-kernel regression checks linker execution, read-only enforcement and
  private configuration absence. Offline/controlled-network cargo/npm tests pass.
- `observe.rs`: compare elapsed Duration directly with the millisecond budget
  using >=, including bulk observation. A zero budget expires immediately.
  This corrects production behavior; the existing zero-budget acceptance
  assertion was not relaxed.
- `sandbox.rs`: retry polling cgroup removal when tasks have left cgroup.procs
  but kernel references still prevent rmdir. The retry remains bounded. Sandbox
  test IDs include PID to avoid concurrent test processes sharing fixed names.
- Systemd scope startup now pauses a fixed trusted launcher until the supervisor
  observes both its stopped state and membership in the expected scope. User
  commands start only after that verification. `--expand-environment=no`
  preserves literal command arguments and the fixed handshake script. Unsupported
  systemd versions fail closed; this option is now a kernel-scope prerequisite.
- The launcher also pauses after command completion to preserve final accounting.
  Systemd can kill that launcher under its normal OOM policy; failed units are
  retained long enough to read authoritative `Result=oom-kill`, then only that
  transient failed unit is reset. Descendants are killed before the bus query.
  MemoryMax, MemorySwapMax, TasksMax and OOM policy are unchanged. No exit-code
  heuristic substitutes for OOM evidence. The OOM test now additionally requires
  oom_killed for the kernel backend.
- A regression runs 12 very short commands in each backend, reusing the same
  execution name, and checks exit and cgroup cleanup. Strict prerequisites were
  added to the confinement and process integration helpers.
- `host_exec.rs` and daemon startup: the old global `nexus-host-*` sweep could
  kill another live supervisor's commands. New names record PID and Linux
  process start ticks; reconciliation reaps only dead/replaced supervisor
  incarnations. PID reuse is distinguished. Live legacy PID-only names and
  unknown identity are handled conservatively; a reused live PID on a legacy
  name cannot be positively attributed. Tests cover identity, foreign names,
  PID reuse and a live host command surviving the actual reconciliation helper.
- Test portability corrections: use a unique external-file content canary for
  symlink containment; permit Node's warning while still requiring successful
  fixture fetch and failed non-proxy access; compare the worker executable's
  canonical path with trusted resolve_node rather than requiring basename node;
  mount the discovered rustup toolchain read-only in the dev-job fixture.
- Sandbox policy version is now **2** so execution receipts distinguish the new
  mounts and supervision contract. x86_64 seccomp filter bytes are unchanged;
  complete sandbox digests intentionally change on both architectures.

Only privileged Phase 3 action: explicitly approved Fedora `python3-pip`
installation (26.0.1). Strace was downloaded from Fedora with unprivileged DNF
and extracted under /tmp for disposable-process tracing, not installed systemwide.
No SELinux, kernel, systemd security configuration or virtualization settings
were changed. No commits, pushes, merges, resets or branch switches occurred.

### Stability investigation and unsuccessful attempts

- Initial cgroup snapshot: `/tmp/nexus-phase3-cgroups-before.json`, including
  path, uid 1000, mode 0755, empty cgroup.procs, populated 0, and delegation
  fields. The recorded empty `nexus-exec-pollmem` artifact was removed with
  rmdir after inspection. The user manager delegates cpu/io/memory/pids;
  per-execution kernel scopes verify memory/pid enforcement.
- Fast `/usr/bin/true` probes sometimes disappeared before the old 10 ms
  polling loop observed their scope. Startup handshake regression addresses
  this lifecycle race; no UTM cause was established.
- The first handshake validation exposed systemd environment expansion of $$.
  That attempt was terminated and is **one interrupted target**, not a pass.
  `/tmp/nexus-phase3-stable-1.log` and `...interrupted.txt` preserve evidence.
- Earlier repeated batteries are retained under `/tmp/nexus-phase3-repeat-*`,
  `final-repeat-*`, `certified-*` and `final-all-*`. Some used Cargo's default
  fail-fast behavior and did not reach later targets after host failures. Those
  omissions are not passes. The no-fail-fast final-all outcomes were
  **101, 101, 0, 101, 0**; they precede the final orphan/OOM corrections.
- Kernel and systemd journals confirmed scoped OOM kills when Nexus reported
  Exited(137). A controlled 32 MiB scope probe returned exit 137 and retained
  ActiveState=failed / Result=oom-kill without --collect. This supports the
  authoritative-result correction. Journals include exact unit names, memory
  peaks, exit statuses and timings, rather than attributing the issue to UTM.
- Syscall tracing showed host SIGKILL before Nexus wrote cgroup.kill, while
  broker tests started daemons. Source review then found the unconditional
  daemon startup sweep. GDB/strace evidence is retained in
  `/tmp/nexus-phase3-host-gdb.log` and `...trace-*` / `...hostsetup-*`.
- A later `cert-3` host test still fell back to its existing process-group
  backend and a detached heartbeat held the pipe readers indefinitely.
  Its parent-cgroup membership and cwd were recorded in
  `/tmp/nexus-phase3-host-hang.json`; only that confirmed process group was
  killed to unblock validation. This is **one manually interrupted host case**,
  and its printed NOT RUN escape assertion is not enforcement evidence.
  The setup failure's exact mkdir/join errno was not captured. It remains an
  **unresolved intermittent host-supervision limitation**, not an established
  Fedora/UTM problem. Five traced setup reruns passed; final untraced stress
  cycles are reported separately below.
- One workspace run overlapped rebuilding shared test executables and four
  crash-test self-spawns returned ENOENT. Another isolated build mistakenly used
  Fedora's quota-limited /tmp tmpfs; EDQUOT invalidated compilation and evidence
  writes in that run. Those are validation-orchestration defects. Build output
  was moved to disk-backed `~/.cache/nexus-validation/phase3-target`; /tmp
  returned to 2% usage. Final compilation and testing use that directory, with
  no rebuilds of running executables.

### Final validation commands

```sh
. ~/.cargo/env
cd ~/Projects/Nexus/native
export CARGO_TARGET_DIR=$HOME/.cache/nexus-validation/phase3-target
cargo fmt --all -- --check
cargo check --workspace --all-targets -j 2
cargo build --workspace --all-targets -j 2
CARGO_BUILD_JOBS=2 cargo clippy --workspace --all-targets -- -D warnings
NEXUS_REQUIRE_SANDBOX=1 cargo test -p nexus-tools --no-fail-fast -j 2 \
  --test seccomp_arch --test confine_m3c --test sandbox_a34 \
  --test process_a34 --test hostexec_m8 -- --nocapture
cargo test --workspace --no-fail-fast -j 2 -- --nocapture
```

Formatting/check/build/Clippy on the final implementation returned **0**;
logs `/tmp/nexus-phase3-cert-{fmt,check,build,clippy}.log`.
The final five stress cycles ran the already-built test executables directly
with `NEXUS_REQUIRE_SANDBOX=1` and `--nocapture` while the broker workspace tests
started/stopped daemons. This avoids changing binaries while self-spawn tests
run and exercises the reconciliation fix under overlap. Use executable paths
printed by Cargo's Running lines; direct log prefix is
`/tmp/nexus-phase3-direct-<cycle>-<test-binary>.log`.
Each invocation had a 90-second external bound; none hit it.

| Final stress cycle | Passed | Failed | Ignored | NOT RUN | Interrupted |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 71 | 0 | 1 | 0 | 0 |
| 2 | 71 | 0 | 1 | 0 | 0 |
| 3 | 71 | 0 | 1 | 0 | 0 |
| 4 | 71 | 0 | 1 | 0 | 0 |
| 5 | 71 | 0 | 1 | 0 | 0 |

Per cycle: confinement 24 passed / 1 ignored benchmark, host supervision 8,
process lifecycle 11, strict sandbox 26, native seccomp 2. Total repeated test
executions: **355 passed, 0 failed, 5 ignored benchmarks, 0 skipped/blocked/
interrupted**. These are executions, not 355 distinct tests. Nested child
harness summaries are counted only in their outer parent result.
Earlier failed/interrupted batteries are not included in these final-cycle
counts and have not been erased or reclassified as successes.

### ARM64 security matrix and release requirements

| Capability | Linux little-endian ARM64 | x86_64 requirement |
| --- | --- | --- |
| Native ABI seccomp / foreign ABI guard | Real kernel installation and SIGSYS/EPERM/ENOSYS assertions passed | Golden bytes preserved; native enforcement and x32 execution still required |
| Descriptor filesystem / native nlink_t / O_NOFOLLOW | Native filesystem, symlink, hard-link and confinement tests | Native filesystem suite still required |
| Bubblewrap / Landlock | Actual execution on Fedora 44, ABI 7, SELinux enforcing | Native supported distro execution still required |
| Kernel scope / polling supervision | Short-command, OOM accounting and cleanup regressions exercised | Native repeated groups required; systemd must support --expand-environment=no |
| Executable trust / ELF gate | Trusted canonical Fedora Node22 plus native/foreign ELF tests | x86_64 ELF validation retained; native runtime rerun required |
| Receipts / digests / unsupported capabilities | Policy version 2, real execution contracts and refusal tests | Version 2 intentionally changes policy digests; compatibility validation required |

Status remains **validated with limitations**, not release-ready. Final five
stress cycles are green, but the earlier host setup fallback/escaped-descendant
case lacks causal closure. Capture its creation/membership errno before claiming
reliable supervision on all failure paths; do not weaken mandatory sandbox
prerequisites or present process-group fallback as equivalent enforcement.
Native x86_64 validation, other supported distros/kernels and legacy host-cgroup
PID-reuse migration remain outstanding. This single ARM64 VM is not a universal
Linux release certification.


### Completed final workspace result

The final, disk-backed, non-rebuilding workspace run completed with **exit 0**.
Cargo outer-target totals: **1663 passed, 0 failed, 65 ignored, 0 interrupted** across 109 target summaries.
Nested child harness summaries are not counted a second time. Final full-run
log: `/tmp/nexus-phase3-cert-workspace.log`. Structured totals, per-target
summaries, ignored names, literal NOT RUN diagnostics and log SHA-256 are
retained in [LINUX-ARM64-PHASE3-RESULTS.json](LINUX-ARM64-PHASE3-RESULTS.json).
**Remaining failing targets in this final run: none.** All eleven historical
failed targets passed their final workspace invocation.

The ignored count includes **40 prepared-host multi-UID tests**. They require
root, NEXUS_MULTUID=1 and the distinct users/groups documented in
`native/deploy/MULTUID-PROCEDURE.md`. Those identities were not
created and the suite was not run privileged. The capability reporter's
passing result is informational, not multi-UID enforcement evidence. Three
other literal NOT RUN lines come from the code_a56 synthetic retry/gate tests
`s0_a_permanently_unavailable_sandbox_is_never_turned_into_a_pass`,
`s0_with_the_requirement_set_a_permanent_problem_fails_at_once`, and
`s0_with_the_requirement_set_an_unavailable_sandbox_fails_the_test`; these
intentionally supply nonexistent/unavailable prerequisites and verify their
handling (including expected panics). They are not failed real preflights.
Ignored manual rehearsals, benchmarks, live-provider tests and child-entry
points are listed by name in the results artifact; none establishes enforcement.

Final validation counts exclude earlier diagnostics. In particular, the
original `cert-3` Cargo command returned 0 only after manual cleanup of one
escaped host descendant and printed NOT RUN for its containment assertion;
that attempted cycle is interrupted/blocked evidence. Only the later five
`direct-*` stress cycles form the **355 passed / 0 failed / 5 ignored /
0 interrupted** repeated-run result. The earlier terminated handshake target
and manually interrupted host case remain recorded above and are not hidden
by the clean final workspace result.

End-to-end evidence now includes real compiler/npm/pip execution under the
launch gate, enforced syscall denials, Landlock/mount protections, scoped OOM
and process limits, cancellation and descriptor closure. Final repeatability
is demonstrated for five clean stress cycles; long-term supervision reliability
is not universally certified because of the earlier unexplained host setup
fallback and the remaining native x86_64 / prepared multi-UID validation gaps.
The final classification remains **validated with limitations**.


### Reproducing the final five stress cycles without rebuilding

After the all-target build above, use Cargo's JSON artifact messages to select
exactly the five current tools test binaries; do not glob cached executables
from old builds. Finish this preparation before starting any self-spawn tests:

```sh
cargo test -p nexus-tools -j 2 --no-run --message-format=json \
  --test seccomp_arch --test confine_m3c --test sandbox_a34 \
  --test process_a34 --test hostexec_m8 > /tmp/nexus-battery-artifacts.jsonl
python3 - <<'PYTHON'
import json, os, pathlib, subprocess
wanted = {"seccomp_arch", "confine_m3c", "sandbox_a34", "process_a34", "hostexec_m8"}
binaries = {}
for line in pathlib.Path("/tmp/nexus-battery-artifacts.jsonl").read_text().splitlines():
    item = json.loads(line)
    if item.get("reason") == "compiler-artifact" and item.get("executable"):
        name = item["target"]["name"]
        if name in wanted:
            binaries[name] = item["executable"]
assert binaries.keys() == wanted
for cycle in range(1, 6):
    for name, binary in sorted(binaries.items()):
        with open(f"/tmp/nexus-repeat-{cycle}-{name}.log", "w") as log:
            result = subprocess.run(["timeout", "90s", binary, "--nocapture"],
                env={**os.environ, "NEXUS_REQUIRE_SANDBOX": "1"},
                stdout=log, stderr=subprocess.STDOUT)
        print(cycle, name, "exit=", result.returncode)
PYTHON
```

The disk-backed directory must have room for debug artifacts (about 10 GiB
in this session). Fedora /tmp is a roughly 5.9 GiB tmpfs with a user quota;
free space on /home does not imply free quota on /tmp. Do not run a second
Cargo build against test executables that are still running. The final stress
binaries used the tools package's feature set; the final workspace run also
covers workspace feature unification, including crash-injection test hooks.


### Phase 3 files changed

Production: `native/nexus-tools/src/sandbox.rs`, `native/nexus-tools/src/host_exec.rs`, `native/nexus-tools/src/observe.rs`, `native/nexus-daemon/src/main.rs`.

Regression harnesses: `native/nexus-broker/tests/code_a56.rs`, `native/nexus-broker/tests/inspect_a55.rs`, `native/nexus-tools/tests/confine_m3c.rs`, `native/nexus-tools/tests/devjobs_m7.rs`, `native/nexus-tools/tests/hostexec_m8.rs`, `native/nexus-tools/tests/process_a34.rs`, `native/nexus-tools/tests/sandbox_a34.rs`, `native/nexus-tools/tests/toolchains_m5.rs`.

Documentation: this report, `native/docs/LINUX-ARM64-PHASE3-FAILURES.json` and `native/docs/LINUX-ARM64-PHASE3-RESULTS.json`. Earlier recovered implementation changes remain intact. Final source SHA-256 values are recorded in the results artifact. Final inspection found no remaining Nexus cgroup leaves or test daemons under the validation session.

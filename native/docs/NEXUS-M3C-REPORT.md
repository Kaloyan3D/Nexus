# M3C — Linux confinement hardening

Branch `feature/rust-native-core`. Baseline `904602f` (M3B). M3C source commit: **`a70d1bf`**; this report is a docs-only commit after it.
Host: Linux 6.18.55 (Landlock ABI 7), bubblewrap 0.13, x86_64, cgroup v2 + systemd user scopes.
Not done, by instruction: Direct Workspace process execution, Controlled Internet, Full Access, browser automation, Nova/CCv2, a new permission system, provider routing changes.

## 1. Verdicts (details below)

* **M3C implementation: PASS** (evidence on the exact SHA in §13–§14).
* **Readiness for M4 — True Direct Workspace: NO-GO until three blockers are closed** (§9). The confinement primitives M4 needs now exist and are tested on disposable folders; the actual real-folder boundary
  (a user's real project, real Git layouts, real hard-link and bind-mount situations on the user's machine) has **not** been validated, and the request was explicit not to claim it.

## 2. Layering (what protects what)

| Layer | Role | Replaced by another layer? |
|---|---|---|
| Kernel authorization (sealed scope, grant, approval, revocation fence) | decides that the command may run | no |
| bubblewrap: user/pid/ipc/uts(/net) namespaces, synthetic root, workspace bound **by descriptor** (`--bind-fd`), protected entries as mounts, seccomp deny-list, cgroup v2 limits, supervisor | mount-level masking and isolation | no |
| **`nexus-confine` launch gate (new)** | runs as the first process inside the namespace; **verifies, then confines, then executes** | adds to, never replaces, the rows above |
| M3A observation / M3B checkpoint | evidence and recovery | unchanged |

## 3. M3C.1 — Mandatory Landlock (`confine.rs`, `bin/nexus-confine.rs`)

The gate is a libc-only binary (5.8 MB debug; no Nexus library linked) bind-mounted read-only at `/nexus/confine`. The command line inside the namespace is
`bwrap … -- /nexus/confine <plan> -- prlimit … -- <program>`, so **nothing the command's chain does happens before the gate has finished**. Order inside the gate:

1. **Descriptor hygiene**: every descriptor except 0–2 is a refusal (`unexpected inherited descriptors [..]`); after Landlock `close_range(3, ∞)` runs again so none reaches the command.
2. **Pinned root**: `/work/src` must be the object `(dev, ino)` the supervisor verified. A different object ⇒ refusal.
3. **Mount specification**: every protected entry is opened with `openat2(BENEATH | NO_SYMLINKS | NO_MAGICLINKS)` and must be exactly what was planned (an empty `/dev/null` character device for hidden files, an empty other-filesystem directory for hidden directories, the very inode and a read-only mount for read-only entries). `/proc/self/mountinfo` must show **no other mount below the workspace**.
4. **Landlock**: ruleset handling every filesystem right of the running ABI; grants only the sandbox's own paths (`/usr`, `/proc`, `/nexus`, planned read-only binds read+exec; `/dev` read/write/ioctl; the workspace, `/work/out`, `/tmp` and project-scoped read-write binds everything). `NO_NEW_PRIVS` is set. Abstract-unix-socket and signal **scoping** are applied from ABI 6 and **required** when the command shares the host network namespace (installs).
5. **Self-test**: an ungranted directory (`/work`) must be unlistable, otherwise the gate refuses ("Landlock is not effective").
6. `execv` of the command.

Any failed step exits 197 with `NEXUS-CONFINE-REFUSED: <why>`; the supervisor turns that into a refusal (`SandboxUnavailable: confinement refused … nothing was run and no weaker backend was used`) — **never** a downgrade, never Full Access.
The host side fails closed earlier for: Landlock unavailable or ABI < 3, ABI < 6 with network, gate binary missing / not owned by this user / group- or world-writable / changed since it was recorded (its sha256 is part of the sandbox digest). `BackendCaps`/`preflight` report `landlock_abi` and `launch_gate`; a Workspace grant needs both, a Scratch grant needs neither (**Scratch execution and its sandbox digest are byte-for-byte unchanged**).

What Landlock does **not** do (so it is not claimed): it cannot carve a denied sub-path out of a granted directory (nested protected entries therefore stay mount-level masks, verified by the gate); pathname unix sockets inside a granted directory stay reachable until Landlock ABI 9 (`RESOLVE_UNIX`), so every socket in the workspace is masked by a mount; TCP is not filtered (offline commands have no network namespace, installs are the existing install class).

## 4. M3C.2 — Recursive protected paths (`inplace.rs`)

Descriptor-relative traversal of the whole workspace (fresh `openat` per directory, `fstatat(NOFOLLOW)`, no symlink followed, mount boundary = refusal), bounded (2 M entries / 15 s; beyond it the command is **refused**, not partly protected). Masked, only if the entry exists (a mask on an absent name would create it):

| Entry | Treatment |
|---|---|
| secret-shaped files/dirs (`.env*`, keys, `.ssh`, `.npmrc`, …) at any depth outside dependency dirs | hidden (`/dev/null` file / empty tmpfs dir) |
| Unix sockets, FIFOs, character and block devices, at any depth including dependency dirs | hidden |
| `.git` directory or file at any depth (nested repositories, submodules) | read-only mount of the very object |
| hard-linked regular files (see §6) | read-only mount |
| symlinks | not masked, never followed (their targets are not mapped into the sandbox) |

Limits stated, not hidden: classification is **filename-based** — a secret stored under an ordinary name (`notes/todo.txt`) is not detected (a test pins this). Dependency/build directories are scanned only for special files, not for secret-shaped names or hard links. An entry created or removed between the scan and the mount (a few ms) is not masked / may leave an empty placeholder; the gate catches path substitution, not appearance (tested).
A bug found by the new multi-command tests and fixed: the directory listing shared its read offset with the workspace descriptor, so the **second** command in a workspace would have seen an empty listing and no masks; listings now use a fresh open file description (regression test).

## 5. M3C.3 — Pinned root and mount safety

| Protection | Evidence |
|---|---|
| root pinned after host-side rename/replacement | `the_mounted_workspace_is_the_pinned_object_even_after_the_path_is_replaced` (command sees REAL, impostor never) |
| mount specification checked before the command | gate steps 2–3; `confinement_that_cannot_be_provided…` (wrong root inode ⇒ refused) |
| nested mounts | host check (`mountinfo` below the root) + gate check inside; `an_unexpected_mount_below_the_workspace_is_refused_by_the_gate` |
| protected subpaths cannot be redirected by symlink substitution | `a_directory_swapped_for_a_link_after_the_scan_is_caught_before_the_command_runs` (command never ran, secret never exposed) |
| launch synchronization | the gate is the first process; every refusal test asserts the command's marker file does not exist |
| no unexpected descriptors | gate refuses a leaked descriptor (test), plus the M1 `/proc/self/fd` test now through the gate |

## 6. M3C.4 — Hard-link boundary

**Problem.** A regular file with link count > 1 may also be reachable under a name outside the workspace; writing it through the workspace name modifies that other name. A checkpoint cannot undo it; the sandbox cannot see the other name.

| Strategy | Effect | Verdict |
|---|---|---|
| Break the links (copy-on-launch) | changes the user's real project without authorization | **rejected** (explicitly forbidden) |
| Refuse any run in a workspace that has one | blocks ordinary repositories (some tools hard-link) | rejected: disproportionate |
| Allow and only report | no protection | kept only as an **explicit operator opt-in** (`--allow-hardlinked-writes`, recorded as `allowed-by-operator`) |
| Landlock `REFER`/link control | does not know about pre-existing links | not applicable |
| **Mount such files read-only** | readable; writes, truncation, unlink and replace fail with EROFS/EBUSY; nothing in the project changes | **chosen default** |

Bound: at most 1 024 protected entries per run; beyond it the run is refused (never partly protected). Dependency/build directories (pnpm-style stores) are **not** scanned for hard links — they would exceed any sane bound and are the normal case there — and the count is reported (`hardLinkedInDependencyDirs`).

**Guarantee statement (default policy).** *At launch, every regular file outside the dependency/build tier that has more than one link is read-only for the command: it cannot be modified, truncated, unlinked or replaced through its workspace name, and a write through it cannot change a file outside the workspace.* Tested with a real outside alias (unchanged), with an in-workspace pair, and with a normal file (writable).
**Not guaranteed — and therefore no claim of complete out-of-workspace write confinement is made:** (a) hard-linked files inside dependency/build directories; (b) a link to a workspace file created by something outside the sandbox between the scan and the mount (a window of tens of milliseconds); (c) `allowed-by-operator` mode; (d) bind sources the operator configures as read-write.

## 7. M3C.5 — Git metadata

* A normal repository: `.git` is a read-only mount; `git log`/`status` work; writes to hooks and config fail (tested), and so do hooks in **nested** repositories. A command therefore cannot plant a hook or `core.fsmonitor`/`hooksPath` that a later host-side `git` would execute. Git run *inside* the sandbox executes any hook inside the same confinement.
* A linked worktree: `.git` is a file pointing at a git directory elsewhere. It is mounted read-only, **its target is never mounted** (a repository could otherwise name any directory), so git operations needing the target fail closed; the summary records `linked-worktree-file` and the target path. A hostile `.git` file pointing at a host directory exposes nothing (tested).
* The future separate git-write permission is untouched; no Git subsystem was added.
* Residual: build-steering files that a *host-side* tool later executes (`.envrc`, `.husky/`, …) are ordinary project files and remain writable (M3A reports them as `protected: build-steering`).

## 8. M3C.6/7 — Lifecycle and compatibility

* The cancellation, revocation, expiry, kill-the-daemon, daemon-crash, restart and recovery tests (permissions suite, M1 process-tree tests, M3A, M3B boundaries) were re-run **with the final confinement active**: 26/26 passed in the focused broker run, and they are part of the full battery below. M3A observation and M3B checkpoints work unchanged (their suites pass; the gate adds ≈ 4 ms).
* Compatibility (`compat_m3c`, real sandbox): create dirs/files, `sed -i` formatter, Python generator, Node build, consecutive commands consuming each other's output, reading and changing `package.json`, `cargo build --offline`, `git log/status`, writes to `.git` refused, journal states the confinement. Negative: `/etc/passwd`, `/home`, a file outside the workspace, `/proc/1/root` unreadable; the model cannot supply `confine`, `landlock`, `unconfined`, `hardLinks`, `shim`, `protect`, `maskPaths`, `noConfine`, `gate`.
* A missing/untrusted gate refuses an in-place command and a Scratch command still runs.

## 9. Blockers for M4 (True Direct Workspace)

1. **Real-folder validation has not been done.** Everything above ran on disposable folders. Needed before enabling Direct execution: an acceptance run on a real user project with real Git layouts (submodules, linked worktrees with owner-approved read access), real symlink/hard-link patterns, monorepo size, and a bind-mounted or FUSE folder.
2. **Owner decisions**: per-project `requireCheckpoint` (D4) and the hard-link policy default (`protect` implemented; the operator opt-in is a daemon flag, not yet a per-project, consent-recorded setting); a user-facing restore authority.
3. **Product follow-ups that affect usability, not safety**: checkpoint creation cost (≈ 0.12 ms/file, M3B) carried forward; the dependency-directory blind spots listed in §4/§6 need a policy statement in the consent text; packaging must ship `nexus-confine` beside `nexusd` (the release gate now builds and scans it; an install without it refuses every in-place command by design).

## 10. Unsupported Linux configurations (the command is refused, never downgraded)

* Landlock disabled or ABI < 3 (kernels before 5.19); ABI < 6 (before 6.12) when the command needs network — installs are refused there.
* No `nexus-confine` next to `nexusd` (or not owned by the user / writable by others / modified).
* bubblewrap without `--bind-fd`, no openat2 (kernel < 5.6), no cgroup v2 `cgroup.kill`, non-x86_64.
* A mount below the workspace root, a workspace on a different filesystem than the project mount, a workspace with a special file whose name is not UTF-8, more than 1 024 protected entries, or more than 2 M entries.
* Hosts where unprivileged user namespaces are disabled.

## 11. Residual risks

Kernel vulnerabilities (shared kernel); filename-based secret detection; hard-link and bulk-directory blind spots (§6); the scan-to-mount window (§4); pathname sockets in granted directories other than the workspace's own (none are granted); Landlock does not cover `ioctl` on non-device files or all network behaviour; a seccomp deny-list (not allow-list) remains; owner of restored files is not restored (M3B).

## 12. Performance (release build, tmpfs, this machine; M3A observation and M3B checkpoint are measured separately in their reports)

Measured with `bench_confinement` (ignored test; median of 25 runs after 5 warm-ups for the launch row).

| Measurement | Result |
|---|---|
| bubblewrap launch + trivial command, **without** the gate | 32 ms |
| same **with** the launch gate (verification + Landlock + exec) | 36 ms → **Landlock/gate overhead ≈ 4 ms** per command |
| mount preparation (recursive scan for protected entries), 1 323 entries | 5 ms |
| 20 323 entries | 47 ms |
| 156 324 entries (20 000 source files + 130 000 dependency files) | 386 ms |
| whole launch of `true` (scan + mounts + gate + run): small / medium / large | 38 ms / 88 ms / 420 ms |

So the **total confinement startup overhead is ≈ 40 ms for a small project, ≈ 90 ms for 20 000 files and ≈ 0.4 s for a large repository with 130 000 dependency files**, dominated by the scan, not by Landlock. These are additional to the M3A observation (≈ 0.1–0.2 s at 20 000 files, two passes) and the M3B checkpoint (≈ 0.9 s tmpfs / ≈ 2.7–3.3 s btrfs for 20 000 files). **M3B's checkpoint cost is carried forward unchanged as a product follow-up; nothing in M3C weakens or skips recoverability.** An obvious M4 optimisation, not done here: skip the dependency-directory part of the scan when a previous scan of the same tree is still valid.

## 13. Tests

| Suite | Tests | What it proves |
|---|---|---|
| `confine_m3c` (real bubblewrap + Landlock + seccomp) | 18 passed, 1 ignored benchmark | Landlock in effect (`NoNewPrivs`, ungranted `/work` and `/` unlistable, normal work unaffected); **abstract-socket scoping** with a negative control that reaches the host socket without the gate; fail-closed for ABI too high, wrong gate digest, missing gate, wrong root inode; descriptor leak refused; plan round-trip; nested secrets / sockets / FIFOs masked at every depth, nothing created in the project, **second command masked too**; ordinary-name secret not detected (pinned); path swapped for a link after the scan ⇒ refused; entry vanished after the scan ⇒ nothing exposed; unexpected mount ⇒ refused; pinned root after path replacement; hard links read-only / operator opt-in recorded / too many ⇒ refused / dependency dirs counted; Git (normal, nested, linked worktree, hostile `.git` file) |
| `compat_m3c` | 3 passed | developer session (dirs, files, formatter, generator, Node, Rust, config edits, consecutive commands, `git log/status`, `.git` write refused, confinement in the journal); host paths / model escalation arguments refused; missing gate ⇒ in-place refused, Scratch still runs |
| `exec_contract` unit | +1 | a Workspace grant needs Landlock ≥ 3 and the gate; Scratch does not |
| Broker end-to-end under the final confinement | 26 passed in a focused run (permissions: revoke/expire/clear/narrow/widen in flight; M1: kill daemon during a command ends the process tree, crash after exit never rerun; M3A boundaries; M3B five-boundary crash test, storage exhaustion, restore verb) | cancellation, revocation, daemon crash and restart behave as before |
| Existing M1–M3B suites | unchanged and passing | no regression (`inplace_m1`, `effects_m3a`, `checkpoint_m3b`, `sandbox_a34`, …) |

Regressions found and fixed during the work: the directory-listing offset bug (§4); the first hash of the 32 MB debug gate raced the cancellation tests (the gate now links nothing but libc, and its digest is cached); a concurrent-edit test relied on timing and now waits for the command's first sign of life.

## 14. Validation

Run once, sequentially, on an idle machine (the baseline body dump for `8a08471` was regenerated first, separately: 1 286 passed, 0 failed, 156 dumps), `NEXUS_REQUIRE_SANDBOX=1`, source SHA `a70d1bf`:

| Gate | Result |
|---|---|
| `cargo fmt --all --check`; strict clippy `--workspace --all-targets -D warnings` | clean / clean |
| Rust workspace battery | **1420 passed, 0 failed, 61 ignored** (M3B: 1398 / 0 / 60) |
| Tauri fmt + clippy; Tauri tests | clean; 27 lib, `permissions_m2` 2, `permissions_runtime_m21` 1, `runtime_update_a614` 1: all passed |
| Desktop `tsc --noEmit`, `eslint src`, `vitest run` | clean, clean, **185/185** |
| Release gate (registry-js / engines / e2e / production / release binaries / desktop binary) | PASS 22/22 / PASS 148-0 / PASS 36-0 / PASS 14-0 (negative control detected) / PASS (**4 executables**, `nexus-confine` now built and scanned, none carries a test-only symbol) / PASS |
| Release gate `bodies` vs the pre-M1 baseline `8a08471` | **PASS**: 156 tests, 1 617 bodies, 1 440 identical, 169 volatile tool output, 8 order-only, 0 polling-count-only, **0 unexplained** |

History kept: M3A's first comparison showed 33 unexplained bodies under heavy load; M3B ran clean (0 order-only). This run had no parallel heavy work; the 8 order-only bodies are the same concurrency-ordering class seen once before (two conversations racing), classified by the gate as ordering, not content; no unexplained difference occurred, so there was nothing further to dismiss or classify.
The release gate script was changed in one respect: it now also builds `nexus-tools` binaries and requires/scans `nexus-confine`.

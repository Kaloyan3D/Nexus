# ADR: True in-place process execution for Nexus Native

Status: **PROPOSED. Research and architecture only; no source was changed.** Branch `feature/rust-native-core` @ `9beace9`.
Supersedes the *recommendation* (not the facts) of `NEXUS-DIRECT-PROCESS-EXECUTION-ASSESSMENT.md` ("Stage 2: adopt effects"). The owner has
rejected scratch-copy + effect adoption as the Direct Workspace target; this ADR decides what replaces it.

Evidence labels used throughout: **[code]** read in this repository (path:line), **[measured]** run on this host in a disposable directory
(§4), **[doc]** taken from a prior Nexus document without re-running, **[knowledge]** platform knowledge not tested here, **[unproven]** a design
claim no experiment has yet confirmed.

Host of all measurements: Linux 6.18.55-1-cachyos-lts, x86_64, bubblewrap 0.13.0, Landlock ABI 7, `/home` and projects on btrfs, systemd user
manager running, `/dev/fuse` + `fusermount3` present, cgroup v2. (`A3.4-EVIDENCE.md` was produced on another host; do not read its kernel numbers as this host's.)

---

## 0. Decision summary

1. **Adopt Option C, hardened ("Confined In-Place")**: the real project directory, pinned by an open file descriptor, is bind-mounted read-write
   into the *existing* bubblewrap + seccomp + cgroup sandbox, with mount-level protections (read-only `.git`, masked secrets, masked sockets),
   a mandatory Landlock layer, and **no network while the whole project is visible**. Verdict for Linux: **FEASIBLE, GO** — with guarantees that
   are explicitly weaker than the `fs_write` guarantees (§6). Option B (unrestricted host execution with the project as cwd) is *not* a design;
   it exists only as the separately consented **Full Access** mode. Option A is retained solely for Isolated Workspace.
2. **Permission is two independent axes**: *Workspace* (Isolated | Direct) × *Exec access* (Sandboxed scratch | Workspace Access | Full Access).
   The exec class is sealed into the Kernel process-scope grant and derived by the daemon from the task identity record. The model has no field,
   verb or argument that can raise it.
3. **Honest evidence, three layers**: Authority (Kernel-sealed, before spawn) → Observation (manifest diff, after) → Verified completion (settled
   and independently checked). A command's effects are *observed*, never *authorized per file*.
4. **Do not claim** per-file authorization, crash-atomic rollback, or exact attribution for arbitrary shell commands. A checkpoint (reflink clone
   where the filesystem supports it, bounded copy otherwise) gives *best-effort guarded rollback*. A FUSE mediation layer is the only route to
   per-operation guarantees; it is recorded as a later option, not part of the first implementation.
5. **First implementation target is the safest one**: in-place execution over the **Isolated** task clone (daemon-owned, disposable). It fixes
   `mkdir`/`npm install`/formatters for Isolated tasks with no host risk and proves the mount/evidence machinery before Direct is touched.

Owner decisions required before implementation: §14.

---

## 1. Current-state architecture (as read, with references)

### 1.1 Authority chain

| Link | What it does | Reference |
|---|---|---|
| Broker run | fixes `workspace_kind` at submission; **one writer per folder** (`project-busy`) claimed under a lock, released however the run ends; read-only runs do not claim | `nexus-broker/src/server.rs:631-660` [code] |
| Consent | one-time provider consent text; names isolated copy vs real folder; promises "never reads or changes … the .git folder" and "never commits, pushes, merges" | `nexus-broker/src/consent.rs:36-43` [code] |
| Controller binding | `workspace_root_digest` (+dev/ino) of the task directory; every approval/operation bound to it | `nexus-daemon/src/server.rs:1298-1313`, `nexus-kernel/src/tools.rs:202-230` [code] |
| Kernel process scope | per-command, HMAC-sealed: `command_id, task, attempt, lease_epoch, store_incarnation, root_digest, max_wall_ms, approver_id, independent`. **It carries no exec class, mount, network or write-back field.** | `nexus-kernel/src/tools.rs:202-230`, `:1318-1380` [code] |
| Process request prep | verifies scope ↔ request ↔ binding, resolves the command, clamps the wall budget | `nexus-tools/src/authorization.rs:104-135` [code] |
| Automated policy | `autonomous-workspace/v1`: `proc.run` approved only if `sandbox.network ∈ {none, install(if project allows)}` **and** `sandbox.writeBack == "none"`; `sandbox.*` comes from the daemon-built operation description | `nexus-daemon/src/server.rs:1261-1275`, `:1371-1400`, `:1611-1625` [code] |
| Daemon grant → run | `consume_approval` → `authorize` → `begin` → `run_process_call`; every journal phase through `DaemonProcessHooks` | `nexus-daemon/src/server.rs:3321-3400`, `:2090-2130` [code] |
| Direct open | issuer-only; folder comes from the trusted registry, re-validated; task identity record `kind: direct`; creates the pre-image store | `nexus-daemon/src/server.rs:2573-2700`, `nexus-tools/src/direct.rs:57-110` [code] |

**Key finding 1.** `writeBack: "none"` is a *literal* in three places (`server.rs:1621`, `process.rs:1202`, `process.rs:1329`) plus the policy
check (`server.rs:1391`). It is not derived from anything the Kernel seals. Wiring in-place execution without replacing these would produce audit
records that state the opposite of what happened. This is the first thing a migration must make impossible rather than merely avoid.

**Key finding 2.** The Kernel does not currently know *what a process may do to the filesystem*; it knows only "this command may run for N ms in
workspace root R". The class of execution is a daemon convention. For in-place, it must become Kernel-sealed (§8.3).

### 1.2 Execution today (`proc_run`)

* `run_process` stages a filtered copy of the workspace (`stage.rs`: no `.git`, hidden/secret names, symlinks, hardlinks, specials, files >16 MB,
  bulk dirs; ≤20k files / 256 MB; per-file double read; **not** point-in-time across files) into a per-execution run dir, binds it at `/work/src`
  (`--bind` when `src_writable`, else `--ro-bind`), runs, computes `scratch_effects`, deletes the copy (`nexus-tools/src/process.rs:993-1360`,
  `stage.rs:1-80`) [code].
* Sandbox: bwrap with user/pid/ipc/uts/(net)/cgroup namespaces, `--disable-userns`, `--cap-drop ALL`, `--new-session`, `--clearenv` allow-list,
  synthetic root (`/usr` ro, tmpfs `/tmp` and `/work/out`), `--remount-ro /`, `prlimit` wrapper, generated seccomp (a **deny-list** of 47 x86_64
  syscalls on an allow-by-default base; **x86_64 only**, other architectures refuse), `close_range(4,~0)`, `PR_SET_PDEATHSIG`, transient systemd
  user scope for `MemoryMax/MemorySwapMax/TasksMax`, `cgroup.kill` for the tree (`nexus-tools/src/sandbox.rs:102-135, 239-290, 365-480, 495-530, 817-1000`) [code].
* `SandboxSpec` **already** has `src_dir: PathBuf`, `src_writable`, and `rw_binds`; the writable-bind mechanism exists. What is missing is not
  "can bwrap bind something rw" but *who is allowed to name what is bound, and what proves it was the right object*.
* Command policy: `workbench` allows 13 programs (`cargo npm npx pnpm yarn node tsc python3 pip go dotnet sh make`); **`git` is not a program**
  (`workbench.rs:35`; test at `:463`); `sh -c` is allowed, so argv-shape policy is not the filesystem boundary and never has been (the file says so) [code].
* Install class: the only networked class; project-scoped environment dir `/work/env` (rw), `node_modules` harvested into the env store and
  re-mounted over later runs (`process.rs:527-565`) [code].
* Recovery: `observe_process_for_recovery` kills a leftover `nexus-exec-*` cgroup and removes the run dir; outcome `uncertain`/`never-started`;
  never restarts (`process.rs:1369-1400`); Kernel `reconcile_open_processes` appends `interrupted` (`nexus-kernel/src/tools.rs:1477-1500`) [code].

### 1.3 Workspace identity and path protection

* `Workspace::open_root`: canonicalize, refuse `/`, `/proc /sys /dev`, pseudo filesystems; open `O_DIRECTORY|O_NOFOLLOW`, pin `(dev, ino, mnt_id)`;
  every access is descriptor-relative with `O_NOFOLLOW`, re-`fstat` identity, same-mount check (`workspace.rs:476-540`, header `:1-23`) [code].
  Documented residual: a pre-existing hard link to an outside file is indistinguishable (`workspace.rs:22`). **Confirmed in §4 (E1).**
* `validate_root` for direct folders: absolute, canonical, owned by the daemon euid, not system dirs, not `$HOME` or an ancestor, not Nexus's own
  data (`direct.rs:57-110`) [code].
* Name policy: `always_denied_names` (`.git .ssh .gnupg .aws .kube .docker .nexus* .ai-harness`), secret-shaped names (`.env*`, keys, `*.pem`, …),
  `PROTECTED_NAMES` (lock files, `package.json`, `Makefile`, `Dockerfile`, …) (`workspace.rs:40-200`, `protect.rs:9-40`) [code]. These are
  *names the tools refuse*; none of them constrains a process.

### 1.4 Write path and its guarantees (what a command does **not** inherit)

`fs_write/fs_edit` run `planned → prepared → applied → verified` with a durable journal row before any mutation, atomic exchange publication,
expected-pre-image checks, and (Direct) `WriteHooks::preimage` — "no edit or deletion ever happens without its original being kept"
(`write.rs:1-63`, `direct.rs:1-20`) [code]. The Direct diff is built **only from the paths Nexus touched** (`direct.rs:17`, `:501`) and
`external_changes` flags any path whose content differs from the last post-image Nexus verified (`direct.rs:457-474`) [code].

**Key finding 3.** Those two facts invert under in-place commands: files a command changes are by construction *not* in the touched set, so (a) the
Direct diff would omit them and (b) the first `fs_write` or resume afterwards would classify them as *external* ("changed outside Nexus") and could
credit them to the user. Command effects therefore need an `observed` ledger that the diff and `external_changes` both understand (§9).

### 1.5 Resume, concurrency, UI

* Direct runs: `workspace-mode-changed` forbids crossing kinds on resume; resume reports files changed outside Nexus (`broker/server.rs:631-640`,
  `direct.rs:457`) [code]. Isolated conversations continue through `seed_copy/seed_rebase` (3-way) [doc: `NEXUS-DIRECT-WORKSPACE-ARCHITECTURE-ASSESSMENT.md` §1].
* `ProjectRecord.workspaceMode` ∈ {isolated, direct}, durable per project; `installs: bool` per project (`registry.rs:74-96, 133`) [code].
* CLI `nexus project open|workspace` (`nexus-cli/src/main.rs:1796-1847`), Desktop `projectSetEditMode` → `project_set_edit_mode`
  (`apps/nexus-desktop/src-tauri/src/lib.rs:719`, `src/lib/api.ts:105,208`, `src/state/NexusContext.tsx:630`) [code]. Both expose *workspace*; neither
  has any notion of *exec access*.
* Model guidance tells the model commands run "over a throw-away copy" (`broker/guidance.rs:33`) — must change with the mode [code].

### 1.6 Which prior claims hold

`NEXUS-DIRECT-PROCESS-EXECUTION-ASSESSMENT.md` ("a bigger step is not recommended") is **right** that unconstrained in-place execution loses
per-file pre-image, per-file name policy and cheap rollback, and **right** that an overlay cannot hide secrets. It is **overstated** in four places:

| Claim | Verdict | Basis |
|---|---|---|
| "could write `.git/hooks`" | Preventable: read-only sub-mounts over `.git/hooks`, `.git/config` (or all of `.git`) | E3 [measured] |
| "replace files with symlinks mid-race" | Cannot escape the mount namespace (all symlink targets resolve inside the sandbox); the real hazard is a symlink that is *dangling in the sandbox but live on the host* (confused deputy against host tools) → detect and report | E1 [measured] |
| "secrets readable" | Existing secret-shaped files/dirs can be masked by bind (`/dev/null`, tmpfs); arbitrary-named secrets cannot (name heuristic, same as `fs_read`) | E3 [measured] |
| "no cheap rollback" | On reflink filesystems a whole-tree checkpoint is O(metadata) (6 ms for a 40-file tree here; btrfs/XFS/APFS) | E7 [measured] |

It is **missed** that in-place changes the *network* story: today install runs on a filtered copy with no secrets and no `.git`; in-place with the
network on would put every readable project file next to an egress path (postinstall scripts). This ADR therefore forbids "full view + network".
It also missed pathname Unix sockets (E4), which the stager had silently excluded.

---

## 2. Alternatives

* **A. Scratch copy + guarded adoption** (the previous Stage 2).
* **B. Unrestricted host execution, project as cwd.**
* **C. Real project bound read-write into the OS-confined sandbox.** (This ADR's choice, hardened.)
* **D (extension, not scored as a candidate). FUSE mediation of the project**: the project is mounted into the sandbox through a Nexus FUSE
  filesystem that journals and pre-images every mutation. Only route to per-operation guarantees; see §6.4.

| Criterion | A. scratch + adopt | B. host cwd | **C. confined bind** | D. FUSE (extension) |
|---|---|---|---|---|
| True in-place semantics (inode identity, mtime, `watch`, partial writes visible live) | **No**: effects appear after exit, as a diff; background processes' writes are lost | Yes | **Yes** (same inode, same fs) | Yes, but via a userspace fs (watch/inotify behaviour differs) |
| Security / isolation | Strong (nothing reaches host except Nexus's own guarded writes) | **None**: user's full OS authority (ssh keys, cloud creds, other repos, network) | Strong for host & other projects; project contents fully exposed to the process | Strongest in-project (per-op policy) |
| Developer-tool compat | Poor: build outputs/lockfile/`node_modules`/formatters/generators need an adoption policy per file class; `git` unusable; long-running servers meaningless | Perfect | Very good; `git` works if `.git` mounted (config/hooks ro); file-watchers work | Medium: HMR/watch, mmap, `O_TMPFILE`, rename atomicity edge cases |
| Reliability / crash recovery | Best (nothing partial reaches the project; adoption journaled) | Worst (no record) | Good for *process* (cgroup kill, journal); effects uncertain after crash → observation + checkpoint | Best (op journal) but the FUSE daemon is a new SPOF |
| Performance | Stage copy per command (today: O(files), bounded 20k/256 MB) + diff | Native | Native I/O; cost = pre/post stat-manifest (§9: ~3.3 s for 71k files cold, measured) + optional checkpoint | 2–10× on metadata-heavy work [knowledge] |
| Git workflows | Not possible (`.git` never staged) | Full (and full danger) | Local git works (E8); no credentials/network by default | Possible |
| Long-running processes | Not meaningful | Yes | Yes (`service` class, §8.6) | Yes |
| Cross-platform | Needs a sandbox + staging (Linux only today) | Trivial | Linux strong; macOS path-rules (weaker); Windows ACL/AppContainer (hazardous) | FUSE on Linux/macFUSE; Windows WinFsp; each a new dependency |
| Implementation complexity | Adoption policy matrix (per file class), conflict UX, atomic multi-file apply | Smallest | Medium: mount spec, masks, observation, checkpoint, Kernel scope change | Large: a filesystem |
| Maintenance burden | Ongoing: every toolchain's output convention | None, but unbounded support/security burden | Moderate: mount layout + host-requirement matrix | High |

**Why A is rejected beyond the owner's veto.** Its structural failure is not engineering effort: a command's *meaning* is its side effects
(`npm install`, `cargo fmt`, `git commit`, a code generator that writes to three directories, a dev server that regenerates files). Adoption must
decide, per file class, which effects count; every decision is wrong for some toolchain, and the result is never "what the user's other tools see".

**Why B is only a mode, not a design.** It is the correct implementation of the owner's "Explicit Full Access" and must exist as a
*separate, separately consented class* — never as a fallback (§7, §10).

---

## 3. Target architecture

```
                         TRUSTED (user-level, daemon identity)                       │      UNTRUSTED
┌──────────────┐  intent   ┌────────────┐ sealed scope ┌──────────────────────────┐  │  ┌─────────────────────────────┐
│ Desktop/CLI  ├──────────►│  Broker    ├─────────────►│ Kernel (journal, HMAC    │  │  │ Model (proposes ProcessArgs │
│ (user dialog)│ mode+     │ claim lease│              │ scopes incl. ExecClass)  │  │  │ {program,args,cwd} ONLY)    │
└──────┬───────┘ consent   └─────┬──────┘              └────────────┬─────────────┘  │  └──────────────┬──────────────┘
       │ registry (workspaceMode, execAccess)                       │ grant          │                 │ tool call
       ▼                         ▼                                  ▼                │                 ▼
┌──────────────┐          ┌─────────────────────────────────────────────────────┐    │  (no field can select class,
│ Project      │ fd+ident │ Daemon: derive ExecClass from task identity record; │    │   mount, net, or path outside
│ registry     ├─────────►│ policy autonomous-workspace/v2; ExecBackend.prepare │    │   cwd-relative)
└──────────────┘          └───────────────┬─────────────────────────────────────┘    │
                                          │ PreparedExec{root_fd, view, masks, net}  │
                          ┌───────────────▼─────────────────────────────────────┐    │
                          │ ExecBackend (linux-bwrap-landlock/1)                │    │
                          │  1 pin root fd, verify (dev,ino,mnt_id,owner)       │    │
                          │  2 refuse nested mounts under root                  │    │
                          │  3 checkpoint (reflink | bounded copy | none+flag)  │    │
                          │  4 pre-manifest                                     │    │
                          │  5 bwrap --bind-fd root /work/src                   │    │
                          │     + ro-bind-fd .git(hooks,config|all)            │    │   ┌───────────────────────────┐
                          │     + /dev/null masks (existing secrets, sockets)   │    │   │ SANDBOX (userns, pidns,   │
                          │     + seccomp + Landlock(shim) + cgroup scope       ├────┼──►│ netns, mountns, cgroup)   │
                          │  6 supervise (cancel/revoke/wall/mem/tasks)         │    │   │  /work/src  = REAL project│
                          │  7 settle (cgroup empty) → post-manifest → effects  │    │   │  /work/env  = env store   │
                          └───────────────┬─────────────────────────────────────┘    │   │  /usr ro, tmpfs /tmp      │
                                          │ journal: prepared/running/observed/...   │   │  NO host $HOME, /etc, run │
                                          ▼                                          │   └───────────────────────────┘
                                   Kernel journal + direct::Store(observed ledger)   │
                                                                                     │   FULL ACCESS = separate class:
                                                                                     │   host spawn, user OS privileges,
                                                                                     │   user-dialog grant, §7.3
```

Trust boundaries: (1) model ↔ daemon (tool arguments are untrusted data); (2) daemon ↔ sandbox (everything inside is hostile, including the project's
own contents, dependency scripts and tool output); (3) project directory ↔ *user's other host tools* (editors, git, build runners that later execute
what the sandbox wrote — **not** covered by any sandbox, §10 R1); (4) user dialog ↔ everything else (only boundary that may grant Full Access).

---

## 4. Linux feasibility: experiments

All experiments ran in a throw-away directory in the session scratchpad (plus one `~/.cache` directory on btrfs, removed). No project source or
production data was touched. Reproduction script is in Appendix A. The harness mimics `bwrap_argv` (`sandbox.rs:365`) minus seccomp/prlimit/cgroup,
which are unchanged code paths.

| # | Question | Result | Consequence |
|---|---|---|---|
| E1 | Does `--bind-fd` of an `O_PATH|O_DIRECTORY` fd bind exactly the verified object, and does the sandbox see the same identity? | **Yes.** Host `fstat` = `(50, 2259512)`; inside `stat /work/src` = `(50, 2259512)`; host-side check through `/proc/<bwrap-child>/root/work/src` = same; `mountinfo` shows `rw,nosuid,nodev`. Files created inside are owned by the real uid on the host (`1000:1000`). | Identity is verified **by construction** (the fd *is* the object) and can be cross-checked after spawn. Path-based `--bind` must never be used for the project. |
| E1b | Symlinks and hard links | `rel-link → ../outside/x`, `abs-link → ~/.ssh`, `abs-host-link → /host/path` all **fail to resolve** inside the sandbox (outside paths are not mapped). A *pre-existing hard link* to an outside file **is readable** (same inode). | Confirms the documented hard-link residual. Symlinks cannot be used to read the host, but they persist on the project and are live on the host → report new symlinks whose target escapes the root. Flag `nlink > 1` regular files in evidence. |
| E1c | Host renames the project directory mid-run | Sandbox keeps writing to the **same inode**; the file appears under the new name. | After spawn, *path* ≠ *mounted object*. All evidence, manifests, and settle checks must use the pinned fd, never the registry path. |
| E2 | Does `--ro-bind /dev/null X` on an **absent** `X` create something in the project? | **Yes — it creates an empty file `X` in the real project** (and it stayed after exit). | Masks only for entries that exist at launch (descriptor-relative scan). Never mask by name speculatively. |
| E3 | Read-only sub-mounts and secret masks inside a writable project bind (sources opened via descriptor-relative `O_NOFOLLOW|O_PATH` and passed as `--ro-bind-fd`) | `.git/hooks` and `.git/config` writes → `EROFS`; other `.git/*` writable; masked `.env.real` → unreadable; real file unchanged on host. | Mount-level protected paths are **enforceable**. Nested path-based `--ro-bind /work/src/.git/hooks` fails ("source not found") — the source must be a host path/fd, so use `--ro-bind-fd`. |
| E4 | Pathname Unix socket inside the project, listener on the host | **The sandbox connected to the host listener and received data.** After masking the socket with `/dev/null`: `ECONNREFUSED`, listener saw nothing. | A project-local socket (ssh-agent, docker, language servers) is an **escape primitive that the staged copy never exposed**. Mask existing sockets; Landlock ABI ≥ 6 scopes *abstract* sockets/signals only; a socket created by a *host* process during the run is a residual (R6). |
| E5 | Real git in place | (a) `.git/hooks`+`config` read-only: `git add -A && git commit` succeeded, host `git log`/`status` consistent, `git fsck` clean; `git config`/`git remote add` fail with `could not write config file: Device or resource busy`. (b) whole `.git` read-only: `git status`, `git diff`, `git log` work (exit 0); `git add`/`git commit` fail cleanly with `Unable to create .git/index.lock: Read-only file system`; host tree unchanged. | Local git works in place. Config-protection fails closed with a confusing `EBUSY` → the tool result should translate it. |
| E6 | Landlock inside the *existing* bwrap+seccomp stack | Ruleset created/enforced from inside; write to the read-only-ruled `/work/src` → `EACCES`, `/tmp` writable. Seccomp deny-list does not block the 444–446 syscalls. | Landlock composes with the current sandbox. It cannot subtract from an allowed subtree, so it is *defense in depth*, not the mask mechanism. Requires a small in-sandbox launcher shim (bwrap has no Landlock option). |
| E7 | Reflink checkpoint; stat-manifest cost | `cp --reflink=always` of a 40-file tree: 6 ms on btrfs. Manifest (`find -printf size,mtime,ctime,ino`) of the full Nexus repo excluding `node_modules/target/.git`: **71 434 files in 3.3 s (cold)**; including bulk dirs the tree is 437 092 files. | Checkpointing is cheap *only* on reflink filesystems; the manifest must be tiered (full for source, summarized for bulk dirs). |
| E8 | Event-based evidence | `fanotify_init` → `EPERM` for the user and for a userns-root. | No unprivileged real-time or permission-event stream. Evidence = before/after manifest (+ optional inotify, which is lossy). Exact attribution is therefore unavailable without FUSE (D). |
| E9 | Host requirements | `unprivileged_userns` available, `max_user_namespaces` 59 396; `fuse` yes; `overlay` not currently loaded; no `pasta/passt/slirp4netns`. | Host-requirement matrix §12; port-forwarding for dev servers needs a decision (§8.6). |

**Not tested (and why it is listed as an engineering stage, not assumed):** nested mounts below the project root (needs a privileged-looking setup —
test via a userns mount in the harness), `--block-fd`/`--userns-block-fd` pre-exec verification, `nsenter -U -n` port forwarding, ext4/xfs/tmpfs
fallback paths, file capabilities/xattrs, macOS and Windows (no such host here), cgroup interplay with a bound real directory (unchanged code
path), aarch64 (seccomp program is x86_64 only, `sandbox.rs:291,337`).

**Feasibility verdict (Linux True In-Place): FEASIBLE — GO**, conditional on: (a) `bwrap ≥ 0.13` (for `--bind-fd/--ro-bind-fd`; verify at preflight),
(b) unprivileged user namespaces, (c) Landlock ABI ≥ 1 present or the mode refuses, (d) x86_64 until the seccomp program is ported,
(e) the guarantees in §6 being accepted as stated. The mechanism is *simpler* than today's (no staging copy); the difficulty is entirely in
authority, masks, evidence and recovery.

---

## 5. Linux design details

### 5.1 Mount construction (replaces `stage_workspace` for in-place classes)

1. Open the project root with the existing `Workspace::open_root` (pins `(dev, ino, mnt_id)`, rejects pseudo filesystems). Re-validate with
   `direct::validate_root` (owner = daemon euid, forbidden prefixes). Take an `O_PATH|O_DIRECTORY|O_CLOEXEC` fd; pass it with `pass_fds`.
2. **Refuse nested mounts**: parse `/proc/self/mountinfo`; any mount whose mountpoint is below the root path refuses with `nested-mount` (a bind or
   FUSE mount inside the project could re-export anything). `Workspace::same_mount` already encodes the same rule for tools (`workspace.rs:537`). [unproven for the `--bind` recursion flag; T7]
3. `--bind-fd FD /work/src`. Cross-check after spawn via `/proc/<child>/root/work/src` identity and `mountinfo` flags (`nosuid,nodev` observed). Use `--block-fd`
   so the command cannot execute before the check passes [unproven; T1].
4. Protected sub-paths via descriptor-relative open of each *existing* entry (`openat O_PATH|O_NOFOLLOW`), then `--ro-bind-fd` (read-only) or
   `--ro-bind /dev/null`/tmpfs (hidden). Default set (Workspace Access): `.git` **read-only** (opt-in rw with `hooks` and `config` still read-only),
   existing entries classified `Sensitive` by `classify_name`, `.nexus*`/`.ai-harness`, every existing socket/FIFO/device. Absent names are never masked (E2).
5. Everything else of the existing sandbox is unchanged: synthetic root, `/work/env` (project env store, rw), tmpfs scratch, seccomp, `prlimit`,
   systemd scope, `cgroup.kill`, clearenv allow-list.
6. Landlock shim (`nexus-sandbox-init`, a ~200-line static Rust binary run as the sandbox's program before `exec`): rulesets allow `rw` on
   `/work/src`, `/work/env`, `/tmp`, `/work/out`; `rx` on `/usr`; scope abstract sockets + signals when ABI ≥ 6. Failure to apply = refuse (no degrade).

### 5.2 Network, localhost servers, caches

* Default `none`: private network namespace with its own `lo`; servers started and tested *within one command* work (existing behaviour,
  `process.rs` writes a minimal `/etc/hosts`).
* **Rule R-NET: the network is never combined with the full project view.** Dependency installation becomes the `install` class with a
  **narrow view**: `/work/src` is a tmpfs onto which only manifests, lock files and the dependency directory are bound (descriptor-relative):
  `package.json`, lock files, workspace manifests (bounded scan), `node_modules` (created in the project through the project fd if absent). Sources,
  `.git`, secrets and sibling files are not visible while the network is up; `.npmrc`/`.pypirc` are `Sensitive` and not mapped (private registries
  will fail — stated, not hidden). This replaces `harvest_node_modules` for in-place.
* Reaching a dev server from the host browser needs a forwarder (`nsenter -U -n` into the exec's namespaces, or `pasta`). Not available on this host;
  **[unproven] — separate stage (S7)**; do **not** solve it by sharing the host netns (that exposes host loopback services and, with a shared netns,
  the host's abstract Unix sockets such as X11's).
* Per-project writable caches stay in the env store (`/work/env`: npm/pip/cargo/go/nuget caches, `CARGO_TARGET_DIR`), so builds do not litter the
  project unless the project itself directs output there. Dependency directories that tools write *inside* the project (`node_modules`, `.venv`)
  are real project changes (that is what in-place means) and are summarized, not enumerated, in evidence (§9).

### 5.3 Inherited state

Existing controls carry over unchanged: `--clearenv`+allow-list, `close_range(4,~0)`, `--new-session`, `--disable-userns`, `no_new_privs`, no
`$HOME`, `/etc`, `/run`, `/var`. New: the project fd and protected-entry fds are inherited *by bwrap only* and closed before the command runs
(bwrap consumes them), and the Landlock shim must `close_range` anything above 2 before exec. Test T-fd asserts only 0/1/2 remain.

### 5.4 Kill / revoke / restart

Unchanged mechanism (cgroup scope + `cgroup.kill`, `--die-with-parent`, pid namespace): cancel or Kernel revoke kills the whole tree
(`sandbox.rs` supervisor loop; A3.4 tests). New obligations: after kill, **settle** (cgroup empty — poll `cgroup.events populated=0`), then take the
post-manifest and record the effects as `partial`. Daemon crash: reconcile kills the cgroup (existing) and now also computes an observed diff against
the durable pre-manifest; the outcome stays `uncertain` and **no rollback is automatic** (it could destroy the user's later edits). Restart of a
command is never automatic (unchanged).

### 5.5 Host requirements / limitations

bwrap ≥ 0.13 with `--bind-fd`; unprivileged userns (Ubuntu 24.04+ needs an AppArmor allowance or the preflight must fail); cgroup v2 + systemd user
manager for kernel-enforced limits (otherwise labelled `rlimit-polling`, `sandbox.rs:495-530`); Landlock ABI ≥ 1 (kernel 5.13+; ABI 6 for scoping);
x86_64 only until the seccomp program is ported; reflink filesystem for O(1) checkpoints (btrfs, XFS with reflink, APFS) — otherwise bounded copy or no
rollback. Preflight reports each as a capability; a missing *required* capability refuses the in-place class and **never** selects a weaker class.

---

## 6. Honest guarantees

### 6.1 Guarantee levels

* **ENFORCED** — a violation is prevented, or the operation refuses before mutation.
* **DETECTED** — not prevented; reported in evidence with the limits of the detection.
* **BEST-EFFORT** — happens when preconditions hold; evidence states whether they held.
* **NONE** — stated absence.

### 6.2 Table

| Property | Broker-mediated `fs_write`/`fs_edit` (today) | Arbitrary command, Workspace Access (this ADR) |
|---|---|---|
| Pre-image preservation | **ENFORCED** — refuse if not kept (`write.rs:50`, `direct.rs:9-13`) | **BEST-EFFORT** — checkpoint (reflink: complete for the tree; bounded copy: complete only within count/size caps and excluded bulk dirs; none: absent). Evidence records `checkpoint{kind, complete, excluded}` |
| External-modification protection | **ENFORCED** — expected-pre-image + exchange; stale overwrite refused | **NONE during the run** (a command can overwrite a concurrent user edit). **DETECTED afterwards** only that the file changed in the window, not by whom |
| Atomic writes | **ENFORCED** — temp + fsync + rename + dir fsync | **NONE** (the tool's own semantics) |
| Change attribution | **ENFORCED** — each op journaled with its grant | **DETECTED, temporal** — "changed between t0 and t1 while command X ran"; Nexus's own concurrent `fs_write`s are subtracted by journal; the user's cannot be (E8). Exclusive project lease reduces but cannot remove ambiguity |
| Rollback / undo | per-file from kept originals (manual today) | **BEST-EFFORT** guarded restore from the checkpoint: 3-way (checkpoint / post-run / now); a path whose current content ≠ post-run is **never** overwritten |
| Protected paths | **ENFORCED** (name policy at broker + daemon, descriptor-relative) | **ENFORCED only for mount-level masks** (`.git` ro, hooks/config, existing secrets/sockets, `.nexus*`); `PROTECTED_NAMES` (lockfiles, `package.json`, `Makefile`, …) become **DETECTED/flagged** — a shell can write any source file anyway, so claiming otherwise would be false |
| Crash recovery | **ENFORCED** — journal + `reconcile_open_writes`; outcome never invented | Process: **ENFORCED** (cgroup killed, no restart). Effects: **UNCERTAIN → DETECTED** via durable pre-manifest vs now; **no crash-atomic rollback is claimed** |
| Concurrent command safety | n/a | **ENFORCED among Nexus runs** (extend the `project-busy` claim to exec leases). **NONE** against the user's own tools |
| Per-file authorization | Yes (`evaluate_autonomous_policy` approves path + size per edit, `server.rs:1288-1400`) | **No.** Authority is per *command + class + view*; files are observed, never pre-authorized |

### 6.3 What must be said in product text

"Commands run directly on your project files. Nexus keeps a checkpoint when your filesystem allows it, records everything that changed, and
protects `.git` internals and secrets by construction — but it cannot make a command's edits atomic or reviewable before they happen." The consent
text (`consent.rs:36`) and the model guidance (`guidance.rs:33`) must change; the current "never changes … the .git folder" promise is false once
`.git` is mounted, even read-only for writes it is *readable*.

### 6.4 Route to stronger guarantees (not in scope)

A FUSE passthrough filesystem (Option D) sees every operation from the sandbox: it can pre-image on first write, journal, enforce per-path policy
including `PROTECTED_NAMES`, make attribution exact, and serialize against `fs_write`. Cost: a new filesystem to write and keep correct, performance, and
watch-semantics risk for HMR. `/dev/fuse` and `fusermount3` exist here; no prototype was built. Revisit if the evidence shows temporal attribution or
checkpoint gaps are unacceptable in practice.

---

## 7. Permission architecture

### 7.1 Two independent concepts

```
                       Exec access (what a COMMAND may do)
                       Sandboxed scratch      Workspace Access        Full Access
Workspace   Isolated   today's behaviour      in-place over the       (not offered)
(where                 (default, unchanged)   disposable task clone
Nexus's                                       (S1: safe first target)
edits go)   Direct     today's behaviour      in-place over the real  host exec under the
                       (what ships now)       folder, confined        user's OS privileges
```

* **Workspace** remains `ProjectRecord.workspaceMode` (`registry.rs:74`). **Exec access** is a new durable per-project field `execAccess ∈
  {scratch, workspace, full}`, default `scratch` for every existing project. A new project's default is an owner decision (D1).
* Both are read by the daemon from the trusted registry at `direct-open`/task open and written into the task identity record (like `kind: direct`).
  `ProcessArgs` stays `{program, args, cwd}`. There is **no model-reachable way** to select, raise or negotiate the class; the only writers are
  the Desktop native dialog and the CLI `nexus project exec-access`, both behind peer-credential-gated broker verbs (as `project_set_workspace` is).
* A started task never changes class; a resume with a different class is refused like `workspace-mode-changed` (`broker/server.rs:631`).
* `Full Access` with `Isolated` is refused (Isolated promises containment; a host process in a "copy" would silently make that false).

### 7.2 Workspace Access (confined in-place)

* Automated policy `autonomous-workspace/v2` (digest includes class, view rules, mask rules, backend id): approves `proc.run` iff the Kernel-sealed
  class is `workspace`, the daemon-derived mount spec digest equals the one in the grant, network ∈ {none, install-with-narrow-view}, per-task
  command budget not exhausted, the project is claimed by this task, and the backend's capabilities ⊇ the required set. It never compares a string the
  caller supplied (§1.1 finding 1).
* No per-tool prompts. Dependency installation keeps its separate per-project `installs` switch.
* Git: §10.2. Network: §5.2. Package managers: §5.2. Credentials: nothing is mapped (no `$HOME`, no agent, no credential helper); `HOME=/work/out/home`.

### 7.3 Explicit Full Access

* A distinct Kernel-sealed class (`full`), minted only from a **user-native grant**: a Desktop/CLI confirmation that names the project folder and states
  the consequences ("commands run as you: they can read your SSH keys and cloud credentials, change any file you can, and use your network; Nexus's
  protections for this project do not apply"). Recorded as `approver_id = user-dialog`, `independent = true`, per project, revocable, with an expiry
  (D5). It requires a daemon started with a separate flag (`--enable-host-exec`), which is **not** implied by `--enable-process` and is refused together with
  nothing else — i.e., sandbox-only deployments cannot be talked into it.
* Execution is a different backend (`host`): it does **not** go through bwrap, and the daemon's rule "no unsandboxed fallback anywhere"
  (A3.4 §Verdicts) is preserved by construction — Full Access is chosen *by the user in advance*, never selected by the daemon on failure.
* Still kept (they do not confine, they supervise): systemd scope limits and `cgroup.kill`, wall clock, output caps and redaction, journal rows with
  the exact argv, cwd, env digest and exit, pre/post manifest of the project directory, cancel/revoke kill. No per-tool prompts.
* Stated residuals: stdout goes to the model provider (redaction is heuristic); the command can touch anything the user can; evidence outside the
  project is not collected; there is no rollback outside the project.

### 7.4 No model-controlled escalation — enforcement points

1. Schema: `ProcessArgs` has no class field; `deny_unknown_fields` (T16).
2. The class lives in the Kernel HMAC-sealed process scope (domain bump, §8.3); `prepare_process` compares it with the daemon-derived class.
3. The approval operation description is *derived from the sealed class and the prepared mount spec*, not a free-form JSON the policy trusts.
4. `Full` additionally requires the host-exec daemon flag and a user-dialog grant row; absence refuses with no execution.
5. A project's `execAccess` changes only through the user-gated verb and only affects *new* tasks.

---

## 8. Execution backend contract (Rust)

### 8.1 Interfaces (proposed; names illustrative)

```rust
/// What a backend can actually enforce, probed at start (never assumed, never inferred from the platform name).
pub struct BackendCaps {
    pub id: &'static str,                   // "linux-bwrap-landlock/1", "macos-seatbelt/1", "host/1"
    pub pinned_root_mount: bool,            // binds the verified object, not a path (E1)
    pub subpath_readonly: bool,             // .git/hooks inside a writable root (E3)
    pub hide_existing_entries: bool,        // secrets / sockets masks (E3, E4)
    pub fs_allowlist_layer: Option<u32>,    // Landlock ABI; None = absent
    pub network: NetCaps,                   // None | PrivateLoopback | Egress(allowlist?) | Host
    pub resources: Enforcement,             // KernelCgroup | RlimitPolling | JobObject | None
    pub kill_tree: KillGuarantee,           // Cgroup | ProcessGroupBestEffort | JobObject
    pub checkpoint: CheckpointKinds,        // Reflink | BoundedCopy
    pub arch: &'static [&'static str],
}

pub enum ExecClass { Scratch, WorkspaceAccess, FullAccess }

pub struct ExecPlan {
    pub id: ExecutionId,
    pub class: ExecClass,                   // sealed in the Kernel scope; backend re-checks
    pub command: ResolvedCommand,           // existing policy output
    pub root: PinnedRoot,                   // OwnedFd + {dev, ino, mnt_id, owner, canonical path (display only)}
    pub view: View,                         // Full | Narrow{ allow: Vec<RelPath> }
    pub protect: Vec<ProtectedPath>,        // {rel, Hide | ReadOnly}, only existing entries
    pub net: NetClass,                      // None | Install   (Host only for FullAccess)
    pub env_store: Option<PathBuf>,         // /work/env
    pub limits: SandboxLimits,
    pub checkpoint: CheckpointPolicy,       // Require | Prefer | Off (Off only if the owner allows)
    pub required: RequiredCaps,             // derived from class+view+net; compared with BackendCaps
}

pub trait ExecBackend: Send + Sync {
    fn caps(&self) -> &BackendCaps;
    /// Pure + fd acquisition. Returns a digest of the exact mount/argv/filter set (extends sandbox_digest, sandbox.rs:481).
    fn prepare(&self, plan: &ExecPlan) -> Result<PreparedExec, ExecRefusal>;
    /// Runs under the supervisor; calls ctl.on_spawned/should_stop like SandboxControl does today.
    fn run(&self, p: PreparedExec, ctl: &mut dyn ExecControl) -> Result<ExecOutcome, ExecError>;
    /// Crash path: kill leftovers described by a durable record; never restarts.
    fn recover(&self, durable: &serde_json::Value) -> serde_json::Value;
}

pub trait EffectObserver { // platform-neutral, uses the pinned fd, not a path
    fn pre(&self, root: &PinnedRoot, scope: &ObserveScope) -> Result<Manifest, ObsError>;
    fn post(&self, root: &PinnedRoot, pre: &Manifest) -> Result<EffectSet, ObsError>;
}
pub trait Checkpointer { fn create(&self, root: &PinnedRoot, p: &CheckpointPolicy) -> Result<CheckpointRef, CkError>;
                         fn restore_guarded(&self, ck: &CheckpointRef, post: &Manifest) -> RestoreReport; }
```

Rule: `required ⊆ caps` or `ExecRefusal::BackendInsufficient{missing}`. The refusal is surfaced to the user with the *different* permission mode as an
explicit choice (e.g. "Workspace Access is unavailable on this machine because X; Sandboxed scratch is still available; Full Access is a separate
decision"). It never auto-selects either.

### 8.2 What is reused unchanged

`run_sandboxed` supervision loop, `bwrap_argv` skeleton, seccomp program, `prlimit`, systemd scope, output readers/redaction, `ProcessHooks` journal
phases, `observe_process_for_recovery`, `Workspace` descriptor-relative primitives, `direct::validate_root`, project claim (`direct_claims`),
`classify_name`, `PROTECTED_NAMES` (as flags), `protect::workbench_path_check` for fs tools.

### 8.3 What must change in the authority chain

1. `ProcessScopeBinding` + `process_scope_canonical` + `PROCESS_SCOPE_DOMAIN` (`nexus-kernel/src/tools.rs:87,202-230`): add `exec_class`, `view_digest`,
   `net_class`; domain `…/v2`. v1 rows read as `scratch` (compat), never as `workspace`.
2. `bind_process_scope_inner` (`:1318`) takes them from the approver (the automated policy or the user-dialog).
3. `prepare_process` (`authorization.rs:104`) refuses if the sealed class ≠ the daemon-derived class.
4. `evaluate_autonomous_policy` → `autonomous-workspace/v2` (`server.rs:1288-1400`): replace the `writeBack == "none"` string test; operation description built from the prepared plan.
5. Remove the three `"writeBack": "none"` literals (`server.rs:1621`, `process.rs:1202`, `process.rs:1329`); compute from class.
6. New journal phases `checkpointed`, `observed` (`process.rs:32-36`, Kernel state machine `record_process_phase`); `interrupted` payload gains the observed diff.
7. `direct::Store` gains the `observed` ledger and attribution `command:<executionId>`; `diff` and `external_changes` (`direct.rs:457,501`) consume it (§9).

### 8.4 Cross-platform paths (what is realistic)

| Platform | Mechanism | Pinned root | Subpath ro / mask | Network off | Kill tree | Memory/CPU | Verdict |
|---|---|---|---|---|---|---|---|
| **Linux** | bwrap + seccomp + Landlock + cgroup scope (this ADR) | yes (`--bind-fd`) | yes (mount) | yes (netns) | yes (cgroup) | kernel | **Workspace Access: supported** [measured] |
| Linux without bwrap/userns (hardened distro) | in-tree launcher (`unshare`+`pivot_root`) or rootless podman as a *second backend* | depends | depends | depends | cgroup | cgroup | `BackendInsufficient` until a backend exists; **no fallback** |
| **macOS** [knowledge, untested] | Seatbelt profile (`sandbox-exec`/`sandbox_init`; deprecated API, still what Chromium and agent CLIs use) | **no** — rules are path-based; a renamed/replaced dir is a TOCTOU | yes: `(deny file-write* (subpath ".git/hooks"))` with deny precedence; `(deny file-read* (literal …))` for existing secrets | yes | **weak**: process group/session only; a double-fork escapes; no cgroup | rlimit + polling only | Workspace Access possible with **downgraded caps** (`pinned_root_mount=false`, `kill_tree=best-effort`, `resources=polling`) → each downgrade must be a declared requirement the owner accepts, else fail closed |
| **Windows** [knowledge, untested] | restricted token or AppContainer + Job Object | no (ACLs by path) | via ACL deny ACEs | AppContainer w/o network capability | **strong** (Job Object kill-on-close) | **strong** (Job limits) | Workspace Access requires **mutating the project directory's ACLs**, a persistent change that a crash can leave behind (needs a journaled grant/revoke); WSL2 runs the Linux backend but `/mnt/c` (drvfs/9p) breaks bind/reflink/perf semantics. **Initial verdict: Workspace Access unavailable (fail closed); Full Access available** |

The existing sandbox is already Linux/x86_64-only (`sandbox.rs:337`), so today non-Linux hosts have *no* process execution; this ADR does not
regress that, and says so rather than implying parity.

---

## 9. Evidence model

### 9.1 Three layers, never mixed

| Layer | Question | Source | When | Strength |
|---|---|---|---|---|
| **E1 Authority** | what was the command *allowed* to do | Kernel-sealed scope + prepared plan digest (class, root identity, view digest, mask-set digest, net class, limits, sandbox/filter digest, backend id/caps, policy id/digest, approver) | durable **before** spawn (`prepared`) | cryptographic (HMAC seal + journal) |
| **E2 Observation** | what *changed* in the project | pre/post manifest over the pinned fd; checkpoint ref; run window; cgroup-empty settle | durable at `observed`/`interrupted` | observed fact; complete only as far as `observation.complete` says |
| **E3 Verified completion** | is the task's claim true | exit status + `settled` + effects reconcile + an independent check run (existing `verified-passed` semantics) | end of run | the only layer that may say "verified" |

### 9.2 Observation record (`observed`)

`{window{t0,t1}, preManifestDigest, postManifestDigest, checkpoint{kind, ref, complete, excluded[]}, effects{created[], modified[], deleted[],
modeChanged[], symlinksCreated[{path,target,escapesRoot}], specialsCreated[], hardlinked[], protectedTouched[{path,rule}], bulkDirs[{path,
changed,count?}]}, overlapWith{nexusWrites[]}, attribution:"temporal", settled:bool, complete:bool, truncated:bool}`.

* Manifest tier 1 (source tree): path, type, size, mode, uid/gid, nlink, ino, mtime_ns, ctime_ns, symlink target; content sha256 computed **only for
  regular files whose (size, mtime, ctime, ino) changed** and ≤ cap. Tier 2 (existing `ignored_dirs`: `node_modules target dist build vendor
  .venv …`): top-level stat and bounded counts, reported as "changed, not enumerated". Rationale: E7 (3.3 s for 71 k files; 437 k including bulk dirs).
* `complete=false` whenever a cap, a permission error, or a vanished file occurred. A `verified-*` state can never be reported over an incomplete
  observation without saying so.
* A path both observed and in `Store.entries` (Nexus's own writes) is attributed to the journal, not the command.
* New states replace `verified-scratch` for in-place: `verified-passed` (exit 0, settled, complete) vs `verified-in-place-uncertain`
  (effects incomplete/unsettled).

### 9.3 Integration with Direct evidence

`Store` gets a second ledger `observed(path, pre_sha, post_sha, executionId)`; the diff is built from `entries ∪ observed` with pre-images from the
checkpoint for observed-only paths; `external_changes` treats `observed` post-states as Nexus-caused (otherwise the first `fs_write` after a
formatter run misreports every reformatted file as a user edit). User edits after the run end are still reported.

---

## 10. Threat model and residual risks

### 10.1 Assets and adversaries

Assets: host files outside the project (A1); secrets in the project (A2); project integrity and history (A3); the user's **future host-side
execution** of what the sandbox wrote (A4); network reachability (A5); Nexus state/Kernel/daemon (A6); data sent to the provider (A7).
Adversaries: prompt-injected model (T1); malicious dependency/postinstall scripts (T2); buggy/destructive toolchains (T3); the user's concurrent
edits (T4, accident); kernel/bwrap bug (T5); same-uid host process (out of scope, as in A3.3).

### 10.2 Matrix

| Threat | Control | Level |
|---|---|---|
| T1/T2 read host files | mount namespace has no `$HOME`/`/etc`/`/run`; symlinks outside do not resolve (E1b) | ENFORCED |
| T1/T2 write host files | root `--remount-ro`, only `/work/src`, `/work/env`, tmpfs writable; Landlock allowlist | ENFORCED (two layers) |
| T2 exfiltrate project secrets | R-NET (no network with full view); masks for existing secret-shaped entries; stdout redaction | ENFORCED for network; **name-based and partial** for secrets in arbitrarily named files (R2) |
| T1 reach host services via project-local Unix socket | mask existing sockets; netns isolates abstract sockets (E4) | ENFORCED for existing; residual for sockets created by host processes mid-run (R6) |
| T1 plant host-executed code (`.git/hooks`, `.git/config` aliases/fsmonitor/sshCommand) | ro mounts (E3/E5); `.git` ro by default | ENFORCED for `.git` internals |
| T1 plant host-executed code elsewhere (`package.json` scripts, `Makefile`, `.vscode/tasks.json`, `.envrc`, any source file, git-tracked build scripts) | **cannot be prevented**: it is the work product. Flagged protected-path touches, full diff, checkpoint | **R1 — accepted, same as any coding agent; review is the control** |
| T3 destroy repository (`rm -rf .git`, `git gc --prune`, `git clean -fdx`, `git reset --hard`) | `.git` ro by default (E3); opt-in rw is an owner decision; working-tree loss mitigated by checkpoint | ENFORCED (ro default); BEST-EFFORT (tree) |
| T3/T1 symlink planted that is live only on the host | report `symlinksCreated.escapesRoot`; Nexus's own readers use `O_NOFOLLOW` | DETECTED |
| Pre-existing hard link to outside file | cannot be distinguished (documented); report `nlink>1` | R3 — accepted, residual stated in `workspace.rs:22` |
| Nested mounts under the project | refuse | ENFORCED [unproven; T7] |
| Fork bomb/memory/CPU/output | unchanged cgroup + rlimits + caps | ENFORCED (kernel scope) |
| Model raises its own privilege | §7.4 | ENFORCED |
| Fallback to host exec when the sandbox fails | no code path; refusal text offers the user a mode choice | ENFORCED |
| T4 concurrent user edit overwritten by a command | none during the run | **R4 — NONE** |
| Crash mid-command | cgroup killed; effects uncertain; no auto rollback | R5 |
| T5 bwrap/kernel/seccomp bypass | deny-list seccomp (allows newly added syscalls by default), userns kernel surface, Landlock second layer | **R7 — residual; larger blast radius than today because the real project is now writable** |
| A7 data egress via stdout | redaction (`redact.rs`), heuristic | R8 |

### 10.3 Git handling

* Default: `.git` visible **read-only**; `git status/diff/log` work and `add/commit` fail cleanly with `EROFS` (E5b, measured; `show`/`blame` not run); the binary is
  provided read-only from the host `/usr`. No credentials, no `~/.gitconfig`, no network ⇒ `push/fetch/clone` cannot succeed.
* Opt-in `git-write` per project (D6): `.git` rw except `hooks` and `config` (E5: `commit` works; `config` writes fail `EBUSY` and should be translated).
  `git` is added to the workbench program list **only** in this mode.
* Argv-level git policy (blocking `reset --hard`, `clean`) is **not** relied on (`sh -c` bypasses it). The protections are: ro `.git`, checkpoint of the working
  tree, evidence.
* Nexus's own promise "never commits, pushes, merges" becomes: Nexus-the-product does not; a *command* may commit locally only when `git-write` is on; nothing can push.

### 10.4 Long-running processes

The `service` class (S7): separate Kernel scope kind with TTL, an explicit stop verb, at most N per task, output ring buffer, same sandbox and masks,
killed on task end/revocation/daemon restart (reconcile). Dev servers also write (HMR caches); with an `fs_write` in flight their writes are
observed, not attributed (R4-like). Host-browser reachability requires the forwarder decision (§5.2). Until S7, long-lived processes are bounded by
the existing wall clock (`BUILD_WALL_MS` 15 min).

---

## 11. Migration strategy (preserving Isolated)

1. Isolated + `scratch` stays byte-identical: same `sandboxDigest`, same staging, same `writeBack: none` semantics (now *computed* from class `Scratch`).
   A regression test pins the digest (T18).
2. New class is introduced behind `execAccess` default `scratch`; nothing changes for any existing project or run until a user moves a project.
3. **S1 enables `workspace` over the Isolated task clone first** (`worktrees/<task>`): daemon-owned, disposable, no external-modification or
   secret-in-folder concerns, patch/Apply flow unchanged. It exercises mount, masks, observation, journal and Kernel scope change with zero host risk
   and immediately fixes `mkdir`/`npm install`/formatters/generators in Isolated tasks.
4. Direct + `workspace` follows (S5) after the Direct-specific parts (observed ledger, attribution, resume, lease) are proven.
5. `Full` is last (S8), independent of 3–4.
6. Old journal rows, registries and consents remain valid. A consent given for the current text is **not** accepted for a `workspace`/`full` run
   (same mechanism as the direct-consent bump).

---

## 12. Required engineering stages

| Stage | Content | Exit criterion |
|---|---|---|
| **S0** | Decisions D1–D10; this ADR accepted; PoC harness from Appendix A promoted to `nexus-tools` offline tests | owner sign-off |
| **S1** | `ExecBackend`/`BackendCaps`/`ExecPlan` extracted from `sandbox.rs`/`process.rs` with **no behaviour change**; `Scratch` class only | T18 green (digest identical), full gate green |
| **S2** | Kernel scope v2 (`exec_class`, `view_digest`, `net_class`); daemon policy v2; derive literals; compat reading of v1 | T16 green; old rows load |
| **S3** | Mount construction: `PinnedRoot`, `--bind-fd`, nested-mount refusal, masks (existing-only), `.git` ro, Landlock shim, fd hygiene; `workspace` over the **Isolated clone** | T1–T8, T14 green on Linux with `NEXUS_REQUIRE_SANDBOX=1` |
| **S4** | Observation (tiered manifest), `settled`, effects schema, journal phases; checkpoint (reflink + bounded copy); guarded rollback | T9–T13 green |
| **S5** | Direct + `workspace`: `observed` ledger in `direct::Store`, attribution, `external_changes`, exec lease, resume, UI/CLI `execAccess`, consent text, guidance text | T12, T19 green; Desktop tests; Owner try-it |
| **S6** | Narrow-view `install` class replacing `harvest_node_modules` for in-place | T15 green |
| **S7** | `service` class + host reachability (forwarder PoC first) | separate ADR addendum |
| **S8** | `Full Access`: host backend, user-dialog grant, daemon flag, journal | T17 green; negative tests |
| **S9** | macOS Seatbelt backend / Windows decision | per-platform addendum with measured caps |

Each stage ends with the full battery (`NEXUS_REQUIRE_SANDBOX=1`), strict clippy, and the release gate with `--bodies`, as for A-series work.

---

## 13. Deterministic proof-of-concept test plan

All offline (real bwrap/cgroup/Kernel/daemon, mock model), assertion-driven, using the existing offline harness style
(`tools run-offline-process`, `crash-injection` points in `mutate.rs`).

| ID | Property | Method → assertion |
|---|---|---|
| T1 | Pinned identity | open fd; swap the path to another dir before spawn → sandbox identity == fd identity; rename during run (E1c) → writes land in the original; `--block-fd` holds execution until the check passes |
| T2 | Symlink escapes | rel/abs/host-live symlinks, racing swaps → nothing outside readable/writable; `escapesRoot` reported |
| T3 | Hard link residual | pre-existing hard link to outside file is readable (pins the known residual); evidence lists `nlink>1` |
| T4 | Secret masks | existing `.env*`, key files, `.ssh/` hidden; **absent names create nothing** (assert project tree unchanged after run — regression for E2) |
| T5 | Git | `.git` ro: status/diff/log work, writes `EROFS`; `git-write`: commit works, `fsck` clean, `hooks`/`config` ro; `config` error translated |
| T6 | Sockets | existing pathname socket masked (`ECONNREFUSED`); abstract socket from host unreachable; Landlock scope on ABI ≥ 6 |
| T7 | Nested mounts | mount a tmpfs under the project in a test mountns → `nested-mount` refusal |
| T8 | Fail closed | no bwrap / userns disabled / Landlock absent / no `--bind-fd` → refusal, **nothing ran**, no host exec, no class downgrade |
| T9 | Kill/revoke/cancel | cancel and Kernel revoke during a large write loop → cgroup empty, effects `partial`, lease released, no stray process |
| T10 | Daemon SIGKILL | mid-command kill -9 daemon → restart: cgroup killed, `interrupted` with observed diff vs pre-manifest, **no auto rollback** |
| T11 | Effects | create/modify/delete/chmod/symlink/special/rename-as-delete+create detected; bulk dirs summarized; `complete=false` on cap/permission errors |
| T12 | Attribution limit | concurrent `fs_write` subtracted via journal; simulated user edit in the window reported as "changed in window", `attribution:"temporal"` (asserts the *limit* is stated) |
| T13 | Checkpoint & rollback | reflink where supported (skip elsewhere), bounded-copy fallback, `none` flagged; guarded restore never overwrites a path whose content ≠ post-run |
| T14 | Resource limits | the A3.4 suite (fork bomb, memory, CPU, output flood, daemonized grandchildren) re-run against the in-place spec |
| T15 | R-NET | `install` class: no source/secret/`.git` visible with network up; policy test that `network≠none ∧ view=Full` is unconstructible |
| T16 | No escalation | `ProcessArgs` rejects extra fields; forged `operation.sandbox` ignored; sealed class mismatch refused; Kernel row tamper detected |
| T17 | Full Access | refused without user-dialog grant row and daemon flag; recorded argv/cwd/env digest; revocation kills; never selected on sandbox failure |
| T18 | Isolated regression | `scratch` `sandboxDigest` identical to baseline; `writeBack: none` computed; existing 1271-test battery unchanged |
| T19 | Resume/ledger | after an in-place formatter run, `external_changes` is empty; a later user edit is reported; diff includes observed-only files |
| T20 | fd hygiene | only 0/1/2 inside; project fd not inherited by the command |

---

## 14. Blockers, unresolved items, and owner decisions

### 14.1 Concrete blockers / unknowns (none prevent Linux feasibility; each gates a stage)

* **B1** Kernel scope schema bump (domain v2) and journal-phase additions touch the Kernel state machine — highest-risk code path; needs its own review (S2).
* **B2** seccomp is x86_64-only (`sandbox.rs:291,337`) → Linux/ARM unsupported.
* **B3** Nested-mount refusal, `--block-fd`, and `--bind-fd` recursion semantics are **unproven** (T1, T7).
* **B4** Host reachability of dev servers (no `pasta`/`slirp4netns` here; `nsenter` path unproven) (S7).
* **B5** Checkpoint is absent on non-reflink filesystems for large trees; bounded copy has caps → "rollback unavailable" must be an accepted state (D4).
* **B6** Attribution is temporal only (E8). Exact attribution requires Option D.
* **B7** macOS/Windows cannot be validated from this environment; caps tables above are knowledge, not measurements.
* **B8** The seccomp filter is a deny-list; writable real project raises the cost of a bypass (R7). An allow-list conversion is a large, separate effort.
* **B9** Consent/guidance/UX text and `execAccess` surfaces (CLI + Desktop) do not exist.

### 14.2 Owner decisions needed before implementation

| # | Decision | Recommendation |
|---|---|---|
| D1 | Default `execAccess` for **newly** authorized projects (existing stay `scratch`) | `scratch` until S5 proves out; then `workspace` for new Direct projects |
| D2 | Approve S1 first: in-place over the **Isolated clone** before any Direct change | Yes |
| D3 | Landlock mandatory for `workspace` class (refuse if kernel lacks it) | Yes (ABI ≥ 1 required, ABI ≥ 6 reported/preferred) |
| D4 | Is a run with **no checkpoint** (non-reflink FS, tree over caps) allowed? options: refuse / allow with prominent "no rollback" / require per-project opt-in | Allow, evidence-flagged, project opt-out `requireCheckpoint` |
| D5 | Full Access: per-project vs per-session consent; expiry; whether env passthrough exists | Per project, expiring (e.g., 7 days), minimal env allow-list, no passthrough |
| D6 | `.git` policy: read-only default; separate opt-in `git-write` | Yes; `git` program only under `git-write` |
| D7 | Should commands be allowed to modify `PROTECTED_NAMES` (lock files, `package.json`, `Makefile`…)? | Allowed under `workspace`, flagged; `install` class may rewrite lock files |
| D8 | Network classes beyond `none`/`install`: allow-listed egress for tests/APIs? | Not in v1; `install` narrow view only |
| D9 | Accept R1 (host-executed project content) and R4 (no protection against concurrent user edits during a command) as stated product limits | Accept, with the §6.3 text |
| D10 | Investment in Option D (FUSE) now, later, or never | Later, only if evidence shows gaps matter |
| D11 | Windows: ship Workspace Access never / after ACL-journaled design; macOS: accept downgraded caps explicitly | Windows: fail closed for now. macOS: decide after a measured Seatbelt PoC |
| D12 | Single-project exec lease semantics vs `service` processes writing while `fs_write` runs | Exclusive lease for commands; `service` exempt, observed-only |

---

## 15. Recommendation

Build **Confined In-Place (Option C)** for Linux, sequenced S1→S6, starting with the Isolated clone; ship **Full Access** (Option B) as a separate,
user-granted class; keep **scratch** as the default and as Isolated's behaviour. Do not market the result as equivalent to `fs_write`'s guarantees:
authority is per command and view, files are observed (not pre-authorized), rollback is best-effort from a checkpoint, and attribution is temporal.
Two rules are non-negotiable because the experiments showed concrete failure modes: **never combine the network with the full project view**, and
**mask only what exists** (a mask on an absent name writes into the user's project). The mechanism is smaller than the staging path it replaces; the work
is in the Kernel-sealed class, the observed ledger, and the product text. The earlier "do not recommend" conclusion rested on assumptions that §1.6 and §4
show are mostly preventable by mount-level controls; what it correctly identified — loss of per-file authorization and cheap rollback — remains true and
is stated, not engineered around.

---

## Appendix A — PoC harness (reproduces E1–E6)

```python
# run2.py <project> '<sh script>' [ro-subpaths,comma] [mask-names,comma]   (scratch use only)
import os,sys,subprocess
proj=sys.argv[1]; script=sys.argv[2]
ro=sys.argv[3].split(",") if len(sys.argv)>3 and sys.argv[3] else []
mask=sys.argv[4].split(",") if len(sys.argv)>4 and sys.argv[4] else []
pf=os.open(proj, os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC); fds=[pf]
argv=["/usr/bin/bwrap","--unshare-user","--unshare-pid","--unshare-ipc","--unshare-uts","--unshare-net",
 "--disable-userns","--die-with-parent","--new-session","--clearenv","--cap-drop","ALL",
 "--ro-bind","/usr","/usr","--symlink","usr/bin","/bin","--symlink","usr/lib","/lib","--symlink","usr/lib64","/lib64",
 "--proc","/proc","--dev","/dev","--tmpfs","/tmp","--bind-fd",str(pf),"/work/src"]
for r in ro:                      # descriptor-relative, no symlink following
    d=pf; parts=r.split("/")
    for p in parts[:-1]: d=os.open(p,os.O_PATH|os.O_NOFOLLOW|os.O_DIRECTORY|os.O_CLOEXEC,dir_fd=d)
    f=os.open(parts[-1],os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=d); fds.append(f)
    argv+=["--ro-bind-fd",str(f),"/work/src/"+r]
for m in mask: argv+=["--ro-bind","/dev/null","/work/src/"+m]   # NOTE E2: creates the file if absent
argv+=["--remount-ro","/","--chdir","/work/src","--setenv","PATH","/usr/bin","--","/bin/sh","-c",script]
print("exit",subprocess.run(argv,pass_fds=fds).returncode)
```

Landlock check (E6) ran this inside the sandbox: `landlock_create_ruleset(fs rights)`, `landlock_add_rule(READ|EXEC on /usr, READ on /work/src,
ALL on /tmp)`, `prctl(NO_NEW_PRIVS)`, `landlock_restrict_self`; then a write to `/work/src` → `EACCES`, `/tmp` → ok.

## Appendix B — Evidence not gathered

No macOS/Windows host; no ext4/xfs run; no ARM; no multi-UID deployment (A3.4 §Verdicts: still NOT RUN); no real-provider run. Everything marked
[unproven] is a design claim to be turned into a test (T1, T7, T-forwarder) before the dependent stage starts.

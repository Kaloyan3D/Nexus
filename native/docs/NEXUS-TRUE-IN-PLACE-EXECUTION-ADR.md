# ADR: True in-place process execution for Nexus Native

Status: **PROPOSED — REVISION 2 (network and Full Access parity). Research and architecture only; no source was changed.** Branch `feature/rust-native-core`.
Revision 1 = commit `34fd64d`. Revision 2 withdraws revision 1's universal rule "no network with the full project view" in favour of an explicit, user-granted network axis (§0, §7, §7A), adds the Claude Code / OpenCode comparison (§7B), a capability matrix (§8.5), and re-plans the stages (§12).
Supersedes the *recommendation* (not the facts) of `NEXUS-DIRECT-PROCESS-EXECUTION-ASSESSMENT.md` ("Stage 2: adopt effects"). The owner has
rejected scratch-copy + effect adoption as the Direct Workspace target; this ADR decides what replaces it.

Evidence labels used throughout: **[code]** read in this repository (path:line), **[measured]** run on this host in a disposable directory
(§4), **[doc]** taken from a prior Nexus document without re-running, **[knowledge]** platform knowledge not tested here, **[unproven]** a design
claim no experiment has yet confirmed.

Host of all measurements: Linux 6.18.55-1-cachyos-lts, x86_64, bubblewrap 0.13.0, Landlock ABI 7, `/home` and projects on btrfs, systemd user
manager running, `/dev/fuse` + `fusermount3` present, cgroup v2. (`A3.4-EVIDENCE.md` was produced on another host; do not read its kernel numbers as this host's.)

---

## 0. Decision summary (revision 2)

Revision 2 changes the network position. Revision 1 forbade any network while the full project view was visible; the owner's goal is practical
Claude Code / OpenCode parity, where network access is routine (package managers, API integration tests, git over HTTPS, web docs). That rule is
withdrawn as a *universal* policy and replaced by an explicit, user-granted, auditable network scope (§7A) with an honest exfiltration statement.

1. **Three independent dimensions, all Kernel-sealed per execution** (§7.1): **filesystem scope** (Scratch | Workspace | Full), **network scope**
   (Offline | Controlled Internet | Full Network), **approval behaviour** (Ask | Auto). They are granted together by one user-created *standing grant*
   per project; the model can neither create nor widen it.
2. **Trusted Workspace = Workspace + Controlled Internet + Auto** is the parity target: true in-place execution (Option C, hardened), project
   source visible, internet through a host-side **egress proxy** with domain/address policy, explicit localhost-port permissions and explicit TCP
   bridges for non-HTTP protocols, no per-command prompts for anything inside the grant.
3. **A domain allowlist does not prevent exfiltration** of readable project source (§7A.3). It bounds *where* data can go, makes it observable (bytes
   per destination in evidence), and removes the credential and anonymous-write cases that matter most. The ADR says so in product text.
4. **Full Access** (§7.4) is a separate, user-authorized host backend: host filesystem and host network under the user's OS permissions, real cwd,
   no per-tool prompts, with audit, cancellation and resource supervision. It is **never** selected after a sandbox failure (§7.5).
5. Unchanged from revision 1: Option C for Workspace scope; Isolated Workspace untouched; first implementation over the Isolated clone; honest
   guarantees (§6) — per-file authorization and crash-atomic rollback are not claimed for arbitrary commands.
6. **Minimal change to the Kernel authority chain** (§8.3): one scope-schema bump (filesystem, network, approval, grant digest), one new
   unprivileged process (`nexus-egress`) whose policy is the sealed digest, one registry record (standing grant), and a policy-v2 rule
   "requested ⊆ granted". No change to the model-facing tool schema.

Owner decisions required before implementation: §14.2.

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

It is **missed** that in-place changes the *network* story: today installs run on a filtered copy with no secrets and no `.git`; in-place with the
network on puts every readable project file next to an egress path. Revision 1 answered with a blanket prohibition; revision 2 treats it as an
explicit, sealed grant with a stated exfiltration residual (§7A.3). It also missed pathname Unix sockets (E4), which the stager had silently excluded.

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
│ (user dialog)│ mode+     │ claim lease│              │ scopes: fs,net,appr)  │  │  │ {program,args,cwd} ONLY)    │
└──────┬───────┘ consent   └─────┬──────┘              └────────────┬─────────────┘  │  └──────────────┬──────────────┘
       │ registry (workspaceMode, grant)                            │ grant          │                 │ tool call
       ▼                         ▼                                  ▼                │                 ▼
┌──────────────┐          ┌─────────────────────────────────────────────────────┐    │  (no field can select class,
│ Project      │ fd+ident │ Daemon: derive grant from task identity record; │    │   mount, net, or path outside
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

Network path (rev. 2): a second trusted, unprivileged process (`nexus-egress`) sits outside the sandbox and is the only exit for Controlled Internet; see the diagram in §7A.2.

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
| E10 | **Egress proxy over a Unix socket** (rev. 2). Sandbox: `--unshare-net`, a host-side CONNECT proxy (≈60 lines Python, name allowlist + post-resolution address-class check, connects to the checked IP) bound in as a socket file, a `socat` bridge to `127.0.0.1:3128`, `HTTPS_PROXY` set. Host had real internet. | **P1** direct connect without proxy: `000`, "no route". Via proxy to allowed `example.com`: **200**. **P2** `github.com` (not allowed): refused. **P2b/c** `169.254.169.254` and `10.0.0.1`: refused. **P3** explicitly allowed host loopback port: served; **P3b** another host loopback port (`:22`): refused. **P4** the project file `source.txt` was POSTed through the *allowed* destination and delivered (server replied 501 only because the toy server cannot POST). **P5** raw TCP / `/dev/tcp/1.1.1.1` ignoring the proxy: `Network is unreachable`; no resolver inside. Proxy decision log matched all of it. | The mechanism works and fails closed for proxy-ignoring tools. **It does not stop exfiltration to an allowed destination** (P4) — §7A.3. The sandbox needs no `resolv.conf`: resolution is the proxy's. |
| E11 | Host → sandbox-only dev server | Server on `127.0.0.1:3000` inside the sandbox's netns: host `curl` to its own loopback `:3000` → `000`; `nsenter -t <bwrap-child> -U -n curl 127.0.0.1:3000` → **200**. | Resolves blocker B4: a forwarder helper that enters the user+net namespaces is feasible without root, `pasta` or shared netns. |
| E12 | Shared host netns vs host **abstract** Unix socket; Landlock scope | Shared netns: sandbox connected and received data from a host abstract socket. Shared netns + `LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET` (ABI 7 here): `EPERM`. Private netns: `ECONNREFUSED`. | Full Network under Workspace scope is only acceptable with the Landlock scope (ABI ≥ 6); host loopback TCP stays reachable by construction. |

**Not tested (and why it is listed as an engineering stage, not assumed):** nested mounts below the project root (needs a privileged-looking setup —
test via a userns mount in the harness), `--block-fd`/`--userns-block-fd` pre-exec verification, a Rust forwarder/bridge/egress service (E10–E12
used Python/`socat`/`nsenter` stand-ins), TLS SNI peeking, tool-by-tool proxy compatibility (npm, pip, cargo, go, git, Node `fetch`, JVM, .NET),
ext4/xfs/tmpfs fallback paths, file capabilities/xattrs, macOS and Windows (no such host here), cgroup interplay with a bound real directory
(unchanged code path), aarch64 (seccomp program is x86_64 only, `sandbox.rs:291,337`).

**Feasibility verdict (Linux True In-Place): FEASIBLE — GO**, conditional on: (a) `bwrap ≥ 0.13` (for `--bind-fd/--ro-bind-fd`; verify at preflight),
(b) unprivileged user namespaces, (c) Landlock ABI ≥ 1 present or the mode refuses, (d) x86_64 until the seccomp program is ported,
(e) the guarantees in §6 being accepted as stated, (f) for Controlled Internet, the exfiltration statement in §7A.3 being accepted. The mechanism is *simpler* than today's (no staging copy); the difficulty is entirely in
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

### 5.2 Caches, dependencies, and the sandbox side of networking

* **Offline** (default for new grants): private network namespace with its own `lo`; servers started and tested *within one command* work.
* **Controlled / Full Network** plumbing is specified in §7A; this subsection only fixes the mount-side facts that do not depend on policy:
  per-project writable caches stay in the env store (`/work/env`: npm/pip/cargo/go/nuget caches, `CARGO_TARGET_DIR`), so builds do not litter the
  project unless the project itself directs output there. Dependency directories that tools write *inside* the project (`node_modules`, `.venv`)
  are real project changes (that is what in-place means) and are summarized, not enumerated, in evidence (§9).
* **Optional hardening profile "isolated install"** (off by default; owner decision D17): dependency installation runs with a *narrow view*
  (`/work/src` is a tmpfs onto which only manifests, lock files and the dependency directory are bound descriptor-relatively) so postinstall scripts
  never see sources while online. It is a project-level hardening choice, not a prerequisite for network access. `.npmrc`/`.pypirc` are `Sensitive`
  and not mapped in this profile (private registries then fail — stated). It supersedes `harvest_node_modules` only when enabled.

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

## 7. Permission architecture (revision 2: three dimensions)

### 7.1 The dimensions

```
 Workspace (where Nexus's EDITS go):      Isolated copy | Direct (real folder)        — registry workspaceMode, unchanged
 Execution grant (what a COMMAND may do), three independent axes, sealed together:
   Filesystem scope   Scratch*  | Workspace | Full
   Network scope      Offline   | Controlled Internet | Full Network
   Approval behaviour Ask       | Auto
   (* Scratch = today's throw-away-copy behaviour; legacy default for every existing project, Isolated only after S3)
```

| Axis | Value | Meaning |
|---|---|---|
| Filesystem | **Scratch** | Today: staged filtered copy, effects discarded. |
| | **Workspace** | Real project (or, for Isolated tasks, the task clone) bound read-write into the sandbox; host filesystem otherwise invisible (§5). |
| | **Full** | Host backend (§7.4): the user's filesystem under their OS permissions. No path confinement. |
| Network | **Offline** | Private netns, loopback only. |
| | **Controlled Internet** | Private netns; the only exits are the host-side egress proxy (domain/address/port policy, §7A) and explicit TCP bridges. Includes localhost-port permissions. A policy of `*` means "any *public* address", still behind the address-class and port rules. |
| | **Full Network** | The host network namespace. Everything the user's machine can reach, including host loopback services, LAN, UDP, raw protocols. Under Workspace scope this is allowed only with the Landlock abstract-socket scope (§7A.5). |
| Approval | **Auto** | A command is run without a human decision iff it falls inside the standing grant. Anything outside is **refused**, not escalated by the model. |
| | **Ask** | Every command (or every command outside a user-chosen "always-allowed" subset) needs the existing single-use human approval (`consume_approval`, A4.2). |

Valid combinations (backend capability permitting): filesystem × network is a full matrix for `Scratch`/`Workspace`; `Full` implies `Full Network`
in v1 (a host process is not network-confined; confining only the network of a host process is possible later — Claude Code offers it —
but is not needed for parity and would add a backend). `Full` + Isolated workspace is refused (Isolated promises containment).
`Scratch` supports `Offline` and the existing `install` network only.

### 7.2 Standing grant (the user's authorization)

One durable record per project, created and changed only through user-gated broker verbs (Desktop native dialog; CLI `nexus project grant …`),
never writable by the model, a task, or a renderer claim:

```
StandingGrant { project, fs_scope, net_scope, approval,
  net_policy { allow:[{host|*.suffix|*, ports?}], deny:[…], local_ports:[port…], bridges:[{listen_port, host, port}],
               max_egress_bytes_per_exec, sni_check:bool, ipv6:bool },
  git_write:bool, install_isolation:bool, expires_at?, text_sha256 (consent text shown), granted_by:"user-dialog", created_at }
grant_digest = sha256(canonical_json(StandingGrant minus timestamps))
```

* The digest is sealed in every execution's Kernel process scope (§8.3). The daemon derives the execution's effective scopes from the registry,
  writes them into the task identity record at task open (like `kind: direct`), and refuses a task whose grant changed mid-task (new tasks only).
* Defaults: new project = `Scratch + Offline + Auto` (today). A "Trusted Workspace" preset = `Workspace + Controlled(preset registries + git host
  over HTTPS, `*`-free) + Auto`; the dialog states the exfiltration consequence (§7A.3) in plain words and records the text digest, as provider
  consent does (`consent.rs`).
* Approval behaviour today is a *daemon-wide* switch and the two modes are mutually exclusive (`nexus-daemon/src/main.rs:695-717`: the autonomous
  policy "cannot be combined with human approval"). The `approval` axis requires the daemon to support both concurrently and pick per task from the
  identity record. That is an authority-chain change (B1) and is called out in §8.3.

### 7.3 Workspace scope under Auto

* Policy `autonomous-workspace/v2` approves `proc.run` iff **requested ⊆ granted**: the sealed filesystem and network scopes equal the
  daemon-derived ones for this task, the egress policy digest equals the grant's, the mount spec digest equals the prepared plan's, the project is
  claimed by this task, budgets remain, and the backend's capabilities ⊇ required. It never reads a caller-supplied description string (§1.1 finding 1).
* No per-tool prompts. A command that needs more than the grant (an unlisted host, a non-granted port) **fails closed at the enforcement point**
  (proxy 403, no route) and produces a structured *scope request* the user can approve (§7A.4). The model cannot approve it.
* Dependency installation: covered by the network grant; the former per-project `installs` switch becomes a convenience preset of it.
* Git: §10.3. Credentials: nothing is mapped (no `$HOME`, no agent, no credential helper); `HOME=/work/out/home`.

### 7.4 Full Access (explicitly owner-authorized)

What it is: the `host` backend. Commands run as the user, on the real filesystem, with the real network, real cwd, and persistent process effects,
for broad CLI compatibility (docker, ssh with the user's agent, browsers, GUI tools, system package managers the user can run).

What the owner gets, per the requirement:

| Requirement | Design |
|---|---|
| Host filesystem under OS permissions | no mount namespace, no Landlock, no seccomp filter (a filter would break the compatibility that is the point) |
| Host network | no netns, no proxy |
| Real cwd, persistent effects | `cwd` = project (or a path under it); background children may outlive the call only if the `service` class is granted (S7); otherwise the cgroup is killed at exit like today |
| No per-tool prompts | `approval = Auto` within the grant; the grant is the authorization |
| Audit | Kernel `prepared` row: exact argv, cwd, env digest, grant digest, backend id; `exited` row: exit, signal, resource use, output digest; pre/post manifest of the **project** directory (best-effort); **no** evidence is collected outside the project |
| Cancellation & resource supervision | the existing transient systemd user scope (`MemoryMax/MemorySwapMax/TasksMax`) wraps the host command; `cgroup.kill` on cancel/revoke/daemon crash; wall clock; output caps and redaction; `PR_SET_PDEATHSIG`; `stdin=/dev/null`, no TTY. `no_new_privs` stays on by default (blocks setuid escalation such as `sudo`; D18) |
| Environment | allow-list by default (`PATH`, `LANG`, …); credential-bearing variables (`SSH_AUTH_SOCK`, `AWS_*`, `GITHUB_TOKEN`, …) are **not** inherited unless the grant lists them by name (D5) |

Authorization: a user-native grant (Desktop dialog / CLI with explicit confirmation text) naming the project and stating the consequences ("commands
run as you: they can read your keys, change any file you can, and use your network; Nexus's protections for this project do not apply"). Recorded
`approver_id = user-dialog`, `independent = true`, revocable, with an expiry (D5). The daemon needs a separate start flag (`--enable-host-exec`,
not implied by `--enable-process`).

Stated residuals: stdout reaches the model provider (redaction is heuristic); anything the user can do, the command can do; no rollback outside the
project; platform limits in §8.4.

### 7.5 No model-controlled escalation and no automatic Full Access — enforcement points

1. Schema: `ProcessArgs` has no field for any axis; `deny_unknown_fields` (T16).
2. All axes and the grant digest live in the Kernel HMAC-sealed process scope; `prepare_process` compares them with the daemon-derived values.
3. The approval operation description is *derived from the sealed values and the prepared plan*; the policy trusts no free-form JSON.
4. **Claude Code's escape hatch is deliberately not copied.** There, a sandboxed command that fails can be retried by the model with
   `dangerouslyDisableSandbox: true` (approved, per mode, by the user, a classifier, or nobody under `bypassPermissions`) and `excludedCommands`
   run fully unsandboxed [doc, §7B]. Nexus has neither: a model cannot ask for an unsandboxed retry; non-HTTP needs are met by explicit bridges
   (§7A.6) or by the user's own change of grant.
5. **Full Access is never selected as a consequence of a failure.** `ExecBackend::prepare` returning `BackendInsufficient`/any sandbox error
   terminates the call with a refusal; the code path from the Linux backend to the `host` backend does not exist; the `host` backend is reachable
   only when the sealed filesystem scope is `Full`, which only a user-dialog grant can mint. T17 kills `bwrap` and asserts nothing ran on the host.
6. A grant changes only through the user-gated verb and only affects *new* tasks; resume with a different grant is refused
   (`workspace-mode-changed` pattern, `broker/server.rs:631`).

## 7A. Network architecture

### 7A.1 Options considered for Controlled Internet

| Option | Domain policy | Non-HTTP | Fail mode | Complexity | Verdict |
|---|---|---|---|---|---|
| (i) Shared host netns + Landlock TCP port rules | **no** (ports only; Landlock net ABI ≥ 4) | yes | open to whole internet and host loopback | low | Only as hardening for *Full Network* (§7A.5) |
| (ii) Userspace netstack (pasta/slirp) + IP firewall | IP only; domain→IP drift, CDN churn | yes (TCP/UDP) | needs `pasta`, not installed here | medium, external dependency | Possible later for transparent mode; no domain policy |
| (iii) **Private netns + host-side HTTP(S) CONNECT proxy reached over a Unix socket** (measured, E10) | **yes**, name checked before resolution, address class checked after | only CONNECT-able TCP to `host:port`; rest via bridges | **closed**: tools that ignore the proxy get `Network is unreachable` (E10-P5) | medium (one small service) | **Chosen** |
| (iv) (iii) + TLS termination with a Nexus CA | adds method/path/host-header policy and credential injection | no | CA in the sandbox trust store; breaks pinning; key custody | high | Deferred (S10); not needed for parity |

This is the same shape Claude Code uses (proxy outside the sandbox, `HTTP(S)_PROXY`/`ALL_PROXY` inside, bwrap + `socat` over Unix sockets on
Linux, Seatbelt on macOS) [doc, §7B]; the differences are in who can widen it and what is audited.

### 7A.2 Components

```
 sandbox (private netns, lo only)                          host (daemon identity, outside the sandbox)
┌───────────────────────────────────┐   unix socket    ┌─────────────────────────────────────────────┐
│ command ──HTTP(S)_PROXY──► 127.0.0.1:3128 (bridge) ───►│ nexus-egress (separate process, same uid)   │
│ command ──TCP bridge ports──► 127.0.0.1:<p> (bridge)  ─►│  1 policy := sealed grant.net_policy        │
│ (in-sandbox servers stay on 127.0.0.1, direct)          │  2 name check (allow/deny, wildcard rules)  │
│ host.nexus.internal → host loopback ports (allowed only)│  3 resolve ONCE; address-class check on the │
└───────────────────────────────────┘                    │    resolved IP; connect to THAT IP          │
   no resolver, no route, no raw sockets out             │  4 per-exec accounting + log (bytes, hosts) │
                                                         └───────────────┬─────────────────────────────┘
                                                                         ▼ internet / explicit local ports
```

* **`nexus-egress`** is an unprivileged helper (not inside `nexusd`, to keep network parsing out of the Kernel-adjacent TCB). It is started by the
  daemon with a per-execution socket in the private run dir and the policy bytes whose digest equals the grant's; it refuses to start on a mismatch.
  It has no access to the Kernel store, no secrets, and only egress. One socket per execution gives exact attribution in its log.
* **In-sandbox bridge**: a small listener in `nexus-sandbox-init` (the Landlock shim from §5.1; `socat` was used in the PoC) listens on
  `127.0.0.1:3128` and relays to the bound Unix socket. Environment: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY=localhost,127.0.0.1,::1`
  (so a server the command starts itself is reached directly, inside the sandbox). No DNS resolver is provided: name resolution happens only in the
  proxy, only for names that passed the name check.
* **Host services** are not `127.0.0.1` (that is the sandbox's own loopback). They are addressed as `host.nexus.internal:<port>` (an `/etc/hosts`
  entry the sandbox gets), and reach the host's loopback **only** for ports listed in `local_ports`. This removes the ambiguity that the PoC had.
* **Counters and evidence**: per execution `{host, port, connections, bytesOut, bytesIn, denies[reason]}`; aggregated into the `exited` record
  (digest in the Kernel journal, full log in a daemon-private audit file). Optional hard cap `max_egress_bytes_per_exec`.

### 7A.3 Threat model: what the proxy does and does not stop

**The root statement.** A command that can read project source and has *any* outbound path can send that source to *any destination that path
reaches*. Controlled Internet narrows the set of destinations; it does not make the sandbox a data-loss-prevention system. This must be in the grant
dialog text (D13) and the product documentation. Claude Code's documentation makes the same admission about broad allowlists and domain fronting [doc, §7B].

| Attack / concern | Controlled Internet behaviour | Level |
|---|---|---|
| Send source/secrets to an arbitrary attacker host | refused: name not in allowlist (E10-P2: `github.com` denied) | ENFORCED |
| Reach cloud metadata, LAN, host loopback via proxy | refused by the post-resolution address-class check even if the *name* is allowed (E10-P2b/P2c); host loopback only for `local_ports` (E10-P3b) | ENFORCED |
| DNS rebinding / TOCTOU between check and connect | the proxy resolves once and connects to the **checked IP** (E10 implementation) | ENFORCED |
| DNS-tunnel exfiltration | the sandbox has no resolver and no route; queries exist only for allowed names inside the proxy | ENFORCED for the sandbox; but a label sent to an allowed name whose authoritative DNS the attacker controls (wildcards on attacker-registrable domains) is a channel |
| Exfiltration to an **allowed** destination that accepts anonymous or attacker-controlled writes | **not prevented.** E10-P4: a project file was POSTed through an allowed destination. Typical offenders: wildcard storage/CDN/hosting domains (`*.amazonaws.com`, `*.github.io`, `*.cloudfront.net`), paste/transfer services, any API that accepts unauthenticated uploads, an attacker-registered package scope on a registry | **NOT STOPPED — residual R9** |
| Same via an allowed destination that needs credentials | the sandbox has no credentials (no `$HOME`, no agent, env allow-list, secret-shaped files masked), so authenticated writes (git push, npm publish, cloud APIs) fail | ENFORCED as long as secrets are not placed in readable, arbitrarily-named project files (R2) |
| Domain fronting (CONNECT allowed host, inner Host/SNI different) | v1 checks SNI against the CONNECT host by peeking the ClientHello (no interception). A front that is genuinely served by the allowed CDN and routes on the inner Host header is **not** visible without TLS termination | PARTIAL; full defence needs (iv) |
| Bulk exfiltration | per-exec `bytesOut` accounting and cap; large uploads show in evidence | DETECTED / bounded |
| Small secrets (keys, tokens) | a few hundred bytes are under any sane cap | **NOT STOPPED** |
| Prompt-injected model plans the exfiltration | policy cannot read intent; the defence is the destination set, credentials absence, and review of evidence | R9 |
| Tool that ignores proxy variables | no route → fails, never bypasses | ENFORCED (E10-P5) |
| Allowlist widening by the model | impossible: grant is user-only (§7.5); a denied connection yields a scope request for the user | ENFORCED |

**Allowlist hygiene rules (policy, enforced by the grant editor):** exact hostnames preferred; wildcard suffixes only for names the project owner
controls or that are not attacker-registrable; `*` is allowed but shown with a warning ("any public address") and is the *Full-Internet* preset;
presets ship as **exact** hosts: npm (`registry.npmjs.org`), PyPI (`pypi.org`, `files.pythonhosted.org`), crates (`index.crates.io`, `static.crates.io`,
`crates.io`), Go (`proxy.golang.org`, `sum.golang.org`), NuGet (`api.nuget.org`), git over HTTPS to hosts the owner names.

**Network-enabled and source-visible, in one sentence for the owner:** the project's source can leave through whatever you allow; Nexus makes that
visible and bounded but cannot make it impossible.

### 7A.4 Prompt-free operation, and what happens beyond the grant

* Inside the grant: no prompt, ever (the Claude Code "sandbox substitutes for the per-command prompt" principle, `autoAllowBashIfSandboxed`).
* Beyond the grant: the connection is refused at the proxy and logged as `pendingEgress{host, port, executionId}`. The broker surfaces it as a user
  card ("api.stripe.com:443 was blocked for this command — Allow for this project / this task / never"). Only the user's choice edits the grant.
  With `approval = Ask` the proxy may **hold** the connection up to a short timeout while the card is shown (Claude Code's first-connection prompt);
  with `Auto` it denies immediately so a command cannot hang on a prompt nobody is watching.
* Persisting "allow for this project" creates a new grant version (new digest) effective for new tasks; "allow for this task" needs a Kernel-visible
  amendment bound to the task identity (design item for S5, B10).

### 7A.5 Localhost, dev servers, browser tests

| Need | Mechanism | Evidence |
|---|---|---|
| Server and client in one command (`npm test` that boots a server; Playwright against its own server) | private loopback inside the sandbox, direct (`NO_PROXY`) | works today |
| Command → a service on the **host** (local database, API mock, a host dev server) | `local_ports` + `host.nexus.internal:<port>` through the proxy; any other host port refused (E10-P3/P3b) | measured |
| **Host** browser/tool → a dev server started in the sandbox | forwarder: host listens on `127.0.0.1:P`, hands each connection to a helper that `setns`es into the execution's user+net namespaces and connects to `127.0.0.1:<port>` (`nsenter -t <pid> -U -n` reached a sandbox-only server with HTTP 200 while the host's own loopback did not, E11) | measured with `nsenter`; Rust helper to be built (S7) |
| Command A starts a server, **later** command B (a different execution) talks to it | impossible with one netns per execution. Needs a **task sandbox**: one long-lived sandbox per task (its init process spawns each command with its own cgroup sub-scope, Landlock domain and journal row). Larger change to lifecycle/recovery; separate ADR addendum | design only |
| Headless browser inside the sandbox | works if the browser is launched with its internal sandbox off (`--no-sandbox`), because user namespaces are disabled inside ours (`--disable-userns`); Nexus's sandbox is the boundary [knowledge, compat test T15g] | to test |

**Full Network under Workspace scope (shared host netns).** Measured (E12): in a shared netns the sandbox connected to a *host abstract Unix
socket* (the class X11 and some D-Bus/desktop services use) and got data; with a Landlock scope rule (ABI ≥ 6, `LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET`)
the same connect fails with `EPERM`; in a private netns it fails with `ECONNREFUSED`. Host loopback TCP services (databases, Docker's TCP port if
enabled, Nexus-unrelated daemons), the LAN and cloud metadata are reachable by construction. Therefore: `Full Network` + `Workspace` requires
(a) a user-dialog grant naming these consequences, (b) Landlock ABI ≥ 6 (else refuse), (c) optionally Landlock TCP port rules (ABI ≥ 4) to cut
inbound/lateral ports, and is documented as *not* protecting host services. It exists for UDP, mDNS, raw/LAN development and tools that cannot be
made proxy-aware; everything else belongs to Controlled.

### 7A.6 Non-HTTP protocols (explicit, not excluded)

Tools that cannot use an HTTP proxy get **no route** (E10-P5) — the correct fail-closed behaviour — and the user has three explicit choices:

1. **CONNECT-capable clients** (ssh via `ProxyCommand`, git over HTTPS, most package managers, curl, Go, cargo, pip): work through the proxy;
   `host:port` allow entries cover arbitrary TCP ports for them.
2. **TCP bridges** (`bridges: [{listen_port: 5432, host: db.dev.example.com, port: 5432}]`): the in-sandbox bridge listens on that loopback port and
   the proxy connects to the one allowed `host:port`. `psql -h 127.0.0.1` works; policy and accounting are identical to HTTP; nothing else opens.
3. **Full Network** (UDP, ICMP, mDNS, arbitrary protocols) or **Full Access**, by an explicit grant.

Claude Code's answer for these is `excludedCommands` (run **unsandboxed with full access**) [doc, §7B]; Nexus does not have that: it would be a
per-command escape to Full Access chosen by configuration text rather than by an explicit scope.

*Tool compatibility is a test matrix, not an assumption (T15g):* env-proxy support differs per tool (Node's built-in `fetch` needs
`NODE_USE_ENV_PROXY`/`--use-env-proxy` on recent Node versions, the JVM needs `-Dhttps.proxyHost`, Go/Python/cargo/pip/npm/git/curl honour the
variables) [knowledge — verify per tool]. The harness sets the variables and per-tool options (`GIT_SSH_COMMAND`, `JAVA_TOOL_OPTIONS`,
`NODE_OPTIONS`) from the resolved command class.

### 7A.7 Egress service implementation notes

CONNECT parser with strict limits (header size, line count, no pipelining); IPv4/IPv6 literal handling (literals are checked as addresses *and*
must satisfy the name rule: an IP literal is allowed only by an explicit entry); IPv4-mapped IPv6, `0.0.0.0`, link-local, ULA, CGNAT and multicast
classes denied unless a `local_ports` entry; concurrency, byte and wall caps per execution; no redirect logic (clients do that); plain HTTP
(non-CONNECT) requests are not proxied (the PoC returns 405) — clients are pointed at CONNECT-only operation via `https_proxy`/`http_proxy`, with
`curl -p`-style tunnelling for plain `http://` where a tool requires it (compat item).

## 7B. Reference products (fetched 2026-10-24; paraphrased)

| Aspect | Claude Code (sandboxing + permissions docs) | OpenCode (permissions docs) | Nexus (this ADR) |
|---|---|---|---|
| Layers | Permission rules (allow/ask/deny, modes) and an **OS sandbox** are "complementary"; sandbox enforcement holds "even if a prompt injection bypasses" the model's decision | permission gates only: `allow`/`ask`/`deny` per tool (`bash`, `edit`, `webfetch`, `external_directory`, …); most default to **allow**; **no OS sandbox or network isolation is documented** | permission *grant* sealed in the Kernel + OS enforcement; model has no input into either |
| Filesystem isolation | bwrap (Linux/WSL2), Seatbelt (macOS); default write = working dir + `$TMPDIR`; **read = whole machine** except denied paths; `.git`/`.claude` protected | none documented | Workspace: project + env store only; **host not visible** (stricter than Claude Code's read-everything default) |
| Network isolation | independent layer, **always on** with the sandbox; netns with no route (Linux); all traffic through a proxy outside the sandbox; `allowedDomains` empty by default; unlisted host → prompt; `127.0.0.1:port` entries for localhost; macOS blocks non-proxy connections | none | Offline / Controlled / Full as a first-class axis; proxy + bridges + `local_ports` |
| Non-HTTP | **`excludedCommands`: run unsandboxed with full access** | n/a | bridges, Full Network, or Full Access — explicit grants |
| Escape hatch | `dangerouslyDisableSandbox` retry, approved per mode (user prompt, classifier, nobody under `bypassPermissions`); `allowUnsandboxedCommands:false` disables it | n/a | none; failure ⇒ refusal ⇒ user changes the grant |
| Auto-approval | `autoAllowBashIfSandboxed` (sandboxed commands run without prompts; a few critical commands still prompt) | per-tool `allow` | `Auto` = requested ⊆ granted |
| "No checks" mode | `bypassPermissions`: skips prompts, **including writes to protected paths**; docs say use only in containers/VMs | `allow` everywhere | **Full Access**: user-dialog grant, host backend, supervision kept, no model-reachable path |
| Credentials | `sandbox.credentials` deny/mask; Linux can expose sentinel copies that the proxy substitutes (needs TLS termination) | `.env` requires approval by default | none mapped; masks; proxy-side injection is a possible S10 |
| Stated limits | domain fronting; broad allowlist = exfil path; writable `.git/hooks`/shell rc = escalation; Unix-socket allowances = escape; nested userns weakens protected paths | n/a | same classes, §7A.3 and §10 |

**Parity statement.** Against Claude Code, the target is: Workspace + Controlled Internet + Auto ≈ "sandbox enabled with auto-allow and a domain
allowlist", with a stronger filesystem default and without the unsandboxed retry; Full Access ≈ `bypassPermissions` plus, deliberately, the
supervision Claude Code does not provide for it. Against OpenCode, the target is Full Access (no OS isolation, gates only), with Nexus's journal.

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
    pub network: NetCaps,                   // Offline | Proxy{sni_check, bridges, host_alias} | HostShared{abstract_scope} | Host
    pub resources: Enforcement,             // KernelCgroup | RlimitPolling | JobObject | None
    pub kill_tree: KillGuarantee,           // Cgroup | ProcessGroupBestEffort | JobObject
    pub checkpoint: CheckpointKinds,        // Reflink | BoundedCopy
    pub arch: &'static [&'static str],
}

pub enum FsScope { Scratch, Workspace, Full }
pub enum NetScope { Offline, Controlled, FullNetwork }
pub enum Approval { Ask, Auto }
pub struct ExecGrant { pub fs: FsScope, pub net: NetScope, pub approval: Approval, pub grant_digest: String }

pub struct ExecPlan {
    pub id: ExecutionId,
    pub grant: ExecGrant,                   // sealed in the Kernel scope; backend re-checks
    pub command: ResolvedCommand,           // existing policy output
    pub root: PinnedRoot,                   // OwnedFd + {dev, ino, mnt_id, owner, canonical path (display only)}
    pub view: View,                         // Full | Narrow{ allow: Vec<RelPath> }
    pub protect: Vec<ProtectedPath>,        // {rel, Hide | ReadOnly}, only existing entries
    pub net: NetPolicy,                     // Offline | Proxy{allow,deny,local_ports,bridges,caps} | HostShared | Host (Host only with fs=Full)
    pub env_store: Option<PathBuf>,         // /work/env
    pub limits: SandboxLimits,
    pub checkpoint: CheckpointPolicy,       // Require | Prefer | Off (Off only if the owner allows)
    pub required: RequiredCaps,             // derived from grant+view+net; compared with BackendCaps
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
explicit choice (e.g. "Workspace scope is unavailable on this machine because X; Scratch is still available; Full Access is a separate
decision you can grant"). It never auto-selects either.

### 8.2 What is reused unchanged

`run_sandboxed` supervision loop, `bwrap_argv` skeleton, seccomp program, `prlimit`, systemd scope, output readers/redaction, `ProcessHooks` journal
phases, `observe_process_for_recovery`, `Workspace` descriptor-relative primitives, `direct::validate_root`, project claim (`direct_claims`),
`classify_name`, `PROTECTED_NAMES` (as flags), `protect::workbench_path_check` for fs tools.

### 8.3 What must change in the authority chain

1. `ProcessScopeBinding` + `process_scope_canonical` + `PROCESS_SCOPE_DOMAIN` (`nexus-kernel/src/tools.rs:87,202-230`): add the three axes (item 8), `view_digest`; domain `…/v2`. v1 rows read as `Scratch + Offline`, never as `Workspace`.
2. `bind_process_scope_inner` (`:1318`) takes them from the approver (the automated policy or the user-dialog).
3. `prepare_process` (`authorization.rs:104`) refuses if the sealed class ≠ the daemon-derived class.
4. `evaluate_autonomous_policy` → `autonomous-workspace/v2` (`server.rs:1288-1400`): replace the `writeBack == "none"` string test; operation description built from the prepared plan.
5. Remove the three `"writeBack": "none"` literals (`server.rs:1621`, `process.rs:1202`, `process.rs:1329`); compute from class.
6. New journal phases `checkpointed`, `observed` (`process.rs:32-36`, Kernel state machine `record_process_phase`); `interrupted` payload gains the observed diff.
7. `direct::Store` gains the `observed` ledger and attribution `command:<executionId>`; `diff` and `external_changes` (`direct.rs:457,501`) consume it (§9).
8. (rev. 2) The scope schema carries the three axes and the grant: `fs_scope`, `net_scope`, `approval`, `grant_digest`, `net_policy_digest` (instead of
   the narrower `net_class`). `process_scope_canonical` covers all of them; `prepare_process` compares each with the daemon-derived value.
9. (rev. 2) **Standing grant** record in `nexus-tools::registry` (`ProjectRecord.grant`, §7.2) with user-only setters; `project_set_grant` verb in the
   broker (peer-credential gated like `project_set_workspace`), CLI `nexus project grant`, Desktop dialog. Task identity record gets the effective axes.
10. (rev. 2) **Approval-mode coexistence**: lift the daemon-wide mutual exclusion (`nexus-daemon/src/main.rs:695-717`) so `Ask` and `Auto` tasks can
    run in one daemon; the mode comes from the identity record and is sealed. This is the riskiest change in the list (B1).
11. (rev. 2) **`nexus-egress`** (new binary/crate, no Kernel access): started per execution by the daemon with a policy whose digest must equal the
    sealed `net_policy_digest`; writes an audit file; the daemon folds a summary + digest of the audit file into the `exited` row (a connection is
    never a Kernel journal row — flood control).
12. (rev. 2) `pendingEgress` events: daemon → broker → Desktop/CLI card; verbs `egress_allow {project|task, host, port}` / `egress_deny`; only they
    edit the grant (new digest, new tasks) or amend a task (S5, B10).
13. (rev. 2) Full Access: `host` backend registered only when started with `--enable-host-exec`; the Kernel scope with `fs_scope=Full` is mintable only by the
    user-dialog approver; `prepare` has no path from `BackendInsufficient` to this backend.

### 8.4 Cross-platform paths (what is realistic)

| Platform | Mechanism | Pinned root | Subpath ro / mask | Network off | Kill tree | Memory/CPU | Verdict |
|---|---|---|---|---|---|---|---|
| **Linux** | bwrap + seccomp + Landlock + cgroup scope (this ADR) | yes (`--bind-fd`) | yes (mount) | yes (netns) | yes (cgroup) | kernel | **Workspace Access: supported** [measured] |
| Linux without bwrap/userns (hardened distro) | in-tree launcher (`unshare`+`pivot_root`) or rootless podman as a *second backend* | depends | depends | depends | cgroup | cgroup | `BackendInsufficient` until a backend exists; **no fallback** |
| **macOS** [knowledge, untested] | Seatbelt profile (`sandbox-exec`/`sandbox_init`; deprecated API, still what Chromium and agent CLIs use) | **no** — rules are path-based; a renamed/replaced dir is a TOCTOU | yes: `(deny file-write* (subpath ".git/hooks"))` with deny precedence; `(deny file-read* (literal …))` for existing secrets | yes | **weak**: process group/session only; a double-fork escapes; no cgroup | rlimit + polling only | Workspace Access possible with **downgraded caps** (`pinned_root_mount=false`, `kill_tree=best-effort`, `resources=polling`) → each downgrade must be a declared requirement the owner accepts, else fail closed |
| **Windows** [knowledge, untested] | restricted token or AppContainer + Job Object | no (ACLs by path) | via ACL deny ACEs | AppContainer w/o network capability | **strong** (Job Object kill-on-close) | **strong** (Job limits) | Workspace Access requires **mutating the project directory's ACLs**, a persistent change that a crash can leave behind (needs a journaled grant/revoke); WSL2 runs the Linux backend but `/mnt/c` (drvfs/9p) breaks bind/reflink/perf semantics. **Initial verdict: Workspace Access unavailable (fail closed); Full Access available** |

The existing sandbox is already Linux/x86_64-only (`sandbox.rs:337`), so today non-Linux hosts have *no* process execution; this ADR does not
regress that, and says so rather than implying parity.

### 8.5 Capability matrix (rev. 2)

`✔` enforced · `◐` partial/best-effort · `✘` unavailable (fail closed or other mode) · `?` unverified here. Linux column = measured on this host unless marked.

| Capability | Linux Workspace (bwrap+Landlock+seccomp+cgroup) | Linux Full Access (`host`) | macOS Workspace (Seatbelt) | Windows Workspace |
|---|---|---|---|---|
| Real project, in place | ✔ (E1) | ✔ | ✔ | ✘ initially (§8.4) |
| Pinned root identity | ✔ `--bind-fd` | n/a | ✘ path rules | ✘ |
| Host filesystem hidden | ✔ | ✘ by design | ◐ deny-rules, reads wide by default | ? |
| `.git`/secret/socket masks | ✔ (E3, E4) | ✘ | ◐ deny rules | ? |
| Offline | ✔ netns | ✘ | ✔ | ◐ AppContainer without network capability [knowledge] |
| Controlled Internet (domain/address policy) | ✔ proxy over Unix socket (E10) | ✘ | ◐ same design; Seatbelt allows only the proxy socket [doc: Claude Code uses it] | ? loopback exemption + firewall rules per AppContainer [knowledge] |
| Localhost ports to host services | ✔ `host.nexus.internal` allow-list (E10) | ✔ (native) | ◐ | ? |
| Host → sandbox dev server | ✔ `nsenter` forwarder (E11) | ✔ (native) | ✔ (shared loopback) | ? |
| Full Network (shared netns) | ◐ with Landlock abstract scope (E12) | ✔ | ✔ | ✔ |
| Non-HTTP via bridges | ✔ (design; stand-in measured) | ✔ native | ◐ | ? |
| Kill process tree | ✔ cgroup | ✔ cgroup scope around the host process | ◐ process group; double-fork escapes | ✔ Job Object [knowledge] |
| Memory/task limits | ✔ kernel scope | ✔ kernel scope | ◐ rlimit + polling | ✔ Job limits [knowledge] |
| Per-command prompts avoided inside grant | ✔ Auto | ✔ Auto | ✔ | ✔ |
| Egress evidence (bytes per destination) | ✔ | ✘ (no proxy) | ✔ | ? |
| Rollback checkpoint | ◐ reflink/copy | ◐ | ◐ APFS clone | ◐ |

Network on macOS/Windows is the same *architecture* (policy lives in a host-side proxy; the OS sandbox only permits the path to it), which is the
reason the contract expresses network as `NetCaps` rather than as a Linux namespace. Where the OS cannot restrict a process to "proxy only", the
backend reports `Offline`/`Proxy` unavailable and the product refuses that scope — or offers `Full Network`/`Full Access` as a separate, explicit grant.


---

## 9. Evidence model

### 9.1 Three layers, never mixed

| Layer | Question | Source | When | Strength |
|---|---|---|---|---|
| **E1 Authority** | what was the command *allowed* to do | Kernel-sealed scope + prepared plan digest (three axes + grant digest, root identity, view digest, mask-set digest, net policy digest, limits, sandbox/filter digest, backend id/caps, policy id/digest, approver) | durable **before** spawn (`prepared`) | cryptographic (HMAC seal + journal) |
| **E2 Observation** | what *changed* in the project | pre/post manifest over the pinned fd; checkpoint ref; run window; cgroup-empty settle | durable at `observed`/`interrupted` | observed fact; complete only as far as `observation.complete` says |
| **E3 Verified completion** | is the task's claim true | exit status + `settled` + effects reconcile + an independent check run (existing `verified-passed` semantics) | end of run | the only layer that may say "verified" |

### 9.2 Observation record (`observed`)

`{window{t0,t1}, preManifestDigest, postManifestDigest, checkpoint{kind, ref, complete, excluded[]}, effects{created[], modified[], deleted[],
modeChanged[], symlinksCreated[{path,target,escapesRoot}], specialsCreated[], hardlinked[], protectedTouched[{path,rule}], bulkDirs[{path,
changed,count?}]}, overlapWith{nexusWrites[]}, egress{byDestination[{host,port,conns,bytesOut,bytesIn}], denied[{host,port,reason}], truncated}, attribution:"temporal", settled:bool, complete:bool, truncated:bool}`.

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
Adversaries: prompt-injected model (T1); hostile content reached over the network — sites, registries, package scripts (T6, rev. 2); malicious dependency/postinstall scripts (T2); buggy/destructive toolchains (T3); the user's concurrent
edits (T4, accident); kernel/bwrap bug (T5); same-uid host process (out of scope, as in A3.3).

### 10.2 Matrix

| Threat | Control | Level |
|---|---|---|
| T1/T2 read host files | mount namespace has no `$HOME`/`/etc`/`/run`; symlinks outside do not resolve (E1b) | ENFORCED |
| T1/T2 write host files | root `--remount-ro`, only `/work/src`, `/work/env`, tmpfs writable; Landlock allowlist | ENFORCED (two layers) |
| T2 exfiltrate project secrets/source | **Offline:** no route. **Controlled:** destination policy (§7A.3) — stops arbitrary hosts, does **not** stop allowed destinations that accept writes (R9); masks for existing secret-shaped entries; no credentials mapped; stdout redaction; egress accounting | ENFORCED for Offline and for arbitrary destinations; **R9 NOT STOPPED** for allowed ones; **name-based and partial** for secrets in arbitrarily named files (R2) |
| T1 reach host services via project-local Unix socket | mask existing sockets; netns isolates abstract sockets (E4) | ENFORCED for existing; residual for sockets created by host processes mid-run (R6) |
| T1 plant host-executed code (`.git/hooks`, `.git/config` aliases/fsmonitor/sshCommand) | ro mounts (E3/E5); `.git` ro by default | ENFORCED for `.git` internals |
| T1 plant host-executed code elsewhere (`package.json` scripts, `Makefile`, `.vscode/tasks.json`, `.envrc`, any source file, git-tracked build scripts) | **cannot be prevented**: it is the work product. Flagged protected-path touches, full diff, checkpoint | **R1 — accepted, same as any coding agent; review is the control** |
| T3 destroy repository (`rm -rf .git`, `git gc --prune`, `git clean -fdx`, `git reset --hard`) | `.git` ro by default (E3); opt-in rw is an owner decision; working-tree loss mitigated by checkpoint | ENFORCED (ro default); BEST-EFFORT (tree) |
| T3/T1 symlink planted that is live only on the host | report `symlinksCreated.escapesRoot`; Nexus's own readers use `O_NOFOLLOW` | DETECTED |
| Pre-existing hard link to outside file | cannot be distinguished (documented); report `nlink>1` | R3 — accepted, residual stated in `workspace.rs:22` |
| Nested mounts under the project | refuse | ENFORCED [unproven; T7] |
| Fork bomb/memory/CPU/output | unchanged cgroup + rlimits + caps | ENFORCED (kernel scope) |
| Model raises its own privilege (any axis) | §7.5; no model-reachable grant verb | ENFORCED |
| Fallback to host exec when the sandbox fails | no code path from any sandbox backend to `host`; refusal text names the user's options (§7.5.5) | ENFORCED |
| T6 malicious site/registry content reaches the command | the command is already untrusted-code-equivalent; blast radius = Workspace filesystem + granted destinations | bounded, not prevented |
| Proxy as attack surface (parsing, SSRF to LAN/metadata) | separate unprivileged process, strict CONNECT parser, post-resolution address-class checks, connect-to-checked-IP, per-exec caps | ENFORCED by design; [unproven until S5 tests] |
| Full Network under Workspace: host loopback/LAN/metadata reachable | user-dialog grant; Landlock abstract-socket scope (E12); optional TCP port rules | **R10 — accepted by grant**, host services are not protected |
| Full Access: everything the user can do | none by design; supervision, audit, kill; user-dialog grant with expiry | **R11 — accepted by grant** |
| T4 concurrent user edit overwritten by a command | none during the run | **R4 — NONE** |
| Crash mid-command | cgroup killed; effects uncertain; no auto rollback | R5 |
| T5 bwrap/kernel/seccomp bypass | deny-list seccomp (allows newly added syscalls by default), userns kernel surface, Landlock second layer | **R7 — residual; larger blast radius than today because the real project is now writable** |
| A7 data egress via stdout | redaction (`redact.rs`), heuristic | R8 |

### 10.3 Git handling

* Default: `.git` visible **read-only**; `git status/diff/log` work and `add/commit` fail cleanly with `EROFS` (E5b, measured; `show`/`blame` not run); the binary is
  provided read-only from the host `/usr`. No credentials and no `~/.gitconfig` ⇒ `push` cannot authenticate; under Controlled Internet `fetch`/`clone` over HTTPS from allowed hosts work (read-only `.git` still blocks `fetch` from updating refs — `git_write` is the switch).
* Opt-in `git-write` per project (D6): `.git` rw except `hooks` and `config` (E5: `commit` works; `config` writes fail `EBUSY` and should be translated).
  `git` is added to the workbench program list **only** in this mode.
* Argv-level git policy (blocking `reset --hard`, `clean`) is **not** relied on (`sh -c` bypasses it). The protections are: ro `.git`, checkpoint of the working
  tree, evidence.
* Nexus's own promise "never commits, pushes, merges" becomes: Nexus-the-product does not; a *command* may commit locally only when `git-write` is on; nothing can push.

### 10.4 Long-running processes

The `service` class (S7): separate Kernel scope kind with TTL, an explicit stop verb, at most N per task, output ring buffer, same sandbox and masks,
killed on task end/revocation/daemon restart (reconcile). Dev servers also write (HMR caches); with an `fs_write` in flight their writes are
observed, not attributed (R4-like). Host-browser reachability uses the forwarder measured in E11 (§7A.5). Until S7, long-lived processes are bounded by
the existing wall clock (`BUILD_WALL_MS` 15 min).

---

## 11. Migration strategy (preserving Isolated)

1. Isolated + `scratch` stays byte-identical: same `sandboxDigest`, same staging, same `writeBack: none` semantics (now *computed* from class `Scratch`).
   A regression test pins the digest (T18).
2. New class is introduced behind the standing grant (default `Scratch + Offline + Auto`); nothing changes for any existing project or run until a user moves a project.
3. **S1 enables `workspace` over the Isolated task clone first** (`worktrees/<task>`): daemon-owned, disposable, no external-modification or
   secret-in-folder concerns, patch/Apply flow unchanged. It exercises mount, masks, observation, journal and Kernel scope change with zero host risk
   and immediately fixes `mkdir`/`npm install`/formatters/generators in Isolated tasks.
4. Direct + `workspace` follows (S5) after the Direct-specific parts (observed ledger, attribution, resume, lease) are proven.
5. `Full` is last (S8), independent of 3–4.
6. Existing projects keep `Scratch + Offline + Auto` until the user creates a standing grant (§7.2). Old journal rows, registries and consents remain valid. A consent given for the current text is **not** accepted for a `workspace`/`full` run
   (same mechanism as the direct-consent bump).

---

## 12. Required engineering stages (revision 2)

| Stage | Content | Exit criterion |
|---|---|---|
| **S0** | Owner decisions D1–D19; ADR accepted; PoC harnesses (Appendix A, A2) promoted to offline tests | owner sign-off |
| **S1** | `ExecBackend`/`BackendCaps`/`ExecPlan` extracted from `sandbox.rs`/`process.rs`, **no behaviour change**; `Scratch + Offline/install` only | T18 green (digest identical), full gate green |
| **S2** | **Authority chain:** Kernel scope v2 (three axes, `grant_digest`, `net_policy_digest`); `StandingGrant` in the registry with user-only verbs; policy `autonomous-workspace/v2` ("requested ⊆ granted"); derive the `writeBack` literals; approval-mode coexistence; v1 rows read as `Scratch` | T16, T21 green; old rows load |
| **S3** | Mount construction (`PinnedRoot`, `--bind-fd`, nested-mount refusal, existing-only masks, `.git` ro, Landlock shim, fd hygiene); **Workspace + Offline over the Isolated clone** | T1–T8, T14, T20 green with `NEXUS_REQUIRE_SANDBOX=1` |
| **S4** | Observation (tiered manifest), `settled`, effects schema, journal phases; checkpoint; guarded rollback | T9–T13 green |
| **S5** | **Controlled Internet** on the Isolated clone: `nexus-egress`, in-sandbox bridge, env/hosts plumbing, `local_ports`, TCP bridges, SNI check, accounting, `pendingEgress` cards, tool-compatibility matrix, presets | T15a–T15i green; compat matrix published |
| **S6** | **Direct + Workspace (+ Controlled):** `observed` ledger, attribution, `external_changes`, exec lease, resume; `nexus project grant` + Desktop grant dialog (three axes, exfiltration text), consent and guidance text | T12, T19, T22 green; Desktop tests; owner try-it |
| **S7** | Local servers: host→sandbox forwarder (Rust, from E11), `service` class, then the task-sandbox addendum for cross-command servers | T15j green; addendum accepted |
| **S8** | **Full Network** under Workspace (shared netns + Landlock abstract scope + optional port rules) | T15k green |
| **S9** | **Full Access:** `host` backend, user-dialog grant, `--enable-host-exec`, supervision parity, audit | T17 green; negative tests |
| **S10** | Optional: TLS termination + credential injection; macOS Seatbelt PoC (measured caps); Windows decision | per-platform addenda |

Order rationale: authority first (S2), then prove filesystem in-place with no network (S3–S4), then add network on the *disposable* clone (S5) so that
the first time source and network meet, the host is not at stake; Direct (S6) is the first time the user's real folder meets a network-enabled
command, and by then the egress service, evidence and grant UI have been exercised. Each stage ends with the full battery, strict clippy, and the
release gate with `--bodies`.

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
| T15a | Offline | no route, no resolver; tools ignoring the proxy fail with `Network is unreachable` |
| T15b | Proxy policy | allowed/denied names, wildcard rules, IP literals only by explicit entry, IPv6, IPv4-mapped, `169.254.169.254`, RFC1918, CGNAT, multicast denied; **resolve-once + connect to checked IP** (rebinding fixture) |
| T15c | SNI check | CONNECT to an allowed host with a ClientHello naming another host → refused |
| T15d | Accounting & cap | `bytesOut/bytesIn` per destination in `exited`; `max_egress_bytes_per_exec` enforced; **exfil evidence test:** a command posting a project file to an allowed fixture shows the bytes (asserts the limit is *reported*, not that it is prevented) |
| T15e | Host services | only `local_ports` reachable via `host.nexus.internal`; the sandbox's own `127.0.0.1` is never the host's |
| T15f | TCP bridge | `127.0.0.1:<p>` reaches exactly the one allowed `host:port`; anything else refused |
| T15g | Tool matrix | npm, pnpm, yarn, pip, cargo, go, git (https), curl, Node `fetch` (with env proxy option), Python `requests`, JVM (`JAVA_TOOL_OPTIONS`), dotnet, headless Chromium (`--no-sandbox`); each: works through the proxy against a fixture registry or fails closed |
| T15h | Pending egress | blocked host yields one `pendingEgress`; only the user verb changes the grant (new digest); the model cannot; `Ask` holds then times out; `Auto` denies at once |
| T15i | Egress service integrity | refuses to start on a policy/digest mismatch; unable to read Kernel store or project; killed with the execution |
| T15j | Forwarder | host `127.0.0.1:P` reaches the sandbox-only server; closing the execution closes the forwarder; no host-loopback exposure |
| T15k | Full Network | host abstract socket unreachable with Landlock scope, reachable without it (pins E12); refuses on ABI < 6; documented host-loopback reachability asserted as a known exposure |
| T16 | No escalation | `ProcessArgs` rejects extra fields; forged `operation.sandbox` ignored; sealed axis/grant mismatch refused; Kernel row tamper detected |
| T17 | Full Access | refused without user-dialog grant row and daemon flag; recorded argv/cwd/env digest; supervision kills on cancel/revoke/daemon crash; **never selected on sandbox failure** (remove `bwrap`, break userns, fail the egress service → refusal, nothing runs on the host); credential env vars absent unless named |
| T18 | Isolated regression | `scratch` `sandboxDigest` identical to baseline; `writeBack: none` computed; existing 1271-test battery unchanged |
| T19 | Resume/ledger | after an in-place formatter run, `external_changes` is empty; a later user edit is reported; diff includes observed-only files |
| T20 | fd hygiene | only 0/1/2 inside; project fd not inherited by the command |
| T21 | Three axes sealed | tampering with any axis, `grant_digest` or `net_policy_digest` in the scope row is detected; a task cannot start with a grant digest different from the registry's; `Ask` and `Auto` tasks coexist in one daemon |
| T22 | Grant authority | no broker verb, tool argument, model output or renderer message can create or widen a grant; user-gated verb works; consent-text digest mismatch refused |

---

## 14. Blockers, unresolved items, and owner decisions

### 14.1 Concrete blockers / unknowns (none prevent Linux feasibility; each gates a stage)

* **B1** Kernel scope schema bump (domain v2), journal-phase additions **and approval-mode coexistence** (`main.rs:695-717`) touch the Kernel/daemon authority chain — highest-risk code; needs its own review (S2).
* **B2** seccomp is x86_64-only (`sandbox.rs:291,337`) → Linux/ARM unsupported.
* **B3** Nested-mount refusal, `--block-fd`, and `--bind-fd` recursion semantics are **unproven** (T1, T7).
* **B4** ~~Host reachability of dev servers~~ — resolved for host→sandbox by E11 (forwarder). **Still open:** cross-command servers need the task-sandbox design (S7 addendum).
* **B5** Checkpoint is absent on non-reflink filesystems for large trees; bounded copy has caps → "rollback unavailable" must be an accepted state (D4).
* **B6** Attribution is temporal only (E8). Exact attribution requires Option D.
* **B7** macOS/Windows cannot be validated from this environment; caps tables are knowledge, not measurements.
* **B8** The seccomp filter is a deny-list; writable real project plus network raises the cost of a bypass (R7). An allow-list conversion is a large, separate effort.
* **B9** Consent/guidance/UX text and the grant surfaces (CLI + Desktop) do not exist.
* **B10** (rev. 2) Per-task egress amendments ("allow for this task") need a Kernel-visible binding or must be limited to project-level grants.
* **B11** (rev. 2) Exfiltration to allowed destinations (R9) and small-secret leakage are **not solvable** by the proxy; only TLS termination (S10) improves domain fronting, not R9.
* **B12** (rev. 2) Proxy-awareness differs per tool; the compatibility matrix (T15g) decides which workflows work in Controlled mode. A transparent netstack (`pasta`/slirp) is the fallback and is not installed here.
* **B13** (rev. 2) Reaching `Full Access` requires `--enable-host-exec`; the daemon today refuses combinations "failing closed" (`main.rs:708-760`), so flag interactions need a matrix test.

### 14.2 Owner decisions needed before implementation

| # | Decision | Recommendation |
|---|---|---|
| D1 | Default grant for **newly** authorized projects (existing stay `Scratch + Offline + Auto`) | Until S6 proves out: unchanged. Then offer the **Trusted Workspace** preset (Workspace + Controlled(exact-host presets) + Auto) as the one-click option in the dialog |
| D2 | Start with the **Isolated clone** (S3–S5) before any Direct change | Yes |
| D3 | Landlock mandatory for Workspace scope | Yes (ABI ≥ 1; ABI ≥ 6 reported; **required** for Full Network) |
| D4 | Run with **no checkpoint** allowed? | Allow, evidence-flagged; per-project `requireCheckpoint` opt-in |
| D5 | Full Access: consent scope, expiry, env passthrough | Per project, expiring (7 days), allow-listed env, credential variables only by explicit name |
| D6 | `.git` policy | Read-only default; `git_write` opt-in in the grant; hooks/config always read-only |
| D7 | Commands may modify `PROTECTED_NAMES`? | Allowed under Workspace, flagged |
| D8 | Controlled Internet defaults | Empty allowlist + **exact-host presets**; `*` (any public address) allowed but shown with the R9 warning; no wildcard storage/CDN suffix presets |
| D9 | Accept R1, R4, **R9** as stated product limits | Accept, with §6.3 and §7A.3 text in the grant dialog |
| D10 | Option D (FUSE) | Later, only if evidence shows gaps matter |
| D11 | Windows/macOS | Windows: fail closed for Workspace; Full Access allowed. macOS: Seatbelt PoC first |
| D12 | Exec lease vs `service` processes | Exclusive for commands; `service` observed-only |
| D13 | Grant dialog wording for exfiltration | Mandatory sentence from §7A.3, digest recorded |
| D14 | Approval axis: confirm `Ask` remains available per project, and the daemon must run both modes | Yes (B1 cost accepted) |
| D15 | Allow **Full Network** under Workspace scope at all | Yes, S8, user-dialog grant, Landlock ABI ≥ 6 required |
| D16 | `max_egress_bytes_per_exec` default | 16 MiB upload cap for Controlled; `unlimited` selectable |
| D17 | "Isolated install" narrow-view hardening profile | Offer as opt-in; not default |
| D18 | `no_new_privs` in Full Access | On (no setuid escalation); off only by explicit grant flag |
| D19 | TLS termination / credential injection (S10) | Defer; revisit when private-registry or API-key workflows demand it |

---

## 15. Recommendation (revision 2)

Build **Confined In-Place (Option C)** on Linux with **network as a first-class, user-granted axis**, sequenced S1→S6, starting on the Isolated clone;
make **Trusted Workspace = Workspace + Controlled Internet + Auto** the parity configuration; ship **Full Access** (host backend) as a separate,
user-granted scope with supervision and audit but no confinement, and never select it after a failure. Keep `Scratch + Offline` as the default and as
Isolated's behaviour.

What the new rule is, and is not: the revision-1 rule "never combine network with the full project view" is replaced by "never combine them
*without a user-created, sealed, auditable grant that states the consequence*". The network is policed by a host-side proxy with name and address-class
checks, explicit local-port and TCP-bridge permissions, accounting, and fail-closed behaviour for tools that ignore it (all measured, E10–E12). It
does **not** prevent exfiltration of readable source to any allowed destination, and Nexus must say that to the owner in the dialog, in the evidence
and in the documentation. The honest defence is layered and partial: a small, exact destination set; no credentials in the sandbox; masks; byte
accounting; review of evidence.

The authority-chain change stays small and mechanical: one scope-schema bump, one standing-grant record, one unprivileged egress process, one
policy rule ("requested ⊆ granted"), and approval-mode coexistence. Nothing the model sends can raise any axis. Unchanged from revision 1:
honest guarantees (§6), mask only what exists, mount the pinned file descriptor never a path, no per-file authorization or crash-atomic rollback
claimed for arbitrary commands.

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

## Appendix A2 — Egress PoC (reproduces E10–E12; scratch use only)

Host proxy (`proxy.py <unix-socket> '<json allowlist>' <seconds>`): accepts `CONNECT host:port`; denies names not in the list (a `host:port` entry is
an explicit allowance, including host loopback); resolves **once**; denies loopback/private/link-local/reserved/multicast/unspecified addresses unless
the entry was explicit; connects to the **checked IP**; logs every decision. Sandbox side: `bwrap … --unshare-net … --ro-bind <proxy.sock>
/work/proxy.sock --bind-fd <project> /work/src …`, then `socat TCP-LISTEN:3128,bind=127.0.0.1,fork UNIX-CONNECT:/work/proxy.sock &` and
`HTTPS_PROXY=http://127.0.0.1:3128`; tools use `curl -p` for plain-HTTP tunnelling. Forwarder test: `nsenter -t <bwrap-child-pid> -U -n curl http://127.0.0.1:3000/`
(`--info-fd` gives the child pid). Abstract-socket test: a host listener on `\0name`, a sandbox client with and without
`landlock_create_ruleset({scoped = LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET})` + `landlock_restrict_self`. The Python/`socat` stand-ins prove the
*mechanism*; the Rust implementations are S5/S7 deliverables and must pass T15a–T15k, not the PoC.

## Appendix B — Evidence not gathered

No macOS/Windows host; no TLS interception, no Rust egress service, no per-tool proxy-compatibility run; no ext4/xfs run; no ARM; no multi-UID deployment (A3.4 §Verdicts: still NOT RUN); no real-provider run. Everything marked
[unproven] is a design claim to be turned into a test (T1, T7, T-forwarder) before the dependent stage starts.

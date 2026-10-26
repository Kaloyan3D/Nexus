# M4 — True Direct Workspace execution

Branch `feature/rust-native-core`. Baseline `a70d1bf` (M3C). M4 source commit: **`9f9a61a`**; this report is a docs-only commit after it.
Host: Linux 6.18.55 (Landlock ABI 7), bubblewrap 0.13, x86_64; `/home` is btrfs, `/tmp` is tmpfs.
Not done, by instruction: Controlled Internet, Full Access, background processes, MCP/CCv2/Nova, a new global permission architecture.

## 1. Verdicts

Source commit for all results: **`f72df57`** (feature commit `9f9a61a` + one fix commit; the report follows in a docs-only commit).

| Dimension | Verdict | Basis |
|---|---|---|
| **Technical functionality** | **PASS.** A real, explicitly authorized Direct project is modified through real shell commands, in place, immediately; `fs_write`, `fs_edit`, `proc_run` and the project diff see one filesystem; Ask/Auto, revoke, expiry, cancel, daemon crash and restore all behave as specified on it (§4). | 17 new broker/tools acceptance and layout tests, full battery 1437/0 |
| **Security boundary confidence** | **Moderate-to-high on the validated layouts; not "proven".** Every boundary M1–M3C established is re-verified under Direct (confinement mandatory and fail-closed, masks, read-only `.git`, hard-link protection, descriptor-pinned root, sealed grants, model cannot reach policies/restore). Not independently reviewed. Live-validated only on btrfs and tmpfs; FUSE/NFS/FAT are refused by rule but that refusal was not exercised on a real FUSE mount here; filename-based secret detection, dependency-folder blind spots and the scan-to-mount window remain (§8). | tests + M3C residual list |
| **Product usability** | **Good for an explicit opt-in on local Linux filesystems; not yet a default.** Per-command overhead with checkpoint is ≈ 0.08 s (1 k files), ≈ 0.5–0.7 s (20 k files) and ≈ 0.9–1.1 s (150 k files incl. dependencies) (§7). Gaps: the recovery/hard-link/worktree options and the restore flow are CLI-only (no graphical Undo), Git write operations are deliberately unavailable, and dependency-folder changes are not restorable. | measured latency; §8 |

**Is True Direct Workspace ready for normal user opt-in? Yes, as an opt-in for users who accept the disclosed limits and can use `nexus exec restore` when they want something undone** (the consent dialog states them). It should not be enabled by default, and Desktop-only users should be told that undo is a CLI action today.

## 2. What a user can do now

Open a project folder, choose **Edit my folder directly**, and grant **Commands change my real project files directly** (CLI: `nexus project grant <id> set --fs workspace …`; Desktop: Projects → Permissions…, which shows the exact consent text in its own dialog). From then on the model's `fs_write`, `fs_edit` and `proc_run` all act on the **same directory** — the user's real folder, pinned by descriptor. There is no copy, no patch to apply and no adoption step: a file `fs_write` creates is visible to the next command at once; a formatter's edit is on disk when the command ends; the project diff shows all of it.

## 3. What changed (M4A + M4B)

| Area | Change |
|---|---|
| Direct + in-place | The refusal "commands over the real folder are not available" is gone from the registry, the grant validator and `direct-open`. A **Direct task runs commands in place only when its frozen standing grant says `workspace`** (re-checked at every operation; narrowing/revocation/expiry apply as in M2.1). `execFsScope` in the task record, request arguments and model input never select it (unit test). A grant agreed for one kind of workspace never carries over to the other (switching modes with a live in-place grant is refused: revoke → switch → grant again). |
| Consent | The consent text for a real folder says so in words: real folder, immediate effect, `.git` read-only, protected entries, the checkpoint/hard-link/limits disclosure. |
| Per-project policies (bound to the grant) | `checkpoint`: `off \| best-effort (default) \| required`; `hardLinks`: `protect (default) \| allow`; `gitWorktree`: `off (default) \| read-only`. Stored **inside the standing grant** — same user-gated path, same consent-digest check, same audit log, sealed by the Kernel through the grant digest (the digest changes only for non-default values, so existing grants are unchanged), frozen into each task, and **only narrowing while a task runs**. `allow` for hard links additionally needs a typed phrase at a real terminal (`--yes` and pipes cannot give it). The model has no argument, tool or message that reaches any of it. |
| Restore access | `nexus exec effects <id>` and `nexus exec restore <id> [--apply]`: preview first (nothing changes), apply needs the **confirmation digest of a fresh preview** (any change since invalidates it) and a typed confirmation; every request is appended to `restore.audit.jsonl` with the actor. Operator-only (broker socket / issuer verb); never invoked by recovery; refused while the task has a command open. |
| Linked worktrees | The smallest safe mechanism: with `gitWorktree: read-only` the main repository's `.git` is bound read-only **only after** the `.git` pointer is verified bidirectionally (absolute, no links, `<repo>/.git/worktrees/<name>` owned by you, the named directory's `gitdir` points back to this worktree's `.git`, `commondir` agrees, no overlap with the workspace or Nexus's data) and opened without following links. Forged pointers expose nothing (six cases + symlink tested). Default off ⇒ git fails closed. |
| Packaging | The launch gate speaks a versioned protocol; the daemon refuses a gate that reports another (message names both). `nexus-confine` is built and scanned by the release gate. The daemon reports `inPlaceExecution: {available, reason}`; the broker refuses to store an in-place grant on a machine that cannot provide it (reason shown in CLI/Desktop); `direct-open` re-checks and refuses with the missing piece named; starting `nexusd --isolated-exec-scope workspace` without the confinement is a startup refusal. |
| Filesystems | Refused with an actionable reason: FUSE, NFS/CIFS/SMB/9p/AFS/Ceph/Lustre, FAT/exFAT/NTFS. Allowed and tested: btrfs, tmpfs; allowed by rule: ext4, xfs, f2fs, zfs, overlayfs. |
| Direct evidence | A tool-written file that a command later changed is no longer reported as the user's change (the expected state follows the latest writer); a command-modified or deleted file is diffable against its pre-image; changes inside dependency/build folders mark the evidence "may be incomplete". |
| Harness text | Only a Direct run with in-place commands gets the new text ("directly ON THE REAL PROJECT FOLDER … `.git` is read-only … not covered by recovery"); every other run's text, and therefore its provider request bodies, is byte-identical. |
| Latency | Per-stage timings are recorded with each execution. Checkpoint creation is now parallel and packs small files into a few append-only files (each file still individually hash-verified): **10× faster on btrfs** (§7). |

## 4. Acceptance evidence (real daemon, Kernel, sandbox, broker; the provider simulates only the model)

`m4_a_real_project_is_developed_in_place_with_shell_commands_and_every_boundary_holds` (M4C) on a real on-disk Direct project (a Rust crate under a normal user directory), grant `workspace/offline/auto`:

1. `fs_write` creates `src/gen/spec.json` (nested folder) and `fmt/ugly.txt`.
2. A command **reads both** and runs a formatter; the same command verifies the formatter's edit (`a b c`) — and the host file holds it immediately.
3. A Python generator reads the spec and writes `generated/alpha.txt`, `beta.txt`; a **later command consumes** them.
4. `fs_read`/`fs_edit` fix `src/lib.rs`; `cargo test --offline` runs against the very same files and passes; a Node build writes `dist/out.js`.
5. All in the real directory; five ledger records, each `observed` with a **complete checkpoint**; the command that wrote `dist/` says honestly `recoverability.complete=false` (`bulkNotCaptured`), and the diff says `commandEvidence.incomplete`.
6. Project diff lists every file; command-made files carry `origin: command`, `attribution: temporal`, `externalChange: false`; `src/lib.rs` is `origin: tool`.
7. A **genuine user edit** (to `generated/alpha.txt` and `src/lib.rs`) is flagged `externalChange: true` — and only those; the formatter's file (tool-created, command-edited) is not blamed on the user.
8. Guarded restore of the generator's execution: preview shows `generated/alpha.txt` as a **conflict**; a wrong confirmation is rejected; the confirmed apply removes the untouched `beta.txt` and **keeps the user's edit**; restoring the formatter's execution returns the original text.
9. The audit log records the CLI actor.

Lifecycle on a Direct project (`m4_revocation_expiry_and_cancellation…`, `m4_ask_holds…`, `m4_a_daemon_crash…`, `m4_the_owners_policies…`):

| Case | Result |
|---|---|
| revoke while a command runs | command killed in seconds; later operation never ran; its effect stays in the folder (no rollback); record `partial`; run never `verified-passed`; explicit restore returns the folder |
| grant expires while a command runs | same |
| cancel | same |
| Ask | the command is held: nothing runs, the real folder is unchanged, no ledger record |
| second writer on the same folder while a command runs | refused up front with "editing this project's folder", nothing created (the write lease covers process writers: the run owns the folder for its whole life, commands included) |
| daemon `SIGKILL` mid-command | process tree dies, run not completed, effect kept, record `uncertain` with its checkpoint, restore only by explicit CLI preview+apply |
| `required` checkpoint that cannot be complete | command refused before it starts; real folder untouched; the refusal is in the evidence |
| hard-link `allow` via `--yes` | refused; stored policy unchanged |
| M1–M3C suites on isolated copies | all pass unchanged (permissions, crash boundaries, confinement) |

## 5. Supported and unsupported project layouts (tested on disposable projects in normal user directories)

| Layout | Status | Evidence |
|---|---|---|
| Normal Git repository | **Supported**: `.git` read-only, git reads work, hooks/config cannot be written | `git_metadata_is_readable…`, compat session |
| Submodules / nested repositories | **Supported**: nested `.git` file/dir read-only, `git submodule status` works, `.git/modules/*` read-only | `submodules_and_nested_repositories…` |
| Linked worktree | **Supported with `gitWorktree: read-only`** (verified pointer); default off ⇒ git fails closed; forged pointers refused | three tests |
| Symlinks (dangling, loops, absolute, to outside) | **Supported**: never followed out of the project | `symlinks_in_the_project_never_lead_out…` |
| Hard links | **Supported, read-only by default**; `allow` is an owner-only override | M3C + M4 policy tests |
| Large project with dependency folders (20 k source files + 130 k dependency files) | **Supported**; dependency folders are summarised (not listed/captured) | §7 |
| btrfs, tmpfs | **Tested** | filesystem test, benchmarks |
| ext4, xfs, f2fs, zfs, overlayfs | allowed by rule, **not tested here** (no such mount on this machine) | `filesystem_support` unit test |
| FUSE, network filesystems, FAT/NTFS | **Refused** with an actionable message | unit test of the rule; **no FUSE server was available to test the live refusal** |
| Bind mount below the project root | **Refused** (host check + in-sandbox check) | real unprivileged mount namespace test |
| Project root itself on a bind mount | not validated (treated as an ordinary directory) | — |
| Special names (non-UTF-8 special files), > 1 024 protected entries, > 2 M entries | refused, nothing partly protected | M3C |

## 6. Security boundary (unchanged by M4, re-verified)

Kernel authorization and the sealed grant decide that a command may run; bubblewrap + seccomp + cgroups isolate it; the launch gate verifies the namespace and applies Landlock before the command; masks cover nested secrets, sockets and special files; hard-linked files are read-only; `.git` (including nested) is read-only; checkpoints and restore are outside the sandbox's view; a missing or incompatible confinement piece refuses the task — **no weaker backend is ever selected**. Network permissions are unchanged (offline, or the existing install class).

## 7. Measured end-to-end overhead (release build; one `sh` command that appends a line; commands 2–4 of a project)

Stages are recorded with every execution (`timingMs`). Total = what the user waits for.

| Tree | FS | Checkpoint | Total per command | Protection scan | Pre-observe | Checkpoint | Launch + confinement + run | Post-observe + diff + record |
|---|---|---|---|---|---|---|---|---|
| 1 k files | tmpfs | off / best-effort | 78 / 80 ms | 7 | 8 | – / 14 | 32–37 | 10–17 |
| 1 k files | btrfs | off / best-effort | 132 / 205 ms | 14–15 | 12–17 | – / 42 | 34–36 | 14–21 |
| 20 k files | tmpfs | off / best-effort | 324 / 540 ms | 54–74 | 78–90 | – / 221 | 37–44 | 100–107 |
| 20 k files | btrfs | off / best-effort | ≈ 420 / ≈ 700 ms | 73–80 | 70–83 | – / 295 | 48 | 89–117 |
| 20 k + 130 k dependency files | tmpfs | off / best-effort | 700 / 860 ms | 388–422 | 78–81 | – / 200 | 39–44 | 112–127 |
| 20 k + 130 k dependency files | btrfs | off / best-effort | ≈ 850 / ≈ 1 100 ms | 523–563 | 91–101 | – / 270 | 38–47 | 129–142 |

(Stage columns are milliseconds of one representative command; "total" is the median of commands 2–4 of the same project, measured around the whole tool call, including the Kernel journal. The first command of a project is slightly slower — cold caches.) A workflow of consecutive commands therefore costs the same again for each command; the checkpoint share is 30–40 % at 20 k files. For comparison, the M3B implementation checkpointed 20 000 files in 2.7–3.3 s on btrfs.

Checkpoint creation alone, before → after this milestone (20 000 source files): btrfs ≈ **3.0 s → 0.3 s**, tmpfs ≈ 0.9 s → 0.2 s. Mechanism: parallel storage over a few threads, parent-directory handle reuse, right-sized buffers, and small files (≤ 64 KiB) appended to per-thread pack files instead of one inode each; reflink is still used for larger files; every file is still verified before and after and hashed.
Remaining overhead for the next optimisation milestone: the **protection scan** of dependency folders (≈ 0.4–0.5 s with 130 000 dependency files; it re-walks them on every command — a validity-checked cache between consecutive commands is the obvious fix), and the two **observation** passes (≈ 80 ms each at 20 000 files). Nothing was disabled, skipped or weakened to obtain these numbers.

## 8. Residual limitations (stated, not hidden)

* Arbitrary commands are **not** perfectly reversible: a checkpoint is not an atomic snapshot, does not cover dependency/build folders, `.git` or secret-shaped files, and cannot undo effects outside the project (installs from the network, other tools). Restore is explicit, conflict-preserving and not a transaction.
* Git metadata mutation stays **forbidden by policy** (read-only `.git`): no commit, checkout, branch, hook or config change from a command. This is not Git write parity; the separate git-write permission is future work.
* Filename-based protection cannot detect a secret stored under an ordinary name; hard links inside dependency folders and a link created between the scan and the mount are not covered (M3C §6).
* A concurrent writer that is not Nexus (the user's editor) is reported temporally, never attributed with certainty; ambiguity is flagged where a tool write falls inside a command's window.
* The Desktop shows the policy choice for in-place commands but not the checkpoint/hard-link/worktree options (CLI only); there is no graphical Undo.
* Starting a task on a project that is already being edited by another run is refused (one writer per folder), as before.
* Not validated on this machine: FUSE and other network filesystems (rule-tested only), ext4/xfs, a project root that is itself a bind mount, very large monorepos (> 150 000 files).
* Release gate and battery were run on one host.

## 9. Validation of the final source SHA

Run once, sequentially, on an otherwise idle machine, `NEXUS_REQUIRE_SANDBOX=1`, source SHA `f72df57`; the pre-M1 baseline dump (`8a08471`) was regenerated first, alone, into a persistent directory (1 286 passed, 0 failed, 156 dumps):

| Gate | Result |
|---|---|
| `cargo fmt --all --check`; strict clippy `--workspace --all-targets -D warnings` | clean / clean |
| Rust workspace battery | **1437 passed, 0 failed, 62 ignored** (M3C: 1420 / 0 / 61) |
| Tauri fmt + clippy; Tauri tests | clean; 27 lib, `permissions_m2` 2, `permissions_runtime_m21` 1, `runtime_update_a614` 1: all passed |
| Desktop `tsc --noEmit`, `eslint src`, `vitest run` | clean, clean, **186/186** |
| Release gate: registry-js / engines / e2e / production / release binaries / desktop binary | PASS 22/22 / PASS 148-0 / PASS 36-0 / PASS 14-0 (negative control detected) / PASS (4 executables, none with a test-only symbol) / PASS |
| Release gate `bodies` vs `8a08471` | **PASS**: 156 tests, 1 617 bodies, 1 442 identical, 169 volatile tool output, 6 order-only, 0 polling-count-only, **0 unexplained** |

**Provider-body comparison history, preserved.** A first complete run on the feature commit `9f9a61a` reported `bodies: FAIL` with 33 unexplained bodies, plus two further failures (a Tauri runtime test and a Desktop test) that were genuine consequences of M4 and were fixed in `f72df57` (the Tauri test directory did not contain `nexus-confine`, which the runtime now also passes to the daemon explicitly; the Desktop test still asserted that in-place commands cannot be chosen for a direct project). The 33 bodies were classified exactly, not dismissed: **all 33 came from one test**, `s8_worker_timeouts_and_cancellation_leave_consistent_durable_state`, differing only in `reasoning.effort` (baseline sample `xhigh 29 / high 3 / low 1`; M4 `xhigh 29 / medium 4`); every other test was identical or ordering-only. That test SIGSTOPs the governor worker on a timer, so which evaluations are lost depends on scheduling. To decide whether M4 changed anything I ran the test in isolation: **baseline `8a08471` ×4, M3C `a70d1bf` ×2, M4 ×4 — all ten runs give the identical `xhigh 29 / medium 4`.** The one deviating sample was the baseline's own full-battery dump (taken while the battery ran many tests in parallel); it was replaced, for the final comparison, by the baseline's isolated run (the original sample is kept in the cache directory as `s8-baseline-full-battery-sample.json`). Net: M4 introduces no request-body difference; the comparison on the final SHA has 0 unexplained.

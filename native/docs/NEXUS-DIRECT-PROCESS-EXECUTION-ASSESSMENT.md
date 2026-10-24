# Direct Workspace — can commands run "in place"? Assessment and staged proposal

Question (owner): `proc_run` still works on a throw-away sandbox copy. Is there a smallest secure way for authorized commands
(`mkdir`, `npm install`, formatters, generators, build tools, git) to act on the REAL Direct Workspace?

**Short answer.** Not without a larger change than a bug fix, and it needs the owner's decision (it widens what a command may
cause). What is done now closes the false-confidence gap and the concrete smoke failure; full "persistent shell effects" is
**not** implemented and **must not be described as True In-Place parity**. A staged path is proposed below.

## What the code does today (read from `process.rs`, `stage.rs`, `sandbox.rs`, the daemon policy)
1. Every `proc_run` first **stages** a filtered copy of the project into a private host directory (descriptor-relative, per-file double-read
   consistency): no `.git`, no hidden/secret names (`.env*`, keys), no symlinks, no hard-linked or special files, no files over 16 MB, no
   `node_modules`/`target`/`dist`/`build`/`vendor`; bounded in files and bytes.
2. bubblewrap (user/PID/mount/net namespaces, seccomp, cgroup-v2 limits) binds that copy at `/work/src` (writable in the workbench profile),
   mounts `/usr` read-only, a size-limited tmpfs for scratch, and (for dependency work) a per-project environment directory at `/work/env`.
3. When the command exits the copy is deleted. The journal and the approval record say `writeBack: none`, and the **automated policy
   refuses any process whose declared sandbox has write-back or a network other than none/install**.

So a command's effects on files never reach the project, by design, in isolated AND direct mode. In direct mode the copy is made from the
real folder's current files, so a command sees every edit Nexus has made (and anything the user changed), but writes nothing back.

## Effect by command class
| Command | Today |
|---|---|
| `mkdir -p src tests` | ran fine in the copy and vanished. **Now solved natively:** `fs_write` `create` makes missing folders (bounded, descriptor-relative, journaled) |
| `echo > file`, generators, code scaffolding | files exist only in the copy. **Now reported**, never silently dropped (below) |
| formatters (`prettier --write`, `cargo fmt`) | rewrite files in the copy only; reported as unsaved; nothing is applied |
| `npm install` / `cargo fetch` | installed packages are kept in the project's *environment store* and mounted into later commands (so tests work); they are not written into the folder (`node_modules` is a protected, ignored directory); lock-file changes stay in the copy |
| build tools | outputs are discarded by design (`target`, `dist`, `build` are ignored/protected) |
| git | `.git` is never staged and never writable; Nexus never commits, pushes or merges |

## Implemented now (Stage 1: honesty, no new authority)
* The command's changes to its scratch copy are computed (before the copy is removed) by comparing it with what was staged, and reported:
  `scratchEffects {created, modified, deleted, createdDirs, unsavedFiles, persisted:false}` in the tool result, the Kernel journal record
  (counts) and the run's tool activity. Lock files the agent may not write anyway are listed but do not count as "unsaved".
* The model is told in the tool result, in words, that those changes exist only in the throw-away copy and are gone, and to use
  `fs_write`/`fs_edit` instead; the direct-workspace harness text says so too.
* A passing check that wrote unsaved files is **not** shown as "Tests passed": the verified outcome is `verified-scratch` ("Check passed in a
  scratch copy · N files it wrote were not saved"). Saving the files and re-running yields `verified-passed`.
* Nothing the command did is applied or "adopted"; no new authority exists.

## Proposed Stage 2: adopt a command's effects through the SAME guarded write path (needs owner approval)
After a command exits 0 (never on failure, timeout or cancel), each reported effect on an adoptable path becomes a harness-originated
file operation executed with the same machinery as `fs_write`:
* only `created`/`modified`/`deleted` files that pass the existing name policy (no hidden, secret, `.git`, protected/lock files, ignored directories)
  and the project's write scope and size budgets; everything else stays reported-as-unsaved;
* **pre-image guard:** a modified/deleted file is applied only if the real file still equals what was staged (the user changed it meanwhile → skipped
  and reported, never overwritten); a created file only if absent (`RENAME_NOREPLACE`);
* every applied file keeps its original in the direct pre-image store first (so it is in the run's diff and recoverable) and is a separate Kernel
  write-journal entry linked to the command's execution id (`aiOrigin: command-effect`) - audit stays complete and crash reconciliation unchanged;
* a policy id bump (`autonomous-workspace/v2`) declaring `writeBack: adopt` for the command, with caps on files and bytes, because today the
  policy *requires* `writeBack: none`; cancellation: adoption starts only after the process has exited and no cancel was requested, file by file,
  so a cancel mid-adoption leaves a prefix that is fully journaled (reported as partial).
This would make `mkdir`, formatters and generators persist while keeping every existing guarantee, at the price of a Kernel/policy change and
a new class of AI-caused file writes the owner must be comfortable with.

## What stays out even after Stage 2, and why a bigger step is not recommended
True in-place process execution (the real folder mounted read-write into the sandbox) would let an arbitrary process write anywhere in the
folder: no per-file pre-image or journal, no name policy (it could write `.git/hooks`, replace files with symlinks mid-race), secrets in the
folder readable by the process and its network (installs), no cheap rollback. It would discard exactly the guarantees Direct Workspace was
built to keep. An overlayfs capture (real folder as a read-only lower layer, scratch upper layer) gives the same *effect set* as the staged copy
without copying, but cannot hide secret files from the process - so the filtered staged copy remains the security boundary. Recommended order:
Stage 1 (done) -> Stage 2 (adoption, owner decision) -> optional overlay capture as an optimisation only.

## Status
| Capability | Direct Workspace today |
|---|---|
| fs tools (create nested files and folders, edit, delete) in the real folder | yes |
| commands run over the real folder's current (persisted) files | yes (in a sandbox copy) |
| commands' file effects persist | **no** (reported, not applied) |
| `npm install`, build outputs, git in the real folder | **no** |

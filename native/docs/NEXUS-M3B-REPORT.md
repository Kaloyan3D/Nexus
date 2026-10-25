# M3B — Checkpoints, pre-images and guarded recovery

Branch `feature/rust-native-core`. Baseline `4ec6f93` (M3A source). M3B source commit: **`904602f`**; this report is a docs-only commit after it.
Host: Linux 6.18, bwrap 0.13, x86_64; `/home` is btrfs (reflink-capable), `/tmp` is tmpfs (no reflink).
Not done, by instruction: Direct Workspace process execution, Landlock (M3C), Controlled Internet, Full Access, an Undo UI.

## 1. What was built

| Piece | Where |
|---|---|
| Checkpoint creation, index, quota/retention/GC, recoverability assessment | `nexus-tools/src/checkpoint.rs` |
| Guarded restore | `nexus-tools/src/restore.rs` |
| Lifecycle integration (checkpoint → `prepared` journal → spawn → observation; recovery) | `process.rs` |
| Records: `checkpoint`, `recoverability`, `post_state` in the M3A effects record (+ summaries in journal/tool output) | `observe.rs` |
| Direct evidence: diff of command modifications/deletions against pre-images | `direct.rs` |
| Daemon: `--checkpoint off\|best-effort\|required`, `--checkpoint-max-bytes`, `--checkpoint-quota-bytes`, `--checkpoint-retention-days`, `--checkpoint-force-copy`; startup sweep; operator verb `exec-restore {executionId, dryRun}` | `nexus-daemon` |

### Sequence of an in-place command
`pre-observation (M3A)` → `pre-manifest persisted` → **`checkpoint of exactly the observed tier-1 entries`** (stored outside the sandbox view, index fsynced, directory published) →
`prepared` journal record (carries the checkpoint description and index digest) → spawn → supervised run → settle → post-observation → diff → **recoverability per changed path** → ledger record →
journal end (`exited`/`cancelled`/`interrupted`). Scratch runs are untouched (no checkpoint store, no `effects`).

## 2. Exact guarantees

**A checkpoint is a verified, non-atomic, file-by-file preservation — not a snapshot.** Files are preserved one after another (reflink clone where the store filesystem allows it, otherwise a bounded
copy). Each file is opened through the pinned workspace descriptor (no symlink followed, no mount crossing) and must still match its M3A observation (inode, size, ctime) **before and after** it is
preserved; otherwise it is excluded and the checkpoint is `incomplete` (`changed-since-observation`, `changed-during-checkpoint`). Two files may still come from slightly different moments while a writer is
active; the index records this (`consistency`) and nothing claims point-in-time consistency. Each stored file has a sha256; restore re-verifies it.

**Coverage is explicit.** `status: complete` means every tier-1 entry was stored or excluded *by a stated rule*; `coverage` lists the rules:
secret-shaped names (never copied: no secrets in checkpoints), special files, dependency/build directories (`node_modules`, `target`, ...: tier 2, **not captured**), `.git` (**not captured**).
Anything else not stored makes the checkpoint `incomplete` with a reason: `size-budget`, `file-budget`, `file-too-large`, `unreadable`, `changed-*`, `pre-manifest-incomplete`.
If nothing could be persisted the attempt is `unavailable` (`insufficient-storage`, `storage-exhausted`, `workspace-identity-changed`, `store-unavailable`) and nothing is left on disk.

**Owner decision D4 (kept explicit, no silent fallback).** Default `best-effort`: the command may run without a complete checkpoint and the journal, the record and the tool result all say so
(`checkpoint.status`, `recoverability.complete=false`, per-path reasons). `required` (daemon flag; per-project opt-in is future registry work) refuses the command **before it starts** unless the
checkpoint is complete (`checkpoint-required: ...`). `off` restores the pre-M3B behaviour.

**Recoverability per observed change.** Modified/deleted files, changed symlinks and mode changes are `available` or `unavailable:<reason>`; created paths are `new`; changes inside summarised directories are
counted as `bulkNotCaptured` and never claimed recoverable; a truncated record or an incomplete checkpoint makes `complete=false`.

**Guarded restore** (operator verb or library API; never called by crash recovery). Inputs: checkpoint index + sealed effects record (digest verified) + the current filesystem. Refused outright when:
the record's digest fails, the process tree did not settle, the pinned workspace identity differs, the checkpoint is missing/corrupt/tampered (digest ≠ the one recorded at run time), or it belongs to another workspace.
Per path: restored only when the current state is exactly what the command left (stat signature or content hash); `already original` is skipped; **a user edit after the command is a conflict and is left untouched**;
a created file that was modified later is kept; a created directory is removed only when empty; a deleted path that was recreated is never overwritten (`RENAME_NOREPLACE`); hard-linked files are never rewritten;
a corrupt or missing pre-image is `unrecoverable` and never applied; summarised directories are `unrecoverable`. The report lists `restored / skipped / conflicted / unrecoverable`. It is **not a transaction**:
paths are independent, an interruption leaves a valid partial state, and running it again finishes the rest (tested).

**Crash behaviour.** Recovery never reruns a command and never rolls back. A run that died stays `interrupted`; the effects are re-observed and recorded `uncertain` (`recovered-after-crash`) together with the
checkpoint's recoverability, so an operator can restore explicitly afterwards (tested end to end). Unpublished checkpoints are removed at startup; stale ACTIVE markers are cleared; retention (default 7 days)
and quota (default 4 GiB logical) apply and never collect an ACTIVE checkpoint.

**Protection.** The store is `<run_root>/_checkpoints`, mode 0700, blobs 0600, never mounted into the sandbox (tested: a command cannot list or read it) and outside the workspace root. The model can name nothing about
checkpoints (`checkpoint`, `restore`, `checkpointMode`, `preImage`, `store` arguments are refused); `exec-restore` is an issuer-capability verb and is refused while the task still has a command open.

## 3. Limitations (stated, not hidden)

* Not a point-in-time snapshot (above). A checkpoint of a tree being written by someone else can be `incomplete`.
* `.git`, dependency and build directories are not captured; secret-shaped files are never captured (their changes are `unrecoverable`).
* Hard links: a file with several names is preserved by content, but confinement cannot protect the other names (possibly outside the workspace); restore never rewrites a hard-linked file and reports a conflict. Writes through a link to a file outside the workspace are not undone.
* Restore checks a path and replaces it in two steps (a writer between them wins); restored files get the recorded mode and mtime, **not the recorded owner**; renames are handled as a deletion plus a creation, each guarded on its own.
* Reflink needs the store on the workspace's filesystem. With the default layout (daemon data and projects both under `$HOME`) that holds; elsewhere the bounded copy is used and its method is recorded.
* Timing cost: ≈ 0.12 ms/file for checkpoint creation (hash + open + clone/copy), i.e. ~2.5–3 s for 20 000 files on btrfs per in-place command, ~0.9 s on tmpfs. This is the price of verified preservation; parallelising it is possible future work.
* The crash-injection points and the ENOSPC hook exist only in builds with the `crash-injection` feature (test builds).
* The ledger record file now holds up to 20 000 paths per category (it is what a restore reads); journals and tool results carry short summaries. Direct evidence remembers at most 2 000 paths per command.

## 4. Performance and storage

Wall times are for one checkpoint and one full restore of everything the command changed. "Sparse" = 1 % of the source files rewritten, "rewrite" = all of them. Files are ~230 bytes each.

| Tree | Edits | FS | Mode used | Files stored | Checkpoint | FS growth at checkpoint | Restore (all changed) | Restored |
|---|---|---|---|---|---|---|---|---|
| 1k | sparse-edits | btrfs | reflink (auto) | 1000 | 217 ms | ≈0 | 807 ms | 10 (completed) |
| 1k | rewrite-all | btrfs | reflink (auto) | 1000 | 229 ms | ≈0 | 412 ms | 1000 (completed) |
| 1k | sparse-edits | btrfs | copy (forced copy) | 1000 | 133 ms | ≈0 | 159 ms | 10 (completed) |
| 1k | rewrite-all | btrfs | copy (forced copy) | 1000 | 130 ms | ≈0 | 423 ms | 1000 (completed) |
| 20k | sparse-edits | btrfs | reflink (auto) | 20000 | 3067 ms | ≈0 | 1043 ms | 200 (completed) |
| 20k | rewrite-all | btrfs | reflink (auto) | 20000 | 2733 ms | ≈0 | 6553 ms | 20000 (completed) |
| 20k | sparse-edits | btrfs | copy (forced copy) | 20000 | 2776 ms | ≈0 | 1360 ms | 200 (completed) |
| 20k | rewrite-all | btrfs | copy (forced copy) | 20000 | 3318 ms | ≈0 | 6701 ms | 20000 (completed) |
| large+deps | sparse-edits | btrfs | reflink (auto) | 20000 | 4442 ms | 1.1 MiB | 697 ms | 200 (completed) |
| large+deps | rewrite-all | btrfs | reflink (auto) | 20000 | 2340 ms | ≈0 | 6068 ms | 20000 (completed) |
| large+deps | sparse-edits | btrfs | copy (forced copy) | 20000 | 2616 ms | ≈0 | 890 ms | 200 (completed) |
| large+deps | rewrite-all | btrfs | copy (forced copy) | 20000 | 2627 ms | ≈0 | 5597 ms | 20000 (completed) |
| 1k | sparse-edits | tmpfs | copy (auto) | 1000 | 58 ms | 4.1 MiB | 7 ms | 10 (completed) |
| 1k | rewrite-all | tmpfs | copy (auto) | 1000 | 56 ms | 4.1 MiB | 129 ms | 1000 (completed) |
| 1k | sparse-edits | tmpfs | copy (forced copy) | 1000 | 53 ms | 4.1 MiB | 4 ms | 10 (completed) |
| 1k | rewrite-all | tmpfs | copy (forced copy) | 1000 | 45 ms | 4.1 MiB | 100 ms | 1000 (completed) |
| 20k | sparse-edits | tmpfs | copy (auto) | 20000 | 917 ms | 82.2 MiB | 98 ms | 200 (completed) |
| 20k | rewrite-all | tmpfs | copy (auto) | 20000 | 845 ms | 82.2 MiB | 2218 ms | 20000 (completed) |
| 20k | sparse-edits | tmpfs | copy (forced copy) | 20000 | 951 ms | 82.2 MiB | 78 ms | 200 (completed) |
| 20k | rewrite-all | tmpfs | copy (forced copy) | 20000 | 920 ms | 82.2 MiB | 2124 ms | 20000 (completed) |
| large+deps | sparse-edits | tmpfs | copy (auto) | 20000 | 922 ms | 82.2 MiB | 74 ms | 200 (completed) |
| large+deps | rewrite-all | tmpfs | copy (auto) | 20000 | 828 ms | 82.2 MiB | 2088 ms | 20000 (completed) |
| large+deps | sparse-edits | tmpfs | copy (forced copy) | 20000 | 949 ms | 82.2 MiB | 76 ms | 200 (completed) |
| large+deps | rewrite-all | tmpfs | copy (forced copy) | 20000 | 879 ms | 82.2 MiB | 2001 ms | 20000 (completed) |

Reading the numbers. (a) For tiny files reflink and copy cost the same, because btrfs stores files under ~2 KiB inline and the per-file open/hash/syscall overhead dominates; reflink pays off with large files:

| 64 files × 8 MiB (512 MiB) on btrfs | checkpoint time | filesystem growth at checkpoint |
|---|---|---|
| reflink | 567 ms | ≈ 20 KiB (extents shared) |
| bounded copy | 3 429 ms | ≈ 512 MiB |

(b) On tmpfs (no reflink) the method is `copy` in every case, and growth equals the logical bytes (+ block rounding: 86 MB allocated for 4.4 MB of 20 000 tiny files, since each file occupies a 4 KiB page). (c) Restore touches only changed paths: sparse edits restore in ≤ 1 s; a full rewrite of 20 000 files in 2 s (tmpfs) to 6.5 s (btrfs). (d) Dependency/build directories add **nothing** to checkpoint time or size (the "large+deps" tree has 130 000 more files). (e) An earlier run of this benchmark showed two defects that were fixed before the final run: a record list cap of 500 made a 20 000-file rewrite only 500-path restorable, and a per-file `fsync` made restore 13 ms/file on btrfs (now one `syncfs` at the end).

## 5. Crash and recovery evidence

Broker end-to-end, real daemon + Kernel + sandbox (`m3b_each_checkpoint_and_observation_boundary_crash...`), `SIGKILL` at each boundary, daemon restarted, same invariants checked each time (≤ 1 execution of the command, no `exited`/`completed`, no `.partial` checkpoint left):

| Crash point | Command ran? | Outcome after restart |
|---|---|---|
| before checkpoint creation (`checkpoint-before`) | no | run not completed; folder untouched; no ledger; nothing left behind |
| during checkpoint creation, after 2 files (`checkpoint-during`) | no | partial checkpoint removed; folder untouched |
| after the checkpoint was persisted and `prepared` journaled, before spawn (`proc-after-prepared`) | no | `interrupted`; folder untouched; the complete checkpoint is kept (evidence), ACTIVE cleared |
| after process exit, before observation (`proc-before-observation`) | yes | `interrupted`; **changes stay (no rollback)**; effects re-observed `uncertain` + checkpoint `complete`; explicit `exec-restore` afterwards restores the original files |
| during post-observation (`proc-during-observation`) | yes | same as above |
| after the ledger record was written (M3A, `proc-after-observation`) | yes | `interrupted`, record kept |
| during guarded restoration | n/a | interrupted/resumed restore finishes without harm (`max_operations` simulates the stop; second run: 4 restored + 2 skipped) |

Also: disk exhaustion mid-copy (`NEXUS_TEST_CHECKPOINT_ENOSPC_AFTER_BYTES`, test builds) → best-effort runs the command and records `unavailable: storage-exhausted` with nothing left on disk and restore `refused: no-checkpoint`; `required` refuses and the folder is untouched. `insufficient-storage` preflight is tested at the library level.

## 6. Tests

| Level | Tests |
|---|---|
| tools, simulated command against a disposable folder (real observer/checkpoint/restore) | 19: formatter rewrite (dry run, restore, restore twice), deletes with mode/mtime, created files and directories with a later user edit, user edit ⇒ conflict preserved (modified / recreated), symlinks (never followed, escaping target recorded, restored conservatively), hard links (flagged, never rewritten), dependency directories never claimed recoverable, secret-shaped files never copied, budget exclusion ⇒ `incomplete`, file changed after observation, insufficient storage leaves nothing, missing/tampered index, corrupt/missing blob, foreign workspace, interrupted + resumed restore, identity change, 1 200-file rewrite fully restorable, retention/quota/startup sweep/ACTIVE, store permissions, Direct diff against pre-images |
| tools, real sandbox | 5: real command checkpointed before it runs and restored; `required` refuses (D4) while `best-effort` runs and says so; cancelled command still restorable; Scratch unchanged + model cannot name checkpoint/restore/mode/store; the command cannot list or read the store |
| broker end-to-end (real daemon, Kernel, sandbox) | 3: `SIGKILL` at five checkpoint/observation boundaries (+ explicit restore after recovery); storage exhaustion (`best-effort` vs `required`); restore is an issuer-only operator verb (wrong credential refused, dry run, real restore, idempotent) |
| adjusted existing | M3A tests still pass unchanged; scratch assertions extended (no `_checkpoints`) |
| benchmarks (ignored) | `bench_checkpoint`, `bench_checkpoint_large_files` |

Totals on the final SHA: tools `checkpoint_m3b` 24 passed + 2 ignored benchmarks; broker `m3b_*` 3 passed; workspace +26 tests over the M3A baseline.

## 7. Validation of the final source SHA

Run once, on an otherwise idle machine, in a single sequence (no parallel heavy runs), `NEXUS_REQUIRE_SANDBOX=1`, source SHA `904602f`:

| Gate | Result |
|---|---|
| `cargo fmt --all --check`; strict clippy `--workspace --all-targets -D warnings` | clean / clean |
| Rust workspace battery | **1398 passed, 0 failed, 60 ignored** (M3A: 1372 / 0 / 58) |
| Tauri fmt + clippy; Tauri tests | clean; 27 lib, `permissions_m2` 2, `permissions_runtime_m21` 1, `runtime_update_a614` 1: all passed |
| Desktop `tsc --noEmit`, `eslint src`, `vitest run` | clean, clean, **185/185** |
| Release gate (registry-js / engines / e2e / production / release binaries / desktop binary) | PASS 22/22 / PASS 148-0 / PASS 36-0 / PASS 14-0 (negative control detected) / PASS (no test-only symbol) / PASS |
| Release gate `bodies` vs the pre-M1 baseline `8a08471` | **PASS**: 156 tests, 1617 bodies, 1446 identical, 169 volatile tool output, **0 order-only**, 2 polling-count-only, **0 unexplained** (same as the Step 0 measurement before M3A) |

History preserved: the M3A comparison first reported 33 unexplained bodies while two heavy runs shared the machine, then 0 on an idle rerun. This milestone ran the battery and the gate once, sequentially; the nondeterminism did not recur, so there was nothing to classify. Scratch request bodies are unchanged; in-place tool results carry the (bounded) checkpoint/recoverability summary, which is the only addition a provider request can see.

## 8. Verdict for M3C

**GO for M3C (Landlock / confinement), with three conditions carried forward.**

Why GO: the evidence M3C and Direct execution need now exists and is tested end to end — a verified (non-atomic) checkpoint before the command, per-path recoverability in the sealed record, a conflict-preserving restore that refuses on untrustworthy state, crash boundaries that never rerun or roll back, and the owner's D4 policy kept explicit. Nothing in M3B weakens a boundary: the store is outside the sandbox view and unreachable from it, the model has no argument or tool for any of it, and restore is an issuer-only verb.

Conditions: (1) M3C must not rely on checkpoints for safety: a checkpoint is recovery evidence, not confinement; hard-link/escape writes outside the root are only *reported*. (2) Direct execution must additionally decide the per-project `requireCheckpoint` opt-in (registry/consent) and the restore authority (today: operator verb only; a user-facing Undo is out of scope here). (3) Checkpoint cost grows linearly with project size (~0.12 ms/file); for very large Direct projects a parallel or incremental (reflink-on-write) strategy should be measured before enabling `required` by default.

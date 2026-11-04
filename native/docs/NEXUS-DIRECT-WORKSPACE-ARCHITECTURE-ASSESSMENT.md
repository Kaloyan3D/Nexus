# Direct Workspace — architecture assessment (before implementation)

Status: **assessment only; no source changed.** The decision below is needed before building.

## 1. What exists today (read from the code)
* **Opening a project snapshots it.** `nexus-tools/src/snapshot.rs` copies the folder's current files into a Nexus-owned Git repository
  (no `.git`, no secret-shaped names, no symlinks/specials, size/count caps) and the registry pins that commit
  (`ProjectRecord{managed, origin, pinned_commit, snapshot_fingerprint, trusted, write_allow, installs}`); *the user's folder is only ever read*.
* **A run executes in a per-task local clone** `worktrees/<taskInstanceId>` of that snapshot (`nexus-tools/src/gitwt.rs`). The daemon derives
  the root, the Kernel binds every approval/operation to `workspace_root_digest` (+dev/ino) of that path, the autonomous policy refuses an operation
  whose root is not `sha256(<root>/<task>)`, and the per-task identity record (`wt_meta`: project, pinned commit, `writeAllow`) lives beside it.
  `proc_run` runs in a sandbox over a throw-away copy of that tree (outputs discarded).
* **Getting changes to the folder is a separate step:** `project_adopt` (`nexus-broker/src/server.rs`) takes the run's git diff and applies it with
  `snapshot::apply_patch(origin, snapshot_fingerprint, patch)` — all-or-nothing, and refused when the folder no longer matches the fingerprint.
  **`trusted` projects already auto-adopt at the end of a completed, non-read-only run** (`pipeline.rs::auto_adopt`), unless the final verification is
  failed/uncertain. Conversations continue via `seed_copy`/`seed_rebase` (3-way per file, conflict ⇒ nothing written).
* So "the application was built but the folder is unchanged" = the project was not `trusted`, or auto-adopt declined (failed/unknown verification,
  folder changed since the snapshot, patch too large, project refreshed). Today's model is *end-of-run, all-or-nothing, patch-based*.

## 2. Two ways to make "Direct" real

### Option A — write-through (recommended): isolated copy stays the execution substrate; every approved mutation is committed to the folder immediately
Keep Kernel, approvals, daemon identity, sandbox, audit, Resume lineage and Sentry untouched. After each **executed** `fs_write`/`fs_edit` (Kernel journal
entry with pre/post sha256 already exists), the trusted side applies *that one file operation* to the real folder:
* via a new daemon-side/`snapshot` primitive that uses the same canonical-root + no-symlink + fd-relative checks as `apply_patch`, scoped to `writeAllow`;
* **preimage guard:** the folder file's sha must equal the run's expected preimage (snapshot content, or what this run last wrote). A mismatch (the user edited
  or created it since) **refuses that edit visibly** (`workspace-conflict`) and nothing is overwritten — dirty user changes can't be silently lost;
* new/deleted files follow the same guard (create only if absent; delete only if unchanged);
* a per-project lock (`direct` runs serialize; a second run on the same project is `busy`, or isolated-only) prevents concurrent conflicting runs;
* a durable **write-through ledger** per run (path, pre/post sha, time, outcome) next to the Kernel evidence makes cancel/crash/restart consistent: on restart the
  broker reconciles ledger vs folder (never guesses; reports divergence). Resume inherits the same project mode; external changes between runs surface through the
  existing `seed_rebase` conflict rules;
* project-level **mode** (`direct` | `isolated`) in the registry, chosen/shown before the first run (Desktop project settings and `nexus project … --workspace`),
  default `direct` only for *newly authorized* projects; existing projects keep isolated until changed. Engine-independent (muse-v0 / nexus-adaptive-v1 both go through the
  same tool path).
* Desktop: live changed-files list from the ledger, no Apply button in direct mode; CLI shows the same.
* Sentry: it snapshots the managed snapshot repository; direct mode must re-snapshot (new pin) *after* a run so the pin follows the folder — otherwise the next run's
  fingerprint check fails. Immutable per-revision snapshots are unaffected.
Cost: moderate (≈ new write-through primitive + ledger + project lock + registry field + UI). Commands still run in the sandboxed copy of the *current* state, which already contains every edit (edits and
runs share the same copy), so "commands operate on those same edits" holds; build outputs remain discarded exactly as today.

### Option B — true in-place: daemon/Kernel root = the folder itself
Materially harder and riskier, because the current trust model assumes an immutable, Nexus-owned, clean-Git root:
* `workspace_root_digest`/dev/ino binding, autonomous-policy root check, `wt_meta` identity and `writeAllow` are all derived from `root/<task>`;
* source must be a clean, pinned Git commit with no config that can execute code (`inspect_source`) — a user's real folder is dirty, may not be Git, may contain hooks/filters;
* diff/evidence is `git diff` against the pinned base — undefined for a dirty or non-Git folder; no preimage backup exists, so crash/cancel mid-run cannot be rolled back;
* proc_run's "copy of the tree" would copy the user's whole folder (node_modules, `.git`, secrets) on every command; `.env`-style files that snapshots deliberately exclude would become reachable;
* concurrency with the user's own editors/IDEs has no coordination at all.
It needs a new workspace-kind in daemon, Kernel and broker, a baseline manifest/undo journal and a re-proved security argument. I do not recommend it unless Option A's visible semantics prove insufficient.

## 3. Mapping to your ten tests under Option A
1/2 new/edited files appear in the folder right after the approved tool executes (integration test over the real daemon+Kernel); 3 commands see the edits (shared copy);
4 path/symlink escapes rejected by the same canonical checks (+ folder-root symlink test); 5 dirty-file guard test; 6 cancel/resume with an external edit ⇒ conflict, no loss;
7 second run on the same project refused/serialized; 8 isolated mode suite unchanged; 9 Desktop test: no Apply button, live changes; 10 Sentry re-snapshot gives a revision-consistent pin.

## 4. Decision needed
Choose the architecture (A recommended) and the default for *existing* projects. Staged plan once chosen: (1) registry mode field + CLI/Desktop choice + disclosure; (2) write-through primitive + preimage guard + ledger + lock;
(3) hook into execution + crash reconciliation + Resume; (4) Desktop live view; (5) Sentry re-snapshot; (6) tests above + full gate.

# Direct Workspace — Nexus edits the project's real folder in place

Decision (owner): **true in-place execution** (assessment option B, `NEXUS-DIRECT-WORKSPACE-ARCHITECTURE-ASSESSMENT.md`),
default **Direct for newly authorized projects**, **existing projects stay Isolated** until the owner switches them.
The isolated working copy remains available, with its patch review/export/apply flow, unchanged.

## What the user sees
* **Open a project** (Desktop): after picking the folder, a native dialog asks, in plain words, "Let Nexus edit this folder
  directly?" (Yes = direct, No = isolated copy). CLI: `nexus project open <folder> [--workspace direct|isolated]` (new projects
  default to direct and the command prints which one it chose). A project that is already open keeps its durable choice.
* **Switch later:** Projects page → "Workspace" per project, or `nexus project workspace <id> direct|isolated`. Switching to
  direct is confirmed natively. It applies to NEW tasks only; a started task never moves, and a conversation or resume never
  crosses from one kind to the other (`workspace-mode-changed`: start a new conversation).
* **A direct run** shows "Edits your folder directly", a live note, and the evidence of what changed (files, diff) with
  **no Apply step**. An isolated run keeps "Apply to my folder…" and the retained copy.
* **Standing consent** text now names both workspaces. A consent given for the older, isolated-only text is **not** accepted for
  a direct run ("give consent again in Settings"); every run's audit line records `workspaceKind`.

## Architecture (what changed, what did not)
Unchanged and reused as-is: Kernel authorization and journals, Controller intent binding (`workspaceRootDigest`), the per-run
automated workspace policy, the descriptor-relative workspace boundary (no symlinks, no `..`, same device, pinned dev/ino),
the atomic exchange-based write tool with pre-image checks and crash journaling, the sandboxed `proc_run`, engine records and
native Resume lineage. Both `muse-v0` and `nexus-adaptive-v1` go through the same tool path; the mode is engine-independent.

New:
* **Registry** (`nexus-tools::registry`): `ProjectRecord.workspaceMode` (`isolated` default; `direct` only for a managed project with a
  canonical origin folder — validated on every write). Old registries load unchanged.
* **`nexus-tools::direct`**: root validation (absolute, canonical, owned by the daemon identity, not `/`, system dirs, `$HOME` itself or
  Nexus's own data), a per-task **pre-image store** (first touch wins; 0600 files in a 0700 daemon-private tree *outside* the folder),
  a diff built **only from the paths Nexus touched**, outside-change detection, 30-day retention sweep.
* **`WriteHooks::preimage`** in the write tool: called with the exact pre-image the operation is planned over, before the intent is
  journaled; an error refuses the operation with nothing mutated. So **no edit or deletion in a user's folder ever happens without
  its original being kept**. (A no-op for isolated copies.)
* **Daemon**: `direct-open` (issuer-only; the caller names a project id, the folder comes from the trusted registry and is
  re-validated), the task's identity record `kind: direct`, `workspace-bind` for exactly that task's folder (the Kernel still demands
  the Controller-committed root digest; a bind for another task is revoked), autonomous policy / diff / stat / remove / seed
  recognise direct tasks. **`worktree-remove` on a direct task deletes only its record and kept originals — never anything in the folder.**
* **Broker**: the workspace kind is fixed on the run at submission and recorded (`workspaceKind`); **one writer per folder**
  (`project-busy`, claimed under the store lock, released when the run ends however it ends; read-only runs don't claim);
  no snapshot refresh for direct runs; `project_adopt` / auto-adopt refuse direct runs; the harness text is truthful about editing
  real files (isolated text byte-identical to before); the conversation context says so too.

## Security invariants and where they hold
| Invariant | Enforced by |
|---|---|
| No write outside the authorized root, no symlink/`..`/absolute escapes | descriptor-relative `workspace.rs` (unchanged), tested on a real folder with a symlink to an outside directory |
| Secrets, `.git`, `.ssh`… never read or written; protected names stay protected | name policy + `protect::workbench_path_check` (unchanged, applies to direct) |
| Project allowlisting / write scope | registry-derived folder + `writeAllow` frozen into the task identity; daemon re-checks |
| Pre-existing or concurrent user changes are never silently lost | the write tool's expected-pre-image checks + atomic exchange with non-destructive reversal; a stale overwrite is refused; user lines are never credited to the agent in the evidence |
| Destructive operations are recoverable | originals kept before any edit/delete (refuse otherwise); retained 30 days |
| Concurrent runs on one folder | broker writer claim (`project-busy`); a direct folder cannot be bound to another task's command |
| Crash/cancel/restart consistency | per-file atomic publication + Kernel write journal/reconciliation (unchanged); cancel keeps applied edits and their originals; restart drops no state and holds no stale writer slot |
| Resume with authenticated lineage | unchanged (`intent-resume`); direct resume reports files changed outside Nexus since the earlier run and never overwrites them |
| Audit completeness | Kernel journals + run record (`workspaceKind`, changed files from the originals vs now, `diffDigest`) + `run-authorized` audit line |
| Consent | direct needs a consent given for the text that names it |

## Tests executed (offline, real daemon/Kernel/sandbox/broker, mock model)
1 new file visible on disk right after the tool returns · 2 edit hits the right real file · 3 `cargo test` in the sandbox sees the edits and passes ·
4 `../`, absolute, symlinked-directory, `.git`, `.env` all refused, nothing outside touched or disclosed · 5 a file the user changed before and during
the run is not overwritten and not credited to the agent · 6 cancel keeps the edit; an outside edit is reported on resume and survives; broker restart
loses nothing and frees the writer slot · 7 second writer refused up front, read-only allowed, slot reusable · 8 isolated mode unchanged (copy,
untouched folder, Apply works); no cross-kind continuation · 9 Desktop (vitest): direct run shows the badge and no Apply, isolated keeps Apply, per-project workspace
control · 10 after direct edits the project can be snapshotted again: a new immutable, revision-consistent snapshot containing the edits, the previous one untouched.

"Sentry" (no Native Sentry API exists; the Desktop page is a placeholder): interpreted as Nexus's own immutable project snapshots (`snapshot.rs`), which are what a
reviewer such as Sentry would consume. Test 10 covers them. Nothing here talks to the Sentry application.

## Limitations (stated, not hidden)
* `proc_run` still runs in a sandbox over a staged copy of the folder's current files; build output is discarded, never written back. Very large folders can
  exceed the stage bounds (the command then refuses; nothing is changed).
* A crash exactly during publication can leave a hidden `.nexus-stage-*` directory in the touched folder until reconciliation removes it.
* A user-created hard link to a file outside the folder is indistinguishable from an in-folder file (the documented residual of `workspace.rs`); writes replace the
  inode and never modify the other link.
* No one-click "revert" yet: the originals are kept (and the diff shown), but restoring is manual.
* Desktop was verified through its UI tests and a browser render of real run data over a mocked bridge; the Tauri window itself, and a real-provider
  direct run, were **not** driven. Linux only; macOS/Windows unverified. R74 (issue #35) is unrelated and unchanged.

## Validation (final tested SHA `097e260`; this document is added in a docs-only commit after it)
| Check | Result |
|---|---|
| Rust workspace battery (`NEXUS_REQUIRE_SANDBOX=1`) | 1271 passed, 0 failed, 57 ignored |
| New Direct Workspace E2E (real daemon/Kernel/sandbox/broker) | 6 tests, all pass (new/edited files + commands + snapshot, escapes, dirty user changes, cancel/resume/concurrent writers, isolated unchanged, restart) |
| Pinned JS environment | 54/54 suites |
| Release gate with `--bodies` (against the previously approved baseline) | **PASS**: registry-js 22/22, engines 148/0, e2e 36/0, production 14/0, release binaries, desktop-binary; bodies 1170: identical 1080, volatile 88, polling-only 2, **0 unexplained** (isolated provider requests are byte-identical) |
| fmt; strict clippy (workspace all-targets; Tauri all-targets) | clean |
| Desktop vitest / tsc / eslint | 174/174; clean |
| Tauri tests | 27 passed, 1 ignored (+2 ignored live) |
| Desktop release build | built (7.3 MB) |
| UI render of a real run's data with `workspaceKind: direct` (browser, mocked Tauri bridge) | badge, note, no Apply |
First failures during the work and their fixes: a stale-sha assumption in my test (the broker fills the expected pre-image itself), two assertions on error codes the client surfaces as messages, a
responder replaying an edit in the third run, clippy (`too_many_arguments`, `cloned_ref_to_slice_refs`), and a renderer-API vocabulary guard that forbids "workspace" in API names (renamed `projectSetEditMode` / `project_set_edit_mode`; the guard was not weakened).

## Owner try-it (a disposable folder, not private code)
1. `nexus project open ~/nexus-test-repos/orbit-demo` (or the Desktop's "Open project…" and answer **Yes** to the direct-editing dialog). Confirm it prints/shows Workspace: DIRECT.
2. Give Nexus a task that creates a file; check the file appears in your folder while the run is still going, and that there is no "Apply" button.
3. Edit a file Nexus will touch in your editor mid-run; Nexus must refuse to overwrite it.
4. Stop a run, change one of its files yourself, press **Resume this run**: the run note must say the file changed outside Nexus and your edit must still be there.
5. Start a second task on the same project while one runs: it must be refused ("another task is editing this project's folder").
6. Switch the project to "Isolated copy" and confirm the old review/Apply flow still works.

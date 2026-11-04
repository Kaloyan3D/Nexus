# Direct Workspace live smoke — root causes, fixes, and what Direct can and cannot do

Smoke: real provider, empty Direct Workspace, project bound to Direct and consent satisfied. Fix commits: `be9320c`, `22e284c`
(final tested code SHA **`22e284c`**; this document is a docs-only commit after it). Local only; nothing pushed, merged or deployed.

## Root causes
**A. Nested files could not be written.** `fs_write` opened the *parent directory* of the target and refused when it did not exist
(`open_parent_for_write` → `not-found`): an explicit A3.3 decision, "no implicit mkdir". It never mattered in a prepared tree, but a fresh
project has no `src/` or `tests/`, and the model has no other way to make a folder (no `fs_mkdir` tool). The model's `mkdir -p` ran inside
`proc_run`'s throw-away copy and vanished.
*Exact error:* the daemon builds the approval's preview before any approval exists; the preview hit the same missing parent and returned
`not-found` ("path not found"), so the broker recorded `status: refused, errorCode: not-found, approvalOutcome: refused`.
*Presentation mismatch:* the Desktop (`describeStep`) and the outcome counter treated approval outcome `refused` as an approval decision and
printed "approval refused". `refused` only means "the request was refused before an approval existed" (policy refusal has its own code,
`policy-refused`). The model, which got the real code, was right.

**B. `proc_run` cannot persist effects (by design, unchanged).** It runs a filtered staged copy and discards it; the policy even requires
`writeBack: none`. That is not True In-Place parity and is not described as such (see the assessment).

**C. "Completed / Tests passed" despite a wrong layout.** The model's own command created `tests/add.test.js` inside the scratch copy and ran
`npm test` there; the pass was judged by exit code only. Nothing compared the scratch copy with the project, and the verified outcome made
no distinction between "a command passed in its environment" and "the project contains what it ran". Whether the *requested layout* was met is
a requirement judgement the harness cannot make from receipts; it never claimed to ("verifies the command, not that every requirement is met").

## Fixes
* **Native folder creation** (`write.rs`, `workspace.rs`): `fs_write` `create` makes missing parent folders (≤ 8 levels). Descriptor-relative,
  one level at a time (`mkdirat` + `O_NOFOLLOW|O_DIRECTORY` open, same device, owner checked); the same name policy applies to every new folder
  (hidden, VCS, secrets, `node_modules`/`target`/… refused before anything is made); a folder someone else made meanwhile is used but never claimed
  or removed; a planted symlink is refused; the intent (`createDirs`) is journaled before any folder is made and the outcome (`createdDirs`) after;
  folders are removed again if the file is never published; the direct pre-image store records them. `replace`/`edit`/`delete` still require the
  file to exist (never make folders). No change to the model-facing tool schema (catalog digests unchanged).
* **Accurate refusals:** the approval preview shows `createsDirs`; the Desktop and the outcome counter name the real error code and say what it means; "approval …"
  is used only for a real decision (denied, expired, revoked, timed out, or `policy-refused`).
* **Honest command effects:** after every workbench `proc_run`, the scratch copy is compared with what was staged and the result is journaled
  (counts), put in the tool activity (`unsavedFiles`) and shown to the model ("NOT saved to the project … use fs_write"); lock files the agent may not
  write are listed but not counted; toolchain artifacts and ignored directories are not reported.
* **Honest verification:** a passing check that wrote unsaved files yields outcome `verified-scratch`, shown as "Check passed in a scratch copy · N files it wrote were not saved";
  saving the files and re-running yields `verified-passed`. Nothing is applied or invented.
* Direct harness text now tells the model both facts (folders are made by `fs_write`; command changes are discarded).
* One regression found by the battery and fixed: a staged hidden project file (`.gitignore`) was reported as "deleted" and flipped ordinary passes to the scratch label (7 tests).

## What Direct Workspace can and cannot do now
| Can | Cannot yet |
|---|---|
| create, edit, delete files and nested folders directly in the real folder, with originals kept | persist what a command writes (mkdir, formatters, generators): reported, not applied |
| run commands over the real folder's current files and know when they changed only their own copy | `npm install` into the folder, build outputs, git operations in the folder |
| refuse escapes, symlinks, protected names, stale overwrites, a second writer | one-click revert; verify that the original *acceptance criteria* are met |
Next step (needs the owner's decision): Stage 2 in `NEXUS-DIRECT-PROCESS-EXECUTION-ASSESSMENT.md` (adopt command effects through the same guarded write path).

## Tests executed (offline; real daemon, Kernel, sandbox, broker; mock model)
New: a fresh empty project receives `package.json`, `src/index.js`, `tests/add.test.js`, they physically exist and `npm test` passes in the sandbox AND `node tests/add.test.js` passes on the host against
the real folder; folder creation cannot escape (symlinked dir, `../`, `.git`, `node_modules`, depth) with accurate codes and nothing left behind; a competing user file in a new folder is never overwritten;
a command that makes the test file only in scratch: the model is told, nothing appears in the project, outcome is `verified-scratch`, and after really saving the file the same check is `verified-passed`;
isolated nested files stay in the copy. Unit/integration: nested creation journaling and rollback, race with a planted symlink, a concurrently made folder, replace/edit/delete never making folders,
scratch-effect accuracy, outcome derivation, step wording, outcome label.

## Validation on `22e284c`
Rust workspace battery 1286 passed, 0 failed, 57 ignored (first run found the 7 regressions above; fixed and re-run) · fmt and strict clippy clean · pinned JS 54/54 ·
**release gate with `--bodies`: PASS** (registry-js 22/22, engines 148/0, e2e 36/0, production 14/0, release binaries, desktop-binary; bodies 1170: identical 1080, volatile 88, order-only 2, **0 unexplained** against the
previously approved baseline) · Desktop vitest 178/178, tsc and eslint clean.
Tauri tests 27 passed (+3 ignored live). Verdict: **READY FOR OWNER RETEST** (nested files, accurate refusals and honest command-effect reporting; persistent command effects are explicitly NOT done).

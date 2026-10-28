# Release 1 — Backend ↔ Desktop parity matrix

Branch `feature/rust-native-core` (local, unpushed). Chain per capability: **backend implementation → authorization
boundary → Tauri command → TypeScript API → state → UI workflow → tests**. Statuses are as of the final commit
(see `RELEASE1_READINESS.md`). "Before" is the status at the start of Release 1.

Classes: **FI** fully integrated · **PI** partially integrated · **CLI** CLI-only · **BO** backend-only but
user-facing · **INT** intentionally internal (not exposed, by design) · **UNS** unsupported / known limitation.
Priority: **P0** blocks the Release 1 journey · **P1** release-relevant · **P2** later.

## A. Setup and runtime

| # | Capability | Backend | Authorization boundary | Tauri / TS | UI workflow | Before → Now | Tests |
|---|---|---|---|---|---|---|---|
| A1 | Start / supervise / update the runtime | `nexus-runtime`, `interactive.rs` | none needed (own processes, owner-only sockets) | `runtime_state`, `runtime_start` | Setup card, Settings → Restart | FI → FI | `interactive.test`, `runtime_update_a614`, release1_runtime |
| A2 | Start from an **installed** package | `Tools::discover` | binaries vetted (owner/root, not group-writable, protocol-matched) | `bundled_layout`, `use_bundled_programs` | none (automatic) | **missing → FI (P0)** | `bundle_tests`; shipped `.deb` binary reached *Ready* |
| A3 | Start-up failure guidance | runtime error text | – | `startupHelp.ts` | Setup card steps (no Node.js, missing programs, long data path) | PI → FI | `outcome.test`, `release1_missing_prerequisites` |
| A4 | Provider connection (OpenCode Go only) | `connect_provider` | key typed in a NATIVE password dialog, never in the page | `provider_connect` | Setup card, Settings | FI → FI | `interactive.test` |
| A5 | Autonomy consent | `consent_*` | exact broker text confirmed natively; digest-bound | `provider_consent/revoke` | Setup card, Settings | FI → FI | `interactive.test`, `permissions_m2` |
| A6 | Engine preference + Nexus Adaptive setup | `engine_choice`, `enable_adaptive` | billable checks behind a native confirmation | `engine_*`, `adaptive_setup` | **Setup step** (was Settings-only); Settings | PI → FI | `interactive.test` (setup step) |
| A7 | This-computer checks (dialog tool, sandbox, browser opener, toolchains) | `environment_check`, `permissions.inPlaceAvailable` | read-only | `environment_check` | Setup card, Settings → This computer | missing → FI | `release1.test` (findings) |
| A8 | Supported providers other than OpenCode Go | – | – | – | none | UNS | not offered (no invented support) |
| A9 | Windows / macOS | – | – | – | – | UNS | not validated; Linux only |

## B. Projects and permissions

| # | Capability | Backend | Authorization boundary | Tauri / TS | UI workflow | Before → Now | Tests |
|---|---|---|---|---|---|---|---|
| B1 | Open / refresh / forget a project | `project-open/refresh/forget` | native folder picker; renderer names no path; forget confirmed natively | `project_pick/refresh/forget` | Projects page, composer "Open…" | FI → FI | `interactive.test` |
| B2 | Edit mode: real folder vs copy | `project-workspace` | direct needs a native yes | `project_set_edit_mode` | "Edit files" row | FI → FI (de-jargoned) | `interactive.test` |
| B3 | Commands in the project folder ("Allow Nexus to edit this project") | grant `fs=workspace` | broker consent text, digest, native yes | `project_allow_work` | row + on-demand card | PI (advanced editor only) → FI | `release1_native`, `release1_runtime`, `release1.test` |
| B4 | Dependency downloads | grant `net=install` / legacy `installs` | native yes (legacy switch now also confirmed) | `project_allow_installs`, `project_set_policy` | row + on-demand card | PI (two overlapping controls) → FI | same |
| B5 | **Local development previews (devPorts)** | grant `devPorts`, JobManager gate | broker consent text lists the ports; native yes; additive, 1024–65535, ≤8 | `project_allow_previews/revoke_previews` | row (port picker) + on-demand card | **CLI → FI (P0)** | `release1_native`, `release1_runtime`, `release1.test` |
| B6 | Granular grants: expiry, Controlled Internet hosts/presets/local ports, approval mode | `project-grant*` | as B3 | `project_set_grant` (now keeps what it doesn't offer) | Projects → Advanced permissions | FI → FI (moved under Advanced) | `interactive.test`, `release1_native` |
| B7 | Preserve checkpoint / hard-link / Git-write / dev-port choices when editing a grant | – | – | `project_set_grant_keeping` | invisible | **defect (silent reset) → FI** | `release1_native` |
| B8 | Full Access / full network | `fs=full` | host-exec build flag, native yes | advanced editor | Advanced only, flagged | FI → FI (never a default, never via simple rows) | `release1.test` |
| B9 | Git metadata writes (`gitWrite`), git worktree access | grant `gitWrite` | explicit | none | – | CLI → **INT/CLI by decision** (high-risk; kept only if already set, never offered) | `release1_native` (kept, not widened) |
| B10 | Ask-before-each-action approvals | independent approver (separate credential) | terminal approver only | – | **disabled for Release 1 by decision**: the application never creates it, the choice is hidden/disabled with the reason, `askAvailable=false` is reported, and a project that already asks can be switched to automatic through a native confirmation | PI → **OFF by decision** (no approver is reachable from the app, so none is offered) | `permissions_runtime_m21`, `release1_native`, `release1.test` |
| B11 | Trusted workspace (auto-apply for copies) | `project-policy trusted` | now native-confirmed | `project_set_policy` | Advanced | FI → FI | `release1_native` |
| B12 | Apply a copy's patch | `project-adopt` | native confirm lists files | `project_adopt` | run actions | FI → FI | `interactive.test` |

## C. Tasks and conversations

| # | Capability | Backend | Tauri / TS | UI | Before → Now | Tests |
|---|---|---|---|---|---|---|
| C1 | New / continue conversations, review-only vs editable | `thread-*`, modes auto/review/edit | `thread_*` | composer + thread view | FI → FI | `threads.test` |
| C2 | Project composer without model/route/request-mode pickers | `intent-code-*`, `new_task_selection` | `thread_send` | `ProjectComposer` | PI (operator composer) → FI | `interactive.test` |
| C3 | Persist across restarts; many projects/conversations | thread store | `thread_list/get` | thread list, last-open restore | FI → FI | `threads.test`, `release1_runtime`, live |
| C4 | Cancel | `intent-cancel` | `intent_cancel` | Stop | FI → FI | `threads.test`, live |
| C5 | Resume (broker decides) | `intent-resumable/resume` | `run_resumable`, `intent_resume` | Resume control | FI → FI | `threads.test`, live |
| C6 | Archive; rename | `thread-update` | `thread_update` | archive only | PI → PI (rename not offered; P2) | – |
| C7 | Engine / effective capability shown | engine summary | `run_engine` | engine activity, composer line | FI → FI | `engine.test` |
| C8 | Ask (text-only) / Inspect (read-only workspace) | `intent-submit/inspect` | `intent_*` | strict-profile composer only | FI (operator profile) → unchanged; not shown to ordinary users | `composer.test` |

## D. Background jobs and previews

| # | Capability | Backend | Authorization | Tauri / TS | UI | Before → Now | Tests |
|---|---|---|---|---|---|---|---|
| D1 | Model starts/queries/stops jobs | `job_*` tools in `nexus-adaptive-v1` | frozen grant, devPorts, revocation watcher | – (broker-side) | activity steps | FI → FI | `aj_*`, `aj2_*` |
| D2 | Why a job was refused / what was asked | run record `errorCode`, `argsSummary`, `requestedPorts` | display only | `ToolActivity` | on-demand cards | **missing → FI** (run-record only; model text unchanged) | `rel1_*`, `aj_` |
| D3 | List jobs per project | `job-list {projectId}`; `projectId` on records | uid-gated socket | `job_list(project)` | Running panel (thread, composer page, Projects) | PI (unlabelled global list) → FI | `jobs_m7`, `release1.test` |
| D4 | Job logs | `job-logs` | bounded, redacted | `job_logs` | Show log | CLI → FI | `release1_runtime`, `release1.test` |
| D5 | Open a preview | job record host port | address from the broker; only `http://127.0.0.1:<port>`; `xdg-open` | `preview_open` | Open preview / Copy | **missing (a dead `target=_blank` link) → FI** | `release1_native`, `release1_runtime` |
| D6 | Stop a job | `job-stop` | – | `job_stop` | Stop | PI → FI | `release1.test` |
| D7 | Jobs vs restart / revoke | reconcile → `interrupted`; watcher | – | state labels | "Interrupted when Nexus restarted" | FI → FI | `release1_runtime`, live |
| D8 | Watch-style servers (`next dev`, `cargo watch`) | – | – | – | – | UNS (untested, noted in the Adaptive+Jobs report) | – |
| D9 | Jobs with network | – | – | – | – | UNS (jobs are offline-class) | – |

## E. Verification and evidence

| # | Capability | Backend | UI | Before → Now | Tests |
|---|---|---|---|---|---|
| E1 | Receipt-derived outcome (tests/commands/edits) | `codingOutcome`, `completion` | badges, Evidence panel | FI → FI | `code.test`, `integrity.test` |
| E2 | Six result categories (verified / not verified / failed / refused / stopped / unavailable) | derived from receipts | one word on every run | PI (scattered labels) → FI | `outcome.test` |
| E3 | Changed files, diff, test output, command receipts | `intent-diff`, transcript | Diff / Test output / Evidence tabs | FI → FI | `code.test` |
| E4 | Model text never shown as verification | – | enforced by E2 | FI | `outcome.test` |

## F. Recovery

| # | Capability | Backend | Authorization | Tauri / TS | UI | Before → Now | Tests |
|---|---|---|---|---|---|---|---|
| F1 | What a command changed (effects) | `exec-effects` | read-only | `exec_effects` / `commandEffects` | Evidence & recovery | **CLI → FI** | `release1_native`, `release1.test` |
| F2 | Guarded restore of command effects | `exec-restore` (dry run + digest) | native yes; renderer supplies only the reviewed digest; stale digest refused; refused while a command runs; audited | `exec_restore_preview/apply` | Review recovery → Restore | **CLI → FI** | `release1_native`, `release1.test`, live |
| F3 | Restore of **file edits** (and files Nexus created) made directly in the folder | `direct-restore-preview` / `direct-restore` (`edit_restore.rs`): digest-bound preview, atomic swap with verification, hard-link/symlink/protected-path refusal, daemon audit | native yes; renderer supplies only the reviewed digest; stale digest refused; changed-since files left alone | `edits_restore_preview/apply` | Evidence & recovery → *N file edits by Nexus* → Restore changes… | **UNS → FI** | `edit_restore_rel1` (10), `code_a56::rel1_direct_run_edits_are_restorable…`, `release1_native`, `release1.test`, **installed-package GUI run** |
| F4 | Edits outside the folder, downloads, dependency dirs | – | – | – | "not a universal undo" text | UNS (by design) | `release1.test` |

## G. Shell and packaging

| # | Capability | Before → Now |
|---|---|---|
| G1 | Sidecars + Registry bridge in the bundle | **absent → shipped** (`bin/`, `repo/config/registry/` incl. `modes/`) |
| G2 | Package dependencies | webkit/gtk only → + `libc6 (>= 2.39)`, `bubblewrap`, `systemd`, `util-linux`, `zenity \| kdialog` (+ recommends `xdg-utils`, `git`). **No Node.js dependency**: a pinned, verified Node.js v24.22.1 (npm 11.19.1) ships in `/usr/lib/Nexus/node` |
| G2a | Private Node.js | **none → bundled**, SHA-256/signature checked at packaging, ELF/arch/version checked at run time, last-resort toolchain for commands (project-specific toolchains still win), never added to the user's PATH |
| G2b | Git metadata created by commands/background jobs | **window open → neutralised** when the creating command/job ends (hooks, dangerous config keys, `.git` pointer files; quarantined originals) — see Readiness §6 |
| G3 | Sentry page (no data source) | primary navigation → moved to Advanced, labelled "not connected" |
| G4 | Mock runs, Controller ledger, Control Room | Advanced (INT/diagnostic) — unchanged |
| G5 | Integrity status | Control Room (INT) |

## Deliberately not exposed

Issuer / approver / witness credentials, daemon socket, raw grant digests as inputs, `gitWrite` as a control, Full
Access as a default, any path, URL, tool or limit as a renderer parameter, model-selectable permissions.

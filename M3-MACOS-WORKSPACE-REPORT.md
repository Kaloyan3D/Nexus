# M3 — Seamless macOS workspaces

Status: **implemented and validated through the real Mac-side code, the real SSH bridge and the real Fedora engine. The Nexus.app window
was NOT clicked or inspected** (no screenshot/accessibility access in this session). Nothing is committed.

## 1. Audit → architecture

Findings that shaped the design:

* The broker already registers a **guest folder** as a project (`project_open_with`, then `project_set_workspace(direct)`); its
  `validate_origin` forbids folders under `NEXUS_HOME`/`~/.config`/… so Mac projects are staged under their own root `~/NexusMac/<id>/`.
* Direct Workspace = the engine edits the registered folder. For Mac projects that folder is the guest-native working copy; the Mac
  folder is only ever written by the verified writeback. The engine's own snapshot rules (skip dirs, secret names, no symlinks,
  4 MiB/file, 60 000 files, 512 MiB) are the reference for the Mac-side filter (`sync/policy.rs`, `sync/manifest.rs`).
* Run verdicts come from the broker run record (`state`, `completion`, `codingOutcome.verification`, …) — the writeback gate.
* Peer-credential auth does not cross SSH (M2 review); sync verbs therefore live on the existing restricted stdio bridge.

```
Mac                                                       Fedora guest (uid 1000)
Coordinator ── Registry+consent+baseline (Mac only)       nexus-bridge ── GuestStore (~/NexusMac only)
  │  open_project / preflight / tick / serve                 │  stage-* / export-*  (no exec, no free paths)
  ├─ host::stage_project ── SyncReq over the bridge ───────► stage → verify → publish → broker project (direct)
  ├─ host::writeback_run ◄─ export-plan/read ───────────────  working copy vs trusted baseline
  │   qualify → download+hash → conflicts → backup → journal → apply → baseline → ack
  └─ UI: project `sync`, run `hostSync` (Mac path only)
```

Trust boundaries: renderer → Tauri ACL (unchanged; the Mac path never reaches it); Mac host (consent, baseline, conflict decisions,
journal); SSH/bridge (restricted key, fixed verbs); guest staging root; broker/Kernel/sandbox (unchanged, authoritative for the run).

## 2. What was built

| Stage | Where | Notes |
|---|---|---|
| M3.1 registry + snapshot | `sync/registry.rs`, `sync/policy.rs`, `sync/manifest.rs`, `sync/host.rs::validate_root` | Stable id, root path + (dev, ino) identity, guest mapping, scope+consent, baseline manifest (per-file size/SHA-256/exec bit), generation, last sync, runs and states. Native picker only. Rejects system/home/credential/app-data roots. Deterministic sorted scan; Git data, secrets, build/cache dirs, links, sockets/devices, `.DS_Store`, >4 MiB files are skipped **and listed** (count + first 100). Case-folding and Unicode-normalization collisions, >60k files, >512 MiB are hard errors, never silent drops. |
| M3.2 transfer | `sync/wire.rs`, `sync/guest.rs`, `bridge_proto.rs` (v2) | Versioned (proto 2, sync 1), 256 KiB base64 chunks, per-file + total limits, SHA-256 on every file, change-list digest, resume from a byte offset, guest baseline-digest check, atomic first publication (build dir → one rename), journaled per-file publication for refresh (`publish.json`, finished on the next call). Guest refuses to refresh over unexported changes or while a task runs. |
| M3.3 integration | `linux_app/bridge.rs` (`register_project`), `sync/coordinator.rs` | After commit the bridge opens the staged folder through the real broker API as a Direct project; mapping Mac id ↔ broker project id ↔ run ids ↔ generations is durable. Before each `thread_send` the Mac folder is re-scanned and the engine copy refreshed (never over an active run or unexported changes). Linux sandbox/policy untouched. |
| M3.4 writeback | `sync/host.rs::writeback_run` | Gate = broker verdict (`completed`, not cancelled, no error, `verified-passed`, no unresolved/uncertain checks, not stale after edit, completion fulfilled/no-change-verified) **and** standing consent. Changed set = real guest working copy vs the trusted baseline. Mac re-validates paths/limits, downloads + re-hashes into Mac staging, compares every affected file with the Mac baseline (content, deletion, rename/case collision, type, symlink ancestor, exec bit), backs up, journals, applies per file (tmp + atomic rename; exclusive create via hard-link), updates baseline, then acknowledges the engine (idempotent). Create/edit/delete/rename handled. |
| M3.5 recovery | `sync/host.rs::resume_journal`, `recover_project`, `Fault` seam | States `staging/running/exporting/prepared/applying/applied/conflict/failed` (+ `not-applied`). Journal fsynced after every step. Restart reconciles by **observing the files**: each op is classified untouched/finished/other; finished → complete, untouched → roll forward, other → roll back and report conflict. Disk-full/permission errors roll everything back. Duplicate completion events and repeated attempts are no-ops. Conflicts keep the person's files untouched and Nexus's result under the app's data folder; later retry through the project's existing "Apply" (`project_adopt`). |
| M3.6 UI | `features/sync/HostSyncNote.tsx` + 4 small edits | Projects page shows the Mac path and sync state; thread runs show a plain status line ("Applied to your Mac folder" vs "the task has finished; its changes are not on your Mac yet"), changed files, conflicts. "Edits your folder directly" and the per-run Apply button are suppressed for Mac projects; no transport details shown. |

## 3. Validation

**Automated (Mac)** — cargo fmt/clippy `-D warnings` clean; Rust tests: **53 pass, 9 live ignored** (17 sync e2e: staging filters, refresh, resume,
corrupt chunk, path escape, exactly-once writeback, non-qualifying runs, conflicts of every kind, crash mid-apply + recovery, disk full,
edit during apply, unacked ack, hostile plan; 7 coordinator e2e; 7 transport; unit tests); frontend: typecheck/lint/build/deps ok,
**258 vitest pass** (+5 for sync status).

**Automated (Fedora)** — fmt, clippy `-D warnings` (default and `engine-bridge`), `cargo test --no-fail-fast` in a delegated cgroup with
`NEXUS_REQUIRE_SANDBOX=1`: all pass, including the portable sync suites on Linux and the existing real-sandbox runtime tests.
`native/` (Kernel, broker, sandbox) untouched, so the 1 663-test workspace suite was not re-run.

**Live, real engine** (`tests/live_m3.rs`; disposable Node project on the Mac; real coordinator + SSH bridge + model + sandbox):

| # | Scenario | Result |
|---|---|---|
| 1–6 | Select folder, consent, stage, real task "add `multiply` + test, run `npm test`" | engine `completed / fulfilled / verified-passed`; Mac `calc.js` updated automatically; `.env` and `node_modules/` never copied; host `node --test` passes |
| 7–8 | Edit README on the Mac, second task (`subtract`) | engine copy refreshed first; both functions present; the person's README edit survived |
| 9 | Host edits `calc.js` while Nexus works on it | `conflict`; the person's file untouched; Nexus's version preserved; next task refused until resolved |
| 10 | Kill the SSH process mid-run, then restart the whole app (new process, same registry) | link recovered; restarted app resumed the run from the registry and applied it once |
| 10 | Kill broker+daemon on the guest mid-run | broker closed the run honestly; `not-applied`; Mac folder untouched; engine restarted by the bridge |
| 11 | Repeated ticks / completion events | generation unchanged, no second write |
| 12 | Cancelled run; run with failing checks (`verified-failed`) | `not-applied`; Mac files untouched |

## 4. Findings fixed on the way

* A daemon restarted from an SSH session cannot create its sandbox cgroup → forced command now runs under `systemd-run --user --scope -p Delegate=yes`
  (this also repaired the engine after my engine-kill test; it now restarts under the bridge). `authorized_keys` command changed (please review).
* A network cut left orphan bridges (half-open TCP) → bridge exits after 90 s of silence (verified: ended at 100 s).
* ssh option values with spaces (`Application Support`) needed quoting (M2); host-key pinning verified again.

## 5. Not verified / limitations (accurate)

* **GUI**: the Nexus.app window, native picker/consent dialog and the status UI were not seen or clicked. The live scenarios drive the same Rust code the app uses;
  the consent dialog is scripted to "Allow" in tests. A rebuilt ad-hoc-signed app launched by Finder/`open` is blocked by macOS **Local Network** privacy
  ("No route to host") until you allow Nexus in the system prompt / System Settings → Privacy → Local Network (runs launched from a terminal inherit its permission).
* **Atomicity**: APFS offers no multi-file transaction. Publication is a recoverable journaled protocol (per-file atomic rename, rollback from backups, observed-state
  recovery), not all-or-nothing at every instant. A person's write landing between the final pre-rename check and the rename (a sub-millisecond window) cannot be detected
  for in-place replacement; creation uses exclusive link and cannot overwrite.
* A run that finishes while changes from an earlier **non-qualifying** run are still unexported in the engine will export both together (the later run's checks verified the tree);
  they are not silently applied by the failed run itself.
* Only one project operation at a time; engine-wide refreshes wait while any task runs (`engine-busy`). Conflict resolution is: restore your file then "Apply" retries, or remove the project;
  there is no merge UI. A crash between `thread_send` returning and the run being recorded would orphan that run's writeback (small window; the run's result stays in the engine).
* Symlinks are never synchronized (reported). Guest address and paths are configuration; UTM is only the current backend.
* Engine killing was tested at daemon level, not a VM reboot.

## 6. Linux regression risk

Linux code changes: none in `native/`; desktop crate only gained `invoke_handler()` extraction, `Runtime` accessors (M2), the feature-gated bridge, and shared portable sync modules
(no behaviour change for the Linux window). Full desktop-crate suite incl. real sandbox runtime passes on Fedora.

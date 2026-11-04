# M1 — Native macOS Desktop (Apple Silicon)

Status: **builds, packages and launches; GUI not visually inspected** (see "Not verified").
Nothing is committed.

## 1. Initial findings (reproduced on M1 Pro, Rust 1.99.1, `aarch64-apple-darwin`)

| # | Blocker | Class |
|---|---------|-------|
| 1 | No Rust toolchain installed | environment (installed `rustup` via Homebrew, with approval) |
| 2 | `nexus-store/ext_witness.rs`: `libc::ucred`, `SO_PEERCRED` | compile (Linux-only) |
| 3 | After #2, `nexus-tools` fails with ~30 errors: Landlock, `openat2`, `O_PATH`, `prctl`, `renameat2`, `syncfs`, seccomp syscalls | compile (Linux-only security core) |
| 4 | `build.rs` panics: resource `native/target/release/nexus-confine` missing (config packages 5 Linux binaries + node + repo) | packaging |
| 5 | Frontend | none — typecheck/lint/tests/build all pass |

Conclusion: `nexus-client` → `nexus-tools` is Linux-bound, so making the shell compile on Darwin by gating
the sandbox code would be the wrong direction. The macOS shell must not link `nexus-client` / `nexus-runtime`.

## 2. Architecture

```
lib.rs  (router)               dto.rs / dialogs.rs (trait) / engine.rs   <- shared, all platforms
 ├─ linux_app.rs  (= old lib.rs, + backend.rs, interactive.rs)  nexus-client, nexus-runtime
 └─ macos_app.rs  (desktop-only host)                           no engine crates linked
```

* `engine.rs` — the **M2 seam**: `EngineLink` trait → `EngineStatus` (today only `Unavailable`), `NoEngine`,
  stable error code `engine-unavailable`. M2 adds a guest-backed `EngineLink`; no host rewrite needed.
* `macos_app.rs` — answers 6 commands locally (`app_info`, `runtime_status`, `list_tasks`, `runtime_state`,
  `environment_check`, `project_pick`) with explicit unavailable states; **every other registered command**
  is rejected by one catch-all in the invoke handler with `engine-unavailable` (no per-command stubs, same
  names, same `build.rs`/capability file, same ACL). `run_mock`, `runtime_start`, submit/grant/restore etc.
  are deliberately *not* local (unit-tested).
* `project_pick`: native picker; cancel → `cancelled`; a chosen folder is **dropped** (not stored, not
  forwarded, nothing granted) and the call returns the unavailable error.
* Dialogs: `dialogs/macos_dialogs.rs` uses `rfd` (NSOpenPanel / NSAlert) on the main thread inside the Rust
  process; no JS dialog plugin, no new capabilities. Confirmation default button (Return) is **Cancel**;
  `secret()` fails closed (no secure-entry panel yet; unused in M1). Linux `kdialog`/`zenity` code unchanged.
* Cargo: engine crates are `cfg(not(target_os="macos"))` deps; `rfd` is macOS-only.
* Packaging: `tauri.macos.conf.json` (auto-merged on macOS) clears `bundle.resources`, targets `app`/`dmg`,
  min macOS 12. Base `tauri.conf.json` (Linux, deb) is untouched. CSP and `freezePrototype` unchanged.
* Frontend (minimal, same design): new `RuntimeState.phase = "unavailable"`; TopBar pill "engine not connected"
  (warning tone), SetupCard shows an explanatory card instead of fake setup steps, Settings disables
  provider/consent buttons and shows the message, polling cadence, and no Linux-tool env warnings on macOS.

## 3. Files changed

Rust: `src/lib.rs` (router), `src/linux_app.rs` (git-renamed old `lib.rs`; diff = module/import lines +
6 `include_str!` paths), `src/engine.rs`, `src/macos_app.rs`, `src/dialogs.rs` (cfg gates),
`src/dialogs/macos_dialogs.rs`, `Cargo.toml`, `Cargo.lock` (+rfd, macOS-only), `tauri.macos.conf.json`,
9 files in `tests/` (`#![cfg(not(target_os = "macos"))]` — they need the Linux engine).
Frontend: `contracts.ts`, `TopBar.tsx`, `SettingsPage.tsx`, `SetupCard.tsx`, `EnvironmentNotes.tsx`,
`NexusContext.tsx`, `test/release1.test.tsx` (the "macOS warns" assertion now uses `windows`; macOS expects none),
new `test/engineUnavailable.test.tsx`. `native/` is untouched.

## 4. Automated verification (macOS, this machine)

| Check | Result |
|-------|--------|
| `npm ci` | ok |
| `npm run typecheck` / `lint` | pass |
| `npm test` | **253/253** (251 prior + 2 new) |
| `npm run build` / `check:deps` | pass |
| `cargo fmt --check` | pass |
| `cargo clippy --all-targets -D warnings` | pass |
| `cargo test` (macOS) | **4/4** (engine + macos_app); Linux integration tests compiled out |
| `npm run tauri -- build --bundles app` | **Nexus.app, arm64, 4.96 MiB**, id `ai.arthurlabs.nexus.desktop`, icns, no Resources besides icon, no Linux binaries, ad-hoc signed (no Apple credentials) |

## 5. Runtime smoke (process level only)

Launched via `open` and directly, twice (close + reopen): process stays alive, **0 child processes, 0 sockets**,
no `nexusd`/`nexus-broker`/`nexus-confine`/`bwrap`; empty stdout/stderr (no panic output). UTM/QEMU processes
visible in `ps` predate the app (started 18:45) and are unrelated.

## 6. Not verified (honest limits)

* **No GUI inspection.** The session has no screenshot/accessibility/computer-use access, so I did **not**
  see the window, navigate pages, exercise the native folder picker/cancel, or check the console for frontend
  exceptions. The rfd main-thread dialog path is therefore **untested end-to-end**. Checklist for you:
  open Nexus.app → pill reads "Nexus engine not connected" → visit each page → Projects → open folder:
  picker appears; Cancel is quiet; choosing a folder shows the "was not opened… nothing granted" message →
  Cmd+W / Cmd+Q / reopen.
* `npm run tauri -- dev` not run (same GUI limitation).
* **Linux not compiled or tested here** (no Linux host in this session). Risk is low but unproven:
  `linux_app.rs` differs from old `lib.rs` only in module/import lines and `include_str!` paths; `interactive.rs`,
  `backend.rs`, `dto.rs` unchanged; `dialogs.rs` only gains `cfg(not(macos))` on Linux items. Please run the
  desktop crate's test suite and `cargo check` on the Fedora ARM64 box before merging.
* Minor: Cargo.lock gained entries needed only by macOS targets; bundle is ad-hoc signed/unnotarized.

## 7. Remaining for M2

Implement a guest `EngineLink`, make `runtime_state` report `ready` through it, route engine commands through
the authenticated channel (no generic HTTP/shell bridge), and decide the secure secret-entry dialog on macOS.

# Nexus desktop (A2.5)

Native desktop GUI for Nexus: Tauri v2 + Rust + React + TypeScript. Nexus Nova (the AI orchestration) is
what it talks to; this app is just "Nexus".

```
React + TypeScript UI -> typed Tauri commands/channels -> nexus-client v1 -> daemon IPC -> Kernel
```

React never touches SQLite, CLI stdout, issuer keys or provider credentials, and contains no model routing.

## Environment

| Variable | Purpose |
|---|---|
| `NEXUS_SOCKET` | daemon socket |
| `NEXUS_LEDGER_DIR` | Controller state dir (`.ai-harness/state`); runs dir defaults to its sibling `runs` |
| `NEXUS_RUNS_DIR` | attempt journals override |
| `NEXUS_DSH_SESSIONS_DIR` | historical session logs (default `~/.local/share/nexus/data/sessions`) |
| `NEXUS_TRANSCRIPT_DIR` | native transcript store (default `~/.local/share/nexus/native/transcripts`) |

## Fedora 44 ARM64 development

Install the native desktop prerequisites once:

```bash
sudo dnf install gtk3-devel webkit2gtk4.1-devel librsvg2-devel patchelf
```

With Rust/Cargo, the C build tools and Fedora Node.js 22 available:

```bash
source ~/.cargo/env
cd ~/Projects/Nexus/apps/nexus-desktop
npm ci
npm run desktop
```

`npm run desktop` builds the matching native services with two Cargo jobs, then
starts Vite and the Tauri window. Development state defaults to
`~/.nexus-interactive-dev`; an existing `NEXUS_HOME` setting is respected.
`NEXUS_BIN_DIR` can point at a separately built matching native workspace.
The development configuration uses system Node.js and excludes staged release
resources. The release packaging scripts currently target x86_64 Debian/Ubuntu.

For a standalone debug executable using the built frontend:

```bash
CARGO_BUILD_JOBS=2 npm run tauri -- build --debug --no-bundle \
  --config src-tauri/tauri.dev.conf.json
```

The binary is `src-tauri/target/debug/nexus-desktop`. From this checkout it finds
services under `native/target/debug`; set `NEXUS_BIN_DIR` explicitly when using
another build directory. Set `NEXUS_HOME` consistently with the development
launcher to use the same provider and project settings.

### Fedora ARM64 setup verification

Verified on Fedora 44 KDE/Wayland with Node.js 22.23.1, GTK 3.24.52 and
WebKitGTK 2.54.2:

- TypeScript, ESLint, web build and dependency-boundary checks passed.
- Frontend: 251 tests passed across 24 files.
- Native desktop backend: 28 unit tests passed, 1 ignored; formatting and
  all-target Clippy passed.
- `release1_runtime`: the real runtime/preview integration test passed with
  `NEXUS_REQUIRE_SANDBOX=1`, with no skip.
- ARM64 native window launched and rendered the setup screen; the supervised
  runtime reported Ready. Provider setup is completed in the application.
- Package-content tests: 2 passed, 4 explicitly skipped because the existing
  release verifier targets x86_64 Debian packages. ARM64 installer validation
  remains separate from this development setup.

For checkout-only native backend checks, set the development resource override
before running Cargo in `src-tauri`:

```bash
export TAURI_CONFIG='{"bundle":{"active":false,"resources":[]}}'
cargo fmt --check
CARGO_BUILD_JOBS=2 cargo clippy --all-targets -- -D warnings
cargo test --lib -j 2
NEXUS_REQUIRE_SANDBOX=1 cargo test --test release1_runtime -j 2
```

The native workspace must be built first for the runtime integration test.
Local setup logs are `/tmp/nexus-desktop-*.log`; the visual smoke capture is
`/tmp/nexus-desktop-smoke.png`. EGL/DRI2 warnings appeared in this VM, but the
Wayland window rendered correctly. No graphics, WebKit sandbox or SELinux
security settings were changed.

## Prerequisites (CachyOS / Arch)

```bash
sudo pacman -S --needed webkit2gtk-4.1 gtk3 libsoup3 base-devel nodejs npm rustup
```

## Run

```bash
cd apps/nexus-desktop
npm install
# optional: point at a running daemon and the Controller ledger
export NEXUS_SOCKET=/path/to/nexusd.sock
export NEXUS_LEDGER_DIR=/home/$USER/Projects/Nexus/.ai-harness/state
npm run tauri -- dev
```

Daemon (read-only mode, short socket path required by `SUN_LEN`):

```bash
cd native && cargo build -p nexus-daemon
mkdir -m 700 /tmp/nx && ./target/debug/nexusd --db /tmp/nx/k.db --socket /tmp/nx/n.sock --witness /tmp/nx/k.wit
```

## Build

```bash
npm run tauri -- build --debug --no-bundle     # binary: src-tauri/target/debug/nexus-desktop
npm run tauri -- build                         # release bundle
```

## Checks

```bash
npm run typecheck && npm run lint && npm test && npm run build && npm run check:deps
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

## Tauri commands (the renderer's entire capability set)

`app_info`, `runtime_status`, `list_tasks`, `task_journal`, `model_catalog`, `live_blockers`, `run_mock`,
`conversation_read`, `model_io_read`, `list_mock_conversations`.
`build.rs`, `capabilities/main.json` and the handler list are cross-checked by unit tests.
No fs, shell, http or opener plugin is installed.

## Conversation scroll policy

- Historical (DSH) conversations open on the latest message.
- Native and mock conversations open at the top so the submitted prompt is visible; a "Jump to latest"
  control appears when more content follows.
- New output is followed only while the viewport is already at the bottom; scrolling up is never overridden.
- Loading earlier records keeps the visible message in place; expanding a tool call never moves the viewport.

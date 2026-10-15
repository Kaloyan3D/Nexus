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

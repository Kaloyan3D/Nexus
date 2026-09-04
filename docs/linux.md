# Nexus on Linux

Nexus runs natively on Linux — the same deterministic controller, the same task state, the same verification and operator gates as on Windows. This guide covers the Linux-specific installer, layout, PATH setup, updates, and troubleshooting.

## Requirements

- Linux x86_64 (tested target: Arch/CachyOS; any glibc distribution with the tools below works)
- git, tar, xz, sha256sum, and curl or wget (install with your package manager, e.g. `pacman -S git curl`)
- A DeepSeek API key (optional ChatGPT/Codex authentication for independent review)
- No sudo, no root: everything installs inside your home directory

Node.js and PowerShell are NOT system requirements: the installer downloads pinned, checksum-verified per-platform builds into the install root (`config/versions.json` pins `NodeVersion` and `PowerShellVersion`).

## Install

```sh
git clone https://github.com/Kaloyan3D/Nexus.git
cd Nexus
./setup.sh
```

Flags:

| Flag | Effect |
| --- | --- |
| `--install-root DIR` | Install somewhere else (default `~/.local/share/nexus`; also `AIH_INSTALL_ROOT`) |
| `--reset-managed-settings` | Replace the managed `settings.yaml` (never touches credentials or task state) |
| `--skip-deepseek-login` | Skip the DeepSeek key prompt |
| `--skip-openai-login` | Skip the ChatGPT/Codex sign-in |
| `--skip-dependency-install` | Skip `npm ci` (requires an existing DSH runtime) |
| `--skip-path-check` | Skip the PATH check at the end |

The installer is idempotent: re-running it updates an existing install and preserves your settings, credentials, and controller state unless you pass `--reset-managed-settings`.

## Install layout (XDG)

| Path | Contents |
| --- | --- |
| `~/.local/share/nexus/` | Install root |
| `~/.local/share/nexus/app/` | Pinned DSH runtime application (`npm ci` closure) |
| `~/.local/share/nexus/runtime/node/` | Pinned Node.js (Linux `tar.xz`, SHA256-verified) |
| `~/.local/share/nexus/runtime/pwsh/` | Pinned PowerShell (Linux `tar.gz`, SHA256-verified) |
| `~/.local/share/nexus/config/` | Versioned controller configuration |
| `~/.local/share/nexus/data/` | Controller state, credentials, routing data (0700/0600) |
| `~/.local/share/nexus/logs/` | Launcher and controller logs |
| `~/.local/share/nexus/scripts/` | PowerShell controller scripts |
| `~/.local/share/nexus/bin/` | Canonical command launchers (extensionless) |
| `~/.local/bin/` | User-facing launchers with the install root baked in (0755) |

## Commands

The Linux launchers are extensionless executables with the same names as the Windows `.cmd` wrappers:

`aih`, `aih-auth`, `aih-complete`, `aih-context`, `aih-detect`, `aih-doctor`, `aih-key`, `aih-review`, `aih-route`, `aih-rules`, `aih-stop`, `aih-task`, `aih-test`, `aih-test-tiers`, `aih-update`, `aih-verify`, `aih-visual-review`.

Every launcher resolves the install root itself (baked at install time, with a script-relative fallback) and delegates to the pinned PowerShell runtime, so it works from any directory and any shell.

## PATH setup (the installer never edits your shell configuration)

If `~/.local/bin` is not already on your `PATH`, the installer prints exact instructions and does nothing else. Add it yourself, once:

```sh
# bash / zsh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.profile
# then open a new shell or: source ~/.profile
```

fish:

```fish
fish_add_path ~/.local/bin
```

Notes:

- On fish, the launchers are POSIX `sh` scripts; fish executes them through the shebang exactly like any other executable. Use `aih` normally; only the *instructions above* are shell-specific.
- The wrappers `exec` the pinned runtime with a fixed argument vector, so spaces and special characters in workspace paths are safe.

## How the platforms differ (and do not)

- Windows keeps `bin/*.cmd` wrappers, `powershell.exe` (5.1) as the verification host, and the exact historical installer behavior (`setup.ps1`). Nothing changed for Windows users.
- Linux uses `bin/linux/*.sh` wrappers, the pinned PowerShell 7.5 runtime for every controller script, procfs-based process identity (`/proc/<pid>/exe` + start time), and POSIX transports with the same file-based stdout/stderr contracts (no pipes), so structured output parsing behaves identically.
- Named synchronization primitives (controller mutexes) are namespace-safe on both platforms: Windows keeps `Local\AIHarness.*`, Linux uses encoded names.
- Sensitive state (`data/`) is protected on both platforms: Windows ACLs (unchanged behavior), Linux `0700` directories and `0600` files, including the credential file.

## Update

From any newer checkout:

```sh
cd /path/to/new/Nexus
~/.local/share/nexus/bin/aih-update
```

or directly:

```sh
bash /path/to/new/Nexus/setup.sh --install-root ~/.local/share/nexus --skip-deepseek-login --skip-openai-login --skip-path-check
```

`aih-update` on Linux delegates to the source checkout's `setup.sh`, which re-provisions moved runtime pins and re-runs the shared install composition (`scripts/Complete-Install.ps1`) — the same code Windows runs. User settings, credentials, and task state are preserved.

## Uninstall

Everything lives in two directories:

```sh
rm -rf ~/.local/share/nexus
rm -f ~/.local/bin/aih ~/.local/bin/aih-*   # the installed launchers
```

The global engineering skill pack is installed into the native Agent Skills root (`~/.agents/skills` per the skills catalog); remove individual Nexus skill directories there if desired. Nexus never writes outside these locations.

## Authentication

- `aih-key` — stores the DeepSeek key in the protected credential store (`data/.credentials.yaml`, 0600). Input is hidden; on Linux the secret is decoded with the POSIX-safe path (no BSTR interop).
- `aih-auth` — ChatGPT/Codex OAuth for independent review; the auth file lives under your user profile (the same location the third-party openai-oauth package uses).
- DeepSeek-only mode: `aih -Preset deepseek`.

## Troubleshooting

- `aih: command not found` — `~/.local/bin` is not on PATH (see above), or you have not opened a new shell after installing.
- `Nexus is not installed at ... (missing runtime/pwsh)` — the launcher resolved a root without the pinned runtime; re-run `./setup.sh` from the source checkout.
- Checksum mismatch / "Refusing an unverified download" — the pinned Node/PowerShell archive or its manifest failed verification; re-run the installer. Nexus never installs an unverified runtime.
- `xdg-open` missing — `aih -Open` prints the URL instead of launching a browser; open it manually.
- `rg` (ripgrep) missing — reference search in the context engine degrades gracefully; install it for full reference results.
- Doctor checks fail — run `aih-doctor -Offline`; each line names the exact failed component and the fix.
- Verification of the harness itself: `aih-test` runs the deterministic suite (the same suite CI runs on `ubuntu-latest` and `windows-latest`).
# Nexus on macOS (Apple Silicon)

Supported target: **macOS arm64** (Apple Silicon). Linux x86_64 keeps its existing path; Windows keeps `setup.ps1`.
Everything is user-scoped: no sudo, no shell-profile edits, and an install never touches another install.

## Install

```sh
./setup.sh --install-root "$HOME/Nexus-DSH-0.2.2" \
           --user-bin "$HOME/Nexus-DSH-0.2.2/launchers" \
           --skip-deepseek-login --skip-openai-login --skip-path-check
```

- `--install-root` (or `AIH_INSTALL_ROOT`): where the runtime and `data/` live. Use a fresh directory to run next to another Nexus.
- `--user-bin` (or `AIH_USER_BIN`): where the `aih*` launchers are written. The default `~/.local/bin` is shared with any other
  install; pass your own directory when you do not want to replace its launchers.
- The installer provisions the pinned Node.js (`darwin-arm64`) and PowerShell (`osx-arm64`) with SHA-256 verification, then runs
  `npm ci` from the lockfile. Required system tools: `git`, `tar`, `xz`, `iconv`, `curl`, and `sha256sum` or `shasum`.
- Do not use Homebrew's `pwsh` for Nexus. On some macOS/.NET combinations it fails to start with
  `FileLoadException: The given assembly name was invalid`; Nexus always runs its own pinned `runtime/pwsh`.

## Start / stop

```sh
"$HOME/Nexus-DSH-0.2.2/runtime/pwsh/pwsh" -NoProfile -File "$HOME/Nexus-DSH-0.2.2/scripts/aih.ps1" -InstallRoot "$HOME/Nexus-DSH-0.2.2" -Port 3081 /path/to/workspace
"$HOME/Nexus-DSH-0.2.2/runtime/pwsh/pwsh" -NoProfile -File "$HOME/Nexus-DSH-0.2.2/scripts/Stop.ps1" -InstallRoot "$HOME/Nexus-DSH-0.2.2"
```

The launcher prints the tokenised URL. With the installed launchers on `PATH` this is simply `aih -Port 3081 .` and `aih-stop`.

- Port: `-Port N` or `AIH_PORT` (1024-65535); the default stays 3080 from `config/versions.json`.
- OAuth service URL: `AIH_OAUTH_BASE_URL` (default `http://127.0.0.1:10531/v1`). Point it at an unused port for a test install that must never reach another
  install's ChatGPT/Codex OAuth proxy.
- Stop uses the install's own state record and process identity (pid + executable + start time); it never signals a process it did not start.

## Platform notes

- Process identity uses .NET `Process.Path` / `StartTime` on macOS (Linux reads procfs, Windows unchanged).
- Detached launch uses the Node helper (`scripts/DetachedProcess.js`), as on Linux.
- The browser opener is `open` on macOS (`xdg-open` on Linux); the doctor checks the right one.
- DSH keeps a default workspace at `~/Documents/deepseek-harness/default-workspace` (the OS Documents folder, not `$HOME`): it is only referenced, not written, by Nexus.
- Known DSH 0.2.2-rc.1 behavior: the host rejects changing a session's agent preset more than once per server process
  (`dsh-scope: scope key is already bound to a parent`). Nexus shows the refusal and keeps the picker on the preset the session really has; start a new session or restart to switch again.

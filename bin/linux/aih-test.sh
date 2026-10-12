#!/bin/sh
# Nexus command launcher: aih-test (delegates to scripts/Test-Harness.ps1).
# POSIX sh; works from any interactive shell (bash, fish, zsh) and from any
# working directory. Installed by setup.sh into <install>/bin and ~/.local/bin.
# When installed into ~/.local/bin, setup.sh bakes AIH_BAKED_ROOT so the
# launcher resolves the install root from anywhere.
AIH_BAKED_ROOT=""

AIH_SELF="$0"
# Resolve symlinks so a symlinked launcher still finds its install root.
while [ -L "$AIH_SELF" ]; do
  AIH_LINK="$(readlink "$AIH_SELF")"
  case "$AIH_LINK" in
    /*) AIH_SELF="$AIH_LINK" ;;
    *) AIH_SELF="$(dirname "$AIH_SELF")/$AIH_LINK" ;;
  esac
done
AIH_SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$AIH_SELF")" && pwd) || exit 1
if [ -n "$AIH_BAKED_ROOT" ] && [ -d "$AIH_BAKED_ROOT" ]; then
  AIH_ROOT="$AIH_BAKED_ROOT"
else
  # Source templates live in <checkout>/bin/linux; installed launchers live
  # in <install>/bin. Baked user launchers keep precedence above.
  AIH_LAUNCHER_SOURCE_ROOT="$(dirname "$(dirname "$AIH_SELF_DIR")")"
  if [ "$(basename "$AIH_SELF_DIR")" = linux ] && [ -f "$AIH_LAUNCHER_SOURCE_ROOT/scripts/Platform.ps1" ]; then
    AIH_ROOT="$AIH_LAUNCHER_SOURCE_ROOT"
  else
    AIH_ROOT="$(dirname "$AIH_SELF_DIR")"
  fi
fi
AIH_PWSH="$AIH_ROOT/runtime/pwsh/pwsh"
if [ ! -x "$AIH_PWSH" ]; then
  AIH_SYSTEM_PWSH=$(command -v pwsh 2>/dev/null || true)
  if [ -n "$AIH_SYSTEM_PWSH" ]; then
    AIH_PWSH="$AIH_SYSTEM_PWSH"
  else
    echo "Nexus is not installed at $AIH_ROOT (missing runtime/pwsh)." >&2
    echo "Run the Nexus installer: ./setup.sh" >&2
    exit 1
  fi
fi
export AIH_INSTALL_ROOT="$AIH_ROOT"
exec "$AIH_PWSH" -NoLogo -NoProfile -File "$AIH_ROOT/scripts/Test-Harness.ps1" -InstallRoot "$AIH_ROOT" "$@"

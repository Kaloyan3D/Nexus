#!/bin/sh
# reinstall.sh <dir>: install + verify the Nexus agent planes in <dir>/root (isolated HOME, blocked egress).
P="$1"; R="$P/root"
export HOME="$P/home" TMPDIR="$P/tmp" PATH="$R/runtime/pwsh:$R/runtime/node/bin:/usr/bin:/bin:/usr/sbin:/sbin" AIH_TOOLCHAIN_ROOT="$R" AIH_INSTALL_ROOT="$R"
export NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost DEEPSEEK_API_KEY=probe-not-a-credential
unset CODEX_HOME
mkdir -p "$HOME" "$TMPDIR"; cd "$R"
"$R/runtime/pwsh/pwsh" -NoLogo -NoProfile -NonInteractive -File scripts/Install-NexusPresets.ps1 -InstallRoot "$R"

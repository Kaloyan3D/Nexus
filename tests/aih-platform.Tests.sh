#!/bin/sh
# Deterministic regression suite for the Nexus installer platform helpers
# (scripts/lib/aih-platform.sh, used by setup.sh). Pure functions: no network, no root.
# Linux x86_64 behavior must stay exactly as before; macOS arm64 maps to the darwin/osx archives.
set -u
AIH_LIB=$(CDPATH= cd -- "$(dirname -- "$0")/../scripts/lib" && pwd)
. "$AIH_LIB/aih-platform.sh"
passes=0; failures=0
expect() { # expect <description> <want> <got>
  if [ "$2" = "$3" ]; then passes=$((passes+1)); echo "PASS: $1"; else failures=$((failures+1)); echo "FAIL: $1 (want '$2', got '$3')"; fi
}
rc_of() { ( "$@" ) >/dev/null 2>&1; echo $?; }
expect "Linux x86_64 -> linux-x64" linux-x64 "$(aih_detect_platform Linux x86_64)"
expect "Linux amd64 -> linux-x64" linux-x64 "$(aih_detect_platform Linux amd64)"
expect "Linux aarch64 stays unsupported by the committed installer" 1 "$(rc_of aih_detect_platform Linux aarch64)"
expect "macOS arm64 -> macos-arm64" macos-arm64 "$(aih_detect_platform Darwin arm64)"
expect "macOS Intel stays unsupported" 1 "$(rc_of aih_detect_platform Darwin x86_64)"
expect "Windows is not a POSIX installer target" 1 "$(rc_of aih_detect_platform MINGW64_NT x86_64)"
expect "Node archive linux-x64 unchanged" node-v24.18.1-linux-x64.tar.xz "$(aih_node_artifact_name 24.18.1 linux-x64)"
expect "Node archive macos-arm64" node-v24.18.1-darwin-arm64.tar.xz "$(aih_node_artifact_name 24.18.1 macos-arm64)"
expect "PowerShell archive linux-x64 unchanged" powershell-7.5.3-linux-x64.tar.gz "$(aih_pwsh_artifact_name 7.5.3 linux-x64)"
expect "PowerShell archive macos-arm64" powershell-7.5.3-osx-arm64.tar.gz "$(aih_pwsh_artifact_name 7.5.3 macos-arm64)"
echo "RESULT: $passes passed, $failures failed."
[ "$failures" -eq 0 ]

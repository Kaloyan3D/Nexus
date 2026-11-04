#!/bin/sh
# Development desktop: build the matching native services; use system Node.
set -eu
app_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo_root=$(CDPATH= cd -- "$app_dir/../.." && pwd)
cd "$app_dir"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
export NEXUS_REPO_ROOT="${NEXUS_REPO_ROOT:-$repo_root}"
export NEXUS_HOME="${NEXUS_HOME:-$HOME/.nexus-interactive-dev}"
if [ -z "${NEXUS_BIN_DIR:-}" ]; then
  cargo build --manifest-path "$repo_root/native/Cargo.toml" \
    --target-dir "$repo_root/native/target" --workspace -j "$CARGO_BUILD_JOBS"
  export NEXUS_BIN_DIR="$repo_root/native/target/debug"
fi
exec npm run tauri -- dev --config src-tauri/tauri.dev.conf.json "$@"

#!/bin/sh
# mkroot.sh <dir>: <dir>/root = clone of a base Nexus install + this repo's working-tree code + prepared closures.
# Base install: NEXUS_DEMO_BASE (default ~/Nexus-DSH-0.2.2-Test/root), read-only source.
# Only <dir>/root is replaced; <dir>/tools, credentials backups and projects are kept.
set -e
P="$1"; R=$P/root
SRC=$(cd "$(dirname "$0")/../.." && pwd)
BASE=${NEXUS_DEMO_BASE:-$HOME/Nexus-DSH-0.2.2-Test/root}
rm -rf "$R"; mkdir -p "$P/home" "$P/tmp" "$P/results"
cp -c -R "$BASE" "$R" 2>/dev/null || cp -R "$BASE" "$R"
rm -rf "$R/data/sessions" "$R/data/logs" "$R/data/aih-state.json" "$R/data/nexus" "$R/data/routing/session-bindings.json"
rsync -a --delete "$SRC/scripts/" "$R/scripts/"; rsync -a --delete "$SRC/tests/" "$R/tests/"; rsync -a "$SRC/docs/" "$R/docs/"
rsync -a "$SRC/ui/nexus-controller/" "$R/ui/nexus-controller/"; rsync -a "$SRC/ui/nexus-controller/" "$R/data/profiles/node_modules/@nexus/controller/"
for prof in '' engineering deepseek host; do "$R/runtime/node/bin/node" "$SRC/scripts/MusePresetDependencyClosure.cjs" prepare "$SRC" "$R" $prof >/dev/null; done

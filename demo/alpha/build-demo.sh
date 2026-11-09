#!/bin/sh
# Build/rebuild the demo install at ${NEXUS_DEMO_DIR:-~/Nexus-Demo} from this repo:
#   1. clone the base install, sync this repo's code, install + verify the agent planes;
#   2. demo port 3090 (never 3080/3081);
#   3. install the PoC DSH gateway/authorize build, reconstructed from
#      docs/architecture/evidence/p2b2b/dsh-gateway-built.lib.diff and checked by digest.
# Keeps stored credentials (.credentials.yaml / .env) across rebuilds. Stop the demo host first.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
D=${NEXUS_DEMO_DIR:-$HOME/Nexus-Demo}
mkdir -p "$D/.keep"; chmod 700 "$D/.keep"
for f in .credentials.yaml .env; do [ -f "$D/root/data/$f" ] && cp -p "$D/root/data/$f" "$D/.keep/$f"; done
sh "$HERE/mkroot.sh" "$D"
for f in .credentials.yaml .env; do [ -f "$D/.keep/$f" ] && cp -p "$D/.keep/$f" "$D/root/data/$f"; done
sh "$HERE/reinstall.sh" "$D" > "$D/results/install.log" 2>&1 || { tail -20 "$D/results/install.log"; exit 1; }
sed -i '' 's#"HarnessUrl": "http://127.0.0.1:3080"#"HarnessUrl": "http://127.0.0.1:3090"#' "$D/root/config/versions.json"
G="$D/root/app/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js"
shasum -a 256 "$G" | grep -q 91abae7edfaa2bf3154680829e77b1f341aa01ba9094795aa70b96ff3e15f52b || { echo "unexpected pristine gateway build; refusing to patch"; exit 1; }
patch -s "$G" < "$REPO/docs/architecture/evidence/p2b2b/dsh-gateway-built.lib.diff"
shasum -a 256 "$G" | grep -q 12e5577b6ae0c19d2d826790f409e086513a41a33014fc45ae57d257a57a14c8 && echo "demo rebuilt at $D (gateway hook build verified, port 3090)"

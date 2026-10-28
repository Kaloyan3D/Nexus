#!/bin/sh
# Build the Linux x86_64 (Debian/Ubuntu) release package from the current source, with the private Node.js,
# the Registry bridge, the provider scripts and the notices, then verify the package CONTENT.
set -eu
cd "$(dirname "$0")/.."
( cd ../../native && cargo build --release --workspace )
node packaging/fetch-node.mjs --verify-signature
node packaging/stage-resources.mjs
node packaging/gen-notices.mjs
npm run tauri -- build --bundles deb
node packaging/verify-package.mjs src-tauri/target/release/bundle/deb/Nexus_*_amd64.deb

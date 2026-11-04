#!/bin/sh
# Build Nexus.app with the embedded engine: the signed VM runner next to the app binary and the guest image
# (compressed) in Resources/engine. Needs engine-image/out/{Image,rootfs.img} (see engine-image/build.sh).
#   ENGINE_IMAGE_DIR=/path/with/Image+rootfs.img  [CARGO_TARGET_DIR=/staging/target]  sh engine-vm/package-app.sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_dir=$(CDPATH= cd -- "$here/.." && pwd)
img="${ENGINE_IMAGE_DIR:-$app_dir/engine-image/out}"
[ -f "$img/Image" ] && [ -f "$img/rootfs.img" ] || { echo "missing $img/Image or rootfs.img (run engine-image/build.sh, then extract-kernel.py)"; exit 1; }
helper=$("$here/build.sh")
cd "$app_dir"
npm run tauri -- build --bundles app
# CARGO_TARGET_DIR stages the build away from src-tauri/target (so a running or installed Nexus.app is untouched)
app="${CARGO_TARGET_DIR:-$app_dir/src-tauri/target}/release/bundle/macos/Nexus.app"
mkdir -p "$app/Contents/Resources/engine"
cp "$helper" "$app/Contents/MacOS/nexus-vm"
cp "$img/Image" "$app/Contents/Resources/engine/Image"
zstd -q -T0 -10 -f "$img/rootfs.img" -o "$app/Contents/Resources/engine/rootfs.img.zst"
ver=$(shasum -a 256 "$app/Contents/Resources/engine/rootfs.img.zst" | cut -c1-16)
printf '{"version":"%s"}\n' "$ver" > "$app/Contents/Resources/engine/manifest.json"
id="${NEXUS_SIGN_IDENTITY:--}"
codesign --force --sign "$id" --entitlements "$here/nexus-vm.entitlements" "$app/Contents/MacOS/nexus-vm"
codesign --force --sign "$id" "$app"
du -sh "$app" "$app/Contents/Resources/engine"/*
echo "$app"

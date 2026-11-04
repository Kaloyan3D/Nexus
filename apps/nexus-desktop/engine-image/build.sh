#!/bin/sh
# Build the engine guest image (rootfs + kernel) with rootless podman. Run on a Linux ARM64 host that has
# a release build of the native workspace and of `nexus-bridge --features engine-bridge` (the Fedora VM today;
# any aarch64 Linux CI machine later). No root needed.
#
#   NEXUS_REPO=~/Projects/Nexus sh build.sh        ->  out/rootfs.img  out/vmlinuz
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo="${NEXUS_REPO:-$(CDPATH= cd -- "$here/../../.." && pwd)}"
rel="$repo/native/target/release"
# built with: cargo build --release --no-default-features --features engine-bridge --bin nexus-bridge
bridge="$repo/apps/nexus-desktop/src-tauri/target/release/nexus-bridge"
size="${ROOTFS_SIZE:-3G}"
out="$here/out"
rm -rf "$here/stage" "$out"
mkdir -p "$here/stage/bin" "$here/stage/repo/config" "$here/stage/repo/scripts" "$out"
for b in nexusd nexus-broker nexus-approver nexus-confine nexus-egress; do
  install -m 0755 "$rel/$b" "$here/stage/bin/$b"
done
install -m 0755 "$bridge" "$here/stage/bin/nexus-bridge"
strip "$here"/stage/bin/* 2>/dev/null || true
cp -r "$repo/config/registry" "$here/stage/repo/config/registry"
for c in model-registry.json engineering-profiles.json muse-profiles.json; do cp "$repo/config/$c" "$here/stage/repo/config/$c"; done
for s in Setup-NativeOpenCodeGo.cjs Verify-NativeOpenCodeGoRoute.cjs; do cp "$repo/scripts/$s" "$here/stage/repo/scripts/$s"; done

podman build -q -t nexus-engine-image -f "$here/Containerfile" "$here" >/dev/null
cid=$(podman create nexus-engine-image /bin/true)
trap 'podman rm -f "$cid" >/dev/null 2>&1 || true' EXIT
# the kernel the image's modules belong to
podman cp "$cid":/lib/modules "$out/modules-tmp" >/dev/null
kver=$(ls "$out/modules-tmp")
cp "$out/modules-tmp/$kver/vmlinuz" "$out/vmlinuz"
rm -rf "$out/modules-tmp"
# rootfs -> ext4 without root: unpack inside a user namespace (uid 0 maps to the caller) and let mke2fs read it there
podman export "$cid" -o "$out/rootfs.tar"
mkdir -p "$out/root"
podman unshare sh -c "
  tar -C '$out/root' --exclude='./dev/*' -xf '$out/rootfs.tar' &&
  ln -sf ../run/systemd/resolve/stub-resolv.conf '$out/root/etc/resolv.conf' &&
  echo nexus-engine > '$out/root/etc/hostname' &&
  truncate -s $size '$out/rootfs.img' &&
  mkfs.ext4 -q -L nexus-root -m 0 -d '$out/root' '$out/rootfs.img'
"
podman unshare rm -rf "$out/root"
rm -f "$out/rootfs.tar"
echo "kernel: $kver"
ls -la "$out"

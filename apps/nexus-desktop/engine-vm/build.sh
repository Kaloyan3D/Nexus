#!/bin/sh
# Build and sign the VM runner. Ad-hoc signing with the virtualization entitlement is enough locally;
# a distributed Nexus.app signs this helper with the developer identity instead of `-`.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out="${1:-$here/build}"
mkdir -p "$out"
swiftc -O -o "$out/nexus-vm" "$here/nexus-vm.swift" -framework Virtualization
codesign --force --sign "${NEXUS_SIGN_IDENTITY:--}" --entitlements "$here/nexus-vm.entitlements" "$out/nexus-vm"
echo "$out/nexus-vm"

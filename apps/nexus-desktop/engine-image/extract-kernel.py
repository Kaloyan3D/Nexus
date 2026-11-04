#!/usr/bin/env python3
"""Fedora's aarch64 `vmlinuz` is an EFI PE wrapper around a zstd-compressed arm64 Image. Virtualization.framework
boots a raw Image, so unwrap it: find the zstd frame, decompress, verify the arm64 header."""
import struct, subprocess, sys
src, dst = sys.argv[1], sys.argv[2]
b = open(src, 'rb').read()
if b[56:60] == b'ARMd':          # already a raw Image
    open(dst, 'wb').write(b); sys.exit(0)
if b[4:8] == b'zimg':               # EFI zboot header: payload offset/size and compression type
    off, size = struct.unpack('<II', b[8:16])
    kind = b[24:32].split(b'\0')[0].decode()
    payload = b[off:off + size]
    cmd = {'zstd': ['zstd', '-dc', '-'], 'gzip': ['gzip', '-dc']}.get(kind)
    if not cmd: sys.exit('unsupported kernel compression: %s' % kind)
    img = subprocess.run(cmd, input=payload, capture_output=True).stdout
else:                                  # older layout: locate the zstd frame inside the PE
    i = b.find(b'\x28\xb5\x2f\xfd', 2_000_000)
    if i < 0: sys.exit('no compressed payload in %s' % src)
    img = subprocess.run(['zstd', '-dc', '-'], input=b[i:], capture_output=True).stdout
if img[56:60] != b'ARMd': sys.exit('payload is not an arm64 Image')
size = struct.unpack('<Q', img[16:24])[0]
open(dst, 'wb').write(img[:size] if size and size <= len(img) else img)
print('arm64 Image: %d bytes' % len(open(dst, 'rb').read()))

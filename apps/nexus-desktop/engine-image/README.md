# Nexus engine guest image

The embedded Linux engine is a Fedora 44 ARM64 userland booted by `engine-vm/nexus-vm` (Virtualization.framework).

| Piece | Where |
|---|---|
| Userland recipe | `Containerfile` (systemd, bubblewrap, Node 22, GTK3 runtime libs for the bridge, Playwright `chromium-headless-shell`) |
| Boot units | `overlay/etc/systemd/system/nexus-state.service` (formats/mounts the state disk as `/home/nexus`), `nexus-bridge.service` (`User=nexus`, `Delegate=yes`, `nexus-bridge --vsock 1024`) |
| Browser evidence tool | `overlay/opt/nexus/bin/nexus-browse.cjs` (`nexus-browse --url … --out DIR [--steps FILE]`) |
| Build | `build.sh` on any ARM64 Linux with rootless podman (needs release builds of `native/` and of `nexus-bridge --no-default-features --features engine-bridge`) |
| Kernel | taken from the image's own `kernel-core`; `extract-kernel.py` unwraps Fedora's EFI-zboot `vmlinuz` into the raw arm64 `Image` that Virtualization.framework boots |

Build and package:

```sh
# on the Linux builder
cargo build --release --workspace                                   # in native/
cargo build --release --no-default-features --features engine-bridge --bin nexus-bridge   # in apps/nexus-desktop/src-tauri
sh engine-image/build.sh                                            # -> engine-image/out/{rootfs.img,vmlinuz}
# on the Mac
python3 engine-image/extract-kernel.py out/vmlinuz out/Image
ENGINE_IMAGE_DIR=out sh engine-vm/package-app.sh                    # Nexus.app with nexus-vm + compressed image
```

No kernel config is carried: the guest uses Fedora's kernel, which has Landlock, seccomp, cgroups v2, user namespaces
and virtio-pci/blk/console built in (vsock and virtio-net load as modules).

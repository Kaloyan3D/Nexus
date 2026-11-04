# M4 — Embedded Linux engine

Status: **the engine now runs in a headless microVM started by Nexus.app (no UTM, no SSH, no network port). Validated by
process-level and protocol-level tests and live runs against the real broker; the app window and the first-run provider prompt
were not inspected by me.** Nothing is committed.

## 1. Architecture decision

| | Virtualization.framework (chosen) | libkrun |
|---|---|---|
| Apple support / stability | first-party, signed with `com.apple.security.virtualization` (works ad-hoc locally) | third-party; Homebrew `krunkit`, bundling a C library and its kernel |
| Kernel | **our choice**: Fedora's kernel, which has every feature the engine's sandbox needs built in | ships `libkrunfw`'s own minimal kernel; Landlock/seccomp/cgroup v2 completeness would have to be audited and maintained by us |
| Host↔guest channel | virtio-vsock, no network exposure | vsock via unix sockets |
| Boot | measured 0.15 s kernel, 2.9–3.6 s to engine ready | claims faster boot; unnecessary gain (3 s already) |
| Risk | Swift helper + entitlement/signing | extra supply-chain and kernel-feature risk against a hard requirement |

Choice: Virtualization.framework. libkrun was **not benchmarked** (not installed; I judged it on the kernel-feature requirement, which is the
hard constraint, not on speed).

```
Nexus.app (Rust)                 nexus-vm daemon (Swift, entitled)               microVM (Fedora 7.2 kernel, systemd)
BridgeLink ── spawns ─► nexus-vm attach ─ unix socket 0700, owner-checked ─► vsock :1024 ─► nexus-bridge --vsock 1024 (User=nexus, Delegate=yes)
   M2/M3 protocol unchanged (stdio lines)     boots VM on demand, clones system disk per boot      └─ Kernel + broker + sandbox (bwrap/Landlock/seccomp/cgroups v2) + nexus-browse
```

* `engine-vm/nexus-vm.swift`: `daemon | attach | stop`. System disk is a fresh copy-on-write clone of the pristine image at every boot (the guest cannot
  persist anything outside the separate state disk); NAT networking only for provider access; memory balloon device; idle self-shutdown 120 s after the last attach;
  console log + development FIFO console.
* `src/engine_vm.rs`: `VmTransport` (replaces the ssh `Transport`), image provisioning from the bundle (zstd, sparse) or `NEXUS_ENGINE_IMAGE_DIR`, stop on app exit.
  `engine.json` is now optional: `{"transport":"vm"}` or nothing; SSH remains for development.
* Guest `nexus-bridge --vsock`: one long-lived service owning the runtime (the engine survives reconnects), accepts only CID 2, newest connection wins.
* Secret entry: the guest can now ask the Mac for a secret (`ToHost::Secret`); the Mac shows a native non-echoing prompt (AppleScript `hidden answer`, text passed as arguments)
  and replies on the private channel. This replaces the last manual step (typing the provider key on the guest).
* Cargo: `window` feature (default) isolates WebKit/GTK window code; the bridge builds without it (`--no-default-features --features engine-bridge`). GTK3 *runtime* libs are still linked by `tauri`
  and are in the image; WebKit is not.

## 2. Benchmarks (same Mac, M1 Pro; UTM = Fedora 44 KDE desktop, 6 vCPU, 12 GB; microVM = 4 vCPU, 2 GB, no desktop)

| Metric | UTM + SSH | Embedded microVM |
|---|---|---|
| Cold start → engine ready | not measured (full KDE boot + login; tens of seconds) | **2.9 / 3.3 / 3.6 s** (hello 2.4–3.1 s; kernel mounted root at 0.14 s) |
| Idle host memory | QEMU 3.35 GB RSS + UTM 72 MB | **0.90 GB** (VZ service) + 21 MB helper; guest 167 MB used of 1.9 GB |
| CPU (node, 4e8 loop) | 0.59 s | 0.55 s |
| sha256 of 2 GiB | 2.00 s | 1.66 s |
| 1 GiB write + fsync | 0.98 s | 0.36 s |
| 300 process spawns | 0.140 s | 0.095 s |
| bwrap sandbox start | 12 ms | 6 ms |
| Headless Chromium: launch + load page + click + 2 screenshots | n/a (no browser installed) | **0.26 s** total; screenshot verified visually |
| App size | — | Nexus.app 434 MB (353 MB compressed image + 75 MB kernel) ; on disk after first run 1.1 GB system + sparse state |
| Project onboarding (cold VM → staged + registered in the real broker) | — | 4.3 s |

UTM figures include a running desktop session (noisy); they are indicative, not a controlled comparison.

## 3. Validation

* Mac: fmt/clippy `-D warnings` clean; **60 Rust tests pass** (+ provisioning, sparse writer, vm config, secret protocol); frontend unchanged (260 pass earlier in this session).
* Fedora: clippy default + `--no-default-features --features engine-bridge`; full desktop test suite incl. real-sandbox runtime tests: all pass after the Cargo feature split.
* Live: microVM boots, vsock bridge handshake, `runtime_state` → `ready` inside the VM (Kernel + broker + cgroup delegation under systemd), M3 onboarding stages a Mac folder into the VM and registers it with the broker
  (`vm_onboarding_stages_into_the_microvm`), app launched from Finder provisions the image (sparse, ~6 s once) and starts the VM with **no network permission needed** (vsock; the Local Network prompt that blocked SSH no longer applies).

## 4. Not done / not verified (accurate)

1. **Agent browser tool is not wired into the broker.** What exists and is proven: the browser, `nexus-browse` (page load, click/fill/press/expectText steps, console + page errors + failed requests,
   screenshots, text summary → `report.json`), running inside the VM with Chromium's own sandbox. What remains: expose it as a Kernel/broker tool (`nexus-model` tool declaration, `broker/src/code.rs` dispatch and
   argument validation, running it under the same confine/egress policy against a job's DevBridge port, recording screenshots + report as receipts in `verification/evidence.rs`, parity/security tests). That touches the
   engine's tool contract, so I stopped here rather than change it blind.
2. **Provider key**: the VM's state disk is new, so the OpenCode Go provider must be connected once through the new native prompt; I did not type a key or inspect that prompt.
3. **GUI** not inspected (same limitation as before).
4. **libkrun** not benchmarked; **UTM cold boot** not measured (would have restarted your VM).
5. Memory is fixed at 2 GB with a balloon device present but no pressure policy; CPU 4 vCPUs. Fonts/Chromium dependencies are minimal.
6. Signing: ad-hoc with the virtualization entitlement (works locally). Distribution needs a Developer ID signature for the app and `nexus-vm` (same entitlement), plus notarization.
7. The image build still needs an ARM64 Linux builder (the Fedora VM today); a CI recipe is future work. Fedora's kernel is used as is (no custom config).
8. UTM remains installed and running; `engine.json.bak` / `engine.ssh.json.bak` keep the SSH settings. The guest-side restricted SSH key is no longer used by the default path.

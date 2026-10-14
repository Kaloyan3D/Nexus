# Multi-UID isolation procedure (closure section 4)

Runs `native/nexus-daemon/tests/multuid.rs` (8 ignored adversarial tests +
1 capability reporter) with GENUINE distinct Linux UIDs. The suite refuses to
run anywhere else: without `NEXUS_MULTUID=1`, without root, or without the
four users below, every test prints NOT RUN (the 8 stay `ignored`, never
PASS). Pick exactly one of A (container) or B (target host).

## Principals (both paths)

| User | Primary group | Extra groups | Role |
|---|---|---|---|
| `nexusd-test` | `nexusd-test` | — | Daemon service identity (owns DataRoot `0700`) |
| `nexus-issuer-test` | `nexus-issuer-test` | — | Trusted issuer (`--allowed-uids`, traverses sockdir `0750`, reads handoff `0640`) |
| `nexus-bystander-test` | own | `nexus-issuer-test` | In-group but NOT allowlisted: must get `peer-unauthorized` with a valid stolen cap |
| `nexus-untrusted-test` | own | — | Adversarial workload: must get OS-level `EACCES` on connect |

Distinctness is enforced by the harness itself (it aborts NOT RUN unless it
sees 4 different UIDs).

## A. Disposable container (preferred, no host changes)

Prerequisite: docker on the operator machine (NOT this unprivileged dev
container — verified absent here) and network access to fetch the base image
and crates.

```sh
# From the repository root of a machine WITH docker:
docker build -f native/deploy/Dockerfile.multuid -t nexus-multuid .
docker run --rm nexus-multuid
```

Expected: `8 passed; 0 failed; 1 reporter ok` on the `-- --ignored` run
(the image CMD already passes `--ignored --test-threads=1`; serial avoids
port/tmp collisions between daemon instances). The image is throwaway: it
carries no production data and must not be promoted or reused for
production. `docker run --rm` deletes it afterwards.

## B. Target host (persistent root machine, explicit operator authorization)

```sh
# 1. Identities (requires host authorization; never run these in dev containers).
groupadd -r nexus-issuer-test
# nexusd-test must join the issuer group (production SupplementaryGroups= equivalent):
# otherwise the unprivileged daemon cannot chown the socket/handoff group and
# every test fails closed with "socket group unsettable".
useradd -r -m -s /usr/sbin/nologin -G nexus-issuer-test nexusd-test
useradd -r -M -s /usr/sbin/nologin -g nexus-issuer-test nexus-issuer-test
useradd -r -U -M -s /usr/sbin/nologin -G nexus-issuer-test nexus-bystander-test
useradd -r -U -M -s /usr/sbin/nologin nexus-untrusted-test
id nexusd-test nexus-issuer-test nexus-bystander-test nexus-untrusted-test

# 2. Tooling the harness shells out to: runuser (util-linux), python3, cat/tee/ls.
command -v runuser && command -v python3 && command -v node
# CachyOS/Arch operator: pacman -S --needed shadow util-linux python nodejs docker rust
# (only if the above check fails; the harness itself reports NOT RUN otherwise)

# 3. Build daemon binaries (tests spawn them directly).
cd native && cargo build -p nexus-daemon -p nexus-kernel

# 4. Reporter first (always safe, asserts nothing): expect NOT RUN or PREPARED.
cargo test -p nexus-daemon --test multuid multuid_host_capability_reporter -- --nocapture

# 5. The genuine multi-UID run, serial:
NEXUS_MULTUID=1 cargo test -p nexus-daemon --test multuid -- --ignored --test-threads=1
```

Expected: `8 passed; 0 failed`. Each test provisions its own
`/tmp/nexus-multuid-<pid>-*` layout (daemon-owned `0700` DataRoot +
`0750` sockdir) and removes it on completion — including on panic, via the
`Drop` guard — so reruns are clean.

## What the 8 tests prove (mapping to closure section 4)

1. `issuer_completes_acquire_seal_accept` — authorized issuer flow works.
2. `issuer_cannot_touch_kernel_persistence` — `cat`/`tee`/`ls` as the issuer
   UID fail on cap/db/witness/DataRoot (DAC `EACCES`).
3. `untrusted_with_stolen_cap_is_denied_at_connect` — valid stolen cap as the
   untrusted UID never reaches the daemon (`Permission denied` at connect).
4. `bystander_with_stolen_cap_gets_peer_unauthorized` — in-group but
   non-allowlisted UID connects yet is refused `peer-unauthorized` despite a
   valid HMAC: stolen capability alone is insufficient (daemon-level proof).
5. `forged_and_replayed_commands_rejected` — forged tag `issuer-untrusted`,
   replay `replay-rejected`.
6. `receipts_stable_across_restart_with_key_rotation` — restart rotates the
   key (`cap1 != cap2`) while the authoritative receipt stays queryable
   byte-identically under the rotated key; re-accepting the same command
   under the post-restart lease epoch is refused `command-conflict` (the
   epoch is bound into the command digest, so a rebinding can neither fork
   nor duplicate the receipt; an exact replay is impossible by construction
   because rotation invalidates the old HMAC tag).
7. `insecure_permissions_refuse_startup` — `0755` DataRoot refuses with
   `insecure-dataroot`; `0755` sockdir refuses with `insecure-socket-dir`;
   no socket is bound in either case.
8. `no_shadow_operation_dispatches` — full shadow flow then readiness stays
   `NOT_READY` with `dispatch_enabled: false`, and
   `Kernel::dispatch_enabled()` is false in-process.

Requirement 9 (Controller + Registry regressions) is covered by the
always-run JS gates (`NativeA20`, `NativeShadowA13/A12`, `Spike02`,
`RegistryCore`, `AihController`, `AihControllerIdentity`), not by this file.

## Recording results

Copy the full `-- --ignored` output (including the `running 9 tests` header
and the `test result` line) into the closure evidence report. An `ignored`
count with no `--ignored` execution is NOT RUN — never transcribe it as PASS.

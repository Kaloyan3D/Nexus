#!/bin/sh
# A3.6: run the multi-UID suite in an unprivileged user namespace (no docker).
# Requires: util-linux unshare >= 2.38, newuidmap/newgidmap, /etc/subuid for
# the invoking user (>= 65535 ids), a built workspace. Disposable; touches only
# /tmp/nxmu and a cgroup leaf under the caller's own scope.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
M=/tmp/nxmu
OUT=$(id -u)
SUB=$(awk -F: -v u="$(id -un)" '$1==u{print $2; exit}' /etc/subuid)
[ -n "$SUB" ] || { echo "NOT RUN: no /etc/subuid range for $(id -un)"; exit 77; }
(cd "$ROOT/native" && cargo build -p nexus-daemon -p nexus-kernel && cargo test -p nexus-daemon --test multuid --no-run)
T=$(ls -t "$ROOT"/native/target/debug/deps/multuid-* | grep -v '\.d$' | head -1)
mkdir -p "$M/bin" "$M/etc" "$M/rust/cargo/bin" "$M/rust/rustup"
cp "$ROOT/native/target/debug/nexusd" "$ROOT/native/target/debug/nexus-kernel" "$T" "$M/bin/"
cp /etc/passwd "$M/etc/passwd"; cp /etc/group "$M/etc/group"
cat >> "$M/etc/passwd" <<P
nexusd-test:x:20001:20001::/nonexistent:/usr/sbin/nologin
nexus-issuer-test:x:20002:20002::/nonexistent:/usr/sbin/nologin
nexus-bystander-test:x:20003:20003::/nonexistent:/usr/sbin/nologin
nexus-untrusted-test:x:20004:20004::/nonexistent:/usr/sbin/nologin
nexus-approver-test:x:20005:20005::/nonexistent:/usr/sbin/nologin
P
cat >> "$M/etc/group" <<G
nexusd-test:x:20001:
nexus-issuer-test:x:20002:nexusd-test,nexus-bystander-test,nexus-approver-test
nexus-bystander-test:x:20003:
nexus-untrusted-test:x:20004:
nexus-approver-test:x:20005:nexusd-test
G
cat > "$M/run.sh" <<'R'
#!/bin/sh
mount --bind /tmp/nxmu/etc/passwd /etc/passwd && mount --bind /tmp/nxmu/etc/group /etc/group || exit 90
P=/sys/fs/cgroup/$(sed 's/^0:://' /proc/self/cgroup)/nxmu-run
mkdir -p "$P" && chown 20001:20001 "$P" "$P/cgroup.procs" "$P/cgroup.subtree_control" "$P/cgroup.threads" && echo $$ > "$P/cgroup.procs" || echo "cgroup delegation FAILED"
mount --bind "$HOME_REAL/.cargo/bin" /tmp/nxmu/rust/cargo/bin && mount --bind "$HOME_REAL/.rustup" /tmp/nxmu/rust/rustup || echo "toolchain bind FAILED"
export CARGO_HOME=/tmp/nxmu/rust/cargo RUSTUP_HOME=/tmp/nxmu/rust/rustup
export NEXUS_MULTUID=1 NEXUSD_BIN=/tmp/nxmu/bin/nexusd NEXUS_KERNEL_BIN=/tmp/nxmu/bin/nexus-kernel
cd /tmp/nxmu
exec /tmp/nxmu/bin/$(ls /tmp/nxmu/bin | grep ^multuid-) "$@"
R
chmod -R a+rX "$M"; chmod a+rx "$M/run.sh"
cd "$M"
HOME_REAL=$HOME exec unshare --user --map-users=0:"$OUT":1 --map-users=1:"$SUB":65535 \
  --map-groups=0:"$(id -g)":1 --map-groups=1:"$SUB":65535 --mount --setuid 0 --setgid 0 -- \
  ./run.sh --ignored --test-threads=1 "$@"

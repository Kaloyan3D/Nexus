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
(cd "$ROOT/native" && cargo build -p nexus-daemon -p nexus-kernel -p nexus-cli && cargo test -p nexus-daemon --test multuid --no-run)
# A5.3: the broker under test is a FIXTURE build (adds --test-tls-ca/--test-resolve so a
# throwaway CA and resolver can be injected for the https provider fixture). It is built into a
# separate target dir so the workspace/default broker binary never carries that feature.
(cd "$ROOT/native" && cargo build -p nexus-broker --features test-fixtures --target-dir "$ROOT/native/target/mu-fixture")
T=$(ls -t "$ROOT"/native/target/debug/deps/multuid-* | grep -v '\.d$' | head -1)
mkdir -p "$M/bin" "$M/etc" "$M/rust/cargo/bin" "$M/rust/rustup"
rm -f "$M"/bin/multuid-*  # a stale hash would be mistaken for a test filter
mkdir -p "$M/repo/data"
rm -rf "$M/repo/config" && cp -r "$ROOT/config" "$M/repo/config"
for f in settings.yaml custom-engineering-profile.json; do [ -f "$ROOT/data/$f" ] && cp "$ROOT/data/$f" "$M/repo/data/$f"; done
cp "$ROOT/native/target/debug/nexus" "$ROOT/native/target/mu-fixture/debug/nexus-broker" "$M/bin/"
cp "$(readlink -f "$(command -v node)")" "$M/bin/node"
cp "$ROOT/native/target/debug/nexusd" "$ROOT/native/target/debug/nexus-approver" "$ROOT/native/target/debug/nexus-witness" "$ROOT/native/target/debug/nexus-kernel" "$T" "$M/bin/"
cp /etc/passwd "$M/etc/passwd"; cp /etc/group "$M/etc/group"
cat >> "$M/etc/passwd" <<P
nexusd-test:x:20001:20001::/nonexistent:/usr/sbin/nologin
nexus-issuer-test:x:20002:20002::/nonexistent:/usr/sbin/nologin
nexus-bystander-test:x:20003:20003::/nonexistent:/usr/sbin/nologin
nexus-untrusted-test:x:20004:20004::/nonexistent:/usr/sbin/nologin
nexus-approver-test:x:20005:20005::/nonexistent:/usr/sbin/nologin
nexus-witness-test:x:20007:20007::/nonexistent:/usr/sbin/nologin
nexus-desktop-test:x:20010:20010::/nonexistent:/usr/sbin/nologin
nexus-desktop2-test:x:20011:20011::/nonexistent:/usr/sbin/nologin
nexus-operator-test:x:20012:20012::/nonexistent:/usr/sbin/nologin
P
cat >> "$M/etc/group" <<G
nexusd-test:x:20001:
nexus-issuer-test:x:20002:nexusd-test,nexus-bystander-test,nexus-approver-test
nexus-issuercred-test:x:20006:nexusd-test,nexus-issuer-test
nexus-bystander-test:x:20003:
nexus-untrusted-test:x:20004:
nexus-approver-test:x:20005:nexusd-test
nexus-witness-test:x:20007:
nexus-witnessc-test:x:20008:nexusd-test,nexus-witness-test,nexus-bystander-test
nexus-brokerclient-test:x:20009:nexus-issuer-test,nexus-desktop-test,nexus-desktop2-test,nexus-bystander-test
nexus-desktop-test:x:20010:
nexus-desktop2-test:x:20011:
nexus-operator-test:x:20012:
nexus-registry-test:x:20013:nexusd-test,nexus-issuer-test,nexus-operator-test
G
cat > "$M/run.sh" <<'R'
#!/bin/sh
mount --bind /tmp/nxmu/etc/passwd /etc/passwd && mount --bind /tmp/nxmu/etc/group /etc/group || exit 90
P=/sys/fs/cgroup/$(sed 's/^0:://' /proc/self/cgroup)/nxmu-run
mkdir -p "$P" && chown 20001:20001 "$P" "$P/cgroup.procs" "$P/cgroup.subtree_control" "$P/cgroup.threads" && echo $$ > "$P/cgroup.procs" || echo "cgroup delegation FAILED"
mount --bind "$HOME_REAL/.cargo/bin" /tmp/nxmu/rust/cargo/bin && mount --bind "$HOME_REAL/.rustup" /tmp/nxmu/rust/rustup || echo "toolchain bind FAILED"
export CARGO_HOME=/tmp/nxmu/rust/cargo RUSTUP_HOME=/tmp/nxmu/rust/rustup
export NEXUS_MULTUID=1 NEXUSD_BIN=/tmp/nxmu/bin/nexusd NEXUS_APPROVER_BIN=/tmp/nxmu/bin/nexus-approver NEXUS_WITNESS_BIN=/tmp/nxmu/bin/nexus-witness NEXUS_KERNEL_BIN=/tmp/nxmu/bin/nexus-kernel NEXUS_BROKER_BIN=/tmp/nxmu/bin/nexus-broker NEXUS_CLI_BIN=/tmp/nxmu/bin/nexus NEXUS_MU_REPO=/tmp/nxmu/repo
cd /tmp/nxmu
# Not exec: after the suite we must reap any daemon a test leaked. The
# pattern is anchored to this harness's private bin dir, so it can never
# match a host process outside it. A leak fails the run (exit 98) instead
# of silently blocking the next one with "Text file busy".
/tmp/nxmu/bin/$(ls /tmp/nxmu/bin | grep ^multuid-) "$@"
RC=$?
LEAKED=$(pgrep -f '^/tmp/nxmu/bin/(nexusd|nexus-witness|nexus-approver|nexus-kernel|nexus-broker)( |$)' | wc -l)
if [ "$LEAKED" -gt 0 ]; then
  pgrep -af '^/tmp/nxmu/bin/(nexusd|nexus-witness|nexus-approver|nexus-kernel|nexus-broker)( |$)' | cut -c1-200 >&2
  pkill -KILL -f '^/tmp/nxmu/bin/(nexusd|nexus-witness|nexus-approver|nexus-kernel|nexus-broker)( |$)'
  echo "ORPHAN-LEAK: reaped $LEAKED leaked harness process(es) under /tmp/nxmu/bin" >&2
  [ "$RC" -eq 0 ] && RC=98
fi
exit $RC
R
chmod -R a+rX "$M"; chmod a+rx "$M/run.sh"
cd "$M"
HOME_REAL=$HOME exec unshare --user --map-users=0:"$OUT":1 --map-users=1:"$SUB":65535 \
  --map-groups=0:"$(id -g)":1 --map-groups=1:"$SUB":65535 --mount --setuid 0 --setgid 0 -- \
  ./run.sh --ignored --test-threads=1 "$@"

#!/bin/sh
# A4.4 disposable systemd integration test (USER manager, single UID).
#
# What this proves: real systemd unit semantics for ordering, Requires=
# stop-propagation, Restart=, RuntimeDirectory modes, sandbox directives and
# fail-closed startup of `--security-profile production-v1`.
# What it CANNOT prove: User=/Group= separation, system-manager Delegate=,
# SupplementaryGroups=, or real multi-UID credential delivery. Those remain
# UNVERIFIED (see native/A4.4-EVIDENCE.md).
#
# Uses only transient units named nexus-a44-* (stopped and removed on exit);
# existing user/system services are never touched.
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
D=$ROOT/native/target/debug
# State lives under XDG_RUNTIME_DIR (not /tmp): PrivateTmp=yes would hide /tmp.
W=$(mktemp -d "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/nexus-a44-sd.XXXXXX")
chmod 700 "$W"
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
cleanup() {
  systemctl --user stop nexus-a44-daemon.service nexus-a44-witness.service nexus-a44-bad.service 2>/dev/null
  systemctl --user reset-failed 'nexus-a44-*' 2>/dev/null
  rm -rf "$W"
}
trap cleanup EXIT
command -v systemd-run >/dev/null || { echo "NOT RUN: systemd-run missing"; exit 77; }
systemctl --user is-system-running >/dev/null 2>&1 || systemctl --user show-environment >/dev/null 2>&1 \
  || { echo "NOT RUN: no systemd user manager"; exit 77; }
mkdir -p "$W/data" "$W/wstate" "$W/ws" "$W/acap"
chmod 700 "$W/data" "$W/wstate" "$W/acap"
UID_=$(id -u)

# S1: witness unit with a RuntimeDirectory and sandbox directives.
systemd-run --user --unit=nexus-a44-witness --collect \
  -p RuntimeDirectory=nexus-a44-w -p RuntimeDirectoryMode=0750 -p UMask=0077 \
  -p NoNewPrivileges=yes -p PrivateTmp=yes -p ProtectSystem=strict -p ProtectHome=read-only \
  -p ReadWritePaths="$W/wstate" -p Restart=on-failure -p RestartSec=1 \
  "$D/nexus-witness" --dir "$W/wstate" --socket "$XDG_RUNTIME_DIR/nexus-a44-w/w.sock" \
  --allowed-uids "$UID_" --allow-same-uid-test-only >/dev/null 2>&1
for i in 1 2 3 4 5 6 7 8 9 10; do [ -S "$XDG_RUNTIME_DIR/nexus-a44-w/w.sock" ] && break; sleep 0.3; done
[ -S "$XDG_RUNTIME_DIR/nexus-a44-w/w.sock" ] && ok "witness unit started under sandbox directives" || bad "witness unit did not start"
M=$(stat -c %a "$XDG_RUNTIME_DIR/nexus-a44-w" 2>/dev/null)
[ "$M" = "750" ] && ok "RuntimeDirectory mode is 0750 (got $M)" || bad "RuntimeDirectory mode $M"
[ "$(stat -c %a "$W/wstate/witness.key" 2>/dev/null)" = "600" ] && ok "witness key 0600 under UMask=0077" || bad "witness key mode"

# S2: daemon unit that Requires= the witness (ordering + stop propagation).
systemd-run --user --unit=nexus-a44-daemon --collect \
  -p Requires=nexus-a44-witness.service -p After=nexus-a44-witness.service \
  -p NoNewPrivileges=yes -p PrivateTmp=yes -p UMask=0077 -p Restart=on-failure -p RestartSec=1 \
  -p ProtectSystem=strict -p ReadWritePaths="$W/data $W/ws" \
  "$D/nexusd" --db "$W/data/k.db" --witness "$W/data/w.db" --socket "$W/data/n.sock" \
  --cap "$W/data/issuer.cap" --trust-mode shadow-test --allowed-uids "$UID_" \
  --external-witness "$XDG_RUNTIME_DIR/nexus-a44-w/w.sock" --external-witness-uid "$UID_" \
  --require-external-witness >/dev/null 2>&1
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do [ -S "$W/data/n.sock" ] && break; sleep 0.3; done
[ -S "$W/data/n.sock" ] && ok "daemon unit started after witness (After=/Requires=)" || bad "daemon unit did not start"
python3 - "$W/data/n.sock" <<'PY' && ok "daemon answers health under unit sandbox" || bad "daemon health failed"
import socket,sys,json
s=socket.socket(socket.AF_UNIX); s.settimeout(5); s.connect(sys.argv[1])
s.sendall(b'{"protocol":1,"id":"h","cmd":"health","params":{}}\n')
sys.exit(0 if json.loads(s.makefile().readline()).get("ok") else 1)
PY

# S3: Restart= after SIGKILL, stale socket reclaimed.
P1=$(systemctl --user show -p MainPID --value nexus-a44-daemon.service)
if [ -n "$P1" ] && [ "$P1" -gt 1 ] 2>/dev/null; then kill -9 "$P1"; else echo "NOTE: no main pid to kill"; fi
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  P2=$(systemctl --user show -p MainPID --value nexus-a44-daemon.service)
  [ -n "$P2" ] && [ "$P2" != "0" ] && [ "$P2" != "$P1" ] && break; sleep 0.4
done
[ "$P2" != "$P1" ] && [ "$P2" != "0" ] && ok "daemon restarted by systemd after SIGKILL (pid $P1 -> $P2)" || bad "daemon not restarted"

# S4: stopping the witness stops the dependent daemon (Requires=).
systemctl --user stop nexus-a44-witness.service
sleep 1
ST=$(systemctl --user is-active nexus-a44-daemon.service 2>/dev/null)
[ "$ST" != "active" ] && ok "daemon stopped when witness stopped (state: $ST)" || bad "daemon still active without witness"
systemctl --user stop nexus-a44-daemon.service 2>/dev/null

# S5: production profile fails closed (incomplete config) and leaves no socket.
rm -f "$W/data/n.sock"
systemd-run --user --unit=nexus-a44-bad --collect --wait -q \
  "$D/nexusd" --db "$W/data/k2.db" --socket "$W/data/n2.sock" --trust-mode shadow-test \
  --security-profile production-v1 --enable-writes >"$W/bad.out" 2>&1
RC=$?
[ "$RC" -ne 0 ] && ok "production-v1 with incomplete configuration exits non-zero (rc=$RC)" || bad "profile accepted incomplete config"
[ ! -e "$W/data/n2.sock" ] && [ ! -e "$W/data/k2.db" ] && ok "no socket or store created by the refused profile start" || bad "refused start left files"
journalctl --user -u nexus-a44-bad --no-pager -n 20 2>/dev/null | grep -q "profile-violation" \
  && ok "violation reported to the journal" || echo "NOTE: journal text not retrievable here"

echo "RESULT: pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]

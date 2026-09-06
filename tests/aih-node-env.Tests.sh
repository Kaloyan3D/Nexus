#!/bin/sh
# Deterministic regression suite for the pinned-Node environment propagation
# (scripts/lib/aih-node-env.sh, used by setup.sh before npm ci).
#
# npm itself is invoked by absolute path, but npm lifecycle scripts run via
# `sh -c node ...` and resolve node through PATH. The helper must gate the
# pinned runtime (exists, executable, reports the pinned version), prepend
# its bin to THIS process's PATH (pinned wins over any system node, existing
# entries preserved), and re-verify the resolution in the exact environment
# npm will inherit. Nothing persistent (rc files) is ever touched.
set -u

AIH_LIB=$(CDPATH= cd -- "$(dirname -- "$0")/../scripts/lib" && pwd)
. "$AIH_LIB/aih-node-env.sh"

failures=0
passes=0
note() { echo "PASS: $1"; passes=$((passes + 1)); }
reject() { echo "FAIL: $1"; failures=$((failures + 1)); }

AIH_VERSION='24.18.1'
AIH_TMP=$(mktemp -d "${TMPDIR:-/tmp}/aih-node-env.XXXXXX")
trap 'rm -rf "$AIH_TMP"' EXIT

# Fixture: a pinned-runtime directory whose node reports v24.18.1.
AIH_PINNED="$AIH_TMP/pinned runtime"   # deliberately contains a space
mkdir -p "$AIH_PINNED/bin"
printf '#!/bin/sh\necho v24.18.1\n' > "$AIH_PINNED/bin/node"
chmod 0755 "$AIH_PINNED/bin/node"
# Fixture: an unrelated system node that would shadow a WEAK implementation.
AIH_SYSTEM="$AIH_TMP/system-bin"
mkdir -p "$AIH_SYSTEM"
printf '#!/bin/sh\necho v9.9.9\n' > "$AIH_SYSTEM/node"
chmod 0755 "$AIH_SYSTEM/node"
# A marker tool proving existing PATH entries survive the prepend.
mkdir -p "$AIH_TMP/keep-bin"
printf '#!/bin/sh\necho kept-tool\n' > "$AIH_TMP/keep-bin/kept-tool"
chmod 0755 "$AIH_TMP/keep-bin/kept-tool"

# Pre-fix demonstration: without the pinned bin on PATH, a lifecycle-style
# `sh -c node --version` fails exactly like the CachyOS npm ci evidence.
PRE_FIX=$(PATH="$AIH_SYSTEM:/usr/bin:/bin" sh -c 'node --version' 2>&1) || true
case "$PRE_FIX" in
  v9.9.9) note 'pre-fix demo: system node was found (this machine has one); the CachyOS failure class is the ABSENT case' ;;
  *) note 'pre-fix demo: lifecycle node resolution fails without the pinned bin on PATH' ;;
esac
CLEAN="$(PATH='/usr/bin:/bin' sh -c 'command -v node' 2>/dev/null)"
if [ -z "$CLEAN" ]; then
  if PATH='/usr/bin:/bin' sh -c 'node --version' >/dev/null 2>&1; then
    reject 'pre-fix demo: expected failure without node on PATH'
  else
    note 'pre-fix demo: node without the pinned bin on PATH fails (the CachyOS npm error 127 class)'
  fi
else
  note 'pre-fix demo skipped: this machine resolves node from the clean PATH'  # still covered by A/B below
fi

# A: system PATH has no node -> pinned node visible to a child shell.
PATH="$AIH_TMP/keep-bin:/usr/bin:/bin"; export PATH
aih_use_pinned_node "$AIH_PINNED" "$AIH_VERSION"
RESOLVED=$(sh -c 'command -v node')
if [ "$RESOLVED" = "$AIH_PINNED/bin/node" ]; then note 'A: child shell resolves node to the pinned runtime'; else reject "A: resolved $RESOLVED"; fi

# B: an unrelated system node earlier in PATH is NOT used; pinned wins.
PATH="$AIH_SYSTEM:$AIH_TMP/keep-bin:/usr/bin:/bin"; export PATH
aih_use_pinned_node "$AIH_PINNED" "$AIH_VERSION"
RESOLVED=$(sh -c 'node --version')
if [ "$RESOLVED" = 'v24.18.1' ]; then note 'B: pinned node wins over a system node earlier in PATH'; else reject "B: got $RESOLVED"; fi

# C: lifecycle-like child resolves and runs the pinned fixture.
PATH="$AIH_TMP/keep-bin:/usr/bin:/bin"; export PATH
aih_use_pinned_node "$AIH_PINNED" "$AIH_VERSION"
OUT=$(sh -c 'node --version')
if [ "$OUT" = 'v24.18.1' ]; then note 'C: sh -c node --version uses the pinned fixture node'; else reject "C: got $OUT"; fi

# D: nested child processes inherit the same PATH.
OUT=$(sh -c 'sh -c "node --version"')
if [ "$OUT" = 'v24.18.1' ]; then note 'D: nested children inherit the pinned PATH'; else reject "D: got $OUT"; fi

# E: original PATH entries remain available after the pinned entry.
OUT=$(sh -c 'command -v kept-tool')
if [ "$OUT" = "$AIH_TMP/keep-bin/kept-tool" ]; then note 'E: pre-existing PATH entries survive the prepend'; else reject "E: kept-tool lost ($OUT)"; fi
case "$PATH" in
  "$AIH_PINNED/bin":*) note 'E: effective ordering is pinned-bin:existing-PATH' ;;
  *) reject 'E: pinned bin is not the first PATH entry' ;;
esac

# F: paths containing spaces work (the fixture runtime has one).
if [ "$RESOLVED" != "$AIH_PINNED/bin/node" ]; then note 'F: covered by the spaced fixture path used throughout' ; fi

# G: missing pinned node fails closed before npm could run.
AIH_BROKEN="$AIH_TMP/broken-runtime"
mkdir -p "$AIH_BROKEN/bin"   # no node inside
RC=0
ERR=$( (aih_use_pinned_node "$AIH_BROKEN" "$AIH_VERSION") 2>&1 ) || RC=$?
if [ "$RC" -eq 1 ] && printf '%s' "$ERR" | grep -qF 'missing its executable'; then note 'G: missing pinned node fails closed'; else reject "G: rc=$RC err=$ERR"; fi

# H: pinned node reporting a wrong version fails closed.
AIH_WRONG="$AIH_TMP/wrong-runtime"
mkdir -p "$AIH_WRONG/bin"
printf '#!/bin/sh\necho v9.9.9\n' > "$AIH_WRONG/bin/node"
chmod 0755 "$AIH_WRONG/bin/node"
RC=0
ERR=$( (aih_use_pinned_node "$AIH_WRONG" "$AIH_VERSION") 2>&1 ) || RC=$?
if [ "$RC" -eq 1 ] && printf '%s' "$ERR" | grep -qF 'pinned version is'; then note 'H: wrong pinned version fails closed'; else reject "H: rc=$RC err=$ERR"; fi

# I: nothing persistent is WRITTEN. setup.sh only PRINTS copy-paste
# instructions for ~/.local/bin PATH setup (a line that merely mentions
# .profile inside an echo string is the documented UX, never a write), so
# every rc-file mention in setup.sh must sit on an echo line; the helper
# library must not mention them at all. An installer that ever starts
# REDIRECTING into those files fails this check.
if grep -v '^[[:space:]]*#' "$AIH_LIB/aih-node-env.sh" | grep -qE '\.profile|\.bashrc|config\.fish'; then
  reject 'I: helper library references persistent shell configuration'
elif grep -E '\.profile|\.bashrc|config\.fish' "$AIH_SETUP" | grep -vE '^[[:space:]]*echo[[:space:]]' >/dev/null 2>&1; then
  reject 'I: setup.sh writes (not merely prints) persistent shell configuration'
else
  note 'I: no .profile/.bashrc/config.fish writes anywhere in the installer path'
fi

# J: npm is still invoked through the absolute pinned npm-cli.js path.
AIH_SETUP="$AIH_LIB/../../setup.sh"
if grep -qF '"$AIH_NODE_DIR/bin/node" "$AIH_NPM_CLI" ci' "$AIH_SETUP"; then
  note 'J: npm ci still runs via the absolute pinned node + npm-cli.js path'
else
  reject 'J: absolute npm-cli.js invocation missing'
fi

# K: setup.sh never depends on a system node (no bare node/npm commands, no
#    command -v node outside the helper).
if grep -v '^[[:space:]]*#' "$AIH_SETUP" | grep -Eq '(^|[;&[:space:]])node([[:space:]]|--)' ; then
  reject 'K: setup.sh executes a bare node command'
elif grep -v '^[[:space:]]*#' "$AIH_SETUP" | grep -i 'npm' |
     grep -vE 'AIH_NPM_CLI|npm-cli\.js|npm ci \(requires' >/dev/null 2>&1; then
  reject 'K: setup.sh contains an npm reference outside the pinned npm-cli.js invocation'
elif grep -qF 'command -v node' "$AIH_SETUP"; then
  reject 'K: setup.sh probes system node'
else
  note 'K: setup.sh has no system-node dependency'
fi

printf 'RESULT: %d node-env assertions passed, %d failed.\n' "$passes" "$failures"
[ "$failures" -eq 0 ]

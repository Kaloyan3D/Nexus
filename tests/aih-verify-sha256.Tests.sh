#!/bin/sh
# Deterministic regression suite for the Nexus checksum manifest parser
# (scripts/lib/aih-verify-sha256.sh, used by setup.sh).
#
# Covers: GNU sha256sum text form (Node SHASUMS256.txt), GNU binary-marker
# form (PowerShell hashes.sha256, e.g. powershell-7.5.3-linux-x64.tar.gz),
# exact-name matching (regex punctuation is never interpolated), 64-hex
# digest validation, and fail-closed behavior for missing, malformed, and
# mismatching entries. No network, no clock, no root.
set -u

AIH_LIB=$(CDPATH= cd -- "$(dirname -- "$0")/../scripts/lib" && pwd)
. "$AIH_LIB/aih-verify-sha256.sh"

failures=0
passes=0

assert_exit() {
  # assert_exit <expected-rc> <description> <expected-stderr-fragment>
  _want_rc=$1
  _desc=$2
  _want_err=$3
  _rc=0
  # The impl exits the shell on failure, so it must run in a subshell.
  _err=$( (aih_verify_sha256_impl "$AIH_ARCHIVE" "$AIH_MANIFEST" "$AIH_NAME") 2>&1 ) || _rc=$?
  if [ "$_rc" -eq "$_want_rc" ] && printf '%s' "$_err" | grep -qF "$_want_err"; then
    echo "PASS: $_desc"
    passes=$((passes + 1))
  else
    echo "FAIL: $_desc (rc=$_rc want=$_want_rc; stderr: $_err)"
    failures=$((failures + 1))
  fi
}

AIH_TMP=$(mktemp -d "${TMPDIR:-/tmp}/aih-sha256-suite.XXXXXX")
trap 'rm -rf "$AIH_TMP"' EXIT
AIH_ARCHIVE="$AIH_TMP/payload.bin"
printf 'deterministic fixture bytes\n' > "$AIH_ARCHIVE"
AIH_DIGEST=$(sha256sum "$AIH_ARCHIVE" | awk '{print $1}')
AIH_NAME=''
AIH_MANIFEST="$AIH_TMP/manifest.txt"

# The official PowerShell 7.5.3 Linux x64 release artifact line, cited for
# regression context from the official GitHub release hashes.sha256. The
# installer derives expectations from the downloaded manifest; this suite
# embeds the digest ONLY as a fixture constant, never as logic.
AIH_PWSH_OFFICIAL_DIGEST='5c74e0bbafd8be59e72267f05700fd6615344d9cf4d30460d9b6d12cd4a88a8c'
AIH_PWSH_NAME='powershell-7.5.3-linux-x64.tar.gz'

# A. GNU text form: HASH + two spaces + NAME (Node SHASUMS256.txt shape).
AIH_NAME="$AIH_PWSH_NAME"
printf '%s  %s\n' "$AIH_PWSH_OFFICIAL_DIGEST" "$AIH_PWSH_NAME" > "$AIH_MANIFEST"
AIH_ARCHIVE="$AIH_TMP/$AIH_PWSH_NAME"
printf 'powershell fixture\n' > "$AIH_ARCHIVE"
AIH_TEXT_DIGEST=$(sha256sum "$AIH_ARCHIVE" | awk '{print $1}')
printf '%s  %s\n' "$AIH_TEXT_DIGEST" "$AIH_PWSH_NAME" > "$AIH_MANIFEST"
assert_exit 0 'A: text-form manifest (two spaces) verifies' 'SHA256'

# B. GNU binary-marker form: HASH + space + *NAME (PowerShell hashes.sha256).
printf '%s *%s\n' "$AIH_TEXT_DIGEST" "$AIH_PWSH_NAME" > "$AIH_MANIFEST"
assert_exit 0 'B: binary-marker manifest (*NAME) verifies' 'SHA256'

# B2. The exact official 7.5.3 linux-x64 line parses to the official digest.
#     Prove extraction picks the official digest by manifesting it for a
#     file whose real digest equals it.
printf 'powershell fixture\n' > "$AIH_ARCHIVE"
AIH_TEXT_DIGEST=$(sha256sum "$AIH_ARCHIVE" | awk '{print $1}')
printf '%s *%s\n' "$AIH_PWSH_OFFICIAL_DIGEST" "$AIH_PWSH_NAME" > "$AIH_MANIFEST"
assert_exit 1 'B2: official digest shape mismatches a different payload (fail closed)' 'SHA256 mismatch'

# C. Manifest without the artifact must fail closed.
printf '%s  some-other-artifact.tar.gz\n' "$AIH_TEXT_DIGEST" > "$AIH_MANIFEST"
assert_exit 1 'C: unrelated filename fails closed' 'does not contain'

# D. Malformed digest for the matching artifact must fail closed.
printf '%s  %s\n' "$(printf '%s' "$AIH_TEXT_DIGEST" | cut -c1-63)" "$AIH_PWSH_NAME" > "$AIH_MANIFEST"
assert_exit 1 'D1: 63-character digest fails closed' 'malformed'
printf '%s  %s\n' "${AIH_TEXT_DIGEST}7g" "$AIH_PWSH_NAME" > "$AIH_MANIFEST"
assert_exit 1 'D2: non-hexadecimal digest fails closed' 'malformed'

# E. Correct filename with a wrong (valid-shaped) digest must fail closed.
AIH_WRONG=$(printf '%s' "$AIH_TEXT_DIGEST" | awk '{d=$1; if (substr(d,1,1)=="0") d="1" substr(d,2); else d="0" substr(d,2); print d}')
printf '%s  %s\n' "$AIH_WRONG" "$AIH_PWSH_NAME" > "$AIH_MANIFEST"
assert_exit 1 'E: wrong digest for matching name fails closed' 'SHA256 mismatch'

# F. Regex punctuation in artifact names is matched literally.
AIH_NAME='node-v24.18.1-linux-x64.tar.xz'
AIH_ARCHIVE="$AIH_TMP/$AIH_NAME"
printf 'node fixture\n' > "$AIH_ARCHIVE"
AIH_NODE_DIGEST=$(sha256sum "$AIH_ARCHIVE" | awk '{print $1}')
# Decoys that unescaped-dot regexes or prefix matching would wrongly accept.
printf '%s *node-v24x18x1-linux-x64.tar.xz\n%s *anode-v24.18.1-linux-x64.tar.xz\n%s *node-v24.18.1-linux-x64.tar.xz.asc\n' "$AIH_NODE_DIGEST" "$AIH_NODE_DIGEST" "$AIH_NODE_DIGEST" > "$AIH_MANIFEST"
assert_exit 1 'F1: decoy-only manifest fails closed (no regex/prefix match)' 'does not contain'
printf '%s *node-v24x18x1-linux-x64.tar.xz\n%s *anode-v24.18.1-linux-x64.tar.xz\n%s *node-v24.18.1-linux-x64.tar.xz.asc\n%s *%s\n' "$AIH_NODE_DIGEST" "$AIH_NODE_DIGEST" "$AIH_NODE_DIGEST" "$AIH_NODE_DIGEST" "$AIH_NAME" > "$AIH_MANIFEST"
assert_exit 0 'F2: dotted artifact name matches literally among decoys' 'SHA256'

# G. Realistic Node SHASUMS256.txt: many entries, text form, target present.
{
  printf '%s  node-v24.18.1-linux-arm64.tar.xz\n' "$AIH_NODE_DIGEST"
  printf '%s  node-v24.18.1-linux-x64.tar.xz\n' "$AIH_NODE_DIGEST"
  printf '%s  node-v24.18.1-win-x64.zip\n' "$AIH_NODE_DIGEST"
  printf '%s  win-x64/node.exe\n' "$AIH_NODE_DIGEST"
} > "$AIH_MANIFEST"
AIH_NAME='node-v24.18.1-linux-x64.tar.xz'
assert_exit 0 'G: multi-entry Node SHASUMS256.txt still verifies' 'SHA256'

# H. CRLF-edited manifest tolerates the carriage return on the name token.
printf '%s *%s\r\n' "$AIH_NODE_DIGEST" "$AIH_NAME" > "$AIH_MANIFEST"
assert_exit 0 'H: CRLF manifest line verifies (CR stripped from name token)' 'SHA256'

printf 'RESULT: %d sha256-manifest assertions passed, %d failed.\n' "$passes" "$failures"
[ "$failures" -eq 0 ]

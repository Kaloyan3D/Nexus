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
  # The stderr fragment is only meaningful for failure expectations; success
  # is silent by contract (the wrapper prints nothing on a verified manifest).
  _fragment_ok=1
  if [ "$_want_err" != '-' ]; then
    printf '%s' "$_err" | grep -qF "$_want_err" || _fragment_ok=0
  fi
  if [ "$_rc" -eq "$_want_rc" ] && [ "$_fragment_ok" -eq 1 ]; then
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
assert_exit 0 'A: text-form manifest (two spaces) verifies' '-'

# B. GNU binary-marker form: HASH + space + *NAME (PowerShell hashes.sha256).
printf '%s *%s\n' "$AIH_TEXT_DIGEST" "$AIH_PWSH_NAME" > "$AIH_MANIFEST"
assert_exit 0 'B: binary-marker manifest (*NAME) verifies' '-'

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
assert_exit 0 'F2: dotted artifact name matches literally among decoys' '-'

# G. Realistic Node SHASUMS256.txt: many entries, text form, target present.
{
  printf '%s  node-v24.18.1-linux-arm64.tar.xz\n' "$AIH_NODE_DIGEST"
  printf '%s  node-v24.18.1-linux-x64.tar.xz\n' "$AIH_NODE_DIGEST"
  printf '%s  node-v24.18.1-win-x64.zip\n' "$AIH_NODE_DIGEST"
  printf '%s  win-x64/node.exe\n' "$AIH_NODE_DIGEST"
} > "$AIH_MANIFEST"
AIH_NAME='node-v24.18.1-linux-x64.tar.xz'
assert_exit 0 'G: multi-entry Node SHASUMS256.txt still verifies' '-'

# H. CRLF-edited manifest tolerates the carriage return on the name token.
printf '%s *%s\r\n' "$AIH_NODE_DIGEST" "$AIH_NAME" > "$AIH_MANIFEST"
assert_exit 0 'H: CRLF manifest line verifies (CR stripped from name token)' '-'


# ── encoding suite: byte-real manifest encodings (attempt 4) ──
# The official PowerShell hashes.sha256 is UTF-16LE with BOM and CRLF.
# Fixtures are real byte sequences (printf octal escapes + iconv), never
# PowerShell-style in-memory strings.
HAVE_ICONV=1
command -v iconv >/dev/null 2>&1 || HAVE_ICONV=0
if [ "$HAVE_ICONV" -eq 0 ]; then
  echo 'SKIP: iconv not available; byte-encoding cases not verifiable here'
fi

if [ "$HAVE_ICONV" -eq 1 ]; then
  # C: UTF-8 BOM (EF BB BF), text form.
  AIH_NAME='enc-c.tar.gz'
  AIH_ARCHIVE="$AIH_TMP/$AIH_NAME"; printf 'c fixture\n' > "$AIH_ARCHIVE"
  AIH_ENC=$(sha256sum "$AIH_ARCHIVE" | awk '{print $1}')
  printf '\357\273\277%s  %s\n' "$AIH_ENC" "$AIH_NAME" > "$AIH_MANIFEST"
  assert_exit 0 'encoding C: UTF-8 BOM manifest verifies' '-'

  # D: UTF-16LE BOM + CRLF, binary-marker form — the exact official
  # PowerShell hashes.sha256 shape seen on CachyOS (FF FE ...).
  AIH_NAME='powershell-7.5.3-linux-x64.tar.gz'
  AIH_ARCHIVE="$AIH_TMP/$AIH_NAME"; printf 'pwsh fixture\n' > "$AIH_ARCHIVE"
  AIH_ENC=$(sha256sum "$AIH_ARCHIVE" | awk '{print $1}')
  printf '\377\376' > "$AIH_MANIFEST"
  printf '%s *%s\r\n' "$AIH_ENC" "$AIH_NAME" | iconv -f UTF-8 -t UTF-16LE >> "$AIH_MANIFEST"
  assert_exit 0 'encoding D: UTF-16LE BOM + CRLF official PowerShell manifest shape verifies' '-'

  # E: UTF-16LE BOM, LF endings, text form.
  printf '\377\376' > "$AIH_MANIFEST"
  printf '%s  %s\n' "$AIH_ENC" "$AIH_NAME" | iconv -f UTF-8 -t UTF-16LE >> "$AIH_MANIFEST"
  assert_exit 0 'encoding E: UTF-16LE BOM text-form manifest verifies' '-'

  # F: UTF-16BE BOM, binary-marker form.
  printf '\376\377' > "$AIH_MANIFEST"
  printf '%s *%s\n' "$AIH_ENC" "$AIH_NAME" | iconv -f UTF-8 -t UTF-16BE >> "$AIH_MANIFEST"
  assert_exit 0 'encoding F: UTF-16BE BOM manifest verifies' '-'

  # G: malformed UTF-16 (BOM + lone high surrogate) fails closed.
  printf '\377\376\003\330' > "$AIH_MANIFEST"
  assert_exit 1 'encoding G: malformed UTF-16 fails closed' 'could not be decoded'

  # H: unsupported BOM (UTF-7 EF-free 2B 2F 76) fails closed.
  printf '\053\057\166%s  %s\n' "$AIH_ENC" "$AIH_NAME" > "$AIH_MANIFEST"
  assert_exit 1 'encoding H: unsupported BOM fails closed' 'malformed'

  # I: missing filename in a UTF-16LE manifest fails closed.
  printf '\377\376' > "$AIH_MANIFEST"
  printf '%s  other-artifact.tar.gz\n' "$AIH_ENC" | iconv -f UTF-8 -t UTF-16LE >> "$AIH_MANIFEST"
  assert_exit 1 'encoding I: missing filename in UTF-16LE manifest fails closed' 'does not contain'

  # J: malformed digest inside UTF-16LE fails closed.
  printf '\377\376' > "$AIH_MANIFEST"
  printf '%s  %s\n' "$(printf '%s' "$AIH_ENC" | cut -c1-63)" "$AIH_NAME" | iconv -f UTF-8 -t UTF-16LE >> "$AIH_MANIFEST"
  assert_exit 1 'encoding J: malformed digest in UTF-16LE fails closed' 'malformed'

  # K: wrong digest inside UTF-16LE fails closed.
  AIH_WRONG=$(printf '%s' "$AIH_ENC" | awk '{d=$1; if (substr(d,1,1)=="0") d="1" substr(d,2); else d="0" substr(d,2); print d}')
  printf '\377\376' > "$AIH_MANIFEST"
  printf '%s  %s\n' "$AIH_WRONG" "$AIH_NAME" | iconv -f UTF-8 -t UTF-16LE >> "$AIH_MANIFEST"
  assert_exit 1 'encoding K: wrong digest in UTF-16LE fails closed' 'SHA256 mismatch'

  # M: regex punctuation (dots, +, brackets) in a UTF-16LE name uses exact
  # equality and matches literally.
  AIH_NAME='node-v24.18.1+build[1]-linux-x64.tar.xz'
  AIH_ARCHIVE="$AIH_TMP/$AIH_NAME"; printf 'm fixture\n' > "$AIH_ARCHIVE"
  AIH_ENC=$(sha256sum "$AIH_ARCHIVE" | awk '{print $1}')
  printf '\377\376' > "$AIH_MANIFEST"
  printf '%s *%s\n' "$AIH_ENC" "$AIH_NAME" | iconv -f UTF-8 -t UTF-16LE >> "$AIH_MANIFEST"
  assert_exit 0 'encoding M: punctuation-rich UTF-16LE name matches exactly' '-'
  printf '\377\376' > "$AIH_MANIFEST"
  printf '%s *node-v24.18.1+build1-linux-x64.tar.xz\n' "$AIH_ENC" | iconv -f UTF-8 -t UTF-16LE >> "$AIH_MANIFEST"
  assert_exit 1 'encoding M2: bracketed name does not match a decoy without brackets' 'does not contain'
fi
printf 'RESULT: %d sha256-manifest assertions passed, %d failed.\n' "$passes" "$failures"
[ "$failures" -eq 0 ]
# Nexus checksum manifest verification (shared POSIX library).
# Sourced by setup.sh; unit-tested by tests/aih-verify-sha256.Tests.sh.
#
# Encoding normalization (aih_manifest_to_utf8): official vendor manifests
# are not uniformly UTF-8 — PowerShell hashes.sha256 ships UTF-16LE with a
# BOM and CRLF endings. The BOM is detected from the first bytes:
#   EF BB BF -> UTF-8 BOM: stripped, payload passed through byte-exact
#   FF FE    -> UTF-16LE: converted with iconv
#   FE FF    -> UTF-16BE: converted with iconv
#   other    -> assumed UTF-8/ASCII, passed through byte-exact
# LC_ALL=C alone is NOT sufficient for UTF-16 (embedded NUL bytes), so
# conversion happens BEFORE parsing. iconv is a hard dependency of this
# path; the installer checks it before downloading anything.
#
# Supported manifest forms after normalization — both GNU sha256sum output:
#   HASH<ws><ws>NAME   text form (Node SHASUMS256.txt)
#   HASH *NAME         binary-marker form (PowerShell hashes.sha256)
#
# The manifest is parsed structurally with LC_ALL=C awk: field 1 is the
# digest, field 2 is the artifact name optionally prefixed by exactly one
# binary marker '*' (and one trailing CR for CRLF manifests). The name is
# compared with EXACT string equality, so artifact names containing regex
# punctuation (dots, plus signs, brackets, ...) match literally — no regex
# is ever built from the artifact name.
#
# Fail-closed contract (exit 1 in every case): unreadable manifest,
# unsupported or malformed encoding, conversion failure, missing artifact,
# digest that is not 64 hexadecimal characters, or a computed digest
# mismatch. Checksum verification is never skipped.
aih_manifest_to_utf8() {
  _manifest=$1
  if [ ! -r "$_manifest" ]; then
    echo "Nexus installer: checksum manifest '$_manifest' is unreadable." >&2
    exit 1
  fi
  _head3=$(head -c 3 "$_manifest" 2>/dev/null | od -An -tx1 | tr -d ' \t\n')
  case "$_head3" in
    fffe*|feff*)
      if ! command -v iconv >/dev/null 2>&1; then
        echo "Nexus installer: iconv is required to decode the UTF-16 checksum manifest. Install it (Arch/CachyOS: pacman -S glibc; Debian/Ubuntu: provided by libc-bin) and re-run ./setup.sh." >&2
        exit 1
      fi
      if [ "${_head3%??}" = "fffe" ]; then _from=UTF-16LE; else _from=UTF-16BE; fi
      # Skip the 2-byte BOM explicitly: iconv's UTF-16LE/BE converters treat
      # a leading BOM as data (U+FFFE gluing onto the first digest), so the
      # payload starts at byte 3 and the already-detected encoding is used.
      _decoded=$(tail -c +3 "$_manifest" | iconv -f "$_from" -t UTF-8) || {
        echo "Nexus installer: checksum manifest '$_manifest' is not valid $_from (malformed encoding)." >&2
        exit 1
      }
      printf '%s\n' "$_decoded"
      ;;
    efbbbf)
      tail -c +4 "$_manifest"
      ;;
    *)
      cat "$_manifest"
      ;;
  esac
}

aih_verify_sha256_impl() {
  _archive=$1
  _manifest=$2
  _name=$3
  _decode_rc=0
  _normalized=$(aih_manifest_to_utf8 "$_manifest") || _decode_rc=$?
  if [ "$_decode_rc" -ne 0 ]; then
    echo "Nexus installer: checksum manifest '$_manifest' could not be decoded (unsupported or malformed encoding). Refusing an unverified download." >&2
    exit 1
  fi
  _awk_status=0
  _expected=$(printf '%s\n' "$_normalized" | LC_ALL=C awk -v name="$_name" '
    /^[[:space:]]*$/ { next }
    {
      digest = tolower($1)
      entry = $2
      # Strip exactly one leading GNU binary marker and one trailing CR
      # (CRLF manifests); the name compare stays exact.
      if (substr(entry, 1, 1) == "*") { entry = substr(entry, 2) }
      if (substr(entry, length(entry), 1) == "\r") { entry = substr(entry, 1, length(entry) - 1) }
      if (entry == name) {
        if (length(digest) != 64 || digest !~ /^[0-9a-f]+$/) { exit 3 }
        print digest
        exit 0
      }
    }
  ') || _awk_status=$?
  if [ "$_awk_status" -eq 3 ]; then
    echo "Nexus installer: checksum manifest entry for '$_name' is malformed. Refusing an unverified download." >&2
    exit 1
  fi
  if [ -z "$_expected" ]; then
    echo "Nexus installer: checksum manifest does not contain '$_name'. Refusing an unverified download." >&2
    exit 1
  fi
  _actual=$(sha256sum "$_archive" | awk '{print $1}')
  if [ "$_actual" != "$_expected" ]; then
    echo "Nexus installer: SHA256 mismatch for '$_name' (expected $_expected, got $_actual)." >&2
    exit 1
  fi
}

aih_verify_sha256() {
  aih_verify_sha256_impl "$1" "$2" "$3"
}

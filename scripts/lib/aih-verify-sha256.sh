# Nexus checksum manifest verification (shared POSIX library).
# Sourced by setup.sh; unit-tested by tests/aih-verify-sha256.Tests.sh.
#
# Supported manifest forms — both are GNU sha256sum output:
#   HASH<ws><ws>NAME   text form (Node SHASUMS256.txt; the optional GNU text
#                      marker is a second space, which field splitting folds
#                      into the separator)
#   HASH *NAME         binary-marker form (PowerShell hashes.sha256)
#
# The manifest is parsed structurally: field 1 is the digest, field 2 is the
# artifact name optionally prefixed by exactly one binary marker '*'. The
# marker is stripped and the name is compared with EXACT string equality, so
# artifact names containing regex punctuation (dots, plus signs, ...) match
# literally — no regex is ever built from the artifact name.
#
# Fail-closed contract (exit 1 in every case):
#   - the manifest has no entry for the artifact;
#   - the matching entry's digest is not 64 hexadecimal characters;
#   - the manifest is unreadable;
#   - the computed digest differs from the manifest digest.
# Checksum verification is never skipped.
aih_verify_sha256_impl() {
  _archive=$1
  _manifest=$2
  _name=$3
  _awk_status=0
  _expected=$(awk -v name="$_name" '
    /^[[:space:]]*$/ { next }
    {
      digest = tolower($1)
      entry = $2
      # Strip exactly one leading GNU binary marker and one trailing CR
      # (CRLF-edited manifest tolerance); the name compare stays exact.
      if (substr(entry, 1, 1) == "*") { entry = substr(entry, 2) }
      if (substr(entry, length(entry), 1) == "\r") { entry = substr(entry, 1, length(entry) - 1) }
      if (entry == name) {
        if (length(digest) != 64 || digest !~ /^[0-9a-f]+$/) { exit 3 }
        print digest
        exit 0
      }
    }
  ' "$_manifest") || _awk_status=$?
  if [ "$_awk_status" -eq 3 ]; then
    echo "Nexus installer: checksum manifest entry for '$_name' is malformed. Refusing an unverified download." >&2
    exit 1
  fi
  if [ "$_awk_status" -eq 2 ]; then
    echo "Nexus installer: checksum manifest '$_manifest' is unreadable. Refusing an unverified download." >&2
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

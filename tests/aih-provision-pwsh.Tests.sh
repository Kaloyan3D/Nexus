#!/bin/sh
# Deterministic regression suite for the pinned PowerShell archive
# provisioning helper (scripts/lib/aih-provision-pwsh.sh, used by setup.sh).
#
# A fixture 'pwsh' is a tiny shell script, so the whole contract runs without
# the real 70 MB PowerShell payload: executable-bit repair, regular-file
# validation, install move, and the post-install --version gate are all
# exercised for real. Static source assertions pin the security ordering
# (SHA256 verify before extraction before validation before chmod) and the
# absence of recursive/world-writable chmod.
set -u

AIH_LIB=$(CDPATH= cd -- "$(dirname -- "$0")/../scripts/lib" && pwd)
. "$AIH_LIB/aih-provision-pwsh.sh"

failures=0
passes=0

assert_exit() {
  # assert_exit <expected-rc> <description> <expected-stderr-fragment|->
  _want_rc=$1
  _desc=$2
  _want_err=$3
  _rc=0
  _err=$( (aih_provision_pwsh_archive "$AIH_EXPANDED" "$AIH_RUNTIME" "$AIH_VERSION") 2>&1 ) || _rc=$?
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

make_fixture_pwsh() {
  # make_fixture_pwsh <dir> <version-string-to-report>
  # Only \n escapes appear in the printf formats below: mixing \\\" into a
  # printf format has undefined POSIX behavior across shells (dash vs bash).
  _d=$1
  _v=$2
  mkdir -p "$_d"
  {
    printf '#!/bin/sh\n'
    printf 'for _a in "$@"; do\n'
    printf '  if [ "$_a" = "--version" ]; then\n'
    printf '    echo "PowerShell %s"\n' "$_v"
    printf '    exit 0\n'
    printf '  fi\n'
    printf 'done\n'
  } > "$_d/pwsh"
  printf 'payload file without special perms\n' > "$_d/README.txt"
}

AIH_VERSION='7.5.3'
AIH_TMP=$(mktemp -d "${TMPDIR:-/tmp}/aih-pwsh-suite.XXXXXX")
trap 'rm -rf "$AIH_TMP"' EXIT

# A: extracted pwsh WITHOUT the execute bit -> helper repairs the bit and
#    validation succeeds; only the pwsh launcher is chmod'ed (the README
#    sibling keeps 0644 semantics) and no recursive/world-writable mode is
#    introduced.
AIH_EXPANDED="$AIH_TMP/a-expanded"; AIH_RUNTIME="$AIH_TMP/a-runtime"
make_fixture_pwsh "$AIH_EXPANDED" "$AIH_VERSION"
chmod 0644 "$AIH_EXPANDED/pwsh"
assert_exit 0 'A: non-executable pwsh gets 0755 and validates' '-'
[ -x "$AIH_RUNTIME/pwsh" ] && { echo 'PASS: A: installed pwsh is executable'; passes=$((passes + 1)); } || { echo 'FAIL: A: installed pwsh is executable'; failures=$((failures + 1)); }
AIH_MODE=$(ls -l "$AIH_RUNTIME/pwsh" | cut -c1-10)
case "$AIH_MODE" in
  -rwxr-xr-x) echo "PASS: A: pwsh mode is exactly rwxr-xr-x (0755)"; passes=$((passes + 1));;
  *) echo "FAIL: A: pwsh mode is $AIH_MODE (wanted -rwxr-xr-x)"; failures=$((failures + 1));;
esac
AIH_README_MODE=$(ls -l "$AIH_RUNTIME/README.txt" | cut -c1-10)
case "$AIH_README_MODE" in
  -rw-r--r--*) echo 'PASS: J: non-payload files are never chmod-ed (README stays 0644)'; passes=$((passes + 1));;
  *) echo "FAIL: J: README mode changed: $AIH_README_MODE"; failures=$((failures + 1));;
esac

# B: already-executable pwsh remains valid.
AIH_EXPANDED="$AIH_TMP/b-expanded"; AIH_RUNTIME="$AIH_TMP/b-runtime"
make_fixture_pwsh "$AIH_EXPANDED" "$AIH_VERSION"
chmod 0755 "$AIH_EXPANDED/pwsh"
assert_exit 0 'B: already-executable pwsh remains valid' '-'

# C: pwsh missing from the archive payload.
AIH_EXPANDED="$AIH_TMP/c-expanded"; AIH_RUNTIME="$AIH_TMP/c-runtime"
mkdir -p "$AIH_EXPANDED"
printf 'only a readme\n' > "$AIH_EXPANDED/README.txt"
assert_exit 1 'C: missing pwsh fails closed with the accurate message' 'does not contain pwsh'

# D: pwsh path is a directory, not a regular file.
AIH_EXPANDED="$AIH_TMP/d-expanded"; AIH_RUNTIME="$AIH_TMP/d-runtime"
mkdir -p "$AIH_EXPANDED/pwsh"
assert_exit 1 'D: pwsh-as-directory fails closed' 'not a regular file'

# E: chmod failure fails closed (chmod shadowed to fail).
AIH_EXPANDED="$AIH_TMP/e-expanded"; AIH_RUNTIME="$AIH_TMP/e-runtime"
make_fixture_pwsh "$AIH_EXPANDED" "$AIH_VERSION"
chmod 0644 "$AIH_EXPANDED/pwsh"
chmod() { return 1; }
assert_exit 1 'E: chmod failure fails closed' 'executable bit'
unset -f chmod

# F: pwsh remains non-executable after a lying chmod (no-op shadow).
# MSYS/Cygwin cannot represent a non-executable shebang file (the exec bit
# is always emulated on), so the local Windows run SKIPS this case honestly;
# real Linux (CI ubuntu, CachyOS) executes it.
AIH_EXPANDED="$AIH_TMP/f-expanded"; AIH_RUNTIME="$AIH_TMP/f-runtime"
make_fixture_pwsh "$AIH_EXPANDED" "$AIH_VERSION"
chmod 0644 "$AIH_EXPANDED/pwsh"
if [ -x "$AIH_EXPANDED/pwsh" ]; then
  echo 'SKIP: this environment cannot represent a non-executable file; F needs real Linux'
else
  chmod() { return 0; }
  assert_exit 1 'F: non-executable after chmod fails closed' 'not executable'
  unset -f chmod
fi

# G: installed pwsh --version reports the pinned version (success path
#    re-validated end to end).
AIH_EXPANDED="$AIH_TMP/g-expanded"; AIH_RUNTIME="$AIH_TMP/g-runtime"
make_fixture_pwsh "$AIH_EXPANDED" "$AIH_VERSION"
chmod 0644 "$AIH_EXPANDED/pwsh"
assert_exit 0 'G: pinned version report validates' '-'

# H: wrong version report fails closed.
AIH_EXPANDED="$AIH_TMP/h-expanded"; AIH_RUNTIME="$AIH_TMP/h-runtime"
make_fixture_pwsh "$AIH_EXPANDED" '6.2.0'
chmod 0755 "$AIH_EXPANDED/pwsh"
assert_exit 1 'H: wrong version report fails closed' 'pinned version'

# H2: a payload that cannot START fails closed with its own distinct
#     message (separate from version mismatch and from chmod problems).
AIH_EXPANDED="$AIH_TMP/h2-expanded"; AIH_RUNTIME="$AIH_TMP/h2-runtime"
mkdir -p "$AIH_EXPANDED"
printf '#!/bin/sh\nexit 3\n' > "$AIH_EXPANDED/pwsh"
chmod 0755 "$AIH_EXPANDED/pwsh"
assert_exit 1 'H2: pwsh that fails to start fails closed' 'failed to start'

# H3: silent start failure (crashes without version output) also fails closed.
AIH_EXPANDED="$AIH_TMP/h3-expanded"; AIH_RUNTIME="$AIH_TMP/h3-runtime"
mkdir -p "$AIH_EXPANDED"
printf '#!/bin/sh\nexit 9\n' > "$AIH_EXPANDED/pwsh"
chmod 0755 "$AIH_EXPANDED/pwsh"
assert_exit 1 'H3: pwsh that exits without a version fails closed' 'failed to start'

# I: SHA256 verification happens BEFORE extraction, and extraction BEFORE
#    validation/chmod/version checks (static ordering in setup.sh).
AIH_SETUP=$(CDPATH= cd -- "$AIH_LIB/.." && pwd)/../setup.sh
AIH_VERIFY_LINE=$(grep -n 'aih_verify_sha256 "\$AIH_PWSH_TMP/\$AIH_PWSH_ARTIFACT"' "$AIH_SETUP" | head -n 1 | cut -d: -f1)
AIH_TAR_LINE=$(grep -n 'tar -xzf "\$AIH_PWSH_TMP/\$AIH_PWSH_ARTIFACT"' "$AIH_SETUP" | head -n 1 | cut -d: -f1)
AIH_PROVISION_LINE=$(grep -n 'aih_provision_pwsh_archive "' "$AIH_SETUP" | head -n 1 | cut -d: -f1)
if [ -n "$AIH_VERIFY_LINE" ] && [ -n "$AIH_TAR_LINE" ] && [ -n "$AIH_PROVISION_LINE" ] &&
   [ "$AIH_VERIFY_LINE" -lt "$AIH_TAR_LINE" ] && [ "$AIH_TAR_LINE" -lt "$AIH_PROVISION_LINE" ]; then
  echo 'PASS: I: SHA256 verify -> extract -> provision ordering in setup.sh'
  passes=$((passes + 1))
else
  echo "FAIL: I: provisioning order broken (verify=$AIH_VERIFY_LINE tar=$AIH_TAR_LINE provision=$AIH_PROVISION_LINE)"
  failures=$((failures + 1))
fi

# J: no recursive or world-writable chmod in the provisioning library.
if grep -qE 'chmod +(-[A-Za-z]+ +)*-R|chmod +0777|chmod +777' "$AIH_LIB/aih-provision-pwsh.sh"; then
  echo 'FAIL: J: recursive or world-writable chmod found in provisioning lib'
  failures=$((failures + 1))
else
  echo 'PASS: J: no recursive/world-writable chmod in provisioning lib'
  passes=$((passes + 1))
fi

printf 'RESULT: %d provision-pwsh assertions passed, %d failed.\n' "$passes" "$failures"
[ "$failures" -eq 0 ]

# Nexus pinned-PowerShell archive provisioning (shared POSIX library).
# Sourced by setup.sh; unit-tested by tests/aih-provision-pwsh.Tests.sh.
#
# Microsoft's official PowerShell Linux binary archives do not reliably
# carry the executable bit on the pwsh launcher — the upstream installation
# instructions require `chmod +x` after extraction. The installer therefore
# validates structure, repairs the permission on the exact expected binary
# inside the freshly-created installer temp directory, installs the payload,
# and gates on the binary actually running and reporting the pinned version.
#
# Contract: aih_provision_pwsh_archive <expanded-dir> <runtime-dir> <expected-version>
#   - <expanded-dir>/pwsh must EXIST (fail: does not contain pwsh) and be a
#     REGULAR FILE (fail: not a regular file)
#   - chmod 0755 on exactly that path (never recursive, never the tree,
#     never world-writable); failure and post-chmod non-executability both
#     fail closed with distinct messages
#   - payload is moved into <runtime-dir>
#   - <runtime-dir>/pwsh --version must run and report exactly
#     'PowerShell <expected-version>'
# The archive MUST already be SHA256 verified before this helper is called
# (setup.sh ordering is asserted by the suite).
aih_provision_pwsh_archive_impl() {
  _expanded=$1
  _runtime_dir=$2
  _expected_version=$3
  _pwsh_bin="$_expanded/pwsh"
  if [ ! -e "$_pwsh_bin" ]; then
    echo "Nexus installer: downloaded PowerShell archive does not contain pwsh. Refusing." >&2
    exit 1
  fi
  if [ ! -f "$_pwsh_bin" ]; then
    echo "Nexus installer: extracted pwsh is not a regular file. Refusing." >&2
    exit 1
  fi
  if ! chmod 0755 "$_pwsh_bin"; then
    echo "Nexus installer: could not set the executable bit on the extracted pwsh. Refusing." >&2
    exit 1
  fi
  if [ ! -x "$_pwsh_bin" ]; then
    echo "Nexus installer: extracted pwsh is still not executable after chmod. Refusing." >&2
    exit 1
  fi
  rm -rf "$_runtime_dir"
  mkdir -p "$(dirname "$_runtime_dir")"
  if ! mv "$_expanded" "$_runtime_dir"; then
    echo "Nexus installer: could not install the extracted PowerShell payload into $_runtime_dir. Refusing." >&2
    exit 1
  fi
  _reported=$("$_runtime_dir/pwsh" --version) || {
    echo "Nexus installer: the installed pwsh binary failed to start. Refusing." >&2
    exit 1
  }
  if [ "$_reported" != "PowerShell $_expected_version" ]; then
    echo "Nexus installer: installed pwsh reports '$_reported' but the pinned version is $_expected_version. Refusing." >&2
    exit 1
  fi
}

aih_provision_pwsh_archive() {
  aih_provision_pwsh_archive_impl "$1" "$2" "$3"
}

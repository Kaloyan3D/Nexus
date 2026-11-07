# Nexus platform helpers (shared POSIX library).
# Sourced by setup.sh; unit-tested by tests/aih-platform.Tests.sh. Pure functions, no I/O.
#   aih_detect_platform <uname -s> <uname -m>  -> linux-x64 | macos-arm64 (exit 1 otherwise)
#   aih_node_artifact_name <version> <target>  -> official Node archive name
#   aih_pwsh_artifact_name <version> <target>  -> official PowerShell archive name

aih_detect_platform() {
  # Pure helper (unit-testable): map uname values to a supported target id.
  aih_detect_platform_impl() {
    _uname_s=$1
    _uname_m=$2
    case "$_uname_s" in
      Linux) ;;
      Darwin)
        # macOS: only Apple Silicon is supported (pinned Node darwin-arm64, PowerShell osx-arm64).
        case "$_uname_m" in
          arm64|aarch64) echo "macos-arm64"; return 0 ;;
          *) echo "unsupported-arch:$_uname_m (Nexus on macOS supports Apple Silicon arm64)" >&2; return 1 ;;
        esac ;;
      *) echo "unsupported-os:$_uname_s" >&2; return 1 ;;
    esac
    case "$_uname_m" in
      x86_64|amd64) echo "linux-x64" ;;
      aarch64|arm64) echo "unsupported-arch:$_uname_m (Nexus currently supports Linux x86_64)" >&2; return 1 ;;
      *) echo "unsupported-arch:$_uname_m" >&2; return 1 ;;
    esac
  }
  aih_detect_platform_impl "$1" "$2"
}

aih_node_artifact_name() {
  # Pure helper (unit-testable): pinned Node artifact per platform target.
  aih_node_artifact_name_impl() {
    _version=$1
    _target=$2
    case "$_target" in
      win-x64|win-arm64) echo "node-v${_version}-${_target}.zip" ;;
      linux-x64|linux-arm64) echo "node-v${_version}-${_target}.tar.xz" ;;
      macos-arm64) echo "node-v${_version}-darwin-arm64.tar.xz" ;;
      *) echo "unsupported target: $_target" >&2; return 1 ;;
    esac
  }
  aih_node_artifact_name_impl "$1" "$2"
}

aih_pwsh_artifact_name() {
  # Pure helper (unit-testable): official PowerShell archive name per platform target.
  case "$2" in
    macos-arm64) echo "powershell-$1-osx-arm64.tar.gz" ;;
    *) echo "powershell-$1-$2.tar.gz" ;;
  esac
}


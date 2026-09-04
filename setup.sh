#!/bin/sh
# Nexus native Linux installer.
#
# Installs Nexus user-scoped into ~/.local/share/nexus (overridable with
# --install-root or the AIH_INSTALL_ROOT environment variable). Never uses
# sudo, never requires root, never edits shell configuration files, and is
# idempotent: re-running updates an existing install while preserving user
# settings, credentials, and controller state unless --reset-managed-settings
# is requested.
#
# Supported: Linux x86_64 (tested target: Arch/CachyOS).
# Required system tools: git, tar, xz, sha256sum, and curl or wget.
# Node.js and PowerShell are provisioned pinned per-platform by this
# installer with SHA256 verification (no system-wide install needed).

set -eu

AIH_SOURCE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Checksum verification is a shared POSIX library so it is unit-testable
# (tests/aih-verify-sha256.Tests.sh) and structurally parsed in one place.
. "$AIH_SOURCE_ROOT/scripts/lib/aih-verify-sha256.sh"
AIH_DEFAULT_ROOT="$HOME/.local/share/nexus"
AIH_INSTALL_ROOT="${AIH_INSTALL_ROOT:-$AIH_DEFAULT_ROOT}"
AIH_RESET_MANAGED_SETTINGS=0
AIH_SKIP_DEEPSEEK_LOGIN=0
AIH_SKIP_OPENAI_LOGIN=0
AIH_SKIP_DEPENDENCY_INSTALL=0
AIH_SKIP_PATH_CHECK=0

usage() {
  cat <<'EOF'
Usage: ./setup.sh [options]

Options:
  --install-root DIR        Install root (default: ~/.local/share/nexus,
                            overridable through AIH_INSTALL_ROOT)
  --reset-managed-settings  Replace the managed settings.yaml (credentials and
                            task state are never touched)
  --skip-deepseek-login     Skip the DeepSeek API key prompt
  --skip-openai-login       Skip the ChatGPT/Codex OAuth sign-in flow
  --skip-dependency-install Skip npm ci (requires an existing DSH runtime)
  --skip-path-check         Skip the ~/.local/bin PATH check
  -h, --help                Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --install-root) [ $# -ge 2 ] || { echo "--install-root requires a value" >&2; exit 1; }; AIH_INSTALL_ROOT=$2; shift 2 ;;
    --reset-managed-settings) AIH_RESET_MANAGED_SETTINGS=1; shift ;;
    --skip-deepseek-login) AIH_SKIP_DEEPSEEK_LOGIN=1; shift ;;
    --skip-openai-login) AIH_SKIP_OPENAI_LOGIN=1; shift ;;
    --skip-dependency-install) AIH_SKIP_DEPENDENCY_INSTALL=1; shift ;;
    --skip-path-check) AIH_SKIP_PATH_CHECK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

AIH_FAIL_UNLESS() {
  # Fail closed with a clear message when an expected upstream/runtime
  # structure is missing.
  if [ ! -e "$1" ]; then
    echo "Nexus installer: expected $1" >&2
    echo "$2" >&2
    exit 1
  fi
}

aih_detect_platform() {
  # Pure helper (unit-testable): map uname values to a supported target id.
  aih_detect_platform_impl() {
    _uname_s=$1
    _uname_m=$2
    case "$_uname_s" in
      Linux) ;;
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
      *) echo "unsupported target: $_target" >&2; return 1 ;;
    esac
  }
  aih_node_artifact_name_impl "$1" "$2"
}

aih_require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Nexus installer: required tool '$1' is not available on PATH." >&2
    echo "Install it with your distribution package manager (Arch/CachyOS: pacman -S $2) and re-run ./setup.sh" >&2
    exit 1
  fi
}

aih_fetch() {
  # Download a URL with whichever downloader exists.
  aih_fetch_impl() {
    _url=$1
    _dest=$2
    if command -v curl >/dev/null 2>&1; then
      curl -fL --retry 3 --silent --show-error "$_url" -o "$_dest"
    else
      wget -q --tries=3 "$_url" -O "$_dest"
    fi
  }
  aih_fetch_impl "$1" "$2"
}

aih_read_version() {
  # Read a top-level string field out of config/versions.json without jq.
  aih_read_version_impl() {
    _key=$1
    _file=$2
    grep "\"$_key\"" "$_file" | head -n 1 | sed 's/.*: *"\([^"]*\)".*/\1/'
  }
  aih_read_version_impl "$1" "$2"
}

# -- 1/6 platform and dependency validation ---------------------------------
AIH_PLATFORM=$(aih_detect_platform "$(uname -s)" "$(uname -m)")
echo "Nexus source: $AIH_SOURCE_ROOT"
echo "Nexus install root: $AIH_INSTALL_ROOT"
echo "Nexus platform: $AIH_PLATFORM"
aih_require_tool git git
aih_require_tool tar tar
aih_require_tool xz xz
aih_require_tool sha256sum coreutils
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  echo "Nexus installer: either curl or wget is required to download the pinned runtime." >&2
  echo "Install one (Arch/CachyOS: pacman -S curl) and re-run ./setup.sh" >&2
  exit 1
fi

AIH_NODE_VERSION=$(aih_read_version NodeVersion "$AIH_SOURCE_ROOT/config/versions.json")
AIH_PWSH_VERSION=$(aih_read_version PowerShellVersion "$AIH_SOURCE_ROOT/config/versions.json")
[ -n "$AIH_NODE_VERSION" ] || { echo "Nexus installer: could not read NodeVersion from config/versions.json" >&2; exit 1; }
[ -n "$AIH_PWSH_VERSION" ] || { echo "Nexus installer: could not read PowerShellVersion from config/versions.json" >&2; exit 1; }

# Fail closed when the source tree is not a complete Nexus checkout.
for _required in config/versions.json config/settings.yaml scripts/Common.ps1 scripts/aih.ps1 runtime/package.json runtime/package-lock.json; do
  AIH_FAIL_UNLESS "$AIH_SOURCE_ROOT/$_required" "The source tree is incomplete; clone the Nexus repository and run ./setup.sh from its root."
done

# -- 2/6 install layout ------------------------------------------------------
mkdir -p "$AIH_INSTALL_ROOT/app" "$AIH_INSTALL_ROOT/bin" "$AIH_INSTALL_ROOT/config" \
         "$AIH_INSTALL_ROOT/data" "$AIH_INSTALL_ROOT/logs" "$AIH_INSTALL_ROOT/runtime" \
         "$AIH_INSTALL_ROOT/scripts" "$AIH_INSTALL_ROOT/docs" "$AIH_INSTALL_ROOT/tests" "$AIH_INSTALL_ROOT/ui"

# Root files (same set the Windows installer publishes).
for _name in setup.sh setup.ps1 README.md SECURITY.md .gitignore .gitattributes .env.example; do
  if [ -f "$AIH_SOURCE_ROOT/$_name" ]; then cp -f "$AIH_SOURCE_ROOT/$_name" "$AIH_INSTALL_ROOT/$_name"; fi
done

AIH_CONFIG_FILES='versions.json settings.yaml home.cordis.patch.yml delegation-block.yml preset.yml preset-deepseek.yml DeepSeek-Isolation.cjs Engineering-Isolation.cjs AihController.cjs deepseek-agent.cordis.yml routing-policy.json engineering-profiles.json model-registry.json Engineering-Profiles.cjs'
for _name in $AIH_CONFIG_FILES; do
  if [ -f "$AIH_SOURCE_ROOT/config/$_name" ]; then cp -f "$AIH_SOURCE_ROOT/config/$_name" "$AIH_INSTALL_ROOT/config/$_name"; fi
done

# Scripts, tests, ui and skills are copied recursively so nested controller
# modules (scripts/Engineering, scripts/intelligence, tests fixtures) always
# reach the installed layout.
copy_tree() {
  _src=$1
  _dst=$2
  [ -d "$_src" ] || return 0
  (cd "$_src" && find . -type f) | while IFS= read -r _rel; do
    _rel=${_rel#./}
    mkdir -p "$_dst/$(dirname "$_rel")"
    cp -f "$_src/$_rel" "$_dst/$_rel"
  done
}
copy_tree "$AIH_SOURCE_ROOT/docs" "$AIH_INSTALL_ROOT/docs"
copy_tree "$AIH_SOURCE_ROOT/scripts" "$AIH_INSTALL_ROOT/scripts"
copy_tree "$AIH_SOURCE_ROOT/tests" "$AIH_INSTALL_ROOT/tests"
copy_tree "$AIH_SOURCE_ROOT/ui" "$AIH_INSTALL_ROOT/ui"
copy_tree "$AIH_SOURCE_ROOT/skills" "$AIH_INSTALL_ROOT/skills"
cp -f "$AIH_SOURCE_ROOT/runtime/package.json" "$AIH_INSTALL_ROOT/runtime/package.json"
cp -f "$AIH_SOURCE_ROOT/runtime/package-lock.json" "$AIH_INSTALL_ROOT/runtime/package-lock.json"

# Linux command launchers: extensionless executables.
# Canonical copies live in <install>/bin; user-facing copies with a baked
# install root go to ~/.local/bin.
mkdir -p "$AIH_INSTALL_ROOT/bin"
if [ -d "$AIH_SOURCE_ROOT/bin/linux" ]; then
  for _wrapper in "$AIH_SOURCE_ROOT"/bin/linux/*.sh; do
    [ -f "$_wrapper" ] || continue
    _base=$(basename "$_wrapper" .sh)
    install -m 0755 "$_wrapper" "$AIH_INSTALL_ROOT/bin/$_base"
  done
fi

# -- 3/6 pinned Node runtime --------------------------------------------------
AIH_NODE_DIR="$AIH_INSTALL_ROOT/runtime/node"
AIH_INSTALLED_NODE_VERSION=''
if [ -x "$AIH_NODE_DIR/bin/node" ]; then
  AIH_INSTALLED_NODE_VERSION=$("$AIH_NODE_DIR/bin/node" --version | sed 's/^v//')
fi
if [ "$AIH_INSTALLED_NODE_VERSION" != "$AIH_NODE_VERSION" ]; then
  AIH_ARTIFACT=$(aih_node_artifact_name "$AIH_NODE_VERSION" "$AIH_PLATFORM")
  AIH_RELEASE_BASE="https://nodejs.org/download/release/v$AIH_NODE_VERSION"
  AIH_TMP=$(mktemp -d "${TMPDIR:-/tmp}/aih-node-XXXXXXXX")
  echo "Downloading pinned Node.js $AIH_NODE_VERSION ($AIH_ARTIFACT) ..."
  aih_fetch "$AIH_RELEASE_BASE/$AIH_ARTIFACT" "$AIH_TMP/$AIH_ARTIFACT"
  aih_fetch "$AIH_RELEASE_BASE/SHASUMS256.txt" "$AIH_TMP/SHASUMS256.txt"
  aih_verify_sha256 "$AIH_TMP/$AIH_ARTIFACT" "$AIH_TMP/SHASUMS256.txt" "$AIH_ARTIFACT"
  tar -xJf "$AIH_TMP/$AIH_ARTIFACT" -C "$AIH_TMP"
  AIH_PAYLOAD=$(find "$AIH_TMP" -maxdepth 1 -mindepth 1 -type d ! -name "$(basename "$AIH_TMP")" | head -n 1)
  [ -n "$AIH_PAYLOAD" ] || { echo "Nexus installer: unexpected Node archive layout." >&2; exit 1; }
  [ -x "$AIH_PAYLOAD/bin/node" ] || { echo "Nexus installer: downloaded Node archive does not contain bin/node. Refusing." >&2; exit 1; }
  rm -rf "$AIH_NODE_DIR"
  mkdir -p "$AIH_INSTALL_ROOT/runtime"
  mv "$AIH_PAYLOAD" "$AIH_NODE_DIR"
  rm -rf "$AIH_TMP"
else
  echo "Pinned Node.js $AIH_NODE_VERSION already installed."
fi

# -- 4/6 pinned PowerShell runtime --------------------------------------------
AIH_PWSH_DIR="$AIH_INSTALL_ROOT/runtime/pwsh"
AIH_INSTALLED_PWSH_VERSION=''
if [ -x "$AIH_PWSH_DIR/pwsh" ]; then
  AIH_INSTALLED_PWSH_VERSION=$("$AIH_PWSH_DIR/pwsh" --version | sed 's/^PowerShell //')
fi
if [ "$AIH_INSTALLED_PWSH_VERSION" != "$AIH_PWSH_VERSION" ]; then
  AIH_PWSH_ARTIFACT="powershell-$AIH_PWSH_VERSION-$AIH_PLATFORM.tar.gz"
  AIH_PWSH_BASE="https://github.com/PowerShell/PowerShell/releases/download/v$AIH_PWSH_VERSION"
  AIH_PWSH_TMP=$(mktemp -d "${TMPDIR:-/tmp}/aih-pwsh-XXXXXXXX")
  echo "Downloading pinned PowerShell $AIH_PWSH_VERSION ($AIH_PWSH_ARTIFACT) ..."
  aih_fetch "$AIH_PWSH_BASE/$AIH_PWSH_ARTIFACT" "$AIH_PWSH_TMP/$AIH_PWSH_ARTIFACT"
  aih_fetch "$AIH_PWSH_BASE/hashes.sha256" "$AIH_PWSH_TMP/hashes.sha256"
  aih_verify_sha256 "$AIH_PWSH_TMP/$AIH_PWSH_ARTIFACT" "$AIH_PWSH_TMP/hashes.sha256" "$AIH_PWSH_ARTIFACT"
  mkdir -p "$AIH_PWSH_TMP/expanded"
  tar -xzf "$AIH_PWSH_TMP/$AIH_PWSH_ARTIFACT" -C "$AIH_PWSH_TMP/expanded"
  [ -x "$AIH_PWSH_TMP/expanded/pwsh" ] || { echo "Nexus installer: downloaded PowerShell archive does not contain pwsh. Refusing." >&2; exit 1; }
  rm -rf "$AIH_PWSH_DIR"
  mkdir -p "$AIH_INSTALL_ROOT/runtime"
  mv "$AIH_PWSH_TMP/expanded" "$AIH_PWSH_DIR"
  rm -rf "$AIH_PWSH_TMP"
else
  echo "Pinned PowerShell $AIH_PWSH_VERSION already installed."
fi

# -- 5/6 pinned runtime dependencies + shared composition ---------------------
cp -f "$AIH_INSTALL_ROOT/runtime/package.json" "$AIH_INSTALL_ROOT/app/package.json"
cp -f "$AIH_INSTALL_ROOT/runtime/package-lock.json" "$AIH_INSTALL_ROOT/app/package-lock.json"
AIH_NPM_CLI="$AIH_NODE_DIR/lib/node_modules/npm/bin/npm-cli.js"
if [ "$AIH_SKIP_DEPENDENCY_INSTALL" -eq 1 ]; then
  if [ ! -f "$AIH_INSTALL_ROOT/app/node_modules/@deepseek-ai/dsh/lib/bin.js" ]; then
    echo "Nexus installer: --skip-dependency-install requires an existing installed DSH runtime." >&2
    exit 1
  fi
else
  "$AIH_NODE_DIR/bin/node" "$AIH_NPM_CLI" ci --omit=dev --legacy-peer-deps --prefix "$AIH_INSTALL_ROOT/app"
fi

# Shared install composition (settings, UI patches, agent presets, data dirs,
# private-path permissions) - the SAME code the Windows installer runs.
if [ "$AIH_RESET_MANAGED_SETTINGS" -eq 1 ]; then
  "$AIH_PWSH_DIR/pwsh" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$AIH_INSTALL_ROOT/scripts/Complete-Install.ps1" -InstallRoot "$AIH_INSTALL_ROOT" -ResetManagedSettings
else
  "$AIH_PWSH_DIR/pwsh" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$AIH_INSTALL_ROOT/scripts/Complete-Install.ps1" -InstallRoot "$AIH_INSTALL_ROOT"
fi

"$AIH_PWSH_DIR/pwsh" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$AIH_INSTALL_ROOT/scripts/Install-NexusSkills.ps1" -InstallRoot "$AIH_INSTALL_ROOT"

# -- 6/6 user launchers and PATH ----------------------------------------------
AIH_USER_BIN="$HOME/.local/bin"
mkdir -p "$AIH_USER_BIN"
for _wrapper in "$AIH_INSTALL_ROOT"/bin/*; do
  [ -f "$_wrapper" ] || continue
  _base=$(basename "$_wrapper")
  sed "s|AIH_BAKED_ROOT=\"\"|AIH_BAKED_ROOT=\"$AIH_INSTALL_ROOT\"|" "$_wrapper" > "$AIH_USER_BIN/$_base.tmp"
  chmod 0755 "$AIH_USER_BIN/$_base.tmp"
  mv -f "$AIH_USER_BIN/$_base.tmp" "$AIH_USER_BIN/$_base"
done

PATH_OK=0
case ":$PATH:" in
  *":$AIH_USER_BIN:"*) PATH_OK=1 ;;
esac

if [ "$AIH_SKIP_PATH_CHECK" -eq 0 ] && [ "$PATH_OK" -eq 0 ]; then
  echo ''
  echo 'ACTION REQUIRED: add the Nexus command directory to your PATH.'
  echo 'Nexus never edits your shell configuration; run ONE of these yourself:'
  echo "  bash/zsh: echo 'export PATH="\$HOME/.local/bin:\$PATH"' >> ~/.profile"
  echo '  fish:     fish_add_path ~/.local/bin'
  echo 'Then open a new shell (or re-source your profile) so the commands resolve.'
fi

# Provider setup (same semantics as the Windows installer).
if [ "$AIH_SKIP_DEEPSEEK_LOGIN" -eq 0 ]; then
  echo 'Configuring DeepSeek (the key input is hidden) ...'
  "$AIH_PWSH_DIR/pwsh" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$AIH_INSTALL_ROOT/scripts/Set-DeepSeekKey.ps1" -InstallRoot "$AIH_INSTALL_ROOT"
else
  echo 'Skipping DeepSeek credential setup.'
fi
if [ "$AIH_SKIP_OPENAI_LOGIN" -eq 0 ]; then
  echo 'Starting the ChatGPT/Codex sign-in flow ...'
  "$AIH_PWSH_DIR/pwsh" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$AIH_INSTALL_ROOT/scripts/Set-OpenAiOAuth.ps1" -InstallRoot "$AIH_INSTALL_ROOT"
else
  echo 'Skipping ChatGPT/Codex sign-in.'
fi

echo 'Running local checks ...'
if [ -s "$AIH_INSTALL_ROOT/data/.credentials.yaml" ]; then
  if ! "$AIH_PWSH_DIR/pwsh" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$AIH_INSTALL_ROOT/scripts/Doctor.ps1" -InstallRoot "$AIH_INSTALL_ROOT" -Offline; then
    echo 'Setup completed, but local checks failed. Run: aih-doctor -Offline' >&2
    exit 1
  fi
else
  echo 'DeepSeek is not configured yet; running credential-free deterministic tests instead.'
  "$AIH_PWSH_DIR/pwsh" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$AIH_INSTALL_ROOT/scripts/Test-Harness.ps1" -InstallRoot "$AIH_INSTALL_ROOT"
fi

echo ''
echo "Setup complete. Nexus is installed at $AIH_INSTALL_ROOT."
echo 'Open a new terminal, enter any project directory, and run: aih'
echo 'DeepSeek-only mode: aih -Preset deepseek'
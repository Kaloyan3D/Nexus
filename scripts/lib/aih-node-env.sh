# Nexus pinned-Node runtime environment (shared POSIX library).
# Sourced by setup.sh; unit-tested by tests/aih-node-env.Tests.sh.
#
# npm itself is invoked by absolute path, but npm lifecycle scripts run
# through `sh -c node ...` and resolve node via PATH. On a machine without a
# system Node (the supported CachyOS target) those scripts died with
# 'node: command not found' (npm error 127).
#
# aih_use_pinned_node <node-dir> <expected-version>:
#   1. gates the pinned runtime: executable exists, starts, and reports
#      exactly v<expected-version> (fail closed otherwise);
#   2. prepends <node-dir>/bin to THIS process's PATH so every descendant
#      (npm and its lifecycle children) resolves node to the pinned
#      runtime; the caller's existing PATH is preserved AFTER the pinned
#      entry so build tools (sh, make, cc, python, git) stay reachable;
#   3. re-verifies inside the modified environment that `command -v node`
#      resolves to the pinned binary.
# The change is strictly process-scoped: nothing is written to .profile,
# .bashrc, config.fish, or any other persistent configuration; no eval; no
# shell strings built from paths.
aih_require_pinned_node() {
  _node_dir=$1
  _expected=$2
  _pinned_node="$_node_dir/bin/node"
  if [ ! -x "$_pinned_node" ]; then
    echo "Nexus installer: the pinned Node runtime is missing its executable ($_pinned_node). Refusing." >&2
    exit 1
  fi
  _reported=$("$_pinned_node" --version) || {
    echo "Nexus installer: the pinned Node runtime at $_pinned_node failed to start. Refusing." >&2
    exit 1
  }
  if [ "$_reported" != "v$_expected" ]; then
    echo "Nexus installer: pinned Node reports '$_reported' but the pinned version is v$_expected. Refusing." >&2
    exit 1
  fi
}

aih_use_pinned_node() {
  aih_require_pinned_node "$1" "$2"
  _node_dir=$1
  case ":$PATH:" in
    *":$_node_dir/bin:"*) ;;
    *) PATH="$_node_dir/bin:$PATH"; export PATH ;;
  esac
  _resolved=$(command -v node) || {
    echo "Nexus installer: node is not resolvable through PATH after the pinned runtime was prepended. Refusing." >&2
    exit 1
  }
  if [ "$_resolved" != "$_node_dir/bin/node" ]; then
    echo "Nexus installer: PATH resolves node to '$_resolved' instead of the pinned $_node_dir/bin/node. Refusing." >&2
    exit 1
  fi
}

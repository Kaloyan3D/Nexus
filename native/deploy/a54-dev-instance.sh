#!/bin/sh
# A5.4 isolated dev instance for the OpenCode Go live acceptance.
# Single-UID development pilot (shadow-test trust, model-only scope). It never
# touches production-v1 or the legacy DSH Registry: everything lives under
# $A54_HOME (default ~/.nexus-a54, mode 0700).
#
#   sh deploy/a54-dev-instance.sh prepare     create dirs, Registry records (offline)
#   sh deploy/a54-dev-instance.sh credentials write credentials.json from the existing OPENCODE_API_KEY (env, then repo .env; parsed, never printed)
#   sh deploy/a54-dev-instance.sh start       start nexusd + nexus-broker (no network egress by itself)
#   sh deploy/a54-dev-instance.sh synthetic-repo   create $A54_HOME/inspect-repo (synthetic sources, no secrets) for A5.5
#   (A5.5) export A55_WORKSPACE=ID=ABS_PATH before `start` to enable read-only repo-inspect on that ONE workspace
#   sh deploy/a54-dev-instance.sh check      read-only: is the running broker the installed build?
#   sh deploy/a54-dev-instance.sh stop
#   sh deploy/a54-dev-instance.sh env         print the exports for the CLI
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
BIN=${BIN_DIR:-$REPO/native/target/debug}
A=${A54_HOME:-$HOME/.nexus-a54}
case "$A" in *production*|*/.nexus|*/.nexus/) echo "refusing to use a production-looking home: $A" >&2; exit 2;; esac
cmd=${1:-}
umask 077
case "$cmd" in
prepare)
  mkdir -p "$A/registry" "$A/daemon" "$A/broker" "$A/transcripts"
  chmod 700 "$A" "$A/registry" "$A/daemon" "$A/broker" "$A/transcripts"
  node "$REPO/scripts/Setup-NativeOpenCodeGo.cjs" --data-root "$A/registry" --apply
  echo "next: sh deploy/a54-dev-instance.sh credentials   (see native/docs/A5.4-LIVE-ACCEPTANCE.md)"
  ;;
credentials)
  mkdir -p "$A" && chmod 700 "$A"
  node "$REPO/scripts/Prepare-NativeOpenCodeGoCredentials.cjs" --out "$A"
  ;;
synthetic-repo)
  R="$A/inspect-repo"
  [ -e "$R" ] && { echo "$R already exists; not touching it" >&2; exit 1; }
  mkdir -p "$R/src" "$R/docs"
  cat >"$R/README.md" <<'EOF'
# demo-gateway
Synthetic repository for the Nexus A5.5 read-only inspection smoke test.
Authorization of model execution lives in src/auth.rs and is used by src/dispatch.rs.
EOF
  cat >"$R/src/auth.rs" <<'EOF'
//! Authorization gate for model execution.
use crate::dispatch::Grant;

/// Decide whether a model request may execute.
pub fn authorize_model_execution(prompt: &str, scope: &str) -> Option<Grant> {
    if scope != "model-only" {
        return None;
    }
    if prompt.is_empty() {
        return None;
    }
    Some(Grant { scope: scope.to_owned() })
}
EOF
  cat >"$R/src/dispatch.rs" <<'EOF'
use crate::auth::authorize_model_execution;

#[derive(Debug)]
pub struct Grant {
    pub scope: String,
}

pub fn run_model(prompt: &str) -> Option<Grant> {
    authorize_model_execution(prompt, "model-only")
}

pub fn replay(prompt: &str) -> Option<Grant> {
    authorize_model_execution(prompt, "model-only")
}
EOF
  cat >"$R/src/main.rs" <<'EOF'
mod auth;
mod dispatch;

fn main() {
    println!("{:?}", dispatch::run_model("hello"));
}
EOF
  echo "created $R (no credentials, no private content)"
  ;;
check)
  # Read-only: is the running broker the installed build?
  rc=0; "$BIN/nexus-broker" identity --state-dir "$A/broker" || rc=$?
  case $rc in 0) ;; 3) echo "-> stop and start this instance before authorizing a live request" >&2;; 4) ;; esac
  exit $rc
  ;;
start)
  [ -d "$A/registry" ] || { echo "run prepare first" >&2; exit 2; }
  # Refuse to "start" over a live instance: a surviving old process silently
  # keeps serving (the A5.4 stale-broker incident) while the new one is refused.
  if "$BIN/nexus-broker" identity --state-dir "$A/broker" >/dev/null 2>&1 || [ $? -eq 3 ]; then
    echo "an instance is already running for $A:" >&2
    "$BIN/nexus-broker" identity --state-dir "$A/broker" >&2 || true
    echo "run 'stop' first (this script only ever stops processes whose command line names $A)" >&2
    exit 1
  fi
  UIDN=$(id -u)
  EXTRA_D=""; EXTRA_B=""
  if [ -n "${A55_WORKSPACE:-}" ]; then
    WID=${A55_WORKSPACE%%=*}; WPATH=${A55_WORKSPACE#*=}
    case "$WPATH" in /*) ;; *) echo "A55_WORKSPACE must be ID=ABSOLUTE_PATH" >&2; exit 2;; esac
    [ -d "$WPATH" ] || { echo "workspace path is not a directory" >&2; exit 2; }
    EXTRA_D="--workspace-bases $WPATH --enable-repo-inspect"
    EXTRA_B="--workspace $WID=$WPATH"
  fi
  # shellcheck disable=SC2086
  "$BIN/nexusd" $EXTRA_D --db "$A/daemon/k.db" --socket "$A/daemon/n.sock" --cap "$A/daemon/issuer.cap" \
    --trust-mode shadow-test --witness "$A/daemon/k.wit.db" --allowed-uids "$UIDN" --enable-model-pilot \
    >"$A/daemon.log" 2>&1 &
  echo $! >"$A/daemon.pid"
  i=0; while [ ! -S "$A/daemon/n.sock" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done
  [ -f "$A/credentials.json" ] || echo '{}' >"$A/credentials.json"
  chmod 600 "$A/credentials.json"
  "$BIN/nexus-broker" --state-dir "$A/broker" --socket "$A/broker.sock" --daemon-socket "$A/daemon/n.sock" \
    --cap "$A/daemon/issuer.cap" --credentials "$A/credentials.json" --repo-root "$REPO" \
    --registry-data-root "$A/registry" --transcript-dir "$A/transcripts" --allowed-uids "$UIDN" $EXTRA_B \
    >"$A/broker.log" 2>&1 &
  echo $! >"$A/broker.pid"
  sleep 1
  if ! "$BIN/nexus-broker" identity --state-dir "$A/broker"; then
    echo "broker did not come up as the installed build; see $A/broker.log" >&2
    exit 1
  fi
  echo "started (logs: $A/daemon.log, $A/broker.log)"
  ;;
stop)
  # Only processes of THIS instance: the pid must exist AND its command line
  # must name this instance's state paths. Unrelated processes are never signalled.
  stop_one() { # name, marker
    pf="$A/$1.pid"; [ -f "$pf" ] || return 0
    pid=$(cat "$pf" 2>/dev/null || true)
    if [ -n "$pid" ] && tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -qF -- "$2"; then
      kill "$pid" 2>/dev/null || true
    else
      echo "pid file for $1 does not match a process of this instance; not signalling" >&2
    fi
    rm -f "$pf"
  }
  stop_one broker "--state-dir $A/broker"
  stop_one daemon "--db $A/daemon/k.db"
  ;;
env)
  echo "export NEXUS_BROKER_SOCKET=$A/broker.sock"
  ;;
*) echo "usage: $0 prepare|credentials|start|synthetic-repo|check|stop|env" >&2; exit 2;;
esac

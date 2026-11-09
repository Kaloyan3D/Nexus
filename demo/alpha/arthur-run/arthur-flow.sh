#!/bin/sh
# Mimics Arthur Studio: idea.md -> Nexus (via the Nexus CLI) -> progress -> result.
# Usage: sh ~/Nexus-Demo/arthur-run/arthur-flow.sh [project-dir]
set -u
NODE=$HOME/Nexus-Demo/root/runtime/node/bin/node
CLI=$HOME/Nexus-Demo/root/scripts/nexus-cli.cjs
IDEA=$HOME/Nexus-Demo/arthur-run/idea.md
PROJECT=${1:-$HOME/Nexus-Demo/projects/pomodoro-$(date +%H%M%S)}
nx() { "$NODE" "$CLI" "$@"; }
field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1; }

echo "[arthur] 1/5 starting Nexus ..."
nx host start --mode engineering-v2 --json > /tmp/arthur-start.json || { cat /tmp/arthur-start.json; exit 1; }
echo "[arthur]     ready: $(field url < /tmp/arthur-start.json)"

echo "[arthur] 2/5 checking keys ..."
nx credentials list OPENCODE_API_KEY | grep -q "set" || { echo "[arthur] OPENCODE_API_KEY is missing: save it with 'credentials set OPENCODE_API_KEY --stdin'"; exit 1; }

echo "[arthur] 3/5 preparing project $PROJECT ..."
if [ ! -d "$PROJECT/.git" ]; then
  mkdir -p "$PROJECT" && git -C "$PROJECT" init -q -b main && echo "# Project" > "$PROJECT/README.md" && git -C "$PROJECT" add . && git -C "$PROJECT" -c user.name=arthur -c user.email=arthur@example.invalid commit -qm init
fi
nx workspace add --path "$PROJECT" --json > /dev/null || exit 1

echo "[arthur] 4/5 sending idea.md to Nexus ..."
KEY="arthur-$(basename "$PROJECT")"
nx submit --workspace "$PROJECT" --mode engineering-v2 --prompt-file "$IDEA" --idempotency-key "$KEY" --json > /tmp/arthur-submit.json || { cat /tmp/arthur-submit.json; exit 1; }
TASK=$(field taskId < /tmp/arthur-submit.json)
echo "[arthur]     task $TASK accepted"

START=$(date +%s)
while :; do
  nx status "$TASK" --json > /tmp/arthur-status.json
  STATUS=$(field status < /tmp/arthur-status.json)
  case "$STATUS" in
    running|accepted|queued) printf "\r[arthur]     working... %ss " $(( $(date +%s) - START )) ;;
    awaiting_operator) echo; echo "[arthur]     Nexus is waiting for an approval:"; nx status "$TASK"; exit 7 ;;
    *) echo; break ;;
  esac
  sleep 3
done

echo "[arthur] 5/5 result after $(( $(date +%s) - START ))s:"
nx status "$TASK"
echo
echo "[arthur] files in $PROJECT:"; ls -la "$PROJECT" | grep -v "^total"

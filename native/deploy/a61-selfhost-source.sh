#!/bin/sh
# A6.1: create the DEDICATED, CLEAN source for a Nexus self-hosting pilot.
#
# The active Nexus checkout is never used as a coding source: it has untracked
# development state (and would be refused as dirty), it contains the running
# daemon/broker build outputs, and its .git holds the full history. Instead this
# exports ONLY the tracked files of ONE SUBTREE of one commit (git archive: no
# untracked or ignored files, no local credentials, no history; by default just
# the `native/` Rust workspace without evidence/docs prose) into a brand-new
# single-commit repository under $A54_HOME/selfhost/. The snapshot root is that
# workspace, so a model can only list/read/search what the operator exported.
# That snapshot is what the daemon clones for each task. Nothing here modifies
# the active repository. The snapshot commit is reproducible (fixed identity,
# the origin commit's date).
#
#   sh deploy/a61-selfhost-source.sh create [COMMIT]   (default: HEAD of the active repo)
#   sh deploy/a61-selfhost-source.sh show
#
# Prints the exact environment for `a54-dev-instance.sh start` (source id,
# path, pinned snapshot commit). Read-only on everything except its own dir.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
A=${A54_HOME:-$HOME/.nexus-a54}
case "$A" in *production*|*/.nexus|*/.nexus/) echo "refusing to use a production-looking home: $A" >&2; exit 2;; esac
SUB=${A61_SUBTREE:-native}
D="$A/selfhost/nexus-self"
O="$A/selfhost/nexus-self.origin"
umask 077
case "${1:-}" in
create)
  [ -e "$D" ] && { echo "$D already exists; not touching it (remove it yourself to re-create)" >&2; exit 1; }
  SRC=$(git -C "$REPO" rev-parse --verify "${2:-HEAD}^{commit}")
  # Refuse to snapshot a tree that tracks anything credential-shaped.
  BAD=$(git -C "$REPO" ls-tree -r --name-only "$SRC" -- "$SUB" | grep -E '(^|/)(\.env[^/]*|id_rsa[^/]*|id_ed25519[^/]*|[^/]*\.pem|[^/]*\.p12|[^/]*\.cap|[^/]*\.key|live-(session-)?authorization[^/]*|provider-credentials[^/]*|credentials\.json)$' | grep -vE '(^|/)\.env\.(example|sample|template)$' || true)
  [ -z "$BAD" ] || { echo "refusing: the commit tracks credential-shaped files:" >&2; echo "$BAD" >&2; exit 1; }
  mkdir -p "$D"
  STRIP=$(printf '%s' "$SUB" | awk -F/ '{print NF}')
  git -C "$REPO" archive --format=tar "$SRC" -- "$SUB" ":(exclude)$SUB/*-EVIDENCE.md" ":(exclude)$SUB/docs" | tar -x --strip-components="$STRIP" -C "$D"
  GIT="git -C $D -c user.name=nexus-selfhost -c user.email=selfhost@invalid -c core.hooksPath=/dev/null"
  $GIT init -q -b main
  $GIT add -A
  DATE=$(git -C "$REPO" show -s --format=%cI "$SRC")
  GIT_AUTHOR_DATE="$DATE" GIT_COMMITTER_DATE="$DATE" $GIT commit -q -m "nexus-self snapshot of $SRC:$SUB (tracked files only, no history)"
  SNAP=$($GIT rev-parse HEAD)
  # Files that are tracked upstream but matched by .gitignore are dev state (e.g. test harness output):
  # they were not committed above, so drop them from the working tree as well.
  $GIT clean -fdXq
  printf 'origin_commit=%s\nsubtree=%s\nsnapshot_commit=%s\n' "$SRC" "$SUB" "$SNAP" >"$O"
  [ -z "$($GIT status --porcelain --ignored)" ] || { echo "snapshot is not clean" >&2; exit 1; }
  echo "created $D"
  echo "  origin commit   : $SRC"
  echo "  snapshot commit : $SNAP  (the daemon pins and records THIS)"
  echo "  files           : $($GIT ls-files | wc -l)"
  echo
  echo "fish:"
  echo "  set -x A56_CODE_SOURCE nexus-self=$D"
  echo "  set -x A56_CODE_COMMIT $SNAP"
  echo "  set -x A61_CODE_WRITE_ALLOW <dir/,file,...>   # the reviewed file scope of the proposal"
  ;;
show)
  [ -d "$D/.git" ] || { echo "no self-hosting source at $D" >&2; exit 1; }
  cat "$O" 2>/dev/null || true
  echo "HEAD now      : $(git -C "$D" rev-parse HEAD)"
  echo "tree is clean : $([ -z "$(git -C "$D" status --porcelain --ignored)" ] && echo yes || echo NO)"
  ;;
*) echo "usage: $0 create [COMMIT] | show" >&2; exit 2;;
esac

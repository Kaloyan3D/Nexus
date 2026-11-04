#!/bin/sh
# Run the hidden inventory acceptance against an exported working copy: run.sh <workspace-dir>
here=$(cd "$(dirname "$0")" && pwd)
INVENTORY_SRC="$1/src/inventory.js" node --test "$here/hidden.test.js" 2>&1 | grep -E '^(ℹ|#) (pass|fail)'

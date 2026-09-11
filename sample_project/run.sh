#!/bin/sh
# Builds the operator from this repository and runs it on this directory with
# the other tools on PATH from their sources. Arguments go to the operator:
#   ./run.sh              the screen
#   ./run.sh --once       the screen once, to stdout
#   ./run.sh --json       everything it read, as JSON
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
(cd "$root/tools/operator" && go build -o "$here/bin/heai-operator" ./cmd/heai-operator)
[ -d "$here/flow" ] || { echo "run ./setup.sh first: there is no state yet" >&2; exit 2; }
cd "$here"
PATH="$here/bin:$PATH" exec heai-operator --dir "$here" "$@"

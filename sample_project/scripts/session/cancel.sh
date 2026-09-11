#!/bin/sh
# Cancel one session through flow: scripts/session/cancel.sh <id>.
[ -n "$1" ] || { echo "usage: cancel.sh <session-id>" >&2; exit 2; }
exec heai-flow advance "$1" canceled --by cancel.sh

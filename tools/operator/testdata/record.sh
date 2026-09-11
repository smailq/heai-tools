#!/bin/sh
# Re-records the pod and reactor fixtures from the tools' own sources, so the
# format contracts this tool reads are the tools' output and not a drawing.
#   pod:      `heai-pod status --json` and `heai-pod list --json` against pod's fake runtime,
#             with a world of one clone and three worktrees in three agent states
#   reactor:  `heai-reactor status --json` and `heai-reactor events --since 1h --json` against
#             a temporary project: five sources, four rules, one emit, one dropped fact, two ticks
# Only the temporary project's path is rewritten, to /repo. Times are the recording's.
# Afterwards: go test ./internal/ui -update, and read the goldens.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
tools=$(cd "$here/../.." && pwd)

echo "pod: recording through $tools/pod against its fake runtime"
(cd "$tools/pod" && node "$here/record/pod.ts" "$here/pod")

echo "reactor: recording through $tools/reactor against a temporary project"
proj=$(mktemp -d "${TMPDIR%/}/operator-record-XXXXXX")
mkdir -p "$proj/drops" "$proj/scripts"
cp "$here/record/reactor.yaml" "$proj/reactor.yaml"
printf '#!/bin/sh\necho swept\n' > "$proj/scripts/sweep.sh"
printf '#!/bin/sh\necho picked "$REACTOR_SLUG"\n' > "$proj/scripts/pick.sh"
chmod +x "$proj/scripts/"*.sh
r() { node "$tools/reactor/src/cli.ts" --dir "$proj" "$@"; }
r emit tasks_cli task.todo --key fetch-company-favicon@todo --payload '{"slug":"fetch-company-favicon"}' >/dev/null
printf '{"workspace":"w2","pane":"w2:p2","agent":"w2","state":"exited","exitCode":0,"flow":"20260906-024801-session-77f0"}' > "$proj/drops/exited.w2.tmp"
mv "$proj/drops/exited.w2.tmp" "$proj/drops/exited.w2"
r tick >/dev/null 2>&1 || true           # the clock, the fact, the emit; pick-now debounces, session-exited fails on purpose
sleep 6
r tick >/dev/null 2>&1 || true           # pick-now's debounce window has closed; it runs
mkdir -p "$here/reactor"
r status --json | sed "s#$proj#/repo#g" > "$here/reactor/status.json"
r events --since 1h --json | sed "s#$proj#/repo#g" > "$here/reactor/events.json"
rm -rf "$proj"
echo "recorded into $here/pod and $here/reactor"

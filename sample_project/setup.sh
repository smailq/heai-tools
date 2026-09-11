#!/bin/sh
# Builds the sample's state with the tools themselves, so the operator has
# something to show: session, request and landing flows in several states,
# two of them idle long enough to be stuck, and an hour of reactor events with
# one rule that failed. Re-runnable: it removes flow/ and reactor/ first.
# tasks/ is committed and only has its index rebuilt.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"
export PATH="$here/bin:$PATH"

echo "map:     heai-architect check"
heai-architect check

echo "tasks:   heai-tasks build"
heai-tasks build

echo "flows:   starting sessions, requests and a landing"
rm -rf flow
# A: running - the agent is at work.
a=$(heai-flow start session --link actor=desktop-owner --link task=add-place-entity --link repo=app --link branch=agent/desktop-owner/add-place-entity --by pick.sh)
heai-flow link "$a" workspace=w3 >/dev/null
heai-flow advance "$a" started --by start.sh >/dev/null
# B: blocked on a request that is still todo - stuck for two hours.
r1=$(heai-flow start request --link task=help-requested-by-web-ui --link from=ui-owner --link to=core-reviewer --by finish.sh)
b=$(heai-flow start session --link actor=ui-owner --link task=document-tabs --link repo=app --link branch=agent/ui-owner/document-tabs --by pick.sh)
heai-flow advance "$b" started --by start.sh >/dev/null
heai-flow advance "$b" exited --data '{"exitCode":0}' --by inbox.sh >/dev/null
heai-flow advance "$b" gated --data '{"requested":true}' --by finish.sh --note "filed help-requested-by-web-ui" >/dev/null
heai-flow link "$b" --waits-on "$r1" >/dev/null
# C: blocked on a request that was canceled - it will never unblock; stuck for three days, red.
r2=$(heai-flow start request --link task=ontology-entity-identity --link from=core-reviewer --link to=ontology-owner --by finish.sh)
heai-flow advance "$r2" canceled --by human --note "superseded" >/dev/null
c=$(heai-flow start session --link actor=core-reviewer --link task=merge-two-entities --link repo=app --link branch=agent/core-reviewer/merge-two-entities --by pick.sh)
heai-flow advance "$c" started --by start.sh >/dev/null
heai-flow advance "$c" exited --data '{"exitCode":0}' --by inbox.sh >/dev/null
heai-flow advance "$c" gated --data '{"requested":true}' --by finish.sh --note "filed ontology-entity-identity" >/dev/null
heai-flow link "$c" --waits-on "$r2" >/dev/null
# D: clean - a session that finished and gated clean; its landing is proposed.
d=$(heai-flow start session --link actor=mail-owner --link task=inline-images-from-eml --link repo=app --link branch=agent/mail-owner/inline-images-from-eml --by pick.sh)
heai-flow advance "$d" started --by start.sh >/dev/null
heai-flow advance "$d" exited --data '{"exitCode":0}' --by inbox.sh >/dev/null
heai-flow advance "$d" gated --data '{"verdict":"clean"}' --by finish.sh >/dev/null
heai-flow start landing --link branch=agent/mail-owner/inline-images-from-eml --link actor=mail-owner --link territory=mail --link session="$d" --link task=inline-images-from-eml --by finish.sh >/dev/null

# Backdate B and C so `heai-flow stuck` has something to report: the journal is
# the truth, so its times move and `reindex` regenerates the rest. This is the
# one hand-edit here, and only because the clock cannot be told to lie.
backdate() { # <flow id> <hours>
  python3 - "$here/flow/flows/$1/journal.jsonl" "$2" <<'PY'
import json, sys, datetime
path, hours = sys.argv[1], float(sys.argv[2])
lines = [json.loads(l) for l in open(path) if l.strip()]
for l in lines:
    at = datetime.datetime.fromisoformat(l["at"].replace("Z", "+00:00")) - datetime.timedelta(hours=hours)
    l["at"] = at.strftime("%Y-%m-%dT%H:%M:%S.") + f"{at.microsecond // 1000:03d}Z"
open(path, "w").write("".join(json.dumps(l, separators=(",", ":")) + "\n" for l in lines))
PY
}
backdate "$b" 2
backdate "$r1" 2
backdate "$c" 72
backdate "$r2" 72
heai-flow reindex >/dev/null
sleep 1   # the hooks flow started are detached; let their echoes land before the summary

echo "reactor: one emit, two facts, two ticks"
rm -rf reactor drops; mkdir -p drops
heai-reactor emit tasks_cli task.todo --key do-the-thing@todo --payload '{"slug":"do-the-thing"}' >/dev/null
printf '{"workspace":"w3","pane":"w3:p2","agent":"w3","state":"exited","exitCode":0,"flow":"%s"}' "$d" > drops/exited.w3.tmp && mv drops/exited.w3.tmp drops/exited.w3
printf '{"workspace":"w9","pane":"w9:p2","agent":"w9","state":"failed","exitCode":1}' > drops/failed.w9.tmp && mv drops/failed.w9.tmp drops/failed.w9
heai-reactor tick >/dev/null 2>&1 || true      # the clock, the emit, both facts; pick-now debounces, session-failed fails on purpose
sleep 6
heai-reactor tick >/dev/null 2>&1 || true      # the debounce window closed; pick-now runs

echo
heai-flow stuck
echo
heai-reactor status | sed -n '/^rules/,$p'
echo
echo "ready: ./run.sh"

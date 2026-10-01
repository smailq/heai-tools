# How the tools work together

The tools share one project directory and know nothing about each other's process.
The process is yours: flow definitions say which states a piece of work passes through, scripts say what each move does by calling the tools, and reactor rules say what starts a move.
Below is the smallest coding system that uses all of them: a human files a task, an agent does the work in a container, the architecture is enforced on the result, and a human lands it.

```
project/
  architecture.yaml        who owns what                         architect
  tasks/items/<slug>.md    the work                              tasks
  flows/session.yaml       the process                           flow
  scripts/*.sh             the mechanics, calling the tools
  reactor.yaml             what starts each move                 reactor
  pod.yaml                 the container the agent works in      pod
  images/workshop/         the image: FROM the base, with claude installed
```

**1. Divide the code and name the experts.** The map gives the API to an agent and keeps CI and the map itself with a human.

```yaml
# architecture.yaml
version: 1
actors:
  alice:     { type: human, identity: '@alice' }
  api-owner: { type: llm-agent, context: "You own the HTTP API. Keep handlers thin." }
repositories:
  app: { remotePath: github.com/example/app, localPath: ../app }
territories:
  platform: { owner: alice,     scope: [{ repository: app, globs: ['architecture.yaml', '.github/**'] }] }
  api:      { owner: api-owner, scope: [{ repository: app, globs: ['src/api/**'] }] }
```

**2. File the work.** A task is a markdown file; its territory must be one the map declares.

```sh
heai-tasks new cache-the-index --title "Cache the index" --territory api --body "It is rebuilt per request."
heai-reactor emit tasks_cli task.todo --key cache-the-index --payload '{"slug":"cache-the-index"}'
```

**3. Define the process.** One flow per piece of work: queued, running, gated, then landed or refused by a person.

```yaml
# flows/session.yaml
name: session
states: [queued, running, exited, review, landed, refused]
initial: queued
terminal: [landed, refused]
links: { task: { required: true }, actor: { required: true }, job: { required: false } }
transitions:
  - { from: queued,  to: running, on: started }
  - { from: running, to: exited,  on: exited }
  - { from: exited,  to: review,  on: gated, when: { verdict: clean } }
  - { from: exited,  to: refused, on: gated }
  - { from: review,  to: landed,  on: landed,  by: [human] }
  - { from: review,  to: refused, on: refused, by: [human] }
hooks:
  queued: { run: scripts/start.sh }
  exited: { run: scripts/gate.sh }
```

**4. Wire the triggers.** A new task starts a session, and a clock settles what is waiting.

```yaml
# reactor.yaml
sources:
  clock:     { type: schedule, cron: "* * * * *" }
  tasks_cli: { type: cli, kinds: [task.todo] }
rules:
  - { name: dispatch, on: { source: tasks_cli, kind: task.todo }, run: scripts/dispatch.sh {{ slug }} }
  - { name: settle,   on: { source: clock },                       run: heai-flow settle }
```

**5. Write the moves.** Each script is a few lines that call the tools; `flow` runs a hook with the flow's id and links in its environment.

```sh
# scripts/dispatch.sh <slug>: route the task to its owner and open a session
actor=$(heai-architect owner "src/api" --json | jq -r .owner)
heai-tasks set "$1" --status in-progress
heai-flow start session --link task="$1" --link actor="$actor" --by dispatch.sh

# scripts/start.sh: a job holding a clone and the prompt, submitted; the hook is detached, so it waits for the result itself
name="$HEAI_LINK_ACTOR-$HEAI_LINK_TASK"
job=$(mktemp -d) && mkdir -p "$job/workdir/repos"
git clone -q ../app "$job/workdir/repos/app" && git -C "$job/workdir/repos/app" checkout -q -b "agent/$name"
{ heai-architect context "$HEAI_LINK_ACTOR"; heai-tasks show "$HEAI_LINK_TASK"; } > "$job/workdir/prompt.md"
echo '{"run": "cd repos/app && claude -p < ../../prompt.md"}' > "$job/job.json"
heai-pod submit "$job" --name "$name" --move --timeout 2h
heai-flow link "$HEAI_FLOW" job="$name"
heai-flow advance "$HEAI_FLOW" started --by start.sh
status=$(heai-pod wait "$name")
heai-flow advance "$HEAI_FLOW" exited --data "{\"status\":\"$status\"}" --by start.sh

# scripts/gate.sh: fetch the branch home from the finished job's clone, then judge it against the map
branch="agent/$HEAI_LINK_JOB"
git -C ../app fetch -q "pod/work_queue/.done/$HEAI_LINK_JOB/workdir/repos/app" "$branch:$branch"
if git -C ../app diff --name-only "main...$branch" | heai-architect gate --actor "$HEAI_LINK_ACTOR"
then heai-flow advance "$HEAI_FLOW" gated --data '{"verdict":"clean"}' --by gate.sh
else heai-flow advance "$HEAI_FLOW" gated --data '{"verdict":"violation"}' --by gate.sh
fi```

**6. Run it and watch.**

```sh
heai-pod up --image app/workshop      # the container, the worker inside
heai-reactor serve                    # the one daemon
heai-operator                         # the screen
```

From here the task moves on its own until `review`, where `heai-operator` shows it waiting on a person.
Alice reads the branch, then makes the one move only she may:

```sh
heai-flow advance <id> landed
heai-tasks set cache-the-index --status done
```

Every step above is a file in the project directory: the map, the task, the definition, the journal, the event, the job.
Change the process by editing the definition and the scripts; no tool needs to know.

# sample_project

A small project directory for running `operator` by hand: a map, a tracker with ten tasks, three flow definitions with flows in several states, a reactor with five sources and an hour of events, and a pod configuration whose container is never built.
Everything in it is made by the tools; nothing is hand-written state except two backdated journals, which `setup.sh` explains.

```sh
./setup.sh          # once: the flow and reactor state, built by heai-flow and heai-reactor
./run.sh            # builds the operator and runs it here; q quits
./run.sh --once     # the screen once, to stdout; exit 1 because something is red
./run.sh --json     # everything it read
```

Requires Go 1.26 and Node 22.18 or newer; `npm install` must have run in each of `tools/architect`, `tools/tasks`, `tools/flow`, `tools/reactor` and `tools/pod`.
`bin/` holds shims that run those tools from their sources, so nothing needs `npm link`; `run.sh` and `setup.sh` put them on `PATH`.
To use the tools here yourself: `PATH=$PWD/bin:$PATH heai-flow list`.

## What the screen should show

| pane | what is there | why |
| --- | --- | --- |
| tasks | 10 tasks: 1 in progress, 1 in review, 3 blocked, 2 todo, 1 backlog, 1 done, 1 canceled; every territory routes to an actor from the map | `multiple-workspaces` is blocked by a canceled task, so its row is red |
| flows | 3 stuck: two sessions blocked on requests, one request still todo; 6 open | the session waiting on the canceled request is red, since it can never unblock; `d` then `session` lists the four sessions (running, blocked, blocked, clean) with their task, actor, repo and branch; `⏎` traces one |
| pod | `○ no container` in amber | `pod.yaml` names `heai-sample`, which was never built or started; the pane shows the down path |
| reactor | 5 sources with `github` and `health` in amber; 5 rules; 4 events, one of them red | the webhook's secret is unset, the poll's port answers nothing, and `session-failed` exits 3 on purpose |

The operator only reads; make changes at the shell with the tools on PATH and watch the screen follow within its poll:

```sh
export PATH=$PWD/bin:$PATH
heai-tasks set do-the-thing --status in-progress --dir tasks          # the tasks pane moves it up
heai-flow start session --link actor=api-owner --link task=do-the-thing --link repo=app --by human   # a new session; the queued hook echoes into its actions/
scripts/session/cancel.sh <that id>                                    # canceled, through heai-flow advance
heai-reactor tick                                                      # the minute rule runs heai-flow settle; a new event in the reactor pane
```

`./setup.sh` again puts everything back.

## Layout

```
architecture.yaml         the map: one human, seven llm-agents, one repository, eight territories
tasks/                    the tracker; items/ are the ten tasks, INDEX.md is built by heai-tasks
flows/                    session, request and landing definitions (landing is templates/software/flows/landing.yaml)
scripts/                  what the hooks and rules run; session/cancel.sh cancels one session through flow
reactor.yaml              five sources, five rules
pod.yaml                  the container name and one image, never built; images/dev/Containerfile is pod's example
bin/                      shims to the tools' sources, and the operator binary run.sh builds
flow/ reactor/ drops/     state, made by setup.sh; the first two ignore themselves
```

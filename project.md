# The project directory

*The system as a whole, 2026-09-10. This is the introductory document: what a project directory is, what each tool does in it, and how humans, agents and automation act through them. Each tool's README carries that tool's own contract; the team documents beside it - [development](development-team.md), [marketing](marketing-team.md), [platform](platform-team.md), [compliance](compliance-team.md), [research](research-team.md), [legal](legal-team.md), [support](support-team.md), [finance](finance-team.md) - show teams built on it, each with its map, flows, scripts and a worked day.*

One directory holds everything a governed system needs to run itself: the map, the tasks, the flow definitions, the scripts that make each move, the reactor's sources and rules, and each tool's configuration and state.
Six tools read it - `architect`, `tasks`, `flow`, `reactor`, `pod`, `operator` - and none of them knows what the process is.
The process is the user's: flow definitions that say which states exist and which script runs on entering each, and the scripts, which call the tools.
The same tools and a different directory run a software team, a content pipeline or a nightly test fleet, with a human wherever a definition says a move is `by: [human]`.

## Why the tools know no process

Every earlier attempt put a policy inside a tool: who gets which task, when a branch lands, what a release is.
Each was right for one project and wrong for the next, because a marketing pipeline has no code review and a test fleet has no landing.
What those tools held was three things: records, which `flow` keeps; mechanics, which are a page of git or `gh` or a prompt; and policy, which is a few lines of "when this, do that".
Only the mechanics are code, and they differ per project, so they live in the project as scripts.
The tools each do one job: the map and its questions, the tasks, the referee, the clock and the events, the hands, the screen.

## The shape of it

```
   <project>/                             one directory, a git repository, the cwd of every tool and of the daemon
     architecture.yaml                    who owns what: actors, repositories, territories                (the map)
     tasks/items/<slug>.md                what a human committed to                                       (the work)
     flows/<name>.yaml                    states, moves, and the script each state runs on entry         (the process)
     scripts/<process>/<move>.sh          what a move actually does, calling the tools                    (the mechanics)
     reactor.yaml                         schedules, webhooks, polls, and what each event does            (the triggers)

   heai-reactor serve      ─── the one daemon: one event, one rule, one script ──────────────────────────────
     a tick, a webhook, a poll, an emit ──► an event ──► the rule that matches ──► one script
     the minute rule                                                            ──► heai-flow settle: facts folded, clocks and guards fired
   flow               ─── the chain: one state entered, one script ─────────────────────────────────────
     a script or a fact moves a flow    ──► the state entered ──► the script the definition names, detached
                                                          │
   the scripts call:  architect (owner, context, gate)   tasks (new, set, list)   flow (start, advance, link)   pod (open, prompt, run, wait)
                                                          │
   pod: a workspace per piece of work, an agent or a command in it, a fact file into the flow's inbox when it settles
   operator: the screen a human watches it all on
```

## The directory

```
<project>/
  architecture.yaml              the map: actors, repositories, territories, ownership         committed
  tasks/                         items/<slug>.md, tasks.yaml, INDEX.md, README.md                committed
  flows/<name>.yaml              one definition per process, with hooks                         committed
  scripts/<process>/<move>.sh    the mechanics, the user's                                      committed
  images/<name>/Containerfile    the pod images, FROM the base, with the project's tools         committed
  flow.yaml                      optional: where the definitions are                           committed
  reactor.yaml                   sources and rules                                              committed
  pod.yaml                       runtime, container name, images, mounts, resources             committed
  <anything>.yaml                a project's own configuration its scripts read                 committed
  flow/                          journals, snapshots, indexes, each flow's inbox and actions    state, ignores itself
  reactor/                       events, actions, cursors, keys                                 state, ignores itself
  pod/                           repos, worktrees, inbox                                        state, ignores itself
```

Every tool finds the directory the same way: `--dir`, else `HEAI_DIR`, else the current directory.
A tool's configuration is `<dir>/<tool>.yaml`, validated against the JSON Schema the tool ships under its own `schemas/`, and refused with every problem at once when it does not validate; an absent file is the defaults.
A tool's state is `<dir>/<tool>/`, which ignores itself with a `.gitignore` of `*`.
The one exception is `tasks`, whose configuration sits inside its own directory as `tasks/tasks.yaml`, because the tracker is self-contained and is committed whole.

The directory is a git repository so that the process is reviewed the way the map is: a changed hook, a changed script, a moved task is a diff.
The state directories are never the source of truth for anything a committed file records.
A map may govern several repositories; `repositories.<name>.localPath` in the map says where each checkout is, and `heai-pod repo add <name>` clones from it.

## The tools

Each tool is one command, one configuration file and one state directory, and answers in text or `--json`.
Exit codes are the same everywhere: `0` done or answered yes, `1` answered no or refused, `2` could not be asked.

### architect - the map and its questions

`architecture.yaml` names the **actors**, human or llm-agent; the **repositories**, each a path-addressable tree; and the **territories**, each a set of globs in a repository with one owning actor, optionally a parent, dependencies on other territories, and an inline `context` block that steers the owner.
[`tools/architect/schemas/architecture.schema.json`](../tools/architect/schemas/architecture.schema.json) is its shape and [`tools/architect/README.md`](../tools/architect/README.md) the rules the schema cannot say.

```sh
heai-architect template > architecture.yaml          # a starting map to edit
heai-architect check [--strict]                      # the validator; 1 on a problem
heai-architect owner src/api/routes.ts --json        # the territory and the actor for one path
heai-architect territories --actor api-owner --json  # what one actor owns, with each owner's type
heai-architect actors --json
heai-architect context api-owner                     # the actor's and its territories' context, for a prompt
git diff --name-only main...branch | heai-architect gate --actor api-owner --format json   # 1 on a boundary crossed
```

Scripts call `owner` to route, `context` to compose a prompt and `gate` to judge a diff.
`map-editor` is the one page in the repository: it draws the map, edits one field at a time with live validation through `architect`, and exports the YAML that lands in the project by a commit.

### tasks - what a human committed to

One markdown file per task under `tasks/items/`, with a fixed frontmatter - `title`, `status`, `priority`, `territory`, `created_at`, `modified_at` - and a body.
`tasks/tasks.yaml` points at the map, so every `territory` a task names must be one the map declares, and that is what routes the task to an owner.
`INDEX.md` is generated, in pick-up order, and is what an agent reads first.

```sh
heai-tasks init --dir heai-tasks --map ../architecture.yaml
heai-tasks new cache-the-index --title "Cache the index" --territory api --body -    # body from stdin
heai-tasks set cache-the-index --status in-progress
heai-tasks set cache-the-index --status blocked --note "Blocked by [t7](t7.md)."      # notes append; bodies are never rewritten
heai-tasks list --status todo --json
heai-tasks show cache-the-index --json | jq -r '.run // empty'                      # the task's run block, if it has one
heai-tasks build --check                                                             # 1 when INDEX.md is stale
```

Statuses are `backlog`, `todo`, `in-progress`, `in-review`, `blocked`, `done`, `canceled`.
A task is never hand-edited: `new` and `set` validate before writing and regenerate the view after.
A task whose body carries a fenced block tagged `run` is executed instead of prompted; the format does not change for it.

### flow - the process, and where everything is

A **definition** under `flows/` is a state machine: `states`, `initial`, `terminal`, the `links` a flow carries, the `transitions` with their event, `when` guard on the event's data, `after` clock, `requires` on linked flows, and `by`, the callers allowed to make the move.
A `hooks` block names, for any state, the one script `flow` runs when a flow enters it.
A **flow** is one record living that definition: an append-only journal, a snapshot, an inbox for facts, and an `actions/` directory holding each script's exit and log.

```sh
heai-flow start review --link doc=spec-7 --by file.sh          # prints the id
heai-flow advance <id> approved --by human
heai-flow advance <id> checked --data '{"failed":0}' --by check.sh
heai-flow link <id> branch=agent/x/t1 --waits-on <other-flow>
heai-flow touch <id>                                   # the heartbeat an `after` counts from
heai-flow list review --in open --json
heai-flow show <id> --json                             # state, links, journal, actions
heai-flow trace doc=spec-7                             # one timeline across every linked flow
heai-flow stuck --older 1h                             # what nothing has moved or touched
heai-flow settle                                       # fold inboxes, expire states, fire guards, rebuild views
heai-flow check [--fix]; heai-flow reindex [--repin]; heai-flow definitions
```

A human at the CLI is `--by human`, the default; scripts pass their own name; `flow` and `inbox` are the clock and the facts and are refused from any caller.
`flow.yaml` is optional and says where the definitions directory is.

### reactor - the one daemon, and a router

`reactor.yaml` declares **sources** - `schedule` on a cron, `git` watching branches of a repository, `webhook` with a provider or a generic shape, `poll` over a URL, `cli` fed only by `heai-reactor emit`, `dir` watching a drop directory, or a module path - and **rules**, each matching a source and optionally a kind and payload fields, and naming one command to `run` with the event in its environment.

```sh
heai-reactor serve --port 4949         # the daemon: schedules, polls, the webhook receiver; under launchd or systemd
heai-reactor tick                      # the same, one pass, from cron on a machine with no daemon
heai-reactor emit tasks_cli task.todo --key t1 --payload '{"slug":"t1"}' --act
heai-reactor status; heai-reactor events --since 24h; heai-reactor retry <event-id>
heai-reactor test pr-merged --event fixtures/merged.json
```

Every event and every action is a file under `reactor/`; the daemon can die at any line.
It knows no flow and no task; a script it runs does whatever those need.

### pod - where agents and commands work

A **base image** carries Herdr, git and the tool's helpers; the project's **images** are Containerfiles `FROM ${BASE}` that add its toolchains and agents, listed in `pod.yaml` by tag.
`heai-pod up --image <tag>` runs one persistent container from an image with a Herdr server inside; the clones live under `pod/repos`, one **worktree per piece of work** under `pod/worktrees`, each a Herdr workspace with Herdr's id.

```sh
heai-pod build                                    # the base, then every image in pod.yaml
heai-pod up --image proj/dev [--env-from ~/.heai/proj.env]
heai-pod repo add app                             # a clone from the map's localPath, kept in sync by the host
ws=$(heai-pod open app --branch agent/api-owner/t1 --actor api-owner)     # w2
heai-pod start "$ws" --agent claude               # w2:p2; commits in it are attributed to the actor
heai-pod prompt "$ws" --file prompt.md --notify /heai/flow/<id>/inbox --event exited
heai-pod run "$ws" --file block.sh --notify /heai/flow/<id>/inbox --event exited
heai-pod wait "$ws" --until blocked --notify /heai/flow/<id>/inbox --event needs-input
heai-pod wait "$ws" --notify /heai/flow/<id>/inbox --every 60s          # a heartbeat, for a state with an `after`
heai-pod repo pull-branch app agent/api-owner/t1  # the branch home, for the gate and the landing
heai-pod attach "$ws"                             # a human, in Herdr, looking at the agent
heai-pod close "$ws" --keep-worktree
```

`--notify <dir>` is the whole of how the container talks back: when the agent settles or the command exits, a helper writes one fact file into that directory by write-and-rename, with the settled state and exit code as JSON.
The directory is a flow's inbox, mounted once in `pod.yaml`, and `heai-flow settle` reads it; the pod never learns what a flow is.
Several containers from several images run side by side with `--container`, one per kind of actor if credentials should not mix.

### operator - the screen

An `htop`-shaped terminal view, read from the tools' files and CLIs, writing nothing of its own: every task with the actor it routes to and where its blocker stands; what `flow` says is open and stuck, and every flow of whichever definition is chosen; the container and the workspaces `heai-pod list` reports; the reactor's sources, rules and last hour of events.
It changes nothing: every key moves, opens, filters or reloads, and a change is made at the shell with the tool that records it. `heai-operator --once` or `--json` is the same screen for a script or a CI job, exit `1` when anything is red.

## The team

The map declares the roster and the tools give each member a way to act.

**Humans** are actors in the map like any other, owning the territories that stay theirs.
A human edits the map, in a text editor or `map-editor`, and the review of that commit is the architectural decision.
A human files and triages tasks, moves one to `todo` when it is ready, and is the only one who may make a move a definition marks `by: [human]`: `heai-flow advance <id> approved` is the approval, and nothing proceeds until it happens.
When an agent stops to ask, a human answers it with `heai-pod prompt`, or steps in with `heai-pod attach` and sees what the agent sees.
A human watches the whole of it on `operator`.

**Agents** are llm-agent actors in the map, each owning territories and each steered by the `context` written beside them.
An agent works in a pod workspace on its own branch, prompted with `heai-architect context <actor>` and the task, commits under its own name, and is judged by `heai-architect gate --actor <actor>` on the diff it produced.
A change it needs outside its territories is not made; it is filed, as a task in the other territory and a flow the session waits on, so an agent never crosses a boundary and the owner of the other side decides.
Any harness installed in the image is an agent kind: `heai-pod start --agent claude`, `--agent codex`.

**Automation** is the definitions, the rules and the scripts.
`reactor` turns the clock, the repositories and the network into events and runs a script for each; `flow` turns a state entered into a script and keeps the chain; a script does one move's mechanics through the tools' CLIs and records the outcome by advancing the flow, filing a task, or dropping a fact.
Nothing in automation may make a `by: [human]` move, and everything it does leaves a file a person can read.
Policy - who gets work and how much, what moves without a person, how many retries - is not a file of its own: it is a reactor rule, a `by:` on a transition, or an argument on a hook, so it is read where the rest of the process is and reviewed as the same diff.

Which humans, which agents, which territories, which flows and which scripts is the team's design, and it differs by what the team makes.
[`development-team.md`](development-team.md) is a software team: agents per area of the code, sessions on branches, and landing, checkpoint, promotion and release as flows chained by hooks and rules.
[`marketing-team.md`](marketing-team.md) is a content program: a writer per channel, an analyst over the experiments, a human who owns the brand and the publish button.
[`platform-team.md`](platform-team.md), [`compliance-team.md`](compliance-team.md) and [`research-team.md`](research-team.md) take the same tools to infrastructure, to evidence and attestations, and to reading a field, each with its own definitions and its own moves that only a person may make.
[`legal-team.md`](legal-team.md), [`support-team.md`](support-team.md) and [`finance-team.md`](finance-team.md) leave software behind altogether: contracts drafted from a clause library, a help center kept true to the tickets, and a month-end close that cannot end until every account is signed.

## Managing a project

**Standing it up.**

```sh
mkdir ~/Code/myproject && cd ~/Code/myproject && git init
heai-architect template > architecture.yaml && $EDITOR architecture.yaml && heai-architect check
heai-tasks init --dir heai-tasks --map ../architecture.yaml
mkdir -p flows scripts images/dev && $EDITOR flows/*.yaml scripts/*/*.sh images/dev/Containerfile
$EDITOR pod.yaml reactor.yaml
heai-pod build && heai-pod up --image myproject/dev && heai-pod repo add <repo>
heai-reactor serve                                                 # under the platform's service manager
heai-operator
```

A template under `templates/` is the usual starting point for `flows/` and `scripts/`; the two team documents each say which.

**The loop, once it runs.** A human moves a task to `todo`. A rule, on the minute or on the `task.todo` emit, runs a script that finds the actor the task routes to and starts a flow. Entering its first state runs the script that opens a workspace and prompts the agent, with `--notify` into the flow's inbox. The agent works; its heartbeat touches the flow; when it settles, a fact lands and the next `heai-flow settle` moves the flow on, and the next state's script brings the branch home, gates it, and records the verdict. From there the project's own definitions say what follows: a landing, a review, a publish, a human's approval.

**Where a human steps in.** At the map, when a boundary should move. At a task, when the work is not yet worth an agent's time or is routed to two actors. When an agent asked. At every `by: [human]` move. At `heai-flow stuck` and the red on `operator`, when a script failed and left its log under the flow's `actions/`; the person reads it and runs the script or the move again.

**Where the outside world comes in.** Through the reactor: a webhook, a poll or a schedule runs a script that drops a fact in a flow's inbox or files a task with a provenance line. The definition's `when` still decides what each fact means.

**Reading what happened.** `heai-flow trace <link>` is one timeline across every flow that shares the link, every line signed by who made the move. `heai-reactor events` is what came in and what ran. `git log` on the project is every change to the process itself.

## Hooks

A definition's `hooks` block is the process, whole: a person opening `flows/<name>.yaml` sees the states, the legal moves, who may make each, and what happens at each step.

```yaml
# flows/review.yaml - a document reviewed and approved
name: review
states: [open, checked, approved, rejected, stale]
initial: open
terminal: [approved, rejected, stale]
links: { doc: { required: true } }
transitions:
  - { from: open,    to: checked,  on: checked,  when: { failed: 0 }, by: [check.sh] }
  - { from: open,    to: rejected, on: checked,  by: [check.sh] }
  - { from: checked, to: approved, on: approved, by: [human] }
  - { from: checked, to: rejected, on: refused,  by: [human] }
  - { from: [open, checked], to: stale, on: stale, after: 7d }
hooks:
  open:    { run: scripts/review/check.sh }       # run the checks, then `heai-flow advance checked --data ...`
  checked: { run: scripts/review/notify.sh }      # file a task for the reviewer naming the flow
  stale:   { run: scripts/review/requeue.sh }
```

- **A hook is one script**, `run`, keyed by the state it fires on entering. A script that wants a task filed calls `heai-tasks new`, one that wants a flow moved calls `heai-flow advance` or writes a fact into an inbox, one that wants the reactor told calls `heai-reactor emit`.
- **`flow` runs it once per entry**, detached, after its locks are released, so a script may `heai-flow advance` its own flow without waiting. A flow that re-enters a state runs it again; a `link` or a `touch` enters no state.
- **It never advances the flow on its own.** The script does, because whether the move happened is the script's to say and its data is what the next `when` reads. A script that exits non-zero leaves the flow where it was, with its exit and log under `flow/flows/<id>/actions/`, and `heai-flow stuck` shows the flow within the hour.
- **It runs on the host, in the project directory**, with `HEAI_FLOW`, `HEAI_DEFINITION`, `HEAI_STATE`, `HEAI_EVENT`, `HEAI_SEQ`, one `HEAI_LINK_<NAME>` per link, and `HEAI_LINE` naming a file holding the journal line as JSON. It names no paths and receives none; every tool finds its files in the directory by convention. A script that wants the container runs `heai-pod run`; the host is where git, `gh` and credentials are.
- **Two scripts of one flow may overlap.** `flow` spawns and forgets. A script that must not overlap takes its own lock, with `mkdir`.
- **The block is validated and pinned** with the rest of the definition when a flow starts, so a definition edited while flows are open changes their scripts only on `heai-flow reindex --repin`.

## Scripts

A script is any executable; the templates' are POSIX shell with `jq`.
The contract is the environment above, the exit code - `0` did it, `1` refused and said why on stderr, `2` could not try - and the rule that a script records what it did by advancing a flow, filing a task, or writing a file under the project's own state, never by remembering.
Scripts pass `--by <name>` so the journal says which script moved the flow, and a definition's `by:` lists the names it accepts.

**The two files a script writes.** A fact into a flow's inbox is a file named for the event, with the event's data as a JSON body, written under a `.tmp` name and renamed into place, which is the whole of flow's inbox protocol and the same one pod's helpers use. A task a script files goes through `heai-tasks new` with a provenance line in its body naming the rule, the event and the source, so the task reads where it came from.

**Tasks that run.** A task whose body carries a fenced block tagged `run` is a script with its reason above it. The script that starts work on it reads the block with `heai-tasks show --json` and runs `heai-pod run <workspace> --file` instead of `heai-pod prompt`; the workspace, the branch, the attribution, the fact file and the gate are the same. No frontmatter key is added.

## Rules

```yaml
# reactor.yaml
sources:
  clock:     { type: schedule, cron: "* * * * *" }
  tasks_cli: { type: cli, kinds: [task.todo, task.canceled] }
  hooks:     { type: webhook, path: /hook/any, secret: file:.secrets/any, kind: /type, key: /id }
rules:
  - { name: minute,   on: { source: clock },                      run: "heai-flow settle && scripts/pick.sh" }
  - { name: pick-now, on: { source: tasks_cli, kind: task.todo }, run: scripts/pick.sh, debounce: 5s }
  - { name: inbound,  on: { source: hooks },                      run: scripts/inbound.sh }
  - { name: nightly,  on: { source: clock, cron: "0 2 * * *" },   run: scripts/nightly.sh }
```

The minute rule is what keeps flow moving: `heai-flow settle` folds the facts the containers dropped, expires the states whose `after` elapsed and fires the guards, and each state entered runs its script from inside `flow`, with no event ever reaching the reactor.
A task moved to `todo` by a person reaches the reactor when the person, or the wrapper they use, runs `heai-reactor emit tasks_cli task.todo`; without it the minute rule picks the task up within sixty seconds.
A script a rule runs sees `REACTOR_EVENT` naming the event's JSON and `REACTOR_<FIELD>` for each scalar of the payload.

## Templates

The tools ship no process, so the repository ships examples of one under `templates/`, copied into a new project and edited freely; a tool never reads a template by name.

- **`templates/software/`** - the development team's files. Four definitions are there: `landing`, `checkpoint`, `promotion` and `release`, each naming in `by:` the scripts allowed to move it. Still to write: the `session` and `request` definitions, the scripts, a `reactor.yaml`, and a `test.sh` that runs the team's worked day against a fake harness on a temporary repository, so the template is checked in this repository's CI.
- **`templates/content/`** - designed, in [`marketing-team.md`](marketing-team.md): the `piece` and `experiment` definitions, the content scripts and the schedules, over the software template's sessions, landings, checkpoints and releases.
- **`templates/testing/`** - designed: a `suite` definition, `open → pass | fail`, started by a nightly rule, `run.sh` running the suite through `heai-pod run`, and a hook on `fail` that files a task in the territory `heai-architect owner` gives for each failing path.

Until a `heai init --template <name>` exists, `cp -r`.

## What keeps it honest

- **The tools know no process.** No tool names a state, a policy or a script. Remove every file under `flows/` and `scripts/` and the six tools still validate, track, referee, watch, run and show; they just do nothing on their own.
- **Every move is a file someone can find.** A state's script leaves its exit and log beside its flow; a rule's run leaves them beside its event; a script's outcome is a journal line it signed; a task's move is a commit. Nothing is in memory, and `heai-reactor serve` can die at any line.
- **A human checkpoint cannot be scripted around.** `by: [human]` is refused from every script's `--by`, and `flow` refuses `flow` and `inbox` as callers, so a state gated on a person is left only by a person at the CLI.
- **An agent cannot cross a boundary.** The gate judges every diff against the map, and what an agent needs elsewhere becomes a task for the owner there.
- **The outside world enters through the inbox.** A webhook runs a script that writes a fact file, not an `advance`; the definition's `when` still decides what it means.
- **Configuration is refused before it runs.** Every `<tool>.yaml` is validated against the tool's schema with every problem reported at once.

## Open questions

1. **Whether `flow` should serialize a flow's scripts.** Today it spawns and forgets, which keeps `advance` instant and lets a script call `advance` on its own flow; a per-flow queue would guarantee order at the cost of a process that waits.
2. **The picker as a script.** Every team so far has one script with a policy in it and a lock, the one that turns a `todo` task into a flow. If it proves the thing every project rewrites badly, `tasks pick --for <actor> --json` is a neutral query to add, with the policy still the script's.
3. **Repinning.** A definition edited while flows are open keeps the old scripts for those flows until `heai-flow reindex --repin`; whether scripts should be read live from `flows/<name>.yaml`, with only the states and moves pinned, is the alternative.

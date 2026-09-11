# operator

An `htop`-shaped terminal view of what the heai tools are doing: one screen, refreshed on its own clocks, that reads each tool's own files and asks each tool's own CLI, holds nothing but the last thing it read, and changes nothing: every key on it moves, opens, filters or reloads, and every change to a task, a flow or the reactor is made at the shell with that tool's own command.

Four panes: **tasks**, every task in the tracker with the actor it routes to and where its blocker stands; **flows**, what `flow` says is stuck, and on request every flow of one definition the project declares; **pod**, the container and every workspace in it; **reactor**, each source's health, each rule's last run, and the last hour's events with what they caused.
One pane is a table and the other three are one line each, in a fixed order, so the screen never jumps.
The map pane is designed in [`DESIGN.md`](DESIGN.md) and not built yet.
The name is the Matrix's: the one at the console watching the crew inside.

```sh
go build -o heai-operator ./cmd/heai-operator     # or: go install ./cmd/heai-operator
cd ../../../aw3-operator && heai-operator    # from the project directory, or HEAI_DIR=... heai-operator from anywhere
```

Requires Go 1.26 or newer to build; the result is one static binary with no runtime dependencies. Each GitHub release attaches it for linux and darwin, amd64 and arm64, and `go install github.com/smailq/heai-tools/tools/operator/cmd/heai-operator@latest` builds it from source. It asks the other tools by their released names: `heai-architect`, `heai-flow`, `heai-pod`, `heai-reactor` and `heai-tasks` must be on PATH.
It is the first tool in this repository not written in TypeScript, for the reason the design gives: a full-screen loop over a terminal is what Go's TUI ecosystem was built for, and a program a person opens and closes all day should start in milliseconds.

## The screen

```
 operator  aw3-operator  tasks 91:  prog 2  review 1  blocked 3  todo 4  flows 19 ⚠2  pod ●3  reactor 12/1h ⚠1   2s  14:02:11
 tasks ── all 91 of 91 ─────────────────────────────────────────────────────────────── items/ changed 3m ago
 status       pri     slug                           territory       routes to         age
 in-progress  high    add-place-entity               core,desktop    desktop-owner     2d
 blocked      high    document-tabs                  ui              ui-owner          1d     ← help-requested-by-web-ui
 blocked      -       multiple-workspaces            core,desktop    desktop-owner     6d     ← ontology-entity-identity (blocker canceled)
 todo         -       add-command-line-shortcut      -               (untriaged)       11d
 flows    ⚠ 2 stuck > 1h   session 14 (running 2 · blocked 1 · clean 10)   request 2 (todo 2)          flow 4s ago
 pod      ● heai-workshop running · herdr 0.9.0   workspaces 3 (working 2 · idle 1)                       pod 4s ago
 reactor  ● clock  ● drops  ● tasks_cli  ○ github   12 events/1h · 4 rules                            reactor 5s ago
 ↑↓ move  ⏎ open  b active  S sort  1-4 pane  / filter  +/- interval  r reload  ? help  q quit
```

**The header** carries the project's name, the task count, the counts that matter in pick-up order - in progress, in review, blocked, to do - each coloured when it is not zero, the open flows with the stuck count beside them, the container with its workspace count or `○` when it is down, the reactor's events in the last hour with `✗` for a rule that failed or `⚠` for a source with a problem, then the tracker's refresh interval and the clock.
On a narrow terminal the meters leave from the right before the clock is cut.

**`1` to `4`** give the table to the tasks, the flows, the pod or the reactor; the other three panes stay as one line each, above or below the table in the same order.
Each line carries the pane's counts and, on the right, the age of its data, because each pane is read on its own clock and the screen is honest about how old each number is.

### tasks

**The table** shows every task, in the order `INDEX.md` lists them - status in pick-up order, then triaged priority with unset last, then slug - so the active work is at the top and the backlog below it.
`b` narrows it to the active tasks - `in-progress`, `in-review`, `blocked` and `todo` - and `b` again widens it.
A file that does not meet the tracker's format is listed too, in red, with its first problem, because a broken task file is the first thing to fix.

| column | what it is |
| --- | --- |
| `status`, `pri` | the task's own frontmatter; empty priority is `-`, meaning not yet triaged |
| `slug` | the file name, the task's stable id |
| `territory` | the task's territories, sorted and unique, as the tracker writes them |
| `routes to` | the actor owning each territory, asked of `heai-architect territories --json`; `?` for a territory the map does not declare, `(untriaged)` for no territory at all |
| `age` | days since `modified_at`, when the task last moved |
| the last column | a blocked task's blocker, from the first `Blocked by [slug](slug.md)` in its body, and where that blocker stands: red when it is `canceled` or not in the tracker, since that task will never unblock on its own |

Columns leave as the terminal narrows - age first, then routes to, then territory, then priority - and the key bar drops its least-used keys before it drops help and quit.

**The task pane.** From 100 columns the screen splits: the list on the left, and on the right the task under the cursor - its frontmatter as a table, its territories with the actor each routes to, its blocker and that blocker's status, the file's path, and its body, wrapped to the pane.
Moving the cursor changes the task; **Tab** moves focus to the task pane so `↑` `↓` and `pgup` `pgdn` scroll a long body, and the rule above the body says which lines are showing.
The list keeps its status, priority and slug columns and its blocker notes, and gives the rest of its columns to the task pane, which shows them in full.

```
 tasks ── all 11 of 11 ────────────────── items/ changed 3m ago│ task ── blocked · document-tabs ──── modified 2026-09-06
 status       pri     slug                                     │ title       Document tabs
 in-progress  high    add-place-entity                         │ status      blocked
 blocked      high    document-tabs   ← help-requested-by-web-ui│ territory   ui  → ui-owner
 blocked      -       multiple-workspaces  ← ontology-entity-i…│ blocked by  help-requested-by-web-ui  (todo)
                                                               │ ── body ─────────────────────────────── lines 1-4 of 4
                                                               │ Tabs.
```

**`p`** hides the task pane and shows it again; hidden, the list takes the whole width and gets its territory, routes-to and age columns back.
Under 100 columns the list has the screen to itself, and **Enter** opens the task full width; Enter does the same when split, for a body worth the whole screen.

### flows

```
 flows ── 2 stuck older than 1h · 19 open ──────────────────────────────────────────────────────────── flow 4s ago
 definition  state       id                              idle   waits on                      stands
 session     blocked     20260903-101010-session-1f2e    3d     task ontology-entity-identity  canceled
 session     blocked     20260906-024801-session-77f0    2h     task help-requested-by-web-ui  todo
 ── all open, by definition ────────────────────────────────────────────────────────────────────────────────────
 landing     proposed   1
 session     blocked    2   running    1
```

**The line** puts the stuck count first, because it is the number that matters, then each definition's flows by state, open states first and the most numerous first.

**The table** is the stuck report as `heai-flow stuck --json` gives it - flows nothing has moved or touched for an hour, grouped by definition and state - each with how long it has been idle, what it waits on, and where that stands.
`waits on` names each waited flow by what it is about: its `task` link, else its `lane`, else its first link, else its id.
`stands` is each waited flow's state, or `missing` when the flow is gone.
A row is red when a waited flow is missing or has reached a terminal state other than `done`: a guard that wants `done` will never fire, and it is exactly the thing a person needs to notice.
Below the report, every definition with open flows, with the count in each open state.

**Enter** opens `heai-flow trace <id>` for the flow under the cursor, full width: the cross-flow timeline as flow prints it, task → session → request → task, one line each with its time, move and who made it.
`↑` `↓` scroll it, `r` asks again, `esc` returns.

**One definition's flows.** `d` puts a chooser on the bar: the stuck report, then every definition the project declares - `heai-flow definitions --json` - or has flows of, by name.
`←` `→` move along it, a digit picks, `⏎` shows the choice, `esc` keeps what was showing.
A definition chosen, the table is every flow of it, in the order flow lists them, with its state and how long it has been in it, and then one column per link the flows carry - `task`, `actor`, `repo` and `branch` first when present, the rest by name - each as wide as its widest value, the last taking what is left, and leaving from the right on a narrow terminal.
Terminal flows are dimmed.
The open-flows summary stays under the table, so the other definitions are still in view, and `⏎` still opens the trace.

```
 flows ── session · 3 open of 4 ─────────────────────────────────────────────────────────────────── flow 4s ago
 id                            state       age    task                actor          repo  branch
 20260906-031244-session-9a1c  running     6m     add-place-entity    desktop-owner  app   agent/desktop-owner/add-place-entity
 20260906-024801-session-77f0  blocked     2h     document-tabs       web-ui         app   agent/web-ui/document-tabs
 ── all open, by definition ─────────────────────────────────────────────────────────────────────────────────────
 landing     proposed   1
 session     blocked    1   running    1
 definition   stuck   landing  [session]                                        ←→ choose · 1-9 pick · ⏎ show · esc back
```

A definition with no flows yet is one dim line saying so; one whose file does not read is one red line with flow's problem.
Nothing here knows what a session or a landing is: the definitions are the project's, and the pane lists whichever it is pointed at.

### pod

```
 pod ── heai-workshop running · herdr 0.9.0 · 3 workspaces · agents working 1 · idle 1 · blocked 1 ──────── pod 4s ago
 id    actor           repo      branch                                    agent         state     label
 w1    -               app       main                                      -             unknown   app  (the clone)
 w3    desktop-owner   app       agent/desktop-owner/add-place-entity      claude w3     working   desktop-owner/add-place-entity
 w4    web-ui          app       agent/web-ui/document-tabs                claude w4     idle      web-ui/document-tabs
 w2    core-reviewer   app       agent/core-reviewer/merge-two-entities    claude w2     blocked   core-reviewer/merge-two-entities
```

**The line** is the container's word first - `●` running with Herdr's version, `○` in amber when the container is stopped, absent, or up without Herdr - then the worktree workspaces by their agent's state.

**The table** is `heai-pod status --json` on the title and `heai-pod list --json` under it: every workspace Herdr has, in the order pod lists them, with the actor, repository and branch pod recorded when it opened it, the agent running in it, the rolled-up agent state, and Herdr's label.
The clone itself is a row too, dimmed and marked `(the clone)`, because Herdr opens the source repository as a workspace when the first worktree is created and a person attaching sees it.
While the container is down the table is one amber line saying so; `list` is not asked, since there is nothing to list.

**Enter** opens the workspace full width: its status, actor, repository, branch and path, the metadata tokens pod wrote, every agent with its pane and state, and every pane with what runs in it and where.
`↑` `↓` scroll it, `esc` returns.

Nothing here is a write: opening, starting, prompting and closing are the project's scripts, and `heai-pod attach` wants a terminal of its own.

### reactor

```
 reactor ── 5 sources ⚠ 2 · 4 rules · 3 events in the last hour · 1 failed ────────────────────────────── reactor 5s ago
 source        type      cadence           last   /1h  cursor
 ● clock       schedule  every 10s         13:38  1    cron * * * * *; last slot 2026-09-09T13:38:00.000Z
 ● tasks_cli   cli       from emit         13:38  1    kinds task.todo, task.done; emitted 1, pending 0; last 2026-09-0…
 ● drops       dir       every 2s          13:38  1    drops; 1 taken, last exited (exited.w2) at 2026-09-09T13:38:38.5…
 ○ github      webhook   listens /hook/g…  -      0    ⚠ env:GITHUB_HOOK_SECRET is not set
 ○ health      poll      every 5m          -      0    ⚠ fetch failed
 ── rules 4 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
 rule              on                                        run                   last   result
 sweep             source=clock                              scripts/sweep.sh      13:38  ok
 session-exited    source=drops kind=exited                  exit 3                13:38  exited 3
 pr-merged         source=github kind=pull_request.closed …  scripts/merged.sh     -      limit 10/hour
 ── events, newest first · heai-reactor events --since 1h ──────────────────────────────────────────────────────────────
 at     source      kind              key                                   rule → result
 13:38  drops       exited            exited.w2@1789093838588.2175@b0f27d…  session-exited → exited 3
 13:38  tasks_cli   task.todo         fetch-company-favicon@todo            pick-now → ok
 13:38  clock       tick              clock@2026-09-09T13:38:00.000Z        sweep → ok
```

**The line** is a dot per source - `●`, or `○` in amber when the source's own cursor reports a problem: a poll that failed, a secret that does not resolve, a directory that cannot be read - then the hour's event count, the rule count, and in red how many rule runs failed in that hour.

**The table** is three blocks.
The **sources** are `heai-reactor status --json` as it describes them: type, cadence - the poll interval, the path a webhook listens on, or `from emit` for a `cli` source - the time of the last event, the count in the last hour, and the cursor in the source's own words, or its problem in amber.
The **rules** are the same answer's other half: what each listens for, what it runs, when it last ran and how that went - `ok`, the error such as `exited 3` in red, `limited`, or for a rule that never fired its limit or `never fired` - and a debounce that is still waiting.
The **events** are `heai-reactor events --since 1h --json`, newest first, each with the rules that acted on it and their result; the cursor moves over these.
When the region is short the sources and rules give way first, saying how many more there are, so the events keep a few rows.

**Enter** opens the event full width: its fields, its payload as JSON, and every action a rule took on it with the command it ran, its result, and the path of its log.
`↑` `↓` scroll it, `esc` returns.
A tick run at the shell, `heai-reactor tick`, shows here on the next poll.

### Keys

| key | does |
| --- | --- |
| `1` to `4` | the pane with the table: tasks, flows, pod, reactor |
| `↑` `↓` `j` `k`, `pgup` `pgdn`, `g` `G` | move, page, first and last |
| `⏎` | open the row full width: a task, a flow's `heai-flow trace`, a workspace, or an event with its actions; `esc` back |
| `p` | show or hide the task pane |
| `⇥` | focus the task pane, to scroll it; `⇥` or `esc` back to the list |
| `d` | in flows: choose what the table lists, the stuck report or one definition's flows; in the chooser `←` `→` move, digits pick, `⏎` shows, `esc` keeps |
| `b` | every status ↔ the active ones: `in-progress`, `in-review`, `blocked`, `todo` |
| `S` | sort tasks: pick-up order, then age, slug, territory |
| `/` | filter the pane by any of its text as you type; `⏎` keeps it, `esc` clears it |
| `+` `-` | the tracker's refresh interval, one second to a minute |
| `r` | reload every pane now |
| `?` | help: every key, and where each number on the screen comes from |
| `q`, `ctrl-c` | quit |

Colour is the sixteen ANSI colours only, so the screen follows the terminal's theme: moving green, waiting yellow, gone wrong red, over dim, ready to move bold, and red for what is wrong.

## Where the numbers come from

Everything on the screen is read fresh on its pane's clock; the process keeps only the last reading.

- **The tracker** is read from its files every two seconds, under the format contract the tasks tool's README states: one file per task under `items/`, exactly six frontmatter keys, its status and priority vocabularies, and a comma-separated territory list. This is a second reader of that format, written on purpose (root README, principle 1) and pinned by the same fixture the tasks tool's own model test parses, in [`internal/tracker`](internal/tracker). `heai-tasks list --json` does not exist yet; when it does, this reader can go.
- **Owners and repositories** are asked of `heai-architect territories --json --map <path>` and `heai-architect check --format json --map <path>`, never read from the map itself, so this tool holds no second map reader or glob dialect. architect is asked again only when the map's mtime moves. Without architect on `PATH`, or without a map, the column shows `-` and the pane's title says why. [`internal/owners`](internal/owners) pins both outputs.
- **The blocker** is the tracker's own convention - the `Blocked by` note - and its state is that slug's status in the same tracker.
- **Flows** are `heai-flow definitions --json`, `heai-flow list --json` and `heai-flow stuck --json`, run with `--dir` set to the map's directory so flow looks beside the same map, every five seconds. One definition's table is the `list` answer filtered by definition; nothing is asked per definition. The output shape is recorded under [`testdata/flow/`](testdata/flow) from a real `heai-flow start` and pinned by [`internal/flows`](internal/flows): that recording is the format contract. flow is asked only when `flow.yaml` or `flow/` sits beside the map, or `HEAI_FLOW_STATE` is set, because `heai-flow list` creates `flow/` when it is absent and a screen must not leave a state directory behind.
- **The pod** is `heai-pod status --json` and, when it says the container and Herdr are up, `heai-pod list --json`, both run with `--dir <project>` on the same clock. `status` exits `1` with its JSON when either is down, and that is read as an answer, not a failure. pod is asked only when `pod.yaml` or `pod/` sits in the project, or `HEAI_POD_STATE` is set, because `heai-pod status` creates `pod/` when it is absent. The outputs are recorded under [`testdata/pod/`](testdata/pod) through the tool against its fake runtime and pinned by [`internal/pod`](internal/pod).
- **The reactor** is `heai-reactor status --json` and `heai-reactor events --since 1h --json`, with `--dir <project>`, on the same clock, and asked only when `reactor.yaml`, `.heai/reactor.yaml` or `reactor/` sits in the project, or `HEAI_REACTOR_STATE` is set, for the same reason. Each event `events --json` prints carries the actions rules took on it, so nothing here reads reactor's files. [`testdata/reactor/`](testdata/reactor) records both from one emit, one dropped fact and two ticks, pinned by [`internal/reactor`](internal/reactor).
- **The recordings** under `testdata/pod/` and `testdata/reactor/` are made by [`testdata/record.sh`](testdata/record.sh), which runs the two tools from their sources - pod against its fake runtime, reactor against a temporary project - and rewrites only the temporary path to `/repo`. When a tool's output changes, run it, then `go test ./internal/ui -update`, and read the goldens.
- **A pane whose tool fails** keeps its last table and says `⚠ <reason> · as of <time>` on its title; a pane that never answered shows why: not on `PATH`, not configured here, or the command's last line.

Reading the tracker has no side effects.
Asking architect, flow, pod and reactor has none either: every command this tool runs is a query.
There are no writes. An earlier build bound `heai-tasks set`, `heai-flow start session`, the project's cancel script and `heai-reactor tick` to keys; they were removed so the screen is only ever a reading of the tools, and a change is made where it is recorded, at the shell with the tool's own command.

## Discovery

Flags first, then the specific environment variables, then the project directory, then the `.heai/` convention, then the legacy default in the working directory:

| what | flag | environment | default |
| --- | --- | --- | --- |
| the project | `--dir <dir>` | `HEAI_DIR` | the map's directory, else the tracker's parent |
| the tracker | `--tasks <dir>` | `HEAI_TASKS` | `$HEAI_DIR/tasks`, else `.heai/tasks` if it exists, else `tasks` |
| the map | `--map <path>` | `HEAI_MAP` | `$HEAI_DIR/architecture.yaml`, else the tracker's `tasks.yaml` `map:`, else `.heai/architecture.yaml`, else `architecture.yaml` |

The project directory is what pod and reactor are asked about; under `HEAI_DIR` the map, the tracker and every tool's state sit in it, which is what `project.md` describes.
The tracker's own configuration sits between the environment and the convention because it is the tracker's statement of which map validates its territories, and this tool should agree with the tracker about who owns what.
flow is given the map's directory as `--dir`, so it finds its state beside the same map this screen reads.

## The CLI

```
heai-operator                  the screen
heai-operator --once                the screen, once, to stdout, then exit
heai-operator --once --active       only the active tasks, not the backlog and the closed
heai-operator --json                the tracker, the flows, the pod and the reactor as the screen read them, with owners, counts and whether anything is red
heai-operator --interval 5s         the tracker's refresh interval (default 2s)
heai-operator --poll 10s            the clock for the panes that ask flow, pod and reactor (default 5s)
heai-operator --width 100           --once: columns to render (default $COLUMNS, else 120)
```

`--once` and `--json` are the whole tool without a terminal, and what makes it a health check: a cron line, or a script reading `red`.
`--once` prints the tasks table with the other three panes' lines under it, never the split, since a batch listing wants rows.

### Exit codes

| code | meaning |
| --- | --- |
| `0` | shown; under `--once` or `--json`, nothing on the screen is red |
| `1` | under `--once` or `--json`, something is red: an invalid task file, a blocked task whose blocker is canceled or missing, a stuck flow waiting on a flow that is missing or ended without `done`, or a reactor rule that ran and failed on an event in the last hour |
| `2` | no tracker at the resolved directory, or bad usage |

The interactive screen exits `0` on `q` whatever it shows; the split is for the batch modes, and it is the same `0` yes, `1` no, `2` could not ask as every other tool here.

## Layout

```
cmd/operator/main.go      flags, discovery, --once and --json, exit codes
internal/discover/        the project directory, the tracker, the map
internal/tracker/         the tracker reader and its fixture: testdata/tracker/ has one task per case
internal/owners/          heai-architect territories --json and check --format json, recorded in testdata/
internal/flows/           heai-flow definitions --json, list --json, stuck --json and trace; the fixtures are testdata/flow/ at the root
internal/pod/             heai-pod status --json and heai-pod list --json; the fixtures are testdata/pod/ at the root
internal/reactor/         heai-reactor status --json and heai-reactor events --json; the fixtures are testdata/reactor/ at the root
internal/ui/              the Bubble Tea model, the screen, and golden renderings in testdata/golden/
testdata/                 the sibling tools' recorded output, the format contracts this tool reads; record.sh makes the pod and reactor ones
```

```sh
go test ./...                      # the readers against their fixtures, the screen against its goldens
go test ./internal/ui -update      # rewrite the goldens after a deliberate change to the screen
go vet ./...                       # the typecheck
```

Built on [Bubble Tea v2](https://github.com/charmbracelet/bubbletea) and [Lip Gloss v2](https://github.com/charmbracelet/lipgloss), with `yaml.v3` for the tracker's `tasks.yaml`; nothing else.

## What is not here yet

The map pane, over `heai-architect check --format json`, designed in [`DESIGN.md`](DESIGN.md): the map's verdict is one line the header could carry when a pane for it is worth the height.
The design's `pages` line is gone with the pages: the implemented tools are command line only.
Any write: the keys `e`, `a`, `c` and `s` that once ran `heai-tasks set`, `heai-flow start session`, the project's cancel script and `heai-reactor tick` are gone, and this tool changes nothing.
A source that is quiet - one that has not produced within twice its interval - is not marked; only a source whose own cursor reports a problem is, because `status --json` does not say when a source last polled, and a git source with no commits for a day is quiet and fine.

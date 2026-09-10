# operator

An `htop`-shaped terminal view of what the heai tools are doing: one screen, refreshed on its own clocks, that reads each tool's own files and asks each tool's own CLI, holds nothing but the last thing it read, and writes nothing itself.

Three panes: **tasks**, every task in the tracker with the actor it routes to and where its blocker stands; **flows**, what `flow` says is stuck and what is open; **sessions**, the session flows and the workspaces in the container.
One pane is a table and the other two are one line each, in a fixed order, so the screen never jumps.
The map pane and the reactor pane are designed in [`DESIGN.md`](DESIGN.md) and not built yet.
The name is the Matrix's: the one at the console watching the crew inside.

```sh
go build -o operator ./cmd/operator     # or: go install ./cmd/operator
cd ../../../aw3-operator && operator    # from the project directory, or HEAI_DIR=... operator from anywhere
```

Requires Go 1.26 or newer to build; the result is one static binary with no runtime dependencies.
It is the first tool in this repository not written in TypeScript, for the reason the design gives: a full-screen loop over a terminal is what Go's TUI ecosystem was built for, and a program a person opens and closes all day should start in milliseconds.

## The screen

```
 operator  aw3-operator  tasks 91:  prog 2  review 1  blocked 3  todo 4  flows 19 ⚠2  sessions 3          2s  14:02:11
 tasks ── all 91 of 91 ─────────────────────────────────────────────────────────────── items/ changed 3m ago
 status       pri     slug                           territory       routes to         age
 in-progress  high    add-place-entity               core,desktop    desktop-owner     2d
 blocked      high    document-tabs                  ui              ui-owner          1d     ← help-requested-by-web-ui
 blocked      -       multiple-workspaces            core,desktop    desktop-owner     6d     ← ontology-entity-identity (blocker canceled)
 todo         -       add-command-line-shortcut      -               (untriaged)       11d
 flows    ⚠ 2 stuck > 1h   session 14 (running 2 · blocked 1 · clean 10)   request 2 (todo 2)          flow 4s ago
 sessions 3 open of 14   running 2 · blocked 1   workspaces 3 (running 2 · idle 1)                       flow 4s ago
 ↑↓ move  ⏎ open  e edit  a start  b active  S sort  1-3 pane  s tick  / filter  +/- interval  r reload  ? help  q quit
```

**The header** carries the project's name, the task count, the counts that matter in pick-up order - in progress, in review, blocked, to do - each coloured when it is not zero, the open flows with the stuck count beside them, the open sessions, then the tracker's refresh interval and the clock.

**`1` `2` `3`** give the table to the tasks, the flows or the sessions; the other two panes stay as one line each, above or below the table in the same order.
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
| `routes to` | the actor owning each territory, asked of `architect territories --json`; `?` for a territory the map does not declare, `(untriaged)` for no territory at all |
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

**Editing.** `e` on a task opens two rows of pills under the list, status and priority, with the task's current values marked.
`←` `→` choose along a row, `↑` `↓` switch rows, a digit picks directly, and the title of the block says what would change.
`⏎` applies the change by running `tasks set <slug> --status=… --priority=… --dir <tracker>` with only the fields that moved, so the tracker's own tool validates the values, restamps `modified_at` and regenerates `INDEX.md`; this screen never writes a task file itself.
The command and the tool's answer then show in place of the key bar until the next key - `Updated items/document-tabs.md: status` on success, the tool's refusal in red otherwise - and the list reloads.
`esc` cancels, and `⏎` with nothing changed runs nothing.

```
 edit ── document-tabs  status blocked → todo ──────────────── ⏎ apply through tasks set · esc cancel
 status     in-progress   in-review   blocked   todo   backlog   done   canceled
 priority   -   urgent  [high]  medium   low
```

**Starting a session.** `a` on a task shows `flow start session --link task=<slug> --link actor=<owner> --link repo=<repo> --map <map>` on the bar, and `y` runs it.
The owner is the actor the task's territories route to, as the `routes to` column shows; the repository is the first the map declares, asked of `architect check --format json`.
A task with no territory, a territory the map does not declare, two owners, or no repository to link is not offered: the bar says which, because a task routed to two actors is a human's to start.
What happens next is the project's: the flow's `queued` hook runs the project's start script, and this screen only started the flow.

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

**The table** is the stuck report as `flow stuck --json` gives it - flows nothing has moved or touched for an hour, grouped by definition and state - each with how long it has been idle, what it waits on, and where that stands.
`waits on` names each waited flow by what it is about: its `task` link, else its `lane`, else its first link, else its id.
`stands` is each waited flow's state, or `missing` when the flow is gone.
A row is red when a waited flow is missing or has reached a terminal state other than `done`: a guard that wants `done` will never fire, and it is exactly the thing a person needs to notice.
Below the report, every definition with open flows, with the count in each open state.

**Enter** opens `flow trace <id>` for the flow under the cursor, full width: the cross-flow timeline as flow prints it, task → session → request → task, one line each with its time, move and who made it.
`↑` `↓` scroll it, `r` asks again, `esc` returns.

### sessions

```
 sessions ── 3 open of 4 ─────────────────────────────────────────────────────────────────────────── flow 4s ago
 id                            actor           task                state      age    branch
 20260906-031244-session-9a1c  desktop-owner   add-place-entity    running    6m     agent/desktop-owner/add-place-entity
 20260906-024801-session-77f0  web-ui          document-tabs       blocked    2h     agent/web-ui/document-tabs
 ── workspaces 3 · pod list ───────────────────────────────────────────────────────────────────────
 w3     desktop-owner/add-place-entity  claude desktop-owner    running   agent/desktop-owner/add-place-entity
 w1     web-ui/document-tabs            claude web-ui           idle      agent/web-ui/document-tabs
```

**The table** is `flow list session --json`: every flow of the definition named `session`, newest first as flow lists them, with its `actor`, `task` and `branch` links, its state, and how long it has been in that state.
A project with no `session` definition, or none started, shows one dim line saying `no session flows`.
Under it, when `pod` is on `PATH`, the workspaces `pod list --json` reports: the workspace id, its label, the agent in it with its state, and its branch.
Without the tool, or when it fails, that block is one dim line saying so, and the sessions above it are unaffected.

**Enter** opens the session's `flow trace`, as in the flows pane.
**`c`** on a session shows `scripts/session/cancel.sh <id>` on the bar and `y` runs it, in the project directory, because cancelling is the project's mechanics and this tool knows only the script's path.
A project without that script gets a bar line saying there is none; a session already in a terminal state is not offered.

### Keys

| key | does |
| --- | --- |
| `1` `2` `3` | the pane with the table: tasks, flows, sessions |
| `↑` `↓` `j` `k`, `pgup` `pgdn`, `g` `G` | move, page, first and last |
| `⏎` | open the row full width: a task, or a flow's `flow trace`; `esc` back |
| `p` | show or hide the task pane |
| `⇥` | focus the task pane, to scroll it; `⇥` or `esc` back to the list |
| `e` | edit the task's status and priority, through `tasks set`; in the editor `←` `→` choose, `↑` `↓` row, digits pick, `⏎` applies, `esc` cancels |
| `a` | start a session on the task, through `flow start session`, after `y` |
| `c` | cancel the session, through the project's `scripts/session/cancel.sh`, after `y` |
| `s` | one tick of the daemon, `reactor tick`; its exit and last line show on the bar |
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

- **The tracker** is read from its files every two seconds, under the format contract the tasks tool's README states: one file per task under `items/`, exactly six frontmatter keys, its status and priority vocabularies, and a comma-separated territory list. This is a second reader of that format, written on purpose (root README, principle 1) and pinned by the same fixture the tasks tool's own model test parses, in [`internal/tracker`](internal/tracker). `tasks list --json` does not exist yet; when it does, this reader can go.
- **Owners and repositories** are asked of `architect territories --json --map <path>` and `architect check --format json --map <path>`, never read from the map itself, so this tool holds no second map reader or glob dialect. architect is asked again only when the map's mtime moves. Without architect on `PATH`, or without a map, the column shows `-` and the pane's title says why. [`internal/owners`](internal/owners) pins both outputs.
- **The blocker** is the tracker's own convention - the `Blocked by` note - and its state is that slug's status in the same tracker.
- **Flows** are `flow list --json` and `flow stuck --json`, run with `--map <path>` so flow looks beside the same map, every five seconds. The output shape is recorded under [`testdata/flow/`](testdata/flow) from a real `flow start` and pinned by [`internal/flows`](internal/flows): that recording is the format contract. flow is asked only when `flow.yaml` or `flow/` sits beside the map, or `HEAI_FLOW_STATE` is set, because `flow list` creates `flow/` when it is absent and a screen must not leave a state directory behind.
- **Sessions** are `flow list session --json` on the same clock, and **workspaces** are `pod list --json`. That tool is being built beside this one; the shape read here is its design's, pinned by [`testdata/pod/list.json`](testdata/pod/list.json) and [`internal/workspaces`](internal/workspaces), and the block dims when the command is absent or fails.
- **A pane whose tool fails** keeps its last table and says `⚠ <reason> · as of <time>` on its title; a pane that never answered shows why: not on `PATH`, not configured here, or the command's last line.

Reading the tracker has no side effects.
Asking architect, flow and pod has none either: every command run on a clock is a query.
The writes are `e`, `a`, `c` and `s` - `tasks set`, `flow start session`, the project's cancel script and `reactor tick` - each run verbatim and shown on the bar with its outcome: the screen is never the only way a change happened, and a person who learns the key has learned the command.
`a` and `c` show the command and wait for `y`; `e` applies on `⏎` from its editor; `s` runs at once, since a tick is what `cron` does every minute anyway.

## Discovery

Flags first, then the specific environment variables, then the project directory, then the `.heai/` convention, then the legacy default in the working directory:

| what | flag | environment | default |
| --- | --- | --- | --- |
| the project | `--dir <dir>` | `HEAI_DIR` | the map's directory, else the tracker's parent |
| the tracker | `--tasks <dir>` | `HEAI_TASKS` | `$HEAI_DIR/tasks`, else `.heai/tasks` if it exists, else `tasks` |
| the map | `--map <path>` | `HEAI_MAP` | `$HEAI_DIR/architecture.yaml`, else the tracker's `tasks.yaml` `map:`, else `.heai/architecture.yaml`, else `architecture.yaml` |

The project directory is where the scripts run and what `reactor tick` reads; under `HEAI_DIR` the map, the tracker and flow's state all sit in it, which is what `docs/project.md` describes.
The tracker's own configuration sits between the environment and the convention because it is the tracker's statement of which map validates its territories, and this tool should agree with the tracker about who owns what.
flow is given the map's path, so it finds its state beside the same map this screen reads.

## The CLI

```
operator                       the screen
operator --once                the screen, once, to stdout, then exit
operator --once --active       only the active tasks, not the backlog and the closed
operator --json                the tracker, the flows and the sessions as the screen read them, with owners, counts and whether anything is red
operator --interval 5s         the tracker's refresh interval (default 2s)
operator --poll 10s            the clock for the panes that ask flow and pod (default 5s)
operator --width 100           --once: columns to render (default $COLUMNS, else 120)
```

`--once` and `--json` are the whole tool without a terminal, and what makes it a health check: a cron line, or a script reading `red`.
`--once` prints the tasks table with the flows and sessions lines under it, never the split, since a batch listing wants rows.

### Exit codes

| code | meaning |
| --- | --- |
| `0` | shown; under `--once` or `--json`, nothing on the screen is red |
| `1` | under `--once` or `--json`, something is red: an invalid task file, a blocked task whose blocker is canceled or missing, or a stuck flow waiting on a flow that is missing or ended without `done` |
| `2` | no tracker at the resolved directory, or bad usage |

The interactive screen exits `0` on `q` whatever it shows; the split is for the batch modes, and it is the same `0` yes, `1` no, `2` could not ask as every other tool here.

## Layout

```
cmd/operator/main.go      flags, discovery, --once and --json, exit codes
internal/discover/        the project directory, the tracker, the map
internal/tracker/         the tracker reader and its fixture: testdata/tracker/ has one task per case
internal/owners/          architect territories --json and check --format json, recorded in testdata/
internal/flows/           flow list --json, flow stuck --json, flow trace; the fixtures are testdata/flow/ at the root
internal/workspaces/      pod list --json; the fixture is testdata/pod/ at the root
internal/actions/         the writes: tasks set, flow start session, scripts/session/cancel.sh, reactor tick
internal/ui/              the Bubble Tea model, the screen, and golden renderings in testdata/golden/
testdata/                 the sibling tools' recorded output, the format contracts this tool reads
```

```sh
go test ./...                      # the readers against their fixtures, the screen against its goldens
go test ./internal/ui -update      # rewrite the goldens after a deliberate change to the screen
go vet ./...                       # the typecheck
```

Built on [Bubble Tea v2](https://github.com/charmbracelet/bubbletea) and [Lip Gloss v2](https://github.com/charmbracelet/lipgloss), with `yaml.v3` for the tracker's `tasks.yaml`; nothing else.

## What is not here yet

The map pane, over `architect check --format json`, and the reactor pane, over `reactor status --json` and `reactor events --json`, both designed in [`DESIGN.md`](DESIGN.md) and waiting on the tools: the reactor is not built, and the map's verdict is one line the header could carry when a pane for it is worth the height.
The design's `pages` line is gone with the pages: the implemented tools are command line only.

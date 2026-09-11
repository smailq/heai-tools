# @heai-tools/flow

Tracks a multi-stage process as a state machine per record and a graph of records.
A definition says which states exist, which moves between them are legal, and which script runs on entering each.
A journal per flow records every move.
One command answers what state anything is in, what it waits on, and what is stuck.

```sh
npm install && npm link                                            # once: builds dist/ and puts `heai-flow` on PATH
heai-flow definitions                                                   # every definition under flows/
heai-flow start session --link actor=alpha --link task=t1 --link repo=app   # prints the new flow's id
heai-flow advance 20260909-140750-session-2e49 started --by start.sh
heai-flow trace task=t1                                                 # one timeline across every linked flow
heai-flow settle                                                        # the catch-up a cron line runs
```

Requires Node 22.18 or newer. `npm install` builds the command into `dist/`, and `npm link` puts it on PATH as `heai-flow`; without the link, every command is `node dist/cli.js <command>` from this directory, and during development `node src/cli.ts <command>` runs the sources directly. Released as `@heai-tools/flow` on npm: `npm install -g @heai-tools/flow`.
Two runtime dependencies: a YAML parser and a JSON Schema validator.

## The shape of it

```
flows/<name>.yaml ──► heai-flow start ──► flow/flows/<id>/journal.jsonl  (append-only, the truth)
                                          │
  a script: heai-flow advance <id> <event> ────┤  each line: one transition, refused if illegal
  the clock: a state's `after` elapsed ───┤  settle makes the move
  a linked flow reaching a state ─────────┘  a guard is satisfied; settle makes the move
                                          │
                              by-state/<definition>/<state>/<id>   regenerated index
                              by-link/<name>/<value>/<id>          regenerated index
                              flows/<id>/state.json                regenerated snapshot
                                          │
                              flows/<id>/actions/<seq>-<state>.*   the script the state names, started detached
```

- **A definition** is a flat state machine in a YAML file: states, one initial, some terminal, and transitions each with a `from`, a `to` and the `on` event that makes it. A state may name the script to start when a flow enters it.
- **A flow** is one record moving through one definition, with an id that sorts by time, links to the things it is about and to other flows, and a journal of every transition. It keeps a pinned copy of the definition it started under.
- **The journal is the truth.** The snapshot and the two indexes are regenerated views. A flow's current state is the `to` of its last journal line.
- **Moves come from three places:** `heai-flow advance`, the clock expiring a state, and a linked flow reaching a state a guard waits for. The first is immediate; the other two happen at settle.
- **Every state entered starts one script**, detached, and `flow` forgets it. No ordering, no retry, no timeout, no waiting.
- **The graph is links.** There is no definition of a whole process. `heai-flow trace` reconstructs the chain by walking `parent`, child and `waits-on` links.

## Definitions

```yaml
# flows/session.yaml
name: session
states: [queued, running, waiting, exited, clean, violation, blocked, resumable, failed, canceled, lost]
initial: queued
terminal: [clean, violation, failed, canceled, lost]
links:
  actor: { required: true }
  task:  { required: true }
  repo:  { required: true }
  workspace: { required: false }     # learned after the start
  branch:    { required: false }
transitions:
  - { from: queued,    to: running,   on: started }
  - { from: running,   to: waiting,   on: exited,   when: { state: blocked } }
  - { from: running,   to: exited,    on: exited,   when: { exitCode: 0 } }
  - { from: running,   to: failed,    on: exited }
  - { from: running,   to: lost,      on: stale,    after: 10m }
  - { from: waiting,   to: running,   on: answered }
  - { from: waiting,   to: exited,    on: exited,   when: { exitCode: 0 } }
  - { from: waiting,   to: failed,    on: exited }
  - { from: exited,    to: failed,    on: gated,    when: { verdict: error } }
  - { from: exited,    to: blocked,   on: gated,    when: { requested: true } }
  - { from: exited,    to: clean,     on: gated,    when: { verdict: clean } }
  - { from: exited,    to: violation, on: gated }
  - { from: blocked,   to: resumable, on: unblocked, requires: { waits-on: { all: [done] } } }
  - { from: resumable, to: running,   on: started }
  - { from: [queued, running, waiting, blocked, resumable], to: canceled, on: canceled }
hooks:
  queued:    { run: scripts/session/start.sh }
  exited:    { run: scripts/session/finish.sh }
  resumable: { run: scripts/session/start.sh }
  waiting:   { run: scripts/session/ask.sh }
  clean:     { run: scripts/lanes/land.sh }
  lost:      { run: scripts/session/requeue.sh }
```

| key | meaning |
| --- | --- |
| `name` | the definition's name; `heai-flow start <name>` finds it among the files under `flows/` |
| `states`, `initial`, `terminal` | the states, the one a flow starts in, the ones it ends in |
| `links` | the link names a flow of this definition carries, and which are required at `start`; values are opaque strings |
| `transitions` | the legal moves, in order |
| `hooks` | per state, `{ run: <command> }`: the script started when a flow enters that state |

A transition's keys:

| key | meaning |
| --- | --- |
| `from`, `to` | the states; `from: [a, b]` is one transition per source |
| `on` | the event that makes it; `start`, `link` and `touch` are reserved |
| `when` | equality on top-level keys of the event's `data`; among transitions sharing `from` and `on`, the first whose `when` matches wins, in file order |
| `after` | a duration; a flow that has sat in `from` that long, with no touch in between, moves at the next settle, `by: flow` |
| `requires` | `{ waits-on: { all: [<states>] } }`: every flow this one waits on is in one of those states; settle takes it, `by: flow` |
| `by` | who may take it, a list of names; the caller's `--by` must be among them |

`when` does not combine with `after` or `requires`, and `after` does not combine with `requires`.
A definition is validated whenever it is read, every problem at once: every transition names known states, the initial state is not terminal, every non-terminal state has a way out, no terminal state has one, every hook names a state and one command.
`parent` and `waits-on` are flow-to-flow links every definition has and none may declare.
Definitions live one per file under `flows/` in the project directory, and are found by the `name` each declares, not by file name; a file that does not validate, or declares a name another file already took, is listed by `heai-flow definitions` with its problem and refused by name.

## Actions

After every journal line that enters a state, `flow` starts the command the flow's pinned definition names for that state, if any: `/bin/sh -c <run>`, detached, in the project directory, its output to a log file.
A `link` line and a `touch` enter no state.
`check` and `reindex` write no journal line and run nothing.
The start happens after the flow's lock and the settle lock are released, so a script that calls `heai-flow advance` on the same flow never waits.
The command's own shell writes its exit code to a file when it ends; a missing script is exit `127` there, not an error the caller sees.

The environment on top of the process's own:

| variable | value |
| --- | --- |
| `HEAI_FLOW` | the flow's id |
| `HEAI_DEFINITION`, `HEAI_STATE`, `HEAI_EVENT`, `HEAI_SEQ` | the definition, the state entered, the event, the line's seq |
| `HEAI_LINK_<NAME>` | one per link the flow carries; the name upper-cased, non-alphanumerics as `_` |
| `HEAI_LINE` | path of a JSON file holding the journal line, `by`, `data` and `note` included |


## The record

```
flow/
  .gitignore                     `*`
  flows/<id>/
    definition.yaml              pinned copy of what this flow started under; rewritten only by reindex --repin
    journal.jsonl                one transition per line, append-only
    state.json                   { id, definition, state, terminal, since, startedAt, seq, links, parent, waitsOn, touchedAt, expiresAt }
    touch                        the last heartbeat, an ISO timestamp
    actions/<seq>-<state>.json   { seq, state, run, startedAt, pid }
    actions/<seq>-<state>.log    the script's output
    actions/<seq>-<state>.exit   its exit code; absent while it runs
    actions/<seq>-<state>.line.json  what HEAI_LINE names
    lock/                        the per-flow mkdir lock
  by-state/<definition>/<state>/<id>   empty files; regenerated
  by-link/<name>/<value>/<id>          empty files; regenerated
  settle.lock/                   the settle mkdir lock
```

A journal line:

```json
{"seq":3,"at":"2026-09-04T16:59:58.000Z","event":"gated","from":"exited","to":"blocked","by":"finish.sh","data":{"verdict":"clean","requested":true},"note":"filed help-requested-by-beta"}
```

The first line is `seq: 0`, `event: start`, `from: null`, `to: <initial>`, with `links`, `parent` and `waitsOn` in `data`.
A `link` line adds links later, `from` and `to` the same state, `data` carrying only what was new.
`seq` is the version: `advance --seq 3` is refused, exit `1`, if the journal has moved.
[`test/fixtures/journal.jsonl`](test/fixtures/journal.jsonl) is one such journal, byte for byte.

`state.json` is rewritten after every line by write-to-temp-and-rename.
`expiresAt` is when the earliest `after` out of the current state elapses, counted from the later of the last transition and the last touch.
Ids sort by time, `20260909-140750-session-2e49`; `--id` on `start` brings one from elsewhere.
A link value becomes a directory name with letters, digits, `.`, `_` and `-` kept and every other byte written `%XX`.

## Writing

**One writer, the CLI, under the per-flow lock.** `advance` takes `flows/<id>/lock` by `mkdir`, reads the last line, checks the transition against the pinned definition, appends the line, rewrites the snapshot and index entries, releases, then starts the state's script.
A second writer waits up to three seconds for the lock; a lock older than a minute is broken.
A torn last line, from a crash mid-append, is ignored by readers, reported by `check`, and cut before the next append.

A process that cannot run the CLI hands its fact to something that can, such as an event router whose rule runs `heai-flow advance`.

**`by`** on a transition restricts who may take it.
Scripts pass `--by <name>`; a human at the CLI is `human`, the default; the clock and guards are `flow`, and that name is refused from a caller.
It is a written rule and a refused mistake, not a credential.

Nobody else writes.
Every write is beside its target and renamed into place; nothing is `fsync`ed.
`check` and `reindex` are the recovery.

## Settling

Every command but `check` settles first, under `settle.lock`:

1. for every non-terminal flow, take a transition whose `after` has elapsed since the later of the last transition and the last touch;
2. for every non-terminal flow with a `requires` transition, take it if the guard holds, and go round again until nothing more fires;
3. rewrite any snapshot behind its journal, and make the index entries say what the snapshot says.

It is idempotent and reads only files.
`heai-flow settle` runs it alone, for a cron line.
Every state a settle enters starts its script once the lock is released.
Two settlers at once are serialized by the lock; the one that finds it held does nothing.

## The graph

Three link kinds, all recorded on the child:

- **`parent`**: the flow this one was started because of.
- **`waits-on`**: flows whose state a `requires` guard reads.
- **Declared links**: not a flow but a thing, `task=<slug>`, `actor=<name>`, `branch=<ref>`, whatever the definition's `links` names.

`heai-flow trace <id>` walks `parent` upward, children downward and `waits-on` both ways, and prints one timeline across every flow it found, in time order.
`heai-flow trace name=value` starts from everything linked to that value.

```
2026-09-06 19:36:42  20260902-165954-req-9a01   request  in-review → done         land.sh
2026-09-06 19:36:42  20260902-165952-run-132f   run      blocked → resumable      flow           (waits-on all done: 20260902-165954-req-9a01:done)
```

`heai-flow stuck [--older 1h]` lists non-terminal flows with no transition or touch in that long, grouped by definition and state, with what each waits on.

## The CLI

```
heai-flow start <definition> [--id <id>] [--link name=value ...] [--parent <flow>] [--waits-on <flow> ...] [--by <who>] [--note "..."] [--definition <path>]
heai-flow advance <id> <event> [--data '<json>'] [--seq <n>] [--by <who>] [--note "..."]
heai-flow touch <id>
heai-flow link <id> [name=value ...] [--parent <flow>] [--waits-on <flow> ...]
heai-flow show <id> [--json]                    state, links, hooks, the journal, and the actions
heai-flow list [<definition>] [--in <state>] [--link name=value] [--json]
heai-flow trace <id | name=value> [--json]
heai-flow stuck [--older 1h] [--json]
heai-flow settle                                the clock, the guards, the views; then the actions
heai-flow check [--fix]                         definitions, journals, snapshots, indexes; runs no action
heai-flow reindex [--repin]                     rebuild the views; --repin first rewrites every open flow's pinned definition from the file on disk
heai-flow definitions                           every definition under flows/, with its states or its problem
```

`start` prints the new id and nothing else; `--definition <path>` takes a file outside `flows/`.
`advance` and `link` print the line they wrote.
`show --json` prints the snapshot plus the pinned `hooks`, the reader's `problems`, the `journal` and the `actions`; `list --json` prints snapshots.
`reindex --repin` is all or nothing: a flow whose definition is missing from `flows/` or does not validate is exit `2` with nothing written; a definition that no longer has the state a flow is in is exit `1`.
Terminal flows keep their pinned copy.

Common options: `--dir`, the project directory, where scripts run (default: `HEAI_DIR`, else the current directory); `--config`, the configuration (default: `.heai/flow.yaml` when `.heai/` exists under the project directory, else `flow.yaml` in it); `--state`, the state directory (default: `HEAI_FLOW_STATE`, else `flow` beside the configuration).

| exit | meaning |
| --- | --- |
| `0` | done |
| `1` | answered no: an illegal transition, a `--seq` that lost a race, a `by` the definition refuses, a flow that already exists, a lock held past its wait, drift found by `check` |
| `2` | bad usage, an unknown flow or definition, a link the definition does not declare, a definition or configuration that does not validate |

## Configuration: `flow.yaml`

[`schemas/flow.schema.json`](schemas/flow.schema.json) is the formal definition: JSON Schema, draft 2020-12.
A configuration is validated against it when read, every problem at once with its path in the file, exit `2`.
An absent file means the defaults.

```yaml
flows: ./flows                        # the definitions directory; flows/ under the project directory by default
```

A relative `flows` resolves against the file.

## Tests

```sh
npm test
npm run typecheck
```

## Layout

```
tools/flow/
  package.json            @heai-tools/flow, Node 22.18+, two dependencies: yaml, ajv
  schemas/
    flow.schema.json      the formal definition of flow.yaml
  src/
    cli.ts                the commands, and where everything is
    store.ts              the operations the CLI calls; scans the flows directory for definitions
    core.ts               the referee: start, advance, link, touch, repin, each under the flow's lock
    actions.ts            the one script per state entered: the environment, the detached start, the record
    definition.ts         parsing and validation; when, after, requires, by, the from list, hooks
    journal.ts            lines, append, the torn tail, the snapshot, the touch file, the lock
    index.ts              by-state and by-link: update, rebuild, check
    settle.ts             the clock, the guards, the views; the settle lock
    trace.ts              the graph walk, the timeline, stuck
    check.ts              replay every journal; report and rebuild the views
    config.ts             flow.yaml: the schema pass and the flows directory
  test/
    fixtures/definitions/ run, request, landing, and session with its hooks
    fixtures/journal.jsonl  the format contract, pinned
    *.test.ts             one file per module above, plus the CLI
```

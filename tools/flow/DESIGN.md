# flow - design

*Design, 2026-09-04. Written before implementation; the README replaces it once the tool exists.*

Tracks a multi-stage process as a **state machine per record and a graph of records**, for every tool in this repository: a definition says which states exist and which moves between them are legal, a journal records every move that was made, and one command answers what state anything is in, what it waits on, and what is stuck.
`flow` runs nothing and supervises nothing.
It is the ledger the other tools write to and the referee that refuses a move the definition does not allow.

## The problem

Every tool here already tracks a process, and each one has written the same machinery by hand:

| tool | records | states | mechanics |
| --- | --- | --- | --- |
| `agent-host` | run | `queued running succeeded blocked failed canceled lost` | JSON per run, `.exit` sentinel written from inside a container, `queue/<actor>/<id>` empty files, `blocked/<slug>.json`, an atomic `mkdir` lock broken after a minute, a lazy settle on every command |
| `integrator` (design) | landing, checkpoint, promotion, release | `proposed landed refused withdrawn`; `open pass fail`; ... | JSON per record, the same settle, reconciled against git and the host |
| `watcher` (design) | event, action | acted or not, retried | JSONL log, `keys/<sha>` dedupe files, `actions/<event>.<rule>.json` |
| `task-manager` | task | `backlog todo in-progress in-review blocked done canceled` | markdown in the repository, moved by a human or the tracker agent |

Three things are wrong with that, and none of them is that the machinery is bad.

1. **Each tool re-implements the same eight ideas** - a status enum, which transitions are legal, an atomic write, a lock, a settle, a "lost" detector, an id that sorts, a page with columns - and the fourth and fifth tools are about to do it again.
2. **No tool can see the whole process.** A task becomes a run, the run files a request, the request becomes a task, that task becomes a run and a landing, the landing unblocks the first task, which becomes a second run and a second landing, which promotes and releases. That chain is what a human actually wants to see when they ask "where is this?", and today it lives in five directories in four formats with no links between them.
3. **The legal moves are in code, not in a file.** `agent-host` never marks a task `done`; `integrator` may. That rule is real and it is enforced nowhere a reader can find it.

`flow` takes the eight ideas out of the tools and puts the whole process in one place, as files.

## What the survey found

*A survey of file- and SQLite-backed process tracking, done before this design. The findings that shaped it are listed with links so the choices below can be checked against them.*

**Files.**

- [Maildir](https://en.wikipedia.org/wiki/Maildir) is the reference directory-per-state design: write into `tmp/`, `rename` into `new/`, `rename` again into `cur/`; no lock code at all, because rename is the lock. [fsq](https://github.com/rp-pwright/fsq) formalises it into `queue tmp done fail` with retry count and TTL in the filename; [nq](https://github.com/leahneukirchen/nq/blob/master/README.md) orders jobs by a timestamp in the name and serialises them with `flock` on each job's output file; [Filespooler](https://www.complete.org/introduction-to-filespooler/) makes the point that when the state is only files, the transport can be rsync or a USB stick.
- [Snakemake](https://snakemake.readthedocs.io/en/master/tutorial/basics.html) decides what to rerun from output files and mtimes, with an explicit `.done` sentinel for steps without an output; the pattern `agent-host` already uses with `.exit`.
- [systemd timers with `Persistent=true`](https://manpages.debian.org/testing/systemd-cron/systemd.cron.7.en.html) record the last run and fire once on the next boot if runs were missed, and the documentation says a unit must be idempotent because a run may be missed or duplicated. [Kubernetes controllers](https://planetscale.com/blog/the-feedback-loops-behind-kubernetes) state the same rule as level-triggered reconcile: converge from observed state, treat events as a hint to run sooner. This is the justification for a settle on every command.
- The atomic-write recipe is write beside the target, `fsync`, `rename`, then `fsync` the directory ([crash consistency](https://0xkiire.com/crash-consistency-fsync-rename/)); `rename` is atomic only within one filesystem and runtimes fall back to copy-and-delete across mounts ([atomic writes](https://docs.bswen.com/blog/2026-04-04-atomic-file-writing-python/)); and on macOS `fsync` hands data to the drive while `F_FULLFSYNC` is what reaches stable storage ([everything about fsync](https://blog.httrack.com/blog/2013/11/15/everything-you-always-wanted-to-know-about-fsync/), [APFS](https://eclecticlight.co/2022/02/18/how-can-you-trust-a-disk-to-write-data/)), which Node's `fsyncSync` does not issue. [Dan Luu's survey](https://danluu.com/file-consistency/) of filesystem crash bugs concludes that a small tool should keep its durable format dumb.
- An append-only JSONL journal loses at most its last partial line in a crash, where a whole-file rewrite can lose everything; the read side skips a trailing corrupt record ([example](https://github.com/HKUDS/Vibe-Trading/pull/147)).
- `mkdir` is an atomic create-and-test but leaves a stale lock after a kill; `flock` is released by the kernel on process death ([BashFAQ 045](https://mywiki.wooledge.org/BashFAQ/045)). Checking a lock's PID is unreliable after a reboot or a container restart, since PIDs are reused ([an example](https://github.com/withastro/astro/pull/17671)).

**SQLite.**

- A writing transaction must start with `BEGIN IMMEDIATE`: a deferred transaction that upgrades from read to write mid-way gets `SQLITE_BUSY` without consulting the busy handler, so `busy_timeout` does not help ([berthub](https://berthub.eu/articles/posts/a-brief-post-on-sqlite3-database-locked-despite-timeout/), [activesphere](http://activesphere.com/blog/2018/12/24/understanding-sqlite-busy)). [WAL mode](https://www.sqlite.org/wal.html) lets readers not block the one writer, and needs real shared memory, not a network filesystem.
- Claiming work is one statement, `UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING` ([RETURNING](https://sqlite.org/lang_returning.html), [a worked example](https://dev.to/d_security/why-i-built-a-job-queue-with-sqlite-instead-of-redis-and-what-i-learned-4f05)). [goqite](https://github.com/maragudk/goqite) is the smallest good schema: one table, visibility timeout, extendable leases; [litequeue](https://github.com/litements/litequeue) records `in_time`, `lock_time`, `done_time` per message so timing comes from the same table.
- [How to corrupt an SQLite database](https://www.sqlite.org/howtocorrupt.html) lists the hazards a CLI suite meets: copying the file mid-transaction, separating it from its WAL, and locking that silently does not work on network and some mounted filesystems.
- [`node:sqlite`](https://nodejs.org/api/sqlite.html) has shipped a synchronous `DatabaseSync` since Node 22.5 with no install; it is the younger option next to [better-sqlite3](https://github.com/WiseLibs/better-sqlite3/discussions/1245), and close to it in [benchmarks](https://sqg.dev/blog/sqlite-driver-benchmark/). One report puts the practical ceiling around a thousand durable step writes a second on one node, and argues one leaves SQLite for architecture, never for throughput ([durable LLM workflows on SQLite](https://www.pedroalonso.net/blog/durable-llm-workflows-sqlite/)).

**Engines, for ideas.**

- [Gunnar Morling's durable execution engine on SQLite](https://www.morling.dev/blog/building-durable-execution-engine-with-sqlite/) is the clearest minimal schema: one `execution_log` table keyed `(flowId, step)` with a status, parameters, return value and attempts; replay returns a completed step's value instead of rerunning it. He names the irreducible race: a crash after the side effect and before the log write repeats the step.
- [DBOS Transact](https://docs.dbos.dev/typescript/reference/workflows-steps), [Inngest](https://www.inngest.com/blog/how-durable-workflow-engines-work), [Restate](https://docs.restate.dev/foundations/key-concepts) and [Reflow](https://danfry1.github.io/reflow-ts/) are the same idea at different sizes: a workflow engine is a memoisation engine over named steps, with a lease so a stalled run is reclaimed. The price is [determinism](https://jack-vanlightly.com/blog/2025/11/24/demystifying-determinism-in-durable-execution): replay works only if the code emits the same steps in the same order. [Windmill](https://www.windmill.dev/blog/launch-week-1/fastest-workflow-engine) states the principle at the other end: every state transition is one transacted statement, the row is the state, workers hold nothing.
- [XState v5 persistence](https://stately.ai/docs/persistence) makes a machine's whole state one JSON snapshot that restores with `createActor(machine, { snapshot })`. [Event sourcing](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing) keeps the events as the record and the current state as a projection that can always be rebuilt.

**Graph or state machine.**

- A step graph advances when the previous step finishes; a state machine advances when an event arrives from outside ([workflow engine vs state machine](https://workflowengine.io/blog/workflow-engine-vs-state-machine/)). Durable execution is the graph done implicitly, the call order being the graph ([Inngest](https://www.inngest.com/docs/learn/how-functions-are-executed)); it wins when the interesting property is "do not redo work", and a machine wins when it is "which moves are legal". The common shape is both: a machine per entity, a step graph inside its running state ([Windmill](https://github.com/windmill-labs/windmill)).
- One explicit state field beats a pile of booleans, because it makes invalid combinations unrepresentable ([designing with types](https://fsharpforfunandprofit.com/posts/designing-with-types-representing-states/)). [Statecharts](https://statecharts.dev/what-is-a-statechart.html) add hierarchy and guards to stop [state explosion](https://statecharts.dev/state-machine-state-explosion.html), and add no expressive power over a flat machine, only less duplication, so they pay off once duplication actually appears ([hierarchical state machines](https://retis.santannapisa.it/~marco/files/lesson8-hierarchical_state_machines.pdf)).

**Concurrency and crash safety.**

- A transition is a compare-and-swap on a version or on the expected state, and zero rows affected is the conflict signal, not an error ([optimistic concurrency](https://alexanderobregon.substack.com/p/optimistic-concurrency-with-sql-version)).
- Leases beat locks for crashed workers ([visibility timeouts](https://oneuptime.com/blog/post/2026-07-22-sqs-visibility-timeouts-concurrent-processing/view)); a heartbeat plus a reaper finds lost work in minutes rather than after the longest possible runtime ([Delayed Job](https://www.salsify.com/blog/engineering/detect-failed-delayed-job-workers), [when the handler outlives the lease](https://www.planetgeek.ch/2026/06/29/when-the-handler-outlives-the-lease/)); and a [fencing token](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) checked on every write stops a writer that lost its lease while suspended.
- Record intent before the effect and completion with it, or carry an idempotency key, so a retry after a crash is effectively once ([idempotency in practice](https://www.alekseialeinikov.com/en/blog/topics/architecture/idempotency-in-practice-api-retries-2026)); the journal may log every attempt as long as the transition applied twice changes nothing ([idempotency patterns](https://dev.to/aloknecessary/idempotency-in-distributed-systems-design-patterns-beyond-retry-safely-k66), [reconcile loops](https://oneuptime.com/blog/post/2026-02-09-operator-reconciliation-loop/view)).

**What this design takes:** a state field per record with an append-only journal as the record and the state as a projection; directory-per-state as a regenerated index; a Maildir-style inbox so an edge writer needs only `rename`; leases as `after` with a heartbeat, so "lost" is data, not a PID check; compare-and-swap by journal sequence as the fencing token; a level-triggered, idempotent settle; flat machines with guards and no hierarchy; SQLite only as a derived index, opened only by this tool, never on a mount.
**What it declines:** replay-based durable execution and its determinism contract, a queue or claim primitive (a tool's queue is its own ordering, as `agent-host`'s is), and a process that runs steps.

## The shape of it

```
definition (yaml) ──► flow start ──► flows/<id>/journal.jsonl  (append-only, the truth)
                                          │
  a tool: flow advance <id> <event> ──────┤  each line: one transition, refused if illegal
  a container or CI: drops a fact file ───┤  inbox/<event>, folded in at settle
  the clock: a state's `after` elapsed ───┤  settle makes the move
  a linked flow reaching a state ─────────┘  a guard is satisfied; settle makes the move
                                          │
                              by-state/<definition>/<state>/<id>   regenerated, ls-able
                              flows/<id>/state.json                regenerated snapshot
                                          │
                        CLI, page and API read the same files; `flow trace` walks the links
```

- **A definition is a flat state machine in a YAML file.** States, one initial, some terminal, and transitions each with a `from`, a `to` and the `on` event that makes it. A transition may also say who may make it, what must be true first, and how long a state may last. Each tool ships its own definitions; a flow keeps a pinned copy of the one it started under.
- **A flow is one record moving through one definition.** It has an id that sorts by time, links to the things it is about (a task slug, a run id, a branch) and to other flows (its parent, what it waits on), and a journal of every transition.
- **The journal is the truth.** `state.json` and `by-state/` are regenerated views, rebuilt by `flow reindex`, checked by `flow check`. A flow's current state is the `to` of its last journal line; nothing else is remembered.
- **Moves come from four places, all of them recorded the same way.** A tool calls `flow advance`. A process with no CLI - an agent inside a container, a CI job - writes a fact file into the flow's `inbox/`. The clock expires a state. A linked flow reaches a state a guard was waiting for. The first is immediate; the other three happen at settle, which every command runs first, as in `agent-host`.
- **The graph is links, not a bigger machine.** There is no definition of "the whole process". Each tool's records stay small flat machines, and `flow trace` reconstructs the chain by walking `parent`, `child` and `waits-on` links across definitions.

Why a state machine per record and not a step graph per run: the durable-execution engines the survey looked at memoize *steps of code* so a crashed program can resume; that is the right tool when one program owns the process end to end.
Here no program does. A run is started by `agent-host`, finished by a container, checked by `scope-gate`, landed by `integrator`, and unblocked by whichever tool looks next.
What is shared is not code but *facts about state*, and a state machine with named events is the smallest thing that records those facts and refuses the ones that make no sense.
The graph shape comes back through links, which is enough to answer "what waits on what" without any tool owning the chain.
Where a tool does run several steps inside one state - `integrator`'s checks inside a checkpoint - those steps are that tool's files, `<check>.log` and `<check>.exit`, which is the memoised-step pattern already; if a second tool ever needs the same thing, named steps under a state are the natural second version of this tool, and not the first.

Why not a workflow engine: principle 6. A process that runs steps has to be up for steps to run, and loses them when it dies.
`flow` records what other things did and what the clock says; it never does the step.

## Definitions

```yaml
# tools/agent-host/flows/run.yaml
name: run
states: [queued, running, succeeded, blocked, failed, canceled, lost]
initial: queued
terminal: [succeeded, blocked, failed, canceled, lost]
links:
  task: { required: false }          # a tracker slug
  actor: { required: true }          # a map actor name
transitions:
  - { from: queued,  to: running,   on: started }
  - { from: queued,  to: canceled,  on: canceled }
  - { from: running, to: succeeded, on: exited, when: { exitCode: 0, requests: 0 } }
  - { from: running, to: blocked,   on: exited, when: { exitCode: 0 } }
  - { from: running, to: failed,    on: exited }
  - { from: running, to: canceled,  on: canceled }
  - { from: running, to: lost,      on: stale, after: 10m }
```

- **`on`** names the event. Several transitions may share an event from one state; the first whose `when` matches the event's data wins, in file order, so `exited` with `exitCode: 0` and no requests is `succeeded`, with requests is `blocked`, otherwise `failed`. `when` is equality on top-level keys of the event's `data`, nothing more; a rule that needs judgement belongs in the tool that has it.
- **`after`** makes a transition the clock can take: a flow that has sat in `from` for that long, with no `touch` in between, moves at the next settle. It is a lease with a heartbeat, the shape every queue in the survey converged on, and it is how `lost` stops being a special case in every tool: whether work is lost becomes a question the files answer, not a PID check. `flow touch <id>` is the heartbeat; the runner wrapper `agent-host` already ships can touch every minute for free.
- **`requires`** makes a transition a guard can take: `requires: { waits-on: { all: [landed, done] } }` says every flow this one waits on is in one of those states. Settle fires it, with `by: flow`. It is how "unblock when every blocker has landed" stops being a loop in `agent-host`.
- **`by`** restricts who may take a transition: `by: [integrator]` on the tracker's `in-review → done` would make "only the tool that knows what landed marks it done" a rule in a file. Tools pass `--by <name>`; a human at the CLI is `human`; a fact file is `inbox`; the clock and guards are `flow`. It is a discipline, not security - anyone can pass any name - and it exists so the rule is written down and a mistake is refused, which is what the map's ownership rules are for too.
- **`links`** declares which link names a flow of this definition carries and which are required at `start`. Link *values* are opaque strings; `flow` never resolves a task slug or a run id, it only records and searches them.

A definition is validated when a flow starts under it: every transition names known states, `initial` is reachable to something, every non-terminal state has at least one way out or an `after`, and no terminal state has one. `flow definitions` lists the ones registered in `flow.yaml` beside the map; `flow start run` finds `run` there, and `--definition <path>` bypasses the registry, which is how a tool uses its own file without the human registering anything.

Hierarchy, parallel regions and history states - the statechart features - are left out on purpose. Every machine the tools have is flat and under ten states; where something looks nested, it is a child flow with its own definition, which `trace` shows nested anyway.

## The record

```
flow/
  .gitignore                     `*`
  flows/<id>/
    definition.yaml              pinned copy of what this flow started under
    journal.jsonl                one transition per line, append-only
    state.json                   { state, since, seq, links, waitsOn, touchedAt, expiresAt }  regenerated
    inbox/                       fact files dropped by things without a CLI; emptied at settle
    rejected/                    inbox files that were not a legal move, with a .reason beside each
    lock/                        the per-flow mkdir lock, present only while a writer holds it
  by-state/<definition>/<state>/<id>   empty files; regenerated
  by-link/<name>/<value>/<id>          empty files; regenerated; `ls by-link/task/cache-the-index`
  settle.lock/                   the settle mkdir lock, as agent-host's
```

A journal line:

```json
{"seq": 3, "at": "2026-09-04T16:59:54Z", "event": "exited", "from": "running", "to": "blocked", "by": "agent-host", "data": {"exitCode": 0, "requests": 1}, "note": "filed help-requested-by-beta"}
```

The first line is `seq: 0`, `event: start`, `from: null`, `to: <initial>`, with `links` in `data`. Links can be added later (`event: link`, no state change) so a run can learn its branch after it starts. `seq` is the version: `advance --seq 3` is a compare-and-swap that is refused, exit `1`, if the journal has moved, so a settler that read a stale state cannot make a stale move.

`state.json` is rewritten after every journal line by write-to-temp-and-rename, the way `agent-host` writes a run record, and it carries the `seq` it was derived from. `flow check` re-derives every snapshot and the two indexes from the journals and reports drift; `flow reindex` rebuilds them. A missing or torn snapshot is never an error, only a rebuild.

Ids sort by time - `20260904-165952-run-132f` - so `ls flows/` is the history and no index is needed for order. A tool may bring its own id with `--id` when it already has one; `agent-host` would, so the run id and the flow id are one string.

## Writing, and who may write

Two writers, deliberately, and only two.

**The CLI, under the per-flow lock.** `flow advance` takes `flows/<id>/lock` by `mkdir`, reads the last line, checks the transition against the definition, appends the line, rewrites the snapshot and the two index entries, and releases. The lock is `mkdir` rather than `flock` because Node has no `flock` without a native dependency, and the critical section is milliseconds long; a lock older than a minute belongs to a crashed writer and is broken, as in `agent-host`, and its PID is never consulted, since a PID proves nothing after a restart. The append is one `write` of one line to a file opened for append, which the lock makes serial; a reader that finds a torn last line - a crash mid-append - ignores it, `check` reports it, and the next append starts after the last newline, so a torn line costs one transition, which the writer that lost it sees as a refused `--seq` and makes again.

**Fact files, into `inbox/`, by anything that can create a file.** The name is the event, an optional suffix after a dot keeps two facts apart, and an optional JSON body is the event's data: `inbox/exited` with `{"exitCode": 0, "requests": 1}`, `inbox/touch.1`, `inbox/touch.2`. The writer writes the file under a `.tmp` name and renames it, Maildir's rule, and settle ignores `.tmp`; that is the whole protocol - no lock, no CLI, no Node - which is what an agent in a container, a CI job with a mounted volume, or a shell hook can manage. Settle takes the lock, folds the inbox in name order into transitions with `by: inbox`, and moves an illegal one to `rejected/` with a reason rather than dropping it, since a fact something thought it recorded and did not is worse than a refused one. The inbox is the generalisation of `agent-host`'s `.exit`, `.pid` and `.canceled` sentinels, and the reason the tool does not need SQLite at the edge: a fact file needs no database driver, no page locks, and no shared library, and it works through a bind mount, where SQLite's own documentation says a database file must not be trusted.

**What "durable" means here.** Every write is beside its target and renamed into place, and the whole state directory sits under one root, so a rename never crosses a filesystem. Nothing is `fsync`ed: the record is safe against a process dying, which is the failure that happens, and not against power loss, which on macOS would need `F_FULLFSYNC` that Node does not expose and which no other tool here attempts. That is a stated assumption, not an accident, and `check` plus `reindex` are the recovery when it is wrong.

Nobody else writes. A tool that wants to know a flow's state reads `state.json`, or asks the CLI, or lists an index directory; it never appends to a journal it did not open through `flow`. That is the format contract this tool states for its siblings, pinned by a fixture.

## Settling

Every command settles first, as `agent-host` does, under `settle.lock`:

1. fold every flow's `inbox/` into its journal;
2. for every non-terminal flow, if a transition out of its state has an `after` that has elapsed since the later of the last transition and the last touch, take it, `by: flow`;
3. for every non-terminal flow with `requires`, if the guard now holds, take it, `by: flow`;
4. rebuild any snapshot or index entry whose `seq` is behind its journal.

It is idempotent, it reads only files, and `flow settle` runs it on its own for a cron or a hook. `flow serve` runs it on an interval, so a page stays live and a stale run becomes `lost` while nobody is typing.

What settle does not do is ask the outside world anything. Whether a container is up, a pull request merged, a branch moved, is each tool's business, and each tool's own settle reports the answer as an `advance`. `flow` knows the clock and the files, and no plugin, which is what keeps it the same size for every tool that uses it.

## The graph

Three link kinds between flows, all recorded on the child:

- **`parent`** - the flow this one was started because of: a request flow's parent is the run that filed it; a landing's parent is the run it lands.
- **`waits-on`** - flows whose state a `requires` guard reads: a blocked run waits on the tasks it requested.
- **`about`** - not a flow but a thing: `task=<slug>`, `actor=<name>`, `branch=<ref>`, `lane=<name>`. Declared by the definition's `links`.

`flow trace <id>` walks `parent` upward and children downward, and prints one timeline across every flow it found, in time order, each line naming its flow and definition. `flow trace task=<slug>` starts from everything about that task. That is the "where is this?" answer, and it exists without any definition describing the chain: the chain is whatever the tools recorded.

`flow stuck [--older 1h]` lists non-terminal flows with no transition or touch in that long, grouped by definition and state, and for each what it waits on and where that stands. It is the one report every tool would otherwise write for itself.

## Files, or SQLite

Both were considered; the survey has the evidence.

Files won for the record because of three facts about this repository. The writers at the edge are inside containers and CI jobs on mounted volumes, where SQLite's locking is not safe and a fact file is. The state directory is gitignored machine state that a human reads with `ls` and `cat` when something is wrong, and a directory per state is a report in itself. And principle 4 names JSON and JSON lines as the formats, which every tool here already reads with nothing installed.

SQLite is kept for one job, later: **an index over many flows**. When `by-state/` and `by-link/` stop being enough - a page that sorts thousands of flows by several fields, a query across definitions - `flow index` builds `index.sqlite` from the journals with `node:sqlite`, no dependency, and the page reads it. It is derived, it is deleted by `flow reindex`, no tool other than `flow` opens it, and no writer at the edge ever sees it. That is the same line ECC's vault draws - files as truth, SQLite as an index - and it means the first version ships with no database and nothing has to change when one is added.

## The CLI

```
flow start <definition> [--id <id>] [--link name=value ...] [--parent <flow>] [--by <who>] [--note ...]
flow advance <id> <event> [--data '<json>'] [--seq <n>] [--by <who>] [--note ...]
flow touch <id>
flow link <id> name=value | --parent <flow> | --waits-on <flow>
flow show <id> [--json]                    state, links, journal
flow list [<definition>] [--state s] [--link name=value] [--json]
flow trace <id | name=value> [--json]
flow stuck [--older 1h] [--json]
flow settle
flow check [--fix]                         definitions, journals, snapshots, indexes
flow reindex
flow definitions | flow define <path>     the registry in flow.yaml
flow serve [--port 4848]
```

Common options and defaults follow the other tools: `--map`, `--state` (`flow` beside the map, `.heai/flow/` under `.heai`), `--config` (`flow.yaml` beside the map). Exit codes: `0` done; `1` answered no - an illegal transition, a `--seq` that lost a race, a `by` the definition refuses, a `check` that found drift; `2` bad usage, an unknown flow or definition, a definition that does not validate. `advance` prints the line it wrote, so a script that wants the new state reads it there.

## The page, and the API

`flow serve` is the same functions behind HTTP, in the palette and server conventions of `task-manager`: a board per definition with a column per state and a card per flow, a trace view, and the stuck list. It holds nothing the files do not hold and adds a settle loop.

| method and path | what it does |
| --- | --- |
| `GET /api/definitions` | the registered definitions |
| `GET /api/flows?definition=&state=&link=` | flows, newest first |
| `GET /api/flows/<id>` | state, links and journal |
| `POST /api/flows` | `flow start`; `201` |
| `POST /api/flows/<id>/advance` | `{event, data, seq, by, note}`; `200` with the line, `409` on a refused move or a lost race |
| `POST /api/flows/<id>/touch` | heartbeat |
| `GET /api/trace/<id>` | the cross-flow timeline |
| `GET /api/stuck?older=1h` | the stuck report |
| `GET /api/events` | server-sent events: journal lines as they land |

## How each tool adopts it

A tool shells out to `flow`, as it does to `scope-gate` and `task-manager`, and keeps its own record for its own payload.

- **`agent-host`.** `assign` becomes `flow start run --id <run> --link task= --link actor=`; the wrapper's `.exit` becomes `inbox/exited` with the exit code, `.pid` stays a file the wrapper writes for `cancel`, and a minute-by-minute `inbox/touch` makes `lost` the definition's `after`. Filing a request is `flow start request --parent <run>` and `flow link <run> --waits-on <request>`; unblocking is a `requires` guard the definition carries. `run.json` keeps the prompt, the gate verdict and the changed files - the payload nobody else needs a machine for - and its `status` field becomes a mirror of the flow's state, written in the same operation, with `flow` authoritative when they disagree. The queue stays `agent-host`'s: it is an actor's ordering of its own work, not a state.
- **`integrator`.** Landing, checkpoint, promotion and release are four definitions; a landing's parent is a run, a promotion's parent is a checkpoint, a release links `lane=` and `version=`. The tracker moves it makes stay tracker writes; the flow is where `proposed` and `landed` live.
- **`watcher`.** An action is a flow of definition `action` with `started`, `done` and `failed`, `parent`-less, linked `event=<id>` and `rule=<name>`; `retry` starts another linked to the same event. The event log stays the watcher's, since an event is a fact, not a process.
- **`task-manager`.** Nothing, in the first version. A task's state is committed markdown moved by people, and the tracker's own validation is the referee there. What `flow` adds is the view: `trace task=<slug>` shows the runs and landings around a task without the tracker knowing any of them exist. Whether the tracker should later check a move against a `task` definition with `by` rules is an open question below.

A tool that has not adopted it loses nothing: `flow` is invisible to a tool that never calls it.

## A walkthrough

The `Working together` story from `agent-host`, as `flow` records it:

```sh
$ flow trace task=t2
20260902-165952-run-132f   run      queued → running          agent-host   actor=beta task=t2
20260902-165954-run-132f   run      running → blocked         inbox        exitCode=0 requests=1
20260902-165954-req-9a01   request  start → todo              agent-host   parent=…run-132f task=help-requested-by-beta
20260902-171003-run-a7c2   run      queued → running          agent-host   actor=alpha task=help-requested-by-beta
20260902-171230-run-a7c2   run      running → succeeded       inbox        exitCode=0 requests=0
20260902-171230-land-04e8  landing  proposed → landed         integrator   parent=…run-a7c2 lane=core
20260902-171231-req-9a01   request  todo → done               integrator
20260902-171231-run-132f   run      blocked → resumable       flow         waits-on all done
```

The last line is a guard firing: no tool wrote it, and the next `agent-host status` sees a run ready to resume because `flow list run --state resumable` says so.

## What v1 deliberately leaves out

- **Running anything.** No steps, no retries, no scheduler, no plugins. Principle 6.
- **Memoised steps and replay.** The durable-execution engines resume a program at its next uncompleted step; that needs one program to own the process and to be deterministic, and neither holds here.
- **Power-loss durability.** Safe against a process dying, not against the machine losing power; see "what durable means".
- **Hierarchical states, parallel regions, history.** Child flows and links cover what the tools need.
- **Asking the world.** Whether a container or a pull request is alive is each tool's reconcile, reported as an `advance`.
- **SQLite.** Kept as a derived index for when the directory indexes are not enough, with `node:sqlite`, and not before.
- **Authorization.** `by` is a written rule and a refused mistake, not a credential.
- **Payload.** A journal line's `data` is what a `when` needs to read; the prompt, the log, the gate findings stay in the tool that made them.

## Open questions

1. **Whether a tool's own `status` field should survive.** Mirroring it is convenient for readers that predate `flow` - `integrator` reads `run.status` as a candidate filter - and it is a second place the state lives. The alternative is that a tool's record carries no state at all and readers ask `flow`, which is cleaner and a breaking change for every reader. The design mirrors, with `flow` authoritative, and `flow check --mirror <dir>` could report drift if it proves to matter.
2. **Whether the tracker should be a definition.** A `task` definition with `by: [integrator]` on `in-review → done` would write down the rule that today lives in prose, and `task-manager set` could ask `flow` before it moves a task. It would also make the tracker's committed markdown depend on gitignored state, which is the wrong direction. The design says no for now and keeps the tracker as a thing flows are `about`.
3. **Where a fact file's data comes from when the writer is a shell.** `echo '{"exitCode":'$?'}' > inbox/exited` is the whole protocol, and it is the one place a malformed JSON can enter; the design treats a body that does not parse as `{}` with a note, since `exited` with no code is still `failed` under the `run` definition, which is the safe reading.
4. **The name.** `flow` is short and says what it tracks; `stage` and `ledger` were the alternatives.

## Layout

```
tools/flow/
  DESIGN.md
  package.json            @heai-tools/flow, Node 22.18+, one dependency: yaml
  flows/                  no definitions of its own; the tools ship theirs
  src/
    cli.ts
    config.ts             flow.yaml: the definition registry
    definition.ts         parsing and validation; when, after, requires, by
    journal.ts            append, read, seq, the per-flow lock, the snapshot
    index.ts              by-state and by-link, rebuild, check
    inbox.ts              fact files → transitions
    settle.ts             inbox, clock, guards, rebuild; the settle lock
    trace.ts              links, the timeline, stuck
    server.ts             the page and the API
  test/
    definition.test.ts    validation, first-match `when`, `after`, `requires`, `by`
    journal.test.ts       append, CAS by seq, lock and stale lock, snapshot rebuild
    inbox.test.ts         name order, bodies, rejected with reason, malformed body
    settle.test.ts        clock moves, guard moves, idempotence, two settlers
    trace.test.ts         a run → request → run → landing chain; stuck
    cli.test.ts           exit codes; the journal fixture other tools read
    fixtures/journal.jsonl   the format contract, pinned
```

Implementation order: `definition.ts` and `journal.ts` with `start`, `advance` and `show`, which makes a tool able to record a process; then `inbox.ts` and `settle.ts` with `after`, which replaces `.exit` and `lost`; then links, `requires`, `trace` and `stuck`, which replaces `blocked/` and unblocking; then `check` and `reindex`; then the page; then `agent-host` adopting it, as the first proof, against its existing tests.

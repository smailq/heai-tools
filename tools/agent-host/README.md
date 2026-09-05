# @heai-tools/agent-host

Hosts the architecture map's llm-agent actors: one Apple container per actor, a CLI that starts them and hands them tracker tasks, a web page showing which actors are running and what each is doing, and a JSON API so other tools can do the same.

```sh
npm install
node src/cli.ts build-image claude       # once per machine: heai/agent-claude
node src/cli.ts up toolsmith             # one container per llm-agent in the map
node src/cli.ts assign toolsmith --task scope-gate-heai-discovery --wait
node src/cli.ts serve                    # http://localhost:4747
```

Requires Node 22.18 or newer, which runs the TypeScript sources directly, macOS 26 with Apple's [`container`](https://github.com/apple/container) CLI, and its service running (`container system start`).
`npm install` pulls one runtime dependency, a YAML parser.

The map already says everything an agent needs except a place to run.
It names each llm-agent, carries its `context`, lists the territories it owns and their contexts, and leaves one thing to "the surrounding tooling": which actor a change is made on behalf of.
`agent-host` is that surrounding tooling.
It starts a sandbox per actor, tells the sandbox who it is, composes the actor's steering from the map, runs the task, and checks the result against the map with `scope-gate` before a human looks at it.

## The shape of it

```
architecture.yaml ──► actors of type llm-agent ──► one container each
                                                       │
  tracker (task-manager) ──► a task slug ──► a run ────┤ container exec, detached
                                                       │
                              .heai/agent-host/runs/ ◄─┘ the run writes its own record
                                       │
                          CLI and server both read and write here
                                       │
                       a ref in the source + a scope-gate verdict
```

- **An actor is a container.** `heai-<actor>`, labelled with the actor's name and the map's hash, created from a known image with a checkout of the repository mounted at `/work` and `HEAI_ACTOR=<actor>` in its environment.
  It stays up between tasks, holding installed dependencies and a warm harness, the way a person keeps a workstation.
- **A task is a run.** Assigning work executes the image's runner inside the actor's container, detached, with a prompt composed from the map and the task.
  A run has a stable id, a log, a ref in the source, and an outcome, and all of them are files.
- **The files are the record; the CLI and the server are two readers of it.** Neither process supervises a run.
  The run writes its own log and exit code into a directory mounted from the host, and whichever process looks next - a CLI command, a page request - finishes the bookkeeping.
  The CLI works with no server running; the server adds a page and an API over the same functions and the same files.

Why one container *per actor* rather than per task: the actor is the map's unit of identity and confinement, the thing `scope-gate --actor` checks and the name a commit is attributed to.
A container per actor makes "which actors are running" a real question with a real answer, keeps each actor's environment warm across tasks, and serializes an actor's work the way one person works one task at a time.
The cost is that one actor cannot run two tasks at once.

Why no supervisor: a process that owns the runs is a process the CLI must talk to and that loses the runs when it dies.
Running the agent detached and having it write its own outcome to a mounted directory makes a run survive the CLI exiting, the server restarting, and the page being closed, and makes every command a pure function of what is on disk plus what `container list` says.

## Why Apple containers

`container` runs each container as its own lightweight Linux VM, which is a harder boundary than a process sandbox and lighter than a full VM.
An agent granted a checkout and an API key inside one can do anything it wants *in there* and nothing on the host beyond the two mounts it was given.
That is the whole point: the map confines an agent's edits by rule, and the container confines everything else by construction.

The tool uses a small slice of the CLI, and nothing else:

| operation | command |
| --- | --- |
| create and start an actor | `container run -d --name heai-<actor> --label heai.actor=<actor> --label heai.map=<hash> -v <checkout>:/work -v <state>/runs:/heai/runs -e HEAI_ACTOR=<actor> [--env-file <env>] [--cpus n --memory m] <image> sleep infinity` |
| what is running | `container list --all --format json`, read for id, state, image and labels |
| run a task | `container exec -d -w /work -e HEAI_RUN=<id> -e HEAI_TASK=<slug> heai-<actor> sh -c '<wrapper>'` |
| cancel a run | `container exec heai-<actor> kill <pid>`, the pid the wrapper recorded |
| stop an actor | `container stop heai-<actor>` then `container delete heai-<actor>` |
| build an image | `container build -t heai/agent-<name> -f image/<name>/Containerfile image/<name>` |

The CLI is young and its JSON is undocumented, so the parser reads only the four fields named above, and `test/fixtures/container-list.json` is real output checked in so a format change fails a test rather than a page.
Every command that needs the service checks once and exits 2 with the `container system start` hint rather than failing partway.

The wrapper is one line of `sh` the host composes: start `/heai/run` in the background with `<id>.prompt` on stdin and stdout and stderr appended to `<id>.log`, record its pid to `<id>.pid`, `wait` on it, and write the exit status to `<id>.exit`.
Those four files, in the mounted `runs/` directory, are the whole protocol between a run and whoever reads it; `wait` is what turns a cancel signal into an exit code, so a canceled run still writes its own ending.

## The image and the runner contract

The tool is harness-agnostic on purpose: which agent runs inside the container is the image's business, and the host knows nothing about it.
An image is usable by `agent-host` when it provides one executable, **`/heai/run`**:

- it reads the prompt on stdin, as plain text;
- it works in the current directory, `/work`, which is the actor's checkout on the ref the source prepared;
- it writes whatever it likes to stdout and stderr, which the host appends to the log verbatim and never parses;
- it exits `0` when it finished the task and non-zero when it did not;
- it receives `HEAI_ACTOR`, `HEAI_RUN`, and `HEAI_TASK` (empty for a free-form prompt) in the environment, and whatever the env file carried.

That is the whole contract, and each clause is chosen so that no harness leaks through it.
The prompt is text because every harness takes text.
The output is unparsed because every harness formats it differently, and the two things the host actually judges a run by - the exit code and the git diff - are the same whatever produced them.
Cancellation is a signal to the process, so no second entry point is needed.
Credentials are the image's business too: the env file is handed to `container run` unread, so an image that needs `ANTHROPIC_API_KEY` and one that needs `OPENAI_API_KEY` differ only in what the file says, and a per-actor `envFile` in the configuration pairs each image with its own.

Three images ship under [`image/`](image), each a `Containerfile` and a `run`:

| image | harness | runner |
| --- | --- | --- |
| `claude` | Claude Code | `exec claude -p "$(cat)" --dangerously-skip-permissions --output-format text` |
| `codex` | OpenAI Codex CLI | `exec codex exec --dangerously-bypass-approvals-and-sandbox "$(cat)"` |
| `echo` | none - a shell script | reads the prompt, writes a note into the actor's first territory, commits; or files a request when the prompt says `please request <territory>` |

Permission prompts are off in the first two because the container *is* the permission boundary: the agent may do anything inside it and nothing outside the two mounts.
The exact flags are each CLI's and are checked against the installed version when the image is built, not by the host.
`echo` is no LLM at all: it proves the contract end to end in seconds, and is what the walkthrough below runs.
A fourth harness is a fourth directory with the same two files; `build-image <name>` builds any of them as `heai/agent-<name>`, and `agent-host.yaml` says which actor runs which and what each image runs with.

The agent's own instructions files - `CLAUDE.md`, `AGENTS.md` - are the repository's, present in `/work` like any other file; the host neither writes nor reads them.

## What an actor is told

The prompt is composed from the map and the task, in this order, so that the standing guidance frames the work rather than trailing it:

1. The actor's own `context`.
2. Each territory the actor owns: its name, its globs, and its context layered outermost-ancestor-first, exactly as [`docs/architecture-map.md`](../../docs/architecture-map.md) says contexts compose.
   Then each territory the actor `watches` without owning, marked observed-not-owned and naming its owner, with the same context chain: a maintainer sees what it monitors and is told to file requests about it, never change it.
3. The task: for a tracker slug, the title and the full body; for a free-form prompt, the prompt.
4. When a blocked task resumes, a pointer to the previous run: its id, what it requested, and its final message.
5. The standing rules of the host: you are `HEAI_ACTOR`; change only paths inside the territories above; the source plugin's own rule for recording work (under git: commit on the branch you are on); never edit the tracker; and when the task needs work outside your territories, write a request for it and finish blocked.

The first two parts are what the map promises an llm-agent receives.
Putting them in the prompt rather than in a generated agent file means this tool needs nothing generated ahead of time, and stays correct the moment the map changes.
`test/prompt.test.ts` pins the order.

## The source plugin, and the gate

The map says a repository is a named, path-addressable tree and assumes no version-control system, and neither does the host.
Everything about *the code* - a checkout per actor, the ref a run works on, putting the checkout on it before a run and bringing the work home after, and the list of paths the run changed - is a **source plugin**, named by `source` in the configuration.
The host itself never runs git.

A source answers six questions, and [`src/source.ts`](src/source.ts) is the contract:

| method | what the host needs |
| --- | --- |
| `refFor(actor, slug)` | the name of the ref a run for that task works on, stable so a resumed task finds its own |
| `prepare(actor)` | the actor's checkout, created if missing; it is mounted at `/work` |
| `env(actor)` | environment for the container, so what the agent records is attributed to the actor |
| `rules(run)` | the lines of the prompt's "How to work" that say how to record work under this source |
| `begin(run)` | put the checkout on the run's ref, from the base - or back on it when the run resumes; null when ready, else why not |
| `finish(run)` | bring the work home, and return the changed paths, the paths left unrecorded, and any problem |

`changed` is what the gate judges: the host pipes it through `scope-gate --actor <actor>` and keeps the verdict - clean, violation, or error - and scope-gate's own findings whole on the run.
A run whose gate says *violation* is not a failed run - the agent may have finished the task - but it is one the page marks so that a boundary crossing is seen before it is reviewed.
The host never merges or lands anything: `finish` leaves the work where a human can review it, with the gate's findings as the first line of the review.

Two sources are built in:

**`git`**, the default.
Each actor gets its own clone of the repository at `<state>/checkouts/<actor>` - a clone rather than a worktree because a worktree's `.git` file points at the host's absolute path, which does not exist inside the container, and because the clone's `origin` is the repository on the host, which the agent cannot reach, so an agent can commit all it likes and never touch the repository's own refs.
The clone's git identity is the actor's name, so every commit is attributed to the declared actor.
`begin` fetches `origin` and checks out `agent/<actor>/<slug>` from the base branch (a free-form prompt gets `agent/<actor>/<run-id>`); a resumed task's branch is checked out and rebased on the base instead, and a rebase that conflicts fails the run before the agent starts, since resolving it is a human's call.
Anything a previous run left uncommitted is stashed, never discarded.
`finish` fetches the branch back into the repository and diffs it against the base; paths left uncommitted are reported as `dirty`, since the gate only sees what was committed.

**`plain`**: no version control at all.
The actor's checkout is a copy of the tree, `begin` takes a content snapshot, and `finish` reports every path whose content differs from it and copies those files to `<state>/outbox/<run-id>/`.
It exists for a tree that is simply present, with no repository behind it, and to show that the seam is real: the host runs unchanged on it, and `test/source.test.ts` proves it.

A third is a module path: `source: ./my-source.ts`, relative to the configuration, exporting `createSource(options)` or a default function of that shape.
It receives the repository root, the checkouts directory, the configured base and the state directory, and returns the six methods above.

## Working together

A task that crosses a boundary is the normal case, not the exception: an API change needs a client change, a tool change needs a doc change, a map change needs a human.
The map's answer is that nobody crosses - reaching beyond a territory means a reviewed edit by the territory's owner - so the host's answer has to be a way for one actor to ask another.

The channel is the tracker.
An actor that needs work done elsewhere **files a task for it and finishes blocked**; the owner of that territory picks the task up the way it picks up any other; when the task lands, the original is unblocked and resumes.
There is no message bus, no shared session, no agent talking to agent: the request is a task, with a title, a territory and a body, reviewable in the tracker like every other task, and the reply is the landed work.

### Filing a request

An agent asks by writing a file, which is the one thing every harness can do.
The prompt tells it how:

> If the task needs a change outside your territories, do not make it.
> Write one file per request to `/heai/runs/$HEAI_RUN.requests/<name>.md`, with `title` and `territory` in frontmatter and, in the body, what is needed, why, and how you will know it is done.
> Then commit what you have and finish, saying what you are blocked on.

```markdown
---
title: scope-gate prints the discovered map path under --format json
territory: scope-gate
---

task-manager's `.heai` discovery needs to show which map the gate resolved,
so the two tools can be checked for agreement in CI. Add a `map` field to the
JSON output, holding the absolute path the gate read.

Done when: `echo | scope-gate --actor toolsmith --format json` includes `"map"`.
```

`territory` names a territory the map declares; it routes the request to that territory's owner, llm-agent or human.
A request to change the map itself routes to whoever owns it, which is a human, which is the point.

### What the host does with it

When the run settles, the host turns each request file into a task and the requesting task into a blocked one, through the tracker's own CLI so the tracker's validation holds:

```sh
task-manager new scope-gate-prints-the-discovered-map-path-under-format-json --dir .heai/tasks \
  --title "..." --territory scope-gate --status todo --priority high --body - < request
task-manager set task-manager-heai-discovery --dir .heai/tasks --status blocked \
  --note "Blocked by [scope-gate-prints-…](scope-gate-prints-….md), requested by \`toolsmith\` in run \`2026…\`."
```

The slug is derived from the title the way the tracker's own capture form derives one, with a numeric suffix on a collision, so the agent never names an id.
The priority is the requesting task's, since the request is on its critical path.
The body gains one line naming the requester, the run and the task it serves, so the new task is traceable to what asked for it.
A request whose `territory` the map does not declare, or whose frontmatter does not parse, is not filed: it is recorded on the run as rejected, and the run is marked `failed` with the reason, since a request the agent thought it made and did not is worse than a failed run.

The run's status becomes **`blocked`** when the runner exited `0` and filed at least one request: it ended cleanly, having done what it could.

These are the only writes the host ever makes to the tracker.
They record facts only the host knows - a run asked for work, a blocker has landed - and never a judgement: the host never marks a task `in-progress`, `in-review` or `done`, which stay the tracker owner's and the humans'.
The writes land in the repository's working tree, not in any actor's checkout, exactly as a change from the tracker's web view does, and are reviewed and committed the same way.

### Resuming

`done` in the tracker means *landed*: the work is on the base branch.
So the host watches the tasks it blocked, in `<state>/blocked/`, and on settle, when every blocker a task waits on is `done`, it moves the task back to `todo` with a note saying which blocker landed.
A task a human has moved out of `blocked` by hand is no longer watched.

What happens next follows the `dispatch` setting.
Under `manual`, the default, the page and `status` show the task as ready to resume and a human assigns it, as they did the first time.
Under `auto`, the host queues it to the actor that had it, and likewise assigns any `todo` task whose territories are all owned by an actor that is up.
`auto` is what turns a set of actors into a team that works a backlog on its own, with the humans reviewing branches and landing them; it is off by default because it is a decision about how much runs unattended.

### What keeps it honest

- **A request is a task, so it is visible.** Every ask an agent makes sits in the tracker with its provenance, where a human triages it, reprioritizes it, or cancels it - and a canceled blocker leaves the requester blocked, which the page shows.
- **The requester stops.** It does not wait, poll, or retry: it finishes, and the container is free for other work.
- **Nothing crosses a boundary.** The request is filed by the host on the human's path, the work is done by the territory's owner on its own ref, and both go through the gate.
- **Chains are bounded.** Under `auto`, a task blocked by a request that is itself blocked by a request is a chain, and the host refuses to auto-assign a task more than three requests deep, saying so instead: three hops is a design conversation, not a backlog.

## State: files beside the map

Everything the tool knows lives in one directory beside the map and the tracker - `.heai/agent-host/` when the map is in `.heai/`, `./agent-host/` next to `./tasks/` when it sits at the root:

```
agent-host/
  .gitignore                  `*` - written by the tool, so the directory ignores itself
  checkouts/<actor>/          the actor's clone, mounted at /work
  runs/<id>.json              the run record, written by the host
  runs/<id>.prompt            the composed prompt, read by the run
  runs/<id>.pid               written by the run when it starts
  runs/<id>.log               appended by the run as it goes
  runs/<id>.exit              written by the run when it ends; its presence means "over"
  runs/<id>.requests/*.md     requests for other territories, written by the run
  runs/<id>.canceled          written by `cancel`, so the exit that follows reads as canceled
  queue/<actor>/<id>          an empty file per queued run, ordered by id
  blocked/<slug>.json         a task the host blocked, its actor, and what it waits on
  requested/<slug>.json       a task a request created, and how deep in a chain it sits
```

It sits beside the map because that is where a repository's heai data lives, and it is gitignored because it is machine state - the line the `.heai` proposal draws with `local.yaml`: committed `.heai/` is reviewable architecture and work, and everything machine-ish under it is ignored.
Run ids sort chronologically, so the queue and the history need no index.

Which actors are running is never stored; it is asked of `container list` on every command and every request, so a container started or stopped by hand shows up correctly.

**Settling.** A run finishes without anyone watching, so its record is brought up to date lazily.
Every command and every request that reads runs first *settles* them: for each record still `running` whose `.exit` file exists, record the exit, run the gate, file its requests, and write the record as `succeeded`, `blocked`, `failed` or `canceled`; for each record `running` whose container is gone, write it as `lost`; unblock any task whose blockers have all landed; then, for each actor that is up and idle with a non-empty queue, start the next run, and under `dispatch: auto` fill idle actors from the `todo` queue.
Settling is idempotent, and two processes settling at once - a CLI command and the server - are serialized by an atomic `mkdir` lock, broken when a crashed settler leaves it older than a minute.
`agent-host settle` runs it on its own, for a cron or a hook; the server also runs it on a short interval so the page stays live without a request.

A run record:

```json
{
  "id": "20260902-165952-beta-132f",
  "actor": "beta",
  "task": "t2",
  "title": "Beta needs alpha",
  "ref": "agent/beta/t2",
  "status": "blocked",
  "queuedAt": "2026-09-02T16:59:52Z",
  "startedAt": "2026-09-02T16:59:52Z",
  "endedAt": "2026-09-02T16:59:54Z",
  "exitCode": 0,
  "gate": { "verdict": "clean", "findings": [], "violations": 0 },
  "requests": [{ "title": "Help requested by beta", "territory": "alpha", "task": "help-requested-by-beta" }],
  "resumes": null,
  "changed": [],
  "dirty": [],
  "error": null
}
```

`status` is one of `queued`, `running`, `succeeded`, `blocked`, `failed`, `canceled`, `lost`.
`gate.findings` is scope-gate's own JSON, kept whole.
The prompt is not in the record - it is the `.prompt` file beside it, and `GET /api/runs/<id>` includes it.

## The CLI

Every command works on its own, against the container service and the state directory; no server is involved.

```
agent-host status                          every llm-agent, and what each is doing
agent-host up <actor> | down <actor> [--force]
agent-host assign <actor> --task <slug> | --prompt "..." [--wait]
agent-host runs [<actor>] | show <run-id> | log <run-id> [--follow] | cancel <run-id>
agent-host tasks                           the tracker's assignable tasks, and who each routes to
agent-host settle                          bring records up to date, start queued runs
agent-host build-image [<name>]            build image/<name> (claude, codex, echo) as heai/agent-<name>
agent-host serve [--port 4747]             the page and the API
```

Run them as `node src/cli.ts <command>` from the tool directory, or install the package and use the `agent-host` bin.
`status`, `runs`, `show` and `tasks` take `--json`.

`up` clones the repository for the actor if it has no checkout yet, then creates and starts its container, or starts it again if it was stopped; an actor already up is left alone.
`assign` composes the prompt, writes it, has the source put the checkout on the run's ref, and starts the run detached, then returns with the run id: the run continues whether or not the CLI does.
If the actor is busy the run is queued instead, and starts when the actor is free.
With `--wait` it prints the log as it grows, settles when the `.exit` file appears, and exits with the outcome.
`log --follow` does the same for a run already started.
`down` refuses while a run is in progress unless `--force`, which cancels it first; the refusal is what stops a container being deleted out from under work only a file knew about.

Common options, on every command:

| option | environment | default | meaning |
| --- | --- | --- | --- |
| `--map` | `HEAI_MAP` | `.heai/architecture.yaml`, else `architecture.yaml` | the architecture map |
| `--tasks` | `HEAI_TASKS` | `.heai/tasks`, else `tasks` | the tracker directory, for `--task` and the assign form |
| `--state` | `HEAI_STATE` | `agent-host` beside the map | where the files above live |
| `--config` | - | `agent-host.yaml` beside the map | machinery configuration, below |

Flags win, then environment variables, then defaults.
The defaults look in `.heai/` first so the tool lands on the convention the other tools are moving to, and fall back to what `scope-gate` and `task-manager` default to today.

### Exit codes

| code | meaning |
| --- | --- |
| `0` | done: the command did what was asked; for `--wait`, the run succeeded and the gate is clean |
| `1` | answered no: the run failed, finished blocked, or the gate found a violation; an actor is busy; a task is already in flight |
| `2` | bad usage, an unreadable map or configuration, a missing image, or a container service that could not be asked |

`--wait` and `log --follow` print one last line naming the outcome - `Run blocked: exit 0, gate clean, 0 files changed, 1 request filed` - so a script that cares which `1` it got reads it there or in the record.
A run that was `lost` exits `2`: the question was not answered.
It is the same split `scope-gate` and `task-manager` make.

## Configuration

Nothing about running an actor belongs in the map: the image, the CPU count, the memory, the credentials file are machinery, the same category `task-manager` keeps out of a task.
They go in an optional `agent-host.yaml` beside the map:

```yaml
image: heai/agent-claude   # the image an actor runs unless it names another
base: main                 # what runs start from: a branch, under git
source: git                # the source plugin: git, plain, or a module path
envFile: ~/.heai/agent-host.env   # credentials for images that name none of their own
dispatch: manual           # or auto: assign todo tasks and resume unblocked ones without being asked
images:                    # what each image runs with, keyed by image name
  heai/agent-claude:
    cpus: 4
    memory: 8G
  heai/agent-codex:
    cpus: 4
    memory: 8G
    envFile: ~/.heai/agent-host-openai.env
actors:                    # which image each actor runs, keyed by the map's actor name
  tracker-smith:
    image: heai/agent-codex
```

Resources and credentials belong to an image, not an actor: the harness is what needs the memory and the key, and two actors on one image are sized once.
An actor's entry may say only `image`; `cpus` there is refused with a pointer at `images`.
An actor named here that the map does not declare, or that is not an llm-agent, is an error, since the map is the only list of actors.
An actor the map declares and this file does not mention runs the default image, and an image this file does not mention runs with the container's default resources.
Paths resolve against the home directory for `~/` and the configuration's own directory otherwise; the env file is best kept out of the repository so a credential is never one `.gitignore` mistake away from a commit.
`source` names the source plugin, above.
`scopeGate` and `taskManager` name the commands to run those tools with, when they are not the sibling checkouts in this repository or on `PATH`.

## The server

`agent-host serve` is the same functions behind HTTP: the page renders what `status` and `show` print, and every API write does what the matching command does.
It holds nothing in memory that the files do not hold, so it can be restarted under an open page, and a run assigned from the CLI while the page is open appears on the page's next refresh.
Its one addition is a settle loop every three seconds, so runs finish and queues drain while nobody is typing commands.

### The API

JSON, under `/api`, same-origin for anything that changes something, the same rule the other servers apply.

| method and path | what it does |
| --- | --- |
| `GET /api/actors` | every llm-agent in the map: context, owned territories, container state (`running`, `stopped`, `absent`), current run, queue length, tasks ready to resume |
| `GET /api/actors/<name>` | one actor, with its recent runs |
| `POST /api/actors/<name>/up` | clone if needed, create and start its container; `202` |
| `POST /api/actors/<name>/down` | stop and delete its container; `409` while a run is in progress unless `{"force": true}` |
| `POST /api/actors/<name>/runs` | assign work: `{"task": "<slug>"}` or `{"prompt": "..."}`; `202` with `{run, queued, warnings}`, `409` if the container is not running or the task is already in flight |
| `GET /api/actors/<name>/runs` | that actor's runs, newest first |
| `GET /api/runs/<id>` | one run record, with its prompt |
| `GET /api/runs/<id>/log` | the log as text; `?follow=1` keeps the response open and streams as the run writes, until it ends |
| `POST /api/runs/<id>/cancel` | signal it; `409` if it is already over |
| `GET /api/tasks` | the tracker's assignable tasks - `todo`, `in-progress`, `blocked` - each with the actors its territories route to, the run on it if any, and for a blocked one what it waits on and where that stands |
| `GET /api/events` | server-sent events: `actor` and `run` records as they change, and `note` lines as settling reports them |
| `GET /api/map` | the map as the server read it, and its hash |

Errors follow the exit-code split, as HTTP: `404` for what is not there, `409` for what cannot happen now, `400` for a bad ask, `502` for anything the container CLI made unanswerable, with the CLI's stderr in the body.

### The page

Server-rendered: plain HTML forms that POST and redirect, usable with the script blocked.
The script adds two things: the live log, streamed through `/api/runs/<id>/log?follow=1`, and the actor list refreshing from `/api/events`.

A master-detail split, the same layout and palette as `task-manager`, so the two look like one application:

- **Left: the actors.** Every llm-agent the map declares, with a state pill - *busy*, *idle*, *stopped*, *absent* - the task it is on, the queue depth, and whether it has a task ready to resume.
  An actor the map declares but that has no container is still listed; that it is absent is the point of listing it.
- **Right: the selected actor.** Its container state and image; **start** and **stop**; the current run with its log scrolling live and a **cancel**; the queue; the **assign** form; its territories and its context as the map states them; and the history, each run with its status and its gate verdict.
- **The assign form** is a select of the assignable tasks, the ones routed to this actor first and the rest marked with where they route, and a textarea for a free prompt.
- **A run page**, `/run/<id>`: the record, the gate's findings, the requests it filed, the changed and uncommitted paths, the log, and the prompt it was given, which is the review's starting point.

The page can start containers, hand out the credentials in the env file, and run an agent against a checkout.
That is why the default binding is loopback and writes are same-origin only, and why there is no authentication: bind wider only behind a trusted proxy, the same posture as the other two servers.
`--port`, `--host` and `--base-path` follow them, with `PORT`, `HOST` and `BASE_PATH` as their environment forms.

## A walkthrough

Every line below is from a real session against the container service, with the `echo` image standing in for an LLM.
The repository has a map with two llm-agents, `alpha` owning `alpha/**` and `beta` owning `beta/**`, and a tracker with two tasks.

```sh
$ agent-host build-image echo
Built heai/agent-echo
$ cat .heai/agent-host.yaml
image: heai/agent-echo
base: main
$ agent-host up alpha && agent-host up beta
Started heai-alpha (heai/agent-echo); checkout /…/.heai/agent-host/checkouts/alpha
Started heai-beta (heai/agent-echo); checkout /…/.heai/agent-host/checkouts/beta
$ agent-host status
actor  container  state    current run                               queued
alpha  running    idle     -                                         0
beta   running    idle     -                                         0
```

Assigning, and waiting on the outcome:

```sh
$ agent-host assign alpha --task t1 --wait
Run 20260902-165951-alpha-6a59 started on agent/alpha/t1
echo-runner: acting as alpha in run 20260902-165951-alpha-6a59 (task: t1)
echo-runner: committed 6d6d841 on agent/alpha/t1
Done: added a note to alpha/AGENT-NOTES.md.
Run succeeded: exit 0, gate clean, 1 file changed
$ git log --oneline --format='%h %an %s' agent/alpha/t1 | head -1
6d6d841 alpha echo-runner: note from alpha (t1)
```

The branch is in the repository, authored by the actor, unmerged.
Now a task whose body asks the agent to request help from `alpha`:

```sh
$ agent-host assign beta --task t2 --wait
Run 20260902-165952-beta-132f started on agent/beta/t2
echo-runner: filed a request; blocked.
Run blocked: exit 0, gate clean, 0 files changed, 1 request filed
$ agent-host tasks
help-requested-by-beta               todo         -       → alpha
t1                                   todo         high    → alpha
t2                                   blocked      -       → beta  waits on help-requested-by-beta:todo
$ git status --short .heai/tasks
 M .heai/tasks/INDEX.md
?? .heai/tasks/items/help-requested-by-beta.md
 M .heai/tasks/items/t2.md
```

The tracker changes are working-tree changes, reviewed and committed like any made from the tracker's page.
`alpha` does the requested task; a human lands it and marks it done; the next settle unblocks `t2`:

```sh
$ agent-host assign alpha --task help-requested-by-beta --wait | tail -1
Run succeeded: exit 0, gate clean, 1 file changed
$ git merge agent/alpha/help-requested-by-beta && task-manager set help-requested-by-beta --status done --dir .heai/tasks
$ agent-host settle
Unblocked t2: help-requested-by-beta done
$ agent-host status
actor  container  state    current run                               queued
alpha  running    idle     -                                         0
beta   running    idle     -                                         0  resume: t2
$ agent-host assign beta --task t2 --wait | tail -1
Run blocked: exit 0, gate clean, 0 files changed, 1 request filed
$ agent-host show 20260902-210025-beta-0ad1 | head -5
run       20260902-210025-beta-0ad1
actor     beta
task      t2  Beta needs alpha
branch    agent/beta/t2  (resumes 20260902-165952-beta-132f)
status    blocked  exit 0  started 2026-09-02T21:00:25Z  ended 2026-09-02T21:00:26Z  (1s)
```

The resumed run reused the branch, was told what it had requested and what it had said, and - being the echo runner, which always asks - asked again, filing `help-requested-by-beta-2`.
Nothing in the exchange was a message from one agent to another: tasks, branches, gate verdicts, and a human at each landing.

```sh
$ agent-host down alpha && agent-host down beta
Stopped and deleted heai-alpha
Stopped and deleted heai-beta
```

Switching `beta` to another harness is one configuration change - `actors: { beta: { image: heai/agent-codex } }`, with that image's `envFile` under `images` - then `down beta` and `up beta`.
The record, the log, the branch and the gate are identical in shape, because none of them ever knew which harness was inside.

## What this deliberately leaves out

- **Judging task state.** The host files requests, blocks and unblocks, and nothing else: it does not move a task to `in-progress` when it assigns it, to `in-review` when a run ends, or to `done` when a branch lands.
  Those are judgements, the tracker has an owner, and this tool is not it.
- **Landing.** A run ends in a ref and a verdict, never in a merge.
- **More than one repository.** The map's single repository is cloned, resolved through its `localPath`; a multi-repo map is a `2` at startup.
- **Remote hosts.** The containers run on the machine the command runs on.
- **Parallelism within an actor.** One run at a time per actor, by design.

## Tests

```sh
npm test        # the CLI slice, the map, the prompt, the files, the operations, the routes, the palette
npm run typecheck
```

`test/source.test.ts` runs the host on the `plain` source and on a stub module, so the seam stays a seam.
`test/host.test.ts` drives the operations against a fake container CLI and a real temporary git repository with a real tracker, playing the run's part by writing the files a run would - which is all the host ever sees of one - and runs the real `scope-gate` and `task-manager` for the verdict and the tracker writes.
`test/containers.test.ts` pins the parser to recorded `container list` output.
`test/style.test.ts` pins the palette to `task-manager`'s, token for token.

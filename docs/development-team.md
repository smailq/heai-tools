# A software development team

*How a codebase is run on heai-tools, 2026-09-10: a few humans, an llm-agent per area of the code, and automation that moves work from a task to a released change. Read [`project.md`](project.md) first for the directory and the tools; this document is the software shape of them, and `templates/software/` is its files.*

The team is a map.
Humans own the parts that must stay theirs - the map itself, CI, the release process - and an agent owns each area of the code it can be trusted with, steered by the context written beside its territory.
Work is a task, routed to an owner by the territory it names; a session is one agent working one task on its own branch in a pod workspace; landing, checking, promotion and release are flows, each moved by a human or by a script a rule or a hook runs.
Every policy - who gets sessions and how many, which areas land without a person, how many retries - is a reactor rule or a line in a flow definition, so it is read where the rest of the process is.

## The map

```yaml
# architecture.yaml
version: 1
unowned: fail

actors:
  lead:          { type: human, identity: '@lead' }
  reviewer:      { type: human, identity: '@reviewer' }
  api-owner:
    type: llm-agent
    context: |
      You own the HTTP API. Keep handlers thin; business rules live in core.
      Anything you need in core is a request, not an edit.
  core-owner:
    type: llm-agent
    context: |
      You own the domain model and the database layer. No I/O in the domain; every aggregate has a test.
    watches: [api]
  web-owner:
    type: llm-agent
    context: You own the web client. Talk to the API through the generated client only.

repositories:
  app: { remotePath: github.com/example/app, localPath: ../app }

territories:
  platform:
    owner: lead
    scope: [{ repository: app, globs: ['architecture.yaml', '.github/**', 'ci/**', 'scripts/**'] }]
  core:
    owner: core-owner
    scope: [{ repository: app, globs: ['src/core/**'] }]
  core-db:
    parent: core
    scope: [{ repository: app, globs: ['src/core/db/**'] }]
    context: Migrations are append-only.
  api:
    owner: api-owner
    scope: [{ repository: app, globs: ['src/api/**'] }]
    dependsOn: [core]
  web:
    owner: web-owner
    scope: [{ repository: app, globs: ['web/**'] }]
    dependsOn: [api]
  docs:
    owner: reviewer
    scope: [{ repository: app, globs: ['docs/**', 'README.md'] }]
```

What the map buys before any automation runs: an agent that edits outside its territory fails `architect gate` on its own diff, so `ci/` and the map cannot be changed by the code they govern; `dependsOn` says which imports are legal; `watches` lets `core-owner` see the API's changes without being able to make them.

## The team

| member | kind | owns | does |
| --- | --- | --- | --- |
| `lead` | human | `platform` | edits the map and the rules, lands what no rule lands, promotes, releases |
| `reviewer` | human | `docs` | reads proposed landings, answers agents in `waiting` |
| `api-owner`, `core-owner`, `web-owner` | llm-agent | one area each | take the tasks routed to them, work on a branch, commit, file requests across boundaries |
| the rules and the hooks | automation | nothing | start sessions, gate diffs, propose landings, land where a rule says so, run checks, requeue |

A task routed to two agents is left for a human to split.
A request an agent files into another agent's territory is a task that agent picks up like any other, and the requesting session waits on it.

## The directory

```
<project>/
  architecture.yaml
  tasks/
  flows/session.yaml  request.yaml  landing.yaml  checkpoint.yaml  promotion.yaml  release.yaml
  scripts/session/pick.sh  start.sh  finish.sh  ask.sh  requeue.sh  cancel.sh
  scripts/landing/propose.sh  land.sh  merged.sh
  scripts/checkpoint/check.sh  promote.sh
  scripts/release/release.sh
  images/dev/Containerfile        FROM ${BASE}: node, pnpm, the agents, herdr integrations
  pod.yaml  reactor.yaml
```

Nothing else: what an area's policy is lives in `reactor.yaml` as rules and in `flows/*.yaml` as `by:` and hooks.

## The flows

Six definitions, chained by links and hooks: a **session** produces a branch; a **landing** brings it into `main`; a **checkpoint** checks a head of `main`; a **promotion** moves a passing head to the `release` branch; a **release** cuts a version from it.
A **request** is a task one agent filed for another, as a flow so a session can wait on it.

```yaml
# flows/session.yaml - one agent on one task
name: session
states: [queued, running, waiting, exited, clean, violation, blocked, resumable, failed, canceled, lost]
initial: queued
terminal: [clean, violation, failed, canceled, lost]
links:
  actor: { required: true }
  task:  { required: true }
  repo:  { required: true }
  workspace: { required: false }
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
  clean:     { run: scripts/landing/propose.sh }
  lost:      { run: scripts/session/requeue.sh 1 }        # one retry; the count is the hook's argument
  failed:    { run: scripts/session/requeue.sh 1 }
```

```yaml
# flows/landing.yaml - one branch brought into main
name: landing
states: [proposed, landed, refused, withdrawn]
initial: proposed
terminal: [landed, refused, withdrawn]
links:
  branch:    { required: true }
  actor:     { required: true }
  territory: { required: true }        # from `architect owner` over the changed paths; what the rules match on
  session:   { required: false }
  task:      { required: false }
  pr:        { required: false }       # under a GitHub host: the pull request
transitions:
  - { from: proposed, to: landed,    on: merged,    by: [human, land.sh, merged.sh] }
  - { from: proposed, to: refused,   on: refused,   by: [human] }
  - { from: proposed, to: withdrawn, on: withdrawn, by: [human, cancel.sh] }
hooks:
  proposed: { run: scripts/landing/announce.sh }            # `reactor emit landings landing.proposed`; the rules decide who lands it
  landed:   { run: scripts/checkpoint/start.sh }            # `flow start checkpoint --link head=`
  refused:  { run: scripts/session/requeue.sh 0 }           # the task back to todo with the note, no new session
```

```yaml
# flows/checkpoint.yaml - a head of main, checked as a whole
name: checkpoint
states: [open, pass, fail]
initial: open
terminal: [pass, fail]
links: { head: { required: true }, landing: { required: false } }
transitions:
  - { from: open, to: pass, on: checked, when: { failed: 0 }, by: [check.sh] }
  - { from: open, to: fail, on: checked, by: [check.sh] }
  - { from: open, to: fail, on: stale,   after: 6h }
hooks:
  open: { run: scripts/checkpoint/check.sh }                # the project's tests, in the pod, `checked` with the count
  fail: { run: scripts/checkpoint/file.sh }                 # a task per failing path, in the territory `architect owner` gives
```

```yaml
# flows/promotion.yaml - a passing head moved to the release branch
name: promotion
states: [proposed, promoted, refused]
initial: proposed
terminal: [promoted, refused]
links: { head: { required: true }, checkpoint: { required: true } }
transitions:
  - { from: proposed, to: promoted, on: merged,  by: [human, promote.sh] }
  - { from: proposed, to: refused,  on: refused, by: [human] }
```

```yaml
# flows/release.yaml - a version cut from a promoted head
name: release
states: [open, released, failed]
initial: open
terminal: [released, failed]
links: { head: { required: true }, version: { required: true }, tag: { required: false } }
transitions:
  - { from: open, to: released, on: published, by: [release.sh] }
  - { from: open, to: failed,   on: failed,    by: [release.sh] }
  - { from: open, to: failed,   on: stale,     after: 6h }
hooks:
  open: { run: scripts/release/release.sh }                 # checks, tag, publish, a note on every task carried
```

A release is started only by a person: `flow start release --link head=<sha> --link version=1.4.0`, and the hook does the rest.
A promotion is started by the checkpoint's `pass`, through a rule below, and moved by a person or by `promote.sh` when a rule runs it.

## The rules

Policy is here.
Who gets sessions, how many at once, and which areas land without a person are rules; an actor or an area with no rule is a human's to start or land.

```yaml
# reactor.yaml
sources:
  clock:     { type: schedule, cron: "* * * * *" }
  tasks_cli: { type: cli, kinds: [task.todo, task.canceled] }
  landings:  { type: cli, kinds: [landing.proposed] }
  flows:     { type: cli, kinds: [checkpoint.pass] }
  github:    { type: webhook, path: /hook/github, provider: github, secret: env:GITHUB_HOOK_SECRET }
  sentry:    { type: webhook, path: /hook/sentry, provider: sentry, secret: env:SENTRY_HOOK_SECRET }
rules:
  - { name: settle,      on: { source: clock },                                           run: flow settle }
  - { name: pick-api,    on: { source: clock },                                           run: scripts/session/pick.sh api-owner 2 }
  - { name: pick-core,   on: { source: clock },                                           run: scripts/session/pick.sh core-owner 1 }
  - { name: pick-now,    on: { source: tasks_cli, kind: task.todo },                      run: scripts/session/pick.sh --for-task, debounce: 5s }
  - { name: land-api,    on: { source: landings, kind: landing.proposed, territory: api }, run: scripts/landing/land.sh }
  - { name: promote,     on: { source: flows, kind: checkpoint.pass },                    run: scripts/checkpoint/promote.sh }
  - { name: pr-merged,   on: { source: github, kind: pull_request.closed, merged: true }, run: scripts/landing/merged.sh }
  - { name: incident,    on: { source: sentry, kind: issue.created },                    run: scripts/incidents/file.sh }
  - { name: nightly,     on: { source: clock, cron: "0 2 * * *" },                       run: scripts/checkpoint/start.sh main }
```

Reading it as policy: `api-owner` may have two sessions open and `core-owner` one, picked every minute; `web-owner` has no rule, so its tasks wait for a human to start a session.
A landing whose changed paths fall in `api` is landed by `land.sh` as soon as it is proposed; a landing in `core` or `web` waits for a person, and `operator` shows it.
Every passing checkpoint is promoted by `promote.sh`; a project that wants a person there deletes the `promote` rule and the move is `by: [human]` in practice.

## The scripts

| script | fires on | does |
| --- | --- | --- |
| `session/pick.sh <actor> <max>` | the minute rule for that actor | if fewer than `<max>` sessions are open for the actor by `flow list session --link actor=`, the `todo` tasks whose territories all route to it by `architect territories --json`, with no open session on them, by priority then age: `flow start session`; a task routed to two actors is left for a human |
| `session/start.sh` | `queued`, `resumable` | `pod open` on a branch from `main`, `architect context` plus the task as the prompt, or the task's `run` block as a command, `--notify` for `exited` and a heartbeat, `flow link`, `flow advance started`, `tasks set --status in-progress` |
| `session/finish.sh` | `exited` | `pod repo pull-branch`, the diff through `architect gate --actor`, each file under `requests/<id>/` into `tasks new` and a `request` flow, `flow link --waits-on`, `flow advance gated`, `tasks set --status blocked` with the `Blocked by` note |
| `session/ask.sh` | `waiting` | a task for the reviewer naming the session and the question `pod read` shows |
| `session/requeue.sh <retries>` | `lost`, `failed`, `landing.refused` | the task back to `todo` with the reason; a new session when fewer than `<retries>` sessions on the task have ended badly, by `flow list session --link task=` |
| `session/cancel.sh` | a human, `operator`'s `c` | `flow advance canceled`, `pod close`, the task back to `todo` |
| `landing/propose.sh` | `session.clean` | `architect owner` over the changed paths for the territory, `flow start landing --link branch= --link actor= --link territory= --link session=` |
| `landing/announce.sh` | `landing.proposed` | `reactor emit landings landing.proposed --payload '{"landing": ..., "territory": ...}'`, so the rules can match the territory |
| `landing/land.sh <landing>` | a rule, or a human | the gate over the branch against `main`, merge, fast-forward; `flow advance merged --by land.sh`, `tasks set --status done`, the linked `request` flow `done` |
| `landing/merged.sh` | the GitHub `pull_request.closed` webhook | finds the landing by its `pr` link and advances `merged --by merged.sh` |
| `checkpoint/start.sh [<ref>]` | `landing.landed`, the nightly rule | `flow start checkpoint --link head=<sha> --link landing=` |
| `checkpoint/check.sh` | `checkpoint.open` | `pod run` the project's tests on the head, `flow advance checked --data '{"failed": n}' --by check.sh` |
| `checkpoint/file.sh` | `checkpoint.fail` | a task per failing path, in the territory `architect owner` gives, with the log's path in the body |
| `checkpoint/promote.sh` | the `promote` rule | `flow start promotion --link head= --link checkpoint=`, fast-forward `release` to the head, `flow advance merged --by promote.sh` |
| `release/release.sh` | `release.open` | release checks, tag, publish, a note on every task whose landing is in the range; `published` or `failed` |

Every script passes `--by <its name>`, and every definition's `by:` lists the scripts allowed to make that move, so a move a script may not make is refused by `flow` rather than by convention.

## Tasks that run

A task whose body carries a fenced block tagged `run` is executed instead of prompted, on the same branch, under the same gate:

````markdown
---
title: Regenerate the ontology bindings
status: todo
priority: medium
territory: core
---

The bindings under `src/core/gen` are stale after the schema change.

```sh run
pnpm --filter core generate && git add -A && git commit -m "Regenerate bindings"
```
````

`start.sh` reads it with `tasks show --json` and runs `pod run <workspace> --file` instead of `pod prompt`.
Dependency bumps, code generation, formatting sweeps and migrations are this kind of task.

## A worked day

The project is a git repository with the files above, `reactor serve` under launchd, and `pod up --image app/dev` done.

- 09:00 - `lead` moves `fetch-company-favicon` to `todo` and emits `task.todo`; the `pick-core` rule finds `core-owner` with none open and starts a session. Entering `queued`, `flow` runs `start.sh`: a workspace from `main`, the prompt, the notifies, `started`, the task `in-progress`.
- 09:31 - the agent settles; the fact lands; the `settle` rule folds it, and entering `exited` runs `finish.sh`: branch home, gate clean, no requests, `gated`. Entering `clean` runs `propose.sh`, which starts a landing in `core`; `announce.sh` emits it; no rule matches `territory: core`, so it waits, and `operator` shows one proposed landing.
- 09:40 - `web-owner` finishes `document-tabs` with one request into `api`. `finish.sh` files the task and the `request` flow, links `waits-on`, advances `gated` with `requested: true`; the session is `blocked`, the task `blocked` with the note. The new task is `todo`; the next minute's `pick-api` rule gives it to `api-owner`.
- 10:15 - the API session is clean; its landing is proposed in `api`; the `land-api` rule runs `land.sh`, which gates the branch against `main`, merges, and advances `merged --by land.sh`; the request is `done`; `flow settle` fires the web session's guard, and entering `resumable` runs `start.sh` again on the same branch rebased on `main`. Entering `landed` runs `checkpoint/start.sh`; `check.sh` runs the tests in the pod; the checkpoint is `pass`; the `promote` rule fast-forwards `release`.
- 10:20 - `reviewer` reads the core landing's diff and lands it: `scripts/landing/land.sh <landing> --by human`. The task goes `done`; a checkpoint runs and passes; `release` moves again.
- 11:05 - `api-owner` stops to ask whether a breaking change is acceptable; the session is `waiting`; `ask.sh` files a task for `reviewer` naming the session; the reviewer looks with `pod attach`, answers with `pod prompt`, and the next `exited` moves it on.
- 14:00 - a Sentry webhook files a task in `web`; `web-owner` has no `pick` rule, so the task waits in `INDEX.md` for a human to decide it is worth an agent and start the session with `operator`'s `a`.
- 17:30 - `lead` releases: `flow start release --link head=$(git -C ../app rev-parse release) --link version=1.4.0`; entering `open` runs `release.sh`, which tags, publishes, and notes the version on every task carried.
- 23:00 - a session touched nothing for ten minutes; `flow settle` makes it `lost`, and entering `lost` runs `requeue.sh 1`, which puts the task back and starts one more session, since none has ended badly before.

`flow trace task=document-tabs` reads the day for one task across its session, its request, its landing and its checkpoint; `operator` shows all of it live.

## Where a human steps in

- **At the map**, when a boundary should move or a new area gets an owner. The commit is the decision.
- **At the rules**, when an actor earns sessions of its own or an area earns automatic landing: a line in `reactor.yaml`, reviewed as a diff.
- **At a task**, to file it, to move it to `todo` when it is ready, to split one routed to two agents, and to start a session for an actor with no `pick` rule.
- **At `waiting`**, when an agent asked. `pod attach` shows what the agent sees; `pod prompt` answers.
- **At a proposed landing** with no rule for its territory, to read the diff and land it, or refuse it with a note the task carries back.
- **At release**, always: only a person starts one.
- **At `violation`**, when an agent's diff crossed a boundary: the gate's report says which paths, and the task goes back with the report in its body.
- **At `flow stuck` and the red on `operator`**, when a script failed and left its log under the flow's `actions/`.

## Standing it up

```sh
mkdir ~/Code/app-project && cd ~/Code/app-project && git init
architect template > architecture.yaml && $EDITOR architecture.yaml && architect check
tasks init --dir tasks --map ../architecture.yaml
cp -r ~/Code/heai-tools/templates/software/{flows,scripts,reactor.yaml} .
mkdir -p images/dev && $EDITOR images/dev/Containerfile        # FROM ${BASE}; node, pnpm, claude-code, codex, herdr integrations
$EDITOR pod.yaml                                               # images: { app/dev: images/dev }, mounts: [./flow/flows:/heai/flow]
pod build && pod up --image app/dev --env-from ~/.heai/app.env && pod repo add app
reactor serve                                                  # under launchd or systemd
operator
```

The first week runs with only the `settle` rule: a human starts every session from `operator` and lands every proposal by hand while the map and the contexts settle.
A `pick` rule for an actor, then a `land` rule for a territory, is how trust is extended, one line at a time, each a reviewed commit to the project.

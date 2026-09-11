# @heai-tools/reactor

Reacts to things that happen - a clock reaching a time, a branch moving, a service posting, a URL answering differently, a script or a person emitting an event - by running a command in the project directory with the event in its environment.
Sources produce events, rules match them, and the one action is a shell command.
Every event and every action is a file.

```sh
npm install && npm link                      # once: builds dist/ and puts `heai-reactor` on PATH
heai-reactor tick                                 # one pass over every source, then exit
heai-reactor serve                                # the daemon, with the webhook receiver on 4949
heai-reactor emit tasks_cli task.todo --key t1 --payload '{"slug":"t1"}'   # one event by hand, into a cli source
heai-reactor status                               # sources and cursors, rules and their last action
heai-reactor events --since 1h                    # the log
heai-reactor test sentry-to-owner --event e.json
```

Requires Node 22.18 or newer. `npm install` builds the command into `dist/`, and `npm link` puts it on PATH as `heai-reactor`; without the link, every command is `node dist/cli.js <command>` from this directory, and during development `node src/cli.ts <command>` runs the sources directly. Released as `@heai-tools/reactor` on npm: `npm install -g @heai-tools/reactor`.
Two runtime dependencies: a YAML parser and a JSON Schema validator.

## The shape of it

```
  sources ──► events (jsonl, append-only) ──► rules ──► run
  schedule      { id, source, kind, key,        a rule in            a command in the project directory,
  git             at, payload }                 reactor.yaml         the event in its environment,
  webhook                                       (deduped, debounced, its output in a log beside the record
  poll                                          limited)
  dir  ◄── a file dropped by anything that can write one
  cli  ◄── heai-reactor emit, from a script or a person
```

- **An event** is `{ id, source, kind, key, at, payload }`, appended once to `reactor/events/<date>.jsonl`. `key` identifies the thing that happened - a commit on a branch, a Sentry issue, a cron slot - so two deliveries of the same thing are one event, and a rule acts on it once.
- **A rule** is an entry in `reactor.yaml`: what it listens for, what it runs, and optionally a debounce, a rate limit and a timeout.
- **A source** produces events. Six types ship, and a module path loads a custom one. A source never decides what to do with what it saw.
- **The action is `run`**: a shell command, with the event in its environment.
- **Nothing runs unless `heai-reactor serve` or `heai-reactor tick` does**, except `emit --act`, which runs the rules for the one event it just emitted.

## Sources

Each source is a plugin behind one contract, [`src/source.ts`](src/source.ts): given its options and a cursor, it polls once and returns events with stable keys, exposes an HTTP listener, or takes events from `heai-reactor emit`.

| type | emits | key | cursor |
| --- | --- | --- | --- |
| `schedule` | `tick` per cron slot | `<source>@<slot>` | the last slot, the missed ones |
| `git` | `commit`, `branch-created`, `branch-deleted` | `<branch>@<sha>` | the sha per watched branch |
| `webhook` | what the provider parses: `pull_request.closed`, `issue.created`, `deployment.error` | the delivery or issue id | received and dropped counts |
| `poll` | `changed` | `<source>@<time>@<hash>` | the last answer |
| `cli` | what `heai-reactor emit` says, within `kinds` | `--key`, else the event id | the emissions not yet handled, the last one |
| `dir` | the file's name up to the first dot | `<file>@<mtime>@<hash>` | files taken, the last one |

**`schedule`** evaluates a cron expression, local time unless `utc: true`, and emits one event per slot.
A daemon restarted inside a slot does not fire it twice.
A slot that passed while nothing was running is noted on stderr and listed under `missed` in the cursor, never replayed.
A slot fires only within `grace` of its time, five minutes by default; `every` is how often `serve` checks the clock, ten seconds by default.

```yaml
sources:
  nightly: { type: schedule, cron: "0 2 * * *" }
  clock:   { type: schedule, cron: "* * * * *" }
```

**`git`** polls a repository's local branches, or a remote's after `git fetch` when `remote:` is given, and emits one event per new commit.
The payload carries `branch`, `sha`, `author`, `at`, `subject` and `paths`, the files the commit changed.
`branches` is a list of names or globs, `["*"]` by default; `maxCommits`, two hundred by default, caps what one poll reports when a branch moves by more than that.
The first poll records where every branch is and emits nothing.

```yaml
sources:
  repo: { type: git, path: ../app, branches: [main, "integration/*"], every: 60s }
```

**`webhook`** is one path, one provider, one secret, on the receiver `serve` runs.
A provider verifies the signature and turns the body into `{ kind, key, payload }`:

| provider | signature | kind | hoisted into the payload |
| --- | --- | --- | --- |
| `github` | `X-Hub-Signature-256` | `<event>.<action>` | `merged`, `merge_commit_sha`, `number` from a pull request |
| `sentry` | `Sentry-Hook-Signature` | `<resource>.<action>` | the issue's `title`, `culprit`, `count`, `firstSeen`, `url`, `tags` |
| `vercel` | `x-vercel-signature`, HMAC-SHA1 | the type as Vercel names it | the deployment's `name`, `url` |
| `generic` | a bearer token | `kind` and `key` from JSON pointers, else `type` and `id`, else a hash | nothing |

A secret is `env:NAME`, `file:path`, or the value itself.
An unsigned or unverifiable post is answered `401`, counted in the cursor, and never an event.

```yaml
sources:
  github: { type: webhook, path: /hook/github, provider: github, secret: env:GITHUB_HOOK_SECRET }
  sentry: { type: webhook, path: /hook/sentry, provider: sentry, secret: env:SENTRY_HOOK_SECRET }
  any:    { type: webhook, path: /hook/any, secret: file:.secrets/any, kind: /type, key: /id }
```

**`poll`** fetches a URL on an interval and emits an event when the answer changes: the `status` code, the value at a JSON pointer, or a `hash` of the body.
`headers` are sent with the request; `timeout`, thirty seconds by default, bounds the wait.
The first answer is recorded, not reported; a fetch that fails is a note in the cursor and the next interval tries again.

```yaml
sources:
  supabase: { type: poll, url: https://status.supabase.com/api/v2/status.json, every: 15m, watch: /status/indicator }
  health:   { type: poll, url: https://api.example.com/health, every: 5m, watch: status }
```

**`cli`** is a source whose events come only from `heai-reactor emit <source> <kind>`.
It polls nothing; an emitted event waits as pending in the cursor until the next `tick` or `serve` pass runs the rules over it.
`kinds` restricts what may be emitted, any kind by default; a kind outside the list is refused at `emit`, exit `2`.
The key is `--key`, else the event's own id; the payload is `--payload`, a JSON object, else empty.

```yaml
sources:
  tasks_cli: { type: cli, kinds: [task.todo, task.done] }
```

**`dir`** polls a directory of fact files, for anything that can create a file but cannot run a CLI, reach the network, or hold a secret: a process in a container with a bind mount, a CI job on a shared volume, a shell hook.
Every regular file that is not a dotfile or `.tmp` is one event, in modification-time order: the name up to the first dot is the kind, a suffix after it keeps two facts apart, and a JSON object body is the payload, with `file` added; any other body is carried as `payload.body`.
A writer writes under a `.tmp` name and renames.
The file is removed once its event is logged, or moved into `archive` when set; the directory is created when absent; `every` is five seconds by default.

```yaml
sources:
  drops: { type: dir, path: drops, every: 2s, archive: drops/.done }
```

**A module path** - `type: ./sources/mine.ts`, relative to the configuration file - loads a custom source: the module exports `create(config)` returning the same contract, and every other key on the source is the module's own option.

## Rules

```yaml
rules:
  - name: sentry-to-owner
    on: { source: sentry, kind: issue.created }
    run: scripts/sentry/file.sh
    limit: 10/hour

  - name: sweep
    on: { source: clock }
    run: scripts/sweep.sh

  - name: sweep-now
    on: { source: tasks_cli, kind: task.todo }
    run: scripts/sweep.sh
    debounce: 5s

  - name: pr-merged
    on: { source: github, kind: pull_request.closed, merged: true }
    run: scripts/merged.sh

  - name: nightly
    on: { source: clock, cron: "0 2 * * *" }
    run: scripts/checkpoint.sh
    timeout: 30m

  - name: main-commit
    on: { source: repo, kind: commit, branch: main }
    run: >-
      scripts/notify.sh "{{ sha }}" "{{ subject }}" "{{ paths | join: ', ' }}"

  - name: session-exited
    on: { source: drops, kind: exited }
    run: heai-flow advance "{{ flow }}" exited --data "$(jq -c .payload "$REACTOR_EVENT")" --by reactor
```

| key | meaning |
| --- | --- |
| `name` | unique among rules; names the rule's state and its action records |
| `on` | what to match; absent, every event |
| `run` | the command |
| `debounce` | collapse a burst into one run after the window, on the burst's last event; every key in the burst counts as acted |
| `limit` | `10/hour`, `3/day`: runs per window; events over the cap are recorded as limited, not run and not deduped, so `replay` can act on them later |
| `repeat` | `true` to fire again on a key already acted on; by default a rule fires once per key, ever |
| `timeout` | kill the command after a duration; the record says so |

**`on`** matches on `source`, `kind` (`*` is a wildcard, so `pull_request.*`), and `cron`, which filters a schedule source's ticks to the slots the expression names, so one minute clock serves every schedule.
Any other key is a dotted path into the payload that must equal the value: `branch: main`, `merged: true`, `tags.environment: production` or `tags: { environment: production }`.
A list in the payload matches when it contains the value.

**Templates** in `run` are rendered before the shell sees the command: `{{ path }}` into the payload, whose fields also sit at the top - `{{ payload.title }}` and `{{ title }}` are the same - plus `event.id`, `source`, `kind`, `key`, `at` and `rule`; two filters, `default` and `join`.
A list renders joined with `, `; a script that wants the types reads `REACTOR_EVENT`.

Any other key on a rule is refused at load.

## The `run` action

`run` executes the command with `/bin/sh -c` in the project directory, its output in a log beside the action record.
The environment carries the event:

| variable | value |
| --- | --- |
| `REACTOR_EVENT` | path of a JSON file holding the whole event |
| `REACTOR_ID`, `REACTOR_SOURCE`, `REACTOR_KIND`, `REACTOR_KEY`, `REACTOR_AT`, `REACTOR_RULE` | the event's own fields and the rule's name |
| `REACTOR_<FIELD>` | every scalar payload field, upper-cased |
| `REACTOR_PAYLOAD_<FIELD>` | a payload field named `id`, `kind`, `event`, `source`, `key`, `at` or `rule`, so the event's own values are never shadowed |

Exit `0` is success; anything else is recorded as a failure with the code, and `heai-reactor retry <event>` runs it again.

```sh
#!/bin/sh
# scripts/sentry/file.sh
echo "$REACTOR_KIND $REACTOR_KEY: $REACTOR_TITLE ($REACTOR_URL) by rule $REACTOR_RULE" >> sentry.log
```

## State

```
reactor/
  .gitignore                         `*`
  events/<YYYY-MM-DD>.jsonl          one line per event, under the date the event carries
  actions/<event-id>.<rule>.json     what a rule did: the command, the exit, the log; or that it was limited
  actions/<event-id>.<rule>.log      the run's output; .event.json beside it is what the script was given
  sources/<name>.json                each source's cursor
  rules/<name>.json                  a rule's pending debounce, its limit window, its last action
  keys/<sha256 of rule@key>          the dedupe set, one file per key a rule has acted on
```

A restart resumes from the cursors.

## The CLI

```
heai-reactor status [--json]                          sources and their cursors, rules and their last action, the last hour
heai-reactor tick                                     one pass: poll every source once, run the rules, exit
heai-reactor serve [--port 4949] [--host 127.0.0.1]   the daemon: schedules, polls, the webhook receiver
heai-reactor emit <source> <kind> [--key <key>] [--payload '<json>' | --payload -] [--at <iso>] [--act]
heai-reactor events [--since 24h] [--source s] [--kind k] [--json]   the log, each event with the actions rules took on it
heai-reactor retry <event-id>                         every rule for one event again, ignoring dedupe and debounce
heai-reactor replay --since <t> [--rule <r>] [--dry-run]
heai-reactor test <rule> --event <file.json>          one rule against one event, dry
```

- **`tick`** is for a machine with a system cron and no daemon. A webhook source reports that it cannot run under `tick`; a debounce fires on the first tick after its window closes.
- **`serve`** is one process, restartable, stopped by `SIGINT` or `SIGTERM` after the runs in flight finish.
- **`emit`** appends one event to a `cli` source and prints its id. `--payload -` reads the object from stdin; `--at` dates the event. With `--act`, the rules run for that event at once, the decisions are printed, and the event is marked handled; a rule that failed is exit `1`. An unknown source, a source of another type, a refused kind, or a payload that is not a JSON object is exit `2`, and nothing is logged.
- **`events`** prints the log, oldest first, and beside each event what every rule did with it: `<rule> → ok`, `→ limited`, or the error. Under `--json` each event carries its `actions`, the records under `actions/` verbatim, so a reader need not walk that directory.
- **`retry`** runs every rule for one event again.
- **`replay`** runs the rules over logged events again with dedupe still holding: how a new rule acts on what it missed, and how limited events are picked up. `--dry-run` prints what would happen and touches nothing.
- **`test`** reads `{ source, kind, key, payload }` from a file and prints whether the rule matches and the rendered command.

Common options: `--dir`, the project directory, where commands run and relative paths resolve (default: the current directory, else `HEAI_DIR`); `--config`, the configuration file (default: `.heai/reactor.yaml` when `.heai/` exists under the project directory, else `reactor.yaml` in it); `--state`, the state directory (default: `reactor` beside the configuration; `HEAI_REACTOR_STATE`).

| exit | meaning |
| --- | --- |
| `0` | done |
| `1` | a script exited non-zero, or `test`'s rule does not match |
| `2` | bad usage, a configuration that does not read, an unknown event, rule or source type, an `emit` the source refuses, a source that could not start |

## Configuration: `reactor.yaml`

[`schemas/reactor.schema.json`](schemas/reactor.schema.json) is the formal definition: JSON Schema, draft 2020-12, with every key, every source type's options, every rule key, and durations, limits and names as patterns.
A configuration is validated against it when read, every problem at once with its path in the file, exit `2`; what the schema cannot say - a rule listening to an undeclared source, two rules with one name, a cron that does not parse, an unknown provider - is checked after it.
An absent file is an empty configuration.

```yaml
concurrency: 4                        # commands running at once
receiver: { host: 127.0.0.1, port: 4949 }
sources:
  clock:     { type: schedule, cron: "* * * * *" }
  sentry:    { type: webhook, path: /hook/sentry, provider: sentry, secret: env:SENTRY_HOOK_SECRET }
  tasks_cli: { type: cli, kinds: [task.todo, task.done] }
rules:
  - { name: sweep,           on: { source: clock },                         run: scripts/sweep.sh }
  - { name: sentry-to-owner, on: { source: sentry, kind: issue.created },    run: scripts/sentry/file.sh, limit: 10/hour }
  - { name: sweep-now,       on: { source: tasks_cli, kind: task.todo },     run: scripts/sweep.sh, debounce: 5s }
```

A duration is a whole number and a unit - `500ms`, `5s`, `10m`, `2h`, `1d` - or a bare number of seconds.
A limit is `<count>/minute`, `/hour`, `/day` or `/week`.
The receiver binds loopback; TLS and exposure are the deployment's business.

## Tests

```sh
npm test
npm run typecheck
```

Every YAML block in this README is validated against the schema, and together they load as one configuration.

## Layout

```
tools/reactor/
  package.json            @heai-tools/reactor, Node 22.18+, two dependencies: yaml, ajv
  schemas/
    reactor.schema.json   the formal definition of reactor.yaml
  src/
    cli.ts                the commands
    reactor.ts            the engine: tick, serve, emit, retry, replay, test
    config.ts             reactor.yaml: the schema pass, then what it cannot say; durations and limits
    paths.ts              discovery: the project directory, the configuration, the state directory
    events.ts             the log, ids, keys, cursors, rule state, action records
    rules.ts              matching and the template context
    template.ts           {{ path | default | join }}
    cron.ts               five fields, names, aliases; previous, next and missed slots
    run.ts                the one action: a command with the environment contract
    pool.ts               the concurrency cap over the commands
    receiver.ts           the HTTP listener for posts
    source.ts             the source contract, the context, the module-path loader
    sources/              schedule, git, webhook, poll, cli, dir
    providers/            github, sentry, vercel, generic; sign.ts for the HMACs
  test/
    fixtures/             one recorded body per provider
    *.test.ts             one file per module, config.test.ts for the schema and this README, cli.test.ts end to end
```

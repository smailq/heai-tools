# watcher - design

*Design, 2026-09-04. Written before implementation; the README replaces it once the tool exists.*

Turns things that happen - a clock reaching a time, a branch moving, a third-party service raising an alert, a health check failing - into work: a task filed for a territory's owner, or an actor woken through agent-host.
One tool, because the rule is the same whatever happened; the sources of what happened are plugins, because a cron tick, a git poll and a webhook from Sentry have nothing in common but the event they produce.

## One tool or two

The question was whether schedules and change detection should be separate tools.
They should not, for one reason: everything after the event is identical.
A rule matches an event, dedupes and rate-limits it, and does one of a small set of things - file a task, assign an actor, run a command.
Splitting the tools would mean two rule engines, two event logs, two pages, and a third tool the moment someone wants "every Monday *and* when the deploy fails".

What differs is how events arrive, and that is exactly the shape of a plugin: agent-host has sources for code and images for harnesses, integrator has hosts, watcher has **event sources**.
A schedule is a source whose events are ticks.
A repository is a source whose events are commits on watched branches.
A webhook receiver is a source whose events are what services post to it.
A poller is a source whose events are changes in what a URL answers.
The one real difference - a webhook receiver must be reachable from the internet, the others need nothing - is a deployment concern of that source, and the design keeps it there.

## The shape of it

```
  sources ──► events (jsonl, append-only) ──► rules ──► actions
  schedule      { source, kind, key, at,      when a     file a task for a territory's owner
  git             payload }                   rule       assign an actor through agent-host
  webhook                                     matches    run a command
  poll                                        (deduped,  (each recorded beside the event)
                                              limited)
```

- **An event is a fact, written once.** `{ id, source, kind, key, at, payload }`, appended to `watcher/events/<date>.jsonl`. `key` is what makes two deliveries of the same thing one event - a commit SHA, a Sentry issue id, a cron slot - so a source may be at-least-once and the log still says each thing once.
- **A rule is a line in `watcher.yaml`.** It names what it listens for and what it does, with a debounce and a rate limit.
  Rules are the human's; a source never decides what to do with what it saw.
- **An action is one of three things**, chosen so the human stays where the map put them.
  **File** creates a tracker task in a territory, routed to its owner by the map, human or llm-agent - the default, because an alert from a service is a claim, and a task is where a claim gets triaged.
  **Assign** hands an actor a prompt or a task through agent-host, for work that is safe to start without a human: a nightly sweep, a re-run of a flaky benchmark.
  **Run** executes a command, for everything else: `integrator checkpoint website`, a notification script.
- **Nothing runs unless `watcher serve` or `watcher tick` does.** The daemon is the sources' clock and the webhook receiver's listener; `tick` does one pass for a system cron. There is no other process, and every action taken is a file beside the event that caused it.

## What comes from the map

An actor's **`watches`** is where the map and the watcher meet.
A rule may say `for: maintainer` instead of naming territories, and the watcher reads which territories that actor watches; a git event whose paths resolve to one of them, or a filed task in one of them, is that actor's business.
The map stays the one place an observer role is declared, and the rule stays short.

Territory resolution is the map's, read here again as the other tools read it: a path resolves to a territory through the globs, a territory to its owner through the parent chain.
A `file` action never names an owner; it names a territory, and routing is the tracker's.

## Sources

Each is a plugin behind one contract (`src/source.ts`): start, stop, and emit events with a stable `key`.
Four ship.

**`schedule`.** Cron expressions, evaluated in the daemon's clock, one event per slot with `key: <rule>@<slot>`, so a daemon restarted inside a slot does not fire it twice, and a missed slot while nothing was running is reported, not replayed - a nightly sweep that was skipped is not three sweeps at nine in the morning.

```yaml
sources:
  nightly: { type: schedule, cron: "0 2 * * *" }
```

**`git`.** Polls a repository's branches - by default the base and every integration lane - and emits one event per new commit with the changed paths, resolved to territories, in the payload.
Also emits `branch-created` and `branch-deleted`, and `run-finished` when an agent-host run record beside the map goes terminal, read the way integrator reads them.

```yaml
sources:
  repo: { type: git, path: ../awareness3, branches: [main, "integration/*"], every: 60s }
```

**`webhook`.** An HTTP listener, loopback by default, with one path per named hook and a secret per hook.
Providers are thin parsers that turn a body into `{ kind, key, payload }`: `github` (push, pull_request, issues, check_run), `sentry` (issue created, regressed, resolved), `vercel` (deployment succeeded, failed), `generic` (any JSON, `key` from a JSON pointer).
Signatures are checked per provider (`X-Hub-Signature-256`, `Sentry-Hook-Signature`, a bearer for generic), and an unsigned or unverifiable post is logged and dropped, never an event.

```yaml
sources:
  sentry:  { type: webhook, path: /hook/sentry, provider: sentry, secret: env:SENTRY_HOOK_SECRET }
  vercel:  { type: webhook, path: /hook/vercel, provider: vercel, secret: env:VERCEL_HOOK_SECRET }
```

Reaching it from the internet is the deployment's business: `tailscale funnel`, a reverse proxy, a tunnel.
The tool binds loopback and documents that the receiver must sit behind something that terminates TLS, the same posture as every server here.

**`poll`.** Fetches a URL on an interval and emits an event when the answer changes: status code, a JSON pointer's value, or a body hash.
Uptime, a third-party status page, a dependency's latest version.

```yaml
sources:
  api-health: { type: poll, url: https://api.example.com/health, every: 5m, watch: status }
  stripe:     { type: poll, url: https://status.stripe.com/api/v2/status.json, every: 10m, watch: /status/indicator }
```

A fifth source is a module path, as agent-host's source and integrator's host are.

## Rules

```yaml
rules:
  - name: sentry-to-owner
    on: { source: sentry, kind: issue.created }
    file:
      territory: "{{ payload.tags.territory | default: 'website' }}"
      title: "Sentry: {{ payload.title }}"
      body: |
        {{ payload.url }}
        {{ payload.culprit }} - {{ payload.count }} events, first seen {{ payload.firstSeen }}.
      priority: high
    limit: 10/hour

  - name: nightly-health-sweep
    on: { source: nightly }
    assign:
      for: maintainer                 # the actor; its watched territories are in its prompt
      prompt: "Nightly sweep: read the logs and test results for the territories you watch; file one request per finding."

  - name: deploy-failed
    on: { source: vercel, kind: deployment.failed }
    file: { territory: website, title: "Deploy failed: {{ payload.name }}", body: "{{ payload.url }}", priority: urgent }
    debounce: 10m

  - name: lane-moved
    on: { source: repo, kind: commit, branch: integration/website }
    run: integrator checkpoint website
    debounce: 2m

  - name: core-changed-tell-desktop
    on: { source: repo, kind: commit, branch: main, territory: core }
    file:
      territory: desktop
      title: "core changed on main: {{ payload.subject }}"
      body: "{{ payload.sha }} touched {{ payload.paths | join: ', ' }}. Check the desktop build against it."
```

- **`on`** matches on source, kind, and any payload field; `territory:` matches an event whose paths resolve into that territory or a child of it; `for: <actor>` matches the territories the actor watches.
- **Templates** are the small `{{ }}` kind - a path into the payload, `default`, `join` - and nothing else; a rule that needs logic runs a command.
- **`debounce`** collapses a burst into one action after the window; **`limit`** caps actions per window and files one task saying the cap was hit rather than silently dropping.
- **Dedupe** is the event's `key`: a rule fires once per key, ever, unless it says `repeat: true`. A Sentry issue that keeps posting does not keep filing.
- **`file`** goes through the task-manager CLI, `todo`, with a provenance line naming the rule, the event id and the source, so a task reads where it came from.
  A task already filed for the same key is not filed again; the rule may `note:` the existing one instead.
- **`assign`** goes through the agent-host CLI, and refuses when the actor is not up - the refusal is recorded as the action's outcome, and the event is not lost: `watcher retry <event>` exists.
- **`run`** is a command with the event as `WATCHER_EVENT` (a path to its JSON) and its fields as `WATCHER_*` variables.

## What keeps it honest

- **Facts and decisions are separate files.** The event log says what happened; `actions/` says what was done about it and by which rule. A rule change does not rewrite history, and `watcher replay --since <date> --rule <name> --dry-run` shows what a new rule would have done.
- **The default action files a task.** An external event becomes a claim in the tracker, triaged by the territory's owner, human or agent, under whatever dispatch policy agent-host has. Waking an actor directly is a rule the human wrote, per rule.
- **A source is never trusted to act.** It emits; the rule decides.
- **Limits fail loud.** A rate cap or a refused assignment produces a task or a note, never a dropped event.
- **The receiver verifies before it believes.** No signature, no event.

## State: files beside the map

```
watcher/
  .gitignore                    `*`
  events/<YYYY-MM-DD>.jsonl     one line per event
  actions/<event-id>.<rule>.json   what a rule did: file → slug, assign → run id, run → exit and log path
  sources/<name>.json           each source's cursor: last cron slot, last SHA per branch, last poll answer
  keys/<sha256-of-key>          the dedupe set, one empty file per key a rule has acted on
```

`watcher status` lists sources with their cursors and last event, rules with their last action, and the last hour of events.
`watcher events [--since] [--source] [--kind]` prints the log; `watcher retry <event-id>` re-runs the rules for one event; `watcher replay` as above.

## The CLI

```
watcher status
watcher tick                            one pass: poll every source once, run the rules, exit
watcher serve [--port 4949]             the daemon: schedules, polls, the webhook receiver, and the page
watcher events [--since 24h] [--source s] [--kind k] [--json]
watcher retry <event-id> | replay --since <t> [--rule <r>] [--dry-run]
watcher test <rule> --event <file.json>  run one rule against one event, dry
```

`tick` is for a machine that already has cron and no daemon: sources that need a listener report that they cannot run under `tick`, and everything else works.
`serve` is the normal mode, one process, restartable: cursors are files, so a restart resumes where it left off.

Common options, defaults and exit codes follow the other tools: `--map`, `--tasks`, `--state` (`watcher` beside the map), `--config` (`watcher.yaml` beside the map); `0` done, `1` a rule refused or an action failed, `2` bad usage or a source that could not start.

## The page

`/`: sources with a green or amber dot and their last event, the recent event stream, and each rule's last action - the operations view of "is anything watching, and what did it do".
`/event/<id>`: the event, and every action it caused with links to the task, the run or the log.
`/rule/<name>`: its matches over time.
Plain pages, server-sent events for the stream, loopback and same-origin like the rest; the webhook paths are the one thing served beyond loopback, and only behind the proxy the deployment provides.

## A worked day, on awareness3

```yaml
# watcher.yaml
sources:
  repo:    { type: git, path: ../awareness3, branches: [main, "integration/*"], every: 60s }
  nightly: { type: schedule, cron: "0 2 * * *" }
  sentry:  { type: webhook, path: /hook/sentry, provider: sentry, secret: env:SENTRY_HOOK_SECRET }
  vercel:  { type: webhook, path: /hook/vercel, provider: vercel, secret: env:VERCEL_HOOK_SECRET }
  supabase-status: { type: poll, url: https://status.supabase.com/api/v2/status.json, every: 15m, watch: /status/indicator }
```

With a `maintainer` llm-agent in the map watching `desktop`, `website` and `core`:

- 02:00 - `nightly` ticks; `nightly-health-sweep` assigns `maintainer` a prompt. It reads test results and logs across the three territories and files two requests: a flaky test in `core-retrieval`, a renderer warning in `desktop-renderer-ui`. Both become `todo` tasks routed to `core-reviewer` and `web-ui`, with the run id as provenance. The run ends `succeeded` with two requests filed.
- 09:14 - Sentry posts `issue.created` for the website. `sentry-to-owner` files `sentry-typeerror-in-checkout` in `website`, priority high, routed to `website-owner`; dispatch is manual, so it waits in `agent-host status` until a human assigns it.
- 09:40 - `website-owner`'s fix lands in `integration/website` through integrator; the lane is continuous, so it promotes; `repo` sees the commit on `main`; the `core-changed-tell-desktop` rule does not match, because the paths are website's.
- 10:05 - Vercel posts `deployment.failed`. `deploy-failed` files an urgent task; the same failure posting again at 10:07 is debounced.
- 11:30 - Supabase's status indicator goes from `none` to `minor`; the poll emits one event; a rule files a low-priority task in `website-supabase` and the return to `none` at 12:10 is a second event, noted on the same task.

Every one of those is a line in `events/2026-09-04.jsonl`, an action file, and a task or a run someone can find from the page.

## What v1 deliberately leaves out

- **Deciding anything.** Rules are declarative matches; a rule that needs judgement assigns an actor or runs a command.
- **Providers beyond four.** GitHub, Sentry, Vercel and generic JSON; each is a parser of thirty lines, and a fifth is a fifth file.
- **Delivery to chat.** A `run` action can call a notification script; the tool itself posts nowhere.
- **Exposure.** The receiver does not do TLS or tunnels.
- **Retries of sources.** A poll that fails is an amber dot and a note, not a retry storm; the next interval tries again.

## Open questions

1. **Whether `assign` should exist in v1, or every event should file a task and dispatch decide.** Filing keeps humans in the loop by default and reuses agent-host's `dispatch: auto` for the unattended case. `assign` is for the sweep that has no task - a prompt on a schedule. The design keeps it, with the rule the human wrote as the authorization.
2. **Whether the git source should watch agent-host and integrator records** (`run-finished`, `landed`) or those tools should append to the watcher's event log themselves. Reading their files keeps the tools independent; writing events would be the first time a tool writes into another's state. The design reads.
3. **Where secrets live.** `env:NAME` in the configuration, resolved from the daemon's environment, which the same env-file discipline as agent-host covers. A `file:` form is the alternative for a receiver run by a service manager.

## Layout

```
tools/watcher/
  DESIGN.md
  package.json            @heai-tools/watcher, Node 22.18+, one dependency: yaml (cron parsing written here, ~80 lines)
  src/
    cli.ts
    config.ts             watcher.yaml: sources, rules, limits
    map.ts                territories, owners, and each actor's watches (read again)
    events.ts             the log, ids, keys, cursors
    rules.ts              matching, templates, debounce, limits, dedupe
    actions.ts            file (task-manager CLI), assign (agent-host CLI), run
    source.ts             the source contract; sources/{schedule,git,webhook,poll}.ts; providers/{github,sentry,vercel,generic}.ts
    watcher.ts            tick, serve, retry, replay
    server.ts             the page, the API, the receiver
  test/
    rules.test.ts         matching, templates, debounce, limit, dedupe by key
    schedule.test.ts      cron slots, restart inside a slot, missed slots reported
    git.test.ts           commits on watched branches against a temporary repository, paths → territories
    webhook.test.ts       signature checks and each provider's parser against recorded bodies
    poll.test.ts          change detection on status, pointer and hash
    actions.test.ts       file/assign/run against fake CLIs
```

Implementation order: `events.ts` and `rules.ts` with the schedule source, which makes `tick` and the nightly sweep work with no network; then the git source; then the webhook receiver with the generic provider and one real provider recorded; then poll; then the page.

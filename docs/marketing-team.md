# A marketing operations team

*How a content program is run on heai-tools, 2026-09-10: one human who owns the brand and the publish button, a writer agent per channel, an analyst agent that runs the experiments, and automation that turns the calendar and the analytics into work. Read [`project.md`](project.md) first for the directory and the tools; this document is the marketing shape of them.*

A marketing program is a repository of files - drafts, brand voice, experiments, a playbook - worked on by a few agents and approved by a human, where the one rule that matters is that nothing publishes without a person saying so.
That is the same shape as a codebase with agents and a reviewer, and the tools were built for it.
The map says who may change what; the gate refuses a writer that touches the brand voice; `flow` writes the content lifecycle down with `by: [human]` on the publish move; `reactor` turns the weekly schedule and the metrics into tasks and says which landings need no person.
The domain - how to mine a quote, transform it per platform, score it against a rubric, run an experiment and promote a winner - comes from skills vendored into the content repository, such as those in [ai-marketing-skills](https://github.com/ericosiu/ai-marketing-skills), and no tool names them.

## The content repository

```
marketing/                          the governed repository (git), cloned into the pod
  .claude/skills/                   vendored skills at a pinned commit; present in every agent's workspace
  brand/                            human-owned: voice.md, style-guide.md, patterns.md, offer.md
  signals/atoms.json                mined quotes and other candidates
  content/
    linkedin/drafts/<slug>.md       one file per draft
    linkedin/published/<slug>.md
    x/…  newsletter/…
  experiments/<channel>/            experiments.json, playbook.json
  reports/scorecard-<date>.md
  scripts/publish.sh  metrics.sh    the connectors; the only things that talk to a platform
```

A draft's frontmatter carries what links it to everything else, and nothing more:

```yaml
---
title: Thread posts get 2x impressions
channel: linkedin
atom: a8f3c1                        # signals/atoms.json id
experiment: EXP-LINKEDIN-004        # or empty
variant: story-hook
score: 92                           # the reviewing panel's final aggregate
task: linkedin-week-37-batch        # the tracker slug that produced it
---
```

## The map

```yaml
# architecture.yaml
version: 1
unowned: fail

actors:
  lead:              { type: human, identity: '@lead' }
  linkedin-writer:
    type: llm-agent
    context: |
      You write LinkedIn posts in the brand voice under brand/. Read experiments/linkedin/playbook.json
      first and apply every rule in it. Score every draft with the panel; do not finish one under 90 unless
      three rounds have passed, and say so in its frontmatter. Ask nothing; everything you need is in brand/.
  x-writer:          { type: llm-agent, context: 'You write posts for X: short, one idea each, in the brand voice.' }
  newsletter-writer: { type: llm-agent, context: "You write the weekly newsletter from the week's published pieces." }
  growth-analyst:
    type: llm-agent
    context: You run the experiments and mine the signals. You never write copy and never edit a draft.
  editor:
    type: llm-agent
    context: You review drafts against brand/ and the rubric. You file a request per weakness; you never edit.
    watches: [linkedin, x, newsletter]

repositories:
  marketing: { remotePath: github.com/example/marketing, localPath: ../marketing }

territories:
  brand:       { owner: lead,              scope: [{ repository: marketing, globs: ['brand/**'] }] }
  connectors:  { owner: lead,              scope: [{ repository: marketing, globs: ['scripts/**', '.claude/**'] }] }
  signals:     { owner: growth-analyst,    scope: [{ repository: marketing, globs: ['signals/**'] }] }
  experiments: { owner: growth-analyst,    scope: [{ repository: marketing, globs: ['experiments/**', 'reports/**'] }] }
  linkedin:    { owner: linkedin-writer,   scope: [{ repository: marketing, globs: ['content/linkedin/**'] }], dependsOn: [brand] }
  x:           { owner: x-writer,          scope: [{ repository: marketing, globs: ['content/x/**'] }],        dependsOn: [brand] }
  newsletter:  { owner: newsletter-writer, scope: [{ repository: marketing, globs: ['content/newsletter/**'] }], dependsOn: [brand, linkedin, x] }
```

Three things the map buys that the skills do not have on their own:

- **A writer cannot edit the brand voice, the rejection patterns or the publish script.** `brand/` is the human's, so a writer that "fixes" `patterns.md` to make its draft pass fails the gate before anyone reads the draft. The skill's "add a pattern on rejection" becomes a request the writer files to `brand`, a task the human reads and approves, which is what a learned rule should be.
- **A writer cannot log experiment data.** `experiments/` is the analyst's, and the engine rewrites `experiments.json` whole, so two writers logging on two branches would conflict at landing. Writers read the playbook and never write it.
- **The reviewer is declared, not improvised.** `editor` watches every channel and owns none: it files a request per weakness instead of editing, and the writer's resumed session makes the edit.

## The team

| member | kind | owns | does |
| --- | --- | --- | --- |
| `lead` | human | `brand`, `connectors` | the brand voice, the map, the rules; reads and lands every batch of copy; publishes |
| `linkedin-writer`, `x-writer`, `newsletter-writer` | llm-agent | one channel each | draft from atoms and the playbook, score with the panel, commit drafts |
| `growth-analyst` | llm-agent | `signals`, `experiments` | mines signals weekly, logs metrics, scores experiments, writes the scorecard, files tasks for writers |
| `editor` | llm-agent | nothing | reviews a batch and files requests |
| the rules and the hooks | automation | nothing | start the weekly runs, gate diffs, land the analyst's data, run the quality gate, file tasks from playbook changes and pacing alerts |

## The directory

```
<project>/
  architecture.yaml
  tasks/
  flows/session.yaml  request.yaml  landing.yaml  checkpoint.yaml  release.yaml  piece.yaml  experiment.yaml
  scripts/session/…                 as the software team's: pick, start, finish, ask, requeue
  scripts/landing/…  scripts/checkpoint/…  scripts/release/…
  scripts/content/mine.sh  piece.sh  readback.sh  playbook-changed.sh  rejected.sh  pacing.sh
  images/marketing/Containerfile    FROM ${BASE}: python3, numpy, scipy, feedparser, the agents
  pod.yaml  reactor.yaml
```

The session, landing, checkpoint and release definitions and their scripts are the software team's: a writer's batch is a session, its drafts land into `main` through a landing, the checkpoint on the landed head is the deterministic quality gate, and publishing is a release.
There is no promotion; a batch that lands and passes its checkpoint is approved.

## The flows

Two definitions are the marketing team's own.
A **piece** is one draft, from candidate to measured, moved by the batch's landing, its checkpoint and its release:

```yaml
# flows/piece.yaml
name: piece
states: [candidate, drafting, drafted, in-review, approved, published, measured, rejected]
initial: candidate
terminal: [measured, rejected]
links:
  channel:    { required: true }
  task:       { required: false }
  session:    { required: false }
  experiment: { required: false }
transitions:
  - { from: candidate, to: drafting,  on: assigned,  by: [piece.sh] }
  - { from: drafting,  to: drafted,   on: exited,    when: { exitCode: 0 }, by: [piece.sh] }
  - { from: drafting,  to: candidate, on: exited,    by: [piece.sh] }              # a failed run; try again
  - { from: drafted,   to: in-review, on: landed,    by: [human, land.sh] }        # the batch landed into main
  - { from: drafted,   to: rejected,  on: refused,   by: [human] }
  - { from: in-review, to: approved,  on: checked,   when: { failed: 0 }, by: [check.sh] }   # the quality gate passed
  - { from: in-review, to: rejected,  on: checked,   by: [check.sh] }
  - { from: in-review, to: rejected,  on: refused,   by: [human] }
  - { from: approved,  to: published, on: released,  by: [release.sh] }            # release.sh ran publish.sh
  - { from: published, to: measured,  on: readback }                                # the analyst's fact, through the inbox
  - { from: published, to: measured,  on: stale,     after: 14d }                   # no readback in two weeks: closed as-is
hooks:
  rejected: { run: scripts/content/rejected.sh }                                    # a task to lead: a pattern for patterns.md?
```

An **experiment** mirrors the engine's own statuses, with the engine's id as the flow's id, so `flow start experiment --id EXP-LINKEDIN-004` makes the two records one string:

```yaml
# flows/experiment.yaml
name: experiment
states: [running, trending, keep, discard]
initial: running
terminal: [keep, discard]
links: { channel: { required: true }, variable: { required: true } }
transitions:
  - { from: running,  to: trending, on: scored, when: { status: trending } }
  - { from: running,  to: keep,     on: scored, when: { status: keep } }
  - { from: running,  to: discard,  on: scored, when: { status: discard } }
  - { from: trending, to: keep,     on: scored, when: { status: keep } }
  - { from: trending, to: discard,  on: scored, when: { status: discard } }
  - { from: trending, to: running,  on: scored, when: { status: running } }
hooks:
  keep: { run: scripts/content/playbook-changed.sh }                               # a task to every writer on that channel
```

The analyst records a score from inside the container by dropping a fact file into the flow's mounted inbox, `{"status":"keep"}` as `scored`, which is the whole protocol and needs no CLI in the image.
A piece links `experiment=EXP-LINKEDIN-004`, so `flow trace EXP-LINKEDIN-004` prints every draft that was a variant of it, which session wrote each, when it landed, when it published, and what came back.

The `by:` rules on the piece are the "separately approved" gates written as a file: nothing but a landing moves a piece past `drafted`, nothing but a passing checkpoint past `in-review`, nothing but a release reaches `published`, and whether a landing needs a person is a rule below.

## The rules

```yaml
# reactor.yaml
sources:
  clock:     { type: schedule, cron: "* * * * *" }
  tasks_cli: { type: cli, kinds: [task.todo] }
  landings:  { type: cli, kinds: [landing.proposed] }
  repo:      { type: git, path: ../marketing, branches: [main], every: 60s }
rules:
  - { name: settle,       on: { source: clock },                                                   run: flow settle }
  - { name: pick-writers, on: { source: clock },                                                   run: "scripts/session/pick.sh linkedin-writer 1 && scripts/session/pick.sh x-writer 1 && scripts/session/pick.sh newsletter-writer 1" }
  - { name: pick-analyst, on: { source: clock },                                                   run: scripts/session/pick.sh growth-analyst 1 }
  - { name: pick-now,     on: { source: tasks_cli, kind: task.todo },                              run: scripts/session/pick.sh --for-task, debounce: 5s }
  - { name: land-data,    on: { source: landings, kind: landing.proposed, actor: growth-analyst }, run: scripts/landing/land.sh }
  - { name: mine,         on: { source: clock, cron: "0 6 * * 1" },                                run: scripts/content/mine.sh }
  - { name: readback,     on: { source: clock, cron: "0 6 * * 4" },                                run: scripts/content/readback.sh }
  - { name: pacing,       on: { source: clock, cron: "0 8 * * *" },                                run: scripts/content/pacing.sh }
  - { name: playbook,     on: { source: repo, kind: commit, paths: ["experiments/*/playbook.json"] }, run: scripts/content/playbook-changed.sh }
```

Reading it as policy: every writer and the analyst get one session at a time; the analyst's landings - signals and scores, data rather than copy - are landed by `land.sh` the moment they are proposed; a writer's landing has no rule, so every batch of copy waits for `lead` to read and land it.
No rule starts a release: publishing is a person's `flow start release`.

## The scripts

The session, landing, checkpoint and release scripts are the software team's.
`checkpoint/check.sh` runs the deterministic quality gate over the landed drafts instead of a test suite; the marketing team adds:

| script | fires on | does |
| --- | --- | --- |
| `content/mine.sh` | Monday 06:00 | `tasks new` for `growth-analyst`: run the quote miner over the last seven days, commit `signals/atoms.json`, and file one task per channel naming the top atoms for it; the analyst's `pick` rule starts the session |
| `content/piece.sh` | called by `start.sh` when the task's territory is a channel | `flow start piece --link channel= --link task= --link session=` per atom the task names, `assigned`; on the session's `exited`, `drafted` or back to `candidate` |
| `content/readback.sh` | Thursday 06:00 | `tasks new` for `growth-analyst`: for each published piece without a readback, fetch metrics through `scripts/metrics.sh`, log them, score every running experiment, suggest the next variable, write the scorecard, and drop a `scored` fact per experiment and a `readback` fact per piece |
| `content/playbook-changed.sh` | `experiment.keep`, and the `playbook` rule | `tasks new` in each affected channel: "the playbook gained *hook_style: story*; apply it from now on" - the learning step, as a task, because agents cooperate through the tracker |
| `content/rejected.sh` | `piece.rejected` | `tasks new` for `lead` with the refusal note: is this a new entry for `patterns.md`? |
| `content/pacing.sh` | daily 08:00 | the pacing check against targets; each alert is a task for `lead` |

`scripts/publish.sh` and `scripts/metrics.sh` live in the content repository, owned by `lead`, and are what the release script and the readback run call.
The first version of `publish.sh` may print what it would post; the whole loop still runs.

## A worked week

- **Monday 06:00** - the `mine` rule files a task for `growth-analyst`; the `pick-analyst` rule starts a session. The analyst mines the week's signals, commits `signals/atoms.json`, files `linkedin-week-37-batch`, `x-week-37-batch` and `newsletter-week-37` with the top atoms for each channel. The session's diff is all `signals/`; the gate is clean; a landing is proposed with `actor: growth-analyst`; the `land-data` rule lands it.
- **Monday 06:20** - the `pick-writers` rule gives `linkedin-week-37-batch` to `linkedin-writer`. `start.sh` opens a workspace on `main`, `piece.sh` starts a `piece` per atom, and the prompt is `architect context linkedin-writer` plus the task. The writer reads the playbook, drafts one variant per running experiment, runs the panel, commits `content/linkedin/drafts/*.md`, and settles. The gate finds only `content/linkedin/**`; the session is `clean`; the pieces are `drafted`; a landing is proposed in `linkedin`. No rule matches a writer's landing, so it waits.
- **Monday 09:00** - `lead` sees three proposed landings on `operator`, reads the drafts from the worktrees, and lands the LinkedIn batch: `scripts/landing/land.sh <landing> --by human`. The pieces are `in-review`; entering `landed` starts a checkpoint; `check.sh` runs the quality gate over the landed drafts and advances `checked` with `failed: 0`; the pieces are `approved`. One draft `lead` does not want is refused with a note before landing; that piece is `rejected`, and `rejected.sh` files a task asking whether the note is a new pattern. `lead` writes the pattern into `brand/patterns.md` in a commit, being its owner.
- **Monday 10:00** - the X writer's panel found the brand voice itself was the problem for one atom. It does not edit `brand/`; it files a request to `brand` and finishes `blocked`. `lead` reads the request, declines it with a note, and the session resumes without that atom.
- **Tuesday 09:00** - `lead` publishes: `flow start release --link head=$(git -C ../marketing rev-parse main) --link version=2026-w37`; entering `open` runs `release.sh`, which runs `scripts/publish.sh` on that head, as the human, so no writer ever held a platform credential. The script posts each approved draft, moves it to `published/`, and logs a `published` data point on each draft's experiment. The pieces are `published`.
- **Thursday 06:00** - the `readback` rule files the analyst's task. The analyst fetches metrics, logs them, scores every experiment, writes `reports/scorecard-2026-w37.md`, and drops a `readback` fact per piece and a `scored` fact per experiment. `EXP-LINKEDIN-004` goes `keep`; the engine promotes its rule into `playbook.json`; the `land-data` rule lands the commit.
- **Thursday 06:40** - the `playbook` rule sees the commit on `main` touching `experiments/linkedin/playbook.json` and `playbook-changed.sh` files a task for `linkedin-writer`: apply *hook_style: story* from now on. Next Monday's batch reads the new playbook first.
- **Friday 08:00** - `pacing.sh` finds the newsletter behind its target; the alert is a task for `lead`, who decides whether to add a send.

`flow trace EXP-LINKEDIN-004` reads the experiment across every variant, session, landing, release and readback; `flow trace task=linkedin-week-37-batch` reads the batch.

## Where a human steps in

- **At the brand.** `brand/` changes only by `lead`'s commit; every learned pattern arrives as a task or a request first.
- **At every batch of copy**, reading the drafts before landing them, because no `land` rule names a writer.
- **At publishing**, always: only a person starts a release.
- **At a refusal**, deciding whether the reason is a new pattern.
- **At requests into `brand` and `connectors`**, and at pacing alerts.
- **At the rules**, when a channel earns automatic landing: one line in `reactor.yaml`, reviewed as a diff.
- **At `flow stuck` and the red on `operator`**, when a script failed.

## Standing it up

```sh
mkdir ~/Code/marketing-project && cd ~/Code/marketing-project && git init
architect template > architecture.yaml && $EDITOR architecture.yaml && architect check
tasks init --dir tasks --map ../architecture.yaml
cp -r ~/Code/heai-tools/templates/software/{flows,scripts,reactor.yaml} .   # then add piece.yaml, experiment.yaml, scripts/content/, the rules above
mkdir -p images/marketing && $EDITOR images/marketing/Containerfile      # FROM ${BASE}; python3, numpy, scipy, feedparser, requests, claude-code, herdr integration
$EDITOR pod.yaml                                                        # images: { marketing/dev: images/marketing }, mounts: [./flow/flows:/heai/flow]
pod build && pod up --image marketing/dev --env-from ~/.heai/marketing.env && pod repo add marketing
reactor serve
operator
```

Phase it by trust.
First, only the `settle` rule: writers draft on branches under the map when a human starts a session, every landing is a person's, and `publish.sh` runs by hand; the gate already protects `brand/` and `experiments/`.
Then the `pick` rules, so the writers and the analyst take their own tasks.
Then `land-data`, so the analyst's data lands on its own, and the schedules, so the calendar files the work and the playbook rule closes the learning loop.
Publishing stays a human's act throughout.

## Beyond two skills

The same map absorbs more of the collection as territories and actors, with no new mechanism: an `seo-analyst` owning `seo/**` whose output is tasks for the writers; outbound sequences and lead lists as drafts that land and release like a piece, with the CRM touched only by the release script; podcast and video clipping as a session that needs `ffmpeg` in the image and a transcript in `signals/`, producing twenty drafts across channels.

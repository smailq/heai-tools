# Marketing automation on heai-tools

*Proposal, 2026-09-06. An idea report: how the skills in [ericosiu/ai-marketing-skills](https://github.com/ericosiu/ai-marketing-skills) - `growth-engine` and `content-ops` first - run as governed work on the tools in this repository, with no tool learning anything about marketing. Re-read against the source and mapped onto the project directory in [project-directory-rehash.md](project-directory-rehash.md), whose last section corrects what this report got wrong.*

## The claim

A marketing program is a repository of files - drafts, brand voice, experiments, a playbook - worked on by a few llm-agents and approved by a human, where the one rule that matters is that nothing publishes without a person saying so.
That is the same shape as a codebase with agents and a reviewer, and every tool here was built for that shape.
The map says who may change what; `agent-host` runs each agent in a container over its own branch; the gate refuses a boundary crossing; the lane scripts turn "land" and "release" into two separate human acts; `flow` writes the content lifecycle down as a state machine with `by: [human]` on the publish move; `watcher` turns the calendar and the analytics into tasks.
The marketing skills supply what the tools deliberately do not have: the domain - how to mine a quote, transform it per platform, score it against a rubric, run an experiment and promote a winner.

The skills are used *unchanged*: they are Claude Code skills and Python scripts, and an actor's container is a Claude Code with the repository mounted at `/work`, so a skill vendored under `.claude/skills/` in the marketing repository is simply there when the actor runs.
Nothing in `tools/` imports or names them.

## What the skills are

**`growth-engine`** is one script, `experiment-engine.py`, over a data directory (`GROWTH_ENGINE_DATA_DIR`, default `./data/experiments`): per channel ("agent" in its vocabulary: `content`, `email`, `linkedin`, `seo`, `blog`), an `experiments.json` and a `playbook.json`.
`create` makes an experiment with a hypothesis, a variable, variants and a metric; `log` records a data point per variant; `score` runs bootstrap confidence intervals and Mann-Whitney U and moves the experiment `running → trending → keep | discard`, promoting a `keep` into the playbook; `playbook` prints the proven rules; `suggest` names the next variable to test.
Two more scripts: `autogrowth-weekly-scorecard.py` writes a markdown report, and `pacing-alert.py` compares campaign metrics from external APIs against targets and exits `1` on an alert.
Its own stated workflow is: read the playbook before writing; `log` at publish; `score` periodically; scorecard weekly; `suggest` after.

**`content-ops`** is a skill and five scripts.
The skill is the **expert panel**: assemble 7-10 personas from `experts/<platform>.md` plus domain experts, always including the AI-writing detector at 1.5x weight and a brand-voice check against `references/patterns.md`; score against a rubric in `scoring-rubrics/`; revise and rescore until the aggregate is 90 or three rounds pass; on a human rejection, add a pattern to `patterns.md`.
The scripts: `quote-mining-engine.py` scans podcast feeds and notes for quotable atoms; `content-transform.py` turns an atom into X, LinkedIn, Short and newsletter drafts; `content-quality-scorer.py` is a deterministic five-dimension scorer (voice, specificity, slop, length, engagement); `content-quality-gate.py` runs it over a `drafts.json` and filters below a threshold; `editorial-brain.py` finds clip-worthy moments in a transcript.
All of them read and write JSON under `CONTENT_OPS_DATA_DIR`, with voice and style in `config/`.

The sibling `content-os-portable-starter` states the lifecycle the whole collection assumes:

```
SIGNAL → CANDIDATE → EVIDENCE_READY → DRAFT → REVIEW → APPROVED_FOR_DRAFT_WRITE
      → DRAFT_WRITTEN → APPROVED_FOR_PUBLISH → PUBLISHED → READBACK → LEARNING
```

with the rule that "each transition must be persisted, attributable, idempotent, and blocked when its required approval or evidence is absent".
That sentence is `flow`'s design in different words, and it is why the fit is real rather than forced.

## The marketing repository

Mirroring the `aw3-operator` layout: an operator directory holds the map and the tools' configuration, and points at a content repository beside it.

```
marketing/                         the governed repository (git)
  .claude/skills/
    growth-engine/                 vendored from ai-marketing-skills at a pinned commit
    content-ops/
  brand/                           human-owned: voice.md, style-guide.md, patterns.md, offer.md
  signals/atoms.json               mined quotes and other candidates
  content/
    linkedin/drafts/<slug>.md      one file per draft, frontmatter below
    linkedin/published/<slug>.md
    x/…  newsletter/…  shorts/…
  experiments/<channel>/           GROWTH_ENGINE_DATA_DIR: experiments.json, playbook.json
  reports/scorecard-<date>.md
  scripts/publish.sh               the connector; the only thing that talks to a platform

marketing-operator/                the heai data, as aw3-operator is for awareness3
  architecture.yaml
  tasks/
  agent-host.yaml  lanes.yaml  watcher.yaml  flow.yaml
  flows/piece.yaml  flows/experiment.yaml
  .heai/                           machine state, self-ignored
```

A draft's frontmatter carries what the tools need to link it to everything else, and nothing more:

```yaml
---
title: Thread posts get 2x impressions
channel: linkedin
atom: a8f3c1                       # signals/atoms.json id
experiment: EXP-LINKEDIN-004       # or empty
variant: story-hook
score: 92                          # the panel's final aggregate
rounds: 2
task: linkedin-week-37-batch       # the tracker slug that produced it
---
```

## The map

Territories are channels and the things around them; actors are one writer per channel, one analyst, one reviewer, and the human who owns the brand and the publish button.

```yaml
actors:
  lead:            { type: human }                 # owns brand/, scripts/, the map, publishing
  linkedin-writer: { type: llm-agent, context: "You write LinkedIn posts in the brand voice…" }
  x-writer:        { type: llm-agent }
  newsletter-writer: { type: llm-agent }
  growth-analyst:  { type: llm-agent, context: "You run experiments; you never write copy…" }
  editor:          { type: llm-agent, watches: [linkedin, x, newsletter] }   # reviews, never edits

territories:
  brand:        { paths: ["brand/**"],               owner: lead }
  connectors:   { paths: ["scripts/**"],             owner: lead }
  signals:      { paths: ["signals/**"],             owner: growth-analyst }
  linkedin:     { paths: ["content/linkedin/**"],    owner: linkedin-writer }
  x:            { paths: ["content/x/**"],           owner: x-writer }
  newsletter:   { paths: ["content/newsletter/**"],  owner: newsletter-writer }
  experiments:  { paths: ["experiments/**", "reports/**"], owner: growth-analyst }
```

Three things this buys, none of which the skills have on their own:

- **A writer cannot edit the brand voice, the rejection patterns, or the publish script.** `brand/` is the human's territory, so a writer that "fixes" `patterns.md` to make its draft pass is a gate violation on its run, marked before anyone reads the draft. The skill's Step 7 - "add a pattern on rejection" - becomes a request the writer files to `brand`, which is a task the human reads and approves, which is exactly what a learned rule should be.
- **A writer cannot log experiment data.** `experiments/` is the analyst's. `experiment-engine.py` rewrites `experiments.json` whole, so two writers logging at once on two branches would conflict at landing; one owner ends that. Writers *read* the playbook, which the prompt tells them to do, and never write it.
- **The reviewer is declared, not improvised.** `editor` watches every channel and owns none, so its prompt says "observed, not owned, file requests"; the expert panel run as a separate reviewing actor produces a request per weakness instead of an edit, and the writer's resumed run makes the edit. Whether to run the panel inside the writer's run (as the skill does) or as `editor` is a per-channel choice; both are legal under the map.

## The lifecycle as flows

Two definitions, shipped in the project directory, small and flat as `flow` wants them.

```yaml
# flows/piece.yaml - one content piece
name: piece
states: [candidate, drafting, drafted, in-review, approved, published, measured, rejected]
initial: candidate
terminal: [measured, rejected]
links:
  channel: { required: true }
  task:    { required: false }
  experiment: { required: false }
transitions:
  - { from: candidate, to: drafting,  on: assigned,  by: [agent-host, watcher] }
  - { from: drafting,  to: drafted,   on: exited,    when: { exitCode: 0 } }
  - { from: drafting,  to: candidate, on: exited }                        # a failed run; try again
  - { from: drafted,   to: in-review, on: landed,    by: [human, lanes] }    # a human landed the branch
  - { from: drafted,   to: rejected,  on: refused,   by: [human, lanes] }
  - { from: in-review, to: approved,  on: promoted,  by: [human, lanes] }
  - { from: in-review, to: rejected,  on: refused,   by: [human] }
  - { from: approved,  to: published, on: released,  by: [human, lanes] }   # release = publish.sh ran
  - { from: published, to: measured,  on: readback,  by: [growth-analyst, inbox] }
  - { from: published, to: measured,  on: stale,     after: 14d }          # no readback in two weeks: closed as-is
```

```yaml
# flows/experiment.yaml - mirrors growth-engine's own statuses
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
```

The experiment's flow id is the engine's own id - `flow start experiment --id EXP-LINKEDIN-004` - so the two records are one string, as `agent-host` does with run ids.
The analyst's run, inside the container, records a score by dropping a fact file: `echo '{"status":"keep"}' > /heai/flow/EXP-LINKEDIN-004/inbox/scored` - the whole protocol, no CLI in the image.
A piece links `experiment=EXP-LINKEDIN-004`, so `flow trace EXP-LINKEDIN-004` prints every draft that was a variant of it, which run wrote each, when it landed, when it published, and what came back.

The three `by:` rules on the piece definition are the content-os "separately approved" gates written as a file: no actor can move a piece past `drafted` - only a landing can, and a landing is a human running `scripts/lanes/land.sh`; and nothing but a release, which is a human running `scripts/lanes/release.sh`, reaches `published`.

## One piece, end to end

**Signal.** `watcher.yaml` has `mine-weekly: { type: schedule, cron: "0 6 * * 1" }` and a rule that assigns `growth-analyst` the prompt "run `quote-mining-engine.py --days 7`, commit `signals/atoms.json`, and file one task per channel naming the top atoms for it".
The run lands `signals/` through the `ops` lane (continuous, `land: auto` for the analyst - it is data, not copy) and files three tasks with `territory: linkedin`, `x`, `newsletter`.
The tracker routes each to its writer.

**Draft.** Under `dispatch: auto`, `agent-host` assigns `linkedin-week-37-batch` to `linkedin-writer`.
Its prompt is the map's context for the actor and territory, then the task body, then the host's rules.
The task body is where the skill's workflow is invoked, in the skill's own words: "Read `experiments/linkedin/playbook.json` first and apply every rule in it. For each atom, produce one draft per variant of any running experiment in `experiments/linkedin/experiments.json` whose variable this content can test, else one draft. Run the expert panel on each; do not finish a draft under 90 unless three rounds have passed, and say so in its frontmatter. Run `content-quality-gate.py` over the batch before you commit. Ask nothing; everything you need is in `brand/`."
The writer commits `content/linkedin/drafts/*.md` on `agent/linkedin-writer/linkedin-week-37-batch` and exits `0`; the gate finds only `content/linkedin/**` changed; the run is `succeeded`, clean; the `piece` flows go `drafted`.
If the panel found the brand voice itself was the problem, the writer instead files a request to `brand` ("add pattern: …") and finishes blocked, and the human decides.

**Review and approve.** The screen lists the run as a candidate for the `linkedin` lane.
The lane's checks are the deterministic gate re-run on the merge result - `python3 .claude/skills/content-ops/scripts/content-quality-gate.py --input <drafts as json>` - and `builtin:gate`.
The human reads the drafts on the run page, with the panel's rounds in the log, and runs `scripts/lanes/land.sh`; the piece is `in-review`.
The lane is `staged`: a checkpoint runs the checks, `promote` moves the batch to `main`, the pieces are `approved`.
A draft the human does not want is a refusal, noted on the task; the piece is `rejected` and the note is the material for a new `patterns.md` entry, which the human writes, being its owner.

**Publish.** `scripts/lanes/release.sh linkedin --version 2026-w37` runs the lane's publish step: `scripts/publish.sh linkedin`, which posts every approved draft through whatever connector the repository has, moves each file to `published/`, and - this is where the growth engine's "log at publish" step lives - calls `experiment-engine.py log --experiment-id … --variant … --metrics '{"published": 1}'` for each draft that carries an experiment.
It runs on the promoted head, as the human, so the writer never held a credential and the log write never conflicts with a writer's branch.
The pieces are `published`.

**Readback and learning.** A second schedule, three days after publish or weekly, assigns `growth-analyst`: "for each published piece without a readback, fetch its metrics through `scripts/metrics.sh`, `log` them, then `score` every running experiment, then `suggest`; write `reports/scorecard-<date>.md`; drop a `scored` fact per experiment and a `readback` fact per piece".
`score` promotes a winner into `playbook.json`; the run lands through the `ops` lane; the `git` source in `watcher` sees a commit on `main` touching `experiments/*/playbook.json` and files a task to every writer whose channel's playbook changed: "the playbook gained *hook_style: story*, apply it from now on".
That task is the LEARNING step closing the loop, and it is a task rather than a message because the map says agents cooperate through the tracker.
`pacing-alert.py` exiting `1` in the same run becomes one request per alert to `lead`, which is what an alert should be: a claim for a human to triage.

## What has to be built

Almost nothing in `tools/`; the work is a repository template and one image.

1. **A `marketing` image under `tools/agent-host/image/`.** The `claude` Containerfile plus `python3`, `pip install numpy scipy feedparser requests`, and `ffmpeg` if `editorial-brain.py` is wanted. Two files, as the contract says. Credentials the scripts want (`ANTHROPIC_API_KEY` for `content-transform.py`'s panel mode) come from the image's `envFile`; platform tokens do not go in it, because publishing is not the container's job.
2. **A `marketing` template**, probably a directory under `ideas/` or a separate repository: the map above, `agent-host.yaml` (`image: heai/agent-marketing`, `dispatch: auto`, `source: git`), `lanes.yaml` with one staged lane per channel and a continuous `ops` lane over `signals` and `experiments`, `watcher.yaml` with the three schedules and the playbook rule, and the two flow definitions.
3. **Two scripts in the content repository**, `publish.sh` and `metrics.sh`, which are the connectors and belong to `lead`. The first version can be "print what would be posted" - the content-os starter's own advice is to begin draft-only - and the whole loop still runs.
4. **A vendoring note.** The skills are copied in at a pinned commit; their preamble writes telemetry to `~/.ai-marketing-skills/` inside the container, which is harmless and should be opted out in the image; `skill-safety.yml` in the upstream repository is worth reading before the first vendor.

What the tools gain is a second kind of repository to prove themselves on: `flow` and `watcher` are designs today, and a content program is a smaller, faster, lower-stakes loop than a monorepo release to implement them against.

## Phasing, by what exists

| phase | needs | what works |
| --- | --- | --- |
| 1, now | `agent-host`, `tasks`, `architect` | writers draft on branches under the map; the human reviews and merges by hand; `publish.sh` by hand; the analyst run on a manual `assign`; the gate protects `brand/` and `experiments/` from day one |
| 2 | lane scripts | land / promote / release as three human acts with the deterministic gate as a lane check; the publish step becomes the release's `publish` |
| 3 | `flow` | the `piece` and `experiment` definitions; `by: [human]` on publish; `trace` from an experiment to every variant's draft and metrics |
| 4 | `watcher` | schedules replace the human's `assign`; the playbook-changed rule closes the learning loop; pacing alerts become tasks |

Phase 1 is a day's work given the tools as they are, and it already has the property the skills lack: an agent that reaches for the brand voice or the experiment log is refused by construction.

## Beyond the two skills

The same map absorbs the rest of the collection as more territories and actors, with no new mechanism:

- **`seo-ops`** and **`conversion-ops`** are an `seo-analyst` owning `seo/**` whose output is tasks for the writers, the analyst's pattern again.
- **`outbound-engine`** and **`sales-pipeline`** produce sequences and lead lists; both are drafts that land and release like a piece, and the release is where a CRM is touched, by the human's publish command, never by an actor.
- **`podcast-ops`** and the video skills are `editorial-brain.py` and clip cutting in a run that needs `ffmpeg` in the image and a transcript in `signals/`; their twenty outputs per episode are twenty drafts across channels.
- **`x-longform-post`**'s humanizer is the same detector `content-ops` already mandates; one copy in `brand/` is the source, and a writer that vendors its own is editing outside its territory.

## Open questions

1. **Panel inside the writer, or as `editor`.** Inside is what the skill does and costs one run per batch; as `editor` it is a reviewing actor with requests as findings, which the tracker shows and the human can read, at the cost of a second run and a resume. The draft above allows both; a channel should pick one.
2. **Where `log` at publish belongs.** In `publish.sh` on the human's path, as above, or in a readback run that reads `published/` and logs from there. The first keeps "published" and "logged" one act; the second keeps the human's script free of the engine. The first is proposed because the engine's own workflow says log at publish.
3. **A flow per draft or per batch.** Per draft gives `trace` its full value and makes hundreds of flows a quarter, which is what `by-state/` and `flow list` are for; per batch is coarser and lines up one-to-one with tasks and lanes. Per draft is proposed, with the batch as the task they all link to.
4. **Whether `experiments/` should be committed at all.** It is machine-written JSON that the engine rewrites whole; committing it makes every promotion to the playbook a reviewed diff, which is the point, but a long-running channel will make `experiments.json` a large file with a noisy history. If it grows past comfort, the engine's `GROWTH_ENGINE_DATA_DIR` can point at gitignored state and only `playbook.json` be copied in, at the price of `trace` losing the data points.

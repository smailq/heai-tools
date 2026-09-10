# A research team

*How a lab or a team tracking a field runs on heai-tools, 2026-09-10: a repository of papers read, notes, syntheses and a reading list; an agent per topic that reads what the feeds bring and writes the notes; a human who owns the syntheses, the questions and what gets published. Read [`project.md`](project.md) first for the directory and the tools.*

This is knowledge work with no build and no deploy, and the tools still fit: the work arrives on its own from feeds, it splits cleanly into topics one reader can own, every note is a file, and the moment that matters - deciding what the field's state is and saying so in public - is a person's.
Agents read, summarize, link and flag; humans decide, synthesize and publish.

## The map

```yaml
# architecture.yaml
version: 1
unowned: fail

actors:
  pi:          { type: human, identity: '@pi' }
  postdoc:     { type: human, identity: '@postdoc' }
  reader-rl:
    type: llm-agent
    context: |
      You read new reinforcement-learning papers and write one note per paper under notes/rl/: claims,
      method, evidence, and how it relates to papers already in notes/. You never edit a synthesis. A paper
      that belongs to another topic is a request to that topic's reader, not a note of yours.
  reader-robotics:
    type: llm-agent
    context: 'You read robotics papers the same way reader-rl reads RL papers, under notes/robotics/.'
  reader-theory:
    type: llm-agent
    context: 'You read learning-theory papers under notes/theory/, and you are the one who checks a proof sketch before a note claims a result holds.'
  curator:
    type: llm-agent
    context: 'You keep the bibliography and the cross-topic index under index/ consistent with notes/: every note cited, every citation resolvable. You write no notes.'
    watches: [rl, robotics, theory]

repositories:
  lab: { remotePath: github.com/example/lab-notes, localPath: ../lab-notes }

territories:
  direction:
    owner: pi
    scope: [{ repository: lab, globs: ['architecture.yaml', 'questions/**', 'scripts/**'] }]
    context: The open questions the lab is working on. A reader cites them; only the PI changes them.
  syntheses:
    owner: postdoc
    scope: [{ repository: lab, globs: ['syntheses/**', 'digests/**'] }]
    context: What we believe the state of the field is. Written by people from the notes, never by a reader.
  rl:
    owner: reader-rl
    scope: [{ repository: lab, globs: ['notes/rl/**'] }]
    dependsOn: [direction]
  robotics:
    owner: reader-robotics
    scope: [{ repository: lab, globs: ['notes/robotics/**'] }]
    dependsOn: [direction, rl]
  theory:
    owner: reader-theory
    scope: [{ repository: lab, globs: ['notes/theory/**'] }]
    dependsOn: [direction]
  index:
    owner: curator
    scope: [{ repository: lab, globs: ['index/**', 'bib/**'] }]
    dependsOn: [rl, robotics, theory]
```

A reader cannot touch the syntheses or the open questions, so an agent that "updates our position" on a result fails the gate; what it may do is write a note that says the position is contradicted, and file a task for the postdoc.
`dependsOn` records that robotics notes may cite RL notes and not the reverse, which is the lab's own view of its field and is the map's to say.

## The team

| member | kind | owns | does |
| --- | --- | --- | --- |
| `pi` | human | `direction` | writes the open questions, approves every digest, decides what is worth a synthesis |
| `postdoc` | human | `syntheses`, `digests` | writes syntheses from the notes, drafts the weekly digest, reviews flagged notes |
| `reader-rl`, `reader-robotics`, `reader-theory` | llm-agent | one topic's notes each | read what the feeds bring, write one note per paper, link it to prior notes, flag contradictions |
| `curator` | llm-agent | `index`, `bib` | keeps citations and the cross-topic index consistent after every landing |
| the rules and the hooks | automation | nothing | poll the feeds, file a paper per topic, land notes, open the weekly digest, start the curator after each landing |

## The flows

A **paper** is one paper from seen to filed, and the reason the team exists.
A **digest** is one week's summary, drafted by a person from the week's notes and published only when the PI says so.
The software team's `session` and `landing` are used as they are: a reader's work on a paper is a session, and its note lands through a landing a rule lands for every reader, because a note is a claim and not a decision.

```yaml
# flows/paper.yaml - one paper, seen to filed
name: paper
states: [seen, assigned, noted, flagged, filed, skipped]
initial: seen
terminal: [filed, skipped]
links:
  id:      { required: true }        # arXiv id or DOI
  topic:   { required: false }
  task:    { required: false }
  session: { required: false }
transitions:
  - { from: seen,     to: assigned, on: routed,   by: [route.sh] }
  - { from: seen,     to: skipped,  on: skipped,  by: [route.sh, human] }        # off-topic, or already noted
  - { from: assigned, to: noted,    on: landed,   when: { flags: 0 }, by: [land.sh] }
  - { from: assigned, to: flagged,  on: landed,   by: [land.sh] }                # the note contradicts a synthesis or a question
  - { from: assigned, to: skipped,  on: exited,   when: { exitCode: 2 }, by: [finish.sh] }   # the reader found it out of scope
  - { from: noted,    to: filed,    on: indexed,  by: [index.sh] }
  - { from: flagged,  to: filed,    on: reviewed, by: [human] }                  # the postdoc read the flag
  - { from: flagged,  to: filed,    on: stale,    after: 30d }
hooks:
  seen:     { run: scripts/papers/route.sh }              # the topic from the feed's category and the questions; a task for the reader
  flagged:  { run: scripts/papers/flag.sh }               # a task for the postdoc naming the note and the synthesis it contradicts
  noted:    { run: scripts/papers/index.sh }              # a task for the curator; `indexed` when its landing lands
```

```yaml
# flows/digest.yaml - one week
name: digest
states: [open, drafted, approved, published, dropped]
initial: open
terminal: [published, dropped]
links: { week: { required: true } }
transitions:
  - { from: open,     to: drafted,   on: drafted,   by: [human] }
  - { from: open,     to: dropped,   on: stale,     after: 10d }
  - { from: drafted,  to: approved,  on: approved,  by: [human] }
  - { from: drafted,  to: open,      on: reopened,  by: [human] }
  - { from: approved, to: published, on: published, by: [publish.sh] }
hooks:
  open:     { run: scripts/digest/open.sh }               # a task for the postdoc with the week's filed notes and flags, `flow list paper --in filed`
  approved: { run: scripts/digest/publish.sh }            # the digest to the lab's site and mailing list
```

The readers never move a `paper` themselves: the routing script starts it, the landing script moves it, the curator's landing files it.
Every move on a `digest` but the last is a person's, and the last is the script the person's approval runs.

## The rules

```yaml
# reactor.yaml
sources:
  clock:      { type: schedule, cron: "* * * * *" }
  tasks_cli:  { type: cli, kinds: [task.todo] }
  landings:   { type: cli, kinds: [landing.proposed] }
  arxiv-rl:   { type: poll, url: "https://export.arxiv.org/api/query?search_query=cat:cs.LG+AND+all:reinforcement&sortBy=submittedDate&max_results=25", every: 6h, watch: /feed/entry/0/id }
  arxiv-ro:   { type: poll, url: "https://export.arxiv.org/api/query?search_query=cat:cs.RO&sortBy=submittedDate&max_results=25", every: 6h, watch: /feed/entry/0/id }
  arxiv-th:   { type: poll, url: "https://export.arxiv.org/api/query?search_query=cat:stat.ML+AND+cat:cs.LG&sortBy=submittedDate&max_results=25", every: 6h, watch: /feed/entry/0/id }
  drops:      { type: dir, path: drops, every: 30s, archive: drops/.done }
rules:
  - { name: settle,       on: { source: clock },                                    run: flow settle }
  - { name: pick-readers, on: { source: clock },                                    run: "scripts/session/pick.sh reader-rl 2 && scripts/session/pick.sh reader-robotics 2 && scripts/session/pick.sh reader-theory 1" }
  - { name: pick-curator, on: { source: clock },                                    run: scripts/session/pick.sh curator 1 }
  - { name: land-notes,   on: { source: landings, kind: landing.proposed },         run: scripts/landing/land.sh }
  - { name: feed-rl,      on: { source: arxiv-rl },                                 run: scripts/papers/seen.sh rl }
  - { name: feed-ro,      on: { source: arxiv-ro },                                 run: scripts/papers/seen.sh robotics }
  - { name: feed-th,      on: { source: arxiv-th },                                 run: scripts/papers/seen.sh theory }
  - { name: dropped,      on: { source: drops },                                    run: scripts/papers/seen.sh --from-file }
  - { name: weekly,       on: { source: clock, cron: "0 7 * * 1" },                 run: scripts/digest/open.sh }
```

Reading it as policy: every landing lands on its own, because in this repository an agent's landing is only ever a note or an index entry, and the human-owned files cannot be in it or the gate would have refused the session first.
A human who wants to route a paper by hand drops its id into `drops/`, and the `dir` source picks it up in thirty seconds.

## The scripts

The session and landing scripts are the software team's.
The research team adds:

| script | fires on | does |
| --- | --- | --- |
| `papers/seen.sh <topic>` | a feed changing, or a drop | for each entry not yet a `paper` flow, `flow start paper --id <arxiv id> --link topic=<topic>`; the feed's own dedupe is the flow id |
| `papers/route.sh` | `paper.seen` | reads `questions/` for the terms the lab cares about; `skipped` when none match and the category is peripheral, else `tasks new` for the topic's reader with the abstract and the questions it touches, then `routed` |
| `papers/land.sh` | wraps `landing/land.sh` for note landings | lands, then reads the note's frontmatter for `flags:`; `flow advance landed --data '{"flags": n}'` on the linked paper |
| `papers/flag.sh` | `paper.flagged` | `tasks new` for `postdoc`: the note, the synthesis or question it contradicts, the reader's one-line reason |
| `papers/index.sh` | `paper.noted` | `tasks new` for `curator`: cite the note, resolve its references; when the curator's landing lands, `indexed` |
| `digest/open.sh` | Monday 07:00 | `flow start digest --link week=`, then `tasks new` for `postdoc` with `flow list paper --in filed --json` since last Monday and every open flag |
| `digest/publish.sh` | `digest.approved` | renders `digests/<week>.md` to the lab site and the mailing list; `published` |

A reader's session prompt is `architect context reader-rl` plus the task: the abstract, the questions it touches, and the instruction to read the PDF through `pod run` with the lab's fetch script, write the note, and set `flags:` in its frontmatter when the paper contradicts anything under `syntheses/` or `questions/`.
The reader exits `2` when the paper is out of scope, which `finish.sh` turns into `skipped`.

## A worked week

- **Monday 07:00** - the `weekly` rule opens `digest 2026-W37` and files the postdoc's task with last week's 41 filed notes and 3 open flags.
- **Monday 08:00** - the RL feed changes; `seen.sh rl` starts 19 `paper` flows. `route.sh` skips 11 as peripheral and files 8 tasks for `reader-rl`; the `pick-readers` rule gives it two at a time. Each session reads the paper, writes `notes/rl/<id>.md`, links prior notes, settles; the `land-notes` rule lands each; `papers/land.sh` reads `flags: 0` and the paper is `noted`; `index.sh` queues the curator.
- **Monday 11:00** - one RL note carries `flags: 1`: the paper reports a negative result against a method the lab's synthesis calls settled. The paper is `flagged`; `flag.sh` files a task for `postdoc` naming the note and `syntheses/offline-rl.md`.
- **Tuesday** - a robotics paper turns out to be a learning-theory paper with a robot in the title. `reader-robotics` files a request to `theory` rather than writing the note; its session ends `blocked`; `reader-theory` picks the request up as a task and writes the note; the request is `done` and the robotics session resumes only to exit `2`, so the original paper is `skipped` in robotics and `noted` in theory.
- **Wednesday** - `postdoc` reads the flagged note and the paper, agrees, and edits `syntheses/offline-rl.md` in a commit of their own; `flow advance <paper> reviewed`; the paper is `filed`. The synthesis change is the only landing of the week made by a person.
- **Thursday** - the `curator` session lands the week's index entries; every `noted` paper it cited is `indexed` and `filed`. `pi` drops a preprint a colleague sent into `drops/`; thirty seconds later it is `seen`, and `route.sh` sends it to `reader-theory`.
- **Friday 16:00** - `postdoc` drafts the digest from the filed notes and the resolved flag, `flow advance <digest> drafted`; `pi` reads it, `flow advance <digest> approved`; `publish.sh` sends it. `flow trace week=2026-W37` is the week: every paper seen, who read it, what it flagged, and the digest that went out.

## Where a human steps in

- **At the questions.** `questions/` is what the routing script reads and what the readers cite; only the PI changes it.
- **At every flag.** A note that contradicts a synthesis waits for the postdoc; the synthesis changes only by their commit.
- **At the digest.** Drafted by a person, approved by the PI, and published by the script that approval runs.
- **At requests between topics**, when two readers disagree about whose paper it is; the PI splits it.
- **At the rules**, to add a feed, change a reader's load, or route a new venue.

## Standing it up

```sh
mkdir ~/Code/lab-project && cd ~/Code/lab-project && git init
architect template > architecture.yaml && $EDITOR architecture.yaml && architect check
tasks init --dir tasks --map ../architecture.yaml
cp -r ~/Code/heai-tools/templates/software/{flows/session.yaml,flows/landing.yaml,scripts/session,scripts/landing} .   # then paper.yaml, digest.yaml, scripts/papers, scripts/digest
mkdir -p images/lab drops && $EDITOR images/lab/Containerfile        # FROM ${BASE}; python3, pandoc, a PDF fetcher, the agents
$EDITOR pod.yaml reactor.yaml
pod build && pod up --image lab/dev && pod repo add lab
reactor serve
operator
```

The readers need no credentials at all: the feeds are public, the PDFs are fetched by a script, and publishing runs on the host as the PI.

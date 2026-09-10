# A customer support team

*How a support organization runs its knowledge work on heai-tools, 2026-09-10: a repository of help-center articles, macros and escalation playbooks; an agent per product area that drafts and repairs articles from what the tickets say; humans who own tone, anything about money or law, and every publish; and a ticketing system that talks to the project through webhooks. Read [`project.md`](project.md) first for the directory and the tools.*

The tickets themselves are not the work here; they live in the ticketing system and the people who answer them stay there.
The work is what the tickets reveal: an article that is wrong, a question with no article, a macro that no longer matches the product.
That is a repository of files, split by product area, with a publish step a person must take, and events that arrive on their own from the ticket queue and the product's release feed.

## The map

```yaml
# architecture.yaml
version: 1
unowned: fail

actors:
  support-lead:  { type: human, identity: '@support-lead' }
  editor:        { type: human, identity: '@kb-editor' }
  billing-lead:  { type: human, identity: '@billing-lead' }
  kb-app:
    type: llm-agent
    context: |
      You keep the help-center articles for the app under articles/app/ true to the product. When a ticket
      cluster names an article, you read the tickets, the article and the release notes, then fix or write the
      article. You follow brand/tone.md. Anything about pricing, refunds or legal terms is a request, not an edit.
  kb-integrations:
    type: llm-agent
    context: 'You do for articles/integrations/ what kb-app does for the app, and you test every setup step you document against the sandbox.'
  macro-keeper:
    type: llm-agent
    context: 'You keep macros/ consistent with articles/: every macro links the article it summarizes, and says what the article says.'
    watches: [app, integrations]

repositories:
  kb: { remotePath: github.com/example/help-center, localPath: ../help-center }

territories:
  standards:
    owner: editor
    scope: [{ repository: kb, globs: ['architecture.yaml', 'brand/**', 'templates/**', 'scripts/**'] }]
    context: Tone, structure and the article template. Agents follow these and never edit them.
  billing:
    owner: billing-lead
    scope: [{ repository: kb, globs: ['articles/billing/**', 'macros/billing/**'] }]
    context: Anything a customer could read as a promise about money. Written by a person, reviewed by finance.
  legal:
    owner: support-lead
    scope: [{ repository: kb, globs: ['articles/legal/**', 'articles/privacy/**'] }]
  app:
    owner: kb-app
    scope: [{ repository: kb, globs: ['articles/app/**'] }]
    dependsOn: [standards]
  integrations:
    owner: kb-integrations
    scope: [{ repository: kb, globs: ['articles/integrations/**'] }]
    dependsOn: [standards, app]
  macros:
    owner: macro-keeper
    scope: [{ repository: kb, globs: ['macros/**'], exclude: { territories: [billing] } }]
    dependsOn: [app, integrations, billing]
  playbooks:
    owner: support-lead
    scope: [{ repository: kb, globs: ['playbooks/**'] }]
```

An agent that answers a refund question by editing `articles/billing/` fails the gate; what it can do is file a request to `billing`, which is how a refund article gets written by the person accountable for it.
`macro-keeper` reads every article and writes only macros, so a macro never says something an article does not.

## The team

| member | kind | owns | does |
| --- | --- | --- | --- |
| `support-lead` | human | `legal`, `playbooks` | decides what gets published, writes the escalation playbooks, reads the weekly gap report |
| `editor` | human | `standards` | owns tone and structure, reviews every article before publish, answers agents' questions |
| `billing-lead` | human | `billing` | writes every article and macro about money |
| `kb-app`, `kb-integrations` | llm-agent | one product area's articles each | turn ticket clusters and release notes into article fixes and new articles |
| `macro-keeper` | llm-agent | `macros` | keeps macros true to the articles they summarize |
| the rules and the hooks | automation | nothing | cluster tickets into tasks, watch the release feed, land drafts, run the link and readability checks, publish on approval, read ratings back |

## The flows

An **article** is one article change from a signal to measured.
The software team's `session` and `landing` are used as they are; a draft lands into `main` through a landing a rule lands for the agents, since `main` is not the live help center and a landing publishes nothing.

```yaml
# flows/article.yaml - one article change
name: article
states: [signal, drafting, drafted, checked, approved, published, measured, declined]
initial: signal
terminal: [measured, declined]
links:
  slug:    { required: true }          # the article's path
  area:    { required: true }          # app | integrations | billing | legal
  reason:  { required: false }         # cluster | release | rating | request
  task:    { required: false }
  cluster: { required: false }         # the ticket cluster id, when one started it
transitions:
  - { from: signal,    to: drafting,  on: assigned,  by: [signal.sh] }
  - { from: signal,    to: declined,  on: declined,  by: [human, signal.sh] }        # noise, or already covered
  - { from: drafting,  to: drafted,   on: landed,    by: [land.sh] }
  - { from: drafted,   to: checked,   on: checked,   when: { failed: 0 }, by: [check.sh] }   # links resolve, reading level, template followed
  - { from: drafted,   to: drafting,  on: checked,   by: [check.sh] }
  - { from: checked,   to: approved,  on: approved,  by: [human] }
  - { from: checked,   to: drafting,  on: revise,    by: [human] }
  - { from: checked,   to: declined,  on: declined,  by: [human] }
  - { from: approved,  to: published, on: published, by: [publish.sh] }
  - { from: published, to: measured,  on: readback }                                 # ratings and deflection, from the readback run
  - { from: published, to: measured,  on: stale,     after: 30d }
hooks:
  signal:    { run: scripts/articles/assign.sh }        # a task for the area's agent with the tickets, the article and the release notes
  drafted:   { run: scripts/articles/check.sh }         # the deterministic checks, in the pod
  checked:   { run: scripts/articles/review.sh }        # a task for the editor with the diff and the tickets it answers
  approved:  { run: scripts/articles/publish.sh }       # to the help center through its API, as the editor
  published: { run: scripts/articles/macros.sh }        # a task for macro-keeper if a macro cites this article
```

`approved` is the one move a person makes, and the publish is the script that move runs.
An agent can bring an article to `checked` and no further.

## The rules

```yaml
# reactor.yaml
sources:
  clock:     { type: schedule, cron: "* * * * *" }
  tasks_cli: { type: cli, kinds: [task.todo] }
  landings:  { type: cli, kinds: [landing.proposed] }
  tickets:   { type: webhook, path: /hook/tickets, secret: env:TICKETS_HOOK_SECRET, kind: /event, key: /ticket/id }
  releases:  { type: poll, url: https://api.example.com/releases/latest.json, every: 15m, watch: /version }
  ratings:   { type: poll, url: https://helpcenter.example.com/api/ratings/summary, every: 6h, watch: /updated_at }
rules:
  - { name: settle,        on: { source: clock },                                          run: flow settle }
  - { name: pick-app,      on: { source: clock },                                          run: scripts/session/pick.sh kb-app 2 }
  - { name: pick-int,      on: { source: clock },                                          run: scripts/session/pick.sh kb-integrations 1 }
  - { name: pick-macros,   on: { source: clock },                                          run: scripts/session/pick.sh macro-keeper 1 }
  - { name: land-drafts,   on: { source: landings, kind: landing.proposed },               run: scripts/articles/land.sh }
  - { name: cluster,       on: { source: clock, cron: "0 */4 * * *" },                     run: scripts/signals/cluster.sh }
  - { name: escalation,    on: { source: tickets, kind: ticket.tagged, tag: kb-gap },      run: scripts/signals/gap.sh }
  - { name: release,       on: { source: releases },                                       run: scripts/signals/release.sh }
  - { name: ratings,       on: { source: ratings },                                        run: scripts/signals/ratings.sh }
  - { name: weekly,        on: { source: clock, cron: "0 9 * * 1" },                       run: scripts/signals/report.sh }
```

Reading it as policy: every four hours the ticket stream is clustered and each cluster with no good article becomes a signal; an agent on the floor who tags a ticket `kb-gap` makes one at once; a product release makes one per article that cites the changed surface; a rating drop makes one for the article rated.
Every agent landing lands on its own; nothing publishes without the editor's `approved`.

## The scripts

The session and landing scripts are the software team's; `articles/land.sh` wraps `landing/land.sh` and advances the linked article with `landed`.
The support team adds:

| script | fires on | does |
| --- | --- | --- |
| `signals/cluster.sh` | every four hours | pulls the period's tickets through the ticketing API, clusters by subject and the article the agent linked, and for each cluster over a threshold with a low-rated or missing article: `flow start article --link slug= --link area= --link reason=cluster --link cluster=`, then `assigned` |
| `signals/gap.sh` | a `kb-gap` tag | one article flow from the tagged ticket, `reason=request`, the ticket's text saved for the task |
| `signals/release.sh` | the release feed changing | reads the release notes, finds the articles citing each changed surface through `grep` over `articles/`, one flow per article with `reason=release` |
| `signals/ratings.sh` | the ratings poll changing | one flow per article whose helpful-rate fell below the threshold since last time, `reason=rating` |
| `articles/assign.sh` | `article.signal` | `tasks new` for the area's agent: the tickets or notes that started it, the article as it is, `brand/tone.md`, the template; declines at once when the slug is in a human's territory and files a request there instead |
| `articles/check.sh` | `article.drafted` | `pod run` the checks: every link resolves, the reading level is under the standard, the template's sections are present; `checked` with the count |
| `articles/review.sh` | `article.checked` | `tasks new` for `editor`: the diff, the tickets it answers, the checks' output |
| `articles/publish.sh` | `article.approved` | the article through the help center's API, as the editor; `published` with the live URL |
| `articles/macros.sh` | `article.published` | if any macro under `macros/` cites the slug, `tasks new` for `macro-keeper` |
| `signals/report.sh` | Monday 09:00 | the week's flows by reason and state, the clusters still without an article, the ratings trend, as a task for `support-lead` |

The scripts that talk to the ticketing system and the help center run on the host with the team's credentials; the agents' pod has read access to a sandbox and nothing else.

## A worked week

- **Monday 04:00** - `cluster.sh` finds 38 tickets in the last four hours about the new export button, all linked to `articles/app/exporting.md`, whose helpful-rate is 41%. It starts an article flow with `reason=cluster`; `assign.sh` files the task; `pick-app` starts a session. `kb-app` reads the tickets and the article, finds the article describes the old menu, rewrites the steps and adds the screenshot the product team shipped in the release assets, lands it. `check.sh` passes; `review.sh` files the editor's task.
- **Monday 10:00** - `editor` reads the diff against the tickets, tightens one sentence with `revise` and a note; the agent's next session applies it; checks pass again; the editor moves `approved`; `publish.sh` puts it live. `macros.sh` finds the "how do I export" macro cites the article and files a task; `macro-keeper` updates the macro to match and lands it.
- **Tuesday** - a floor agent tags a ticket `kb-gap`: a customer asked how a proration works on plan change. `gap.sh` starts a flow in `billing`; `assign.sh` sees the territory is a human's, declines the agent path, and files a request task for `billing-lead`, who writes the article themselves and publishes it through the same `approved` move.
- **Wednesday** - the release feed shows 4.12 shipped. `release.sh` finds six articles citing the settings page that moved and starts six flows; `kb-app` takes two at a time; four are small edits and land within the hour; two turn out unchanged in substance and the agent exits `2`, which `finish.sh` records and the editor declines.
- **Thursday** - `kb-integrations` documents the new Slack setup; its context says to test every step against the sandbox, and step 4 fails there. It writes the article with step 4 marked as unverified and files a request to `playbooks` asking whether to publish with a caveat or wait; `support-lead` says wait; the flow sits in `drafting` with the note.
- **Friday** - the ratings poll shows `articles/app/two-factor.md` fell to 55%; a flow starts with `reason=rating`; the agent finds the article correct but the tickets show customers are on the mobile app, which the article never mentions; it adds a section; the editor approves.
- **Monday 09:00** - `report.sh` gives `support-lead` the week: nine articles published, two declined, one waiting on the product team, the export cluster's ticket volume down 70%.

`flow trace slug=articles/app/exporting.md` reads the article's history: which tickets started each change, who drafted, who approved, what the rating did after.

## Where a human steps in

- **At every publish.** `approved` is the editor's, and the publish is the script that move runs.
- **At money and law.** `billing`, `legal` and `privacy` articles are written by the people accountable for them; agents can only ask.
- **At tone and structure.** `brand/` and `templates/` change only by the editor's commit.
- **At an agent's question**, when a setup step cannot be verified or a ticket cluster is ambiguous.
- **At the weekly report**, deciding which gaps the agents should not fill.

## Standing it up

```sh
mkdir ~/Code/support-project && cd ~/Code/support-project && git init
architect template > architecture.yaml && $EDITOR architecture.yaml && architect check
tasks init --dir tasks --map ../architecture.yaml
cp -r ~/Code/heai-tools/templates/software/{flows/session.yaml,flows/landing.yaml,scripts/session,scripts/landing} .   # then article.yaml, scripts/articles, scripts/signals
mkdir -p images/kb && $EDITOR images/kb/Containerfile        # FROM ${BASE}; a markdown linter, a link checker, a readability scorer, the agents
$EDITOR pod.yaml reactor.yaml
pod build && pod up --image kb/dev && pod repo add kb
reactor serve
operator
```

Start with the `cluster` rule alone and the editor approving everything; add the release and ratings rules once the editor trusts what the clusters produce.

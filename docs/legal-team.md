# A legal team

*How an in-house legal team runs its contract work on heai-tools, 2026-09-10: a repository of clause libraries, templates, playbooks and the contracts in flight; an agent per contract family that drafts from the library and redlines against the playbook; lawyers who own the playbook and every outbound document; and intake that arrives from the business as tickets. Read [`project.md`](project.md) first for the directory and the tools.*

A contract is a document, a clause library is a set of files with approved variants, and a playbook is the written position on each clause: what we accept, what we counter with, what needs a lawyer.
That is a repository with territories, and the moves that matter - sending a draft to a counterparty, accepting a deviation from the playbook, signing - are a person's.
Agents do the assembling and the comparing; lawyers do the deciding, and the journal is the record of who decided what.

## The map

```yaml
# architecture.yaml
version: 1
unowned: fail

actors:
  general-counsel: { type: human, identity: '@gc' }
  commercial-counsel: { type: human, identity: '@commercial' }
  privacy-counsel:    { type: human, identity: '@privacy' }
  nda-drafter:
    type: llm-agent
    context: |
      You assemble NDAs and simple vendor agreements from templates/ and clauses/ according to playbook/.
      You never invent a clause: every paragraph comes from clauses/ or is a deviation you list in the
      draft's frontmatter under `deviations:`. Anything the playbook marks `counsel` is a deviation.
  redliner:
    type: llm-agent
    context: |
      You compare a counterparty's markup against our last draft and the playbook, clause by clause, and write
      a redline report under matters/<id>/redline-<n>.md: accepted, countered with which clause variant, or
      escalated. You never edit the contract itself.
    watches: [nda, dpa]
  dpa-drafter:
    type: llm-agent
    context: 'You assemble data-processing agreements the same way nda-drafter assembles NDAs, under matters/*/dpa/.'

repositories:
  legal: { remotePath: github.com/example/legal, localPath: ../legal }

territories:
  playbook:
    owner: general-counsel
    scope: [{ repository: legal, globs: ['architecture.yaml', 'playbook/**', 'scripts/**'] }]
    context: Our position on every clause. Changes only by counsel's commit; an agent that disagrees files a request.
  clauses:
    owner: commercial-counsel
    scope: [{ repository: legal, globs: ['clauses/**', 'templates/**'] }]
    context: Approved language. Every variant here has been through counsel once so it need not be again.
  privacy-clauses:
    parent: clauses
    owner: privacy-counsel
    scope: [{ repository: legal, globs: ['clauses/privacy/**', 'templates/dpa/**'] }]
  nda:
    owner: nda-drafter
    scope: [{ repository: legal, globs: ['matters/*/nda/**', 'matters/*/vendor/**'] }]
    dependsOn: [clauses, playbook]
  dpa:
    owner: dpa-drafter
    scope: [{ repository: legal, globs: ['matters/*/dpa/**'] }]
    dependsOn: [privacy-clauses, playbook]
  redlines:
    owner: redliner
    scope: [{ repository: legal, globs: ['matters/*/redline-*.md'] }]
    dependsOn: [nda, dpa, playbook]
  executed:
    owner: general-counsel
    scope: [{ repository: legal, globs: ['matters/*/executed/**', 'matters/*/matter.yaml'] }]
    context: Signed documents and the matter record. Written only by the person who closed the matter.
```

The library and the playbook are counsel's; a drafter that wants a clause the library lacks lists the gap as a deviation, and a deviation is what makes a draft wait for a lawyer.
The redliner may read every draft and write only reports, so a counterparty's markup never becomes our text without a person moving it there.

## The team

| member | kind | owns | does |
| --- | --- | --- | --- |
| `general-counsel` | human | `playbook`, `executed` | sets the positions, approves every deviation escalated to them, signs and closes matters |
| `commercial-counsel` | human | `clauses` | reviews drafts before they go out, approves deviations within their authority, answers the redliner's escalations |
| `privacy-counsel` | human | `privacy-clauses` | the same for DPAs and anything touching personal data |
| `nda-drafter`, `dpa-drafter` | llm-agent | drafts of one family each | assemble a draft from a matter's intake, list deviations, revise from a redline report |
| `redliner` | llm-agent | redline reports | compare a markup to our draft and the playbook, propose a response clause by clause |
| the rules and the hooks | automation | nothing | open matters from intake, start drafting, route markups, remind on stale matters, file executed documents |

## The flows

A **matter** is one contract from intake to executed or dropped.
The software team's `session` and `landing` are used as they are; a draft or a report lands into `main` through a landing a rule lands for the agents, because nothing an agent lands is ever sent anywhere by that landing.

```yaml
# flows/matter.yaml - one contract
name: matter
states: [intake, drafting, review, sent, markup, negotiating, agreed, executed, dropped]
initial: intake
terminal: [executed, dropped]
links:
  id:           { required: true }        # M-2026-0417
  family:       { required: true }        # nda | vendor | dpa
  counterparty: { required: true }
  requester:    { required: false }       # who in the business asked
  task:         { required: false }
  round:        { required: false }       # the current redline round
transitions:
  - { from: intake,      to: drafting,    on: assigned,   by: [intake.sh] }
  - { from: drafting,    to: review,      on: landed,     by: [land.sh] }                    # the draft is in main, deviations listed
  - { from: review,      to: sent,        on: sent,       by: [human] }                      # counsel sent it; the draft as sent is recorded
  - { from: review,      to: drafting,    on: revise,     by: [human] }                      # counsel wants changes; a note says what
  - { from: sent,        to: markup,      on: markup,     by: [inbound.sh] }                 # the counterparty's version arrived
  - { from: sent,        to: agreed,      on: accepted,   by: [human] }                      # signed as sent
  - { from: markup,      to: negotiating, on: landed,     by: [land.sh] }                    # the redline report is in main
  - { from: negotiating, to: drafting,    on: respond,    by: [human] }                      # counsel chose the responses; redraft
  - { from: negotiating, to: agreed,      on: accepted,   by: [human] }
  - { from: agreed,      to: executed,    on: executed,   by: [human] }
  - { from: [sent, markup, negotiating], to: sent, on: stale, after: 10d }                   # re-entered, so the reminder repeats
  - { from: [intake, drafting, review, sent, markup, negotiating, agreed], to: dropped, on: dropped, by: [human] }
hooks:
  intake:      { run: scripts/matters/assign.sh }        # a task for the family's drafter with the intake form
  review:      { run: scripts/matters/review.sh }        # a task for the counsel who owns the family, listing the deviations
  sent:        { run: scripts/matters/remind.sh }        # on entry and on every stale re-entry: a note on the task, a nudge to the requester
  markup:      { run: scripts/matters/redline.sh }       # a task for the redliner with our draft and theirs
  negotiating: { run: scripts/matters/respond.sh }       # a task for counsel with the report: accept, counter, or escalate each item
  agreed:      { run: scripts/matters/signature.sh }     # the signature packet, through the e-signature connector, as counsel
  executed:    { run: scripts/matters/file.sh }          # the signed PDF under matters/<id>/executed/, matter.yaml closed, the requester told
```

Every move from `review` onward that changes what the counterparty sees is `by: [human]`.
An agent's landing can bring a matter to `review` or to `negotiating`, never past them.

## The rules

```yaml
# reactor.yaml
sources:
  clock:     { type: schedule, cron: "* * * * *" }
  tasks_cli: { type: cli, kinds: [task.todo] }
  landings:  { type: cli, kinds: [landing.proposed] }
  intake:    { type: webhook, path: /hook/intake, secret: env:INTAKE_HOOK_SECRET, kind: /type, key: /ticket }
  mail:      { type: dir, path: inbound, every: 30s, archive: inbound/.done }
  esign:     { type: webhook, path: /hook/esign, secret: env:ESIGN_HOOK_SECRET, kind: /event, key: /envelope }
rules:
  - { name: settle,       on: { source: clock },                                          run: flow settle }
  - { name: pick-nda,     on: { source: clock },                                          run: scripts/session/pick.sh nda-drafter 3 }
  - { name: pick-dpa,     on: { source: clock },                                          run: scripts/session/pick.sh dpa-drafter 1 }
  - { name: pick-redline, on: { source: clock },                                          run: scripts/session/pick.sh redliner 2 }
  - { name: land-drafts,  on: { source: landings, kind: landing.proposed },               run: scripts/matters/land.sh }
  - { name: new-matter,   on: { source: intake, kind: legal.request },                    run: scripts/matters/intake.sh }
  - { name: inbound,      on: { source: mail },                                           run: scripts/matters/inbound.sh }
  - { name: signed,       on: { source: esign, kind: envelope.completed },                run: scripts/matters/signed.sh }
  - { name: weekly,       on: { source: clock, cron: "0 8 * * 1" },                       run: scripts/matters/docket.sh }
```

Reading it as policy: three NDAs may be drafting at once, one DPA, two redlines.
Every agent landing lands on its own, because a landing here only ever puts a draft or a report into `main` for a lawyer to read.
Nothing leaves the building by a rule: `sent`, `accepted` and `executed` have no rule and no script that makes them.

## The scripts

The session and landing scripts are the software team's; `matters/land.sh` wraps `landing/land.sh` and then advances the linked matter with `landed`.
The legal team adds:

| script | fires on | does |
| --- | --- | --- |
| `matters/intake.sh` | the intake webhook | `flow start matter --id M-… --link family= --link counterparty= --link requester=`; the form saved under `matters/<id>/intake.md`; `assigned` |
| `matters/assign.sh` | `matter.intake` | `tasks new` for the family's drafter: the intake, the template to start from, the playbook sections that apply |
| `matters/review.sh` | `matter.review` | `tasks new` for the counsel who owns the family: the draft's path and its `deviations:` list, each with the playbook's position beside it |
| `matters/remind.sh` | `matter.sent`, again on stale | a note on the matter's task with the days out; a message to the requester through the ticketing connector |
| `matters/inbound.sh` | a file in `inbound/` | matches the file to a matter by counterparty and id in its name, saves it under `matters/<id>/rounds/<n>/theirs.docx`, `flow advance markup --link round=` |
| `matters/redline.sh` | `matter.markup` | `tasks new` for the redliner: our draft as sent, their markup, the playbook; the report goes to `matters/<id>/redline-<n>.md` |
| `matters/respond.sh` | `matter.negotiating` | `tasks new` for counsel with the report; the task's `run` block is empty on purpose - the response is a decision |
| `matters/signature.sh` | `matter.agreed` | the signature packet through the e-signature connector, sent as the counsel who moved it |
| `matters/signed.sh` | the e-signature webhook | `flow advance executed --by human` is refused from a script, so this files a task for counsel to confirm and move it; the PDF is saved under `rounds/` meanwhile |
| `matters/file.sh` | `matter.executed` | the signed PDF into `matters/<id>/executed/`, `matter.yaml` with the dates and the final deviations, committed as the counsel who closed it |
| `matters/docket.sh` | Monday 08:00 | `flow list matter --json` grouped by state and age, as a task for `general-counsel` and a page for the team |

The e-signature webhook cannot move the matter to `executed` itself, because that move is `by: [human]`: the script files the task and a lawyer confirms that what came back is what was agreed.
That is the design refusing to be scripted around, and here it is the point.

## A worked matter

- **Day 1, 09:12** - the business files a request for an NDA with Northwind through the ticket form; the `intake` webhook starts `M-2026-0417` and saves the form; `assign.sh` files a task; `pick-nda` starts a session. `nda-drafter` assembles the mutual NDA from `templates/nda/mutual.md`, chooses the three-year term the playbook prefers, and lists one deviation: the requester asked for a five-year term. The draft lands; the matter is `review`; `review.sh` files a task for `commercial-counsel` with the one deviation and the playbook's line on it.
- **Day 1, 14:00** - counsel reads the draft, accepts the five-year term as within their authority, notes it, and sends it from their own mail: `flow advance M-2026-0417 sent --note "five-year term accepted, requester's business reason"`. The draft as sent is what `main` holds.
- **Day 6** - Northwind's markup arrives by mail; a forwarding rule drops it into `inbound/`; `inbound.sh` files it as round 1 and the matter is `markup`; `redline.sh` files a task; `pick-redline` starts a session. `redliner` writes the report: seven changes, four accepted as within the playbook, two countered with variants from `clauses/`, one escalated - a non-solicitation clause the playbook marks `counsel`. The report lands; the matter is `negotiating`; `respond.sh` files a task for counsel.
- **Day 7** - counsel takes the report's four accepts and two counters, refuses the non-solicit, and moves `respond`. The matter is `drafting` again; the drafter's session produces round 2 with the chosen variants and the refusal noted; it lands; `review`; counsel sends it.
- **Day 11** - nothing has come back; `stale` re-enters `sent`; `remind.sh` notes the task and nudges the requester to chase.
- **Day 13** - Northwind agrees by mail; counsel moves `accepted`; `signature.sh` sends the packet. Two days later the e-signature webhook fires; `signed.sh` files the confirmation task; counsel checks the executed PDF matches round 2 and moves `executed`; `file.sh` files it and closes the matter record.
- **The docket** - `flow trace id=M-2026-0417` is the matter's history: every draft, every round, every decision, signed by the lawyer who made it and dated.

## Where a human steps in

- **At the playbook and the library.** Positions and approved language change only by counsel's commit; agents draft from them and never into them.
- **At every deviation.** A draft with a deviation waits in `review` until counsel reads it.
- **At sending, accepting, and executing.** Nothing reaches a counterparty or a signature by a rule.
- **At each redline response.** The report proposes; counsel chooses.
- **At escalations**, where the playbook says a clause is counsel's call, and at requests from the drafters for language the library lacks.

## Standing it up

```sh
mkdir ~/Code/legal-project && cd ~/Code/legal-project && git init
architect template > architecture.yaml && $EDITOR architecture.yaml && architect check
tasks init --dir tasks --map ../architecture.yaml
cp -r ~/Code/heai-tools/templates/software/{flows/session.yaml,flows/landing.yaml,scripts/session,scripts/landing} .   # then matter.yaml and scripts/matters
mkdir -p images/legal inbound && $EDITOR images/legal/Containerfile        # FROM ${BASE}; pandoc, a docx diff tool, the agents
$EDITOR pod.yaml reactor.yaml
pod build && pod up --image legal/dev && pod repo add legal
reactor serve
operator
```

The pod holds no mail and no e-signature credentials; those connectors run on the host as the lawyer whose move called them.
The first matters run with the agents drafting and every landing landed by hand, until counsel has read enough drafts to trust the library is being used as written.

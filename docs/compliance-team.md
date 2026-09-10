# A security and compliance team

*How a compliance program is run on heai-tools, 2026-09-10: a repository of policies, controls, evidence and audit mappings; an agent per framework that gathers and maps evidence; a human who owns every policy sentence and every attestation; and a quarterly clock that opens a review of each control. Read [`project.md`](project.md) first for the directory and the tools.*

The work here is not code, and that is the point of the example.
A control is a file; its evidence is files a script collects; an attestation is a move only a person may make; and the audit trail the auditor wants is the journal `flow` already keeps.
Agents do what is tedious and checkable - collect evidence, map it to controls, draft the gap analysis - and a human does what must be a person's: write the policy, sign the attestation, accept a risk.

## The map

```yaml
# architecture.yaml
version: 1
unowned: fail

actors:
  ciso:        { type: human, identity: '@ciso' }
  grc-lead:    { type: human, identity: '@grc-lead' }
  soc2-agent:
    type: llm-agent
    context: |
      You map evidence to the SOC 2 criteria under frameworks/soc2/. You collect evidence only through the
      scripts under collectors/; you never write policy text and never mark a control attested. A gap is a task.
  iso-agent:
    type: llm-agent
    context: 'You map evidence to ISO 27001 Annex A controls under frameworks/iso27001/, the same way soc2-agent does for SOC 2.'
  vuln-agent:
    type: llm-agent
    context: 'You triage vulnerability findings under findings/: deduplicate, rate, and file a task for the code owner named in the finding.'
    watches: [frameworks-soc2, frameworks-iso]

repositories:
  compliance: { remotePath: github.com/example/compliance, localPath: ../compliance }

territories:
  governance:
    owner: ciso
    scope: [{ repository: compliance, globs: ['architecture.yaml', 'scripts/**', 'collectors/**'] }]
  policies:
    owner: ciso
    scope: [{ repository: compliance, globs: ['policies/**'] }]
    context: Policy text changes only by the CISO's commit, after review. Nothing here is drafted by an agent.
  risks:
    owner: grc-lead
    scope: [{ repository: compliance, globs: ['risks/**', 'attestations/**'] }]
  frameworks-soc2:
    owner: soc2-agent
    scope: [{ repository: compliance, globs: ['frameworks/soc2/**', 'evidence/soc2/**'] }]
    dependsOn: [policies]
  frameworks-iso:
    owner: iso-agent
    scope: [{ repository: compliance, globs: ['frameworks/iso27001/**', 'evidence/iso27001/**'] }]
    dependsOn: [policies]
  findings:
    owner: vuln-agent
    scope: [{ repository: compliance, globs: ['findings/**'] }]
```

The framework agents may read the policies and cite them; they may not edit them.
Attestations live in the human's territory, so an agent cannot mark a control satisfied by writing a file: it can only file a task saying the evidence is ready.

## The team

| member | kind | owns | does |
| --- | --- | --- | --- |
| `ciso` | human | `governance`, `policies` | writes policy, owns the collectors that touch production systems, accepts risks |
| `grc-lead` | human | `risks`, attestations | opens the quarter, attests each control from the evidence, runs the audit |
| `soc2-agent`, `iso-agent` | llm-agent | one framework's mappings and evidence each | collect evidence through the collectors, map it, draft the gap analysis, file a task per gap |
| `vuln-agent` | llm-agent | `findings` | triages scanner output into rated findings and tasks for the code owners |
| the rules and the hooks | automation | nothing | open a review per control each quarter, run collectors on their schedules, pull scanner feeds, land evidence |

## The flows

A **review** is one control in one quarter, from opened to attested.
A **finding** is one vulnerability from reported to closed.
The software team's `session` and `landing` are used as they are: an agent's mapping work is a session, and the evidence it commits lands through a landing a rule lands on its own, because evidence is data and the attestation is elsewhere.

```yaml
# flows/review.yaml - one control, one quarter
name: review
states: [opened, collecting, evidence-ready, gap, attested, accepted-risk, expired]
initial: opened
terminal: [attested, accepted-risk, expired]
links:
  control:   { required: true }      # e.g. CC6.1
  framework: { required: true }      # soc2 | iso27001
  quarter:   { required: true }      # 2026-Q3
  task:      { required: false }
transitions:
  - { from: opened,         to: collecting,     on: assigned,  by: [open-quarter.sh] }
  - { from: collecting,     to: evidence-ready, on: collected, when: { gaps: 0 }, by: [collected.sh] }
  - { from: collecting,     to: gap,            on: collected, by: [collected.sh] }
  - { from: gap,            to: collecting,     on: remediated, by: [human, remediated.sh] }
  - { from: gap,            to: accepted-risk,  on: accepted,  by: [human] }
  - { from: evidence-ready, to: attested,       on: attested,  by: [human] }
  - { from: evidence-ready, to: gap,            on: rejected,  by: [human] }
  - { from: [opened, collecting, evidence-ready, gap], to: expired, on: stale, after: 90d }
hooks:
  opened:         { run: scripts/review/assign.sh }        # a task for the framework's agent naming the control and the collectors to run
  evidence-ready: { run: scripts/review/notify.sh }        # a task for grc-lead: read the evidence, attest or reject
  gap:            { run: scripts/review/gap.sh }           # a task in the territory the gap names, from the agent's analysis
  attested:       { run: scripts/review/record.sh }        # the attestation file under attestations/, committed by the person's move
  expired:        { run: scripts/review/escalate.sh }      # a task for the ciso
```

```yaml
# flows/finding.yaml - one vulnerability
name: finding
states: [reported, triaged, assigned, fixed, verified, accepted-risk, closed]
initial: reported
terminal: [verified, accepted-risk, closed]
links: { id: { required: true }, severity: { required: false }, task: { required: false } }
transitions:
  - { from: reported, to: triaged,       on: triaged,  by: [triage.sh] }
  - { from: reported, to: closed,        on: duplicate, by: [triage.sh] }
  - { from: triaged,  to: assigned,      on: assigned, by: [triage.sh] }
  - { from: assigned, to: fixed,         on: fixed,    by: [human, fixed.sh] }
  - { from: fixed,    to: verified,      on: verified, by: [rescan.sh] }
  - { from: fixed,    to: assigned,      on: reopened, by: [rescan.sh] }
  - { from: [triaged, assigned], to: accepted-risk, on: accepted, by: [human] }
  - { from: assigned, to: assigned,      on: stale,    after: 30d }
hooks:
  reported: { run: scripts/findings/triage.sh }            # a session for vuln-agent, or a duplicate closed at once
  assigned: { run: scripts/findings/notify.sh }            # a task in the owning code territory, severity in the title; re-entered on stale, so the reminder repeats
  fixed:    { run: scripts/findings/rescan.sh }            # the scanner on the fixed path; verified or reopened
```

Three moves are a person's and only a person's: `attested`, `accepted`, and `rejected`.
Nothing an agent does can reach `attested`; the most it can do is bring a review to `evidence-ready` and file the task that asks.

## The rules

```yaml
# reactor.yaml
sources:
  clock:     { type: schedule, cron: "* * * * *" }
  tasks_cli: { type: cli, kinds: [task.todo] }
  landings:  { type: cli, kinds: [landing.proposed] }
  scanner:   { type: webhook, path: /hook/scanner, secret: env:SCANNER_HOOK_SECRET, kind: /event, key: /finding/id }
  advisories: { type: poll, url: https://advisories.example/api/feed.json, every: 1h, watch: /latest/id }
rules:
  - { name: settle,        on: { source: clock },                                                       run: flow settle }
  - { name: pick-soc2,     on: { source: clock },                                                       run: scripts/session/pick.sh soc2-agent 2 }
  - { name: pick-iso,      on: { source: clock },                                                       run: scripts/session/pick.sh iso-agent 2 }
  - { name: pick-vuln,     on: { source: clock },                                                       run: scripts/session/pick.sh vuln-agent 1 }
  - { name: land-evidence, on: { source: landings, kind: landing.proposed, actor: soc2-agent },         run: scripts/landing/land.sh }
  - { name: land-evidence-iso, on: { source: landings, kind: landing.proposed, actor: iso-agent },     run: scripts/landing/land.sh }
  - { name: land-findings, on: { source: landings, kind: landing.proposed, territory: findings },      run: scripts/landing/land.sh }
  - { name: open-quarter,  on: { source: clock, cron: "0 6 1 1,4,7,10 *" },                            run: scripts/review/open-quarter.sh }
  - { name: collect-daily, on: { source: clock, cron: "0 3 * * *" },                                   run: scripts/collectors/run-all.sh }
  - { name: finding,       on: { source: scanner, kind: finding.created },                             run: scripts/findings/report.sh }
  - { name: advisory,      on: { source: advisories },                                                 run: scripts/findings/advisory.sh }
```

Reading it as policy: the agents' evidence and findings land on their own, because a landing there changes no policy and attests nothing; policy changes have no rule and are the CISO's landings.
The first day of each quarter opens a review for every control in every framework.
Collectors run nightly so evidence is fresh when a review asks for it.

## The scripts

| script | fires on | does |
| --- | --- | --- |
| `review/open-quarter.sh` | the quarterly rule | for every control in `frameworks/*/controls.yaml`, `flow start review --link control= --link framework= --link quarter=`, then `assigned` |
| `review/assign.sh` | `review.opened` | `tasks new` for the framework's agent: the control's text, the collectors that apply, and where evidence goes |
| `review/collected.sh` | called by `finish.sh` when a session's task links a review | reads the agent's `analysis.json` from the landed evidence; `collected` with the gap count |
| `review/notify.sh` | `review.evidence-ready` | `tasks new` for `grc-lead` naming the review, the evidence directory and the agent's summary |
| `review/gap.sh` | `review.gap` | one task per gap in the territory the analysis names, with the control cited; the review waits on them |
| `review/remediated.sh` | called when every gap task is `done` | `flow advance remediated`, so collection runs again |
| `review/record.sh` | `review.attested` | writes `attestations/<quarter>/<control>.md` from the journal line - who, when, which evidence - and commits it as the attester |
| `review/escalate.sh` | `review.expired` | a task for `ciso` |
| `collectors/run-all.sh` | nightly | each collector under `collectors/` through `pod run`, output under `evidence/<framework>/<control>/<date>/`, committed and landed by the evidence rules |
| `findings/report.sh` | a scanner webhook | `flow start finding --id <scanner id> --link severity=`, `reported` |
| `findings/triage.sh` | `finding.reported` | a session for `vuln-agent`: deduplicate against `findings/`, rate, name the owning code territory through `architect owner --map ../app-project/architecture.yaml`; `triaged` then `assigned`, or `duplicate` |
| `findings/notify.sh` | `finding.assigned`, again on `stale` | a task in the code project's tracker for the owning territory; the finding waits on it |
| `findings/fixed.sh` | the code task `done` | `flow advance fixed` |
| `findings/rescan.sh` | `finding.fixed` | the scanner on the path; `verified` or `reopened` |
| `findings/advisory.sh` | the advisory feed changing | a task for `vuln-agent` naming the advisory; it decides whether it applies |

The findings flow reaches into another project: the code that has the vulnerability is governed by its own map, in the software team's directory, and `notify.sh` files the task in that tracker with `tasks new --dir ../app-project/tasks`.
Two directories, two maps, one journal line that links them.

## A worked quarter

- **July 1, 06:00** - `open-quarter.sh` starts 61 SOC 2 reviews and 93 ISO reviews for `2026-Q3`. Each enters `opened` and `assign.sh` files its task; the `pick` rules give the agents two at a time.
- **July 1-3** - `soc2-agent` works through the access-control criteria: for `CC6.1` it runs the IAM collector, maps the export to the criterion, writes `analysis.json` with no gaps, commits under `evidence/soc2/CC6.1/2026-07-01/`. The session is clean; the landing is proposed with `actor: soc2-agent`; the `land-evidence` rule lands it; `finish.sh` calls `collected.sh`; the review is `evidence-ready`; `notify.sh` files a task for `grc-lead`.
- **July 3** - for `CC7.2`, the log-review criterion, the agent finds no evidence that alerts were reviewed within the policy's window. `collected` with `gaps: 1`; the review is `gap`; `gap.sh` files a task in `observability` of the platform project's tracker: produce a monthly alert-review record. The review waits on it.
- **July 8** - `grc-lead` opens `operator`, reads the evidence for the twelve reviews in `evidence-ready`, and attests eleven with `flow advance <id> attested`. Entering `attested`, `record.sh` writes the attestation file with the journal line's signature and time. The twelfth is `rejected` with a note that the export is from the wrong account; the review is `gap`, and the agent's next session collects again.
- **July 15** - the scanner webhook reports a critical finding in `src/api/auth.ts`. `report.sh` starts a `finding`; `triage.sh` runs `vuln-agent`, which finds no duplicate, rates it, and names `api` as the owner through the software project's map; `assigned`; `notify.sh` files a task in the software project's tracker. The software team's `pick-api` rule starts a session there; the fix lands two hours later; `fixed.sh` advances the finding; `rescan.sh` verifies it.
- **August 20** - the platform team's alert-review record lands; the gap task is `done`; `remediated.sh` moves `CC7.2` back to `collecting`; the agent collects the new record; `evidence-ready`; `grc-lead` attests.
- **September 28** - three reviews sit in `gap` with no remediation. `grc-lead` accepts one as a risk with `flow advance <id> accepted --note "..."` and a risk entry under `risks/`, and the other two expire on October 1, each filing a task for `ciso`.
- **Audit** - the auditor asks how `CC6.1` was satisfied this quarter. `flow trace control=CC6.1` prints the review: opened by the rule, collected by the agent's session with the evidence commit, attested by `grc-lead` on July 8 at 10:14, and the attestation file the move produced.

## Where a human steps in

- **At every attestation, acceptance and rejection.** The three moves that mean anything to an auditor are `by: [human]` and nothing else.
- **At policy text.** `policies/` changes only by the CISO's own landing.
- **At the collectors.** They touch production systems with read credentials, so they are the CISO's territory and run from the host, never from an agent's session.
- **At risk.** A gap nobody will fix becomes a risk entry only by the GRC lead's move and file.
- **At the rules**, when a framework earns more concurrent sessions or a new collector joins the nightly run.

## Standing it up

```sh
mkdir ~/Code/compliance-project && cd ~/Code/compliance-project && git init
architect template > architecture.yaml && $EDITOR architecture.yaml && architect check
tasks init --dir tasks --map ../architecture.yaml
cp -r ~/Code/heai-tools/templates/software/{flows/session.yaml,flows/landing.yaml,scripts/session,scripts/landing} .   # then review.yaml, finding.yaml, scripts/review, scripts/findings, scripts/collectors
mkdir -p images/grc && $EDITOR images/grc/Containerfile        # FROM ${BASE}; python3, the cloud CLIs read-only, the agents
$EDITOR pod.yaml reactor.yaml
pod build && pod up --image grc/dev --env-from ~/.heai/grc-readonly.env && pod repo add compliance
reactor serve
operator
```

The first quarter runs with the reviews opened by the rule and every attestation by hand, which is what an auditor would ask for anyway; the agents' contribution is that `evidence-ready` arrives with the evidence already mapped.

# A finance team

*How an accounting team runs the month-end close on heai-tools, 2026-09-10: a repository of close checklists, reconciliation workpapers, journal entries and the policies behind them; an agent per ledger area that prepares reconciliations and drafts entries from the systems' exports; controllers who own every posted entry, every sign-off and the policies; and a calendar that opens the close on the first business day and will not let it end until every account is signed. Read [`project.md`](project.md) first for the directory and the tools.*

The close is the most process-shaped work a company has: the same accounts every month, in an order, each with a preparer and a reviewer, each with evidence, and a controller's signature at the end.
Agents prepare: pull the export, tie the balance, explain the variance, draft the entry.
People decide: post, sign, waive.
The journal `flow` keeps is the close binder the auditors ask for.

## The map

```yaml
# architecture.yaml
version: 1
unowned: fail

actors:
  controller:  { type: human, identity: '@controller' }
  ar-manager:  { type: human, identity: '@ar-manager' }
  ap-manager:  { type: human, identity: '@ap-manager' }
  recon-cash:
    type: llm-agent
    context: |
      You prepare the cash reconciliations under close/<period>/cash/: pull the bank export and the ledger
      export through the collectors, tie them, list every reconciling item with its evidence, and draft any
      entry needed under entries/<period>/drafts/. You never post. A difference you cannot explain is a task.
  recon-ar:
    type: llm-agent
    context: 'You prepare the receivables reconciliations and the aging under close/<period>/ar/, the same way recon-cash prepares cash.'
  recon-ap:
    type: llm-agent
    context: 'You prepare payables and accruals under close/<period>/ap/: the aging, the unrecorded-liabilities search, and the accrual drafts.'
  flux-analyst:
    type: llm-agent
    context: 'You write the fluctuation analysis under close/<period>/flux/: every account moving more than the threshold in policies/thresholds.yaml, with the reason from the reconciliations. You edit no reconciliation.'
    watches: [cash, ar, ap]

repositories:
  books: { remotePath: github.com/example/books, localPath: ../books }

territories:
  policies:
    owner: controller
    scope: [{ repository: books, globs: ['architecture.yaml', 'policies/**', 'checklist/**', 'scripts/**', 'collectors/**'] }]
    context: Accounting policies, thresholds, the close checklist and the collectors that touch the systems. The controller's alone.
  posted:
    owner: controller
    scope: [{ repository: books, globs: ['entries/*/posted/**', 'close/*/signoff/**'] }]
    context: What went into the ledger and who signed. Written only by the person who posted or signed.
  cash:
    owner: recon-cash
    scope: [{ repository: books, globs: ['close/*/cash/**', 'entries/*/drafts/cash-*.md'] }]
    dependsOn: [policies]
  ar:
    owner: recon-ar
    scope: [{ repository: books, globs: ['close/*/ar/**', 'entries/*/drafts/ar-*.md'] }]
    dependsOn: [policies]
  ap:
    owner: recon-ap
    scope: [{ repository: books, globs: ['close/*/ap/**', 'entries/*/drafts/ap-*.md'] }]
    dependsOn: [policies]
  flux:
    owner: flux-analyst
    scope: [{ repository: books, globs: ['close/*/flux/**'] }]
    dependsOn: [cash, ar, ap]
```

A preparer cannot post: `entries/*/posted/` is the controller's, and the ledger itself is reached only by a collector the controller owns, run on the host by the person posting.
A preparer cannot move a threshold to make a variance disappear: `policies/` is the controller's.
The flux analyst reads every reconciliation and writes only the analysis, so the explanation of a movement is never written by the one who reconciled it.

## The team

| member | kind | owns | does |
| --- | --- | --- | --- |
| `controller` | human | `policies`, `posted` | opens and closes the period, posts every entry, signs every account, waives what may be waived |
| `ar-manager`, `ap-manager` | human | nothing in the map; reviewers | review their area's reconciliations, approve drafts to be posted, answer the preparers |
| `recon-cash`, `recon-ar`, `recon-ap` | llm-agent | one area's workpapers each | pull exports, tie balances, list reconciling items with evidence, draft entries |
| `flux-analyst` | llm-agent | `flux` | explain every movement over the threshold from the reconciliations |
| the rules and the hooks | automation | nothing | open the close on the calendar, run collectors nightly, land workpapers, chase what is late, assemble the binder |

The two managers own no files: their work is reviewing and approving, which are moves on flows, not edits to the repository.
That is what a reviewer is here, and the map need not give them a territory to make their approval count.

## The flows

A **close** is one period, opened by the calendar and closed only when every account under it is signed or waived.
An **account** is one reconciliation in one period, prepared by an agent, reviewed by a manager, signed by the controller.
An **entry** is one journal entry from draft to posted.
The software team's `session` and `landing` are used as they are; workpapers land into `main` through a landing a rule lands for the preparers, because a landing posts nothing.

```yaml
# flows/close.yaml - one period
name: close
states: [open, reconciling, reviewed, closed]
initial: open
terminal: [closed]
links: { period: { required: true } }
transitions:
  - { from: open,        to: reconciling, on: started,   by: [open-period.sh] }
  - { from: reconciling, to: reviewed,    on: complete,  requires: { waits-on: { all: [signed, waived] } } }
  - { from: reviewed,    to: closed,      on: closed,    by: [human] }
  - { from: reviewed,    to: reconciling, on: reopened,  by: [human] }        # a period reopened after closing is a new close flow
hooks:
  open:        { run: scripts/close/open-period.sh }      # an account flow per line of the checklist, each waited on
  reviewed:    { run: scripts/close/binder.sh }           # the binder: every workpaper, sign-off and posted entry, as one PDF
  closed:      { run: scripts/close/lock.sh }             # the period locked in the ledger, through the controller's collector
```

```yaml
# flows/account.yaml - one reconciliation in one period
name: account
states: [assigned, prepared, reviewed, signed, waived, rejected]
initial: assigned
terminal: [signed, waived]
links:
  period:   { required: true }
  account:  { required: true }        # 1010-cash-operating
  area:     { required: true }        # cash | ar | ap
  reviewer: { required: true }        # the manager who reviews this line
  task:     { required: false }
transitions:
  - { from: assigned, to: prepared, on: landed,    when: { unexplained: 0 }, by: [land.sh] }
  - { from: assigned, to: rejected, on: landed,    by: [land.sh] }                       # an unexplained difference remains
  - { from: rejected, to: assigned, on: retry,     by: [human, retry.sh] }
  - { from: prepared, to: reviewed, on: reviewed,  by: [human] }                          # the area's manager
  - { from: prepared, to: assigned, on: returned,  by: [human] }                          # sent back with a note
  - { from: reviewed, to: signed,   on: signed,    by: [human] }                          # the controller
  - { from: reviewed, to: assigned, on: returned,  by: [human] }
  - { from: [assigned, rejected], to: waived, on: waived, by: [human] }                   # below materiality, the controller's call
  - { from: assigned, to: assigned, on: stale, after: 2d }                                # re-entered, so the reminder repeats
  - { from: prepared, to: prepared, on: stale, after: 2d }
hooks:
  assigned: { run: scripts/accounts/assign.sh }           # a task for the area's preparer: the account, last month's workpaper, the collectors
  rejected: { run: scripts/accounts/unexplained.sh }      # a task for the area's manager: the difference and what the preparer tried
  prepared: { run: scripts/accounts/review.sh }           # a task for the reviewer with the workpaper
  reviewed: { run: scripts/accounts/signoff.sh }          # a task for the controller
  signed:   { run: scripts/accounts/record.sh }           # close/<period>/signoff/<account>.md from the journal, committed as the signer
```

```yaml
# flows/entry.yaml - one journal entry
name: entry
states: [drafted, approved, posted, rejected]
initial: drafted
terminal: [posted, rejected]
links: { period: { required: true }, account: { required: true }, draft: { required: true } }
transitions:
  - { from: drafted,  to: approved, on: approved, by: [human] }                           # the area's manager
  - { from: drafted,  to: rejected, on: rejected, by: [human] }
  - { from: approved, to: posted,   on: posted,   by: [human] }                           # the controller, after the collector posted it
hooks:
  drafted:  { run: scripts/entries/review.sh }            # a task for the manager with the draft and the reconciling item it clears
  approved: { run: scripts/entries/stage.sh }             # a task for the controller: `scripts/collectors/post.sh <draft>` then `flow advance posted`
  posted:   { run: scripts/entries/record.sh }            # the draft moved to entries/<period>/posted/ with the ledger's document number
```

The `close` cannot reach `reviewed` until every `account` it waits on is `signed` or `waived`; that is the `requires` guard, fired by `flow settle`, and no script can move it early.
Every `signed`, `waived`, `approved` and `posted` is a person's.

## The rules

```yaml
# reactor.yaml
sources:
  clock:     { type: schedule, cron: "* * * * *" }
  tasks_cli: { type: cli, kinds: [task.todo] }
  landings:  { type: cli, kinds: [landing.proposed] }
  bank:      { type: poll, url: https://bank.example.com/api/statements/latest, every: 1h, watch: /statement_date }
rules:
  - { name: settle,       on: { source: clock },                                     run: flow settle }
  - { name: pick-cash,    on: { source: clock },                                     run: scripts/session/pick.sh recon-cash 2 }
  - { name: pick-ar,      on: { source: clock },                                     run: scripts/session/pick.sh recon-ar 2 }
  - { name: pick-ap,      on: { source: clock },                                     run: scripts/session/pick.sh recon-ap 2 }
  - { name: pick-flux,    on: { source: clock },                                     run: scripts/session/pick.sh flux-analyst 1 }
  - { name: land-papers,  on: { source: landings, kind: landing.proposed },          run: scripts/accounts/land.sh }
  - { name: open-close,   on: { source: clock, cron: "0 7 1 * *" },                  run: scripts/close/start.sh }
  - { name: collect,      on: { source: clock, cron: "0 2 * * *" },                  run: scripts/collectors/run-all.sh }
  - { name: statement,    on: { source: bank },                                      run: scripts/collectors/bank.sh }
  - { name: chase,        on: { source: clock, cron: "0 9 * * 1-5" },                run: scripts/close/chase.sh }
  - { name: flux,         on: { source: clock, cron: "0 12 5 * *" },                 run: scripts/close/flux.sh }
```

Reading it as policy: the close opens at 07:00 on the first; the collectors pull every system's export nightly and the bank statement the hour it appears; preparers work two accounts at a time; every workpaper landing lands on its own, because posting and signing are elsewhere; the flux analysis is asked for on the fifth, when most reconciliations are in; and every weekday morning the stale accounts are listed for whoever is late.

## The scripts

The session and landing scripts are the software team's; `accounts/land.sh` wraps `landing/land.sh` and advances the linked account with `landed` and the workpaper's `unexplained:` count.
The finance team adds:

| script | fires on | does |
| --- | --- | --- |
| `close/start.sh` | the first of the month | `flow start close --link period=2026-09`, `started` |
| `close/open-period.sh` | `close.open` | for each line of `checklist/close.yaml`: `flow start account --link period= --link account= --link area= --link reviewer=`, and `flow link <close> --waits-on <account>` |
| `accounts/assign.sh` | `account.assigned` | `tasks new` for the area's preparer: the account, last period's workpaper, the collectors' exports, the threshold from `policies/` |
| `accounts/unexplained.sh` | `account.rejected` | `tasks new` for the area's manager: the difference, the items tried, the evidence; the manager answers with `retry` and a note, or `waived` if the controller agrees |
| `accounts/review.sh` | `account.prepared` | `tasks new` for the reviewer with the workpaper and the entry drafts it produced |
| `accounts/signoff.sh` | `account.reviewed` | `tasks new` for `controller` |
| `accounts/record.sh` | `account.signed` | `close/<period>/signoff/<account>.md` from the journal line: preparer session, reviewer, signer, times; committed as the signer |
| `entries/review.sh` | `entry.drafted` | `tasks new` for the area's manager with the draft and the reconciling item it clears |
| `entries/stage.sh` | `entry.approved` | `tasks new` for `controller` whose body says: run `scripts/collectors/post.sh <draft>`, then `flow advance <entry> posted --note <document number>` |
| `entries/record.sh` | `entry.posted` | the draft moved to `entries/<period>/posted/` with the document number, committed as the controller |
| `collectors/run-all.sh` | nightly | each export under `collectors/`, on the host with read credentials, into `close/<period>/exports/`, landed by the rule |
| `collectors/bank.sh` | the statement poll changing | the statement into `close/<period>/exports/bank/`, and a `retry` on any cash account in `rejected` |
| `close/chase.sh` | weekday mornings | `flow list account --in assigned --json` and `--in prepared`, older than two days, as one task for `controller` naming who holds each |
| `close/flux.sh` | the fifth | `tasks new` for `flux-analyst` with every account over the threshold, from the landed workpapers |
| `close/binder.sh` | `close.reviewed` | every workpaper, sign-off, flux page and posted entry into one PDF under `close/<period>/binder.pdf` |
| `close/lock.sh` | `close.closed` | the period locked in the ledger through the controller's collector, as the controller |

The collectors are the only code that touches the bank, the ledger and the sub-ledgers.
They are the controller's, run on the host, and the preparers' pod sees only the exports they leave behind.

## A worked close

- **Sept 1, 07:00** - `start.sh` opens `2026-09`; `open-period.sh` starts 47 account flows from the checklist and links each as something the close waits on. The preparers' `pick` rules give them two at a time.
- **Sept 1-3** - `recon-ap` prepares the accrual accounts from the invoices export: for `2100-accrued-liabilities` it finds three invoices received after cutoff for September services, drafts `ap-accrual-2026-09.md` with the three lines and their evidence, and lands a workpaper with `unexplained: 0`. The account is `prepared`; `review.sh` files the AP manager's task; the entry draft's own flow is `drafted` and `entries/review.sh` files a second task. The manager reviews both, moves the account `reviewed` and the entry `approved`; `stage.sh` files the controller's posting task.
- **Sept 3** - `recon-cash` ties the operating account to the August 31 statement and is off by 1,240.00; it lists every outstanding item and still cannot explain it, lands with `unexplained: 1`. The account is `rejected`; `unexplained.sh` files a task for the AR manager, who recognizes a customer wire the bank coded oddly, notes it, and moves `retry`. The agent's next session ties it and lands; `prepared`.
- **Sept 5, 12:00** - the `flux` rule files the analyst's task; `flux-analyst` writes explanations for the eleven accounts over threshold, citing the reconciliations, and lands them.
- **Sept 8, 09:00** - `chase.sh` lists two accounts in `prepared` for three days, both waiting on the AP manager, who is out. The controller reassigns one to themselves by reviewing it directly.
- **Sept 9** - the controller posts the approved entries from the staging tasks, each `posted` with its document number, and signs accounts in batches from `operator`; `record.sh` writes each sign-off. One account, `1450-prepaid-misc`, has a 300.00 difference under materiality; the controller moves `waived` with a note.
- **Sept 10** - the last account is signed; `flow settle` fires the close's guard; the close is `reviewed`; `binder.sh` builds the binder. The controller reads it and moves `closed`; `lock.sh` locks the period.
- **Audit, in March** - the auditor asks who reconciled operating cash in September and what the 1,240.00 was. `flow trace period=2026-09 account=1010-cash-operating` prints the preparer's two sessions, the rejection, the AR manager's note, the review, the controller's signature, each dated and signed, and the workpaper commits beside them.

## Where a human steps in

- **At every posting and every signature.** `approved`, `posted`, `reviewed`, `signed` and `waived` are `by: [human]`, and the ledger is reached only by a collector a person runs.
- **At policy and thresholds.** `policies/` changes only by the controller's commit, so a variance cannot be defined away by the one explaining it.
- **At an unexplained difference**, where a manager brings what the agent could not know.
- **At the close itself.** The guard says when every account is done; the controller says when the period is closed.
- **At the checklist**, adding or retiring an account, which is a diff to a file the controller owns.

## Standing it up

```sh
mkdir ~/Code/close-project && cd ~/Code/close-project && git init
architect template > architecture.yaml && $EDITOR architecture.yaml && architect check
tasks init --dir tasks --map ../architecture.yaml
cp -r ~/Code/heai-tools/templates/software/{flows/session.yaml,flows/landing.yaml,scripts/session,scripts/landing} .   # then close.yaml, account.yaml, entry.yaml, scripts/close, scripts/accounts, scripts/entries, scripts/collectors
mkdir -p images/close && $EDITOR images/close/Containerfile        # FROM ${BASE}; python3, pandas, a spreadsheet reader, the agents
$EDITOR pod.yaml reactor.yaml
pod build && pod up --image close/dev && pod repo add books
reactor serve
operator
```

The first close runs with the preparers producing workpapers and every other move made by hand, which is one close's worth of a manager reading what an agent tied before trusting the `unexplained: 0` it reports.

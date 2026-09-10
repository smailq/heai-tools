# A platform and infrastructure team

*How infrastructure is run on heai-tools, 2026-09-10: a repository of Terraform, Kubernetes manifests and runbooks, an agent per system in the lower environments, a human who owns production and identity, and a release that is an `apply` only a person starts. Read [`project.md`](project.md) first for the directory and the tools; [`development-team.md`](development-team.md) is the shape this one is closest to.*

Infrastructure is the case where the map's `unowned: fail` earns its keep: a path nobody owns is a path nobody watches.
Agents own the manifests and modules for the systems they can be trusted with in `dev` and `staging`; a human owns `prod`, IAM and the network; a landing is a plan, a checkpoint is `terraform plan` and policy checks run in the pod, and a release is the `apply`, always a person's.
Incidents arrive from the pager as webhooks and become tasks routed by the alert's service label through `architect owner`.

## The map

```yaml
# architecture.yaml
version: 1
unowned: fail

actors:
  sre-lead:   { type: human, identity: '@sre-lead' }
  on-call:    { type: human, identity: '@on-call' }
  k8s-owner:
    type: llm-agent
    context: |
      You own the Kubernetes manifests and Helm values for dev and staging. Every workload has resource
      limits and a PodDisruptionBudget. You never touch prod/ or anything under iam/; file a request.
  data-infra-owner:
    type: llm-agent
    context: You own the databases and queues in dev and staging as Terraform modules. Migrations of schema are not yours.
  observability-owner:
    type: llm-agent
    context: 'You own dashboards, alert rules and SLOs as code. An alert without a runbook link is a bug.'
    watches: [k8s, data-infra]

repositories:
  infra: { remotePath: github.com/example/infra, localPath: ../infra }

territories:
  governance:
    owner: sre-lead
    scope: [{ repository: infra, globs: ['architecture.yaml', 'policy/**', '.github/**', 'scripts/**'] }]
  prod:
    owner: sre-lead
    scope: [{ repository: infra, globs: ['envs/prod/**'], exclude: { territories: [iam, network] } }]
    context: Every change here is applied by a person, from a plan they read.
  iam:
    owner: sre-lead
    scope: [{ repository: infra, globs: ['iam/**', 'envs/*/iam/**'] }]
  network:
    owner: on-call
    scope: [{ repository: infra, globs: ['network/**', 'envs/*/network/**'] }]
  k8s:
    owner: k8s-owner
    scope: [{ repository: infra, globs: ['k8s/**', 'envs/dev/k8s/**', 'envs/staging/k8s/**'] }]
    dependsOn: [network]
  data-infra:
    owner: data-infra-owner
    scope: [{ repository: infra, globs: ['modules/data/**', 'envs/dev/data/**', 'envs/staging/data/**'] }]
    dependsOn: [network]
  observability:
    owner: observability-owner
    scope: [{ repository: infra, globs: ['observability/**', 'runbooks/**'] }]
```

`envs/prod/**` and `iam/**` are the human's, so an agent that "fixes" a staging outage by widening a role or editing a prod value fails the gate before a plan is ever run.
`dependsOn` says the workloads may reference the network module and not the reverse.

## The team

| member | kind | owns | does |
| --- | --- | --- | --- |
| `sre-lead` | human | `governance`, `prod`, `iam` | edits the map and the policies, reads every plan for prod, starts every apply |
| `on-call` | human | `network` | triages incidents the pager files, answers agents, lands staging changes during an incident |
| `k8s-owner`, `data-infra-owner` | llm-agent | the lower environments of one system each | take routed tasks, change manifests and modules on a branch, keep plans clean |
| `observability-owner` | llm-agent | dashboards, alerts, runbooks | turns every new service and every incident into alert rules and a runbook |
| the rules and the hooks | automation | nothing | start sessions, plan every landing, apply to dev on their own, file incidents, run drift checks |

## The flows

The software team's `session`, `request`, `landing` and `checkpoint` are used as they are.
The platform team replaces `promotion` and `release` with two of its own: a **plan** per environment on a landed head, and an **apply**, which is the release.

```yaml
# flows/plan.yaml - terraform plan for one environment on one head
name: plan
states: [open, clean, changes, failed]
initial: open
terminal: [clean, changes, failed]
links: { head: { required: true }, env: { required: true }, landing: { required: false } }
transitions:
  - { from: open, to: clean,   on: planned, when: { changes: 0 }, by: [plan.sh] }
  - { from: open, to: changes, on: planned, by: [plan.sh] }
  - { from: open, to: failed,  on: failed,  by: [plan.sh] }
  - { from: open, to: failed,  on: stale,   after: 30m }
hooks:
  open:    { run: scripts/plan/plan.sh }                 # `pod run terraform plan -out`, policy checks, the plan file beside the flow
  changes: { run: scripts/plan/announce.sh }             # `reactor emit plans plan.changes` with env and resource counts; the rules decide
```

```yaml
# flows/apply.yaml - one plan applied to one environment
name: apply
states: [proposed, applying, applied, failed, refused]
initial: proposed
terminal: [applied, failed, refused]
links: { plan: { required: true }, env: { required: true }, head: { required: true } }
transitions:
  - { from: proposed, to: applying, on: approved, by: [human, apply.sh] }
  - { from: proposed, to: refused,  on: refused,  by: [human] }
  - { from: applying, to: applied,  on: applied,  by: [apply.sh] }
  - { from: applying, to: failed,   on: failed,   by: [apply.sh] }
  - { from: applying, to: failed,   on: stale,    after: 1h }
hooks:
  applying: { run: scripts/apply/apply.sh }             # `pod run terraform apply <the saved plan>`, the log beside the flow
  applied:  { run: scripts/apply/verify.sh }            # smoke checks, a note on every task carried
  failed:   { run: scripts/apply/page.sh }              # a task for on-call with the log, and `reactor emit` for the pager
```

An apply to `dev` is `approved` by `apply.sh` when a rule runs it; an apply to `staging` or `prod` has no such rule, so `approved` is only ever a person's `flow advance`, made after reading the saved plan the `plan` flow left beside itself.
The `applying` hook applies the saved plan and nothing else, so what was approved is exactly what runs.

## The rules

```yaml
# reactor.yaml
sources:
  clock:     { type: schedule, cron: "* * * * *" }
  tasks_cli: { type: cli, kinds: [task.todo] }
  landings:  { type: cli, kinds: [landing.proposed] }
  plans:     { type: cli, kinds: [plan.changes] }
  pager:     { type: webhook, path: /hook/pager, secret: env:PAGER_HOOK_SECRET, kind: /event_type, key: /incident/id }
  cloud:     { type: poll, url: https://status.cloud.example/api/v2/status.json, every: 5m, watch: /status/indicator }
rules:
  - { name: settle,        on: { source: clock },                                                    run: flow settle }
  - { name: pick-k8s,      on: { source: clock },                                                    run: scripts/session/pick.sh k8s-owner 1 }
  - { name: pick-data,     on: { source: clock },                                                    run: scripts/session/pick.sh data-infra-owner 1 }
  - { name: pick-obs,      on: { source: clock },                                                    run: scripts/session/pick.sh observability-owner 2 }
  - { name: land-obs,      on: { source: landings, kind: landing.proposed, territory: observability }, run: scripts/landing/land.sh }
  - { name: plan-dev,      on: { source: landings, kind: landing.proposed },                         run: scripts/plan/start.sh dev }
  - { name: apply-dev,     on: { source: plans, kind: plan.changes, env: dev },                      run: scripts/apply/start.sh --approve }
  - { name: plan-staging,  on: { source: clock, cron: "0 */2 * * *" },                              run: scripts/plan/start.sh staging }
  - { name: plan-prod,     on: { source: clock, cron: "0 6 * * *" },                                run: scripts/plan/start.sh prod }
  - { name: incident,      on: { source: pager, kind: incident.triggered },                          run: scripts/incidents/file.sh }
  - { name: provider-down, on: { source: cloud },                                                    run: scripts/incidents/provider.sh }
```

Reading it as policy: only `observability` lands without a person, because alert rules and dashboards cannot take a service down; every other landing waits for `on-call` or `sre-lead`.
Every proposed landing gets a `dev` plan at once, and a `dev` plan with changes is applied by the rule.
`staging` is planned every two hours and `prod` every morning, and both applies are a human's.
Drift shows up as a `plan.changes` on a head nobody landed, which `operator` shows as an open plan.

## The scripts

The session and landing scripts are the software team's.
The platform team adds:

| script | fires on | does |
| --- | --- | --- |
| `plan/start.sh <env>` | a landing proposed, or a schedule | `flow start plan --link head= --link env= --link landing=` |
| `plan/plan.sh` | `plan.open` | `pod run` in a workspace at the head: `terraform init`, `plan -out`, the policy checks under `policy/`; `planned` with the resource counts, or `failed`; the plan file and its text saved beside the flow |
| `plan/announce.sh` | `plan.changes` | `reactor emit plans plan.changes --payload '{"plan": ..., "env": ..., "adds": n, "changes": n, "destroys": n}'` |
| `apply/start.sh [--approve] <plan>` | the `apply-dev` rule, or a human | `flow start apply --link plan= --link env= --link head=`; with `--approve`, `flow advance approved --by apply.sh` |
| `apply/apply.sh` | `apply.applying` | `pod run terraform apply <saved plan>`, the log beside the flow; `applied` or `failed` |
| `apply/verify.sh` | `apply.applied` | smoke checks from `runbooks/<system>/verify.sh`; a task per failure to the system's owner |
| `apply/page.sh` | `apply.failed` | a task for `on-call` with the log's path; `reactor emit` to the pager's source if the project has one |
| `incidents/file.sh` | a pager webhook | the service label from the payload, `architect owner` over its manifests for the territory, `tasks new` with the incident's link and a provenance line; a `session` may start if the owner has a `pick` rule, or `on-call` takes it |
| `incidents/provider.sh` | the cloud status poll changing | a task for `on-call` naming the indicator; nothing else moves on its own |

## A worked day

- 07:00 - the morning `plan-prod` rule plans `prod` on `main`. The plan has one change nobody landed: a security group rule someone edited in the console. `announce.sh` emits it; no rule applies to `prod`; `operator` shows an open plan. `sre-lead` reads the plan, sees the drift, and files a task in `network` to codify or revert it.
- 09:00 - `on-call` moves `raise-worker-memory-limits` to `todo`; the `pick-k8s` rule starts a session. The agent changes `envs/staging/k8s/worker/values.yaml`, keeps the PodDisruptionBudget, settles clean; a landing is proposed in `k8s`; the `plan-dev` rule plans `dev` on the branch's head and the plan has two changes; `apply-dev` applies them. The landing itself waits for a person.
- 09:40 - `on-call` reads the landing's diff and the dev apply's log, lands it. The two-hourly `plan-staging` rule picks the change up at 10:00; the plan shows the same two changes; `on-call` approves the staging apply from `operator`; `verify.sh` runs the worker's smoke check and passes.
- 11:30 - the pager fires: `queue-depth-high` on `orders-worker`. `incidents/file.sh` finds the manifest's owner, `k8s-owner`, and files a task with the incident link; `pick-k8s` starts a session. The agent finds the consumer count too low, proposes a change to staging first as its context says, and files a request into `prod` for the same change. `on-call` lands the prod request as a human change and `sre-lead` approves the prod apply from the plan file. The incident's task carries both landings as notes.
- 14:00 - `observability-owner`, watching `k8s`, opens a task of its own: the new worker has no alert on queue depth beyond the one that fired. It writes the rule and the runbook, settles clean, and the `land-obs` rule lands it; nothing is applied, because alert rules deploy through their own operator on `main`.
- 18:00 - the cloud status poll changes to `major`; `provider.sh` files a task for `on-call` and nothing else moves.

`flow trace task=raise-worker-memory-limits` reads the session, the landing, the dev plan and apply, and the staging plan and apply, each move signed by the script or the person who made it.

## Where a human steps in

- **At every apply beyond `dev`.** `approved` on `staging` and `prod` is only ever a person's move, made from a saved plan.
- **At every landing except observability.** A diff to manifests or modules is read before it lands.
- **At drift.** An open `prod` plan with changes nobody landed is a person's to explain.
- **At incidents**, where `on-call` decides whether the agent's proposal is the fix or the workaround.
- **At `iam/` and `envs/prod/`**, which only `sre-lead` may change, and only through a landing they made themselves.
- **At the rules**, when a system earns automatic landing or `staging` earns automatic apply.

## Standing it up

```sh
mkdir ~/Code/infra-project && cd ~/Code/infra-project && git init
architect template > architecture.yaml && $EDITOR architecture.yaml && architect check
tasks init --dir tasks --map ../architecture.yaml
cp -r ~/Code/heai-tools/templates/software/{flows,scripts,reactor.yaml} . && rm flows/promotion.yaml flows/release.yaml   # then add plan.yaml, apply.yaml, scripts/plan, scripts/apply, scripts/incidents
mkdir -p images/infra && $EDITOR images/infra/Containerfile        # FROM ${BASE}; terraform, kubectl, helm, conftest, the agents
$EDITOR pod.yaml                                                    # images: { infra/dev: images/infra }, mounts: [./flow/flows:/heai/flow]
pod build && pod up --image infra/dev --env-from ~/.heai/infra-dev.env && pod repo add infra
reactor serve
operator
```

The env file handed to the pod carries credentials for `dev` and, at most, read-only ones for `staging` and `prod`, so a plan can run inside and an apply beyond `dev` cannot: `apply.sh` for those environments runs on the host, as the person who approved it.

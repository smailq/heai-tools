# integrator - design

*Design, 2026-09-04. Written before implementation; the README replaces it once the tool exists.*

Coordinates how finished work reaches a release: one **integration lane** per module, where many branches converge and are checked together before anything moves on; a **policy** per lane, because a website ships every green change and a desktop app ships a staged release; and the landing, checkpoint, promotion and release of each lane recorded as files, with the tracker told what landed.

The tools so far cover the map, the gate, the tracker and the runs.
What none of them covers is the stretch between "the run succeeded and the gate is clean" and "this is released": who merges what, into what, in what order, after which checks.
Today that is a human holding it in their head across nine actors' branches.
`integrator` is that stretch, written down.

## The shape of it

```
agent/<actor>/<slug> ─┐
agent/<actor>/<slug> ─┼─ land ─► integration/<lane> ─ checkpoint ─► promote ─► main ─ release ─► tag
agent/<actor>/<slug> ─┘            (many converge)     (checks run     (lane → main)   (staged lanes
                                                        on the whole                     only: version,
                                                        lane at once)                    final checks,
                                                                                         publish)
```

- **A lane is a branch that collects a module's work.** `integration/desktop`, `integration/website`, `integration/core`. Each is declared over a set of the map's territories, so every finished run knows its lane from the paths it changed.
- **Landing brings one branch into a lane.** Under the `local` host it is a merge the tool makes when a human says so; under the `github` host it is a pull request the tool opens and then watches.
- **A checkpoint freezes a lane and checks all of it.** The lane's head is recorded, the lane's checks run against that head, and the result is a file. A lane can land more while a checkpoint is open, but the checkpoint speaks for the head it recorded.
- **Promotion moves a passing checkpoint to the target.** The lane merges into `main` (or opens a pull request to it). What promotes is exactly what was checked.
- **Release is for staged lanes.** A version, final checks on the promoted head, a tag and a release branch, and a publish command the configuration names. Continuous lanes have no release step: promotion is the release.
- **The tracker learns what landed.** A task moves to `in-review` when its branch is put up for landing and to `done` when it lands, because "done means landed" is what the tracker already says, and this is the tool that knows.

Why lanes rather than branches straight to `main`: a module's changes need to be seen together before they ship - three agents' desktop branches may each be clean and still not build as a set - and a module's cadence is its own.
A lane is where "together" happens and where the cadence is declared, without either leaking into the map, which describes ownership, not process.

## Two policies

Every lane declares one:

**`continuous`.** Every landing that passes the lane's checks promotes at once.
Checkpoint and promotion are one step the tool runs on its own after each landing.
The website, the API, anything deployed from `main` by CI.
The lane still exists - it is the place the checks run on the merged result rather than on each branch alone - but it never holds work.

**`staged`.** Landings accumulate.
A human, or a schedule, calls a checkpoint; the whole lane is checked; a passing checkpoint may be promoted; a release is cut from the promoted head with a version, final checks and a publish command.
The desktop app, anything with installers, signing, an update channel, or a support burden per version.
The lane holds work between releases, which is the point: a release is a deliberate set, not whatever landed last.

The difference is one word in the configuration, and the commands are the same; a continuous lane simply runs `checkpoint` and `promote` for itself.

## What comes from the map, and what does not

**From the map:** which territories exist and who owns them.
A lane names territories; a run's changed paths resolve to territories through the map's globs, so a run's lane is derived, never typed.
A run that touches two lanes is not a mistake, it is a cross-module change: it lands in every lane it touches, and the tool says so.

**Not from the map:** lanes, branches, checks, policies, versions, publish commands.
Those are process, the category `task-manager` keeps out of a task and `agent-host` keeps out of the map.
They live in `integrator.yaml` beside the map.

The one rule the tool enforces from the map is the gate's: landing re-runs `scope-gate` on the branch's diff against the lane, as the branch's actor, and refuses a violation.
The run already carried a verdict; the lane may have moved since, and the merge result is what ships.

## Sources of work

A candidate for landing is a branch and the actor it is attributed to.
Three ways in:

- **agent-host run records**, read from `agent-host/runs/*.json` beside the map: every run `succeeded` with a clean gate whose ref is not yet landed is a candidate, with its task, its actor and its changed paths already known.
  This is a file-format contract between two tools, the same kind as map-editor reading the tracker; the tools still do not import each other.
- **A branch by name**, `integrator land --branch <name> --actor <name>`, for work a human or a harness made outside agent-host.
- **A pull request**, under the `github` host, for work that arrives as one.

A candidate's task, when it has one, is the tracker slug the run carried, or `--task` on the command line.

## Hosts

Where the branches live and how a merge is reviewed is a plugin, like agent-host's source, because the map assumes no host.

**`local`.** The repository on this machine.
`land` merges the branch into the lane with a merge commit whose message names the task, the run and the actor; the human's `land` command is the review.
`promote` merges the lane into the target the same way.
Nothing is pushed; the human pushes.

**`github`.** `land` pushes the branch and opens a pull request against the lane branch, titled from the task, with the run's gate verdict and changed paths in the body and the task's slug in a trailer; the tool records the pull request number and, on each settle, asks `gh` whether it merged.
`promote` opens the lane's pull request against `main`.
Review, required checks and merge happen where the team already does them; the tool watches and records.
Branch protection on lanes and on `main` is the team's, not the tool's.

A host answers five questions - push a branch, open a merge from A into B with a body, ask whether it merged and at what SHA, tag a commit, and whether a branch exists remotely - and `src/host.ts` is the contract.

## Checks

A lane declares its checks: named commands run in a checkout of the lane at the checkpoint's head.

```yaml
checks:
  - name: test
    run: pnpm test --filter desktop
  - name: typecheck
    run: pnpm -r typecheck
  - name: gate
    run: builtin:scope-gate      # the lane's whole diff against main, as each actor that landed
```

Each check writes its exit code and output to the checkpoint's directory; a checkpoint passes when every check exits 0.
Checks run on the host by default and, when the lane names an `image`, inside an Apple container with the checkout mounted at `/work` - the same mechanism agent-host uses, so a desktop build that needs a pinned toolchain runs in the toolchain's image.
`builtin:scope-gate` runs the gate over everything the lane changed since it last promoted, attributing each path to the actor that landed it; a lane that has drifted into someone else's territory is caught before it promotes, not after.

Release checks are a second list, `release.checks`, run once more on the promoted head before a tag: the slow ones, signing, the installer smoke test.

## The tracker

The tool writes task state, in exactly two places, through the task-manager CLI:

| event | task status | note appended |
| --- | --- | --- |
| `land` puts the branch up (a pull request opened, or a local merge about to be made) | `in-review` | which lane, and the pull request or the landing id |
| the landing merges into the lane | `done` | the lane, the merge SHA, and the checkpoint or release it later shipped in, added when that happens |

`done` means landed, as the tracker's own contract says; it does not mean released.
A staged lane's release adds a note to every task it carried, so a task reads "done - landed in `integration/desktop` at `a1b2c3d`, released in `desktop-v1.4.0`".
This closes agent-host's loop: an actor blocked on a task resumes when that task is `done`, which is now the moment its blocker's code is in the lane the actor will branch from.

Nothing else moves.
`in-progress` stays the actor's and the human's; `canceled` stays the human's; a task with no landing is never touched.

## agent-host and lanes

Two things change on agent-host's side, both small:

- **Base per lane.** An actor whose territories belong to a lane branches from that lane, not from `main`, so it sees what landed and has not yet promoted.
  agent-host reads `integrator.yaml` when it is beside the map and takes the lane's branch as the base for each actor the lane's territories route to; `agent-host.yaml`'s `base` stays the fallback.
- **Landing is the human's act, or the policy's.** A run ending clean does not land itself.
  Under `dispatch: auto` an actor may take the next task, but the branch waits in `integrator status` as a candidate until someone lands it - or until a lane says `land: auto` for that actor's work, which is a decision the configuration makes per lane, off by default.

Cross-module cooperation now has a full path: `tracker-smith` requests a `scope-gate` change and finishes blocked; `toolsmith` does it; it lands in `integration/tools`, the task goes `done`; the tracker's blocked task goes `todo`; `tracker-smith` resumes from `integration/tools`, which has the change.

## State: files beside the map

```
integrator/
  .gitignore                        `*`
  checkouts/<lane>/                 a clone per lane, for checks; the lane branch checked out
  landings/<id>.json                { id, lane, branch, actor, task, run, host: {pr}, status, mergeSha, gate }
  checkpoints/<lane>/<id>/          record.json, and <check>.log + <check>.exit per check
  promotions/<id>.json              { lane, checkpoint, target, status, host: {pr}, mergeSha }
  releases/<lane>/<version>/        record.json, release-check logs, the publish log
```

Ids sort chronologically, as agent-host's do.
Landing status is `proposed` (a pull request open, or a local merge pending a conflict), `landed`, `refused` (gate or conflict), `withdrawn`.
Nothing here is the source of truth for the branches - git is - so `status` reads git and the host each time and reconciles: a landing whose pull request merged is `landed` whether or not the tool was watching.

**Settling**, as in agent-host: every command first reconciles landings against the host, then runs whatever the policies demand - a continuous lane with a new landing checkpoints and promotes; a staged lane with a passing checkpoint and `promote: auto` promotes.
`integrator settle` runs it alone; `serve` runs it on an interval.

## The CLI

```
integrator status [<lane>]                lanes, candidates, landings, the last checkpoint, what is unpromoted
integrator land <run-id> | --branch <b> --actor <a> [--task <slug>] [--lane <l>]
integrator withdraw <landing-id>
integrator checkpoint <lane>              freeze the head, run the checks, record the result
integrator promote <lane> [--checkpoint <id>]
integrator release <lane> --version <v> [--dry-run]
integrator settle
integrator serve [--port 4848]
```

`land` resolves the lane from the run's changed paths unless `--lane` says otherwise, re-runs the gate against the lane, and either merges (local) or opens the pull request (github); a conflict or a violation refuses with the reason, and nothing has moved.
`checkpoint` prints each check's name and exit as it finishes, and the checkpoint id.
`promote` refuses without a passing checkpoint at the lane's current head; `--checkpoint` names an older one only if the head has not moved since it.
`release` refuses on a staged lane without a promoted checkpoint, runs the release checks, tags `<lane>-v<version>` on the promoted head, creates `release/<lane>-<version>` when the configuration asks for a branch, runs the publish command, and notes the release on every task it carried.
`--dry-run` does everything but the tag and the publish.

Exit codes: `0` done; `1` answered no - a refused landing, a failing checkpoint, a promotion with nothing to promote; `2` bad usage, a lane the configuration does not declare, a host that could not be asked.

## The page

`/`: every lane as a column - candidates, proposed, landed since the last promotion, the last checkpoint with its check results, the last release - in the palette of the other pages.
`/lane/<name>`: the lane's history and a **land** button per candidate, a **checkpoint** button, and **promote** and **release** when the state allows them.
`/checkpoint/<id>`, `/release/<lane>/<version>`: the records and the logs.
Plain forms that POST and redirect; the script adds the live check log.
Same-origin writes, loopback by default: this page merges and publishes.

API under `/api`: `lanes`, `lanes/<name>`, `candidates`, `landings`, `checkpoints/<id>`, `releases/<lane>`, and POSTs mirroring the commands; server-sent events for the page.

## Configuration: `integrator.yaml`

```yaml
host: local                       # or github
target: main                      # what lanes promote into

lanes:
  desktop:
    branch: integration/desktop
    territories: [desktop, react-ui]      # children of a territory follow it
    policy: staged
    image: heai/toolchain-desktop         # checks run in this container; omit to run on the host
    checks:
      - { name: typecheck, run: pnpm -r typecheck }
      - { name: test,      run: pnpm --filter desktop test }
      - { name: gate,      run: builtin:scope-gate }
    release:
      branch: true                        # also create release/desktop-<version>
      checks:
        - { name: build,   run: pnpm --filter desktop dist }
      publish: pnpm --filter desktop release   # or omit: tag only, CI publishes
  website:
    branch: integration/website
    territories: [website]
    policy: continuous
    checks:
      - { name: test, run: pnpm --filter website test }
      - { name: gate, run: builtin:scope-gate }
  core:
    branch: integration/core
    territories: [core, core-server, ontology, operator, mail-infra, extensions]
    policy: continuous
    checks:
      - { name: test, run: pnpm -r --filter './packages/*' test }
      - { name: gate, run: builtin:scope-gate }
```

A territory named by two lanes is an error; a territory named by none is reported by `status` and lands nowhere until it is placed.
Naming a parent territory places its children.
Human-owned territories may be in a lane like any other: a human's branch lands the same way.

## A worked day, on awareness3

`desktop-owner` and `web-ui` each finish a run; `website-owner` finishes one.

```sh
$ integrator status
lane      policy      branch                 landed  unpromoted  last checkpoint
desktop   staged      integration/desktop    7       7           cp-20260904-1012  pass
website   continuous  integration/website    0       0           -
core      continuous  integration/core       0       0           -

candidates
  20260904-093012-desktop-owner-4a1c  multiple-workspaces       desktop   gate clean
  20260904-094500-web-ui-77e0         entity-view-polish        desktop   gate clean
  20260904-095100-website-owner-12ff  blog-subscription         website   gate clean
$ integrator land 20260904-095100-website-owner-12ff
Landed blog-subscription into integration/website (a3f9c1e); task → done
Checkpoint cp-20260904-1103 on integration/website: test pass, gate pass
Promoted integration/website → main (b71d0aa)
```

The website lane is continuous, so landing was the release.
The desktop lane is staged:

```sh
$ integrator land 20260904-093012-desktop-owner-4a1c && integrator land 20260904-094500-web-ui-77e0
Landed multiple-workspaces into integration/desktop (c0de11a); task → done
Landed entity-view-polish into integration/desktop (d4e5f66); task → done
$ integrator checkpoint desktop
typecheck  pass   (41s)
test       pass   (3m 12s)
gate       pass   9 paths, 3 actors, no violations
Checkpoint cp-20260904-1130 on integration/desktop at d4e5f66: pass
$ integrator promote desktop
Promoted integration/desktop → main (e8a9b02), 9 landings
$ integrator release desktop --version 1.4.0
build      pass   (6m 40s)
Tagged desktop-v1.4.0 at e8a9b02; created release/desktop-1.4.0
Published: pnpm --filter desktop release (exit 0)
Noted desktop-v1.4.0 on 9 tasks
```

With `host: github`, the two `land` commands open pull requests instead, `status` shows them as proposed until they merge, and `promote` opens the lane's pull request against `main`; the checkpoint and release steps are unchanged.

## What v1 deliberately leaves out

- **Deploying.** `publish` is a command the configuration names; what it does is the module's business. CI owns deployment; the tool records that it was asked.
- **Hotfixes to a release branch.** `release/<lane>-<version>` is created and left alone; cherry-picks onto it are a human's, and a later version is a new release.
- **Conflict resolution.** A landing that conflicts is refused with the paths; the actor's task can be reassigned so the agent rebases (agent-host's resume already rebases on the base), or a human resolves it.
- **More than one target.** Every lane promotes into the one `target`.
- **Hosts beyond `local` and `github`.** The plugin contract is five questions; GitLab is a second file.

## Open questions

1. **Whether `done` should mean landed-in-lane or promoted.** The design says landed, because the tracker says so and because it is what lets a blocked actor resume from the lane. The cost is that a staged lane's `done` tasks are not yet released, which the release note on the task makes visible. The alternative, `done` at promotion, would stall cooperation until the next desktop release.
2. **Where lanes are declared.** Beside the map in `integrator.yaml`, with agent-host reading it for each actor's base. The alternative is a shared `.heai/lanes.yaml` both tools read as a first-class convention; better once the `.heai` directory spec lands, premature before.
3. **Whether the gate re-runs at landing under `github`.** Locally it must, since the tool merges. Under GitHub the merge is the host's; the tool can only run the gate when it opens the pull request and post the verdict in the body, and rely on branch protection for the rest - or run it again on settle after the merge and flag a landed violation after the fact.

## Layout

```
tools/integrator/
  DESIGN.md
  package.json            @heai-tools/integrator, Node 22.18+, one dependency: yaml
  src/
    cli.ts
    config.ts             integrator.yaml
    map.ts                territories and owners (read again, as the other tools do)
    lanes.ts              lane resolution from changed paths; a run's lane
    candidates.ts         agent-host run records as candidates (file-format contract)
    host.ts               the host contract; hosts/local.ts, hosts/github.ts
    checks.ts             running a check list in a checkout, on the host or in a container
    integrator.ts         the operations: land, checkpoint, promote, release, settle
    records.ts            the state directory
    tracker.ts            the two tracker writes, through the task-manager CLI
    server.ts             the page and the API
  test/
    lanes.test.ts         territory → lane resolution, parents, two-lane runs, unplaced territories
    integrator.test.ts    the operations against a temporary repository with a fake host and stub checks
    github.test.ts        the github host against recorded `gh` output
    server.test.ts
```

Implementation order: `lanes.ts` and `config.ts`; then the `local` host with `land`, `checkpoint`, `promote` and the tracker writes, which makes the continuous policy work end to end on a temporary repository; then `release` for staged lanes; then the page; then the `github` host against recorded `gh` output; then agent-host's per-lane base.

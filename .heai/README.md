# .heai

The project directory that develops heai-tools with heai-tools.

Every tool in [`tools/`](../tools) works on a project directory: one place holding the map, the agents, the tasks, the flow definitions, the scripts and each tool's configuration and state.
This is that directory for this repository, so the tools under development are also the tools in use, and a rough edge in one is felt here first.

It is being set up one tool at a time.

| file | tool | state |
| --- | --- | --- |
| [`architecture.yaml`](architecture.yaml) | architect | 10 territories, no actors; valid, no warnings |
| [`agents/`](agents) | the process | 8 agents: 5 workers, 3 gates |
| [`tasks/`](tasks) | tasks | initialised against the map; no tasks filed yet |
| `flows/`, `scripts/` | flow | not set up |
| `reactor.yaml` | reactor | not set up |
| `pod.yaml`, `images/` | pod | not set up |

## How it is used

Three things, each saying one kind of thing:

- **The map says where.** A territory is an area of the code with a boundary and a context: what is where, who relies on it, what must stay true, the commands that prove a change. It says nothing about who works there.
- **An agent file says who.** [`agents/`](agents) holds one file per agent: five *workers*, each an area of expertise (`cli`, `systems`, `tui`, `web`, `release`), and three *gates* (`judge`, `reviewer`, `verifier`). A worker's file is its craft; a gate's file is its role. Neither names a tool.
- **A task says which.** The producer who files a task sets its `territory` - the scope - and its `agent` - who does it. That choice is the producer's responsibility, and the one control the rest depends on.

A worker is prompted with its file, then `heai-architect context <territory>` for the task's territory, then the task.
Its change is then judged in order, each a state in a flow:

1. **The scope gate** - `git diff main... | heai-architect gate <territory>` - mechanical: every changed path is inside the task's territory, or the change is refused. A task scoped to cross a boundary names both territories, and the gate judges against their union.
2. **The judge** decides whether the change decides something it should not alone: the map, a schema, an output another tool reads, a command's surface, a dependency, a principle, a refactor nobody asked for.
3. **The reviewer** returns CLEAR, WATCH or BLOCK on the code; **the verifier** checks each acceptance criterion against evidence it produced.
4. **A human approves** - a transition only `human` may take, `heai-flow advance <id> approved` at the shell - on what has actually changed. No human is named in the map; the approval is on the diff.

Nothing in the map protects the map: a change to `.heai/` is a change like any other to the gate, always architectural to the judge, and lands only through the human approval.

Until the tracker, the flows and the pod are set up, these are run by hand, from the repository root.

```sh
heai-architect check                              # the map is valid
heai-architect territories                        # every territory, its parent, its globs
heai-architect context flow                       # what a worker or a gate in flow is given
heai-architect territory tools/flow/src/cli.ts    # which territory claims a path
git diff --name-only main... | heai-architect gate flow     # did this branch's change stay inside flow?
git add -AN && git diff HEAD | heai-architect gate flow     # the same over the working tree, untracked files included
```

## The map

One repository, `heai-tools`, at `..` from this directory.

| territory | claims |
| --- | --- |
| `platform` | `README.md`, `releasing.md`, `LICENSE`, `.gitignore`, `.github/workflows/ci.yml`, `.github/workflows/release.yml` |
| `process` | `.heai/**` |
| `tool-source` | what is directly in `tools/`, and a new tool's directory until it has a territory; parent of the seven below, and its context layers onto each |
| `architect` | `tools/architect/**` |
| `tasks` | `tools/tasks/**` |
| `flow` | `tools/flow/**` |
| `reactor` | `tools/reactor/**` |
| `pod` | `tools/pod/**` |
| `operator` | `tools/operator/**` |
| `operator-web` | `tools/operator-web/**` |

- `platform` names its files one by one, so a file added outside `tools/` and `.heai/` - a new workflow, a new root document - is unowned, and `unowned: allow` lets a change to it pass, until it is named there.
- Changing the map is an architectural decision: edit the file, run `heai-architect check`, and the judge and the human approval are what land it.
- A territory's context is written from the code as it stands, and a context that no longer matches the code is a defect in the map. Whoever finds one files a task scoped to `process`.

## How the tools find it

- `heai-architect`, `heai-tasks`, `heai-operator` and `heai-operator-web` look for `.heai/` in the current directory, so they are run from the repository root with no flags.
- `heai-flow`, `heai-reactor` and `heai-pod` take the project directory from `--dir`, else `HEAI_DIR`, else the current directory, so they are run with `HEAI_DIR=.heai` or from inside this directory.

The commands on PATH should be built from this checkout, so that a change to a tool is in use as soon as it is built:

```sh
cd tools/<tool> && npm install && npm link        # architect, tasks, flow, reactor, pod, operator-web
cd tools/operator && go install ./cmd/heai-operator
```

## Next

The first tasks in `.heai/tasks`, each naming its territory and its agent; then the flow definition for how a change is built, gated, judged, reviewed, verified, approved and landed, the scripts it runs, the pod that agents work in, and the reactor rules that start a move.

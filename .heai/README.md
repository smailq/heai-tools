# .heai

The project directory that develops heai-tools with heai-tools.

Every tool in [`tools/`](../tools) works on a project directory: one place holding the map, the tasks, the flow definitions, the scripts and each tool's configuration and state.
This is that directory for this repository, so the tools under development are also the tools in use, and a rough edge in one is felt here first.

It is being set up one tool at a time.

| file | tool | state |
| --- | --- | --- |
| [`architecture.yaml`](architecture.yaml) | architect | 9 territories, 10 actors; valid, no warnings |
| `tasks/` | tasks | not set up |
| `flows/`, `scripts/` | flow | not set up |
| `reactor.yaml` | reactor | not set up |
| `pod.yaml`, `images/` | pod | not set up |

## How it is used

The map says who may change what, and everything else follows from it.

- **A person owns what decides.**
  The root README and its design principles, CI and releases (`platform`), this directory (`process`), and what is shared across tools (`tool-source`) are `smailq`'s.
- **An agent owns each tool.**
  `tools/flow/**` is `flow-owner`'s, `tools/pod/**` is `pod-owner`'s, and so on for all six.
  An agent working on a tool is prompted with `heai-architect context <actor>`, which composes its own context, the context every tool shares, and its tool's invariants.
- **A change is judged against the map.**
  `heai-architect gate --actor <actor>` over the diff fails on any path the actor does not own.
  A change an agent needs in another tool is not made: it is a task for that tool's owner, or a reviewed edit to the map that moves the boundary.
- **Three agents watch and own nothing.**
  `reviewer` returns CLEAR, WATCH or BLOCK on a change; `verifier` checks each acceptance criterion against evidence it produced; `principles` flags a tool drifting from the design principles.
  None of them edits what it watches.

Until the tracker, the flows and the pod are set up, these are run by hand, from the repository root.

```sh
heai-architect check                              # the map is valid
heai-architect actors                             # who there is, what each owns and watches
heai-architect owner tools/flow/src/cli.ts        # which territory claims a path, and who owns it
heai-architect context flow-owner                 # what an agent working on flow is told
git diff --name-only main... | heai-architect gate --actor flow-owner   # may flow-owner have made this branch's change?
git add -AN && git diff HEAD | heai-architect gate --actor flow-owner   # the same over the working tree, untracked files included
```

## The map

One repository, `heai-tools`, at `..` from this directory.

| territory | owner | claims |
| --- | --- | --- |
| `platform` | `smailq` | everything outside `tools/` and `.heai/` |
| `process` | `smailq` | `.heai/**` |
| `tool-source` | `smailq` | what is directly in `tools/`; parent of the six below, and its context layers onto each |
| `architect` | `architect-owner` | `tools/architect/**` |
| `tasks` | `tasks-owner` | `tools/tasks/**` |
| `flow` | `flow-owner` | `tools/flow/**` |
| `reactor` | `reactor-owner` | `tools/reactor/**` |
| `pod` | `pod-owner` | `tools/pod/**` |
| `operator` | `operator-owner` | `tools/operator/**` |

- `tools/_map-editor/` is parked: no territory claims it, and `unowned: allow` lets a change to it pass.
  Picking it up again means giving it a territory and an owner.
- The map falls inside `process`, so no agent may change the boundaries it works within.
- Changing the map is an architectural decision: edit the file, run `heai-architect check`, and the review of that commit is the decision.

## How the tools find it

- `heai-architect`, `heai-tasks` and `heai-operator` look for `.heai/` in the current directory, so they are run from the repository root with no flags.
- `heai-flow`, `heai-reactor` and `heai-pod` take the project directory from `--dir`, else `HEAI_DIR`, else the current directory, so they are run with `HEAI_DIR=.heai` or from inside this directory.

The commands on PATH should be built from this checkout, so that a change to a tool is in use as soon as it is built:

```sh
cd tools/<tool> && npm install && npm link        # architect, tasks, flow, reactor, pod
cd tools/operator && go install ./cmd/heai-operator
```

## Next

The tracker at `.heai/tasks`, with its territories validated against this map; then the flow definitions for how a change to a tool is built, reviewed and landed, the scripts they run, the pod that agents work in, and the reactor rules that start a move.

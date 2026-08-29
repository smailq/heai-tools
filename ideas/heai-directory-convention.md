# The `.heai` directory convention

*Proposal, 2026-08-28. An idea report, not a spec: if adopted, the normative version belongs in `docs/` beside `architecture-map.md`.*

## The problem

Each tool today is told where its data lives on every invocation: `scope-gate` defaults to `./architecture.yaml` in the current directory, `task-manager` takes `--dir tasks` and points at the map through a relative path in `config.yaml`, and `map-editor` resolves a repository's `localPath` against wherever the server happened to be started. All of it works, and none of it composes: the tools share no answer to "where is this repository's heai data?", so every caller re-answers it, and a user who installs the tools globally still cannot run them from an arbitrary subdirectory without flags.

## The proposal

One conventional directory, discovered the way `.git` is: walk upward from the current directory until a `.heai/` is found.

```
<repo>/.heai/
  architecture.yaml     the map
  tasks/                the task-manager tracker (items/, config.yaml, INDEX.md, README.md)
  local.yaml            machine-local settings, gitignored
  config.yaml           only when the map lives elsewhere (multi-repo, below)

~/.heai/
  config.yaml           who I am: an identity matching a declared actor's `identity`
  repos.yaml            repository name → local checkout path
  cache/                derived data, always safe to delete
```

**Resolution precedence, which must be specced precisely:** an explicit flag, then a `HEAI_DIR` environment variable, then the nearest `.heai/` walking up from the current directory, then the legacy defaults (`./architecture.yaml`, `./tasks`). Nearest wins for nested checkouts.

The discovery algorithm should be written down in `docs/` as a normative spec and pinned by tests in each tool, the same way the glob dialect is: each tool implements it separately on purpose, and the shared test cases are what keep the implementations agreeing. That keeps the "tools do not import each other" rule intact while every tool discovers identically.

**The one line to hold:** global configuration may add convenience, never change a verdict. The map deliberately gives callers no flag to override the `unowned` posture, because a caller that could opt out of fail-closed would make the posture meaningless. The same reasoning binds `~/.heai`: nothing in a home directory may make a gate pass that would fail in CI. A verdict that differs between a laptop and CI because of a home-directory file breaks the enforcement story entirely.

## What this buys each tool

- **scope-gate** becomes `git diff origin/main... | npx @heai-tools/scope-gate --territory api` from any subdirectory of any governed repository, with no `--map`. Better: discovery can often infer `--repo` too, since the map's `repositories` entries plus a checkout registry say which repository the current directory sits in - so the multi-repo case stops needing a flag per invocation.
- **task-manager** loses the `config.yaml: map: ../architecture.yaml` relative-path plumbing: the map is a sibling by convention. `--dir` stays as an override; the default becomes `.heai/tasks`.
- **map-editor** keeps its paste-in/export-out model, but "start the server from the tree the map governs" becomes unnecessary: the server discovers `.heai/` and can offer the current map as a one-click load - still never writing it back, since what lands in the repository being a file you moved yourself is worth keeping.

## The self-governance win

The subtlest benefit: a conventional location makes the map's *own protection* conventional. Today "the map falls outside every human-owned territory" is a validator warning each adopter resolves by hand. With `.heai/`, the starter map ships the split pre-written:

- `.heai/architecture.yaml` and `.heai/config.yaml` - a human-owned territory, the governance surface
- `.heai/tasks/**` - the tracker agent's territory
- generated agent files (below) - derived, checked by CI, never hand-edited

An `init` command scaffolds exactly this, so a day-one adopter gets the "map protects itself" property without reading the design doc first.

## What belongs in `~/.heai`, and what must not

Belongs:

- **`localPath` moves out of the committed map.** The design doc already flags the tension: `localPath` is the one part of a map that is about the machine rather than the architecture. A `~/.heai/repos.yaml` registry (repository name → checkout path) resolves it cleanly: the committed map stays pure architecture, map-editor's file tree and cross-repo tools read the registry, and two people with different checkout layouts stop diffing each other's map. A per-repo `.heai/local.yaml`, gitignored, covers the same need where a path is project-specific.
- **Identity.** `~/.heai/config.yaml` holding `identity: <handle or email>` lets a tool resolve *which declared actor the user is* by matching against the actors' `identity` fields. That makes `scope-gate` with no subject meaningful - "check my diff as me" - and attribution stops being re-typed per invocation.
- **Cache** of derived data (compiled globs, validation results keyed by map hash), always safe to `rm -rf`.

Must not: postures, subject overrides, anything a gate's exit code depends on. Identity inference is the one exception, and even there CI should require the explicit flag - conveniently, no `~/.heai` exists in CI, a natural forcing function.

## LLM agent files and skills

This is where the convention pays off most, because it inverts the current distribution model.

1. **Generate agent files from the map instead of shipping them.** The map already holds each llm-agent's `context` and each territory's `context` - that *is* an agent definition, minus formatting. A `heai agents build` command renders `.claude/agents/<actor>.md` (and an `AGENTS.md` section for other harnesses) from the map: actor context, owned territories and their contexts, and the standing rules - run the scope gate before committing, route task changes through the tracker agent. Generated files get the same treatment as `INDEX.md`: derived, deterministic, `--check` in CI so they cannot drift from the map. The current `agent/task-manager.md` "copy and edit two marked lines" becomes the first template of this generator. One source, no drift - which is also what the map doc's context-freshness check wants.
2. **One installable skill instead of per-repo copies.** Because discovery is conventional, a single globally-installed agent skill works in every governed repository: find `.heai/`, learn which actor the session acts as and what territory that grants, run the gate on the diff before finishing, route tasks through the task manager. The repository carries data (`.heai/`), npm carries behavior (the tools), the skill carries the bridge - nothing is copied per project.
3. **Live enforcement via hooks, not only CI.** scope-gate's exit-code contract is already hook-shaped. A pre-edit or session-end hook piping the working-tree diff through `scope-gate --actor <current>` gives an agent *in-session* confinement: the violation surfaces while the agent can still fix it, instead of at PR time. The convention is what makes such a hook installable once, globally, rather than configured per repository.
4. **An environment contract for agent identity.** Define `HEAI_ACTOR` as the way a harness tells tools which declared actor a session acts as. Generated agent files set it; scope-gate and task-manager read it as the default subject. That gives "attribution is the surrounding tooling's job" a concrete, portable answer.

## Multi-repo maps

One map governing several repositories needs an anchor in each governed repository. A governed repository that does not hold the map carries just `.heai/config.yaml` with `map:` pointing at it - a relative path into a sibling checkout, resolved through `~/.heai/repos.yaml`, or eventually a fetchable reference. Discovery then works identically everywhere: find `.heai/`, follow `map:` where present, else expect `architecture.yaml` in place. The governance repository holding the map is itself just a repository with a full `.heai/`.

## Packaging and adoption

- **An umbrella `heai` CLI** - `heai init`, `heai gate`, `heai tasks …`, `heai map`, `heai agents build`, `heai doctor` - as a thin npm dispatcher over the per-tool packages. It does not violate tool independence if it only shells out to their published bins: a router, not a library. `npx heai init` becomes the entire onboarding story.
- **`heai doctor`** is cheap and high-leverage: map validates, no overlaps, tracker view fresh, agent files fresh, contexts not stale, `local.yaml` gitignored - one command that says "your `.heai` is healthy."
- **Legacy defaults keep working** - a bare `architecture.yaml` at the root, a `tasks/` directory - with a doctor hint suggesting the move, so existing adopters are not broken by the convention landing.

## Risks to watch

- **Discovery ambiguity in monorepos and nested checkouts.** The "nearest `.heai` wins" rule must be specced and pinned, or two tools will disagree the way glob dialects usually do.
- **`.heai` accreting machine state.** Hold the line: everything committed under `.heai/` is reviewable architecture or work data; everything machine-ish goes to `local.yaml` or `~/.heai`.
- **Generated agent files being hand-edited.** The same failure `build --check` already guards against in the tracker; reuse that pattern from day one.

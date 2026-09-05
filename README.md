# heai-tools

Development tools for human experts and AI working together

## The architecture map

Everything builds on a single file, the **architecture map** (`architecture.yaml`): an attempt to hold key architectural guardrails, clear territory ownership definitions, and a visualizable picture of the architecture in one place, for a system spread across one or more repositories.
The map assigns each governed path to at most one owner - exactly one wherever the map is exhaustive - naming a declared actor, human or llm-agent, programmatically enforces architectural rules and limits (scope gates, import boundaries), steers each owning llm-agent through inline actor and territory context, and is the file human experts edit to manage the architecture.
Adoption is incremental: a partial map is legal, so a repository can claim one territory on day one and extend coverage from there.

- [`schemas/architecture.schema.json`](schemas/architecture.schema.json) - JSON Schema (draft 2020-12) for the map
- [`docs/architecture-map.md`](docs/architecture-map.md) - design rationale, semantics, and the rules a validator must enforce beyond the schema

## Design principles

These hold for every tool in [`tools/`](tools) and for every tool proposed.
A change that breaks one needs a reviewed edit to this section first.

**1. Each tool stands alone.**
A tool is a directory with its own manifest, its own dependencies, its own `test` and `typecheck`, built and run from that directory with no root-level setup.
It never imports source from another tool.
Logic two tools need is either published - depended on as a package by name, as `map-editor` depends on `map-check` - or written twice on purpose, with the copies pinned by shared test cases, as the glob dialect is in `scope-gate` and `map-check`.

**2. The command line is the primary interface.**
Every capability a tool has is reachable from its CLI, works with no server running, and answers with the exit-code split `0` yes, `1` no, `2` the question could not be asked.
A web page or an API, where a tool has one, is a view over the same operations through the same functions, holds no state of its own, and adds nothing the CLI cannot do.

**3. Tools cooperate through files, not through each other.**
What passes between tools is a file with a simple, documented format: the architecture map and its JSON Schema, a tracker's markdown tasks, a run record, a configuration beside the map.
A tool that needs another tool's behaviour shells out to its CLI; a tool that needs another tool's knowledge reads its files.
Reading a sibling's files is a format contract, stated in that sibling's README and pinned by a test, never a shared library.

**4. Formats are plain, small, and universal.**
YAML, markdown with fixed frontmatter, JSON, and append-only JSON lines.
Every field is named and its meaning written down; a format carries only what its owning tool needs and nothing that belongs to another tool or to a particular harness, version-control system, or host.
Derived views are regenerated, never hand-edited, and a `--check` catches drift.
Machine state lives beside the map in a directory that ignores itself and is never the source of truth for anything git or another file already records.

**5. The map is the single source of ownership, and process stays out of it.**
Actors, territories, ownership and dependency edges live in `architecture.yaml` and nowhere else.
How work runs - images, branches, lanes, schedules, credentials - lives in each tool's configuration beside the map.
Every tool reads the map and validates against the same schema and the same rules in [`docs/architecture-map.md`](docs/architecture-map.md); none may work around them.

**6. No supervisor.**
No tool holds a process that other tools must talk to.
A long-running step writes its own outcome to a file; whichever tool looks next settles it.
What is running is asked of the system that runs it, never remembered.

**7. Anything outside this repository is a plugin.**
Harnesses, version-control systems, code hosts, event sources and container runtimes sit behind a small contract with at least one built-in implementation and a test against recorded output.
The tool's own code never names one of them.

## Tools

[`tools/`](tools) holds one directory per tool, each built to the principles above: its own manifest, its own dependencies, its own test command, built and run from its own directory.
Tools here will target different languages, so there is no shared build at the root.

- [`tools/map-check`](tools/map-check) - the reference validator for the map, as a command for CI and as the library `map-editor` validates through, with the queries other tools shell out for: who owns a path, what an actor is composed with.
- [`tools/scope-gate`](tools/scope-gate) - checks a diff against the map's ownership boundaries.
- [`tools/map-editor`](tools/map-editor) - a web editor for visualizing and editing the map: the system drawn from it, live validation, and paste-in/export-out so the map stays a file you move yourself.
- [`tools/task-manager`](tools/task-manager) - a task tracker kept as markdown files in the repository, owned by an agent, with `territory` validated against the map so a task routes to the actor that owns the code it touches.
- [`tools/agent-host`](tools/agent-host) - hosts the map's llm-agent actors, one Apple container each: assigns them tracker tasks, checks each run's branch with the scope gate, and lets an actor ask another territory for work by filing a task and finishing blocked.

## Ideas

Potential features, not commitments.

- **Deprecated edges.** A `dependsOn` edge that still passes but warns, for a dependency being refactored away. Today an edge can only be kept or deleted, with nothing in between.
- **A group actor type.** A team or other named set of people as one owner, so a territory several people stand behind keeps exactly one owner and the no-overlap rule holds unchanged. It is how shared stakeholding gets expressed without co-ownership.
- **Composable maps.** One reviewed file is the design's central bet, but every territory edit funnels through it. Splitting a map into files that compose into one would keep the single reviewed picture without the single bottleneck.
- **Studies of neighbouring projects.** [oh-my-claudecode](ideas/oh-my-claudecode-study.md), [ECC](ideas/ecc-study.md) and [ponytail](ideas/ponytail-study.md): what each has that heai-tools can lift - reviewer and verifier contracts, a pre-edit territory gate, done criteria and evidence on a task, run receipts - and what not to take.
- **Warn on foreign glob syntax.** The glob dialect is deliberately small, so `[`, `{` and `!` are literal characters. They mean something in every neighbouring dialect, including gitignore and doublestar, so a validator warning would catch the habit before it becomes a silent mismatch.

## License

MIT - see [LICENSE](LICENSE).

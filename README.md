# heai-tools

Development tools for human experts and AI working together

## The architecture map

Everything builds on a single file, the **architecture map** (`architecture.yaml`): an attempt to hold key architectural guardrails, clear territory ownership definitions, and a visualizable picture of the architecture in one place, for a system spread across one or more repositories.
The map assigns each governed path to at most one owner - exactly one wherever the map is exhaustive - naming a declared actor, human or llm-agent, programmatically enforces architectural rules and limits (scope gates, import boundaries), steers each owning llm-agent through inline actor and territory context, and is the file human experts edit to manage the architecture.
Adoption is incremental: a partial map is legal, so a repository can claim one territory on day one and extend coverage from there.

- [`schemas/architecture.schema.json`](schemas/architecture.schema.json) - JSON Schema (draft 2020-12) for the map
- [`docs/architecture-map.md`](docs/architecture-map.md) - design rationale, semantics, and the rules a validator must enforce beyond the schema

## Tools

[`tools/`](tools) holds one directory per tool, each independent: its own manifest, its own dependencies, its own test command, built and run from its own directory.
Tools here will target different languages, so there is no shared build at the root.

- [`tools/scope-gate`](tools/scope-gate) - checks a diff against the map's ownership boundaries.
- [`tools/map-editor`](tools/map-editor) - a web editor for visualizing and editing the map: the system drawn from it, live validation, and paste-in/export-out so the map stays a file you move yourself.
- [`tools/task-manager`](tools/task-manager) - a task tracker kept as markdown files in the repository, owned by an agent, with `territory` validated against the map so a task routes to the actor that owns the code it touches.

## Ideas

Potential features, not commitments.

- **Deprecated edges.** A `dependsOn` edge that still passes but warns, for a dependency being refactored away. Today an edge can only be kept or deleted, with nothing in between.
- **A group actor type.** A team or other named set of people as one owner, so a territory several people stand behind keeps exactly one owner and the no-overlap rule holds unchanged. It is how shared stakeholding gets expressed without co-ownership.
- **Composable maps.** One reviewed file is the design's central bet, but every territory edit funnels through it. Splitting a map into files that compose into one would keep the single reviewed picture without the single bottleneck.
- **Warn on foreign glob syntax.** The glob dialect is deliberately small, so `[`, `{` and `!` are literal characters. They mean something in every neighbouring dialect, including gitignore and doublestar, so a validator warning would catch the habit before it becomes a silent mismatch.

## License

MIT - see [LICENSE](LICENSE).

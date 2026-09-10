# Tools

One directory per tool, each independent.

Tools here target different languages and ecosystems, so there is no shared build at the root: a tool brings its own manifest, its own dependencies, and its own test command, and is built and run from its own directory.

## What a tool must provide

- **A manifest of its ecosystem** - `package.json`, `go.mod`, `pyproject.toml`, `Cargo.toml`.
- **`test` and `typecheck` (or the ecosystem's equivalent), runnable from the tool's own directory** with no root-level setup.
- **A `README.md`** covering what it does, how it is invoked, and its exit codes.

## Independence

The normative statement is the [design principles](../README.md#design-principles) in the root README; this is the short form.
A tool must not import source from another tool.
Where two tools need the same logic, either publish it or implement it twice on purpose - a copy whose divergence is caught by tests beats a shared library that couples release cycles across ecosystems.

Tools read [`architect/schemas/architecture.schema.json`](architect/schemas/architecture.schema.json) and the map's rules in [`architect/README.md`](architect/README.md) as their contract, not each other.

## Tools

- [`architect`](architect) - the reference validator for the map, the owner, territory, actor and context queries other tools shell out for, and the scope gate that checks a diff against the map's ownership boundaries, as a command and a library.
- [`map-editor`](_map-editor) - a web editor for visualizing and editing the map.
- [`tasks`](tasks) - a file-based task tracker for a repository, managed by an agent.
- [`reactor`](reactor) - the one daemon, and a router: ticks, commits, webhooks, polls and `reactor emit` become events, and each event runs the one script its rule names.
- [`pod`](pod) - one persistent container running Herdr, a worktree per piece of work, an agent or a command in it, and a fact file when it settles.
- [`flow`](flow) - a state machine per record and a graph of records: a definition per process with one script per state, an append-only journal per flow, the script run on each state entered, and one command that says what state anything is in, what it waits on, and what is stuck.
- [`operator`](operator) - an `htop`-shaped terminal view of the tools' state: tasks, flows and sessions, read from their files and CLIs.

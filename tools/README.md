# Tools

One directory per tool, each independent.

Tools here target different languages and ecosystems, so there is no shared build at the root: a tool brings its own manifest, its own dependencies, and its own test command, and is built and run from its own directory.

## What a tool must provide

- **A manifest of its ecosystem** - `package.json`, `go.mod`, `pyproject.toml`, `Cargo.toml`.
- **`test` and `typecheck` (or the ecosystem's equivalent), runnable from the tool's own directory** with no root-level setup.
- **A `README.md`** covering what it does, how it is invoked, and its exit codes.
- **A released command named `heai-<tool>`**, where `<tool>` is the directory name: a Node tool sets `bin` to that name and builds into `dist/` on `npm install` (so an installed package never depends on Node stripping types under `node_modules`); a Go tool keeps its `main` under `cmd/heai-<tool>`. A tool that shells out to another asks for it by the released name.
- **A release per tool**, from a GitHub release tagged `<tool>-v<version>`; [`releasing.md`](../releasing.md) has the procedure.

## Independence

The normative statement is the [design principles](../README.md#design-principles) in the root README; this is the short form.
A tool must not import source from another tool.
Where two tools need the same logic, either publish it or implement it twice on purpose - a copy whose divergence is caught by tests beats a shared library that couples release cycles across ecosystems.

Tools read [`architect/schemas/architecture.schema.json`](architect/schemas/architecture.schema.json) and the map's rules in [`architect/README.md`](architect/README.md) as their contract, not each other.

## Tools

- [`architect`](architect) - the reference validator for the map, the territory and context queries other tools shell out for, and the scope gate that checks a diff against the territory a change was scoped to, as a command and a library.
- [`tasks`](tasks) - a file-based task tracker for a repository, managed by an agent.
- [`reactor`](reactor) - the one daemon, and a router: ticks, commits, webhooks, polls and `heai-reactor emit` become events, and each event runs the one script its rule names.
- [`pod`](pod) - one persistent container watching a work queue: a job is a directory with a `job.json` and a `workdir/`, the worker runs the job's command, and its `stdout`, `stderr` and `result.json` land beside it.
- [`flow`](flow) - a state machine per record and a graph of records: a definition per process with one script per state, an append-only journal per flow, the script run on each state entered, and one command that says what state anything is in, what it waits on, and what is stuck.
- [`operator`](operator) - an `htop`-shaped terminal view of the tools' state: tasks, flows, the pod's jobs and the reactor's events, read from their files and CLIs; written in Go, and read-only.
- [`operator-web`](operator-web) - the same as a web page, each flow definition drawn as its state machine, and an editor for the map that saves it back.

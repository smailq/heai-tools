# Tools

One directory per tool, each independent.

Tools here target different languages and ecosystems, so there is no shared build at the root: a tool brings its own manifest, its own dependencies, and its own test command, and is built and run from its own directory.

## What a tool must provide

- **A manifest of its ecosystem** - `package.json`, `go.mod`, `pyproject.toml`, `Cargo.toml`.
- **`test` and `typecheck` (or the ecosystem's equivalent), runnable from the tool's own directory** with no root-level setup.
- **A `README.md`** covering what it does, how it is invoked, and its exit codes.

## Independence

A tool must not import source from another tool.
Where two tools need the same logic, either publish it or implement it twice on purpose - a copy whose divergence is caught by tests beats a shared library that couples release cycles across ecosystems.

Tools read [`../schemas/architecture.schema.json`](../schemas/architecture.schema.json) and [`../docs/architecture-map.md`](../docs/architecture-map.md) as their contract, not each other.

## Tools

- [`scope-gate`](scope-gate) - checks a diff against the map's ownership boundaries.
- [`map-editor`](map-editor) - a web editor for visualizing and editing the map.
- [`task-manager`](task-manager) - a file-based task tracker for a repository, managed by an agent.

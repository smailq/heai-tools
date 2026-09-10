# heai-tools

Development tools for human experts and AI working together

## The architecture map

Everything builds on a single file, the **architecture map** (`architecture.yaml`): an attempt to hold key architectural guardrails, clear territory ownership definitions, and a visualizable picture of the architecture in one place, for a system spread across one or more repositories.
The map assigns each governed path to at most one owner - exactly one wherever the map is exhaustive - naming a declared actor, human or llm-agent, programmatically enforces architectural rules and limits (scope gates, import boundaries), steers each owning llm-agent through inline actor and territory context, and is the file human experts edit to manage the architecture.
Adoption is incremental: a partial map is legal, so a repository can claim one territory on day one and extend coverage from there.

- [`tools/architect/schemas/architecture.schema.json`](tools/architect/schemas/architecture.schema.json) - JSON Schema (draft 2020-12) for the map
- [`tools/architect/README.md`](tools/architect/README.md) - the map explained: what each section means, the rules a validator must enforce beyond the schema, and the tool that enforces them

## The project directory

The tools run against one directory that holds the map, the tasks, the flow definitions with their hooks, the scripts that make each move, the reactor's rules, and every tool's configuration and state.
The tools know no process; the process is the user's, written in that directory, and a human sits wherever a definition says a move is theirs.

- [`docs/project.md`](docs/project.md) - the system as a whole: the directory, what each tool does in it, and how humans, agents and automation run a piece of work through it
- [`docs/development-team.md`](docs/development-team.md) - a software team on the tools: agents per area of the code, sessions on branches, and landing, checkpoint, promotion and release as chained flows
- [`docs/marketing-team.md`](docs/marketing-team.md) - a marketing operations team on the tools: a writer per channel, an analyst over the experiments, a human who owns the brand and the publish button
- [`docs/platform-team.md`](docs/platform-team.md) - a platform team: agents own the lower environments, a human owns production and identity, a plan per landing and an apply only a person starts
- [`docs/compliance-team.md`](docs/compliance-team.md) - a compliance team: agents gather and map evidence, a quarterly clock opens a review per control, and every attestation is a human's move
- [`docs/research-team.md`](docs/research-team.md) - a research team: feeds file papers, a reader agent per topic writes the notes, humans own the syntheses and the weekly digest
- [`docs/legal-team.md`](docs/legal-team.md) - a legal team: agents assemble drafts from the clause library and redline against the playbook, counsel makes every move a counterparty sees
- [`docs/support-team.md`](docs/support-team.md) - a customer support team: ticket clusters and release notes become article fixes, an agent per product area drafts, the editor publishes
- [`docs/finance-team.md`](docs/finance-team.md) - a finance team: the month-end close as flows, agents prepare reconciliations and draft entries, the controller posts and signs

## Design principles

These hold for every tool in [`tools/`](tools) and for every tool proposed.
A change that breaks one needs a reviewed edit to this section first.

**1. Each tool stands alone.**
A tool is a directory with its own manifest, its own dependencies, its own `test` and `typecheck`, built and run from that directory with no root-level setup.
It never imports source from another tool.
Logic two tools need is either published - depended on as a package by name, as `map-editor` depends on `architect` - or written twice on purpose, with the copies pinned by shared test cases.

**2. The command line is the primary interface.**
Every capability a tool has is reachable from its CLI, works with no server running, and answers with the exit-code split `0` yes, `1` no, `2` the question could not be asked.
A web page, where a tool has one - today only `map-editor`, whose job is the page - is a view over the same operations through the same functions, holds no state of its own, and adds nothing a file and the validator cannot do.

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
How work runs - images, branches, schedules, credentials - lives in each tool's configuration beside the map, and the process itself in the project's flow definitions and reactor rules.
Every tool reads the map and validates against the same schema and the same rules in [`tools/architect/README.md`](tools/architect/README.md); none may work around them.

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

- [`tools/architect`](tools/architect) - the map as one tool: the reference validator, as a command for CI and as the library `map-editor` validates through; the queries other tools shell out for, who owns a path and what an actor is composed with; and the scope gate, which checks a diff against the map's ownership boundaries.
- [`tools/_map-editor`](tools/_map-editor) - a web editor for visualizing and editing the map: the system drawn from it, live validation, and paste-in/export-out so the map stays a file you move yourself.
- [`tools/tasks`](tools/tasks) - a task tracker kept as markdown files in the repository, owned by an agent, with `territory` validated against the map so a task routes to the actor that owns the code it touches.
- [`tools/reactor`](tools/reactor) - the one daemon, and a router: schedules, git polls, webhooks, URL polls and `reactor emit` become events, and each event runs the one script the matching rule names, with the event in its environment.
- [`tools/pod`](tools/pod) - the hands: one persistent container with a Herdr server, a git worktree per piece of work, an agent or a command in it, and a fact file into a flow's inbox when it settles.
- [`tools/operator`](tools/operator) - an `htop`-shaped terminal view of what the tools are doing, refreshed on its own clocks and reading each tool's own files and CLIs: every task with the actor it routes to and where its blocker stands, what `flow` says is open and stuck, and the sessions and workspaces; keys act through the tools, and `--once` or `--json` is the same screen for a script.
- [`tools/flow`](tools/flow) - tracks a multi-stage process as a state machine per record and a graph of records: a YAML definition says which moves are legal and which script runs on entering each state, an append-only journal per flow records every move made, fact files let a container or a CI job record one with nothing installed, each state entered runs its script detached, and `trace` and `stuck` answer where anything is and what it waits on.

## Ideas

Potential features, not commitments.

- **Deprecated edges.** A `dependsOn` edge that still passes but warns, for a dependency being refactored away. Today an edge can only be kept or deleted, with nothing in between.
- **A group actor type.** A team or other named set of people as one owner, so a territory several people stand behind keeps exactly one owner and the no-overlap rule holds unchanged. It is how shared stakeholding gets expressed without co-ownership.
- **Composable maps.** One reviewed file is the design's central bet, but every territory edit funnels through it. Splitting a map into files that compose into one would keep the single reviewed picture without the single bottleneck.
- **Studies of neighbouring projects.** [oh-my-claudecode](ideas/oh-my-claudecode-study.md), [ECC](ideas/ecc-study.md) and [ponytail](ideas/ponytail-study.md): what each has that heai-tools can lift - reviewer and verifier contracts, a pre-edit territory gate, done criteria and evidence on a task, run receipts - and what not to take.
- **Marketing automation.** [A proposal](ideas/marketing-automation.md) for running the `growth-engine` and `content-ops` skills from [ai-marketing-skills](https://github.com/ericosiu/ai-marketing-skills) as governed work: a content repository under a map, writers and an analyst as llm-agents in `agent-host`, the content lifecycle as `flow` definitions with `by: [human]` on publish, landing and release as two separate human approvals, and `reactor` schedules closing the playbook loop.
- **A reader for every file the tools write.** [A design](ideas/reader.md) for `reader`: one read-only page and CLI over the map, the tracker, each tool's state directory and the governed checkouts as named roots of one tree, rendering each file by its format - frontmatter as a table, JSON lines as rows, logs that follow - with no state of its own and nothing it can write.
- **Warn on foreign glob syntax.** The glob dialect is deliberately small, so `[`, `{` and `!` are literal characters. They mean something in every neighbouring dialect, including gitignore and doublestar, so a validator warning would catch the habit before it becomes a silent mismatch.

## License

MIT - see [LICENSE](LICENSE).

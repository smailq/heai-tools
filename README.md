# heai-tools

Development tools for human experts and AI working together.

> **Warning:** this is alpha-quality software under heavy development. Commands, file formats and defaults change without notice.

This repository holds a set of small, independent command-line tools for running a project where humans and AI agents share the work.
Each tool does one job:

- [**`architect`**](tools/architect) defines and enforces architectural decisions.
- [**`tasks`**](tools/tasks) maintains units of work as markdown files with frontmatter.
- [**`flow`**](tools/flow) runs a multi-stage process as a state machine that refuses illegal moves and journals every move.
- [**`reactor`**](tools/reactor) reacts to events such as webhooks, file changes, git commits and more.
- [**`pod`**](tools/pod) runs agents and commands in containers with [Herdr](https://herdr.dev).
- [**`operator`**](tools/operator) displays the status and state of heai-tools in an `htop`-like text UI.

## How the tools work together

The tools share one project directory and know nothing about each other's process.
The process is yours: flow definitions say which states a piece of work passes through, scripts say what each move does by calling the tools, and reactor rules say what starts a move.

[`examples.md`](examples.md) walks through the smallest coding system that uses all of them: a human files a task, an agent does the work in a container, the architecture is enforced on the result, and a human lands it.

## Installing

Each tool is released on its own, as one GitHub release per version tagged `<tool>-v<version>`; the command a release installs is the tool's name with a `heai-` prefix, so the short names in this repository never collide with anything else on a PATH.

```sh
npm install -g @heai-tools/tasks          # heai-tasks; likewise architect, flow, pod, reactor
go install github.com/smailq/heai-tools/tools/operator/cmd/heai-operator@latest
```

The Node tools are published to npm under the `@heai-tools` scope, with the tarball also attached to the release; `operator` is attached to its release as a binary for linux and darwin, amd64 and arm64.
[`releasing.md`](releasing.md) says how a release is cut and what the workflow does.

## Design principles

These hold for every tool in [`tools/`](tools) and for every tool proposed.
A change that breaks one needs a reviewed edit to this section first.

**1. Each tool stands alone.**

**2. The command line is the primary interface.**

**3. Tools cooperate through files, not through each other.**

**4. Formats are plain, small, and universal.**

**5. Anything outside this repository is a plugin.**

## License

MIT - see [LICENSE](LICENSE).

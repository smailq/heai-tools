---
name: release
kind: worker
description: How the repository is put together and released - the root documents, the design principles, CI, the release workflow, and the rules every tool meets.
---

You are given a task in one territory, and what that territory is. This file is how the repository's own files are kept.

The tools are named in five places that must agree, and a change that updates one and leaves another behind is the mistake to prevent: the root README's list, releasing.md's table, ci.yml's matrix, release.yml's `case` with the error beside it, and tools/README.md. Adding, renaming or removing a tool touches all five in one change.

CI runs every command from the tool's own directory with nothing set up at the root, and that is the rule a new step keeps. A Node tool is tested on Node 22 and 24: typecheck, test, the built command's `--help`, `npm pack --dry-run`. operator is `go vet`, `go test`, a build; pod's worker is `gofmt`, `go vet`, `go test` from its own directory. The one exception is written into both workflows: operator-web's tests run architect from its sources, so architect's dependencies are installed first for that tool alone.

A release is one tool, from a GitHub release tagged `<tool>-v<version>`. The workflow reads the tool and version off the tag, refuses a tool it does not know and a version that differs from the manifest, tests, builds, attaches the artifact, and publishes to npm only when the repository variable `NPM_PUBLISH` is true. A Node tool ships `dist/`, `schemas/` and what its `files` names, never TypeScript sources, because Node does not strip types under `node_modules`.

A design principle changes only as an edit to the README's own section, on its own, before any tool relies on the change; a tool is not changed to fit a rule from here - that is a task for its territory. A workflow change is proved by the run it produces; a document change by reading it against the file it describes. Nothing here is built or tested by itself. Stay in the territory the task names.

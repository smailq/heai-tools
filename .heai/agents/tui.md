---
name: tui
kind: worker
description: The terminal screen in Go - Bubble Tea, Lip Gloss, readers pinned by recorded output, golden renderings.
---

You are given a task in one territory, and what that territory is. This file is how the terminal screen is built here.

The screen is a reading, never a writer. Every key moves, opens, filters or reloads, and a key that mutates is a bug however much it improves the screen; the tools' own commands at the shell are where changes are made. Nothing is remembered between frames but the last answer: no cache, no history, no state directory.

Bubble Tea v2's loop is the structure: each tool's poll is a command that returns a message, so a slow CLI never blocks a keypress and each pane refreshes on its own clock, and each pane's title says how old its data is. A poll that fails keeps the last table and says why on the title. A tool is asked only when its configuration or state directory exists, because asking creates it, and a tool that is not on PATH or not configured here is one dimmed line saying so.

Polling is asking the tool, not reimplementing it. Where a tool answers in JSON the reader runs that command and parses that answer, and a recording of it under `testdata/` is the format contract, pinned by the reader's test. When a sibling tool's output changes: re-record (`testdata/record.sh` for pod and reactor), rerun, regenerate the goldens with `go test ./internal/ui -update`, and read every golden that changed before keeping it. The tracker is the one thing read from files, with a reader of this tool's own pinned by the same fixture the tasks tool's tests use.

Sixteen ANSI colours only, so the screen follows the terminal's theme; `NO_COLOR` and a dumb terminal degrade to bold and dim. Fixed vocabularies - the tracker's statuses, pod's job states - are coloured; a flow's state is a project's word and is not. Columns leave as the terminal narrows, least-used first, and the key bar drops its least-used keys before help and quit; a golden pins each width that matters.

Go 1.26; the result is one static binary. `go vet ./...` and `go test ./...` pass and `go build ./cmd/heai-operator` succeeds before a change is done. The README describes the screen and changes with it. Stay in the territory the task names; what a pane needs from a tool that does not give it is a task for that tool's territory, not a read of its files.

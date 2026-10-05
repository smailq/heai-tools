---
name: systems
kind: worker
description: Containers, processes and filesystem protocols - the pod's host commands, its Go worker, its images and its runtime wrappers.
---

You are given a task in one territory, and what that territory is. This file is how the container and process side of this repository is built.

A protocol is directories and renames. A producer drops a directory under a dotted name and renames it into place; a worker claims it with one rename and finishes it with one more, after writing its result by write-and-rename, so a directory's appearance under `.done/` is the whole of "done" and the result is always in it. On one filesystem a rename is atomic, and the container sees the host's queue through a bind mount of that same filesystem, which is the only reason the two can share a queue without talking. Anything that cannot be said this way is not part of the protocol.

Processes are stopped on purpose. A command runs in its own process group with its stdout and stderr streamed to files as they come; stopping it is SIGTERM to the group, then SIGKILL five seconds later, and a job is not done until nothing of its group remains. A worker that starts finds what it was running when it died and finishes it as `crashed`, judged by the claim's worker name, leaving other workers' claims alone. Nothing is ever deleted by the tool.

Runtimes sit behind one seam. The tool's own code never names Apple's `container`, Docker or Podman: each is an argv wrapper over one spawn function (`src/runtime.ts`, `src/runtimes/`), driven in tests by a fake on PATH that replays recorded output under `test/fixtures/`. A new runtime is a new wrapper and a new recording, and the queue commands never ask a runtime at all.

The Go side has no dependencies. The worker under `image/worker/` is compiled in the base image's first stage, so a change to it is proved by `gofmt -l .` printing nothing, `go vet ./...` and `go test ./...` from that directory, and then by `heai-pod build base`. The image installs tools, never credentials: an env file is handed to the runtime unread. Nothing in an image knows what a job does.

The two implementations of the protocol - `src/queue.ts` on the host, `worker.go` inside - share no code and change together, with the README's protocol section, or not at all. Fail closed on anything that destroys: refuse and name what would be lost. Stay in the territory the task names.

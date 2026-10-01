# pod as a work queue

Proposed 2026-09-24, decided and implemented 2026-09-25. Replaces the Herdr-based pod: no git
integration, no Herdr, no workspaces. A pod is one container that watches a directory of job
folders, runs each one's `run.sh`, and leaves the result in `.done`. Producers
and the pod share nothing but the directory. `tools/pod/README.md` is now the specification; this
file keeps the rationale and the decisions.

## Decisions

1. Jobs move through `work_queue/<job>` → `.running/<job>` → `.done/<job>`. Two places besides the
   top, no more: the rename is the claim and the rename is the finish.
2. Every finished job lands in `.done`, failures included; `result.json` carries the status
   (`ok`, `failed`, `timeout`, `canceled`, `crashed`). One place to look.
3. The worker is a small Go program with no dependencies, compiled in the base image's first build
   stage, so the host needs no Go and the image gets no toolchain.
4. The host command keeps the file-only queue commands: `submit`, `list`, `show`, `wait`, `cancel`.
   They never ask the runtime, so a machine without one can still feed and read a queue.
5. No fact files from the worker. `result.json` is the one thing the worker writes about a job;
   anything else a job needs to say - a fact into a flow's inbox, an artifact - `run.sh` writes
   itself, into the job or into a directory `pod.yaml` mounts.
6. (2026-10-01) No `do_work.sh` in the image at all. The first cut had one in the base image and
   another in the example image, both deciding how to run a job; that was the job's decision
   twice over. Now the job carries `run.sh`, the worker runs it, and the image is only a toolbox.

## Why

- Herdr and git made pod know too much: what a repository is, what a worktree is, what an agent's
  states are. Every other tool cooperates through files; pod should too.
- A job folder is a complete, inspectable unit: the code, the instructions, the logs and the result
  travel together, and a human can `ls` the state of the world.
- Atomic renames on one filesystem give claim, done and drop semantics for free, with several
  containers able to share a queue and nothing to coordinate but names.

## What went away

- Image: herdr, `herdr.toml`, `HERDR_VERSION`, the `fact`, `settled`, `notify` helpers. Git stays,
  because jobs carry code. Entrypoint is the worker.
- Source: `herdr.ts`, `repos.ts`, `workspaces.ts`, `agents.ts`, `git.ts`, and every command they
  served: `repo *`, `open`, `close`, `diff`, `log`, `start`, `prompt`, `run`, `read`, `keys`,
  `herdr --`, `attach`, `--notify`, `--map`.
- The state directory: `repos/`, `worktrees/`, `inbox/` became `work_queue/`.

## Follow-ups

- `operator`'s pod pane was moved to the new shapes the same day: the header meter counts
  running, queued and badly finished jobs, the table lists jobs, and Enter shows a job with the
  tail of its logs read from the host.
- `examples.md`'s session example now waits on the job from the `queued` hook; a project that
  prefers events can have its `run.sh` write a fact into a mounted flow inbox.

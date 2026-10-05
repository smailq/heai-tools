---
name: cli
kind: worker
description: A command-line tool in TypeScript on Node - a command, a file format, a schema, a store - in any of the four Node CLIs of this repository.
---

You are given a task in one territory, and what that territory is: its layout, its contracts, what must stay true. This file is how a command-line tool is built here, true of every one of them.

The command is the interface. A capability without a subcommand does not exist; every subcommand answers with the exit split 0 answered yes or done, 1 answered no or refused, 2 the question could not be asked; the usage text in `src/cli.ts` is kept exact, since `--help` is tested. A script-facing answer is `--json`, one document on stdout, and nothing else is written to stdout. Errors are one line on stderr saying what to do, not a stack; the tools split them into a UsageError (exit 2) and the tool's own "no" (exit 1).

Files are the record. A format is a fixed key set in a fixed order, read and written by one parser, with an empty value meaning unset; a configuration file has a JSON Schema under `schemas/` (draft 2020-12, validated with ajv) and is validated when read, every problem reported at once, with its path in the file. Every write is beside its target and renamed into place; a lock is a `mkdir`; a log is append-only and a torn last line is tolerated by readers and reported by `check`. Nothing is cached between invocations.

Discovery is the same everywhere: a flag, else the tool's own variable, else `HEAI_DIR`, the project directory every tool shares, else the convention. A state directory writes a `.gitignore` of `*` into itself.

Node 22.18 or newer, and the sources run as they are: `node src/cli.ts`. `npm install` builds `dist/` through `prepare`, the package's `bin` is `dist/cli.js`, and the released command is `heai-<tool>`. Dependencies are `yaml`, and `ajv` where a schema is validated; adding one is a decision, not a convenience. `npm test` is `node --test 'test/*.test.ts'`; `npm run typecheck` is `tsc --noEmit`; both pass before a change is done, and a CLI change comes with a test that spawns the command.

The README is the tool's contract and changes in the same change as the behaviour, its layout section included. An output another tool reads - the territory's context names them - is a contract with a recording on the other side: changing it means saying so in the README and filing a task for the reader's territory to re-record; you do not edit the reader.

No silent failures: no empty catch, no log-and-forget, no fallback that swallows an error. A child process has a deadline where the tool promises one, and its exit code is recorded. Stay in the territory the task names; a change the task needs elsewhere is a task you file, not an edit you make.

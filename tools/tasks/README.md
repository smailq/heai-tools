# @heai-tools/tasks

A task tracker that is markdown files in the repository: one file per task, and one generated view.
It is built for an llm-agent to own and orchestrate work from, which is why the format is a fixed key set, the view is derived, and every change to a task is a commit.

```sh
npm install && npm link                                          # puts `tasks` on PATH
tasks init --dir tasks --map ../architecture.yaml
tasks new cache-the-index --title "Cache the index" --body "It is rebuilt per request."
tasks set cache-the-index --status in-progress
tasks list --status todo --json
tasks show cache-the-index
tasks build --check
```

Requires Node 22.18 or newer, which runs the TypeScript sources directly.
There is no page: the command line is the whole tool, and a page over the tasks belongs to whatever reads them next, `operator` or a project's own.
A script reads tasks through `list --json` and `show --json`, so nothing outside this tool parses the frontmatter a second time.

## The tracker lives in the repository

The tool is not the tracker.
It is pointed at a directory with `--dir`, or finds one the way every tool here finds its files, so a repository keeps its tasks wherever it wants and the tool stays independent of them.

```
tasks/
  items/<slug>.md       one file per task; the slug is its stable id
  tasks.yaml            what territory may say
  README.md             the contract, written once at init
  INDEX.md              generated: the task overview, in pick-up order
```

Tracking work in files rather than a service is what lets a task move in the same commit as the work it describes, a branch carry its own backlog, and a status change be reviewed as a diff.
That only holds if the format stays machine-clean, which is what the validator is for: exactly the declared keys, always present, in order, with an empty value meaning *unset* rather than *missing*.

A slug never changes after creation, even when the title is edited - it is the id that cross-references, branches, and commit messages point at.
`done` and `canceled` files stay in `items/`: history lives with the tasks, not in an archive.

`init` writes that directory's own `README.md` once and never rewrites it, so a repository can extend the contract with its own conventions.

## The commands

```
tasks init  [--dir tasks] [--map <path>]
tasks new <slug> --title "..." [--status todo] [--priority high]
tasks set <slug> --status in-progress [--note "..."]
tasks delete <slug>
tasks list [--json] [--status <name>] [--territory <name>]
tasks show <slug> [--json]
tasks build [--dir tasks] [--check]
```

| command | what it does |
| --- | --- |
| `init` | create the directory, its configuration, and its contract, then build the view |
| `new <slug>` | create a task, validating it before it is written |
| `set <slug>` | change its properties, or add a note to its body |
| `delete <slug>` | move its file to `deleted/` |
| `list` | every task's slug and frontmatter, in pick-up order: a table, or one JSON array with `--json` |
| `show <slug>` | one task: the file as it is, or with `--json` its frontmatter, `body`, and `run` when the body carries a run block |
| `build` | validate every task file, then regenerate `INDEX.md` |
| `build --check` | validate, and fail if the view is stale, without writing - the CI gate |

Run them as `tasks <command>`; `npm install && npm link` puts the command on PATH.

### Editing is never hand-editing

```sh
tasks new cache-the-index --title "Cache the index" --body "It is rebuilt per request."
tasks set cache-the-index --status in-progress --territory api
tasks set cache-the-index --territory api,web    # crosses a boundary
tasks set cache-the-index --status blocked --note "Blocked by [x](x.md)."
```

The frontmatter is a fixed key set in a fixed order, which a file written by hand can lose a key from, reorder, or fill with a value no vocabulary allows - and none of that surfaces until the next `build`.
So every change goes through `new` and `set`, and two things hold for each:

- **The change is validated before anything is written.** The prospective state is assembled in memory and parsed back through the same parser a file on disk goes through. An edit that would not validate leaves the tracker exactly as it was, so there is no half-applied state and nothing to roll back.
- **The view is regenerated as part of the edit.** A caller cannot forget, which is the failure `build --check` exists to catch and the one hand-editing hits most.

An empty value clears a property (`--priority=`), because empty is what *unset* looks like in the file.
A body is never rewritten, only added to with `--note`: it is the source of truth for scope, and a blocker or a cancellation reason is information the body gains rather than information that replaces it.

### Reading is `list` and `show`

```sh
tasks list                                  # a table, in pick-up order
tasks list --json --status todo --territory api
tasks show cache-the-index                  # the file, as it is
tasks show cache-the-index --json | jq -r '.run // empty'
```

`list` answers with every task's slug and frontmatter and nothing from the body, in the order `INDEX.md` uses: status section first, then priority, then slug.
`--status` keeps the tasks in one state and `--territory` the tasks whose territory list names the territory; together they intersect.
With `--json` the answer is one array of objects with the keys `slug`, `title`, `status`, `priority`, `territory`, `created_at`, `modified_at`, where `territory` is an array of names and an unset value is `""` or `[]`.

`show` prints the task file exactly as it is on disk.
With `--json` it is the same object as one `list` entry plus `body`, the markdown after the frontmatter, and `run` when the body carries a run block, absent otherwise.
Both read the whole tracker first, so an invalid file anywhere in `items/` is reported before either answers.

## The file format

```markdown
---
title: Human-readable task title
status: backlog
priority:
territory:
---

The task body: free markdown - context, motivation, proposed approach,
acceptance criteria.
```

Exactly these six frontmatter keys, always present, in this order:

| key | values | meaning |
| --- | --- | --- |
| `title` | free text | required |
| `status` | `in-progress` `in-review` `blocked` `todo` `backlog` `done` `canceled` | lifecycle state |
| `priority` | empty, `urgent` `high` `medium` `low` | empty = not yet triaged |
| `territory` | empty, or one or more declared territories, comma-separated | routes the task to each one's owner |
| `created_at` | `YYYY-MM-DD` | stamped once, at creation |
| `modified_at` | `YYYY-MM-DD` | restamped by every edit that changes something |

Both dates are the tool's to maintain, not a caller's to set: they record when the tool acted, so a settable one would be a claim rather than a fact.
An edit that changes nothing does not restamp - `modified_at` says when the task last moved, not when it was last looked at.

Lifecycle: `backlog` (triage pool) → `todo` (committed) → `in-progress` → `in-review` (submitted for review) → `done` (landed).
`blocked` names its blocker in the body; `canceled` gives a one-line reason.

### Tasks that run

A task whose body carries a fenced block whose info string is `sh run` is meant to be executed rather than prompted:

````markdown
---
title: Regenerate the ontology bindings
status: todo
priority: medium
territory: ontology
created_at: 2026-09-01
modified_at: 2026-09-01
---

The bindings under `packages/ontology/gen` are stale after the schema change.

```sh run
pnpm --filter ontology generate && git add -A && git commit -m "Regenerate ontology bindings"
```
````

The block is a body convention, not a frontmatter key, so the format is unchanged and a task that has one validates exactly as one that does not.
This tool only reports it: `show --json` carries the block's contents as `run`, and the library's `runBlockOf` is the one reader of it.
What runs it is the project's script, which reads `run` and hands it to the workspace as a command instead of a prompt; see [`docs/project.md`](../../docs/project.md), "Tasks that run".
The fence is three or more backticks or tildes and closes with the same character; a block left unclosed is not a run block, and where a body has several, the first is the one reported.
The block says what the work is, in a language a machine runs, and says nothing about where or how, which is the same rule the frontmatter keeps.

### What a task deliberately does not carry

A task says what the work is, how urgent it is, and who owns it.
It says nothing about the machinery used to do it: no branch, no PR, no commit, no build, no release, no environment, no assignee account.

Those belong to the layer that does the shipping, and they are the parts that differ per repository, per VCS, and per host.
Keeping them out is what lets the same tracker sit in front of a different toolchain unchanged, and what stops the format acquiring a key that means something only under one of them.

The link between the two runs **from the tooling to the task**, through the slug: a branch named after it, a commit or PR mentioning it, a CI job reading it.
The slug is stable and the task is findable by it, so nothing is lost by not writing the branch down - and nothing goes stale when the branch is renamed, rebased away, or never existed because the change landed some other way.

Where a specific fact is worth keeping - the PR that closed it, the reason it was canceled - it goes in the body, as prose, where it stays readable without becoming a field every other task must now carry empty.

## Validation

Validation runs on every `build`, over every file in `items/`.

A file reports every problem it has in one pass rather than failing at the first, so a malformed file is fixed once rather than three times.
Every bad file is reported too, not just the first one, so a tracker is fixed in a single pass rather than one run per problem.

A task sits in one territory as a rule, and in several when the work crosses a boundary: `territory: api, web` routes it to both owners.
The list is written sorted and unique, so two edits that mean the same set produce the same line and a diff shows a change of routing rather than of order.
`INDEX.md` carries it as one token, `t:api,web`, so an entry stays greppable.

Which values `territory` may take is the **repository's** decision, not this tool's, so the list is not hard-coded.
It defaults to open, because a tool that invented a repository's territory list would be wrong everywhere it was not configured.

## Configuration: `tasks.yaml`

```yaml
# Territories, and the actor owning each, are read from the architecture map.
map: ../architecture.yaml
```

[`schemas/tasks.schema.json`](schemas/tasks.schema.json) is the formal definition: JSON Schema, draft 2020-12, with every key and its type.
A file that does not validate is refused with every problem it has, and the tracker is not read.

Territories are deliberately not listed here twice.
A repository with an architecture map already names them, together with the actor that owns each one, so the tracker points at the map and the map stays the single source of ownership.
Every name a task's `territory` lists is then checked against it - which is what makes `territory` a routing decision rather than a label.
A configured map that cannot be read is an error, not a silent fallback: a tracker that asked to be checked must not quietly stop being checked.

`tasks.yaml` is the one part of a tracker that is about the repository rather than the tasks, and a tracker is valid whether or not it has one.

## Keeping the view honest

`INDEX.md` is derived, and is the one file here nobody edits.
When it and a task file disagree, the file wins and the view needs regenerating - so `build --check` belongs in CI beside the tests:

```sh
tasks build --dir tasks --check
```

The view sorts deterministically - status section, then priority, then slug - so regenerating with nothing changed produces no diff.

## Options

| option | default | meaning |
| --- | --- | --- |
| `--dir` | discovered | the tracker directory to read |
| `--json` | off | (`list`, `show`) answer as JSON, for scripts |
| `--status` | none | (`list`) only tasks in that state |
| `--territory` | none | (`list`) only tasks whose territory list names it |
| `--check` | off | (`build`) fail on a stale view instead of writing it |
| `--map` | none | (`init`) architecture map to validate territories against |

Without `--dir` the tracker is discovered the way every tool here discovers its files: `HEAI_TASKS`, else `tasks/` under the project directory `HEAI_DIR` names, else `.heai/tasks` if it exists, else `tasks` in the working directory.
The flag wins over the environment, and this tool's own variable over the shared one, so a shell set up for one project can still be pointed at one tracker.

### Exit codes

| code | meaning |
| --- | --- |
| `0` | done: the view was written, or it was already fresh, or the answer was printed |
| `1` | a task file is invalid, or the view is stale under `--check` |
| `2` | bad usage, or a directory or configuration that cannot be read |

Exit `2` covers anything that makes the question unanswerable rather than answered "no": an unknown command, a directory that is not a tracker, an unreadable or malformed `tasks.yaml`, a configured architecture map that cannot be read, a slug that is not one, a slug already taken, a slug `show` cannot find, a filter value no vocabulary allows, and a property the format does not have.
It is the same split `architect` makes.

## Ownership

One agent owns the tracker directory, the same cross-boundary convention as a code territory: other agents route changes through it rather than editing the files themselves.
A human editing through the CLI is not a violation of that - the convention is about which *agent* writes, and both paths validate identically.
[`agent/tasks.md`](agent/tasks.md) is that agent, ready to copy into `.claude/agents/`; set the tracker directory and the regenerate command in the two marked lines.
Other agents route status moves, new tasks, and triage through it.

## The library

`src/index.ts` exports the parser, the vocabularies, the store with its discovery, the edits, the renderer, and the readers `list` and `show` are built on: `pickUpOrder`, `taskRecord` and `runBlockOf`.
A tool in the same ecosystem can depend on the package by name rather than parse the frontmatter a second time; a tool in another ecosystem, as `operator` is, keeps its own reader pinned by [`test/model.test.ts`](test/model.test.ts)'s fixture task, or shells out to `list --json` and `show --json` and parses nothing.

## Tests

```sh
npm test        # the format, the edits, the view, the CLI
npm run typecheck
```

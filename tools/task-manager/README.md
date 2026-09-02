# @heai-tools/task-manager

A task tracker that is markdown files in the repository: one file per task, and one generated view.
It is built for an llm-agent to own and orchestrate work from, which is why the format is a fixed key set, the view is derived, and every change to a task is a commit.

```sh
npm install
npm start        # http://localhost:3838
```

Requires Node 22.18 or newer, which runs the TypeScript sources directly.

## The tracker lives in the repository

The tool is not the tracker.
It is pointed at a directory with `--dir`, so a repository keeps its tasks wherever it wants and the tool stays independent of them.

```
tasks/
  items/<slug>.md       one file per task; the slug is its stable id
  config.yaml           what territory may say
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
task-manager init  [--dir tasks] [--map <path>]
task-manager new <slug> --title "..." [--status todo] [--priority high]
task-manager set <slug> --status in-progress [--note "..."]
task-manager delete <slug>
task-manager build [--dir tasks] [--check]
task-manager serve [--dir tasks] [--port 3838]
```

| command | what it does |
| --- | --- |
| `init` | create the directory, its configuration, and its contract, then build the view |
| `new <slug>` | create a task, validating it before it is written |
| `set <slug>` | change its properties, or add a note to its body |
| `delete <slug>` | move its file to `deleted/` |
| `build` | validate every task file, then regenerate `INDEX.md` |
| `build --check` | validate, and fail if the view is stale, without writing - the CI gate |
| `serve` | the web view: read the tracker, and create and edit through it |

Run them as `node src/cli.ts <command>` from the tool directory, or install the package and use the `task-manager` bin.
`npm start` is `serve` on the default tracker directory.

### Editing is never hand-editing

```sh
node src/cli.ts new cache-the-index --title "Cache the index" --body "It is rebuilt per request."
node src/cli.ts set cache-the-index --status in-progress --territory api
node src/cli.ts set cache-the-index --territory api,web    # crosses a boundary
node src/cli.ts set cache-the-index --status blocked --note "Blocked by [x](x.md)."
```

The frontmatter is a fixed key set in a fixed order, which a file written by hand can lose a key from, reorder, or fill with a value no vocabulary allows - and none of that surfaces until the next `build`.
So every change goes through `new` and `set`, and two things hold for each:

- **The change is validated before anything is written.** The prospective state is assembled in memory and parsed back through the same parser a file on disk goes through. An edit that would not validate leaves the tracker exactly as it was, so there is no half-applied state and nothing to roll back.
- **The view is regenerated as part of the edit.** A caller cannot forget, which is the failure `build --check` exists to catch and the one hand-editing hits most.

An empty value clears a property (`--priority=`), because empty is what *unset* looks like in the file.
A body is never rewritten, only added to with `--note`: it is the source of truth for scope, and a blocker or a cancellation reason is information the body gains rather than information that replaces it.

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

### What a task deliberately does not carry

A task says what the work is, how urgent it is, and who owns it.
It says nothing about the machinery used to do it: no branch, no PR, no commit, no build, no release, no environment, no assignee account.

Those belong to the layer that does the shipping, and they are the parts that differ per repository, per VCS, and per host.
Keeping them out is what lets the same tracker sit in front of a different toolchain unchanged, and what stops the format acquiring a key that means something only under one of them.

The link between the two runs **from the tooling to the task**, through the slug: a branch named after it, a commit or PR mentioning it, a CI job reading it.
The slug is stable and the task is findable by it, so nothing is lost by not writing the branch down - and nothing goes stale when the branch is renamed, rebased away, or never existed because the change landed some other way.

Where a specific fact is worth keeping - the PR that closed it, the reason it was canceled - it goes in the body, as prose, where it stays readable without becoming a field every other task must now carry empty.

## Validation

Validation runs on every `build` and on every request the web view serves, over every file in `items/`.

A file reports every problem it has in one pass rather than failing at the first, so a malformed file is fixed once rather than three times.
Every bad file is reported too, not just the first one, so a tracker is fixed in a single pass rather than one run per problem.

A task sits in one territory as a rule, and in several when the work crosses a boundary: `territory: api, web` routes it to both owners.
The list is written sorted and unique, so two edits that mean the same set produce the same line and a diff shows a change of routing rather than of order.
`INDEX.md` carries it as one token, `t:api,web`, so an entry stays greppable.

Which values `territory` may take is the **repository's** decision, not this tool's, so the list is not hard-coded.
It defaults to open, because a tool that invented a repository's territory list would be wrong everywhere it was not configured.

## Configuration: `config.yaml`

```yaml
# Territories, and the actor owning each, are read from the architecture map.
map: ../architecture.yaml
```

Territories are deliberately not listed here twice.
A repository with an architecture map already names them, together with the actor that owns each one, so the tracker points at the map and the map stays the single source of ownership.
Every name a task's `territory` lists is then checked against it, and the web view shows the owning actor beside each - which is what makes `territory` a routing decision rather than a label.
A configured map that cannot be read is an error, not a silent fallback: a tracker that asked to be checked must not quietly stop being checked.

`config.yaml` is the one part of a tracker that is about the repository rather than the tasks, and a tracker is valid whether or not it has one.

## Keeping the view honest

`INDEX.md` is derived, and is the one file here nobody edits.
When it and a task file disagree, the file wins and the view needs regenerating - so `build --check` belongs in CI beside the tests:

```sh
node src/cli.ts build --dir tasks --check
```

The view sorts deterministically - status section, then priority, then slug - so regenerating with nothing changed produces no diff.

## The web view

| route | shows |
| --- | --- |
| `/` | the task list, in pick-up order, with the selected task beside it |
| `/task/<slug>` | that task's frontmatter, its body, and the actor owning each of its territories |
| `/new` | the capture form |
| `?t=<territory>` | the list narrowed to the tasks in one territory, or `?t=none` for the untriaged |

### What a browser may change

Deliberately little.

**Priority, status and territory are the three properties edited in place**, each as a row of pills in the frontmatter table, because triage, the board and routing are what this view is for: deciding what matters, moving work along its states and sending it to the territories it touches are the judgements made while reading the list.

**Territory is a set of toggles.**
With a map configured, every territory it declares is a pill, the ones the task sits in pressed; pressing one adds or removes it, and `none` clears the set.
Each pill posts the whole set as it would be after the click, so the control is a plain form that works without the script, and the page can never offer a name the map does not have.
Without a map the vocabulary is open, and the names are typed, comma-separated.
The capture form offers the same set as checkboxes.

**Title and slug are not editable at all**: the slug is an id, and a title that drifts from the body it heads is worse than one edited deliberately in the file.

The narrow surface is the browser's, not the format's.
`set` still changes any property; it is the place where a change arrives with its context.

Beyond that, the view can **capture** a task - the slug is derived from the title, so composing a task does not also mean composing an id - and **delete** one, which moves its file to `deleted/` rather than unlinking it.
A slug is an id that branches, commits and other tasks point at, so a deleted task stays readable at a known path, and a misclick is undone by moving one file back.
Deleting always takes two deliberate acts: the script arms the button, and without the script the server asks on its own page.

The files are read fresh on every request, so the view is never stale and the process holds no copy of the tracker to go out of date.
It can be restarted under an open page, and an invalid file shows as a problem page naming the file - fixed by fixing the file, with no restart.

Editing goes through the same functions the CLI uses, so both guarantees above hold here too: a change is validated before it is written, and the view is regenerated after it.
A closed vocabulary is rendered as a `<select>`, so the page cannot offer a value the validator would reject; an open one is a text input, because there is no list to offer.
A refused change re-renders the page with the problems listed and what was typed still in the form, and nothing on disk has moved.

Forms are plain HTML that POST and redirect, and the page is fully usable with `app.js` blocked or failing.
That file adds two things and nothing else: navigation without a reload, so moving between tasks keeps a long list where it was, and arming the delete button.

The palette, the metrics and the components are copied from the tracker this tool was built from, so the two look like the same application - a recessed page carrying white cards, semantic badge pills, and a reading type scale, because a task list is read far more often than it is edited.
The source has only a light theme, so the dark values are derived here at the same relationships and pinned by test.

The triage pool is the one status split into two groups: a backlog of any size is mostly untriaged, and the few items someone has already ranked are exactly what gets lost in it, so they surface above as `prioritized`.
Older titles fade slightly, as a hint about age rather than a second priority system.

What the page writes is a file in the repository, so a change made here is still reviewed as a diff and still lands as a commit.
That is also why writes are same-origin only, and why the default binding stays loopback: the page can now change the tracker, not just show it.

## Options

| option | environment | default | meaning |
| --- | --- | --- | --- |
| `--dir` | - | `tasks` | the tracker directory to read |
| `--check` | - | off | (`build`) fail on a stale view instead of writing it |
| `--map` | - | none | (`init`) architecture map to validate territories against |
| `--port` | `PORT` | `3838` | (`serve`) port to listen on |
| `--host` | `HOST` | `127.0.0.1` | (`serve`) address to bind |
| `--base-path` | `BASE_PATH` | none | (`serve`) URL prefix the app is mounted under, e.g. behind `tailscale serve --set-path` |

Flags win, then environment variables, then defaults.

The web view exposes every task body to whoever reaches the page, and lets them change it.
That is why the default binding is loopback: bind wider only inside a container or behind a trusted proxy.

### Exit codes

| code | meaning |
| --- | --- |
| `0` | done: the view was written, or it was already fresh |
| `1` | a task file is invalid, or the view is stale under `--check` |
| `2` | bad usage, or a directory or configuration that cannot be read |

Exit `2` covers anything that makes the question unanswerable rather than answered "no": an unknown command, a directory that is not a tracker, an unreadable or malformed `config.yaml`, a configured architecture map that cannot be read, a slug that is not one, a slug already taken, and a property the format does not have.
It is the same split `scope-gate` makes.

## Ownership

One agent owns the tracker directory, the same cross-boundary convention as a code territory: other agents route changes through it rather than editing the files themselves.
A human editing through the web view or the CLI is not a violation of that - the convention is about which *agent* writes, and both paths validate identically.
[`agent/task-manager.md`](agent/task-manager.md) is that agent, ready to copy into `.claude/agents/`; set the tracker directory and the regenerate command in the two marked lines.
Other agents route status moves, new tasks, and triage through it.

## Tests

```sh
npm test        # the format, the edits, the view, the routes, the CLI
npm run typecheck
```

`test/style.test.ts` pins the palette.

They are pinned because a palette is the kind of thing that gets tidied toward whatever a neighbouring file happens to use, and nothing fails when it does: the page still renders, in the wrong colours.
The dark theme is pinned by the relationships it has to hold rather than by its values, since a derived palette is exactly where a single wrong value hides.

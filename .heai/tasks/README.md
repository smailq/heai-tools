# Tasks

This folder is the system of record for planned work.
Everything the tracker needs lives here: one markdown file per task, and one generated view.

- `items/<slug>.md` - one file per task. The **slug is the task's stable id**; it never changes after creation, even if the title is edited.
- `INDEX.md` - the generated task overview agents read first. Never edit it by hand.
- `tasks.yaml` - what `territory` is allowed to say.

Create and change tasks with `heai-tasks new` and `heai-tasks set`, never by writing frontmatter by hand: they validate the change before writing it and regenerate the view after it.
`heai-tasks build --check` exits non-zero when the view is stale, so CI can hold the two in step.

## Task file format

```markdown
---
title: Human-readable task title
status: backlog
priority:
territory:
agent:
created_at:
modified_at:
---

The task body: free markdown - context, motivation, proposed approach, acceptance criteria.
```

Exactly these seven frontmatter keys, always present, in this order:

| key | values | meaning |
| --- | --- | --- |
| `title` | free text | required |
| `status` | `in-progress` `in-review` `blocked` `todo` `backlog` `done` `canceled` | lifecycle state (below) |
| `priority` | empty, `urgent` `high` `medium` `low` | empty = not yet triaged |
| `territory` | empty, or territories declared in [`../architecture.yaml`](../architecture.yaml), comma-separated | where the work is scoped to: the scope gate holds the change inside it; empty = not yet triaged |
| `agent` | empty, or an agent's name | who is meant to do it, a file under the project's agents directory; empty = not yet assigned |
| `created_at` | `YYYY-MM-DD` | stamped once, at creation |
| `modified_at` | `YYYY-MM-DD` | restamped by every edit that changes something |

Both dates are maintained by the tool and are never set by hand.

A task says what the work is, where it is scoped to and who is meant to do it, and nothing about the machinery used to do it - no branch, no PR, no build, no release.
Whatever layer does the shipping references the task by its slug, in a branch name, a commit message, or a PR title, so the link runs from the tooling to the task rather than the other way round and the tracker stays the same shape whatever that tooling is.

## Lifecycle

`backlog` (triage pool) → `todo` (committed, ready to pick up) → `in-progress` (someone is on it) → `in-review` (submitted for review) → `done` (landed).
Side states: `blocked` (the body must name the blocker, ideally as a link to the blocking task, `[slug](slug.md)`) and `canceled` (kept for the record; the body gains a one-line reason).

`done` and `canceled` tasks stay in `items/` - history lives here, not in a separate archive.

## Rules for agents

1. **One agent owns this folder.** Other agents route changes - status moves, new tasks, triage - through it.
2. **Pick-up protocol:** read `INDEX.md`, choose a task (finish `in-progress` first, then `todo`, then triage `backlog`), read its file fully, `heai-tasks set <slug> --status in-progress`, and commit the task-file change alongside the work.
3. **Adding a task:** `heai-tasks new <slug> --title "..." --body "..." --territory <name> --agent <name>` - kebab-case slug, unique, descriptive, and permanent. The producer of a task picks its territory and its agent: that is what scopes the work and chooses who does it.
   Deleting is `heai-tasks delete <slug>`, which moves the file to `deleted/` rather than unlinking it; `done` and `canceled` are outcomes and stay in `items/`.
4. **Cross-references between tasks** are relative markdown links: `[other-slug](other-slug.md)` from a task body, `[other-slug](items/other-slug.md)` from this file or `INDEX.md`.
5. **The files win.** Task bodies are the source of truth for scope; `INDEX.md` is a derived view, and when it disagrees it needs regenerating.

// Creating a tracker directory: the items folder, the configuration, and the
// local contract an agent reads before touching anything.
//
// `init` writes the contract once rather than regenerating it, so a repository
// can extend it with its own conventions without the tool overwriting them.
// Nothing existing is ever replaced.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CONFIG_FILE, type Config } from './config.ts'
import { ITEMS_DIR } from './store.ts'
import { PRIORITIES, TASK_STATUSES } from './model.ts'

export const README_FILE = 'README.md'

const backtickList = (values: readonly string[]): string =>
  values.map((v) => `\`${v}\``).join(' ')

function renderConfig(config: Config): string {
  const lines = [
    '# Configuration for this task tracker. The one key is optional; without it,',
    '# `territory` accepts any non-empty value.',
    ''
  ]
  lines.push(
    config.map !== undefined
      ? `# Territories are validated against this map, and each one's owner is read from it.\nmap: ${config.map}`
      : "# map: ../architecture.yaml   # validate 'territory' against an architecture map"
  )
  return `${lines.join('\n')}\n`
}

function renderReadme(config: Config): string {
  const territory =
    config.map !== undefined
      ? `empty, or territories declared in [\`${config.map}\`](${config.map}), comma-separated`
      : 'empty, or territory names, comma-separated'

  return `# Tasks

This folder is the system of record for planned work.
Everything the tracker needs lives here: one markdown file per task, and one generated view.

- \`${ITEMS_DIR}/<slug>.md\` - one file per task. The **slug is the task's stable id**; it never changes after creation, even if the title is edited.
- \`INDEX.md\` - the generated task overview agents read first. Never edit it by hand.
- \`${CONFIG_FILE}\` - what \`territory\` is allowed to say.

Create and change tasks with \`tasks new\` and \`tasks set\`, never by writing frontmatter by hand: they validate the change before writing it and regenerate the view after it.
\`tasks build --check\` exits non-zero when the view is stale, so CI can hold the two in step.

## Task file format

\`\`\`markdown
---
title: Human-readable task title
status: backlog
priority:
territory:
created_at:
modified_at:
---

The task body: free markdown - context, motivation, proposed approach, acceptance criteria.
\`\`\`

Exactly these six frontmatter keys, always present, in this order:

| key | values | meaning |
| --- | --- | --- |
| \`title\` | free text | required |
| \`status\` | ${backtickList(TASK_STATUSES)} | lifecycle state (below) |
| \`priority\` | empty, ${backtickList(PRIORITIES)} | empty = not yet triaged |
| \`territory\` | ${territory} | routes the task to each territory's owner; empty = not yet triaged |
| \`created_at\` | \`YYYY-MM-DD\` | stamped once, at creation |
| \`modified_at\` | \`YYYY-MM-DD\` | restamped by every edit that changes something |

Both dates are maintained by the tool and are never set by hand.

A task says what the work is and who owns it, and nothing about the machinery used to do it - no branch, no PR, no build, no release.
Whatever layer does the shipping references the task by its slug, in a branch name, a commit message, or a PR title, so the link runs from the tooling to the task rather than the other way round and the tracker stays the same shape whatever that tooling is.

## Lifecycle

\`backlog\` (triage pool) → \`todo\` (committed, ready to pick up) → \`in-progress\` (someone is on it) → \`in-review\` (submitted for review) → \`done\` (landed).
Side states: \`blocked\` (the body must name the blocker, ideally as a link to the blocking task, \`[slug](slug.md)\`) and \`canceled\` (kept for the record; the body gains a one-line reason).

\`done\` and \`canceled\` tasks stay in \`${ITEMS_DIR}/\` - history lives here, not in a separate archive.

## Rules for agents

1. **One agent owns this folder.** Other agents route changes - status moves, new tasks, triage - through it, the same cross-boundary convention as code territories.
2. **Pick-up protocol:** read \`INDEX.md\`, choose a task (finish \`in-progress\` first, then \`todo\`, then triage \`backlog\`), read its file fully, \`tasks set <slug> --status in-progress\`, and commit the task-file change alongside the work.
3. **Adding a task:** \`tasks new <slug> --title "..." --body "..."\` - kebab-case slug, unique, descriptive, and permanent.
   Deleting is \`tasks delete <slug>\`, which moves the file to \`deleted/\` rather than unlinking it; \`done\` and \`canceled\` are outcomes and stay in \`${ITEMS_DIR}/\`.
4. **Cross-references between tasks** are relative markdown links: \`[other-slug](other-slug.md)\` from a task body, \`[other-slug](${ITEMS_DIR}/other-slug.md)\` from this file or \`INDEX.md\`.
5. **The files win.** Task bodies are the source of truth for scope; \`INDEX.md\` is a derived view, and when it disagrees it needs regenerating.
`
}

export interface InitResult {
  dir: string
  /** Paths created, relative to the tracker directory. */
  created: string[]
  /** Paths that already existed and were left alone. */
  kept: string[]
}

/** Create a tracker directory, leaving anything that already exists untouched. */
export function init(dir: string, config: Config = {}): InitResult {
  const root = resolve(dir)
  const created: string[] = []
  const kept: string[] = []

  mkdirSync(root, { recursive: true })
  const items = join(root, ITEMS_DIR)
  if (existsSync(items)) kept.push(`${ITEMS_DIR}/`)
  else {
    mkdirSync(items, { recursive: true })
    created.push(`${ITEMS_DIR}/`)
  }

  const files: [string, string][] = [
    [CONFIG_FILE, renderConfig(config)],
    [README_FILE, renderReadme(config)]
  ]
  for (const [name, contents] of files) {
    const path = join(root, name)
    if (existsSync(path)) kept.push(name)
    else {
      writeFileSync(path, contents)
      created.push(name)
    }
  }
  return { dir: root, created, kept }
}

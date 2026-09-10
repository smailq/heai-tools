// The generated view: INDEX.md, the task overview an agent reads first.
//
// It is derived, never edited: the files under items/ are the source of truth,
// and when the view disagrees with them the view is stale. It carries a banner
// saying so, and `build --check` is the gate that proves it.

import { TASK_STATUSES, taskOrder, territoriesOf, type Task } from './model.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { INDEX_FILE, ITEMS_DIR, type Store } from './store.ts'

const BANNER = '<!-- GENERATED FILE - regenerate with `tasks build`. Do not edit by hand. -->'

const dash = (value: string): string => value || '-'
/** A territory list as one token, so an entry stays greppable as `t:api,web`. */
const territories = (value: string): string => dash(territoriesOf(value).join(','))

export function renderIndex(store: Store): string {
  const byStatus = new Map(TASK_STATUSES.map((s) => [s, [] as Task[]]))
  for (const task of store.tasks) byStatus.get(task.status)!.push(task)
  const counts = TASK_STATUSES.map((s) => `${s}: ${byStatus.get(s)!.length}`).join(' · ')

  const lines = [
    '# Task Index',
    '',
    BANNER,
    '',
    `**${store.tasks.length} tasks** - ${counts}`,
    '',
    `Each entry: \`[slug](${ITEMS_DIR}/slug.md) · p:<priority> · t:<territory> - <title>\`, where \`-\` means unset and \`t:\` lists every territory the task sits in, comma-separated.`,
    "The slug is the task's stable id; the linked file holds the full task body and is the source of truth.",
    'Sections appear in pick-up order: finish `in-progress` work first, then take from `todo` (the committed queue), then triage `backlog`. `blocked` tasks name their blocker in the body. Within a section, triaged priority sorts first (urgent → low, unset last).',
    "After changing any task's frontmatter, re-run `tasks build`. Full contract: [README.md](README.md).",
    ''
  ]

  for (const status of TASK_STATUSES) {
    const group = byStatus.get(status)!.slice().sort(taskOrder)
    lines.push(`## ${status} (${group.length})`, '')
    if (group.length === 0) {
      lines.push('(none)', '')
      continue
    }
    for (const t of group) {
      lines.push(
        `- [${t.slug}](${ITEMS_DIR}/${t.slug}.md) · p:${dash(t.priority)} · t:${territories(t.territory)} - ${t.title}`
      )
    }
    lines.push('')
  }
  return lines.join('\n')
}

export interface RenderedView {
  name: string
  path: string
  rendered: string
}

/** The generated view, as it should be on disk for this store. */
export function indexView(store: Store): RenderedView {
  return { name: INDEX_FILE, path: join(store.dir, INDEX_FILE), rendered: renderIndex(store) }
}

/**
 * Write the view. Every path that changes a file goes through here, so a
 * tracker is never left with a view describing the state before the change.
 */
export function writeIndex(store: Store): RenderedView {
  const view = indexView(store)
  writeFileSync(view.path, view.rendered)
  return view
}

// The tracker's tasks, read here again on purpose: tools do not import each
// other, so the six-key frontmatter is parsed by this tool for what it needs -
// which task a run is for, which are assignable, and who each routes to.
//
// This is a reader only. Every write to the tracker goes through the
// task-manager CLI (see requests.ts), so the tracker's own validation holds.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ArchitectureMap } from './map.ts'

export const ASSIGNABLE = ['todo', 'in-progress', 'blocked'] as const

export interface Task {
  slug: string
  title: string
  status: string
  priority: string
  territories: string[]
  body: string
}

export interface Tracker {
  /** Absolute tracker directory. */
  dir: string
  tasks: Task[]
  task(slug: string): Task | null
}

/** Split a tracker file into its frontmatter fields and body; lenient, since the tracker validates its own. */
function parseTask(slug: string, raw: string): Task | null {
  if (!raw.startsWith('---\n')) return null
  const end = raw.indexOf('\n---\n', 4)
  if (end === -1) return null
  const fields: Record<string, string> = {}
  for (const line of raw.slice(4, end).split('\n')) {
    const m = line.match(/^([a-z_]+):[ ]?(.*)$/)
    if (m) fields[m[1]!] = m[2]!.trim()
  }
  return {
    slug,
    title: fields['title'] ?? slug,
    status: fields['status'] ?? '',
    priority: fields['priority'] ?? '',
    territories: (fields['territory'] ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    body: raw.slice(end + 5).trim()
  }
}

/** Read a tracker directory. A directory that is not one reads as empty, since a host can run without a tracker. */
export function loadTracker(dir: string): Tracker {
  const root = resolve(dir)
  const items = join(root, 'items')
  const tasks: Task[] = []
  if (existsSync(items)) {
    for (const file of readdirSync(items).filter((f) => f.endsWith('.md')).sort()) {
      const task = parseTask(file.slice(0, -3), readFileSync(join(items, file), 'utf8'))
      if (task) tasks.push(task)
    }
  }
  const bySlug = new Map(tasks.map((t) => [t.slug, t]))
  return { dir: root, tasks, task: (slug) => bySlug.get(slug) ?? null }
}

/** Whether a tracker directory exists at all. */
export const isTracker = (dir: string): boolean => existsSync(join(resolve(dir), 'items'))

/** The actors a task routes to: the owner of each territory it names, deduplicated. */
export function routedTo(task: Task, map: ArchitectureMap): string[] {
  const owners = task.territories.map((t) => map.territory(t)?.owner ?? null)
  return [...new Set(owners.filter((o): o is string => o !== null))]
}

/**
 * Whether every territory a task names is owned by one actor. A task with no
 * territory is assignable to nobody in particular, so it is offered with a note
 * rather than routed.
 */
export function assignableTo(task: Task, actor: string, map: ArchitectureMap): boolean {
  if (!task.territories.length) return false
  return task.territories.every((t) => map.territory(t)?.owner === actor)
}

/** The tasks a host may assign: committed, in flight, or blocked (a resume). */
export const assignable = (tracker: Tracker): Task[] =>
  tracker.tasks.filter((t) => (ASSIGNABLE as readonly string[]).includes(t.status))

/** A slug from a title, the way the tracker's own capture form derives one. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
}

/** The first free slug in the `slug`, `slug-2`, `slug-3` series. */
export function uniqueSlug(tracker: Tracker, slug: string): string {
  const taken = new Set(tracker.tasks.map((t) => t.slug))
  if (!taken.has(slug)) return slug
  for (let n = 2; ; n++) if (!taken.has(`${slug}-${n}`)) return `${slug}-${n}`
}

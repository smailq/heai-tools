// The tracker, read from its files under the format contract the tasks tool's
// README states: one markdown file per task under items/, exactly seven
// frontmatter keys, its status and priority vocabularies, the agent's name
// format, and an optional tasks.yaml naming the architecture map.
//
// This is a reader of that format written on purpose beside the tasks tool's
// own, as heai-operator's is (root README, principles 1 and 3): the tools meet
// in the files, not in each other's code. It never writes.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parse } from 'yaml'

/** Statuses in pick-up order, exactly the tasks tool's. */
export const STATUSES = ['in-progress', 'in-review', 'blocked', 'todo', 'backlog', 'done', 'canceled']
/** Priorities most urgent first; empty is "not yet triaged". */
export const PRIORITIES = ['urgent', 'high', 'medium', 'low']
/** The exact frontmatter key set, in the order the tasks tool writes it. */
export const KEYS = ['title', 'status', 'priority', 'territory', 'agent', 'created_at', 'modified_at']
/** An agent's name: the architecture map's name format, lowercase with `.`, `_` and `-`. */
export const AGENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
/** What the tasks tab's "active" view keeps. */
export const WORKING_SET = new Set(['in-progress', 'in-review', 'blocked', 'todo'])

export interface Task {
  slug: string
  title: string
  status: string
  priority: string
  territories: string[]
  /** The agent meant to do it, a name the project resolves; "" is unassigned. This tool only shows it. */
  agent: string
  created_at: string
  modified_at: string
  body: string
  /** The first "Blocked by [slug](...)" in the body, or "". */
  blocker: string
  /** What the format contract found wrong with the file; a task with problems is still listed. */
  problems: string[]
}

export interface Tracker {
  dir: string
  /** tasks.yaml's `map`, resolved against dir, or "". */
  map: string
  configError: string
  tasks: Task[]
  /** The newest mtime under items/, in ms. */
  changed: number
}

export class NotATracker extends Error {}

export const valid = (t: Task): boolean => t.problems.length === 0

/** Reads every task file under dir/items and the optional tasks.yaml. */
export function loadTracker(dir: string): Tracker {
  const items = join(dir, 'items')
  let st
  try {
    st = statSync(items)
  } catch {
    throw new NotATracker(`${dir}: not a tracker directory (no items/)`)
  }
  if (!st.isDirectory()) throw new NotATracker(`${dir}: not a tracker directory (no items/)`)
  const t: Tracker = { dir, map: '', configError: '', tasks: [], changed: st.mtimeMs }
  readConfig(t)
  for (const name of readdirSync(items)) {
    if (!name.endsWith('.md')) continue
    const path = join(items, name)
    const info = statSync(path)
    if (!info.isFile()) continue
    t.tasks.push(parseTask(name.slice(0, -3), readFileSync(path, 'utf8')))
    t.changed = Math.max(t.changed, info.mtimeMs)
  }
  sortPickup(t.tasks)
  return t
}

function readConfig(t: Tracker): void {
  let raw: string
  try {
    raw = readFileSync(join(t.dir, 'tasks.yaml'), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') t.configError = (e as Error).message
    return
  }
  try {
    const cfg = parse(raw) as { map?: unknown } | null
    if (cfg && typeof cfg.map === 'string' && cfg.map) t.map = isAbsolute(cfg.map) ? cfg.map : join(t.dir, cfg.map)
  } catch (e) {
    t.configError = `tasks.yaml: ${(e as Error).message}`
  }
}

const BLOCKED_BY = /Blocked by \[([^\]]+)\]\(/

/** Reads one task file; every problem is reported in one pass, and an empty optional field is unset, not invalid. */
export function parseTask(slug: string, raw: string): Task {
  const t: Task = { slug, title: '', status: '', priority: '', territories: [], agent: '', created_at: '', modified_at: '', body: '', blocker: '', problems: [] }
  raw = raw.replaceAll('\r\n', '\n')
  if (!raw.startsWith('---\n')) {
    t.problems.push("missing frontmatter opening '---'")
    t.body = raw.trim()
    return t
  }
  let end = raw.indexOf('\n---\n', 4)
  let rest = ''
  if (end < 0) {
    if (raw.endsWith('\n---')) end = raw.length - 4
    else {
      t.problems.push("missing frontmatter closing '---'")
      return t
    }
  } else rest = raw.slice(end + 5)
  const fields = new Map<string, string>()
  for (const line of raw.slice(4, end).split('\n')) {
    if (line.trim() === '') continue
    const i = line.indexOf(':')
    if (i <= 0) {
      t.problems.push(`bad frontmatter line: ${JSON.stringify(line)}`)
      continue
    }
    const key = line.slice(0, i).trim()
    const val = line.slice(i + 1).trim()
    if (!KEYS.includes(key)) {
      t.problems.push(`unknown frontmatter key: ${key}`)
      continue
    }
    if (fields.has(key)) {
      t.problems.push(`duplicate frontmatter key: ${key}`)
      continue
    }
    fields.set(key, val)
  }
  for (const key of KEYS) if (!fields.has(key)) t.problems.push(`missing frontmatter key: ${key}`)
  t.title = fields.get('title') ?? ''
  t.status = fields.get('status') ?? ''
  t.priority = fields.get('priority') ?? ''
  t.agent = fields.get('agent') ?? ''
  t.created_at = fields.get('created_at') ?? ''
  t.modified_at = fields.get('modified_at') ?? ''
  const territory = fields.get('territory') ?? ''
  if (territory) {
    t.territories = [...new Set(territory.split(',').map((s) => s.trim()).filter(Boolean))].sort()
  }
  if (!t.title) t.problems.push('title must not be empty')
  if (fields.has('status') && !STATUSES.includes(t.status)) t.problems.push(`status ${JSON.stringify(t.status)} not in [${STATUSES.join(' ')}]`)
  if (t.priority && !PRIORITIES.includes(t.priority)) t.problems.push(`priority ${JSON.stringify(t.priority)} not in [${PRIORITIES.join(' ')}] (or empty)`)
  if (t.agent && !AGENT_PATTERN.test(t.agent)) t.problems.push(`agent ${JSON.stringify(t.agent)} is not a name: lowercase letters, digits, '.', '_' and '-' (or empty)`)
  t.body = rest.trim()
  if (!t.body) t.problems.push('body must not be empty')
  t.blocker = BLOCKED_BY.exec(t.body)?.[1] ?? ''
  return t
}

const rank = (list: string[], v: string): number => {
  const i = list.indexOf(v)
  return i < 0 ? list.length : i
}

/** The order INDEX.md uses: status in pick-up order, then priority with unset last, then slug. */
export function sortPickup(tasks: Task[]): void {
  tasks.sort(
    (a, b) =>
      rank(STATUSES, a.status) - rank(STATUSES, b.status) ||
      (a.priority ? rank(PRIORITIES, a.priority) : PRIORITIES.length) - (b.priority ? rank(PRIORITIES, b.priority) : PRIORITIES.length) ||
      (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)
  )
}

export const bySlug = (t: Tracker, slug: string): Task | undefined => t.tasks.find((x) => x.slug === slug)

/** Where a blocker stands: "" when none is named, "missing" when not in the tracker, else its status. */
export function blockerState(t: Tracker, task: Task): string {
  if (!task.blocker) return ''
  return bySlug(t, task.blocker)?.status ?? 'missing'
}

export function counts(t: Tracker): Record<string, number> {
  const c: Record<string, number> = {}
  for (const task of t.tasks) c[task.status] = (c[task.status] ?? 0) + 1
  return c
}

/** Whether anything shown is red: an invalid file, or a blocked task whose blocker will never clear. */
export function trackerRed(t: Tracker): boolean {
  return t.tasks.some((task) => !valid(task) || (task.status === 'blocked' && ['missing', 'canceled'].includes(blockerState(t, task))))
}

// The file format: what a task file is, and what makes one valid.
//
// A task is a markdown file whose name is its stable id. The frontmatter is a
// fixed key set - exactly these keys, always present, in this order - so the
// format stays machine-clean and an empty value means "unset" rather than
// "missing".

/**
 * Task statuses, in pick-up order: active work first, then the committed queue,
 * then the triage pool, then terminal states. `INDEX.md` sections follow this
 * order, which is what makes it readable as a work queue.
 */
export const TASK_STATUSES = [
  'in-progress',
  'in-review',
  'blocked',
  'todo',
  'backlog',
  'done',
  'canceled'
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** Priorities, most urgent first. Unset is a legitimate state: "not yet triaged". */
export const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const
export type Priority = (typeof PRIORITIES)[number]

export const TASK_KEYS = [
  'title',
  'status',
  'priority',
  'territory',
  'created_at',
  'modified_at'
] as const

export interface Task {
  /** The file name without `.md`; the task's stable id, immutable once created. */
  slug: string
  title: string
  status: TaskStatus
  /** Empty = not yet triaged. */
  priority: string
  /**
   * Empty = not yet triaged. Otherwise one or more territories from the
   * architecture map, comma-separated, sorted and unique - see `territoriesOf`.
   */
  territory: string
  /** `YYYY-MM-DD`, set once when the task is created and never rewritten. */
  created_at: string
  /** `YYYY-MM-DD`, restamped by every edit that changes something. */
  modified_at: string
  /** The markdown after the frontmatter: the source of truth for scope. */
  body: string
}

/**
 * A closed vocabulary, or `null` for an open one.
 *
 * `territory` is the one field whose values belong to the repository rather
 * than to this tool, so it is configurable and defaults to open: a tracker with
 * no configuration accepts any non-empty value rather than inventing a list.
 */
export type Vocabulary = readonly string[] | null

export interface Vocabularies {
  territories: Vocabulary
}

/** The open vocabulary set, used when a tracker declares no configuration. */
export const OPEN_VOCABULARIES: Vocabularies = { territories: null }

export type ParseResult<T> = { ok: true; value: T } | { ok: false; problems: string[] }

/** A calendar date, the only precision any date here carries. */
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Today, as `YYYY-MM-DD` in local time - the granularity the format stores. */
export function today(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * A date as "today" / "yesterday" / "N days ago", which is how a list of work
 * is actually read - what matters is whether something is fresh or has been
 * sitting, not the calendar date it carries.
 */
export function relativeDate(date: string, from: string = today()): string {
  if (!DATE_PATTERN.test(date)) return ''
  const days = Math.round((Date.parse(`${from}T00:00:00`) - Date.parse(`${date}T00:00:00`)) / 86400000)
  if (!Number.isFinite(days)) return ''
  if (days < 0) return 'in the future'
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

/**
 * The territories a task's `territory` value names, in file order.
 *
 * The field is a comma-separated list so that the frontmatter stays one line
 * per key and a file with a single territory reads exactly as it always has.
 * A task may sit in more than one territory when the work crosses a boundary;
 * each name still routes to its own owner.
 */
export function territoriesOf(value: string): string[] {
  return value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '')
}

/**
 * The canonical spelling of a territory list: unique, sorted, `', '`-joined.
 * Every write goes through this so two edits that mean the same set produce
 * the same line, and a diff shows a change of routing rather than of order.
 */
export function normalizeTerritories(value: string): string {
  return [...new Set(territoriesOf(value))].sort().join(', ')
}

/** A slug: kebab-case, with dots allowed so a version can be part of one. */
export const SLUG_PATTERN = /^[a-z0-9]+([-.][a-z0-9]+)*$/

const list = (values: readonly string[]): string => values.join(', ')

/**
 * Split a frontmatter block off a file and check it against an exact key set.
 * Every violation is collected rather than thrown at the first one, so a
 * malformed file reports everything wrong with it in a single pass.
 */
function parseFrontmatter(
  raw: string,
  keys: readonly string[],
  problems: string[]
): { fields: Record<string, string>; body: string } {
  if (!raw.startsWith('---\n')) {
    problems.push("missing frontmatter opening '---'")
    return { fields: {}, body: '' }
  }
  const end = raw.indexOf('\n---\n', 4)
  if (end === -1) {
    problems.push("missing frontmatter closing '---'")
    return { fields: {}, body: '' }
  }
  const fields: Record<string, string> = {}
  for (const line of raw.slice(4, end).split('\n')) {
    if (line.trim() === '') continue
    const m = line.match(/^([a-z_]+):[ ]?(.*)$/)
    if (!m) {
      problems.push(`bad frontmatter line: ${JSON.stringify(line)}`)
      continue
    }
    const key = m[1]!
    if (!keys.includes(key)) problems.push(`unknown frontmatter key: ${key}`)
    else if (key in fields) problems.push(`duplicate frontmatter key: ${key}`)
    else fields[key] = m[2]!.trim()
  }
  for (const key of keys) if (!(key in fields)) problems.push(`missing frontmatter key: ${key}`)
  if (!fields['title']) problems.push('title must not be empty')

  const body = raw.slice(end + 5).trim()
  if (!body) problems.push('body must not be empty')
  return { fields, body }
}

/**
 * Check the territory list: each name against the vocabulary, and the list
 * itself for the shapes that would make it ambiguous - a name given twice, or
 * an empty entry left by a stray comma. An empty value is always allowed.
 */
function checkTerritories(value: string | undefined, vocabulary: Vocabulary, problems: string[]): void {
  if (!value) return
  const names = value.split(',').map((t) => t.trim())
  if (names.some((t) => t === '')) {
    problems.push(`territory ${JSON.stringify(value)} has an empty entry; separate names with commas`)
  }
  const seen = new Set<string>()
  for (const name of names.filter((t) => t !== '')) {
    if (seen.has(name)) problems.push(`territory lists ${JSON.stringify(name)} twice`)
    seen.add(name)
    if (vocabulary === null || vocabulary.includes(name)) continue
    problems.push(
      vocabulary.length
        ? `territory ${JSON.stringify(name)} not in [${list(vocabulary)}] (or empty)`
        : `territory ${JSON.stringify(name)} is set, but no territory is declared`
    )
  }
}

/** Parse a task file. `slug` is the file name without its extension. */
export function parseTask(
  slug: string,
  raw: string,
  vocabularies: Vocabularies = OPEN_VOCABULARIES
): ParseResult<Task> {
  const problems: string[] = []
  const { fields, body } = parseFrontmatter(raw, TASK_KEYS, problems)

  const status = fields['status']
  if (status !== undefined && !TASK_STATUSES.includes(status as TaskStatus)) {
    problems.push(`status ${JSON.stringify(status)} not in [${list(TASK_STATUSES)}]`)
  }
  const priority = fields['priority']
  if (priority && !PRIORITIES.includes(priority as Priority)) {
    problems.push(`priority ${JSON.stringify(priority)} not in [${list(PRIORITIES)}] (or empty)`)
  }
  checkTerritories(fields['territory'], vocabularies.territories, problems)
  for (const key of ['created_at', 'modified_at'] as const) {
    const value = fields[key]
    if (value && !DATE_PATTERN.test(value)) {
      problems.push(`${key} ${JSON.stringify(value)} must be YYYY-MM-DD (or empty)`)
    }
  }

  if (problems.length) return { ok: false, problems }
  return {
    ok: true,
    value: {
      slug,
      title: fields['title']!,
      status: status as TaskStatus,
      priority: priority ?? '',
      territory: normalizeTerritories(fields['territory'] ?? ''),
      created_at: fields['created_at'] ?? '',
      modified_at: fields['modified_at'] ?? '',
      body
    }
  }
}

/**
 * Sort order inside a status section: triaged priority first (urgent → low,
 * unset last), then slug, so the order is stable across regenerations.
 */
export function taskOrder(a: Task, b: Task): number {
  const rank = (t: Task) =>
    t.priority ? PRIORITIES.indexOf(t.priority as Priority) : PRIORITIES.length
  return rank(a) - rank(b) || a.slug.localeCompare(b.slug)
}

/** Render a task back to its file form. Used by `init` for the starter files. */
export function serializeTask(task: Omit<Task, 'slug'>): string {
  return [
    '---',
    `title: ${task.title}`,
    `status: ${task.status}`,
    `priority: ${task.priority}`.trimEnd(),
    `territory: ${task.territory}`.trimEnd(),
    `created_at: ${task.created_at}`.trimEnd(),
    `modified_at: ${task.modified_at}`.trimEnd(),
    '---',
    '',
    task.body,
    ''
  ].join('\n')
}


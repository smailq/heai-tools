// Creating a task, and changing one's properties.
//
// Every edit goes through here rather than through a hand-written file, and
// that is the point: the frontmatter is a fixed key set in a fixed order, so a
// file assembled by hand is a file that can lose a key, reorder one, or carry a
// value no vocabulary allows - and none of that surfaces until the next build.
//
// Two properties hold for every function here:
//
//   1. The change is validated BEFORE anything is written. The prospective
//      state is assembled in memory and parsed back through the same parser a
//      file on disk goes through. An edit that would not validate leaves the
//      tracker exactly as it was, so there is no half-applied state and nothing
//      to roll back.
//   2. The generated view is rewritten as part of the edit. A caller cannot
//      forget, which is the failure the `--check` gate exists to catch and the
//      one an agent editing files by hand hits most.

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { UsageError } from './config.ts'
import { parseTask, today, serializeTask, SLUG_PATTERN, type Task } from './model.ts'
import { ITEMS_DIR, load, ValidationError, type Store } from './store.ts'
import { writeIndex } from './render.ts'

/** The task properties an edit may set. Every key optional; `''` clears one. */
export type TaskFields = Partial<Pick<Task, 'title' | 'status' | 'priority' | 'territory'>>

/**
 * The task properties a caller may set. `created_at` and `modified_at` are
 * deliberately not among them: they record when the tool acted, so letting a
 * caller write them would make them a claim rather than a fact.
 */
export const SETTABLE_TASK_KEYS = ['title', 'status', 'priority', 'territory'] as const

export interface EditResult {
  /** The file written, relative to the tracker directory. */
  file: string
  /** The tracker as it now stands, with the change applied. */
  store: Store
  /** Which properties actually changed, for reporting. */
  changed: string[]
}

const EMPTY_TASK: Omit<Task, 'slug' | 'body'> = {
  title: '',
  status: 'backlog',
  priority: '',
  territory: '',
  created_at: '',
  modified_at: ''
}

function checkSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new UsageError(
      `${JSON.stringify(slug)} is not a slug: kebab-case, dots allowed for versions`
    )
  }
}

/** Reject a field name the format does not have, before it reaches a file. */
function checkFields(fields: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Object.keys(fields)) {
    if (!keys.includes(key)) {
      throw new UsageError(`${JSON.stringify(key)} is not a property; there is: ${keys.join(', ')}`)
    }
  }
}

/** Which of `fields` actually differ from what is there now. */
function diff(before: Task, fields: object): string[] {
  const current = before as unknown as Record<string, string>
  return Object.entries(fields)
    .filter(([key, value]) => value !== undefined && value !== current[key])
    .map(([key]) => key)
}

/** Drop the keys a caller left undefined, so they do not overwrite with `undefined`. */
function given<T extends object>(fields: T): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined)
  ) as Record<string, string>
}

/**
 * Write a validated state, and regenerate the view from it.
 *
 * The record reaching here has been serialized and parsed back rather than
 * validated as an object: that is the same path a file on disk takes, so an
 * edit cannot pass a check the file it produces would fail.
 */
function commit(store: Store, file: string, contents: string, tasks: Task[], changed: string[]): EditResult {
  writeFileSync(join(store.dir, file), contents)
  const next: Store = { ...store, tasks }
  writeIndex(next)
  return { file, store: next, changed }
}

const bySlug = (tasks: Task[], replacement: Task): Task[] =>
  tasks.map((task) => (task.slug === replacement.slug ? replacement : task))

const sorted = (tasks: Task[]): Task[] =>
  tasks.slice().sort((a, b) => a.slug.localeCompare(b.slug))

export function createTask(
  dir: string,
  slug: string,
  fields: TaskFields,
  body: string
): EditResult {
  checkSlug(slug)
  checkFields(fields, SETTABLE_TASK_KEYS)
  const store = load(dir)
  const file = `${ITEMS_DIR}/${slug}.md`
  if (existsSync(join(store.dir, file))) {
    throw new UsageError(`${file} already exists; a slug is an id and is never reused`)
  }

  const stamp = today()
  const contents = serializeTask({
    ...EMPTY_TASK,
    ...given(fields),
    created_at: stamp,
    modified_at: stamp,
    body: body.trim()
  })
  const parsed = parseTask(slug, contents, store.vocabularies)
  if (!parsed.ok) throw new ValidationError([`${file}:\n  - ${parsed.problems.join('\n  - ')}`])

  return commit(
    store,
    file,
    contents,
    sorted([...store.tasks, parsed.value]),
    Object.keys(given(fields))
  )
}

/**
 * A body is only ever added to, never rewritten: it is the source of truth for
 * scope, and a blocker, a decision or a cancellation reason is information the
 * body gains rather than information that replaces it.
 */
function appendNote(body: string, note: string | undefined): string {
  return note ? `${body.trim()}\n\n${note.trim()}` : body
}

export function updateTask(
  dir: string,
  slug: string,
  fields: TaskFields,
  note?: string
): EditResult {
  checkFields(fields, SETTABLE_TASK_KEYS)
  const store = load(dir)
  const file = `${ITEMS_DIR}/${slug}.md`
  const current = store.tasks.find((t) => t.slug === slug)
  if (!current) throw new UsageError(`no task ${JSON.stringify(slug)} in ${ITEMS_DIR}/`)

  const changed = diff(current, fields)
  // An edit that changes nothing does not restamp: modified_at records when the
  // task last actually moved, not when it was last looked at.
  const touched = changed.length > 0 || note !== undefined
  const contents = serializeTask({
    ...current,
    ...given(fields),
    created_at: current.created_at || today(),
    modified_at: touched ? today() : current.modified_at,
    body: appendNote(current.body, note)
  })
  const parsed = parseTask(slug, contents, store.vocabularies)
  if (!parsed.ok) throw new ValidationError([`${file}:\n  - ${parsed.problems.join('\n  - ')}`])

  return commit(store, file, contents, bySlug(store.tasks, parsed.value), changed)
}

export const DELETED_DIR = 'deleted'

/**
 * Delete a task by moving its file to `deleted/`.
 *
 * Nothing is unlinked. A slug is an id that branches, commits and other tasks
 * point at, so a deleted task stays readable at a known path rather than
 * becoming a dangling reference - and a deletion made by a misclick is undone
 * by moving one file back.
 *
 * `done` and `canceled` are not this: those are outcomes, and they stay in
 * `items/` as history. This is for a task that should never have been filed.
 */
export function deleteTask(dir: string, slug: string): EditResult {
  const store = load(dir)
  const file = `${ITEMS_DIR}/${slug}.md`
  const current = store.tasks.find((t) => t.slug === slug)
  if (!current) throw new UsageError(`no task ${JSON.stringify(slug)} in ${ITEMS_DIR}/`)

  const tasks = store.tasks.filter((t) => t.slug !== slug)

  const from = join(store.dir, file)
  const to = join(store.dir, DELETED_DIR, `${slug}.md`)
  mkdirSync(dirname(to), { recursive: true })
  if (existsSync(to)) {
    throw new UsageError(`${DELETED_DIR}/${slug}.md already exists; move it aside first`)
  }
  renameSync(from, to)

  const next: Store = { ...store, tasks }
  writeIndex(next)
  return { file: `${DELETED_DIR}/${slug}.md`, store: next, changed: ['deleted'] }
}

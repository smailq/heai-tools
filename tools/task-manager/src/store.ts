// Reading a tracker directory: every task file, and what makes the set of them
// hold together.
//
// The files are the source of truth. Nothing here caches: a caller reads the
// directory whenever it needs the current state, which is what lets the web
// view be correct without being told about a change.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadVocabularies, UsageError, type Config, type VocabularySet } from './config.ts'
import { parseTask, SLUG_PATTERN, type Task } from './model.ts'

export const ITEMS_DIR = 'items'
export const INDEX_FILE = 'INDEX.md'

/** One or more task files that do not hold. Carries every problem found. */
export class ValidationError extends Error {
  readonly problems: string[]

  constructor(problems: string[]) {
    super(`Invalid task files:\n${problems.join('\n')}`)
    this.name = 'ValidationError'
    this.problems = problems
  }
}

export interface Store {
  /** The tracker directory these came from, absolute. */
  dir: string
  tasks: Task[]
  vocabularies: VocabularySet
}

/**
 * Read a tracker directory.
 *
 * Throws `UsageError` when the directory or the configuration cannot be read,
 * and `ValidationError` when the files themselves do not hold - the same split
 * the CLI's exit codes make: a question that cannot be asked, versus one
 * answered "no".
 */
export function load(dir: string, config?: Config): Store {
  const root = resolve(dir)
  const items = join(root, ITEMS_DIR)
  if (!existsSync(items)) {
    throw new UsageError(`not a tracker directory: ${root} has no ${ITEMS_DIR}/`)
  }
  const vocabularies = loadVocabularies(root, config ?? undefined)

  // Every bad file is reported, not just the first: a caller fixing a tracker
  // wants the whole list, not one problem per run.
  const problems: string[] = []
  const tasks: Task[] = []
  for (const file of readdirSync(items)
    .filter((f) => f.endsWith('.md'))
    .sort()) {
    const slug = file.slice(0, -'.md'.length)
    if (!SLUG_PATTERN.test(slug)) {
      problems.push(
        `${ITEMS_DIR}/${file}: file name must be a kebab-case slug (dots allowed for versions)`
      )
      continue
    }
    const result = parseTask(slug, readFileSync(join(items, file), 'utf8'), vocabularies)
    if (result.ok) tasks.push(result.value)
    else problems.push(`${ITEMS_DIR}/${file}:\n  - ${result.problems.join('\n  - ')}`)
  }

  if (problems.length) throw new ValidationError(problems)
  return { dir: root, tasks, vocabularies }
}

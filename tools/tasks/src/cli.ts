#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadVocabularies, UsageError, type Config } from './config.ts'
import { discoverDir, load, INDEX_FILE, ITEMS_DIR, ValidationError } from './store.ts'
import { indexView } from './render.ts'
import { init } from './init.ts'
import { createTask, deleteTask, updateTask, type EditResult } from './edit.ts'
import {
  pickUpOrder,
  runBlockOf,
  TASK_STATUSES,
  taskRecord,
  territoriesOf,
  type Task,
  type TaskStatus
} from './model.ts'

const USAGE = `tasks - a file-based task tracker kept in markdown

  tasks init [--dir tasks] [--map <path>]
  tasks new <slug> --title "..." [--status todo] [--priority high]
  tasks set <slug> --status in-progress [--note "..."]
  tasks list [--json] [--status <name>] [--territory <name>]
  tasks show <slug> [--json]
  tasks build [--dir tasks] [--check]

Commands:
  init                 create a tracker directory: items/, tasks.yaml, README.md
  new <slug>           create a task; --title is required
  set <slug>           change a task's properties
  delete <slug>        move a task's file to deleted/ (never an unlink)
  list                 every task's slug and frontmatter, in pick-up order
  show <slug>          one task: the file as it is, or its fields, body and run block
  build                validate every file, then regenerate INDEX.md

Properties (new, set) - an empty value clears one, e.g. --priority=
  --title <text>       the human-readable title
  --status <name>      lifecycle state
  --priority <name>    urgent, high, medium, low
  --territory <names>  the territory it routes to; several, comma-separated, when
                       the work crosses a boundary
  --body <text>        (new) the body; reads stdin when given as - or omitted
  --note <text>        (set) a line appended to the body; bodies are never rewritten

Filters (list):
  --status <name>      only tasks in that state
  --territory <name>   only tasks whose territory list names it

Options:
  --dir <path>         the tracker directory; default HEAI_TASKS, else
                       $HEAI_DIR/tasks, else .heai/tasks if it exists, else tasks
  --json               (list, show) answer as JSON, for scripts
  --check              (build) fail if the view is stale, instead of writing it
  --map <path>         (init) architecture map to validate territories against,
                       written into tasks.yaml relative to the tracker directory
  --help

Every new and set validates the change before writing it and regenerates the
view after, so a tracker is never left half-edited or with a stale view.

Exit codes: 0 done, 1 invalid files or a stale view, 2 bad usage.`

const COMMANDS = ['init', 'new', 'set', 'delete', 'list', 'show', 'build'] as const
type Command = (typeof COMMANDS)[number]

const dash = (value: string): string => value || '-'

/** A plain table: one task per line, columns padded to their widest value. */
function table(tasks: Task[]): string {
  const rows = tasks.map((t) => [
    t.slug,
    t.status,
    dash(t.priority),
    dash(territoriesOf(t.territory).join(',')),
    dash(t.modified_at),
    t.title
  ])
  const header = ['slug', 'status', 'priority', 'territory', 'modified', 'title']
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join('  ').trimEnd()
  return [line(header), ...rows.map(line)].join('\n')
}

/** Refuse a property flag on a read-only command, where it can only be a filter that does not exist. */
function refuseProperties(command: string, values: Record<string, string | undefined>, allowed: string[]): void {
  for (const flag of ['title', 'status', 'priority', 'territory', 'body', 'note']) {
    if (values[flag] !== undefined && !allowed.includes(flag)) {
      throw new UsageError(
        allowed.length
          ? `${command} takes --${allowed.join(' and --')} as filters, not --${flag}`
          : `${command} takes no --${flag}`
      )
    }
  }
}

function listCommand(dir: string, values: Record<string, string | undefined>, json: boolean): number {
  refuseProperties('list', values, ['status', 'territory'])
  const status = values['status']
  if (status !== undefined && !TASK_STATUSES.includes(status as TaskStatus)) {
    throw new UsageError(`status ${JSON.stringify(status)} not in [${TASK_STATUSES.join(', ')}]`)
  }
  const territory = values['territory']
  if (territory !== undefined && !territory.trim()) {
    throw new UsageError('--territory needs a territory name to filter by')
  }

  const tasks = load(dir)
    .tasks.filter((t) => status === undefined || t.status === status)
    .filter((t) => territory === undefined || territoriesOf(t.territory).includes(territory.trim()))
    .sort(pickUpOrder)

  console.log(json ? JSON.stringify(tasks.map(taskRecord), null, 2) : table(tasks))
  return 0
}

function showCommand(dir: string, slug: string, values: Record<string, string | undefined>, json: boolean): number {
  refuseProperties('show', values, [])
  const store = load(dir)
  const task = store.tasks.find((t) => t.slug === slug)
  if (!task) throw new UsageError(`no task ${JSON.stringify(slug)} in ${store.dir}`)

  if (!json) {
    process.stdout.write(readFileSync(join(store.dir, ITEMS_DIR, `${slug}.md`), 'utf8'))
    return 0
  }
  // `run` is present only when the body carries the block: its absence is the
  // answer "prompt this one", and a script reads it as `.run // empty`.
  const run = runBlockOf(task.body)
  const record = { ...taskRecord(task), body: task.body, ...(run === null ? {} : { run }) }
  console.log(JSON.stringify(record, null, 2))
  return 0
}

function build(dir: string, check: boolean): number {
  const store = load(dir)
  const counts = `${store.tasks.length} task${store.tasks.length === 1 ? '' : 's'}`
  const view = indexView(store)

  if (check) {
    const current = existsSync(view.path) ? readFileSync(view.path, 'utf8') : ''
    if (current !== view.rendered) {
      console.error(`${view.name} is stale - run \`tasks build\``)
      return 1
    }
    console.log(`${INDEX_FILE} is fresh (${counts})`)
    return 0
  }

  writeFileSync(view.path, view.rendered)
  console.log(`Wrote ${INDEX_FILE} (${counts})`)
  return 0
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (data += chunk))
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

/** The property flags a caller actually gave, undefined meaning "leave alone". */
function properties(values: Record<string, string | undefined>): Record<string, string> {
  const fields = {
    title: values['title'],
    status: values['status'],
    priority: values['priority'],
    territory: values['territory']
  }
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined)
  ) as Record<string, string>
}

const report = (verb: string, result: EditResult): number => {
  const what = result.changed.length ? `: ${result.changed.join(', ')}` : ' (nothing changed)'
  console.log(`${verb} ${result.file}${what}`)
  console.log(`Wrote ${INDEX_FILE}`)
  return 0
}

function deleteCommand(dir: string, slug: string): number {
  const result = deleteTask(dir, slug)
  console.log(`Moved items/${slug}.md to ${result.file}`)
  console.log(`Wrote ${INDEX_FILE}`)
  return 0
}

async function newCommand(
  dir: string,
  slug: string,
  values: Record<string, string | undefined>
): Promise<number> {
  const fields = properties(values)
  if (!fields['title']) throw new UsageError('--title is required to create a task')

  // A body is required by the format, so it is required here. Taking it from
  // stdin is what makes a multi-paragraph body writable from a shell at all.
  let body = values['body'] ?? ''
  if (!body || body === '-') {
    if (process.stdin.isTTY) {
      throw new UsageError('give the body with --body, or pipe it in on stdin')
    }
    body = await readStdin()
  }
  if (!body.trim()) throw new UsageError('the body must not be empty')

  return report('Created', createTask(dir, slug, fields, body))
}

function setCommand(
  dir: string,
  slug: string,
  values: Record<string, string | undefined>
): number {
  const fields = properties(values)
  const note = values['note']
  // The specific complaint first: --body here is a caller reaching for the
  // wrong flag, and "nothing to set" would send them looking in the wrong place.
  if (values['body'] !== undefined) {
    throw new UsageError('a body is never rewritten; add to it with --note')
  }
  if (!Object.keys(fields).length && note === undefined) {
    throw new UsageError('name at least one property to set, or --note to add to the body')
  }

  return report('Updated', updateTask(dir, slug, fields, note))
}

function initCommand(dir: string, options: Record<string, string | undefined>): number {
  const config: Config = {}
  if (options['map'] !== undefined) config.map = options['map']

  // Check the configuration before writing anything: a tracker pointed at a map
  // that cannot be read would fail on its first build, having already scaffolded.
  loadVocabularies(dir, config)

  const result = init(dir, config)
  if (result.created.length) console.log(`Created in ${result.dir}: ${result.created.join(', ')}`)
  if (result.kept.length) console.log(`Already there, left alone: ${result.kept.join(', ')}`)
  return build(dir, false)
}

async function main(): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        dir: { type: 'string' },
        check: { type: 'boolean' },
        map: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string' },
        priority: { type: 'string' },
        territory: { type: 'string' },
        body: { type: 'string' },
        note: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean' }
      }
    })
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USAGE}`)
    return 2
  }

  const { values, positionals } = parsed
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  if (positionals.length === 0) {
    console.error(`name a command\n\n${USAGE}`)
    return 2
  }
  const command = positionals[0] as Command
  if (!COMMANDS.includes(command)) {
    console.error(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`)
    return 2
  }

  // `new`, `set`, `delete` and `show` name a task by its slug; every other
  // command takes no subject at all.
  const takesSubject =
    command === 'new' || command === 'set' || command === 'delete' || command === 'show'
  const expected = takesSubject ? 2 : 1
  if (positionals.length > expected) {
    console.error(`unexpected argument ${JSON.stringify(positionals[expected])}\n\n${USAGE}`)
    return 2
  }
  if (takesSubject && positionals.length < 2) {
    console.error(`${command} needs a task slug, e.g. \`${command} my-slug\`\n\n${USAGE}`)
    return 2
  }

  const dir = discoverDir(values.dir)
  const options = values as Record<string, string | undefined>
  const json = values.json === true
  try {
    if (command === 'init') return initCommand(dir, options)
    if (command === 'new') return await newCommand(dir, positionals[1]!, options)
    if (command === 'set') return setCommand(dir, positionals[1]!, options)
    if (command === 'delete') return deleteCommand(dir, positionals[1]!)
    if (command === 'list') return listCommand(dir, options, json)
    if (command === 'show') return showCommand(dir, positionals[1]!, options, json)
    return build(dir, values.check === true)
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(e.message)
      return 1
    }
    if (e instanceof UsageError) {
      console.error(e.message)
      return 2
    }
    throw e
  }
}

// Set the exit code rather than calling process.exit, so a pending stdout write
// is not dropped; every command has finished by the time this runs.
main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((e) => {
    process.stderr.write(`${(e as Error).stack ?? String(e)}\n`)
    process.exitCode = 2
  })

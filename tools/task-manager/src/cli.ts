#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { loadVocabularies, UsageError, type Config } from './config.ts'
import { load, INDEX_FILE, ValidationError } from './store.ts'
import { indexView } from './render.ts'
import { init } from './init.ts'
import { createTask, deleteTask, updateTask, type EditResult } from './edit.ts'
import { createTaskServer, normalizeBasePath } from './server.ts'

const USAGE = `task-manager - a file-based task tracker kept in markdown

  task-manager init [--dir tasks] [--map <path>]
  task-manager new <slug> --title "..." [--status todo] [--priority high]
  task-manager set <slug> --status in-progress [--note "..."]
  task-manager build [--dir tasks] [--check]
  task-manager serve [--dir tasks] [--port 3838]

Commands:
  init                 create a tracker directory: items/, config.yaml, README.md
  new <slug>           create a task; --title is required
  set <slug>           change a task's properties
  delete <slug>        move a task's file to deleted/ (never an unlink)
  build                validate every file, then regenerate INDEX.md
  serve                a web view, reading the files fresh on every request

Properties (new, set) - an empty value clears one, e.g. --priority=
  --title <text>       the human-readable title
  --status <name>      lifecycle state
  --priority <name>    urgent, high, medium, low
  --territory <name>   the territory that owns it
  --body <text>        (new) the body; reads stdin when given as - or omitted
  --note <text>        (set) a line appended to the body; bodies are never rewritten

Options:
  --dir <path>         the tracker directory (default: tasks)
  --check              (build) fail if the view is stale, instead of writing it
  --map <path>         (init) architecture map to validate territories against,
                       written into config.yaml relative to the tracker directory
  --port <n>           (serve) port to listen on (default: 3838, or PORT)
  --host <addr>        (serve) address to bind (default: 127.0.0.1, or HOST)
  --base-path <prefix> (serve) URL prefix behind a reverse proxy (or BASE_PATH)
  --help

Every new and set validates the change before writing it and regenerates the
view after, so a tracker is never left half-edited or with a stale view.

Exit codes: 0 done, 1 invalid files or a stale view, 2 bad usage.`

const DEFAULT_PORT = 3838

const COMMANDS = ['init', 'new', 'set', 'delete', 'build', 'serve'] as const
type Command = (typeof COMMANDS)[number]

function build(dir: string, check: boolean): number {
  const store = load(dir)
  const counts = `${store.tasks.length} task${store.tasks.length === 1 ? '' : 's'}`
  const view = indexView(store)

  if (check) {
    const current = existsSync(view.path) ? readFileSync(view.path, 'utf8') : ''
    if (current !== view.rendered) {
      console.error(`${view.name} is stale - run \`task-manager build\``)
      return 1
    }
    console.log(`${INDEX_FILE} is fresh (${counts})`)
    return 0
  }

  writeFileSync(view.path, view.rendered)
  console.log(`Wrote ${INDEX_FILE} (${counts})`)
  return 0
}

async function serve(dir: string, options: Record<string, string | undefined>): Promise<number> {
  // Fail fast on a tracker that cannot be read, rather than serving an error page.
  const store = load(dir)

  // Flags win, then environment variables, then defaults - the precedence every
  // tool here uses.
  const rawPort = options['port'] ?? process.env['PORT']
  const port = Number(rawPort ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`--port must be a port number, got ${JSON.stringify(rawPort)}`)
  }
  const host = options['host'] ?? process.env['HOST'] ?? '127.0.0.1'
  const basePath = normalizeBasePath(options['base-path'] ?? process.env['BASE_PATH'])

  const server = createTaskServer({ dir, basePath, title: basename(store.dir) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const bound = server.address()
  const shown = typeof bound === 'object' && bound ? bound.port : port

  console.log(`task-manager: http://${host === '0.0.0.0' ? 'localhost' : host}:${shown}${basePath}/`)
  if (basePath) console.log(`task-manager: also serving under base path ${basePath}/`)
  console.log(`task-manager: tracker ${store.dir}`)
  console.log('task-manager: edits here are validated and regenerate the views, like the CLI')
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(
      'task-manager: WARNING - listening beyond loopback, and whoever reaches the ' +
        'page can read every task body and change the tracker'
    )
  }
  // Held open by the listening server.
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
        port: { type: 'string' },
        host: { type: 'string' },
        'base-path': { type: 'string' },
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

  // `new`, `set` and `delete` name a task by its slug; every other command
  // takes no subject at all.
  const takesSubject = command === 'new' || command === 'set' || command === 'delete'
  const expected = takesSubject ? 2 : 1
  if (positionals.length > expected) {
    console.error(`unexpected argument ${JSON.stringify(positionals[expected])}\n\n${USAGE}`)
    return 2
  }
  if (takesSubject && positionals.length < 2) {
    console.error(`${command} needs a task slug, e.g. \`${command} my-slug\`\n\n${USAGE}`)
    return 2
  }

  const dir = values.dir ?? 'tasks'
  const options = values as Record<string, string | undefined>
  try {
    if (command === 'init') return initCommand(dir, options)
    if (command === 'new') return await newCommand(dir, positionals[1]!, options)
    if (command === 'set') return setCommand(dir, positionals[1]!, options)
    if (command === 'delete') return deleteCommand(dir, positionals[1]!)
    if (command === 'build') return build(dir, values.check === true)
    return await serve(dir, options)
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
// is not dropped. `serve` sets 0 and returns while its listening server holds
// the loop open; every other command has finished by the time this runs.
main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((e) => {
    process.stderr.write(`${(e as Error).stack ?? String(e)}\n`)
    process.exitCode = 2
  })

// Actions: on every journal line that enters a state, the one script the
// pinned definition names for that state, started detached in the project
// directory and forgotten. flow records what it started; the script writes
// its own exit code when it ends (principle 6). Nothing here waits, orders,
// retries or times anything, and nothing here runs under a lock.

import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Definition } from './definition.ts'
import { writeAtomic, type Line } from './journal.ts'

export const ACTIONS = 'actions'

/** A journal line that entered a state, with what its action needs; captured under the flow's lock, acted on after it. */
export interface Entered {
  id: string
  dir: string
  definition: Definition
  line: Line
  links: Record<string, string>
}

/** The start line enters the initial state; a transition enters `to` when it differs from `from`; a link enters nothing. */
export const entersState = (line: Line): boolean => line.event === 'start' || (line.event !== 'link' && line.to !== line.from)

/** `actions/<seq>-<state>.json`: `pid` is the process id, or null when the shell could not start. */
export interface ActionRecord {
  seq: number
  state: string
  run: string
  startedAt: string
  pid: number | null
}

export interface Action extends ActionRecord {
  /** The exit code once the script ended; null while it runs. */
  exit: number | null
}

/** The command runs in its own shell, so an `exit` inside it or a syntax error still leaves a code; the code lands beside the log by rename. */
const WRAPPER = '/bin/sh -c "$1"; e=$?; echo "$e" > "$2.tmp" && mv -f "$2.tmp" "$2"'

/** `task` is `HEAI_LINK_TASK`; `waits-on` would be `HEAI_LINK_WAITS_ON`. */
export const envName = (link: string): string => `HEAI_LINK_${link.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`

/** What a script gets on top of the process's environment; no paths, since it runs in the project directory. */
export function environment(e: Entered, lineFile: string): Record<string, string> {
  const env: Record<string, string> = {
    HEAI_FLOW: e.id,
    HEAI_DEFINITION: e.definition.name,
    HEAI_STATE: e.line.to,
    HEAI_EVENT: e.line.event,
    HEAI_SEQ: String(e.line.seq),
    HEAI_LINE: lineFile
  }
  for (const [name, value] of Object.entries(e.links)) env[envName(name)] = value
  return env
}

export interface RunOptions {
  /** The project directory: the script's working directory. */
  project: string
  now: Date
}

/** Start the action for a line that entered a state. Null when the state names no hook. */
export function runAction(e: Entered, opts: RunOptions): ActionRecord | null {
  const hook = e.definition.hooks[e.line.to]
  if (!hook) return null
  const dir = join(e.dir, ACTIONS)
  mkdirSync(dir, { recursive: true })
  const stem = join(dir, `${e.line.seq}-${e.line.to}`)
  const lineFile = `${stem}.line.json`
  writeAtomic(lineFile, JSON.stringify(e.line) + '\n')
  const log = openSync(`${stem}.log`, 'a')
  const child = spawn('/bin/sh', ['-c', WRAPPER, 'flow-action', hook.run, `${stem}.exit`], {
    cwd: opts.project,
    env: { ...process.env, ...environment(e, lineFile) },
    detached: true,
    stdio: ['ignore', log, log]
  })
  closeSync(log)
  child.on('error', (err) => {
    appendFileSync(`${stem}.log`, `flow: could not start /bin/sh in ${opts.project}: ${err.message}\n`)
    writeAtomic(`${stem}.exit`, '127\n')
  })
  child.unref()
  const record: ActionRecord = { seq: e.line.seq, state: e.line.to, run: hook.run, startedAt: opts.now.toISOString(), pid: child.pid ?? null }
  writeAtomic(`${stem}.json`, JSON.stringify(record, null, 2) + '\n')
  return record
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

function readExit(path: string): number | null {
  if (!existsSync(path)) return null
  const n = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
  return Number.isInteger(n) ? n : null
}

/** Every action a flow started, oldest first, each with its exit code when the script has ended. */
export function readActions(flowDir: string): Action[] {
  const dir = join(flowDir, ACTIONS)
  if (!existsSync(dir)) return []
  const out: Action[] = []
  for (const name of readdirSync(dir)) {
    if (!/^\d+-.+\.json$/.test(name)) continue
    let v: unknown
    try {
      v = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      continue
    }
    if (!isRecord(v) || typeof v['seq'] !== 'number' || typeof v['state'] !== 'string' || typeof v['run'] !== 'string' || typeof v['startedAt'] !== 'string') continue
    if (name !== `${v['seq']}-${v['state']}.json`) continue
    const pid = typeof v['pid'] === 'number' ? v['pid'] : null
    out.push({ seq: v['seq'], state: v['state'], run: v['run'], startedAt: v['startedAt'], pid, exit: readExit(join(dir, `${v['seq']}-${v['state']}.exit`)) })
  }
  return out.sort((a, b) => a.seq - b.seq)
}

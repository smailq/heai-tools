// The one action: `run` executes a command with /bin/sh -c in the project
// directory, its output in a log beside the record, and the event in its
// environment - REACTOR_* for the event and its rule, REACTOR_<FIELD> for
// every scalar payload field. Where anything else is - a tracker, another
// tool's state - is the script's business: it runs in the project directory
// and finds it there. Everything a rule wants done is a command that does
// it; the tool needs nothing but a shell.

import { spawn } from 'node:child_process'
import { closeSync, openSync, writeFileSync } from 'node:fs'
import type { Event, Log } from './events.ts'
import type { Paths } from './paths.ts'

export interface RunContext {
  event: Event
  /** The rule's name. */
  rule: string
  paths: Paths
  log: Log
  timeout: number | null
}

export interface Outcome {
  ok: boolean
  /** What was done, into the action record. */
  outcome: Record<string, unknown>
  error: string | null
}

const envName = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '_')

/** The seven names the event itself takes; a payload field that would take one goes under REACTOR_PAYLOAD_<FIELD> instead. */
export const RESERVED = ['EVENT', 'ID', 'SOURCE', 'KIND', 'KEY', 'AT', 'RULE']

/** The environment a `run` sees: REACTOR_EVENT naming the event file, the event's own fields, and every scalar payload field. */
export function environment(ctx: RunContext, eventPath: string): NodeJS.ProcessEnv {
  const { event } = ctx
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REACTOR_EVENT: eventPath,
    REACTOR_ID: event.id,
    REACTOR_SOURCE: event.source,
    REACTOR_KIND: event.kind,
    REACTOR_KEY: event.key,
    REACTOR_AT: event.at,
    REACTOR_RULE: ctx.rule
  }
  for (const [k, v] of Object.entries(event.payload)) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue
    const name = envName(k)
    env[RESERVED.includes(name) ? `REACTOR_PAYLOAD_${name}` : `REACTOR_${name}`] = String(v)
  }
  return env
}

/** One line saying what a run would do, for --dry-run and `test`. */
export const describe = (command: string): string => `run ${command}`

/** Execute a rendered command; the exit code is the outcome. */
export function run(command: string, ctx: RunContext): Promise<Outcome> {
  const { event, log } = ctx
  const eventPath = log.actionPath(event.id, ctx.rule, 'event.json')
  writeFileSync(eventPath, JSON.stringify(event, null, 2) + '\n')
  const logPath = log.actionPath(event.id, ctx.rule, 'log')
  const fd = openSync(logPath, 'w')
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd: ctx.paths.dir, env: environment(ctx, eventPath), stdio: ['ignore', fd, fd] })
    let timer: NodeJS.Timeout | null = null
    let timedOut = false
    if (ctx.timeout) {
      timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, ctx.timeout)
    }
    const done = (exitCode: number | null, signal: string | null, error: string | null) => {
      if (timer) clearTimeout(timer)
      closeSync(fd)
      const ok = exitCode === 0 && !error
      resolve({ ok, outcome: { command, exitCode, signal, log: logPath, timedOut }, error: error ?? (ok ? null : timedOut ? `timed out after ${ctx.timeout}ms` : `exited ${exitCode ?? signal}`) })
    }
    child.on('error', (e) => done(null, null, e.message))
    child.on('exit', (code, signal) => done(code, signal, null))
  })
}

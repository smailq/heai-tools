// The protocol, from the host's side. Everything here is files under the
// state directory's work_queue/: a job is a directory at the top, .running/
// while the worker has it, .done/ with a result.json after. The container is
// never asked; a script that knows the layout can do all of this without the
// command.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { RefusedError, UsageError, type StateDirs } from './config.ts'

/** A job name: letters, digits, `.`, `_`, `-`; never starting with a dot, so the worker sees it. */
export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export type Place = 'queued' | 'running' | 'done'

/** .running/<job>/claim.json, the worker's. */
export interface Claim {
  worker: string
  started: string
}

/** .done/<job>/result.json, the worker's. */
export interface Result {
  job: string
  status: 'ok' | 'failed' | 'timeout' | 'canceled' | 'crashed'
  exit: number
  signal?: string
  error?: string
  started: string
  finished: string
  duration_ms: number
  worker: string
}

export interface Job {
  name: string
  place: Place
  path: string
  claim?: Claim
  result?: Result
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** The non-dotted directories in `dir`, in name order; none when it is missing. */
function dirsIn(dir: string): string[] {
  if (!isDir(dir)) return []
  return readdirSync(dir)
    .filter((n) => !n.startsWith('.') && isDir(join(dir, n)))
    .sort()
}

function at(state: StateDirs, place: Place, name: string): Job {
  const path = join(place === 'queued' ? state.queue : place === 'running' ? state.running : state.done, name)
  const job: Job = { name, place, path }
  if (place === 'running') job.claim = readJson<Claim>(join(path, 'claim.json'))
  if (place === 'done') job.result = readJson<Result>(join(path, 'result.json'))
  return job
}

/** Every job: queued in name order, then running, then done. */
export function jobs(state: StateDirs): Job[] {
  return [...dirsIn(state.queue).map((n) => at(state, 'queued', n)), ...dirsIn(state.running).map((n) => at(state, 'running', n)), ...dirsIn(state.done).map((n) => at(state, 'done', n))]
}

/** The job by name, wherever it is. Looked for twice, since a rename can move it between two looks. */
export function find(state: StateDirs, name: string): Job | undefined {
  if (!NAME.test(name)) return undefined
  for (let pass = 0; pass < 2; pass++) {
    if (isDir(join(state.done, name))) return at(state, 'done', name)
    if (isDir(join(state.running, name))) return at(state, 'running', name)
    if (isDir(join(state.queue, name))) return at(state, 'queued', name)
  }
  return undefined
}

export interface Counts {
  queued: number
  running: number
  done: number
  /** The done jobs by status. */
  byStatus: Record<string, number>
}

export function counts(state: StateDirs): Counts {
  const out: Counts = { queued: dirsIn(state.queue).length, running: dirsIn(state.running).length, done: 0, byStatus: {} }
  for (const n of dirsIn(state.done)) {
    out.done++
    const status = readJson<Result>(join(state.done, n, 'result.json'))?.status ?? 'unknown'
    out.byStatus[status] = (out.byStatus[status] ?? 0) + 1
  }
  return out
}

export function checkName(name: string): string {
  if (!NAME.test(name)) throw new UsageError(`a job name is letters, digits, dots, dashes and underscores, not starting with a dot; not ${JSON.stringify(name)}`)
  return name
}

export interface SubmitOptions {
  name?: string
  /** Written into job.json as the worker's timeout for this job. */
  timeout?: string
  /** Move the directory in instead of copying it. */
  move?: boolean
}

/** Drop a copy (or the directory itself) into the queue under a dotted name, then rename it into place. Prints nothing; returns the name. */
export function submit(state: StateDirs, dir: string, opts: SubmitOptions = {}): string {
  const source = resolve(dir)
  if (!isDir(source)) throw new UsageError(`${dir} is not a directory`)
  const name = checkName(opts.name ?? basename(source))
  if (find(state, name)) throw new RefusedError(`a job named ${name} already exists; \`list\` shows where`)
  mkdirSync(state.queue, { recursive: true })
  const tmp = join(state.queue, `.tmp-${name}`)
  rmSync(tmp, { recursive: true, force: true })
  if (opts.move) {
    try {
      renameSync(source, tmp)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
      cpSync(source, tmp, { recursive: true, verbatimSymlinks: true })
      rmSync(source, { recursive: true, force: true })
    }
  } else cpSync(source, tmp, { recursive: true, verbatimSymlinks: true })
  if (opts.timeout !== undefined) {
    const spec = readJson<Record<string, unknown>>(join(tmp, 'job.json')) ?? {}
    writeFileSync(join(tmp, 'job.json'), JSON.stringify({ ...spec, timeout: opts.timeout }, null, 2) + '\n')
  }
  renameSync(tmp, join(state.queue, name))
  return name
}

const stamp = (d: Date): string => d.toISOString()

/**
 * A queued job is finished here and now as canceled, with a result of the host's; a running one gets a
 * `cancel` file and the worker finishes it. Refused when it is already done; unknown when it is nowhere.
 */
export function cancel(state: StateDirs, name: string): 'canceled' | 'requested' {
  checkName(name)
  const job = find(state, name)
  if (!job) throw new UsageError(`no job named ${name}`)
  if (job.place === 'done') throw new RefusedError(`${name} is already done (${job.result?.status ?? 'no result'})`)
  if (job.place === 'queued') {
    const tmp = join(state.done, `.tmp-${name}`)
    try {
      renameSync(job.path, tmp)
      const now = new Date()
      const result: Result = { job: name, status: 'canceled', exit: -1, started: stamp(now), finished: stamp(now), duration_ms: 0, worker: 'heai-pod' }
      writeFileSync(join(tmp, 'result.json'), JSON.stringify(result, null, 2) + '\n')
      renameSync(tmp, join(state.done, name))
      return 'canceled'
    } catch (e) {
      // the worker claimed it first; it is running now
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }
  writeFileSync(join(state.running, name, 'cancel'), '')
  return 'requested'
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Block until the job is done; null when `timeoutMs` passes first. Unknown when it is nowhere. */
export async function wait(state: StateDirs, name: string, timeoutMs?: number, every = 500): Promise<Job | null> {
  checkName(name)
  const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : Infinity
  for (;;) {
    const job = find(state, name)
    if (!job) throw new UsageError(`no job named ${name}`)
    if (job.place === 'done') return job
    if (Date.now() >= deadline) return null
    await sleep(Math.min(every, Math.max(0, deadline - Date.now())))
  }
}

/** The last `lines` lines of a file; empty when it is missing. */
export function tail(path: string, lines: number): string {
  if (!existsSync(path)) return ''
  const all = readFileSync(path, 'utf8').replace(/\n$/, '').split('\n')
  return all.slice(-lines).join('\n') + (all.length ? '\n' : '')
}

/** `91234` → `1m31s`; under a minute, seconds with one decimal. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

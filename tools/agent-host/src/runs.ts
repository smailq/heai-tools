// Run records, the queue, and the state directory: the files that are the
// whole of what the host knows.
//
// A run is a record the host writes plus four files the run itself writes
// into the mounted runs/ directory - .prompt read, .pid, .log and .exit
// written. Nothing here is held in memory across calls; every reader reads
// the files, so the CLI and the server agree by construction.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'blocked', 'failed', 'canceled', 'lost'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** A run is over once it is in one of these. */
export const TERMINAL: readonly RunStatus[] = ['succeeded', 'blocked', 'failed', 'canceled', 'lost']

export interface GateReport {
  verdict: 'clean' | 'violation' | 'error'
  /** scope-gate's own JSON output, kept whole, or the error text. */
  findings: unknown[]
  violations: number
  detail?: string
}

export interface RequestRecord {
  title: string
  territory: string
  /** The tracker slug it became, or null when rejected. */
  task: string | null
  error?: string
}

export interface RunRecord {
  id: string
  actor: string
  /** The tracker slug, or null for a free-form prompt. */
  task: string | null
  title: string
  /** The ref the source prepared for the run: a branch under git. */
  ref: string
  status: RunStatus
  queuedAt: string
  startedAt: string | null
  endedAt: string | null
  exitCode: number | null
  gate: GateReport | null
  requests: RequestRecord[]
  /** The run this one continues, when a blocked task resumed. */
  resumes: string | null
  /** Paths the run changed against the base, once settled. */
  changed: string[]
  /** Paths left uncommitted in the checkout, once settled. */
  dirty: string[]
  /** Why a run failed before or after its process, when the host knows. */
  error: string | null
}

export interface State {
  /** Absolute state directory. */
  dir: string
  runsDir: string
  checkoutsDir: string
  queueDir: string
  blockedDir: string
  requestedDir: string
}

/** Where the files live, created on first use with a `.gitignore` that ignores everything. */
export function openState(dir: string): State {
  const root = resolve(dir)
  const state: State = {
    dir: root,
    runsDir: join(root, 'runs'),
    checkoutsDir: join(root, 'checkouts'),
    queueDir: join(root, 'queue'),
    blockedDir: join(root, 'blocked'),
    requestedDir: join(root, 'requested')
  }
  for (const d of [root, state.runsDir, state.checkoutsDir, state.queueDir, state.blockedDir, state.requestedDir]) {
    mkdirSync(d, { recursive: true })
  }
  const ignore = join(root, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '# machine state, written by agent-host\n*\n')
  return state
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Ids sort chronologically (UTC, like every timestamp here), so the history needs no index: `20260902-153012-toolsmith-4f2a`. */
export function newRunId(actor: string, now: Date = new Date()): string {
  const ts =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  return `${ts}-${actor}-${randomBytes(2).toString('hex')}`
}

export const RUN_ID = /^[0-9]{8}-[0-9]{6}-[a-z0-9][a-z0-9._-]*-[0-9a-f]{4}$/

export const runFile = (state: State, id: string, ext: string): string => join(state.runsDir, `${id}.${ext}`)
export const requestsDir = (state: State, id: string): string => join(state.runsDir, `${id}.requests`)

/** Write a record atomically: a reader never sees half a file. */
export function writeRun(state: State, run: RunRecord): void {
  const path = runFile(state, run.id, 'json')
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(run, null, 2) + '\n')
  renameSync(tmp, path)
}

export function readRun(state: State, id: string): RunRecord | null {
  const path = runFile(state, id, 'json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunRecord
  } catch {
    return null
  }
}

/** Every run, newest first. */
export function listRuns(state: State, actor?: string): RunRecord[] {
  if (!existsSync(state.runsDir)) return []
  const runs: RunRecord[] = []
  for (const file of readdirSync(state.runsDir)) {
    if (!file.endsWith('.json')) continue
    const run = readRun(state, file.slice(0, -5))
    if (run && (!actor || run.actor === actor)) runs.push(run)
  }
  return runs.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

/** The run an actor is on, if any. */
export const currentRun = (state: State, actor: string): RunRecord | null =>
  listRuns(state, actor).find((r) => r.status === 'running') ?? null

/** The `.exit` file, written by the run itself when it ends; its presence means "over". */
export function readExit(state: State, id: string): number | null {
  const path = runFile(state, id, 'exit')
  if (!existsSync(path)) return null
  const n = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
  return Number.isFinite(n) ? n : 1
}

export function readPid(state: State, id: string): number | null {
  const path = runFile(state, id, 'pid')
  if (!existsSync(path)) return null
  const n = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
  return Number.isFinite(n) ? n : null
}

export const readLog = (state: State, id: string): string => {
  const path = runFile(state, id, 'log')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** The last non-empty lines of a log: what the agent said as it finished. */
export function finalMessage(log: string, lines = 12): string {
  const all = log.trimEnd().split('\n')
  return all.slice(Math.max(0, all.length - lines)).join('\n').trim()
}

// ── The queue ─────────────────────────────────────────────────────────────
// One directory per actor, one empty file per queued run, ordered by id.

export function enqueue(state: State, run: RunRecord): void {
  const dir = join(state.queueDir, run.actor)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, run.id), '')
}

export function queued(state: State, actor: string): string[] {
  const dir = join(state.queueDir, actor)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => RUN_ID.test(f)).sort()
}

export function dequeue(state: State, actor: string, id: string): void {
  const path = join(state.queueDir, actor, id)
  if (existsSync(path)) unlinkSync(path)
}

// ── Blocked tasks and requested tasks ─────────────────────────────────────

export interface BlockedTask {
  slug: string
  actor: string
  /** The tracker slugs it waits on. */
  waitsOn: string[]
  /** The run that filed them. */
  run: string
}

export interface RequestedTask {
  slug: string
  requestedBy: string
  run: string
  /** How many requests deep this task sits: 1 for a request from a hand-assigned task. */
  depth: number
}

export function writeBlocked(state: State, b: BlockedTask): void {
  writeFileSync(join(state.blockedDir, `${b.slug}.json`), JSON.stringify(b, null, 2) + '\n')
}
export function readBlocked(state: State, slug: string): BlockedTask | null {
  const path = join(state.blockedDir, `${slug}.json`)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BlockedTask
  } catch {
    return null
  }
}
export const listBlocked = (state: State): BlockedTask[] =>
  readdirSync(state.blockedDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readBlocked(state, f.slice(0, -5)))
    .filter((b): b is BlockedTask => b !== null)
export function clearBlocked(state: State, slug: string): void {
  rmSync(join(state.blockedDir, `${slug}.json`), { force: true })
}

export function writeRequested(state: State, r: RequestedTask): void {
  writeFileSync(join(state.requestedDir, `${r.slug}.json`), JSON.stringify(r, null, 2) + '\n')
}
export function readRequested(state: State, slug: string): RequestedTask | null {
  const path = join(state.requestedDir, `${slug}.json`)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RequestedTask
  } catch {
    return null
  }
}
/** How deep a task sits in a chain of requests: 0 when it was assigned by hand. */
export const chainDepth = (state: State, slug: string): number => readRequested(state, slug)?.depth ?? 0

// ── The settle lock ───────────────────────────────────────────────────────
// Two settlers at once - a CLI command and the server - are serialized by an
// atomic mkdir. A lock older than a minute is a crashed settler's, and is broken.

const LOCK_STALE_MS = 60_000

export function withLock<T>(state: State, fn: () => T): T | null {
  const lock = join(state.dir, 'settle.lock')
  try {
    mkdirSync(lock)
  } catch {
    let age = 0
    try {
      age = Date.now() - statSync(lock).mtimeMs
    } catch {
      return null
    }
    if (age < LOCK_STALE_MS) return null
    try {
      rmdirSync(lock)
      mkdirSync(lock)
    } catch {
      return null
    }
  }
  try {
    return fn()
  } finally {
    try {
      rmdirSync(lock)
    } catch {
      /* already gone */
    }
  }
}

/** Async form of the same lock. */
export async function withLockAsync<T>(state: State, fn: () => Promise<T>): Promise<T | null> {
  const lock = join(state.dir, 'settle.lock')
  try {
    mkdirSync(lock)
  } catch {
    let age = 0
    try {
      age = Date.now() - statSync(lock).mtimeMs
    } catch {
      return null
    }
    if (age < LOCK_STALE_MS) return null
    try {
      rmdirSync(lock)
      mkdirSync(lock)
    } catch {
      return null
    }
  }
  try {
    return await fn()
  } finally {
    try {
      rmdirSync(lock)
    } catch {
      /* already gone */
    }
  }
}

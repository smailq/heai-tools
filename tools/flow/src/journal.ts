// The files of one flow: the journal, which is the truth; the snapshot,
// which is a regenerated view of it; the touch file, which is the heartbeat;
// and the per-flow lock. Nothing here decides whether a move is legal - that
// is core.ts - and nothing here is remembered between calls.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Definition } from './definition.ts'
import { FlowError } from './errors.ts'

export const JOURNAL = 'journal.jsonl'
export const SNAPSHOT = 'state.json'
export const TOUCH = 'touch'
export const DEFINITION = 'definition.yaml'

/** One transition, as one line of the journal. */
export interface Line {
  seq: number
  at: string
  event: string
  from: string | null
  to: string
  by: string
  data: Record<string, unknown>
  note?: string
}

/** The current state of a flow: a projection of its journal, never the source of anything. */
export interface Snapshot {
  id: string
  definition: string
  state: string
  terminal: boolean
  /** When the current state was entered. */
  since: string
  startedAt: string
  /** The seq of the last journal line: the version an advance can compare against. */
  seq: number
  links: Record<string, string>
  waitsOn: string[]
  touchedAt: string | null
  /** When the earliest `after` out of the current state elapses, if any. */
  expiresAt: string | null
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

function parseLine(raw: string): Line | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(v)) return null
  if (typeof v['seq'] !== 'number' || typeof v['at'] !== 'string' || typeof v['event'] !== 'string' || typeof v['to'] !== 'string' || typeof v['by'] !== 'string') return null
  if (v['from'] !== null && typeof v['from'] !== 'string') return null
  const line: Line = { seq: v['seq'], at: v['at'], event: v['event'], from: v['from'] as string | null, to: v['to'], by: v['by'], data: isRecord(v['data']) ? v['data'] : {} }
  if (typeof v['note'] === 'string') line.note = v['note']
  return line
}

export interface Journal {
  lines: Line[]
  /** What a reader skipped: a torn last line, or one that does not parse. */
  problems: string[]
}

export function readJournal(path: string): Journal {
  if (!existsSync(path)) return { lines: [], problems: ['journal is missing'] }
  const text = readFileSync(path, 'utf8')
  const parts = text.split('\n')
  const torn = text.length > 0 && !text.endsWith('\n')
  const lines: Line[] = []
  const problems: string[] = []
  parts.forEach((raw, i) => {
    if (raw === '') return
    const line = parseLine(raw)
    if (line) lines.push(line)
    else problems.push(torn && i === parts.length - 1 ? `journal line ${i + 1} is torn (a crash mid-append) and is ignored` : `journal line ${i + 1} does not parse and is ignored`)
  })
  return { lines, problems }
}

/** Append one line. A torn tail from an earlier crash is cut first, so the new line starts after the last newline. */
export function appendLine(path: string, line: Line): void {
  if (existsSync(path)) {
    const buf = readFileSync(path)
    if (buf.length && buf[buf.length - 1] !== 0x0a) truncateSync(path, buf.lastIndexOf(0x0a) + 1)
  }
  appendFileSync(path, JSON.stringify(line) + '\n')
}

/** Write beside the target and rename into place: a reader never sees half a file. */
export function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

export const writeSnapshot = (flowDir: string, snap: Snapshot): void => writeAtomic(join(flowDir, SNAPSHOT), JSON.stringify(snap, null, 2) + '\n')

export function readSnapshot(flowDir: string): Snapshot | null {
  const path = join(flowDir, SNAPSHOT)
  if (!existsSync(path)) return null
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return isRecord(v) && typeof v['seq'] === 'number' && typeof v['state'] === 'string' ? (v as unknown as Snapshot) : null
  } catch {
    return null
  }
}

export const writeTouch = (flowDir: string, at: string): void => writeAtomic(join(flowDir, TOUCH), at + '\n')

export function readTouch(flowDir: string): string | null {
  const path = join(flowDir, TOUCH)
  if (!existsSync(path)) return null
  const at = readFileSync(path, 'utf8').trim()
  return Number.isFinite(Date.parse(at)) ? at : null
}

const later = (a: string, b: string | null): string => (b && Date.parse(b) > Date.parse(a) ? b : a)

/** The state a journal puts a flow in. Null when the journal has no usable start line. */
export function project(id: string, def: Definition, lines: Line[], touchedAt: string | null): Snapshot | null {
  const first = lines[0]
  if (!first || first.event !== 'start') return null
  let state = first.to
  let since = first.at
  const links: Record<string, string> = {}
  const waitsOn: string[] = []
  const merge = (data: Record<string, unknown>) => {
    if (isRecord(data['links'])) for (const [k, v] of Object.entries(data['links'])) if (typeof v === 'string') links[k] = v
    if (Array.isArray(data['waitsOn'])) for (const w of data['waitsOn']) if (typeof w === 'string' && !waitsOn.includes(w)) waitsOn.push(w)
  }
  for (const l of lines) {
    if (l.event === 'start' || l.event === 'link') merge(l.data)
    if (l.event !== 'link') {
      state = l.to
      since = l.at
    }
  }
  const terminal = def.terminal.includes(state)
  const base = later(since, touchedAt)
  let expiresAt: string | null = null
  if (!terminal)
    for (const t of def.transitions) {
      if (t.from !== state || t.after === null) continue
      const e = new Date(Date.parse(base) + t.after).toISOString()
      if (!expiresAt || e < expiresAt) expiresAt = e
    }
  return { id, definition: def.name, state, terminal, since, startedAt: first.at, seq: lines[lines.length - 1]!.seq, links, waitsOn, touchedAt, expiresAt }
}

// ── The per-flow lock ─────────────────────────────────────────────────────
// An atomic mkdir, held for the milliseconds an append takes. A lock older
// than a minute belongs to a crashed writer and is broken; its PID is never
// consulted, since a PID proves nothing after a restart.

const LOCK_STALE_MS = 60_000
const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function withFlowLock<T>(flowDir: string, fn: () => T, waitMs = 3000): T {
  const lock = join(flowDir, 'lock')
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      let age = 0
      try {
        age = Date.now() - statSync(lock).mtimeMs
      } catch {
        continue
      }
      if (age >= LOCK_STALE_MS) {
        try {
          rmdirSync(lock)
        } catch {
          /* someone else broke it first */
        }
        continue
      }
      if (Date.now() >= deadline) throw new FlowError('locked', `${flowDir} is locked by another writer`)
      sleep(15)
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

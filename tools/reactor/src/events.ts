// The state directory: the event log, the dedupe keys, each source's
// cursor, each rule's debounce and limit state, and every action's record.
// All of it is files, so a restart resumes and `ls` is a report.

import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from './errors.ts'

export interface Event {
  id: string
  source: string
  kind: string
  key: string
  at: string
  payload: Record<string, unknown>
}

/** What a source hands over; the log gives it an id and a time. */
export interface RawEvent {
  kind: string
  key: string
  payload: Record<string, unknown>
  at?: string
}

export interface ActionRecord {
  event: string
  rule: string
  /** The one action there is; kept in the record so a reader need not know that. */
  action: 'run'
  at: string
  ok: boolean
  outcome: Record<string, unknown>
  error: string | null
  /** Events a debounce collapsed into this one, when it did. */
  collapsed?: string[]
}

export interface RuleState {
  pending: { event: string; key: string; since: string; until: string; events: string[] } | null
  window: { start: string; count: number; noted: boolean } | null
  lastAction: string | null
}

const EMPTY_RULE_STATE: RuleState = { pending: null, window: null, lastAction: null }

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

export function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const day = (iso: string): string => iso.slice(0, 10)

function parseEvent(raw: string): Event | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(v)) return null
  if (typeof v['id'] !== 'string' || typeof v['source'] !== 'string' || typeof v['kind'] !== 'string' || typeof v['key'] !== 'string' || typeof v['at'] !== 'string') return null
  return { id: v['id'], source: v['source'], kind: v['kind'], key: v['key'], at: v['at'], payload: isRecord(v['payload']) ? v['payload'] : {} }
}

export interface ReadFilter {
  since?: Date
  source?: string
  kind?: string
}

/** `pull_request.*` matches `pull_request.closed`; `*` matches everything. */
export const globMatch = (glob: string, s: string): boolean => new RegExp(`^${glob.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(s)

export class Log {
  readonly dir: string
  readonly now: () => Date

  constructor(dir: string, now: () => Date = () => new Date()) {
    this.dir = dir
    this.now = now
    for (const sub of ['events', 'actions', 'sources', 'keys', 'rules']) mkdirSync(join(dir, sub), { recursive: true })
    const ignore = join(dir, '.gitignore')
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  }

  // ── events ──────────────────────────────────────────────────────────────

  /** A fresh id for an event at `at`: the time, then six hex digits. */
  newId(at: string): string {
    return `${stamp(new Date(at))}-${randomBytes(3).toString('hex')}`
  }

  append(source: string, raw: RawEvent, id?: string): Event {
    const at = raw.at ?? this.now().toISOString()
    id ??= this.newId(at)
    const event: Event = { id, source, kind: raw.kind, key: raw.key, at, payload: raw.payload }
    appendFileSync(join(this.dir, 'events', `${day(at)}.jsonl`), JSON.stringify(event) + '\n')
    return event
  }

  /** Every event, oldest first, filtered. */
  read(filter: ReadFilter = {}): Event[] {
    const dir = join(this.dir, 'events')
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
    const sinceDay = filter.since ? day(filter.since.toISOString()) : null
    const out: Event[] = []
    for (const f of files) {
      if (sinceDay && f.slice(0, 10) < sinceDay) continue
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (!line) continue
        const e = parseEvent(line)
        if (!e) continue
        if (filter.since && Date.parse(e.at) < filter.since.getTime()) continue
        if (filter.source && e.source !== filter.source) continue
        if (filter.kind && !globMatch(filter.kind, e.kind)) continue
        out.push(e)
      }
    }
    return out
  }

  get(id: string): Event | null {
    const m = id.match(/^(\d{4})(\d{2})(\d{2})-/)
    const path = m ? join(this.dir, 'events', `${m[1]}-${m[2]}-${m[3]}.jsonl`) : null
    if (path && existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const e = line ? parseEvent(line) : null
        if (e?.id === id) return e
      }
    }
    return this.read().find((e) => e.id === id) ?? null
  }

  // ── dedupe keys: one empty file per (rule, key) a rule has acted on ─────

  private keyPath(rule: string, key: string): string {
    return join(this.dir, 'keys', sha256(`${rule}@${key}`))
  }

  hasKey(rule: string, key: string): boolean {
    return existsSync(this.keyPath(rule, key))
  }

  markKey(rule: string, key: string): void {
    writeFileSync(this.keyPath(rule, key), `${rule}@${key}\n`)
  }

  // ── cursors ─────────────────────────────────────────────────────────────

  cursor<T>(source: string): T | null {
    return readJson(join(this.dir, 'sources', `${source}.json`)) as T | null
  }

  setCursor(source: string, value: unknown): void {
    writeAtomic(join(this.dir, 'sources', `${source}.json`), JSON.stringify(value, null, 2) + '\n')
  }

  // ── rule state ──────────────────────────────────────────────────────────

  ruleState(rule: string): RuleState {
    const v = readJson(join(this.dir, 'rules', `${rule}.json`))
    return isRecord(v) ? { ...EMPTY_RULE_STATE, ...(v as Partial<RuleState>) } : { ...EMPTY_RULE_STATE }
  }

  setRuleState(rule: string, state: RuleState): void {
    writeAtomic(join(this.dir, 'rules', `${rule}.json`), JSON.stringify(state, null, 2) + '\n')
  }

  ruleNames(): string[] {
    return readdirSync(join(this.dir, 'rules'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
  }

  // ── actions ─────────────────────────────────────────────────────────────

  actionPath(eventId: string, rule: string, ext = 'json'): string {
    return join(this.dir, 'actions', `${eventId}.${rule}.${ext}`)
  }

  record(action: ActionRecord): ActionRecord {
    writeAtomic(this.actionPath(action.event, action.rule), JSON.stringify(action, null, 2) + '\n')
    return action
  }

  /** Every action for each of the given events, by event id, oldest first; one pass over the directory. */
  actionsFor(eventIds: Iterable<string>): Map<string, ActionRecord[]> {
    const out = new Map<string, ActionRecord[]>()
    for (const id of eventIds) out.set(id, [])
    for (const a of this.actions()) out.get(a.event)?.push(a)
    return out
  }

  /** Every action, or those for one event, oldest first. */
  actions(eventId?: string): ActionRecord[] {
    const dir = join(this.dir, 'actions')
    const out: ActionRecord[] = []
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith('.json') || f.endsWith('.event.json')) continue
      if (eventId && !f.startsWith(`${eventId}.`)) continue
      const v = readJson(join(dir, f))
      if (isRecord(v) && typeof v['event'] === 'string' && typeof v['rule'] === 'string') out.push(v as unknown as ActionRecord)
    }
    return out
  }
}

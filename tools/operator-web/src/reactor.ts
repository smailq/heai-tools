// What the reactor has seen and done: `heai-reactor status --json` for its
// sources and rules, `heai-reactor events --since 1h --json` for the last
// hour's events, each carrying the actions rules took on it.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { short } from './format.ts'
import { message, run, which } from './run.ts'

export interface Source {
  name: string
  type: string
  every: number | null
  listens: string | null
  emits: boolean
  cursor: string
  lastEvent: string | null
  lastHour: number
}

export interface Action {
  event: string
  rule: string
  action: string
  at: string
  ok: boolean
  outcome: Record<string, unknown> | null
  error: string | null
}

export interface Rule {
  name: string
  on: string
  run: string
  debounce: number | null
  limit: { count: number; windowMs: number } | null
  lastAction: Action | null
  pending: { until: string } | null
}

export interface ReactorStatus {
  sources: Source[]
  rules: Rule[]
}

export interface Event {
  id: string
  source: string
  kind: string
  key: string
  at: string
  payload: Record<string, unknown> | null
  actions: Action[] | null
}

export interface ReactorResult {
  status: ReactorStatus | null
  /** The last hour, newest first. */
  events: Event[]
  note: string
  failed: boolean
  at: number
}

/** How a source gets its events: "every 10s", "listens /hook/github", "from emit", or "idle". */
export function cadence(s: Source): string {
  if (s.every !== null) return `every ${short(s.every)}`
  if (s.listens !== null) return `listens ${s.listens}`
  return s.emits ? 'from emit' : 'idle'
}

/** What the cursor reports after "PROBLEM", or "". */
export function problem(s: Source): string {
  const i = s.cursor.indexOf('PROBLEM ')
  return i < 0 ? '' : s.cursor.slice(i + 'PROBLEM '.length)
}

export const problems = (st: ReactorStatus | null): number => (st?.sources ?? []).filter((s) => problem(s) !== '').length

export const limited = (a: Action): boolean => a.outcome?.['limited'] === true
export const command = (a: Action): string => (typeof a.outcome?.['command'] === 'string' ? (a.outcome['command'] as string) : '')
export const logPath = (a: Action): string => (typeof a.outcome?.['log'] === 'string' ? (a.outcome['log'] as string) : '')
/** Ran and went wrong; a limited event is held, not failed. */
export const actionFailed = (a: Action): boolean => !a.ok && !limited(a)

/** One word on the outcome: "ok", "limited", or the error. */
export function actionResult(a: Action): string {
  if (a.ok) return 'ok'
  if (limited(a)) return 'limited'
  return a.error || 'failed'
}

/** A rule's limit as the configuration wrote it: "10/hour". */
export function limitText(l: { count: number; windowMs: number }): string {
  const unit = ({ 60_000: 'minute', 3_600_000: 'hour', 86_400_000: 'day', 604_800_000: 'week' } as Record<number, string>)[l.windowMs] ?? short(l.windowMs)
  return `${l.count}/${unit}`
}

/** A rule's last run in one word, as the terminal's rules block says it. */
export function ruleResult(r: Rule): string {
  if (r.lastAction) return actionResult(r.lastAction)
  if (r.limit) return `limit ${limitText(r.limit)}`
  return 'never fired'
}

export const failedActions = (r: ReactorResult): Action[] => r.events.flatMap((e) => (e.actions ?? []).filter(actionFailed))
export const reactorRed = (r: ReactorResult): boolean => failedActions(r).length > 0

/** Whether reactor has anything here. `reactor status` creates reactor/ when absent. */
export function reactorConfigured(project: string): string {
  if (process.env['HEAI_REACTOR_STATE']) return ''
  if (!project) return 'no project directory, so nowhere to look for reactor.yaml'
  for (const n of ['reactor.yaml', 'reactor', '.heai/reactor.yaml', '.heai/reactor']) if (existsSync(join(project, n))) return ''
  return 'not configured here (no reactor.yaml or reactor/ in the project)'
}

/** Events as `events --json` prints them, oldest first, reordered newest first. */
export function newestFirst(list: Event[]): Event[] {
  return [...list].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0))
}

export async function pollReactor(project: string, now: number): Promise<ReactorResult> {
  const r: ReactorResult = { status: null, events: [], note: '', failed: false, at: now }
  const bin = which('heai-reactor')
  if (!bin) return { ...r, note: 'heai-reactor not on PATH' }
  const why = reactorConfigured(project)
  if (why) return { ...r, note: why }
  const dir = project ? ['--dir', project] : []
  try {
    r.status = JSON.parse(await run(bin, ['status', '--json', ...dir], { name: 'reactor' })) as ReactorStatus
    r.events = newestFirst(JSON.parse(await run(bin, ['events', '--since', '1h', '--json', ...dir], { name: 'reactor' })) as Event[])
  } catch (e) {
    return { ...r, status: null, note: message(e), failed: true }
  }
  return r
}

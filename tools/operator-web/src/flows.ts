// What flow knows: its definitions whole, every flow, what is stuck, and one
// flow's timeline - all from `heai-flow ... --json`, run with --dir set to the
// map's directory so flow looks beside the same map this server reads.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { message, run, which } from './run.ts'

export interface Flow {
  id: string
  definition: string
  state: string
  terminal: boolean
  since: string
  startedAt: string
  seq: number
  links: Record<string, string>
  waitsOn: string[]
  touchedAt: string | null
  expiresAt: string | null
}

export interface Wait {
  id: string
  state: string | null
}

export interface Stuck {
  flow: Flow
  idleMs: number
  waits: Wait[]
}

export interface Transition {
  from: string
  to: string
  on: string
  when: Record<string, unknown> | null
  /** How long `from` may last before the clock takes this move, in ms. */
  after: number | null
  requires: { waitsOn: { all: string[] } } | null
  by: string[] | null
}

/** One entry of `flow definitions --json`: the machine whole when it validates, its problem when not. */
export interface Definition {
  name: string
  path: string
  problem: string | null
  states: string[] | null
  initial?: string | null
  terminal?: string[] | null
  links?: Record<string, { required: boolean }> | null
  transitions?: Transition[] | null
  hooks?: Record<string, { run: string }> | null
}

export interface TraceLine {
  id: string
  definition: string
  seq: number
  at: string
  event: string
  from: string | null
  to: string
  by: string
  data: Record<string, unknown> | null
  note: string
}

export interface Timeline {
  flows: Flow[]
  lines: TraceLine[]
}

export interface FlowsResult {
  definitions: Definition[]
  flows: Flow[]
  stuck: Stuck[]
  /** Why the lists are empty or old. */
  note: string
  /** flow could not answer; the last answer is kept and marked old. */
  failed: boolean
  at: number
}

/**
 * Whether flow has anything beside this map: flow.yaml, a flow/ directory, or
 * HEAI_FLOW_STATE. Asked first because `flow list` creates flow/ when it is
 * absent, and a reader must not leave a state directory behind.
 */
export function flowConfigured(mapPath: string): string {
  if (process.env['HEAI_FLOW_STATE']) return ''
  if (!mapPath) return 'no map, so nowhere to look for flow/'
  const dir = dirname(mapPath)
  if (existsSync(join(dir, 'flow.yaml')) || existsSync(join(dir, 'flow'))) return ''
  return 'not configured here (no flow.yaml or flow/ beside the map)'
}

function flow(mapPath: string, args: string[]): Promise<string> {
  const bin = which('heai-flow')
  if (!bin) return Promise.reject(new Error('heai-flow not on PATH'))
  return run(bin, mapPath ? [...args, '--dir', dirname(mapPath)] : args, { name: 'flow' })
}

export async function pollFlows(mapPath: string, now: number): Promise<FlowsResult> {
  const r: FlowsResult = { definitions: [], flows: [], stuck: [], note: '', failed: false, at: now }
  if (!which('heai-flow')) return { ...r, note: 'heai-flow not on PATH' }
  const why = flowConfigured(mapPath)
  if (why) return { ...r, note: why }
  try {
    r.definitions = JSON.parse(await flow(mapPath, ['definitions', '--json'])) as Definition[]
    r.flows = JSON.parse(await flow(mapPath, ['list', '--json'])) as Flow[]
    r.stuck = JSON.parse(await flow(mapPath, ['stuck', '--json'])) as Stuck[]
  } catch (e) {
    return { ...r, definitions: [], flows: [], stuck: [], note: message(e), failed: true }
  }
  return r
}

export async function traceJSON(mapPath: string, id: string): Promise<Timeline> {
  return JSON.parse(await flow(mapPath, ['trace', id, '--json'])) as Timeline
}

export const openCount = (list: Flow[]): number => list.filter((f) => !f.terminal).length

/**
 * Where a stuck flow's waits stand, and whether that is red: a waited flow that is
 * missing, or that flow calls terminal, will never move again.
 */
export function stands(s: Stuck, flows: Flow[]): { text: string; red: boolean } {
  const byId = new Map(flows.map((f) => [f.id, f]))
  let red = false
  const parts = s.waits.map((w) => {
    if (w.state === null) {
      red = true
      return 'missing'
    }
    if (byId.get(w.id)?.terminal) red = true
    return w.state
  })
  return { text: parts.join(', '), red }
}

export const flowsRed = (r: FlowsResult): boolean => r.stuck.some((s) => stands(s, r.flows).red)

/** The state change a line made: "→ queued" at the start, "from → to", or the event for a line that moved nothing. */
export function move(l: TraceLine): string {
  if (l.from === null) return `→ ${l.to}`
  if (l.from !== l.to) return `${l.from} → ${l.to}`
  return l.event
}

/** What came of a line: its note, else its data by name, less the keys that restate a link. */
export function lineResult(l: TraceLine): string {
  if (l.note) return l.note
  return Object.keys(l.data ?? {})
    .filter((k) => k !== 'links' && k !== 'waitsOn')
    .sort()
    .map((k) => `${k}=${String(l.data![k])}`)
    .join(' ')
}

// A definition: a flat state machine in a YAML file. States, one initial,
// some terminal, and transitions each with a `from`, a `to` and the `on`
// event that makes it. A transition may also say what the event's data must
// say (`when`), how long the state may last (`after`), which states the flows
// this one waits on must reach (`requires`), and who may take it (`by`).
//
// A definition may also carry `hooks`: for any state, the one script flow
// starts when a flow enters it. The shape is validated here and pinned with
// the rest of the text; actions.ts is what runs one.
//
// Validated when a flow starts under it, and pinned verbatim into the flow,
// so editing the file later changes nothing already recorded.

import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { UsageError } from './errors.ts'

export type Scalar = string | number | boolean | null

export const NAME = /^[a-z0-9][a-z0-9._-]*$/
/** Events the journal writes itself; a definition may not name them. */
export const RESERVED_EVENTS = ['start', 'link', 'touch'] as const
/** Writers the tool signs as itself; a caller may not claim them. */
export const RESERVED_BY = ['flow'] as const

export interface Transition {
  from: string
  to: string
  on: string
  /** Equality on top-level keys of the event's data, nothing more. */
  when: Record<string, Scalar> | null
  /** How long `from` may last before the clock takes this move, in ms. */
  after: number | null
  /** Every flow this one waits on must be in one of these states. */
  requires: { waitsOn: { all: string[] } } | null
  /** Who may take it; null means anyone. */
  by: string[] | null
}

/** The one hook: the script flow starts, detached, when a flow enters the state. */
export type Hook = { run: string }

export interface Definition {
  name: string
  states: string[]
  initial: string
  terminal: string[]
  links: Record<string, { required: boolean }>
  transitions: Transition[]
  /** State name to the script run on entering it; validated here, started in actions.ts. */
  hooks: Record<string, Hook>
  /** The YAML it was read from, pinned into every flow started under it. */
  text: string
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** `90s`, `10m`, `2h`, `1d`; a bare number is seconds. Null when it is none of those. */
export function parseDuration(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v * 1000 : null
  if (typeof v !== 'string') return null
  const m = v.trim().match(/^(\d+)\s*(ms|s|m|h|d)$/)
  if (!m) return null
  const n = Number(m[1]) * UNITS[m[2]!]!
  return n > 0 ? n : null
}

/** The shortest exact spelling: 600000 is `10m`, 90000 is `90s`. */
export function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const isScalar = (v: unknown): v is Scalar => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

const TOP_KEYS = ['name', 'states', 'initial', 'terminal', 'links', 'transitions', 'hooks']
const TRANSITION_KEYS = ['from', 'to', 'on', 'when', 'after', 'requires', 'by']

/** Parse and validate a definition; every problem is reported at once. */
export function parseDefinition(text: string, where: string): Definition {
  let doc: unknown
  try {
    doc = parse(text)
  } catch (e) {
    throw new UsageError(`${where}: not valid YAML: ${(e as Error).message}`)
  }
  if (!isRecord(doc)) throw new UsageError(`${where}: a definition must be a mapping`)
  const problems: string[] = []
  const fail = (): never => {
    throw new UsageError(`${where} does not validate:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
  }
  for (const key of Object.keys(doc)) if (!TOP_KEYS.includes(key)) problems.push(`unknown key ${JSON.stringify(key)}`)

  const name = doc['name']
  if (typeof name !== 'string' || !NAME.test(name)) problems.push('name must be a lowercase word, like `run`')

  const states: string[] = []
  if (!Array.isArray(doc['states']) || !doc['states'].length) problems.push('states must be a non-empty list')
  else
    for (const s of doc['states']) {
      if (typeof s !== 'string' || !NAME.test(s)) problems.push(`state ${JSON.stringify(s)} is not a lowercase word`)
      else if (states.includes(s)) problems.push(`state ${s} is listed twice`)
      else states.push(s)
    }
  const known = (s: unknown): s is string => typeof s === 'string' && states.includes(s)

  const initial = doc['initial']
  if (!known(initial)) problems.push('initial must name one of the states')

  const terminal: string[] = []
  if (doc['terminal'] !== undefined) {
    if (!Array.isArray(doc['terminal'])) problems.push('terminal must be a list of states')
    else
      for (const s of doc['terminal']) {
        if (!known(s)) problems.push(`terminal state ${JSON.stringify(s)} is not one of the states`)
        else if (!terminal.includes(s)) terminal.push(s)
      }
  }
  if (known(initial) && terminal.includes(initial)) problems.push(`initial state ${initial} cannot be terminal`)

  const links: Record<string, { required: boolean }> = {}
  if (doc['links'] !== undefined) {
    if (!isRecord(doc['links'])) problems.push('links must be a mapping of link name to { required }')
    else
      for (const [k, v] of Object.entries(doc['links'])) {
        if (!NAME.test(k)) problems.push(`link name ${JSON.stringify(k)} is not a lowercase word`)
        if (k === 'waits-on') problems.push(`link name ${k} is reserved for flow-to-flow links`)
        if (v === null) links[k] = { required: false }
        else if (!isRecord(v) || Object.keys(v).some((x) => x !== 'required') || (v['required'] !== undefined && typeof v['required'] !== 'boolean'))
          problems.push(`link ${k} must be { required: true|false }`)
        else links[k] = { required: v['required'] === true }
      }
  }

  const transitions: Transition[] = []
  if (!Array.isArray(doc['transitions'])) problems.push('transitions must be a list')
  else
    doc['transitions'].forEach((raw, i) => {
      const at = `transition ${i + 1}`
      if (!isRecord(raw)) {
        problems.push(`${at} must be a mapping`)
        return
      }
      for (const key of Object.keys(raw)) if (!TRANSITION_KEYS.includes(key)) problems.push(`${at}: unknown key ${JSON.stringify(key)}`)
      let ok = true
      // `from: [a, b, c]` is sugar: one transition per source, identical otherwise.
      const sources: string[] = []
      if (Array.isArray(raw['from'])) {
        if (!raw['from'].length) problems.push(`${at}: from lists no states`)
        for (const s of raw['from']) {
          if (!known(s)) problems.push(`${at}: from lists ${JSON.stringify(s)}, which is not one of the states`)
          else if (sources.includes(s)) problems.push(`${at}: from lists ${s} twice`)
          else sources.push(s)
        }
        if (sources.length !== raw['from'].length) ok = false
      } else if (!known(raw['from'])) {
        problems.push(`${at}: from must name one of the states, or list several`)
        ok = false
      } else sources.push(raw['from'])
      if (!known(raw['to'])) {
        problems.push(`${at}: to must name one of the states`)
        ok = false
      }
      const on = raw['on']
      if (typeof on !== 'string' || !NAME.test(on)) {
        problems.push(`${at}: on must name the event, a lowercase word`)
        ok = false
      } else if ((RESERVED_EVENTS as readonly string[]).includes(on)) {
        problems.push(`${at}: ${on} is an event the journal writes itself; pick another name`)
        ok = false
      }
      let when: Record<string, Scalar> | null = null
      if (raw['when'] !== undefined) {
        if (!isRecord(raw['when']) || !Object.values(raw['when']).every(isScalar)) {
          problems.push(`${at}: when must be a mapping of data keys to scalar values`)
          ok = false
        } else when = raw['when'] as Record<string, Scalar>
      }
      let after: number | null = null
      if (raw['after'] !== undefined) {
        after = parseDuration(raw['after'])
        if (after === null) {
          problems.push(`${at}: after must be a duration like 10m, 2h or 90s`)
          ok = false
        }
      }
      let requires: Transition['requires'] = null
      if (raw['requires'] !== undefined) {
        const r = raw['requires']
        const w = isRecord(r) ? r['waits-on'] : undefined
        const all = isRecord(w) ? w['all'] : undefined
        if (!isRecord(r) || Object.keys(r).some((k) => k !== 'waits-on') || !isRecord(w) || Object.keys(w).some((k) => k !== 'all') || !Array.isArray(all) || !all.length) {
          problems.push(`${at}: requires must be { waits-on: { all: [states] } }`)
          ok = false
        } else {
          for (const s of all) if (typeof s !== 'string' || !NAME.test(s)) problems.push(`${at}: requires names ${JSON.stringify(s)}, which is not a state name`)
          requires = { waitsOn: { all: all.filter((s): s is string => typeof s === 'string') } }
        }
      }
      if (after !== null && requires !== null) problems.push(`${at}: after and requires cannot combine; use two transitions`)
      if (when !== null && (after !== null || requires !== null)) problems.push(`${at}: when reads an event's data, which the clock and a guard do not carry`)
      let by: string[] | null = null
      if (raw['by'] !== undefined) {
        if (!Array.isArray(raw['by']) || !raw['by'].length || !raw['by'].every((b) => typeof b === 'string' && b.length)) {
          problems.push(`${at}: by must be a non-empty list of names`)
          ok = false
        } else by = raw['by'] as string[]
      }
      if (ok) for (const from of sources) transitions.push({ from, to: raw['to'] as string, on: on as string, when, after, requires, by })
    })

  const hooks: Record<string, Hook> = {}
  if (doc['hooks'] !== undefined && doc['hooks'] !== null) {
    if (!isRecord(doc['hooks'])) problems.push('hooks must be a mapping of state name to { run: <script> }')
    else
      for (const [state, raw] of Object.entries(doc['hooks'])) {
        const at = `hook ${state}`
        if (!known(state)) problems.push(`${at}: ${JSON.stringify(state)} is not one of the states`)
        if (!isRecord(raw)) {
          problems.push(`${at}: must be { run: <script> }`)
          continue
        }
        const strange = Object.keys(raw).filter((k) => k !== 'run')
        if (strange.length) problems.push(`${at}: unknown key${strange.length > 1 ? 's' : ''} ${strange.map((k) => JSON.stringify(k)).join(', ')}; the one action is run`)
        const value = raw['run']
        if (typeof value !== 'string' || !value.trim()) problems.push(`${at}: run must be a command, a non-empty string`)
        else if (known(state) && !strange.length) hooks[state] = { run: value }
      }
  }

  if (problems.length) fail()
  const outOf = (s: string) => transitions.filter((t) => t.from === s)
  for (const s of states) {
    if (terminal.includes(s)) {
      if (outOf(s).length) problems.push(`terminal state ${s} has a way out`)
    } else if (!outOf(s).length) problems.push(`state ${s} has no way out and is not terminal`)
  }
  if (problems.length) fail()
  return { name: name as string, states, initial: initial as string, terminal, links, transitions, hooks, text }
}

export function loadDefinition(path: string): Definition {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new UsageError(`no definition file at ${path}`)
  }
  return parseDefinition(text, path)
}

/** The transitions an event could take from a state, in file order. */
export const candidates = (def: Definition, state: string, event: string): Transition[] =>
  def.transitions.filter((t) => t.from === state && t.on === event)

/** The first candidate whose `when` the data satisfies. */
export function matchTransition(def: Definition, state: string, event: string, data: Record<string, unknown>): Transition | null {
  return candidates(def, state, event).find((t) => !t.when || Object.entries(t.when).every(([k, v]) => data[k] === v)) ?? null
}

// The referee: one flow, one move, refused if the definition does not allow
// it. Every write to a journal goes through here, under the flow's lock, and
// is followed by the snapshot and the index entries so the views never lag
// the truth by more than a crash.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { candidates, matchTransition, parseDefinition, RESERVED_BY, RESERVED_EVENTS, type Definition, type Transition } from './definition.ts'
import { appendLine, DEFINITION, JOURNAL, project, readJournal, readTouch, withFlowLock, writeAtomic, writeSnapshot, writeTouch, type Line, type Snapshot } from './journal.ts'
import { updateIndex } from './index.ts'
import { entersState, type Entered } from './actions.ts'
import { FlowError, UsageError } from './errors.ts'

export const FLOWS = 'flows'
export const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export interface Flow {
  id: string
  dir: string
  definition: Definition
  lines: Line[]
  snapshot: Snapshot
  /** What the journal reader skipped. */
  problems: string[]
}

/** The state directory, created on first use with a `.gitignore` that ignores everything. */
export function openRoot(dir: string): string {
  const root = resolve(dir)
  mkdirSync(join(root, FLOWS), { recursive: true })
  const ignore = join(root, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '# machine state, written by flow\n*\n')
  return root
}

export const flowDir = (root: string, id: string): string => join(root, FLOWS, id)

export function listIds(root: string): string[] {
  const dir = join(root, FLOWS)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => ID.test(n) && statSync(join(dir, n)).isDirectory())
    .sort()
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Ids sort by time, so `ls flows/` is the history: `20260904-165952-run-132f`. */
export function newId(definition: string, now: Date): string {
  const ts =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  return `${ts}-${definition}-${randomBytes(2).toString('hex')}`
}

export function loadFlow(root: string, id: string): Flow | null {
  const dir = flowDir(root, id)
  if (!existsSync(join(dir, DEFINITION))) return null
  let definition: Definition
  try {
    definition = parseDefinition(readFileSync(join(dir, DEFINITION), 'utf8'), join(dir, DEFINITION))
  } catch {
    return null
  }
  const journal = readJournal(join(dir, JOURNAL))
  const snapshot = project(id, definition, journal.lines, readTouch(dir))
  if (!snapshot) return null
  return { id, dir, definition, lines: journal.lines, snapshot, problems: journal.problems }
}

const mustExist = (root: string, id: string): void => {
  if (!existsSync(join(flowDir(root, id), DEFINITION))) throw new FlowError('not-found', `no flow ${id}`)
}

const mustLoad = (root: string, id: string): Flow => {
  const flow = loadFlow(root, id)
  if (!flow) throw new FlowError('not-found', `no flow ${id}`)
  return flow
}

function checkBy(by: string): void {
  if (!by) throw new UsageError('by must name who makes the move')
  if ((RESERVED_BY as readonly string[]).includes(by)) throw new UsageError(`by ${by} is what the tool signs its own moves as; pass your own name`)
}

function checkLinks(def: Definition, links: Record<string, string>): void {
  for (const [name, value] of Object.entries(links)) {
    if (!(name in def.links)) {
      const declared = Object.keys(def.links)
      throw new UsageError(`definition ${def.name} declares no link ${name}${declared.length ? `; it declares ${declared.join(', ')}` : ''}`)
    }
    if (typeof value !== 'string' || !value) throw new UsageError(`link ${name} needs a value`)
  }
}

function checkTargets(root: string, ids: string[]): void {
  for (const id of ids) if (!existsSync(join(flowDir(root, id), DEFINITION))) throw new FlowError('not-found', `no flow ${id} to link to`)
}

const finish = (root: string, flow: Pick<Flow, 'id' | 'dir' | 'definition'>, lines: Line[]): Snapshot => {
  const snapshot = project(flow.id, flow.definition, lines, readTouch(flow.dir))!
  writeSnapshot(flow.dir, snapshot)
  updateIndex(root, snapshot)
  return snapshot
}

/** What the action for this line needs, when the line entered a state; captured here, under the lock, and acted on by the store after it. */
const entered = (flow: Pick<Flow, 'id' | 'dir' | 'definition'>, line: Line, snapshot: Snapshot): Entered | null =>
  entersState(line) ? { id: flow.id, dir: flow.dir, definition: flow.definition, line, links: snapshot.links } : null

export interface StartSpec {
  id?: string
  definition: Definition
  links: Record<string, string>
  waitsOn: string[]
  by: string
  note?: string
}

/** Start a flow: its directory, the pinned definition, and journal line 0, which enters the initial state. */
export function createFlow(root: string, spec: StartSpec, now: Date): { id: string; line: Line; snapshot: Snapshot; entered: Entered } {
  const def = spec.definition
  checkBy(spec.by)
  if (spec.id !== undefined && !ID.test(spec.id)) throw new UsageError(`id ${JSON.stringify(spec.id)} must be letters, digits, dots, dashes and underscores`)
  checkLinks(def, spec.links)
  for (const [name, l] of Object.entries(def.links)) if (l.required && !(name in spec.links)) throw new UsageError(`definition ${def.name} requires link ${name}`)
  checkTargets(root, spec.waitsOn)
  const id = spec.id ?? newId(def.name, now)
  const dir = flowDir(root, id)
  try {
    mkdirSync(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new FlowError('conflict', `flow ${id} already exists`)
    throw e
  }
  writeFileSync(join(dir, DEFINITION), def.text)
  const data: Record<string, unknown> = { links: spec.links }
  if (spec.waitsOn.length) data['waitsOn'] = [...new Set(spec.waitsOn)]
  const line: Line = { seq: 0, at: now.toISOString(), event: 'start', from: null, to: def.initial, by: spec.by, data }
  if (spec.note) line.note = spec.note
  appendLine(join(dir, JOURNAL), line)
  const flow = { id, dir, definition: def }
  const snapshot = finish(root, flow, [line])
  return { id, line, snapshot, entered: entered(flow, line, snapshot)! }
}

export interface ApplySpec {
  event: string
  data: Record<string, unknown>
  by: string
  note?: string
  /** Compare-and-swap: refused if the journal has moved past this seq. */
  seq?: number
}

/** Which transition an event takes from where the flow is, or why none. */
export function decide(flow: Flow, spec: ApplySpec): Transition {
  const { definition: def, snapshot: s } = flow
  if (spec.seq !== undefined && spec.seq !== s.seq) throw new FlowError('conflict', `${flow.id} is at seq ${s.seq}, not ${spec.seq}; read it again`)
  if ((RESERVED_EVENTS as readonly string[]).includes(spec.event)) throw new UsageError(`${spec.event} is an event the journal writes itself`)
  if (s.terminal) throw new FlowError('refused', `${flow.id} is ${s.state}, which is terminal; nothing moves from there`)
  const from = candidates(def, s.state, spec.event)
  if (!from.length) {
    const legal = [...new Set(def.transitions.filter((t) => t.from === s.state).map((t) => t.on))]
    throw new FlowError('refused', `no transition on ${spec.event} from ${s.state} in ${def.name}; from ${s.state} the events are ${legal.join(', ')}`)
  }
  const t = matchTransition(def, s.state, spec.event, spec.data)
  if (!t) throw new FlowError('refused', `${spec.event} from ${s.state} matches no transition with data ${JSON.stringify(spec.data)}; the transitions want ${from.map((c) => JSON.stringify(c.when)).join(' or ')}`)
  if (t.by && !t.by.includes(spec.by)) throw new FlowError('refused', `${spec.by} may not take ${s.state} → ${t.to} on ${spec.event}; the definition allows ${t.by.join(', ')}`)
  return t
}

/** A line written, and what its action needs when it entered a state. */
export interface Applied {
  line: Line
  entered: Entered | null
}

/** Record an event: the transition it takes, appended under the lock. */
export function applyEvent(root: string, id: string, spec: ApplySpec, now: Date, trusted = false): Applied {
  if (!trusted) checkBy(spec.by)
  mustExist(root, id)
  return withFlowLock(flowDir(root, id), () => {
    const flow = mustLoad(root, id)
    const t = decide(flow, spec)
    const line: Line = { seq: flow.snapshot.seq + 1, at: now.toISOString(), event: spec.event, from: flow.snapshot.state, to: t.to, by: spec.by, data: spec.data }
    if (spec.note) line.note = spec.note
    appendLine(join(flow.dir, JOURNAL), line)
    const snapshot = finish(root, flow, [...flow.lines, line])
    return { line, entered: entered(flow, line, snapshot) }
  })
}

export interface LinkSpec {
  links?: Record<string, string>
  waitsOn?: string[]
}

/** Add links after the start; no state changes. Null when there was nothing new to record. */
export function applyLink(root: string, id: string, spec: LinkSpec, by: string, now: Date, note?: string): Line | null {
  checkBy(by)
  mustExist(root, id)
  return withFlowLock(flowDir(root, id), () => {
    const flow = mustLoad(root, id)
    const s = flow.snapshot
    const data: Record<string, unknown> = {}
    if (spec.links) {
      checkLinks(flow.definition, spec.links)
      const fresh = Object.fromEntries(Object.entries(spec.links).filter(([k, v]) => s.links[k] !== v))
      if (Object.keys(fresh).length) data['links'] = fresh
    }
    if (spec.waitsOn?.length) {
      checkTargets(root, spec.waitsOn)
      if (spec.waitsOn.includes(id)) throw new UsageError(`${id} cannot wait on itself`)
      const fresh = [...new Set(spec.waitsOn)].filter((w) => !s.waitsOn.includes(w))
      if (fresh.length) data['waitsOn'] = fresh
    }
    if (!Object.keys(data).length) return null
    const line: Line = { seq: s.seq + 1, at: now.toISOString(), event: 'link', from: s.state, to: s.state, by, data }
    if (note) line.note = note
    appendLine(join(flow.dir, JOURNAL), line)
    finish(root, flow, [...flow.lines, line])
    return line
  })
}

/** The heartbeat: an `after` counts from the later of the last transition and the last touch. */
export function touchFlow(root: string, id: string, now: Date): Snapshot {
  mustExist(root, id)
  return withFlowLock(flowDir(root, id), () => {
    const flow = mustLoad(root, id)
    writeTouch(flow.dir, now.toISOString())
    return finish(root, flow, flow.lines)
  })
}

/** Rewrite the views of one flow from its journal. */
export function refresh(root: string, id: string): Snapshot | null {
  const flow = loadFlow(root, id)
  return flow ? finish(root, flow, flow.lines) : null
}

/**
 * Replace a flow's pinned definition with `def`, under the flow's lock, and
 * rewrite its views. The caller has checked the flow is open and its current
 * state is one `def` knows; this only writes. Returns false when the pinned
 * text was already `def`'s and nothing was written.
 */
export function repinFlow(root: string, id: string, def: Definition): boolean {
  mustExist(root, id)
  return withFlowLock(flowDir(root, id), () => {
    const flow = mustLoad(root, id)
    if (flow.definition.text === def.text) return false
    writeAtomic(join(flow.dir, DEFINITION), def.text)
    finish(root, { id, dir: flow.dir, definition: def }, flow.lines)
    return true
  })
}

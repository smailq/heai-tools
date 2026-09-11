// The operations, over one state directory. The CLI is their one caller and
// holds nothing itself; every call reads the files. Every line that enters a
// state starts its action here, after the flow's lock and the settle lock are
// released, so a script that calls `flow advance` on the same flow never
// waits on the process that started it.

import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { loadDefinition, type Definition, type Hook } from './definition.ts'
import { UsageError, FlowError } from './errors.ts'
import type { Line, Snapshot } from './journal.ts'
import { loadConfig, type Config } from './config.ts'
import { applyEvent, applyLink, createFlow, listIds, loadFlow, openRoot, repinFlow, touchFlow, type ApplySpec, type Flow, type LinkSpec } from './core.ts'
import { readActions, runAction, type Action, type Entered } from './actions.ts'
import { settleLocked, withSettleLock } from './settle.ts'
import { collect, startSet, stuck as stuckReport, timeline, type Flows, type StuckEntry, type TraceLine } from './trace.ts'
import { check as checkRoot, reindex as reindexRoot, type Problem } from './check.ts'

export type { Definition, Hook, Line, Snapshot, Flow, Action, Problem, StuckEntry, TraceLine, ApplySpec, LinkSpec }
export { UsageError, FlowError }

export interface RegisteredDefinition {
  name: string
  path: string
  definition: Definition | null
  /** Why it could not be read, when it could not. */
  problem: string | null
}

export interface StartOptions {
  /** A definition name, found under the flows directory by the name it declares; or a path, when it has a slash or a .yaml ending. */
  definition: string
  definitionPath?: string
  id?: string
  links?: Record<string, string>
  waitsOn?: string[]
  by: string
  note?: string
}

export interface ListFilter {
  definition?: string
  state?: string
  link?: { name: string; value: string }
}

export interface Repin {
  /** Flows whose pinned copy was rewritten. */
  repinned: string[]
  /** Open flows whose pinned copy already matched the definition on disk. */
  current: string[]
}

export interface StoreOptions {
  dir: string
  configPath: string
  /** The project directory, where an action script runs; default: the directory holding the configuration. */
  project?: string
  /** The clock, injectable so `after` can be tested. */
  now?: () => Date
}

export interface Store {
  dir: string
  configPath: string
  project: string
  /** The directory the definitions are scanned from. */
  flowsDir(): string
  now(): Date
  config(): Config
  /** Every definition file in the directory, in path order, with its problem when it does not read. */
  definitions(): RegisteredDefinition[]
  resolveDefinition(ref: string, path?: string): Definition
  start(opts: StartOptions): { id: string; line: Line; snapshot: Snapshot }
  advance(id: string, spec: ApplySpec): Line
  touch(id: string): Snapshot
  link(id: string, spec: LinkSpec, by: string, note?: string): Line | null
  /** A fresh projection, or null; never the snapshot file. */
  get(id: string): Snapshot | null
  show(id: string): Flow & { actions: Action[] }
  list(filter?: ListFilter): Snapshot[]
  trace(target: string): { flows: Snapshot[]; lines: TraceLine[] }
  stuck(olderMs: number): StuckEntry[]
  /** Runs one settle pass; empty when another settler held the lock. Actions start once the lock is released. */
  settle(): string[]
  /** Reports the views as they are; runs no action. */
  check(): Problem[]
  /** Rebuilds the views; runs no action. */
  reindex(): number
  /**
   * Rewrite every open flow's pinned definition from the directory's current
   * one of the same name. All or nothing: a flow whose definition is not
   * there, or does not validate, is a UsageError; one whose current
   * state the new definition does not know is a refusal; either writes nothing.
   */
  repin(): Repin
  /** Lines this process writes, as it writes them. */
  subscribe(fn: (line: Line & { id: string }) => void): () => void
}

export function openStore(options: StoreOptions): Store {
  const root = openRoot(options.dir)
  const configPath = resolve(options.configPath)
  const project = resolve(options.project ?? dirname(configPath))
  const now = options.now ?? (() => new Date())
  const subscribers = new Set<(line: Line & { id: string }) => void>()
  const emit = (id: string, line: Line) => {
    for (const fn of subscribers) fn({ id, ...line })
  }

  const config = () => loadConfig(configPath)
  /** Start the action for a line that entered a state. Called only once every lock is released. */
  const act = (e: Entered | null) => {
    if (e) runAction(e, { project, now: now() })
  }

  const flowsDir = () => config().flows ?? join(project, 'flows')

  const read = (path: string): RegisteredDefinition => {
    try {
      const definition = loadDefinition(path)
      return { name: definition.name, path, definition, problem: null }
    } catch (e) {
      return { name: basename(path).replace(/\.ya?ml$/, ''), path, definition: null, problem: (e as Error).message }
    }
  }

  /** Every definition file in the directory, then a problem on each whose name another file already declared. */
  const definitions = (): RegisteredDefinition[] => {
    const dir = flowsDir()
    if (!existsSync(dir)) return []
    const out = readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f) && !f.startsWith('.'))
      .sort()
      .map((f) => read(join(dir, f)))
    const seen = new Map<string, string>()
    for (const d of out) {
      if (!d.definition) continue
      const first = seen.get(d.name)
      if (first) {
        d.problem = `names itself ${d.name}, which ${first} already declares`
        d.definition = null
      } else seen.set(d.name, d.path)
    }
    return out
  }

  /** The readable definition of that name, by the name it declares; a UsageError naming the problem otherwise. */
  const byName = (name: string): Definition => {
    const all = definitions()
    const hit = all.find((d) => d.definition && d.name === name)
    if (hit?.definition) return hit.definition
    const broken = all.find((d) => d.problem && d.name === name)
    if (broken) throw new UsageError(`definition ${name} at ${broken.path}: ${broken.problem}`)
    const names = all.filter((d) => d.definition).map((d) => d.name)
    throw new UsageError(`no definition ${name} in ${flowsDir()}${names.length ? `; found: ${names.join(', ')}` : ''}. Give a path with --definition`)
  }

  const resolveDefinition = (ref: string, path?: string): Definition => {
    if (path) return loadDefinition(resolve(path))
    if (ref.includes('/') || /\.ya?ml$/.test(ref)) return loadDefinition(resolve(ref))
    return byName(ref)
  }

  const flows: Flows = {
    all: () => list(),
    lines: (id) => loadFlow(root, id)?.lines ?? []
  }

  const settle = (): string[] => {
    const r = withSettleLock(root, () => settleLocked(root, now()))
    if (!r) return []
    for (const e of r.entered) act(e)
    return r.notes
  }

  function list(filter: ListFilter = {}): Snapshot[] {
    const out: Snapshot[] = []
    for (const id of listIds(root)) {
      const f = loadFlow(root, id)
      if (!f) continue
      const s = f.snapshot
      if (filter.definition && s.definition !== filter.definition) continue
      if (filter.state && s.state !== filter.state) continue
      if (filter.link) {
        const { name, value } = filter.link
        const has = name === 'waits-on' ? s.waitsOn.includes(value) : s.links[name] === value
        if (!has) continue
      }
      out.push(s)
    }
    return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  }

  return {
    dir: root,
    configPath,
    project,
    flowsDir,
    now,
    config,
    definitions,
    resolveDefinition,
    start(opts) {
      const definition = resolveDefinition(opts.definition, opts.definitionPath)
      const r = createFlow(root, { id: opts.id, definition, links: opts.links ?? {}, waitsOn: opts.waitsOn ?? [], by: opts.by, note: opts.note }, now())
      emit(r.id, r.line)
      act(r.entered)
      return { id: r.id, line: r.line, snapshot: r.snapshot }
    },
    advance(id, spec) {
      const { line, entered } = applyEvent(root, id, spec, now())
      emit(id, line)
      act(entered)
      return line
    },
    touch: (id) => touchFlow(root, id, now()),
    link(id, spec, by, note) {
      const line = applyLink(root, id, spec, by, now(), note)
      if (line) emit(id, line)
      return line
    },
    get: (id) => loadFlow(root, id)?.snapshot ?? null,
    show(id) {
      const f = loadFlow(root, id)
      if (!f) throw new FlowError('not-found', `no flow ${id}`)
      return { ...f, actions: readActions(f.dir) }
    },
    list,
    trace(target) {
      const start = startSet(flows, target)
      if (!start.length) throw new FlowError('not-found', target.includes('=') ? `no flow is about ${target}` : `no flow ${target}`)
      const set = collect(flows, start)
      return { flows: set, lines: timeline(flows, set) }
    },
    stuck: (olderMs) => stuckReport(flows, olderMs, now()),
    settle,
    check: () => checkRoot(root),
    reindex: () => reindexRoot(root),
    repin() {
      const onDisk = new Map(definitions().map((d) => [d.name, d]))
      const loaded = new Map<string, Definition>()
      const unaskable: string[] = []
      const refused: string[] = []
      const plan: { id: string; def: Definition }[] = []
      for (const id of listIds(root)) {
        const f = loadFlow(root, id)
        if (!f || f.snapshot.terminal) continue
        const name = f.definition.name
        let def = loaded.get(name)
        if (!def) {
          const d = onDisk.get(name)
          if (!d) {
            unaskable.push(`${id}: definition ${name} is not in ${flowsDir()}`)
            continue
          }
          if (!d.definition) {
            unaskable.push(`${id}: definition ${name} at ${d.path}: ${d.problem}`)
            continue
          }
          def = d.definition
          loaded.set(name, def)
        }
        if (!def.states.includes(f.snapshot.state)) {
          refused.push(`${id}: is ${f.snapshot.state}, which ${name} at ${onDisk.get(name)!.path} no longer has`)
          continue
        }
        plan.push({ id, def })
      }
      if (unaskable.length) throw new UsageError(`cannot repin; nothing was written:\n${unaskable.map((p) => `  - ${p}`).join('\n')}`)
      if (refused.length) throw new FlowError('refused', `repin would leave a flow in a state its definition does not know; nothing was written:\n${refused.map((p) => `  - ${p}`).join('\n')}`)
      const out: Repin = { repinned: [], current: [] }
      for (const { id, def } of plan) (repinFlow(root, id, def) ? out.repinned : out.current).push(id)
      return out
    },
    subscribe(fn) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    }
  }
}

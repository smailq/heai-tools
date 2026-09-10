// The graph: parent, waits-on and the shared things flows are about. `trace`
// walks it from one flow or one link value and prints one timeline; `stuck`
// lists what nothing has touched in a while and what each waits on.

import type { Line, Snapshot } from './journal.ts'

export interface Flows {
  all(): Snapshot[]
  lines(id: string): Line[]
}

export interface TraceLine extends Line {
  id: string
  definition: string
}

/** Every flow reachable from the start set over parent, child and waits-on links, in both directions. */
export function collect(flows: Flows, start: Snapshot[]): Snapshot[] {
  const all = flows.all()
  const byId = new Map(all.map((s) => [s.id, s]))
  const set = new Map(start.map((s) => [s.id, s]))
  for (let grew = true; grew; ) {
    grew = false
    for (const s of [...set.values()]) {
      for (const other of [s.parent, ...s.waitsOn]) {
        const o = other ? byId.get(other) : undefined
        if (o && !set.has(o.id)) {
          set.set(o.id, o)
          grew = true
        }
      }
    }
    for (const o of all) {
      if (set.has(o.id)) continue
      if ((o.parent && set.has(o.parent)) || o.waitsOn.some((w) => set.has(w))) {
        set.set(o.id, o)
        grew = true
      }
    }
  }
  return [...set.values()]
}

/** The start set for a target: one id, or `name=value` for everything about that thing. */
export function startSet(flows: Flows, target: string): Snapshot[] {
  const eq = target.indexOf('=')
  if (eq > 0) {
    const name = target.slice(0, eq)
    const value = target.slice(eq + 1)
    return flows.all().filter((s) => (name === 'parent' ? s.parent === value : name === 'waits-on' ? s.waitsOn.includes(value) : s.links[name] === value))
  }
  return flows.all().filter((s) => s.id === target)
}

/** One timeline across every flow in the set, in time order. */
export function timeline(flows: Flows, set: Snapshot[]): TraceLine[] {
  const out: TraceLine[] = []
  for (const s of set) for (const l of flows.lines(s.id)) out.push({ id: s.id, definition: s.definition, ...l })
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : a.seq - b.seq))
}

export interface StuckEntry {
  flow: Snapshot
  /** How long since the last transition or touch, in ms. */
  idleMs: number
  waits: { id: string; state: string | null }[]
}

export function stuck(flows: Flows, olderMs: number, now: Date): StuckEntry[] {
  const all = flows.all()
  const byId = new Map(all.map((s) => [s.id, s]))
  const out: StuckEntry[] = []
  for (const s of all) {
    if (s.terminal) continue
    const last = Math.max(Date.parse(s.since), s.touchedAt ? Date.parse(s.touchedAt) : 0)
    const idleMs = now.getTime() - last
    if (idleMs < olderMs) continue
    out.push({ flow: s, idleMs, waits: s.waitsOn.map((w) => ({ id: w, state: byId.get(w)?.state ?? null })) })
  }
  return out.sort((a, b) => (a.flow.definition < b.flow.definition ? -1 : a.flow.definition > b.flow.definition ? 1 : a.flow.state < b.flow.state ? -1 : a.flow.state > b.flow.state ? 1 : b.idleMs - a.idleMs))
}

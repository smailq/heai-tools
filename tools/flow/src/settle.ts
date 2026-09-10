// Settling: the level-triggered, idempotent catch-up every command runs
// first. It lets the clock expire states, fires the guards that now hold,
// and rebuilds any view behind its journal. It reads only files and asks
// the world nothing.

import { mkdirSync, rmdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { formatDuration, type Transition } from './definition.ts'
import { readSnapshot } from './journal.ts'
import { updateIndex } from './index.ts'
import { applyEvent, listIds, loadFlow, refresh, type Flow } from './core.ts'
import type { Entered } from './actions.ts'

const LOCK_STALE_MS = 60_000

/** Two settlers at once are serialized by an atomic mkdir; the second one gets null and moves on. */
export function withSettleLock<T>(root: string, fn: () => T): T | null {
  const lock = join(root, 'settle.lock')
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

const idleSince = (flow: Flow): number => Math.max(Date.parse(flow.snapshot.since), flow.snapshot.touchedAt ? Date.parse(flow.snapshot.touchedAt) : 0)

/** Whether a guard holds: the flow waits on at least one flow, and every one is in an allowed state. */
export function guardHolds(t: Transition, flow: Flow, load: (id: string) => Flow | null): boolean {
  if (!t.requires || !flow.snapshot.waitsOn.length) return false
  return flow.snapshot.waitsOn.every((w) => {
    const other = load(w)
    return other !== null && t.requires!.waitsOn.all.includes(other.snapshot.state)
  })
}

export interface Settled {
  /** What moved, one note each. */
  notes: string[]
  /** The lines that entered a state, for the actions the store starts once the lock is released. */
  entered: Entered[]
}

/** One pass; the notes say what moved. Must be called under the settle lock, and starts nothing itself. */
export function settleLocked(root: string, now: Date): Settled {
  const notes: string[] = []
  const entered: Entered[] = []
  const apply = (id: string, spec: Parameters<typeof applyEvent>[2]) => {
    const r = applyEvent(root, id, spec, now, true)
    if (r.entered) entered.push(r.entered)
    return r.line
  }
  const ids = listIds(root)
  const load = (id: string) => loadFlow(root, id)

  // 1. The clock: a state that has outlived an `after` with no touch in between moves.
  for (const id of ids) {
    const flow = load(id)
    if (!flow || flow.snapshot.terminal) continue
    const idle = now.getTime() - idleSince(flow)
    const t = flow.definition.transitions.find((x) => x.from === flow.snapshot.state && x.after !== null && idle >= x.after!)
    if (!t) continue
    const line = apply(id, { event: t.on, data: {}, by: 'flow', note: `${flow.snapshot.state} for ${formatDuration(t.after!)} with no touch` })
    notes.push(`${id}: ${line.from} → ${line.to} after ${formatDuration(t.after!)}`)
  }

  // 2. Guards, until nothing more fires: one flow reaching a state can release another.
  for (let moved = true, rounds = 0; moved && rounds <= ids.length; rounds++) {
    moved = false
    for (const id of ids) {
      const flow = load(id)
      if (!flow || flow.snapshot.terminal) continue
      const t = flow.definition.transitions.find((x) => x.from === flow.snapshot.state && x.requires !== null && guardHolds(x, flow, load))
      if (!t) continue
      const states = flow.snapshot.waitsOn.map((w) => `${w}:${load(w)?.snapshot.state ?? '?'}`)
      const line = apply(id, { event: t.on, data: {}, by: 'flow', note: `waits-on all ${t.requires!.waitsOn.all.join('|')}: ${states.join(', ')}` })
      notes.push(`${id}: ${line.from} → ${line.to}, ${states.join(', ')}`)
      moved = true
    }
  }

  // 3. Views: any snapshot behind its journal is rewritten, and its index entries with it.
  for (const id of ids) {
    const flow = load(id)
    if (!flow) continue
    const file = readSnapshot(flow.dir)
    if (!file || file.seq !== flow.snapshot.seq || file.state !== flow.snapshot.state || file.touchedAt !== flow.snapshot.touchedAt) {
      refresh(root, id)
      if (file && file.seq !== flow.snapshot.seq) notes.push(`${id}: snapshot rebuilt from seq ${file.seq} to ${flow.snapshot.seq}`)
    } else updateIndex(root, flow.snapshot)
  }
  return { notes, entered }
}

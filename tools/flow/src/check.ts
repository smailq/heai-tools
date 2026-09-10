// `check`: re-derive everything from the journals and say where the views
// disagree. `reindex`: rebuild them. A missing or torn view is never an
// error a reader sees, only a rebuild; check exists so drift is found on
// purpose rather than by accident.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { candidates, parseDefinition, type Definition } from './definition.ts'
import { DEFINITION, JOURNAL, project, readJournal, readSnapshot, readTouch, type Line, type Snapshot } from './journal.ts'
import { indexProblems, rebuildIndexes } from './index.ts'
import { flowDir, listIds, refresh } from './core.ts'

export interface Problem {
  id: string | null
  message: string
}

/** Replay a journal against its definition: every line legal from where the one before left it. */
export function replayProblems(def: Definition, lines: Line[]): string[] {
  const problems: string[] = []
  let state: string | null = null
  lines.forEach((l, i) => {
    if (l.seq !== i) problems.push(`journal line ${i + 1} has seq ${l.seq}, expected ${i}`)
    if (i === 0) {
      if (l.event !== 'start' || l.from !== null || l.to !== def.initial) problems.push(`journal line 1 is not a start into ${def.initial}`)
      state = l.to
      return
    }
    if (l.from !== state) problems.push(`journal line ${i + 1} leaves ${l.from}, but the flow was ${state}`)
    if (l.event === 'link') {
      if (l.to !== l.from) problems.push(`journal line ${i + 1} is a link that changes state`)
      return
    }
    if (l.event === 'start') problems.push(`journal line ${i + 1} is a second start`)
    else if (!candidates(def, l.from ?? '', l.event).some((t) => t.to === l.to)) problems.push(`journal line ${i + 1}: ${def.name} has no ${l.from} → ${l.to} on ${l.event}`)
    state = l.to
  })
  return problems
}

export function check(root: string): Problem[] {
  const problems: Problem[] = []
  const snaps: Snapshot[] = []
  for (const id of listIds(root)) {
    const dir = flowDir(root, id)
    const add = (message: string) => problems.push({ id, message })
    if (!existsSync(join(dir, DEFINITION))) {
      add('has no definition.yaml')
      continue
    }
    let def: Definition
    try {
      def = parseDefinition(readFileSync(join(dir, DEFINITION), 'utf8'), 'definition.yaml')
    } catch (e) {
      add((e as Error).message)
      continue
    }
    const journal = readJournal(join(dir, JOURNAL))
    for (const p of journal.problems) add(p)
    for (const p of replayProblems(def, journal.lines)) add(p)
    const snap = project(id, def, journal.lines, readTouch(dir))
    if (!snap) {
      add('journal has no start line; the flow cannot be projected')
      continue
    }
    snaps.push(snap)
    const file = readSnapshot(dir)
    if (!file) add('state.json is missing or unreadable')
    else if (JSON.stringify(file) !== JSON.stringify(snap)) add(`state.json says ${file.state} at seq ${file.seq}; the journal says ${snap.state} at seq ${snap.seq}`)
  }
  for (const p of indexProblems(root, snaps)) problems.push({ id: null, message: p })
  return problems
}

/** Rebuild every snapshot and both indexes; returns how many flows were projected. */
export function reindex(root: string): number {
  const snaps: Snapshot[] = []
  for (const id of listIds(root)) {
    const s = refresh(root, id)
    if (s) snaps.push(s)
  }
  rebuildIndexes(root, snaps)
  return snaps.length
}

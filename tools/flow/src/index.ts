// The two directory indexes: by-state/<definition>/<state>/<id> and
// by-link/<name>/<value>/<id>, one empty file each, so `ls` answers "what
// is running" and "what is about task X" with nothing installed. Both are
// regenerated from the journals; nothing reads them as truth.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Snapshot } from './journal.ts'

export const BY_STATE = 'by-state'
export const BY_LINK = 'by-link'

const safe = (b: number): boolean =>
  (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2e || b === 0x5f || b === 0x2d

/**
 * A link value as a directory name: letters, digits, `.`, `_` and `-` stay
 * and every other byte is `%XX`, so `cache-the-index` is itself and
 * `agent/alpha/x` is `agent%2Falpha%2Fx`. A leading dot is encoded so no
 * value becomes `.` or `..`.
 */
export function encodeValue(v: string): string {
  return [...Buffer.from(v, 'utf8')]
    .map((b, i) => (safe(b) && !(i === 0 && b === 0x2e) ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0')))
    .join('')
}

export function decodeValue(s: string): string {
  return Buffer.from(
    s.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16))),
    'latin1'
  ).toString('utf8')
}

/** Every (name, value) pair a flow is indexed under: its `about` links, its parent, and what it waits on. */
export function linkEntries(s: Snapshot): [name: string, value: string][] {
  const out: [string, string][] = Object.entries(s.links)
  if (s.parent) out.push(['parent', s.parent])
  for (const w of s.waitsOn) out.push(['waits-on', w])
  return out
}

const touchFile = (p: string): void => {
  if (!existsSync(p)) writeFileSync(p, '')
}
const dirs = (p: string): string[] => (existsSync(p) ? readdirSync(p).filter((n) => !n.startsWith('.') && statSync(join(p, n)).isDirectory()) : [])

/** Make the indexes say exactly what this snapshot says, and nothing else about this flow. */
export function updateIndex(root: string, s: Snapshot): void {
  const defDir = join(root, BY_STATE, s.definition)
  mkdirSync(join(defDir, s.state), { recursive: true })
  for (const st of dirs(defDir)) if (st !== s.state) rmSync(join(defDir, st, s.id), { force: true })
  touchFile(join(defDir, s.state, s.id))

  const wanted = linkEntries(s)
  for (const name of new Set(wanted.map(([n]) => n))) {
    const nameDir = join(root, BY_LINK, name)
    const values = new Set(wanted.filter(([n]) => n === name).map(([, v]) => encodeValue(v)))
    for (const v of dirs(nameDir)) if (!values.has(v)) rmSync(join(nameDir, v, s.id), { force: true })
    for (const v of values) {
      mkdirSync(join(nameDir, v), { recursive: true })
      touchFile(join(nameDir, v, s.id))
    }
  }
}

export function rebuildIndexes(root: string, snaps: Snapshot[]): void {
  rmSync(join(root, BY_STATE), { recursive: true, force: true })
  rmSync(join(root, BY_LINK), { recursive: true, force: true })
  mkdirSync(join(root, BY_STATE), { recursive: true })
  mkdirSync(join(root, BY_LINK), { recursive: true })
  for (const s of snaps) updateIndex(root, s)
}

/** Entries the snapshots call for but the directories lack, and entries the directories hold for nothing. */
export function indexProblems(root: string, snaps: Snapshot[]): string[] {
  const expected = new Set<string>()
  for (const s of snaps) {
    expected.add(`${BY_STATE}/${s.definition}/${s.state}/${s.id}`)
    for (const [n, v] of linkEntries(s)) expected.add(`${BY_LINK}/${n}/${encodeValue(v)}/${s.id}`)
  }
  const found = new Set<string>()
  for (const top of [BY_STATE, BY_LINK])
    for (const a of dirs(join(root, top)))
      for (const b of dirs(join(root, top, a)))
        for (const id of readdirSync(join(root, top, a, b))) if (!id.startsWith('.')) found.add(`${top}/${a}/${b}/${id}`)
  const problems: string[] = []
  for (const e of expected) if (!found.has(e)) problems.push(`missing index entry ${e}`)
  for (const f of found) if (!expected.has(f)) problems.push(`stray index entry ${f}`)
  return problems.sort()
}

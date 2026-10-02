// Who owns each territory, and which repositories the map declares - asked of
// architect, never read from the map, so this tool holds no map reader or glob
// dialect of its own.

import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { message, run, which } from './run.ts'

export interface Owners {
  owners: Record<string, string>
  repos: string[]
  /** Why owners is empty: architect missing, no map, or the command's last line. */
  note: string
  /** The map's mtime when it was asked, so it is asked again only when the map moves. */
  mapMtime: number
}

export async function resolveOwners(mapPath: string): Promise<Owners> {
  const r: Owners = { owners: {}, repos: [], note: '', mapMtime: 0 }
  if (!mapPath) return { ...r, note: 'no map configured' }
  try {
    r.mapMtime = statSync(mapPath).mtimeMs
  } catch {
    return { ...r, note: `map not found: ${basename(mapPath)}` }
  }
  const bin = which('heai-architect')
  if (!bin) return { ...r, note: 'heai-architect not on PATH' }
  try {
    r.owners = parseTerritories(await run(bin, ['territories', '--json', '--map', mapPath], { name: 'architect' }))
  } catch (e) {
    return { ...r, note: message(e) }
  }
  // The repositories ride on the validator's own output; a failure here costs their names and nothing else.
  try {
    r.repos = parseRepositories(await run(bin, ['check', '--format', 'json', '--map', mapPath], { name: 'architect', exit1OK: true }))
  } catch {
    // keep the owners
  }
  return r
}

export function parseTerritories(raw: string): Record<string, string> {
  const list = JSON.parse(raw) as Array<{ name: string; owner: string }>
  return Object.fromEntries(list.map((t) => [t.name, t.owner]))
}

/** The keys of the map's repositories, in the map's order; `map` is present only when the map validates. */
export function parseRepositories(raw: string): string[] {
  const doc = JSON.parse(raw) as { map?: { repositories?: Record<string, unknown> } }
  return Object.keys(doc.map?.repositories ?? {})
}

/** The actors a task's territories route to: unique, in order, "?" for an undeclared territory. */
export function routesTo(owners: Record<string, string>, territories: string[]): string {
  return [...new Set(territories.map((t) => owners[t] ?? '?'))].join(',')
}

// The territories the map declares - asked of architect, never read from the
// map, so this tool holds no map reader or glob dialect of its own.

import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { message, run, which } from './run.ts'

export interface Territories {
  /** The territory names, in the map's order. */
  names: string[]
  /** Why names is empty: architect missing, no map, or the command's last line. */
  note: string
  /** The map's mtime when it was asked, so it is asked again only when the map moves. */
  mapMtime: number
}

export const emptyTerritories = (): Territories => ({ names: [], note: '', mapMtime: 0 })

export async function resolveTerritories(mapPath: string): Promise<Territories> {
  const r = emptyTerritories()
  if (!mapPath) return { ...r, note: 'no map configured' }
  try {
    r.mapMtime = statSync(mapPath).mtimeMs
  } catch {
    return { ...r, note: `map not found: ${basename(mapPath)}` }
  }
  const bin = which('heai-architect')
  if (!bin) return { ...r, note: 'heai-architect not on PATH' }
  try {
    r.names = parseTerritories(await run(bin, ['territories', '--json', '--map', mapPath], { name: 'architect' }))
  } catch (e) {
    return { ...r, note: message(e) }
  }
  return r
}

/** The names from `heai-architect territories --json`: objects with name, parent, globs, dependsOn, hasContext. */
export function parseTerritories(raw: string): string[] {
  const list = JSON.parse(raw) as Array<{ name: string }>
  return list.map((t) => t.name)
}

// The map queries other tools keep re-implementing: which territory claims a
// path, what the map declares, and what context a territory carries. All of
// them run over a validated map, so an answer is never given for a map that
// does not hold.

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UsageError } from './errors.ts'
import { claims, createValidator, type ArchitectureMap, type Territory, type ValidationResult } from './validate.ts'

const here = fileURLToPath(new URL('.', import.meta.url))

/** The schema shipped with this tool, in schemas/. */
export const DEFAULT_SCHEMA = join(here, '..', 'schemas', 'architecture.schema.json')

/**
 * Where the map is: `given` when the caller names one, else `HEAI_MAP`, else
 * `architecture.yaml` in the project directory `HEAI_DIR` names, else
 * `.heai/architecture.yaml` if it exists, else `architecture.yaml`, from `cwd`.
 */
export function resolveMapPath(given: string | undefined, cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  if (given) return resolve(cwd, given)
  if (env['HEAI_MAP']) return resolve(cwd, env['HEAI_MAP'])
  if (env['HEAI_DIR']) return resolve(cwd, env['HEAI_DIR'], 'architecture.yaml')
  const conventional = resolve(cwd, '.heai', 'architecture.yaml')
  return existsSync(conventional) ? conventional : resolve(cwd, 'architecture.yaml')
}

export interface LoadedMap {
  path: string
  result: ValidationResult
}

/** Read and validate a map file. Throws `UsageError` when the file or the schema cannot be read. */
export function loadMap(mapPath: string, schemaPath: string = DEFAULT_SCHEMA): LoadedMap {
  if (!existsSync(schemaPath)) throw new UsageError(`cannot read schema: ${schemaPath}`)
  let text: string
  try {
    text = readFileSync(mapPath, 'utf8')
  } catch {
    throw new UsageError(`cannot read architecture map: ${mapPath}`)
  }
  const validator = createValidator(schemaPath)
  return { path: mapPath, result: validator.validate(text) }
}

export interface TerritoryAnswer {
  path: string
  repository: string
  /** The territory whose effective scope holds the path, or null when none does. */
  territory: string | null
}

/** The one repository a map governs, or the named one; null when the name is needed and missing. */
function pickRepository(map: ArchitectureMap, repository?: string): string | null {
  if (repository) return repository in map.repositories ? repository : null
  const names = Object.keys(map.repositories)
  return names.length === 1 ? names[0]! : null
}

/**
 * Which territory's effective scope holds a path. A valid map has no overlaps,
 * so at most one territory answers.
 */
export function territoryOf(map: ArchitectureMap, path: string, repository?: string): TerritoryAnswer {
  const repo = pickRepository(map, repository)
  if (repo === null) {
    const names = Object.keys(map.repositories)
    throw new UsageError(
      repository
        ? `no repository named "${repository}" in the map`
        : `the map governs ${names.length} repositories (${names.join(', ')}); name one with --repo`
    )
  }
  const normalized = path.replace(/^\.\//, '').replace(/^\/+/, '')
  for (const name of Object.keys(map.territories)) {
    if (claims(map, repo, name, normalized)) return { path: normalized, repository: repo, territory: name }
  }
  return { path: normalized, repository: repo, territory: null }
}

export interface TerritoryView {
  name: string
  parent: string | null
  globs: { repository: string; globs: string[] }[]
  dependsOn: string[]
  hasContext: boolean
}

export function territoriesView(map: ArchitectureMap): TerritoryView[] {
  return Object.entries(map.territories).map(([name, t]) => ({
    name,
    parent: t.parent ?? null,
    globs: (t.scope ?? []).map((e) => ({ repository: e.repository, globs: [...(e.globs ?? [])] })),
    dependsOn: [...(t.dependsOn ?? [])],
    hasContext: Boolean(t.context)
  }))
}

export interface ContextLayer {
  /** `territory:<name>`. */
  from: string
  context: string
}

/**
 * A territory's context chain: ancestors outermost first, then its own; empty
 * contexts skipped. This is what anyone working or judging in the territory is
 * given; who that is, and what else they are prompted with, is the process's.
 */
export function contextChain(map: ArchitectureMap, territory: string): ContextLayer[] {
  if (!(territory in map.territories)) throw new UsageError(`no territory named "${territory}" in the map`)
  const chain: ContextLayer[] = []
  const seen = new Set<string>()
  let cur: string | undefined = territory
  while (cur !== undefined && !seen.has(cur) && cur in map.territories) {
    seen.add(cur)
    const t: Territory = map.territories[cur]!
    if (t.context) chain.unshift({ from: `territory:${cur}`, context: t.context })
    cur = t.parent
  }
  return chain
}

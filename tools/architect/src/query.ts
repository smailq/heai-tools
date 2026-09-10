// The map queries other tools keep re-implementing: which territory claims a
// path and who owns it, what the map declares, and what context an actor is
// composed with. All of them run over a validated map, so an answer is never
// given for a map that does not hold.

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UsageError } from './errors.ts'
import { claims, createValidator, effectiveOwner, type ArchitectureMap, type Territory, type ValidationResult } from './validate.ts'

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

export interface OwnerAnswer {
  path: string
  repository: string
  territory: string | null
  owner: string | null
  ownerType: string | null
}

/** The one repository a map governs, or the named one; null when the name is needed and missing. */
function pickRepository(map: ArchitectureMap, repository?: string): string | null {
  if (repository) return repository in map.repositories ? repository : null
  const names = Object.keys(map.repositories)
  return names.length === 1 ? names[0]! : null
}

/**
 * Which territory's effective scope holds a path, and who owns it. A valid map
 * has no overlaps, so at most one territory answers.
 */
export function ownerOf(map: ArchitectureMap, path: string, repository?: string): OwnerAnswer {
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
    if (claims(map, repo, name, normalized)) {
      const owner = effectiveOwner(map, name)
      return { path: normalized, repository: repo, territory: name, owner, ownerType: owner ? (map.actors[owner]?.type ?? null) : null }
    }
  }
  return { path: normalized, repository: repo, territory: null, owner: null, ownerType: null }
}

export interface TerritoryView {
  name: string
  /** The owner resolved through the parent chain. */
  owner: string | null
  /** That owner's `type`, so a script can route without a second lookup. */
  ownerType: string | null
  declaredOwner: string | null
  parent: string | null
  globs: { repository: string; globs: string[] }[]
  dependsOn: string[]
  hasContext: boolean
}

export function territoriesView(map: ArchitectureMap, actor?: string): TerritoryView[] {
  return Object.entries(map.territories)
    .map(([name, t]) => {
      const owner = effectiveOwner(map, name)
      return {
        name,
        owner,
        ownerType: owner ? (map.actors[owner]?.type ?? null) : null,
        declaredOwner: t.owner ?? null,
        parent: t.parent ?? null,
        globs: (t.scope ?? []).map((e) => ({ repository: e.repository, globs: [...(e.globs ?? [])] })),
        dependsOn: [...(t.dependsOn ?? [])],
        hasContext: Boolean(t.context)
      }
    })
    .filter((t) => !actor || t.owner === actor)
}

export interface ActorView {
  name: string
  type: string
  identity: string | null
  owns: string[]
  watches: string[]
  hasContext: boolean
}

export function actorsView(map: ArchitectureMap): ActorView[] {
  const views = territoriesView(map)
  return Object.entries(map.actors).map(([name, a]) => ({
    name,
    type: a.type,
    identity: a.identity ?? null,
    owns: views.filter((t) => t.owner === name).map((t) => t.name),
    watches: [...(a.watches ?? [])],
    hasContext: Boolean(a.context)
  }))
}

export interface ContextLayer {
  /** `actor:<name>` or `territory:<name>`. */
  from: string
  context: string
}

/** A territory's context chain: ancestors outermost first, then its own; empty contexts skipped. */
export function contextChain(map: ArchitectureMap, territory: string): ContextLayer[] {
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

/**
 * Everything an actor is composed with: its own context, then each owned
 * territory's chain, then each watched territory's chain, marked as watched.
 */
export function actorContext(map: ArchitectureMap, actor: string): { own: ContextLayer[]; owned: { territory: string; layers: ContextLayer[] }[]; watched: { territory: string; owner: string | null; layers: ContextLayer[] }[] } {
  const a = map.actors[actor]
  if (!a) throw new UsageError(`no actor named "${actor}" in the map`)
  const owned = territoriesView(map, actor).map((t) => ({ territory: t.name, layers: contextChain(map, t.name) }))
  const watched = (a.watches ?? [])
    .filter((w) => w in map.territories && effectiveOwner(map, w) !== actor)
    .map((w) => ({ territory: w, owner: effectiveOwner(map, w), layers: contextChain(map, w) }))
  return { own: a.context ? [{ from: `actor:${actor}`, context: a.context }] : [], owned, watched }
}

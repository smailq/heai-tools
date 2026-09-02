import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { GlobError, matchesAny, validateGlob } from './glob.ts'

export type UnownedPosture = 'fail' | 'allow'
export type ActorType = 'human' | 'llm-agent'

export interface Exclusion {
  globs?: string[]
  territories?: string[]
}

export interface ScopeEntry {
  repository: string
  globs: string[]
  exclude?: Exclusion
}

export interface Territory {
  /** Required on a territory without a parent; a child may omit it and inherit. */
  owner?: string
  parent?: string
  scope: ScopeEntry[]
  dependsOn?: string[]
  context?: string
}

export interface Actor {
  type: ActorType
  identity?: string
  context?: string
}

export interface Repository {
  remotePath?: string
  unowned?: UnownedPosture
}

export interface ArchitectureMap {
  version: number
  actors: Record<string, Actor>
  repositories: Record<string, Repository>
  territories: Record<string, Territory>
  unowned?: UnownedPosture
}

/** A problem with the invocation or the map, as opposed to a boundary violation. */
export class UsageError extends Error {}

/**
 * Load a map. This deliberately does NOT re-implement the semantic validation
 * in `docs/architecture-map.md`; it checks only the shape it depends on and
 * leaves rule enforcement to the validator that owns those rules. A map that
 * passes the gate is not necessarily a valid map.
 */
export function loadMap(path: string): ArchitectureMap {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new UsageError(`cannot read map: ${path}`)
  }
  let doc: unknown
  try {
    doc = parse(text)
  } catch (e) {
    throw new UsageError(`map is not valid YAML: ${(e as Error).message}`)
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new UsageError(`map must be a mapping: ${path}`)
  }
  const map = doc as ArchitectureMap
  for (const section of ['actors', 'repositories', 'territories'] as const) {
    if (!map[section] || typeof map[section] !== 'object') {
      throw new UsageError(`map is missing an "${section}" section: ${path}`)
    }
  }
  if (map.version !== 1) {
    throw new UsageError(
      `map declares version ${JSON.stringify(map.version) ?? 'nothing'}; this tool reads version 1`
    )
  }
  return map
}

/** The posture in force for one repository: its own, else the map's, else fail-closed. */
export function unownedPosture(map: ArchitectureMap, repository: string): UnownedPosture {
  return map.repositories[repository]?.unowned ?? map.unowned ?? 'fail'
}

export function actorType(map: ArchitectureMap, name: string): ActorType | null {
  return map.actors[name]?.type ?? null
}

/** A territory's scope entries for one repository (a territory may span several). */
export function entriesFor(
  map: ArchitectureMap,
  repository: string,
  territory: string
): ScopeEntry[] {
  const t = map.territories[territory]
  if (!t) return []
  return (t.scope ?? []).filter((s) => s.repository === repository)
}

/**
 * Whether one scope entry subtracts a path.
 *
 * Subtraction by territory is not recursive: it removes the globs that
 * territory declares for this repository, not that territory's own exclusions.
 */
function excludes(
  map: ArchitectureMap,
  repository: string,
  entry: ScopeEntry,
  path: string
): boolean {
  const ex = entry.exclude
  if (!ex) return false
  if (matchesAny(path, ex.globs ?? [])) return true
  for (const name of ex.territories ?? []) {
    for (const other of entriesFor(map, repository, name)) {
      if (matchesAny(path, other.globs ?? [])) return true
    }
  }
  return false
}

/**
 * Whether a child territory's declared globs take a path out of this
 * territory's effective scope. Like exclusion by territory, the subtraction is
 * not recursive: the child's declared globs, not the child's own exclusions.
 */
function takenByChild(
  map: ArchitectureMap,
  repository: string,
  territory: string,
  path: string
): boolean {
  for (const [name, t] of Object.entries(map.territories)) {
    if (t.parent !== territory || name === territory) continue
    for (const entry of entriesFor(map, repository, name)) {
      if (matchesAny(path, entry.globs ?? [])) return true
    }
  }
  return false
}

/**
 * Whether a territory's effective scope holds a path: matched by a glob, minus
 * its exclusions, minus what its children carve out.
 */
export function claims(
  map: ArchitectureMap,
  repository: string,
  territory: string,
  path: string
): boolean {
  for (const entry of entriesFor(map, repository, territory)) {
    if (
      matchesAny(path, entry.globs ?? []) &&
      !excludes(map, repository, entry, path) &&
      !takenByChild(map, repository, territory, path)
    ) {
      return true
    }
  }
  return false
}

/**
 * A territory's owner: its own, else the nearest ancestor's. A chain that does
 * not resolve - an unknown parent, a parent cycle, or a root with no owner - is
 * a map problem, reported rather than guessed at.
 */
export function ownerOf(map: ArchitectureMap, territory: string): string {
  const seen = new Set<string>()
  let name = territory
  for (;;) {
    if (seen.has(name)) {
      throw new UsageError(`map is invalid: parent cycle through territory "${name}"`)
    }
    seen.add(name)
    const t = map.territories[name]
    if (!t) throw new UsageError(`map is invalid: unknown parent territory "${name}"`)
    if (t.owner) return t.owner
    if (!t.parent) {
      throw new UsageError(`map is invalid: territory "${name}" has neither owner nor parent`)
    }
    name = t.parent
  }
}

/**
 * Compile every glob the map uses for one repository, so a malformed glob is a
 * clean map error rather than a stack trace thrown mid-match - and one raised
 * whether or not a changed path happens to reach it.
 */
export function validateGlobs(map: ArchitectureMap, repository: string): void {
  const check = (globs: readonly string[] | undefined, where: string) => {
    for (const g of globs ?? []) {
      try {
        validateGlob(g)
      } catch (e) {
        if (e instanceof GlobError) throw new UsageError(`map is invalid: ${where}: ${e.message}`)
        throw e
      }
    }
  }
  for (const [name, t] of Object.entries(map.territories)) {
    for (const entry of t.scope ?? []) {
      if (entry.repository !== repository) continue
      check(entry.globs, `territories.${name}.scope`)
      check(entry.exclude?.globs, `territories.${name}.scope.exclude`)
    }
  }
}

/**
 * Every territory claiming a path. A valid map yields at most one: territories
 * do not overlap, and there is no precedence rule to break a tie. More than one
 * means the map is invalid, which the caller reports rather than guessing at.
 */
export function claimants(map: ArchitectureMap, repository: string, path: string): string[] {
  return Object.keys(map.territories).filter((t) => claims(map, repository, t, path))
}

export function territoriesOwnedBy(map: ArchitectureMap, owner: string): string[] {
  // Ownership resolves through the parent chain, so a child that declares no
  // owner belongs to the actor its nearest ancestor names.
  return Object.keys(map.territories).filter((name) => ownerOf(map, name) === owner)
}

export type SubjectKind = 'territory' | 'actor'

/** Who the change is attributed to, and what that lets them touch. */
export interface Subject {
  kind: SubjectKind
  name: string
  /** Territories this subject may change. */
  territories: string[]
  /** For a territory subject, who owns it. */
  owner?: string
}

export interface SubjectRequest {
  territory?: string | undefined
  actor?: string | undefined
  /** A bare name, resolved against both namespaces. */
  name?: string | undefined
}

export function resolveSubject(map: ArchitectureMap, req: SubjectRequest): Subject {
  const explicit = (
    [
      ['territory', req.territory],
      ['actor', req.actor]
    ] as [SubjectKind, string | undefined][]
  ).filter(([, v]) => v !== undefined) as [SubjectKind, string][]

  if (explicit.length > 1) throw new UsageError('give only one of --territory, --actor')
  if (explicit.length === 1) return build(map, explicit[0]![0], explicit[0]![1])
  if (!req.name) throw new UsageError('name the subject: --territory, --actor, or a bare name')

  const kinds: SubjectKind[] = []
  if (map.territories[req.name]) kinds.push('territory')
  if (map.actors[req.name]) kinds.push('actor')
  if (kinds.length === 0) {
    throw new UsageError(`"${req.name}" is not a territory or an actor in the map`)
  }
  if (kinds.length > 1) {
    throw new UsageError(
      `"${req.name}" is both a territory and an actor; disambiguate with --territory or --actor`
    )
  }
  return build(map, kinds[0]!, req.name)
}

function build(map: ArchitectureMap, kind: SubjectKind, name: string): Subject {
  if (kind === 'territory') {
    const t = map.territories[name]
    if (!t) throw new UsageError(`no territory named "${name}" in the map`)
    return { kind, name, territories: [name], owner: ownerOf(map, name) }
  }
  if (!map.actors[name]) throw new UsageError(`no actor named "${name}" in the map`)
  return { kind, name, territories: territoriesOwnedBy(map, name) }
}

/**
 * Which repository the diff came from. A single-repository map answers this on
 * its own; anything larger has to be told, since a diff carries no indication.
 */
export function resolveRepository(map: ArchitectureMap, requested?: string): string {
  const names = Object.keys(map.repositories)
  if (requested) {
    if (!map.repositories[requested]) {
      throw new UsageError(
        `no repository named "${requested}" in the map (declared: ${names.join(', ') || 'none'})`
      )
    }
    return requested
  }
  if (names.length === 1) return names[0]!
  throw new UsageError(
    `the map governs ${names.length} repositories (${names.join(', ')}); name the diff's repository with --repo`
  )
}

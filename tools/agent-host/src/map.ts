// What this tool reads out of an architecture map: the llm-agent actors, the
// territories each owns, and the contexts that steer them.
//
// Only the shape this tool depends on is checked. The map's own rules belong
// to the validators that own them (map-editor, scope-gate), so a map this
// reads is not thereby a valid map - but a map that cannot be read at all is
// an error, never a silent empty host.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { parse } from 'yaml'

/** A problem with the invocation or the configuration, not with a run. Exit 2. */
export class UsageError extends Error {}

export interface Actor {
  name: string
  type: string
  context: string
  identity: string | null
  /** Territories observed without being owned; grants nothing. */
  watches: string[]
}

export interface ScopeEntry {
  repository: string
  globs: string[]
}

export interface Territory {
  name: string
  /** The declared owner, or the nearest ancestor's. */
  owner: string | null
  parent: string | null
  scope: ScopeEntry[]
  context: string
}

export interface Repository {
  name: string
  localPath: string | null
}

export interface ArchitectureMap {
  /** Absolute path the map was read from. */
  path: string
  /** Short content hash, which is what a container is labelled with. */
  hash: string
  actors: Actor[]
  territories: Territory[]
  repositories: Repository[]
  actor(name: string): Actor | null
  territory(name: string): Territory | null
  /** The llm-agent actors, in declaration order: what the host hosts. */
  agents(): Actor[]
  /** Every territory an actor owns, in declaration order. */
  owned(actor: string): Territory[]
  /** Every territory an actor watches and does not own, in the actor's order; unknown names dropped. */
  watched(actor: string): Territory[]
  /** A territory's context chain: ancestors outermost first, then its own. Empty contexts are skipped. */
  contextChain(territory: string): { territory: string; context: string }[]
  /** The single governed repository's checkout, resolved against the map's directory. */
  repositoryRoot(): string
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** Read and shape a map. Throws `UsageError` for anything that makes the map unusable here. */
export function loadMap(path: string): ArchitectureMap {
  const abs = resolve(path)
  let text: string
  try {
    text = readFileSync(abs, 'utf8')
  } catch {
    throw new UsageError(`cannot read architecture map: ${abs}`)
  }
  let doc: unknown
  try {
    doc = parse(text)
  } catch (e) {
    throw new UsageError(`architecture map is not valid YAML: ${abs}: ${(e as Error).message}`)
  }
  if (!isRecord(doc)) throw new UsageError(`architecture map must be a mapping: ${abs}`)
  if (doc['version'] !== 1) throw new UsageError(`architecture map version must be 1: ${abs}`)
  for (const section of ['actors', 'repositories', 'territories']) {
    if (!isRecord(doc[section])) throw new UsageError(`architecture map has no "${section}" section: ${abs}`)
  }

  const actors: Actor[] = Object.entries(doc['actors'] as Record<string, unknown>).map(([name, raw]) => {
    const a = isRecord(raw) ? raw : {}
    return {
      name,
      type: str(a['type']) ?? '',
      context: str(a['context']) ?? '',
      identity: str(a['identity']),
      watches: (Array.isArray(a['watches']) ? a['watches'] : []).filter((w): w is string => typeof w === 'string')
    }
  })

  const repositories: Repository[] = Object.entries(doc['repositories'] as Record<string, unknown>).map(
    ([name, raw]) => ({ name, localPath: isRecord(raw) ? str(raw['localPath']) : null })
  )

  const rawTerritories = doc['territories'] as Record<string, unknown>
  const declared = new Map<string, Record<string, unknown>>()
  for (const [name, raw] of Object.entries(rawTerritories)) declared.set(name, isRecord(raw) ? raw : {})

  // An owner resolves through the parent chain: a child that declares none
  // belongs to the nearest ancestor that does. A broken chain resolves to no
  // owner, which is the validator's business.
  const ownerOf = (name: string): string | null => {
    const seen = new Set<string>()
    let cur: string | null = name
    while (cur !== null && !seen.has(cur) && declared.has(cur)) {
      seen.add(cur)
      const t = declared.get(cur)!
      const owner = str(t['owner'])
      if (owner) return owner
      cur = str(t['parent'])
    }
    return null
  }

  const territories: Territory[] = [...declared.entries()].map(([name, t]) => ({
    name,
    owner: ownerOf(name),
    parent: str(t['parent']),
    scope: (Array.isArray(t['scope']) ? t['scope'] : [])
      .filter(isRecord)
      .map((e) => ({
        repository: str(e['repository']) ?? '',
        globs: (Array.isArray(e['globs']) ? e['globs'] : []).filter((g): g is string => typeof g === 'string')
      })),
    context: str(t['context']) ?? ''
  }))

  const byActor = new Map(actors.map((a) => [a.name, a]))
  const byTerritory = new Map(territories.map((t) => [t.name, t]))

  return {
    path: abs,
    hash: createHash('sha256').update(text).digest('hex').slice(0, 8),
    actors,
    territories,
    repositories,
    actor: (name) => byActor.get(name) ?? null,
    territory: (name) => byTerritory.get(name) ?? null,
    agents: () => actors.filter((a) => a.type === 'llm-agent'),
    owned: (actor) => territories.filter((t) => t.owner === actor),
    watched: (actor) =>
      (byActor.get(actor)?.watches ?? [])
        .map((w) => byTerritory.get(w))
        .filter((t): t is Territory => t !== undefined && t.owner !== actor),
    contextChain(name) {
      const chain: { territory: string; context: string }[] = []
      const seen = new Set<string>()
      let cur: string | null = name
      while (cur !== null && !seen.has(cur)) {
        seen.add(cur)
        const t = byTerritory.get(cur)
        if (!t) break
        if (t.context) chain.unshift({ territory: t.name, context: t.context })
        cur = t.parent
      }
      return chain
    },
    repositoryRoot() {
      if (repositories.length !== 1) {
        throw new UsageError(
          `the map declares ${repositories.length} repositories; this tool hosts exactly one (${abs})`
        )
      }
      const repo = repositories[0]!
      const mapDir = dirname(abs)
      if (!repo.localPath) {
        // A map with no localPath is read where it lives: in .heai/ beside the
        // tree, or at the tree's root.
        return mapDir.endsWith('/.heai') ? dirname(mapDir) : mapDir
      }
      return isAbsolute(repo.localPath) ? repo.localPath : resolve(mapDir, repo.localPath)
    }
  }
}

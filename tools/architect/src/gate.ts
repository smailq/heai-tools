// The scope gate: every changed path classified against the territories the
// subject may change. It runs over the validated map like every other
// subcommand, and the checks it keeps on the map itself are assertions for a
// library caller that hands it an object the validator has not seen.

import { UsageError } from './errors.ts'
import { GlobError, validateGlob } from './glob.ts'
import {
  claims,
  effectiveOwner,
  entriesFor,
  unownedPosture,
  type ActorType,
  type ArchitectureMap,
  type UnownedPosture
} from './validate.ts'

export type Classification = 'owned' | 'foreign' | 'unowned'

export interface Finding {
  path: string
  classification: Classification
  /** The territory that owns the path, when one does. */
  territory: string | null
  /** That territory's owner. */
  owner: string | null
  /** The owner's declared type, for the report. */
  ownerType: ActorType | null
  /** Whether this finding fails the gate. */
  fatal: boolean
  note?: string
}

export interface GateResult {
  ok: boolean
  repository: string
  subject: Subject
  unownedPosture: UnownedPosture
  changedFiles: number
  findings: Finding[]
  violations: number
}

export interface GateInput {
  map: ArchitectureMap
  repository: string
  subject: Subject
  paths: readonly string[]
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

/**
 * A territory's owner through the parent chain. A validated map always
 * resolves one; an object that does not is a map problem, reported rather than
 * guessed at.
 */
function ownerOrThrow(map: ArchitectureMap, territory: string): string {
  const owner = effectiveOwner(map, territory)
  if (owner === null) {
    throw new UsageError(`map is invalid: territory "${territory}" resolves to no owner through its parent chain`)
  }
  return owner
}

/**
 * Every territory claiming a path. A valid map yields at most one: territories
 * do not overlap, and there is no precedence rule to break a tie.
 */
export function claimants(map: ArchitectureMap, repository: string, path: string): string[] {
  return Object.keys(map.territories).filter((t) => claims(map, repository, t, path))
}

export function territoriesOwnedBy(map: ArchitectureMap, owner: string): string[] {
  // Ownership resolves through the parent chain, so a child that declares no
  // owner belongs to the actor its nearest ancestor names.
  return Object.keys(map.territories).filter((name) => effectiveOwner(map, name) === owner)
}

/**
 * Compile every glob the map uses for one repository, so a malformed glob in an
 * unvalidated object is a clean usage error rather than a stack trace thrown
 * mid-match - and one raised whether or not a changed path happens to reach it.
 */
function validateGlobs(map: ArchitectureMap, repository: string): void {
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
    return { kind, name, territories: [name], owner: ownerOrThrow(map, name) }
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

/**
 * Classify every changed path against the territories the subject may change.
 *
 * Confinement is symmetric: a change fails when it reaches a path its actor
 * does not own, whoever that actor is. The map bounds every actor alike, so
 * there is no kind of subject that passes trivially.
 */
export function runGate({ map, repository, subject, paths }: GateInput): GateResult {
  validateGlobs(map, repository)
  const posture = unownedPosture(map, repository)
  const mine = new Set(subject.territories)

  const findings: Finding[] = []
  for (const path of paths) {
    const owners = claimants(map, repository, path)

    // Territories do not overlap and no precedence rule breaks a tie, so a
    // path claimed twice has no defined owner. The validator rejects such a
    // map before it gets here; for an object it never saw, guessing would be
    // a lie.
    if (owners.length > 1) {
      throw new UsageError(
        `map is invalid: "${path}" is claimed by ${owners.length} territories ` +
          `(${owners.join(', ')}); territories may not overlap`
      )
    }

    const territory = owners[0] ?? null
    if (!territory) {
      findings.push({
        path,
        classification: 'unowned',
        territory: null,
        owner: null,
        ownerType: null,
        fatal: posture === 'fail',
        ...(posture === 'allow'
          ? { note: "allowed by this repository's unowned posture" }
          : {})
      })
      continue
    }

    const owner = ownerOrThrow(map, territory)
    const ownerType = map.actors[owner]?.type ?? null
    findings.push({
      path,
      classification: mine.has(territory) ? 'owned' : 'foreign',
      territory,
      owner,
      ownerType,
      fatal: !mine.has(territory)
    })
  }

  const violations = findings.filter((f) => f.fatal).length
  return {
    ok: violations === 0,
    repository,
    subject,
    unownedPosture: posture,
    changedFiles: paths.length,
    findings,
    violations
  }
}

/** Every glob the subject may touch in this repository, for diagnostics. */
export function subjectGlobs(
  map: ArchitectureMap,
  repository: string,
  subject: Subject
): string[] {
  const globs = subject.territories.flatMap((t) => {
    // Exclusions and child carve-outs are noted rather than subtracted: this
    // is a hint, and silently advertising a subtracted path would mislead.
    const carved = Object.entries(map.territories).some(
      ([name, o]) => o.parent === t && name !== t && entriesFor(map, repository, name).length > 0
    )
    return entriesFor(map, repository, t).flatMap((e) =>
      (e.globs ?? []).map((g) => {
        const notes = [
          ...(e.exclude ? ['minus exclusions'] : []),
          ...(carved ? ['minus child territories'] : [])
        ]
        return notes.length ? `${g} (${notes.join(', ')})` : g
      })
    )
  })
  return [...new Set(globs)]
}

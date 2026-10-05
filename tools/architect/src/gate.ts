// The scope gate: every changed path classified against the territories a
// unit of work was scoped to. It runs over the validated map like every other
// subcommand, and the checks it keeps on the map itself are assertions for a
// library caller that hands it an object the validator has not seen.

import { UsageError } from './errors.ts'
import { GlobError, validateGlob } from './glob.ts'
import { claims, entriesFor, unownedPosture, type ArchitectureMap, type UnownedPosture } from './validate.ts'

export type Classification = 'inside' | 'outside' | 'unowned'

export interface Finding {
  path: string
  classification: Classification
  /** The territory that claims the path, when one does. */
  territory: string | null
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

/** What the change was scoped to: the territories it may touch. */
export interface Subject {
  territories: string[]
}

/**
 * Every territory claiming a path. A valid map yields at most one: territories
 * do not overlap, and there is no precedence rule to break a tie.
 */
export function claimants(map: ArchitectureMap, repository: string, path: string): string[] {
  return Object.keys(map.territories).filter((t) => claims(map, repository, t, path))
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

/**
 * The subject of a gate: one or more territories, each declared in the map. A
 * unit of work that crosses a boundary names every territory it was scoped
 * to, and the gate judges against their union.
 */
export function resolveSubject(map: ArchitectureMap, names: readonly string[]): Subject {
  const territories = [...new Set(names)]
  if (territories.length === 0) throw new UsageError('name the territory the change was scoped to')
  for (const name of territories) {
    if (!map.territories[name]) throw new UsageError(`no territory named "${name}" in the map`)
  }
  return { territories }
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
 * Classify every changed path against the territories the change was scoped
 * to. A path inside them passes; a path another territory claims fails; a path
 * no territory claims fails or passes by the repository's unowned posture. No
 * subject passes trivially: the scope is what the task declared, and nothing
 * widens it.
 */
export function runGate({ map, repository, subject, paths }: GateInput): GateResult {
  validateGlobs(map, repository)
  const posture = unownedPosture(map, repository)
  const mine = new Set(subject.territories)

  const findings: Finding[] = []
  for (const path of paths) {
    const claimed = claimants(map, repository, path)

    // Territories do not overlap and no precedence rule breaks a tie, so a
    // path claimed twice has no defined territory. The validator rejects such
    // a map before it gets here; for an object it never saw, guessing would be
    // a lie.
    if (claimed.length > 1) {
      throw new UsageError(
        `map is invalid: "${path}" is claimed by ${claimed.length} territories ` +
          `(${claimed.join(', ')}); territories may not overlap`
      )
    }

    const territory = claimed[0] ?? null
    if (!territory) {
      findings.push({
        path,
        classification: 'unowned',
        territory: null,
        fatal: posture === 'fail',
        ...(posture === 'allow' ? { note: "allowed by this repository's unowned posture" } : {})
      })
      continue
    }

    findings.push({
      path,
      classification: mine.has(territory) ? 'inside' : 'outside',
      territory,
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
export function subjectGlobs(map: ArchitectureMap, repository: string, subject: Subject): string[] {
  const globs = subject.territories.flatMap((t) => {
    // Exclusions and child carve-outs are noted rather than subtracted: this
    // is a hint, and silently advertising a subtracted path would mislead.
    const carved = Object.entries(map.territories).some(
      ([name, o]) => o.parent === t && name !== t && entriesFor(map, repository, name).length > 0
    )
    return entriesFor(map, repository, t).flatMap((e) =>
      (e.globs ?? []).map((g) => {
        const notes = [...(e.exclude ? ['minus exclusions'] : []), ...(carved ? ['minus child territories'] : [])]
        return notes.length ? `${g} (${notes.join(', ')})` : g
      })
    )
  })
  return [...new Set(globs)]
}

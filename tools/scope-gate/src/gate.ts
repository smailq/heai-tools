import {
  type ActorType,
  type ArchitectureMap,
  type Subject,
  type UnownedPosture,
  UsageError,
  claimants,
  entriesFor,
  ownerOf,
  unownedPosture,
  validateGlobs
} from './map.ts'

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
    // path claimed twice has no defined owner. Guessing would be a lie.
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

    const owner = ownerOf(map, territory)
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

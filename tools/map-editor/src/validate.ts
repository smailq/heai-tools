/**
 * Validation of an architecture map: the JSON Schema first, then the semantic
 * rules `docs/architecture-map.md` lists as "rules a validator must enforce
 * beyond JSON Schema".
 *
 * The editor validates on every keystroke, so this is the surface a human sees
 * while authoring: an error is something that makes the map wrong, a warning is
 * something worth looking at before it becomes wrong.
 */
import { readFileSync } from 'node:fs'
import { parse, stringify } from 'yaml'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { GlobError, contains, intersects, matchesAny, validateGlob } from './glob.ts'

export type UnownedPosture = 'fail' | 'allow'
export type UndeclaredPosture = 'fail' | 'warn'
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
  owner: string
  scope: ScopeEntry[]
  dependsOn?: string[]
  undeclaredDependencies?: UndeclaredPosture
  context?: string
}

export interface Actor {
  type: ActorType
  identity?: string
  context?: string
}

export interface Repository {
  remotePath?: string
  localPath?: string
  unowned?: UnownedPosture
  undeclaredDependencies?: UndeclaredPosture
}

export interface ArchitectureMap {
  version: number
  actors: Record<string, Actor>
  repositories: Record<string, Repository>
  territories: Record<string, Territory>
  unowned?: UnownedPosture
  undeclaredDependencies?: UndeclaredPosture
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  /** The parsed map, present only when it has no errors. */
  map?: ArchitectureMap
}

export interface Validator {
  validate(yamlText: string): ValidationResult
  validateDoc(doc: unknown): ValidationResult
}

/** The unowned posture in force for one repository: its own, else the map's, else fail-closed. */
export function unownedPosture(map: ArchitectureMap, repository: string): UnownedPosture {
  return map.repositories[repository]?.unowned ?? map.unowned ?? 'fail'
}

/** Serialize a map object to YAML (multiline strings become literal blocks). */
export function mapToYaml(map: unknown): string {
  return stringify(map, { lineWidth: 100 })
}

/** A territory's scope entries for one repository (a territory may span several). */
function entriesFor(map: ArchitectureMap, repository: string, territory: string): ScopeEntry[] {
  return (map.territories[territory]?.scope ?? []).filter((s) => s.repository === repository)
}

/**
 * Every glob one scope entry subtracts: its own patterns, plus the globs each
 * named territory declares for this repository. Subtraction by territory is not
 * recursive, so the named territory's own exclusions play no part.
 */
function exclusionGlobs(map: ArchitectureMap, entry: ScopeEntry): string[] {
  const ex = entry.exclude
  if (!ex) return []
  const out = [...(ex.globs ?? [])]
  for (const name of ex.territories ?? []) {
    for (const other of entriesFor(map, entry.repository, name)) out.push(...(other.globs ?? []))
  }
  return out
}

/** Territories in the order a cycle through `from` visits them, or null. */
function findCycle(map: ArchitectureMap, from: string): string[] | null {
  const stack: string[] = []
  const onStack = new Set<string>()
  const done = new Set<string>()
  const walk = (name: string): string[] | null => {
    if (onStack.has(name)) return [...stack.slice(stack.indexOf(name)), name]
    if (done.has(name)) return null
    stack.push(name)
    onStack.add(name)
    for (const next of map.territories[name]?.dependsOn ?? []) {
      if (!map.territories[next]) continue // reported as an unknown-name error
      const cycle = walk(next)
      if (cycle) return cycle
    }
    stack.pop()
    onStack.delete(name)
    done.add(name)
    return null
  }
  return walk(from)
}

export function createValidator(schemaPath: string): Validator {
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
  const ajv = new Ajv2020({ allErrors: true })
  const validateSchema = ajv.compile(schema)

  function validate(yamlText: string): ValidationResult {
    let doc: unknown
    try {
      doc = parse(yamlText)
    } catch (e) {
      return { valid: false, errors: [`YAML: ${(e as Error).message}`], warnings: [] }
    }
    return validateDoc(doc)
  }

  function validateDoc(doc: unknown): ValidationResult {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      return { valid: false, errors: ['YAML: document must be a mapping'], warnings: [] }
    }

    const errors: string[] = []
    const warnings: string[] = []

    if (!validateSchema(doc)) {
      for (const err of validateSchema.errors ?? []) {
        errors.push(`schema: ${err.instancePath || '/'} ${err.message ?? 'invalid'}`)
      }
      return { valid: false, errors, warnings }
    }

    const map = doc as ArchitectureMap
    const repoNames = new Set(Object.keys(map.repositories))
    const territoryNames = new Set(Object.keys(map.territories))
    const actorNames = new Set(Object.keys(map.actors))

    // ── Globs the dialect rejects: checked before anything matches them, so the
    // report does not depend on which paths happen to reach them. ──
    let globsUsable = true
    const checkGlobs = (globs: readonly string[] | undefined, where: string) => {
      for (const g of globs ?? []) {
        try {
          validateGlob(g)
        } catch (e) {
          if (!(e instanceof GlobError)) throw e
          errors.push(`${where}: ${e.message}`)
          globsUsable = false
        }
      }
    }

    for (const [name, territory] of Object.entries(map.territories)) {
      if (!actorNames.has(territory.owner)) {
        errors.push(`territories.${name}: owner "${territory.owner}" is not a declared actor`)
      }
      for (const [i, entry] of (territory.scope ?? []).entries()) {
        const where = `territories.${name}.scope[${i}]`
        if (!repoNames.has(entry.repository)) {
          errors.push(`${where}: unknown repository "${entry.repository}"`)
        }
        checkGlobs(entry.globs, `${where}.globs`)
        checkGlobs(entry.exclude?.globs, `${where}.exclude.globs`)
        for (const excluded of entry.exclude?.territories ?? []) {
          if (!territoryNames.has(excluded)) {
            errors.push(`${where}.exclude.territories: unknown territory "${excluded}"`)
          } else if (excluded === name) {
            errors.push(`${where}.exclude.territories: territory excludes itself`)
          }
        }
      }
      for (const dep of territory.dependsOn ?? []) {
        if (!territoryNames.has(dep)) {
          errors.push(`territories.${name}.dependsOn: unknown territory "${dep}"`)
        } else if (dep === name) {
          errors.push(`territories.${name}.dependsOn: territory depends on itself`)
        }
      }
    }

    // ── Acyclic dependency graph ──
    const reported = new Set<string>()
    for (const name of territoryNames) {
      const cycle = findCycle(map, name)
      if (!cycle) continue
      // One cycle, one error, whichever territory the walk entered it from.
      const key = [...cycle.slice(0, -1)].sort().join('|')
      if (reported.has(key)) continue
      reported.add(key)
      errors.push(`territories: dependency cycle ${cycle.join(' -> ')}`)
    }

    // ── No overlap: a property of the globs, not of the files on disk ──
    if (globsUsable) errors.push(...overlapErrors(map))

    // ── Warnings ──
    const owners = new Set(Object.values(map.territories).map((t) => t.owner))
    for (const actor of actorNames) {
      if (!owners.has(actor)) warnings.push(`actors.${actor}: declared but owns no territory`)
    }

    const scopedRepos = new Set(
      Object.values(map.territories).flatMap((t) => (t.scope ?? []).map((s) => s.repository))
    )
    for (const repo of repoNames) {
      if (!scopedRepos.has(repo)) {
        warnings.push(`repositories.${repo}: declared but no territory scopes it`)
      }
    }

    const byRemote = new Map<string, string[]>()
    for (const [name, repo] of Object.entries(map.repositories)) {
      if (!repo.remotePath) continue
      byRemote.set(repo.remotePath, [...(byRemote.get(repo.remotePath) ?? []), name])
    }
    for (const [remote, names] of byRemote) {
      if (names.length > 1) {
        warnings.push(
          `repositories: ${names.join(', ')} share the remotePath "${remote}", ` +
            'so two territories can own one path without ever overlapping'
        )
      }
    }

    if (globsUsable) warnings.push(...exclusionWarnings(map))

    const humanOwned = Object.values(map.territories).some(
      (t) => map.actors[t.owner]?.type === 'human'
    )
    if (!humanOwned) {
      warnings.push(
        'no human-owned territory: the map protects everything else, so it must fall inside one itself'
      )
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      map: errors.length === 0 ? map : undefined
    }
  }

  return { validate, validateDoc }
}

/**
 * Overlap between two territories, compared as glob languages after exclusions.
 *
 * An exclusion clears the pair when it provably covers one of the two globs,
 * which is what `exclude.territories` and a mirrored `exclude.globs` do. Where
 * subtraction is subtler than that the overlap is still reported: a false
 * finding on an exotic pair of patterns is better than silence on a real one,
 * and the map is what gets rewritten either way.
 */
function overlapErrors(map: ArchitectureMap): string[] {
  const errors: string[] = []
  const names = Object.keys(map.territories)
  for (const repository of Object.keys(map.repositories)) {
    for (let a = 0; a < names.length; a++) {
      for (let b = a + 1; b < names.length; b++) {
        const witness = overlapWitness(map, repository, names[a]!, names[b]!)
        if (!witness) continue
        errors.push(
          `territories: ${names[a]} and ${names[b]} overlap in ${repository} - ` +
            `"${witness[0]}" and "${witness[1]}" match a common path`
        )
      }
    }
  }
  return errors
}

function overlapWitness(
  map: ArchitectureMap,
  repository: string,
  first: string,
  second: string
): [string, string] | null {
  for (const entryA of entriesFor(map, repository, first)) {
    const excludeA = exclusionGlobs(map, entryA)
    for (const entryB of entriesFor(map, repository, second)) {
      const excludeB = exclusionGlobs(map, entryB)
      const subtracted = [...excludeA, ...excludeB]
      for (const globA of entryA.globs ?? []) {
        for (const globB of entryB.globs ?? []) {
          if (!intersects(globA, globB)) continue
          if (subtracted.some((x) => contains(x, globA) || contains(x, globB))) continue
          return [globA, globB]
        }
      }
    }
  }
  return null
}

/** Exclusions that subtract nothing, and exclusions that strand paths. */
function exclusionWarnings(map: ArchitectureMap): string[] {
  const warnings: string[] = []
  for (const [name, territory] of Object.entries(map.territories)) {
    for (const [i, entry] of (territory.scope ?? []).entries()) {
      if (!entry.exclude) continue
      const where = `territories.${name}.scope[${i}]`
      const subtracted = exclusionGlobs(map, entry)
      const bites = subtracted.some((x) => (entry.globs ?? []).some((g) => intersects(x, g)))
      if (!bites) {
        warnings.push(`${where}.exclude: subtracts nothing from this entry's globs`)
      }
      // Paths excluded here that no territory claims: mirroring a territory that
      // has since been deleted leaves them unowned, which nothing else catches.
      for (const excluded of entry.exclude.globs ?? []) {
        if (!(entry.globs ?? []).some((g) => intersects(excluded, g))) continue
        const claimed = Object.keys(map.territories).some((other) =>
          entriesFor(map, entry.repository, other).some(
            (e) => e !== entry && (e.globs ?? []).some((g) => intersects(excluded, g))
          )
        )
        if (!claimed) {
          warnings.push(`${where}.exclude.globs: "${excluded}" is claimed by no territory`)
        }
      }
    }
  }
  return warnings
}

/** Whether a territory claims a path in a repository: matched, minus exclusions. */
export function claims(
  map: ArchitectureMap,
  repository: string,
  territory: string,
  path: string
): boolean {
  for (const entry of entriesFor(map, repository, territory)) {
    if (matchesAny(path, entry.globs ?? []) && !matchesAny(path, exclusionGlobs(map, entry))) {
      return true
    }
  }
  return false
}

/** Starter content for a brand-new architecture map. */
export const TEMPLATE = `version: 1

# Partial maps are legal: while this one is being adopted, paths no territory
# claims are allowed. Switch to 'fail' once the tree is covered.
unowned: allow

actors:
  your-name:
    type: human
    identity: '@your-handle'
  example-owner:
    type: llm-agent
    context: |
      Role, focus, and standing guidance for this agent across every
      territory it owns.

repositories:
  app:
    remotePath: src.example.com/team/app
    # Where a checkout sits on this machine, so the editor can list its files.
    # localPath: ~/Code/app

territories:
  example:
    owner: example-owner
    scope:
      - repository: app
        globs: ['src/**']
    context: |
      Invariants, review discipline, and background needed to work in and
      review this territory.

  platform:
    owner: your-name
    scope:
      - repository: app
        globs: ['architecture.yaml', 'ci/**', 'docs/**']
    context: CI, guard tooling, repo-wide docs, and this map itself.
`

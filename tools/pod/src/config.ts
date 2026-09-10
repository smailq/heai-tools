// Where everything is, and pod.yaml. The project directory is
// --dir, else HEAI_DIR, else the directory of an explicit map, else the cwd;
// the map, the configuration and the state directory sit in it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import { parse } from 'yaml'

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** Refused, exit 1: a container that is busy, a clone that exists, a branch git would not update. */
export class RefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefusedError'
  }
}

export interface Config {
  runtime?: string
  name?: string
  /** The base image's tag. */
  base?: string
  /** The directory holding the base Containerfile; the tool's own image/ when unset. */
  baseDir?: string
  /** Extended images built FROM the base: tag → directory holding a Containerfile. */
  images?: Record<string, string>
  envFile?: string
  /** `host:container`, added to every `up`. */
  mounts?: string[]
  resources?: { cpus?: number; memory?: string }
}

export const DEFAULT_NAME = 'heai-workshop'
export const DEFAULT_BASE = 'heai/pod-base'

/** The formal definition of pod.yaml. */
export const SCHEMA_PATH = join(import.meta.dirname, '..', 'schemas', 'pod.schema.json')

export const defaultRuntime = (platform: string = process.platform): string => (platform === 'darwin' ? 'apple' : 'docker')

export const expandHome = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

export interface Paths {
  dir: string
  map: string
  state: string
  config: string
}

function firstExisting(candidates: string[], fallback: string): string {
  return candidates.find((c) => existsSync(c)) ?? fallback
}

export function resolvePaths(values: { dir?: string; map?: string; state?: string; config?: string }, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Paths {
  const explicitMap = values.map ?? env['HEAI_MAP']
  const dir = resolve(cwd, values.dir ?? env['HEAI_DIR'] ?? (explicitMap ? dirname(resolve(cwd, explicitMap)) : cwd))
  const map = resolve(cwd, explicitMap ?? firstExisting([join(dir, '.heai', 'architecture.yaml')], join(dir, 'architecture.yaml')))
  const state = resolve(cwd, values.state ?? env['HEAI_POD_STATE'] ?? join(dir, 'pod'))
  const config = resolve(cwd, values.config ?? join(dir, 'pod.yaml'))
  return { dir, map, state, config }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

let validator: ValidateFunction | null = null

function compiled(): ValidateFunction {
  validator ??= new Ajv2020({ allErrors: true, verbose: true, allowUnionTypes: true }).compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')))
  return validator
}

/** One problem as a line: the path into the document, then what is wrong, in the words the schema's titles give. */
function describeProblem(err: ErrorObject): string {
  const where = err.instancePath || '/'
  const parent = isObject(err.parentSchema) ? err.parentSchema : {}
  const p = err.params as Record<string, unknown>
  switch (err.keyword) {
    case 'additionalProperties': {
      const keys = isObject(parent['properties']) ? Object.keys(parent['properties']) : []
      return `${where}: unknown key ${JSON.stringify(p['additionalProperty'])}${keys.length ? `; the keys are ${keys.join(', ')}` : ''}`
    }
    case 'required':
      return `${where}: ${String(p['missingProperty'])} is required`
    case 'propertyNames':
      return `${where}: ${JSON.stringify(p['propertyName'])} is not a name`
    default:
      return `${where}: ${typeof parent['title'] === 'string' ? `must be ${parent['title']}` : err.message ?? 'invalid'}`
  }
}

/** Every problem the schema finds with a parsed document, one `<path>: <problem>` line each; none when it validates. */
export function schemaProblems(doc: unknown): string[] {
  const validate = compiled()
  if (validate(doc)) return []
  const out: string[] = []
  for (const err of validate.errors ?? []) {
    if (err.propertyName !== undefined && err.keyword !== 'propertyNames') continue // the propertyNames error names the key
    const line = describeProblem(err)
    if (!out.includes(line)) out.push(line)
  }
  return out
}

/** pod.yaml, or `{}` when there is none. */
export function readConfig(path: string): Config {
  if (!existsSync(path)) return {}
  return parseConfig(readFileSync(path, 'utf8'), path)
}

/** `text` as a configuration, validated against the schema, with `~` expanded in every path; `path` names it in messages. */
export function parseConfig(text: string, path = 'pod.yaml'): Config {
  let doc: unknown
  try {
    doc = parse(text)
  } catch (e) {
    throw new UsageError(`${path} is not valid YAML: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (doc === null || doc === undefined) return {}
  if (!isObject(doc)) throw new UsageError(`${path} must be a mapping`)
  const problems = schemaProblems(doc)
  if (problems.length) throw new UsageError(`${path}:${problems.length === 1 ? ` ${problems[0]}` : `\n  ${problems.join('\n  ')}`}`)
  const out: Config = {}
  if (typeof doc['runtime'] === 'string') out.runtime = doc['runtime']
  if (typeof doc['name'] === 'string') out.name = doc['name']
  if (typeof doc['base'] === 'string') out.base = doc['base']
  if (typeof doc['baseDir'] === 'string') out.baseDir = expandHome(doc['baseDir'])
  if (typeof doc['envFile'] === 'string') out.envFile = expandHome(doc['envFile'])
  if (isObject(doc['images'])) out.images = Object.fromEntries(Object.entries(doc['images'] as Record<string, string>).map(([tag, dir]) => [tag, expandHome(dir)]))
  if (Array.isArray(doc['mounts'])) out.mounts = (doc['mounts'] as string[]).map(expandHome)
  if (isObject(doc['resources'])) {
    const r = doc['resources']
    out.resources = {}
    if (typeof r['cpus'] === 'number') out.resources.cpus = r['cpus']
    if (r['memory'] !== undefined) out.resources.memory = String(r['memory'])
  }
  return out
}

export interface StateDirs {
  root: string
  repos: string
  worktrees: string
  inbox: string
}

/** The state directory beside the map: repos/, worktrees/, inbox/ and a .gitignore of `*`, nothing else. */
export function ensureState(root: string): StateDirs {
  const dirs = { root, repos: join(root, 'repos'), worktrees: join(root, 'worktrees'), inbox: join(root, 'inbox') }
  for (const d of [dirs.repos, dirs.worktrees, dirs.inbox]) mkdirSync(d, { recursive: true })
  const ignore = join(root, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  return dirs
}

/** `60s`, `5m`, `2h`, or a bare number of milliseconds; null when it is none of those. */
export function parseDuration(s: string): number | null {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(s.trim())
  if (!m) return null
  const n = Number.parseInt(m[1]!, 10)
  const unit = m[2] ?? 'ms'
  return n * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1000 : 1)
}

/** `K=V` pairs into an object; a pair without `=` is a usage error. */
export function parseEnv(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of pairs) {
    const eq = p.indexOf('=')
    if (eq <= 0) throw new UsageError(`--env takes KEY=VALUE, not ${JSON.stringify(p)}`)
    out[p.slice(0, eq)] = p.slice(eq + 1)
  }
  return out
}

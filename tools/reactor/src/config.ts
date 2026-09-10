// reactor.yaml: the sources, the rules, the concurrency and the receiver's
// address. A rule does one thing, `run` a command, so the vocabulary is one
// word.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import { parse } from 'yaml'
import { parseCron } from './cron.ts'
import { isRecord, UsageError } from './errors.ts'

export interface Match {
  source: string | null
  kind: string | null
  cron: string | null
  /** Every other key: a dotted path into the payload and the value it must equal. */
  fields: Record<string, unknown>
}

export interface Rule {
  name: string
  on: Match
  /** The command, templates still in it; rendered against each event it runs for. */
  run: string
  debounce: number | null
  limit: { count: number; windowMs: number } | null
  repeat: boolean
  timeout: number | null
}

export interface SourceConfig {
  name: string
  type: string
  options: Record<string, unknown>
}

export interface Config {
  path: string | null
  sources: SourceConfig[]
  rules: Rule[]
  concurrency: number
  receiver: { host: string; port: number }
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** `90s`, `10m`, `2h`, `1d`; a bare number is seconds. Null when it is none of those. */
export function parseDuration(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v * 1000 : null
  if (typeof v !== 'string') return null
  const m = v.trim().match(/^(\d+)\s*(ms|s|m|h|d)$/)
  if (!m) return null
  const n = Number(m[1]) * UNITS[m[2]!]!
  return n > 0 ? n : null
}

export function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}

const WINDOWS: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 }

/** `10/hour`, `3/day`, `100/minute`. */
export function parseLimit(v: unknown, where: string): { count: number; windowMs: number } {
  const m = typeof v === 'string' ? v.trim().match(/^(\d+)\s*\/\s*(minute|hour|day|week)$/) : null
  if (!m) throw new UsageError(`${where}: limit must be like 10/hour (per minute, hour, day or week)`)
  return { count: Number(m[1]), windowMs: WINDOWS[m[2]!]! }
}

export const NAME = /^[a-z0-9][a-z0-9._-]*$/

const RULE_KEYS = ['name', 'on', 'run', 'debounce', 'limit', 'repeat', 'timeout']

export function parseRun(v: unknown, where: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new UsageError(`${where}: run must be a command`)
  return v
}

function parseMatch(raw: unknown, where: string): Match {
  if (raw === undefined || raw === null) return { source: null, kind: null, cron: null, fields: {} }
  if (!isRecord(raw)) throw new UsageError(`${where}: on must be a mapping`)
  const m: Match = { source: null, kind: null, cron: null, fields: {} }
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'source' || k === 'kind' || k === 'cron') {
      if (typeof v !== 'string' || !v) throw new UsageError(`${where}: on.${k} must be a string`)
      m[k] = v
      if (k === 'cron') parseCron(v, `${where}: on.cron`)
    } else m.fields[k] = v
  }
  return m
}

export function parseRule(raw: unknown, i: number): Rule {
  const where = `rule ${i + 1}`
  if (!isRecord(raw)) throw new UsageError(`${where} must be a mapping`)
  for (const k of Object.keys(raw)) if (!RULE_KEYS.includes(k)) throw new UsageError(`${where}: unknown key ${JSON.stringify(k)}; the keys are ${RULE_KEYS.join(', ')}`)
  const name = raw['name']
  if (typeof name !== 'string' || !NAME.test(name)) throw new UsageError(`${where}: name must be a lowercase word, like sentry-to-owner`)
  const at = `rule ${name}`
  let debounce: number | null = null
  if (raw['debounce'] !== undefined) {
    debounce = parseDuration(raw['debounce'])
    if (debounce === null) throw new UsageError(`${at}: debounce must be a duration like 5s or 10m`)
  }
  let timeout: number | null = null
  if (raw['timeout'] !== undefined) {
    timeout = parseDuration(raw['timeout'])
    if (timeout === null) throw new UsageError(`${at}: timeout must be a duration like 10m`)
  }
  if (raw['repeat'] !== undefined && typeof raw['repeat'] !== 'boolean') throw new UsageError(`${at}: repeat must be true or false`)
  return {
    name,
    on: parseMatch(raw['on'], at),
    run: parseRun(raw['run'], at),
    debounce,
    limit: raw['limit'] === undefined ? null : parseLimit(raw['limit'], at),
    repeat: raw['repeat'] === true,
    timeout
  }
}

const TOP_KEYS = ['sources', 'rules', 'concurrency', 'receiver']

/** The formal definition of reactor.yaml: every key, every source type's options, every rule key, durations and limits as patterns. */
export const SCHEMA_PATH = join(import.meta.dirname, '..', 'schemas', 'reactor.schema.json')

let validator: ValidateFunction | null = null

function compiled(): ValidateFunction {
  validator ??= new Ajv2020({ allErrors: true, verbose: true, allowUnionTypes: true }).compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')))
  return validator
}

/** One problem as a line: the path into the document, then what is wrong, in the words the schema's titles give. */
function describeProblem(err: ErrorObject): string {
  const where = err.instancePath || '/'
  const parent = isRecord(err.parentSchema) ? err.parentSchema : {}
  const p = err.params as Record<string, unknown>
  switch (err.keyword) {
    case 'additionalProperties': {
      const keys = isRecord(parent['properties']) ? Object.keys(parent['properties']) : []
      return `${where}: unknown key ${JSON.stringify(p['additionalProperty'])}${keys.length ? `; the keys are ${keys.join(', ')}` : ''}`
    }
    case 'required':
      return `${where}: ${String(p['missingProperty'])} is required`
    case 'propertyNames':
      return `${where}: ${JSON.stringify(p['propertyName'])} is not a lowercase word`
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
    if (err.keyword === 'if') continue // the branch's own errors say what is wrong
    if (err.propertyName !== undefined && err.keyword !== 'propertyNames') continue // the name's pattern; the propertyNames error names the key
    const line = describeProblem(err)
    if (!out.includes(line)) out.push(line)
  }
  return out
}

/** `text` as a configuration; `path` names it in messages. */
export function parseConfig(text: string, path: string | null): Config {
  let doc: unknown
  try {
    doc = parse(text)
  } catch (e) {
    throw new UsageError(`${path ?? 'reactor.yaml'}: not valid YAML: ${(e as Error).message}`)
  }
  if (doc === null || doc === undefined) doc = {}
  if (!isRecord(doc)) throw new UsageError(`${path ?? 'reactor.yaml'}: must be a mapping`)
  const problems = schemaProblems(doc)
  if (problems.length === 1) throw new UsageError(`${path ?? 'reactor.yaml'}: ${problems[0]}`)
  if (problems.length) throw new UsageError(`${path ?? 'reactor.yaml'}: ${problems.length} problems\n  ${problems.join('\n  ')}`)
  // What follows is what the schema cannot say: a rule's source must be declared, names must not repeat, a cron must parse.
  for (const k of Object.keys(doc)) if (!TOP_KEYS.includes(k)) throw new UsageError(`${path}: unknown key ${JSON.stringify(k)}; the keys are ${TOP_KEYS.join(', ')}`)

  const sources: SourceConfig[] = []
  if (doc['sources'] !== undefined && doc['sources'] !== null) {
    if (!isRecord(doc['sources'])) throw new UsageError(`${path}: sources must be a mapping of name to { type, ... }`)
    for (const [name, raw] of Object.entries(doc['sources'])) {
      if (!NAME.test(name)) throw new UsageError(`${path}: source name ${JSON.stringify(name)} is not a lowercase word`)
      if (!isRecord(raw) || typeof raw['type'] !== 'string' || !raw['type']) throw new UsageError(`${path}: source ${name} needs a type`)
      const { type, ...options } = raw
      sources.push({ name, type: type as string, options })
    }
  }

  const rules: Rule[] = []
  if (doc['rules'] !== undefined && doc['rules'] !== null) {
    if (!Array.isArray(doc['rules'])) throw new UsageError(`${path}: rules must be a list`)
    doc['rules'].forEach((r, i) => rules.push(parseRule(r, i)))
    const seen = new Set<string>()
    for (const r of rules) {
      if (seen.has(r.name)) throw new UsageError(`${path}: two rules are named ${r.name}`)
      seen.add(r.name)
      if (r.on.source && !sources.some((s) => s.name === r.on.source)) throw new UsageError(`${path}: rule ${r.name} listens to source ${r.on.source}, which is not declared`)
    }
  }

  let concurrency = 4
  if (doc['concurrency'] !== undefined) {
    if (typeof doc['concurrency'] !== 'number' || !Number.isInteger(doc['concurrency']) || doc['concurrency'] < 1) throw new UsageError(`${path}: concurrency must be a whole number of at least 1`)
    concurrency = doc['concurrency']
  }

  const receiver = { host: '127.0.0.1', port: 4949 }
  if (doc['receiver'] !== undefined) {
    if (!isRecord(doc['receiver'])) throw new UsageError(`${path}: receiver must be { host, port }`)
    if (doc['receiver']['host'] !== undefined) {
      if (typeof doc['receiver']['host'] !== 'string') throw new UsageError(`${path}: receiver.host must be a string`)
      receiver.host = doc['receiver']['host']
    }
    if (doc['receiver']['port'] !== undefined) {
      if (typeof doc['receiver']['port'] !== 'number') throw new UsageError(`${path}: receiver.port must be a number`)
      receiver.port = doc['receiver']['port']
    }
  }

  return { path, sources, rules, concurrency, receiver }
}

/** The file at `path`, or an empty configuration when there is none. */
export function loadConfig(path: string): Config {
  if (!existsSync(path)) return parseConfig('', null)
  return parseConfig(readFileSync(path, 'utf8'), path)
}

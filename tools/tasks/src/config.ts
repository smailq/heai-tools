// The vocabulary a tracker's `territory` field draws on, and where it comes from.
//
// `territory` is the only task field whose values belong to the repository
// rather than to this tool, so it is not hard-coded here. A tracker declares it
// in `tasks.yaml` beside its files; with no configuration it stays open and
// any non-empty value is accepted. schemas/tasks.schema.json is the formal
// definition of that file.
//
// Territories are not listed twice: a repository that has an architecture map
// already names them there, together with the actor that owns each one, so the
// config points at the map and the map stays the single source of ownership.

import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import { parse } from 'yaml'
import type { Vocabularies, Vocabulary } from './model.ts'

export const CONFIG_FILE = 'tasks.yaml'

/** The formal definition of tasks.yaml. */
export const SCHEMA_PATH = join(import.meta.dirname, '..', 'schemas', 'tasks.schema.json')

/** A problem with the invocation or the configuration, not with a task file. */
export class UsageError extends Error {}

export interface Config {
  /** Path to an architecture map, relative to the tracker directory. */
  map?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

let validator: ValidateFunction | null = null

function compiled(): ValidateFunction {
  validator ??= new Ajv2020({ allErrors: true, verbose: true }).compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')))
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
      return `${where}: unknown configuration key ${JSON.stringify(p['additionalProperty'])}${keys.length ? `; the keys are ${keys.join(', ')}` : ''}`
    }
    case 'required':
      return `${where}: ${String(p['missingProperty'])} is required`
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
    const line = describeProblem(err)
    if (!out.includes(line)) out.push(line)
  }
  return out
}

export interface VocabularySet extends Vocabularies {
  /** The configuration as declared, for reporting. */
  config: Config
  /** Where the map was read from, when one is configured. */
  mapPath: string | null
}

function readYaml(path: string, what: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new UsageError(`cannot read ${what}: ${path}`)
  }
  try {
    return parse(text)
  } catch (e) {
    throw new UsageError(`${what} is not valid YAML: ${path}: ${(e as Error).message}`)
  }
}

/** Read `<dir>/tasks.yaml` and validate it against the schema, or the empty configuration when there is none. */
export function loadConfig(dir: string): Config {
  const path = resolve(dir, CONFIG_FILE)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new UsageError(`cannot read configuration: ${path}`)
  }
  return parseConfig(text, path)
}

/** `text` as a configuration; `path` names it in messages. */
export function parseConfig(text: string, path: string = CONFIG_FILE): Config {
  let doc: unknown
  try {
    doc = parse(text)
  } catch (e) {
    throw new UsageError(`configuration is not valid YAML: ${path}: ${(e as Error).message}`)
  }
  if (doc === null || doc === undefined) return {}
  if (!isRecord(doc)) throw new UsageError(`configuration must be a mapping: ${path}`)
  const problems = schemaProblems(doc)
  if (problems.length) throw new UsageError(`${path}:${problems.length === 1 ? ` ${problems[0]}` : `\n  ${problems.join('\n  ')}`}`)
  const config: Config = {}
  if (doc['map'] !== undefined) config.map = doc['map'] as string
  return config
}

/**
 * Read the territory names out of an architecture map.
 *
 * Only the shape this tool depends on is checked - a `territories` mapping,
 * whose keys are the names; the map's own rules belong to the validator that
 * owns them, so a map that this reads is not thereby a valid map. A map that
 * cannot be read at all is an error rather than a silent fallback to an open
 * vocabulary: a tracker that asked to be checked against a map must not
 * quietly stop being checked.
 */
function readMap(path: string): string[] {
  const doc = readYaml(path, 'architecture map')
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new UsageError(`architecture map must be a mapping: ${path}`)
  }
  const territories = (doc as Record<string, unknown>)['territories']
  if (!territories || typeof territories !== 'object' || Array.isArray(territories)) {
    throw new UsageError(`architecture map has no "territories" section: ${path}`)
  }
  return Object.keys(territories as object)
}

/** Resolve the vocabulary a tracker directory's files are validated against. */
export function loadVocabularies(dir: string, config: Config = loadConfig(dir)): VocabularySet {
  let territories: Vocabulary = null
  let mapPath: string | null = null

  if (config.map !== undefined) {
    mapPath = isAbsolute(config.map) ? config.map : resolve(dir, config.map)
    territories = readMap(mapPath)
  }

  return { territories, config, mapPath }
}

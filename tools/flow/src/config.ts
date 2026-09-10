// `flow.yaml`: where the definitions are. Definitions are found by scanning
// that directory; each file declares its own name. schemas/flow.schema.json is the formal definition of this file
// and every file is validated against it when read.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import { parse } from 'yaml'
import { UsageError } from './errors.ts'

export interface Config {
  /** Where it was read from, or null when there was none. */
  path: string | null
  /** The directory of definitions, absolute; null for the default, `flows` under the project directory. */
  flows: string | null
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** The formal definition of flow.yaml. */
export const SCHEMA_PATH = join(import.meta.dirname, '..', 'schemas', 'flow.schema.json')

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
    default:
      return `${where}: ${typeof parent['title'] === 'string' ? `must be ${parent['title']}` : (err.message ?? 'invalid')}`
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

export function loadConfig(path: string): Config {
  const abs = resolve(path)
  const config: Config = { path: null, flows: null }
  if (!existsSync(abs)) return config
  let doc: unknown
  try {
    doc = parse(readFileSync(abs, 'utf8'))
  } catch (e) {
    throw new UsageError(`configuration is not valid YAML: ${abs}: ${(e as Error).message}`)
  }
  config.path = abs
  if (doc === null || doc === undefined) return config
  if (!isRecord(doc)) throw new UsageError(`${abs}: must be a mapping`)
  const problems = schemaProblems(doc)
  if (problems.length === 1) throw new UsageError(`${abs}: ${problems[0]}`)
  if (problems.length) throw new UsageError(`${abs}: ${problems.length} problems\n  ${problems.join('\n  ')}`)
  const d = doc as { flows?: string }
  if (d.flows !== undefined) config.flows = isAbsolute(d.flows) ? d.flows : resolve(dirname(abs), d.flows)
  return config
}

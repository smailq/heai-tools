#!/usr/bin/env node
// The command. Validation answers with the exit-code split every tool here
// uses; the queries answer the questions other tools shell out for.

import { parseArgs } from 'node:util'
import { actorContext, actorsView, contextChain, DEFAULT_SCHEMA, loadMap, LoadError, ownerOf, resolveMapPath, territoriesView } from './query.ts'
import { TEMPLATE, type ArchitectureMap } from './validate.ts'

const USAGE = `map-check - validates an architecture map, and answers questions about it

  map-check [<map>] [--format text|json] [--schema <path>] [--strict]
  map-check owner <path> [--repo <name>] [--json]
  map-check territories [--actor <name>] [--json]
  map-check actors [--json]
  map-check context <actor>|<territory> [--json]
  map-check template

<map> defaults to .heai/architecture.yaml, else architecture.yaml (or HEAI_MAP).
The schema defaults to this repository's schemas/architecture.schema.json (or HEAI_SCHEMA).

Exit codes: 0 valid (or answered), 1 invalid (or unowned, or warnings under --strict),
2 the map or schema cannot be read, or bad usage.`

const COMMANDS = ['owner', 'territories', 'actors', 'context', 'template'] as const
type Command = (typeof COMMANDS)[number]

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n')
}

/** Load, and refuse to answer a query for a map with errors. */
function validMap(mapPath: string, schemaPath: string): ArchitectureMap {
  const { result } = loadMap(mapPath, schemaPath)
  if (!result.valid || !result.map) {
    throw new LoadError(`${mapPath} does not validate:\n${result.errors.map((e) => `  ${e}`).join('\n')}`)
  }
  return result.map
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      format: { type: 'string' },
      json: { type: 'boolean', default: false },
      schema: { type: 'string' },
      strict: { type: 'boolean', default: false },
      repo: { type: 'string' },
      actor: { type: 'string' },
      map: { type: 'string' },
      help: { type: 'boolean', default: false }
    }
  })
  if (values.help) {
    out(USAGE)
    return 0
  }
  const schemaPath = values.schema ?? process.env['HEAI_SCHEMA'] ?? DEFAULT_SCHEMA
  const first = positionals[0]
  const isCommand = first !== undefined && (COMMANDS as readonly string[]).includes(first)

  if (first === 'template') {
    out(TEMPLATE)
    return 0
  }

  if (!isCommand) {
    // Validate. The positional, if any, is the map.
    const mapPath = resolveMapPath(first ?? values.map)
    const format = values.format ?? (values.json ? 'json' : 'text')
    if (format !== 'text' && format !== 'json') throw new LoadError(`unknown --format "${format}" (text or json)`)
    const { result } = loadMap(mapPath, schemaPath)
    const failed = !result.valid || (values.strict && result.warnings.length > 0)
    if (format === 'json') {
      out(JSON.stringify({ path: mapPath, ...result }, null, 2))
      return failed ? 1 : 0
    }
    for (const e of result.errors) out(`error: ${e}`)
    for (const w of result.warnings) out(`warning: ${w}`)
    if (!result.valid) out(`${mapPath}: ${result.errors.length} error${result.errors.length === 1 ? '' : 's'}`)
    else if (result.warnings.length) out(`${mapPath}: valid with ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}${values.strict ? ' (--strict)' : ''}`)
    else out(`${mapPath}: valid`)
    return failed ? 1 : 0
  }

  const command = first as Command
  const mapPath = resolveMapPath(values.map)
  const map = validMap(mapPath, schemaPath)
  const json = values.json || values.format === 'json'

  switch (command) {
    case 'owner': {
      const path = positionals[1]
      if (!path) throw new LoadError('owner needs a path')
      const answer = ownerOf(map, path, values.repo)
      if (json) out(JSON.stringify(answer, null, 2))
      else if (answer.territory) out(`${answer.path}  ${answer.territory}  owned by ${answer.owner ?? '(nobody)'}${answer.ownerType ? ` (${answer.ownerType})` : ''}`)
      else out(`${answer.path}  unowned in ${answer.repository}`)
      return answer.territory ? 0 : 1
    }
    case 'territories': {
      const view = territoriesView(map, values.actor)
      if (json) out(JSON.stringify(view, null, 2))
      else
        for (const t of view) {
          const globs = t.globs.map((g) => `${g.repository}: ${g.globs.join(' ')}`).join('; ')
          out(`${t.name.padEnd(26)} ${(t.owner ?? '(nobody)').padEnd(18)} ${t.parent ? `parent ${t.parent}`.padEnd(24) : ''.padEnd(24)} ${globs}`)
        }
      return 0
    }
    case 'actors': {
      const view = actorsView(map)
      if (json) out(JSON.stringify(view, null, 2))
      else
        for (const a of view) {
          const watches = a.watches.length ? `  watches ${a.watches.join(', ')}` : ''
          out(`${a.name.padEnd(20)} ${a.type.padEnd(10)} owns ${a.owns.join(', ') || '(nothing)'}${watches}`)
        }
      return 0
    }
    case 'context': {
      const name = positionals[1]
      if (!name) throw new LoadError('context needs an actor or territory name')
      if (name in map.actors) {
        const c = actorContext(map, name)
        if (json) {
          out(JSON.stringify(c, null, 2))
          return 0
        }
        for (const l of c.own) out(`# ${l.from}\n\n${l.context.trim()}\n`)
        for (const t of c.owned) for (const l of t.layers) out(`# owned ${t.territory} (${l.from})\n\n${l.context.trim()}\n`)
        for (const t of c.watched) for (const l of t.layers) out(`# watched ${t.territory}, owned by ${t.owner ?? '(nobody)'} (${l.from})\n\n${l.context.trim()}\n`)
        return 0
      }
      if (name in map.territories) {
        const chain = contextChain(map, name)
        if (json) out(JSON.stringify(chain, null, 2))
        else for (const l of chain) out(`# ${l.from}\n\n${l.context.trim()}\n`)
        return 0
      }
      throw new LoadError(`no actor or territory named "${name}" in the map`)
    }
    case 'template':
      return 0
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    process.stderr.write(`map-check: ${(e as Error).message}\n`)
    process.exitCode = 2
  }
)

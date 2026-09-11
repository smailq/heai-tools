#!/usr/bin/env node
// The command. One subcommand per question the map answers: `check` validates,
// `gate` judges a diff, the rest query. Every one of them runs over the map
// the validator has read, and answers with the exit-code split every tool
// here uses: 0 yes, 1 no, 2 the question could not be asked.

import { parseArgs } from 'node:util'
import { parseDiffPaths } from './diff.ts'
import { UsageError } from './errors.ts'
import { resolveRepository, resolveSubject, runGate, subjectGlobs, type Finding, type GateResult } from './gate.ts'
import { actorContext, actorsView, contextChain, DEFAULT_SCHEMA, loadMap, ownerOf, resolveMapPath, territoriesView } from './query.ts'
import { TEMPLATE, type ArchitectureMap } from './validate.ts'

const USAGE = `heai-architect - validates an architecture map, answers questions about it, and checks a diff against it

  heai-architect check [<map>] [--format text|json] [--strict]
  git diff | heai-architect gate <name> | --territory <name> | --actor <name>  [--repo <name>] [--format text|json] [--all]
  heai-architect owner <path> [--repo <name>] [--json]
  heai-architect territories [--actor <name>] [--json]
  heai-architect actors [--json]
  heai-architect context <actor>|<territory> [--json]
  heai-architect template

  --map <path>      the map; default HEAI_MAP, else $HEAI_DIR/architecture.yaml, else .heai/architecture.yaml, else architecture.yaml
  --schema <path>   the schema; default the tool's own schemas/architecture.schema.json (or HEAI_SCHEMA)
  --help

gate reads the diff from stdin; a plain path list (git diff --name-only) also works.
A bare name is resolved against both namespaces and must be qualified if it is both.

Exit codes: 0 valid, clean, or answered; 1 invalid (or warnings under --strict), a boundary
violation, or an unowned path; 2 the map or schema cannot be read, the map does not validate,
or bad usage.`

const COMMANDS = ['check', 'gate', 'owner', 'territories', 'actors', 'context', 'template'] as const
type Command = (typeof COMMANDS)[number]

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n')
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (data += chunk))
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

/** Load, and refuse to answer for a map with errors. */
function validMap(mapPath: string, schemaPath: string): ArchitectureMap {
  const { result } = loadMap(mapPath, schemaPath)
  if (!result.valid || !result.map) {
    throw new UsageError(`${mapPath} does not validate:\n${result.errors.map((e) => `  ${e}`).join('\n')}`)
  }
  return result.map
}

function pickFormat(format: string | undefined, json: boolean): 'text' | 'json' {
  const chosen = format ?? (json ? 'json' : 'text')
  if (chosen !== 'text' && chosen !== 'json') throw new UsageError(`unknown --format "${chosen}" (text or json)`)
  return chosen
}

// ── gate's text report ──

const SYMBOL: Record<Finding['classification'], string> = { owned: '✓', foreign: '✗', unowned: '!' }

function describe(f: Finding): string {
  switch (f.classification) {
    case 'owned':
      return `owned by ${f.territory}`
    case 'foreign':
      return `owned by ${f.territory} (${f.owner}${f.ownerType ? `, ${f.ownerType}` : ''}); delegate the change or move the boundary`
    case 'unowned':
      return f.note ?? 'no territory claims it, and this repository fails closed on unowned paths'
  }
}

function gateReport(result: GateResult, showAll: boolean): string {
  const { subject } = result
  const who =
    subject.kind === 'territory'
      ? `territory ${subject.name}${subject.owner ? ` (owner ${subject.owner})` : ''}`
      : `actor ${subject.name}${subject.territories.length ? ` (owns ${subject.territories.join(', ')})` : ' (owns no territory)'}`

  const lines: string[] = []
  lines.push(`scope gate: ${result.ok ? 'PASS' : 'FAIL'}`)
  lines.push(`  subject     ${who}`)
  lines.push(`  repository  ${result.repository}`)
  const counts = [`${result.changedFiles} file${result.changedFiles === 1 ? '' : 's'} changed`]
  if (result.violations) counts.push(`${result.violations} violation${result.violations === 1 ? '' : 's'}`)
  lines.push(`  changed     ${counts.join(', ')}`)

  // Owned paths stay quiet unless asked for; anything the subject does not own
  // is worth showing even when the posture keeps it from failing the gate.
  const shown = result.findings.filter((f) => showAll || f.note || f.classification !== 'owned')
  if (shown.length) {
    lines.push('')
    for (const f of shown) {
      lines.push(`  ${SYMBOL[f.classification]} ${f.classification.padEnd(8)} ${f.path}`)
      lines.push(`    ${' '.repeat(8)} ${describe(f)}`)
    }
  }
  return lines.join('\n')
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      map: { type: 'string' },
      schema: { type: 'string' },
      format: { type: 'string' },
      json: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      repo: { type: 'string' },
      actor: { type: 'string' },
      territory: { type: 'string' },
      all: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    }
  })
  if (values.help) {
    out(USAGE)
    return 0
  }
  const first = positionals[0]
  if (first === undefined || !(COMMANDS as readonly string[]).includes(first)) {
    throw new UsageError(first === undefined ? `a subcommand is required\n\n${USAGE}` : `unknown subcommand "${first}"\n\n${USAGE}`)
  }
  const command = first as Command
  const rest = positionals.slice(1)
  const schemaPath = values.schema ?? process.env['HEAI_SCHEMA'] ?? DEFAULT_SCHEMA

  if (command === 'template') {
    out(TEMPLATE)
    return 0
  }

  if (command === 'check') {
    // The positional, if any, is the map.
    if (rest.length > 1) throw new UsageError(`check takes one map, got: ${rest.join(', ')}`)
    const mapPath = resolveMapPath(rest[0] ?? values.map)
    const format = pickFormat(values.format, values.json)
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

  const mapPath = resolveMapPath(values.map)
  const format = pickFormat(values.format, values.json)
  const json = format === 'json'

  if (command === 'gate') {
    if (rest.length > 1) throw new UsageError(`expected at most one subject name, got: ${rest.join(', ')}`)
    if (rest.length === 1 && (values.territory || values.actor)) {
      throw new UsageError(`name the subject once: got "${rest[0]}" and ${values.territory ? '--territory' : '--actor'}`)
    }
    if (process.stdin.isTTY) {
      throw new UsageError(`no diff on stdin; pipe one, e.g. git diff origin/main... | heai-architect gate <name>\n\n${USAGE}`)
    }
    const map = validMap(mapPath, schemaPath)
    const repository = resolveRepository(map, values.repo)
    const subject = resolveSubject(map, { territory: values.territory, actor: values.actor, name: rest[0] })
    const paths = parseDiffPaths(await readStdin())
    const result = runGate({ map, repository, subject, paths })
    if (json) {
      out(JSON.stringify(result, null, 2))
    } else {
      out(gateReport(result, values.all))
      if (!result.ok) {
        const globs = subjectGlobs(map, repository, subject)
        out(`\n  ${subject.name} may change: ${globs.length ? globs.join(', ') : '(nothing in this repository)'}`)
      }
    }
    return result.ok ? 0 : 1
  }

  const map = validMap(mapPath, schemaPath)

  switch (command) {
    case 'owner': {
      const path = rest[0]
      if (!path) throw new UsageError('owner needs a path')
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
      const name = rest[0]
      if (!name) throw new UsageError('context needs an actor or territory name')
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
      throw new UsageError(`no actor or territory named "${name}" in the map`)
    }
    default:
      return 2
  }
}

// Set the exit code rather than calling process.exit: exiting outright drops
// whatever of an async pipe write has not flushed, which truncates --format
// json at the 64KB pipe buffer and hands CI unparseable output.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    // parseArgs reports an unknown flag as an error with an ERR_PARSE_ARGS code.
    const usage = e instanceof UsageError || String((e as { code?: string }).code ?? '').startsWith('ERR_PARSE_ARGS')
    const message = usage ? (e as Error).message : ((e as Error).stack ?? String(e))
    process.stderr.write(`architect: ${message}\n`)
    process.exitCode = 2
  }
)

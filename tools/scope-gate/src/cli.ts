#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { loadMap, resolveRepository, resolveSubject, UsageError } from './map.ts'
import { parseDiffPaths } from './diff.ts'
import { runGate, subjectGlobs, type Finding, type GateResult } from './gate.ts'

const USAGE = `scope-gate - check a diff against the architecture map

  git diff | scope-gate <name> [options]
  git diff origin/main... | scope-gate --territory editor-ui

The diff is read from stdin; a plain path list (git diff --name-only) also works.

Subject (exactly one; a bare name is resolved against both namespaces):
  --territory <name>   confine the change to one territory
  --actor <name>       allow every territory that actor owns

Options:
  --map <path>         architecture map (default: architecture.yaml)
  --repo <name>        which repository the diff came from
                       (defaults to the only one, when the map declares one)
  --format text|json   output format (default: text)
  --all                list every changed file, not just findings
  --help

Exit codes: 0 clean, 1 boundary violation, 2 bad usage or unreadable map.`

const SYMBOL: Record<Classification, string> = { owned: '✓', foreign: '✗', unowned: '!' }
type Classification = Finding['classification']

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (data += chunk))
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

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

function report(result: GateResult, showAll: boolean): string {
  const { subject } = result
  const who =
    subject.kind === 'territory'
      ? `territory ${subject.name}${subject.owner ? ` (owner ${subject.owner})` : ''}`
      : `actor ${subject.name}${
          subject.territories.length
            ? ` (owns ${subject.territories.join(', ')})`
            : ' (owns no territory)'
        }`

  const lines: string[] = []
  lines.push(`scope gate: ${result.ok ? 'PASS' : 'FAIL'}`)
  lines.push(`  subject     ${who}`)
  lines.push(`  repository  ${result.repository}`)
  const counts = [`${result.changedFiles} file${result.changedFiles === 1 ? '' : 's'} changed`]
  if (result.violations) {
    counts.push(`${result.violations} violation${result.violations === 1 ? '' : 's'}`)
  }
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

async function main(): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        territory: { type: 'string' },
        actor: { type: 'string' },
        map: { type: 'string', default: 'architecture.yaml' },
        repo: { type: 'string' },
        format: { type: 'string', default: 'text' },
        all: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false }
      }
    })
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${USAGE}\n`)
    return 2
  }
  const { values, positionals } = parsed

  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (values.format !== 'text' && values.format !== 'json') {
    process.stderr.write(`unknown --format "${values.format}" (text or json)\n`)
    return 2
  }
  if (positionals.length > 1) {
    process.stderr.write(`expected at most one subject name, got: ${positionals.join(', ')}\n`)
    return 2
  }
  if (positionals.length === 1 && (values.territory || values.actor)) {
    process.stderr.write(
      `name the subject once: got "${positionals[0]}" and ${values.territory ? '--territory' : '--actor'}\n`
    )
    return 2
  }
  if (process.stdin.isTTY) {
    process.stderr.write(
      `no diff on stdin; pipe one, e.g. git diff origin/main... | scope-gate <name>\n\n${USAGE}\n`
    )
    return 2
  }

  const map = loadMap(values.map as string)
  const repository = resolveRepository(map, values.repo)
  const subject = resolveSubject(map, {
    territory: values.territory,
    actor: values.actor,
    name: positionals[0]
  })
  const paths = parseDiffPaths(await readStdin())
  const result = runGate({ map, repository, subject, paths })

  if (values.format === 'json') {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`${report(result, values.all as boolean)}\n`)
    if (!result.ok) {
      const globs = subjectGlobs(map, repository, subject)
      process.stdout.write(
        `\n  ${subject.name} may change: ${globs.length ? globs.join(', ') : '(nothing in this repository)'}\n`
      )
    }
  }
  return result.ok ? 0 : 1
}

// Set the exit code rather than calling process.exit: exiting outright drops
// whatever of an async pipe write has not flushed, which truncates --format
// json at the 64KB pipe buffer and hands CI unparseable output. stdin has
// already ended by this point, so the process exits on its own once stdout
// drains.
main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((e) => {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n`)
      process.exitCode = 2
      return
    }
    process.stderr.write(`${(e as Error).stack ?? String(e)}\n`)
    process.exitCode = 2
  })

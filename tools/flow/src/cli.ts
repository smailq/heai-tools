#!/usr/bin/env node
// The commands. Each is a thin call into store.ts, and every one settles
// first, so what it prints is current. What settles or advances starts the
// action of every state entered, and the command returns without waiting.

import { parseArgs } from 'node:util'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { openStore, FlowError, UsageError, type Action, type Line, type Snapshot, type Store } from './store.ts'
import { formatDuration, parseDuration, RESERVED_EVENTS } from './definition.ts'
import { humanize } from './cli-format.ts'

const USAGE = `heai-flow - a state machine per record, a journal per flow, and one command that says where anything is

  heai-flow start <definition> [--id <id>] [--link name=value ...] [--parent <flow>] [--waits-on <flow> ...] [--by <who>] [--note "..."]
  heai-flow advance <id> <event> [--data '<json>'] [--seq <n>] [--by <who>] [--note "..."]
  heai-flow touch <id>                            the heartbeat: an \`after\` counts from the last touch
  heai-flow link <id> [name=value ...] [--parent <flow>] [--waits-on <flow> ...] [--by <who>]
  heai-flow show <id> [--json]                    state, links, the journal, and the actions
  heai-flow list [<definition>] [--in <state>] [--link name=value] [--json]
  heai-flow trace <id | name=value> [--json]      one timeline across every linked flow
  heai-flow stuck [--older 1h] [--json]           non-terminal flows nothing has moved or touched in that long
  heai-flow settle                                expire states, fire guards, rebuild views; run the actions
  heai-flow check [--fix]                         definitions, journals, snapshots and indexes; --fix rebuilds the views; runs no action
  heai-flow reindex [--repin]                     rebuild every snapshot and both indexes from the journals; runs no action;
                                             --repin first rewrites every open flow's pinned definition from the file under flows/
  heai-flow definitions                           every definition in the flows directory

Options, on every command:
  --dir <path>         the project directory, where scripts run (default: HEAI_DIR, else the current directory)
  --config <path>      the configuration (default: .heai/flow.yaml under the project directory when .heai exists, else flow.yaml)
  --state <dir>        where flows live (default: HEAI_FLOW_STATE, else flow beside the configuration)
  --definition <path>  (start) a definition file outside the flows directory
  --by <who>           who makes the move (default: human)
  --json               print JSON
  --help

Every state entered runs the script its definition names, detached, in the project directory.

Exit codes: 0 done; 1 answered no (a refused move, a lost race, a \`by\` the definition refuses, drift found by check); 2 bad usage, an unknown flow or definition, or a definition that does not validate.`

const COMMANDS = ['start', 'advance', 'touch', 'link', 'show', 'list', 'trace', 'stuck', 'settle', 'check', 'reindex', 'definitions'] as const

/**
 * Where everything is: the project directory from `--dir`, `HEAI_DIR` or the
 * current directory; the configuration under `.heai/` when that directory exists
 * there, else in the project directory; the state from `--state` or
 * `HEAI_FLOW_STATE`, else `flow` beside the configuration.
 */
export function resolvePaths(values: Record<string, string | undefined>, cwd = process.cwd(), env: Record<string, string | undefined> = process.env) {
  const dir = resolve(cwd, values['dir'] ?? env['HEAI_DIR'] ?? '.')
  const config = resolve(dir, values['config'] ?? join(existsSync(join(dir, '.heai')) ? '.heai' : '.', 'flow.yaml'))
  const state = resolve(dir, values['state'] ?? env['HEAI_FLOW_STATE'] ?? join(dirname(config), 'flow'))
  return { dir, state, config }
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length))
const when = (s: string | null): string => (s ? s.slice(0, 19).replace('T', ' ') : '-')
const fmtLinks = (s: Snapshot): string =>
  [...Object.entries(s.links).map(([k, v]) => `${k}=${v}`), ...(s.parent ? [`parent=${s.parent}`] : []), ...s.waitsOn.map((w) => `waits-on=${w}`)].join(' ')

function parseLinks(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of pairs) {
    const eq = p.indexOf('=')
    if (eq <= 0) throw new UsageError(`a link is name=value, not ${JSON.stringify(p)}`)
    out[p.slice(0, eq)] = p.slice(eq + 1)
  }
  return out
}

function parseData(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {}
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    throw new UsageError(`--data must be JSON: ${raw}`)
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new UsageError('--data must be a JSON object')
  return v as Record<string, unknown>
}

/** One journal line for the eye: the move, who made it, and the data with `links` flattened to `name=value`. */
const fmtAction = (a: Action): string => {
  const outcome = a.exit !== null ? `exit ${a.exit}` : a.pid === null ? 'not started' : 'running'
  return `${String(a.seq).padStart(3)}  ${when(a.startedAt)}  ${pad(a.state, 10)} ${a.run}  ${outcome}`
}

const fmtLine = (l: Line): string => {
  const move = l.event === 'link' ? 'link' : l.from === null ? `→ ${l.to}` : `${l.from} → ${l.to}`
  const data = Object.entries(l.data)
    .map(([k, v]) => (k === 'links' && v && typeof v === 'object' ? Object.entries(v as Record<string, string>).map(([a, b]) => `${a}=${b}`).join(' ') : `${k}=${Array.isArray(v) ? v.join(',') : typeof v === 'string' ? v : JSON.stringify(v)}`))
    .filter(Boolean)
    .join(' ')
  return `${pad(move, 24)} ${pad(l.by, 12)} ${data}${l.note ? `  (${l.note})` : ''}`.trimEnd()
}

function showFlow(store: Store, id: string): void {
  const f = store.show(id)
  const s = f.snapshot
  console.log(`flow        ${s.id}`)
  console.log(`definition  ${s.definition}`)
  console.log(`state       ${s.state}${s.terminal ? ' (terminal)' : ''}  since ${when(s.since)}${s.touchedAt ? `  touched ${when(s.touchedAt)}` : ''}${s.expiresAt ? `  expires ${when(s.expiresAt)}` : ''}`)
  if (Object.keys(s.links).length) console.log(`links       ${Object.entries(s.links).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  if (s.parent) console.log(`parent      ${s.parent}`)
  if (s.waitsOn.length) console.log(`waits on    ${s.waitsOn.map((w) => `${w}:${store.get(w)?.state ?? '?'}`).join(', ')}`)
  for (const p of f.problems) console.log(`problem     ${p}`)
  console.log('journal')
  for (const l of f.lines) console.log(`  ${String(l.seq).padStart(3)}  ${when(l.at)}  ${pad(l.event, 10)} ${fmtLine(l)}`)
  if (f.actions.length) {
    console.log('actions')
    for (const a of f.actions) console.log(`  ${fmtAction(a)}`)
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      state: { type: 'string' },
      config: { type: 'string' },
      definition: { type: 'string' },
      id: { type: 'string' },
      link: { type: 'string', multiple: true },
      parent: { type: 'string' },
      'waits-on': { type: 'string', multiple: true },
      by: { type: 'string' },
      note: { type: 'string' },
      data: { type: 'string' },
      seq: { type: 'string' },
      in: { type: 'string' },
      older: { type: 'string' },
      fix: { type: 'boolean', default: false },
      repin: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    }
  })
  if (values.help || !positionals.length) {
    process.stdout.write(USAGE + '\n')
    return values.help ? 0 : 2
  }
  const command = positionals[0] as (typeof COMMANDS)[number]
  if (!COMMANDS.includes(command)) throw new UsageError(`unknown command ${JSON.stringify(command)}`)
  const paths = resolvePaths({ dir: values.dir, state: values.state, config: values.config })
  const store = openStore({ dir: paths.state, configPath: paths.config, project: paths.dir })
  const by = values.by ?? 'human'
  const json = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + '\n')
  const needId = ['advance', 'touch', 'link', 'show', 'trace'].includes(command)
  if (needId && !positionals[1]) throw new UsageError(`${command} needs a flow id${command === 'trace' ? ' or name=value' : ''}`)

  // Every command settles first, so what it reads and prints is current -
  // except check, which reports the views as they are rather than after a
  // settle has quietly rebuilt them, and the commands that touch no flow.
  if (!['check', 'reindex', 'definitions'].includes(command)) store.settle()

  switch (command) {
    case 'start': {
      if (!positionals[1] && !values.definition) throw new UsageError('start needs a definition name, or --definition <path>')
      const r = store.start({
        definition: positionals[1] ?? values.definition!,
        definitionPath: values.definition,
        id: values.id,
        links: parseLinks(values.link ?? []),
        parent: values.parent,
        waitsOn: values['waits-on'] ?? [],
        by,
        note: values.note
      })
      if (values.json) json({ id: r.id, ...r.line })
      else console.log(r.id)
      return 0
    }

    case 'advance': {
      const event = positionals[2]
      if (!event) throw new UsageError('advance needs an event')
      if ((RESERVED_EVENTS as readonly string[]).includes(event)) throw new UsageError(`${event} is an event the journal writes itself; use flow ${event === 'touch' ? 'touch' : 'start'}`)
      let seq: number | undefined
      if (values.seq !== undefined) {
        seq = Number.parseInt(values.seq, 10)
        if (!Number.isFinite(seq)) throw new UsageError('--seq must be a number')
      }
      const line = store.advance(positionals[1]!, { event, data: parseData(values.data), by, note: values.note, seq })
      process.stdout.write(JSON.stringify(line) + '\n')
      return 0
    }

    case 'touch': {
      const s = store.touch(positionals[1]!)
      console.log(`Touched ${s.id} at ${s.touchedAt}${s.expiresAt ? `; expires ${s.expiresAt}` : ''}`)
      return 0
    }

    case 'link': {
      const links = parseLinks(positionals.slice(2))
      const line = store.link(positionals[1]!, { links, parent: values.parent, waitsOn: values['waits-on'] }, by, values.note)
      if (line) process.stdout.write(JSON.stringify(line) + '\n')
      else console.log('Nothing to link: every link given is already recorded')
      return 0
    }

    case 'show': {
      if (values.json) {
        const f = store.show(positionals[1]!)
        json({ ...f.snapshot, hooks: f.definition.hooks, problems: f.problems, journal: f.lines, actions: f.actions })
      } else showFlow(store, positionals[1]!)
      return 0
    }

    case 'list': {
      const [linkPair] = Object.entries(parseLinks(values.link ?? []))
      const flows = store.list({
        definition: positionals[1],
        state: values.in,
        link: linkPair ? { name: linkPair[0], value: linkPair[1] } : undefined
      })
      if (values.json) json(flows)
      else if (!flows.length) console.log('(no flows)')
      else {
        const w = Math.max(4, ...flows.map((f) => f.id.length))
        const d = Math.max(10, ...flows.map((f) => f.definition.length))
        for (const f of flows) console.log(`${pad(f.id, w)}  ${pad(f.definition, d)}  ${pad(f.state, 12)}  ${when(f.since)}  ${fmtLinks(f)}`.trimEnd())
      }
      return 0
    }

    case 'trace': {
      const t = store.trace(positionals[1]!)
      if (values.json) json(t)
      else {
        const w = Math.max(4, ...t.flows.map((f) => f.id.length))
        const d = Math.max(4, ...t.flows.map((f) => f.definition.length))
        for (const l of t.lines) console.log(`${when(l.at)}  ${pad(l.id, w)}  ${pad(l.definition, d)}  ${fmtLine(l)}`)
      }
      return 0
    }

    case 'stuck': {
      const older = parseDuration(values.older ?? '1h')
      if (older === null) throw new UsageError('--older must be a duration like 30m or 2h')
      const entries = store.stuck(older)
      if (values.json) json(entries)
      else if (!entries.length) console.log(`Nothing stuck for ${formatDuration(older)} or longer`)
      else {
        let group = ''
        for (const e of entries) {
          const g = `${e.flow.definition} / ${e.flow.state}`
          if (g !== group) console.log(`${group ? '\n' : ''}${g}`)
          group = g
          const waits = e.waits.length ? `  waits on ${e.waits.map((w) => `${w.id}:${w.state ?? 'missing'}`).join(', ')}` : ''
          console.log(`  ${e.flow.id}  idle ${humanize(e.idleMs)}  ${fmtLinks(e.flow)}${waits}`.trimEnd())
        }
      }
      return 0
    }

    case 'settle': {
      const notes = store.settle()
      for (const n of notes) console.log(n)
      if (!notes.length) console.log('Nothing to settle')
      return 0
    }

    case 'check': {
      let problems = store.check()
      if (values.fix && problems.length) {
        const n = store.reindex()
        console.log(`Rebuilt ${n} snapshot${n === 1 ? '' : 's'} and both indexes`)
        problems = store.check()
      }
      if (values.json) json(problems)
      else if (!problems.length) console.log('No drift: every snapshot and index entry matches its journal')
      else for (const p of problems) console.log(p.id ? `${p.id}: ${p.message}` : p.message)
      return problems.length ? 1 : 0
    }

    case 'reindex': {
      if (values.repin) {
        const r = store.repin()
        const open = r.repinned.length + r.current.length
        console.log(`Repinned ${r.repinned.length} of ${open} open flow${open === 1 ? '' : 's'}${r.current.length ? ` (${r.current.length} already current)` : ''}`)
      }
      const n = store.reindex()
      console.log(`Rebuilt ${n} snapshot${n === 1 ? '' : 's'} and both indexes`)
      return 0
    }

    case 'definitions': {
      const defs = store.definitions()
      if (values.json) json(defs.map((d) => ({ name: d.name, path: d.path, problem: d.problem, states: d.definition?.states ?? null })))
      else if (!defs.length) console.log(`(no definitions in ${store.flowsDir()})`)
      else for (const d of defs) console.log(`${pad(d.name, 12)} ${pad(d.path, 48)}  ${d.definition ? d.definition.states.join(' ') : `PROBLEM ${d.problem}`}`)
      return 0
    }
  }
}

/** Run only when this file is the program, so a test can import resolvePaths without running a command. */
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)
  } catch {
    return false
  }
})()

if (isMain) main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    if (e instanceof UsageError) {
      process.stderr.write(`flow: ${e.message}\n`)
      process.exitCode = 2
    } else if (e instanceof FlowError) {
      process.stderr.write(`flow: ${e.message}\n`)
      process.exitCode = e.code === 'not-found' ? 2 : 1
    } else if (e instanceof Error && (e as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`flow: ${e.message}\n`)
      process.exitCode = 2
    } else {
      process.stderr.write(`flow: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
      process.exitCode = 2
    }
  }
)

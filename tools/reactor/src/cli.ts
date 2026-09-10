#!/usr/bin/env node
// The commands. Each builds one engine over the files and calls it; nothing
// is remembered between commands but the state directory.

import { parseArgs } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatDuration, loadConfig, parseDuration, type Rule } from './config.ts'
import { isRecord, ReactorError, UsageError } from './errors.ts'
import { Log, type Event } from './events.ts'
import { resolvePaths } from './paths.ts'
import { Engine, type Decision } from './reactor.ts'

const USAGE = `reactor - reacts to things that happen by running a script with the event in its environment

  reactor status [--json]                          sources and their cursors, rules and their last action, the last hour
  reactor tick                                     one pass: poll every source once, run the rules, exit
  reactor serve [--port 4949] [--host 127.0.0.1]   the daemon: schedules, polls, the webhook receiver
  reactor emit <source> <kind> [--key <key>] [--payload '<json>' | --payload -] [--at <iso>] [--act]
                                                   one event into a cli source; --act runs the rules for it now
  reactor events [--since 24h] [--source s] [--kind k] [--json]
  reactor retry <event-id>                         run every rule for one event again, ignoring dedupe
  reactor replay --since <t> [--rule <r>] [--dry-run]
  reactor test <rule> --event <file.json>          one rule against one event, dry

Options, on every command:
  --dir <path>         the project directory (default: the current directory; HEAI_DIR)
  --config <path>      the sources and rules (default: .heai/reactor.yaml under --dir when .heai exists, else reactor.yaml)
  --state <dir>        where events, actions, cursors and keys live (default: reactor beside the configuration; HEAI_REACTOR_STATE)
  --json               print JSON
  --help

Exit codes: 0 done; 1 a rule refused or an action failed, or (test) the rule does not match; 2 bad usage, a configuration that does not read, an event this tool cannot take, or a source that could not start.`

const COMMANDS = ['status', 'tick', 'serve', 'emit', 'events', 'retry', 'replay', 'test'] as const

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length))
const when = (s: string | null | undefined): string => (s ? s.slice(0, 19).replace('T', ' ') : '-')

/** `24h` or an ISO time. */
function parseSince(v: string | undefined, fallback: string, now: Date): Date {
  const raw = v ?? fallback
  const d = parseDuration(raw)
  if (d !== null) return new Date(now.getTime() - d)
  const t = Date.parse(raw)
  if (!Number.isFinite(t)) throw new UsageError(`--since must be a duration like 24h or an ISO time, not ${JSON.stringify(raw)}`)
  return new Date(t)
}

const matchSummary = (r: Rule): string =>
  [r.on.source && `source=${r.on.source}`, r.on.kind && `kind=${r.on.kind}`, r.on.cron && `cron="${r.on.cron}"`, ...Object.entries(r.on.fields).map(([k, v]) => `${k}=${JSON.stringify(v)}`)]
    .filter(Boolean)
    .join(' ') || '(everything)'

function printDecisions(ds: Decision[]): void {
  for (const d of ds) console.log(`${pad(d.event, 24)} ${pad(d.rule, 28)} ${pad(d.verdict, 10)} ${d.description}${d.record?.error ? `  PROBLEM ${d.record.error}` : ''}`)
}

function readEventFile(path: string, now: Date): Event {
  if (!existsSync(path)) throw new UsageError(`no event file at ${path}`)
  let v: unknown
  try {
    v = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new UsageError(`${path} is not JSON`)
  }
  if (!isRecord(v) || typeof v['source'] !== 'string' || typeof v['kind'] !== 'string') throw new UsageError(`${path} must be an event: { source, kind, key, payload }`)
  return { id: typeof v['id'] === 'string' ? v['id'] : 'test', source: v['source'], kind: v['kind'], key: typeof v['key'] === 'string' ? v['key'] : 'test', at: typeof v['at'] === 'string' ? v['at'] : now.toISOString(), payload: isRecord(v['payload']) ? v['payload'] : {} }
}

/** `--payload`: a JSON object as text, or `-` for stdin; absent is an empty payload. */
function readPayload(v: string | undefined): Record<string, unknown> {
  if (v === undefined) return {}
  const text = v === '-' ? readFileSync(0, 'utf8') : v
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new UsageError(`--payload must be a JSON object${v === '-' ? '; stdin is not JSON' : `, not ${JSON.stringify(v)}`}`)
  }
  if (!isRecord(doc)) throw new UsageError('--payload must be a JSON object, not a list or a scalar')
  return doc
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      state: { type: 'string' },
      config: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      since: { type: 'string' },
      source: { type: 'string' },
      kind: { type: 'string' },
      rule: { type: 'string' },
      event: { type: 'string' },
      key: { type: 'string' },
      payload: { type: 'string' },
      at: { type: 'string' },
      act: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
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
  const config = loadConfig(paths.config)
  const log = new Log(paths.state)
  const engine = new Engine({ paths, config, log })
  const json = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + '\n')
  const now = engine.now()

  switch (command) {
    case 'status': {
      await engine.loadSources()
      const hour = new Date(now.getTime() - 3_600_000)
      const recent = log.read({ since: new Date(now.getTime() - 86_400_000) })
      const actions = log.actions()
      const lastActionOf = (rule: string) => actions.filter((a) => a.rule === rule).at(-1) ?? null
      const sources = engine.sources.map((s) => ({
        name: s.name,
        type: s.type,
        every: s.every,
        listens: s.listener?.path ?? null,
        emits: Boolean(s.emit),
        cursor: s.describe(engine.context(s)),
        lastEvent: recent.filter((e) => e.source === s.name).at(-1)?.at ?? null,
        lastHour: recent.filter((e) => e.source === s.name && Date.parse(e.at) >= hour.getTime()).length
      }))
      const rules = config.rules.map((r) => {
        const st = log.ruleState(r.name)
        return { name: r.name, on: matchSummary(r), run: r.run, debounce: r.debounce, limit: r.limit, repeat: r.repeat, lastAction: lastActionOf(r.name), pending: st.pending, window: st.window }
      })
      if (values.json) json({ state: paths.state, config: config.path, sources, rules, events: { lastHour: recent.filter((e) => Date.parse(e.at) >= hour.getTime()).length, lastDay: recent.length } })
      else {
        console.log(`state   ${paths.state}\nconfig  ${config.path ?? `${paths.config} (absent)`}\n`)
        console.log('sources')
        if (!sources.length) console.log('  (none)')
        for (const s of sources) console.log(`  ${pad(s.name, 16)} ${pad(s.type, 9)} ${pad(s.every ? `every ${formatDuration(s.every)}` : s.listens ? `listens ${s.listens}` : s.emits ? 'from reactor emit' : 'idle', 22)} last event ${when(s.lastEvent)}  ${s.cursor}`)
        console.log('\nrules')
        if (!rules.length) console.log('  (none)')
        for (const r of rules) console.log(`  ${pad(r.name, 24)} on ${pad(r.on, 40)} last ${when(r.lastAction?.at)}${r.lastAction ? (r.lastAction.ok ? ' ok' : ` PROBLEM ${r.lastAction.error}`) : ''}${r.pending ? `  debouncing until ${when(r.pending.until)}` : ''}`)
        console.log(`\nevents  ${recent.filter((e) => Date.parse(e.at) >= hour.getTime()).length} in the last hour, ${recent.length} in the last day`)
      }
      return 0
    }

    case 'tick': {
      const r = await engine.tick()
      for (const s of r.skipped) console.log(`${s}: needs a listener and cannot run under tick; run reactor serve`)
      console.log(`${r.events.length} event${r.events.length === 1 ? '' : 's'}, ${r.decisions.length} decision${r.decisions.length === 1 ? '' : 's'}`)
      printDecisions(r.decisions)
      return r.decisions.some((d) => d.verdict === 'failed') ? 1 : 0
    }

    case 'serve': {
      let port: number | undefined
      if (values.port !== undefined) {
        port = Number.parseInt(values.port, 10)
        if (!Number.isFinite(port)) throw new UsageError('--port must be a number')
      }
      const s = await engine.serve(port, values.host)
      console.log(`reactor serving ${engine.sources.length} source${engine.sources.length === 1 ? '' : 's'} from ${paths.state}${s.port ? `; receiver on port ${s.port}` : ''}`)
      await new Promise<void>((resolve) => {
        const stop = () => {
          console.log('reactor stopping')
          void s.stop().then(resolve)
        }
        process.once('SIGINT', stop)
        process.once('SIGTERM', stop)
      })
      return 0
    }

    case 'emit': {
      const [, source, kind] = positionals
      if (!source || !kind) throw new UsageError('emit needs a source and a kind: reactor emit <source> <kind>')
      if (values.key !== undefined && !values.key) throw new UsageError('--key must not be empty')
      let at: string | null = null
      if (values.at !== undefined) {
        const t = Date.parse(values.at)
        if (!Number.isFinite(t)) throw new UsageError(`--at must be an ISO time, not ${JSON.stringify(values.at)}`)
        at = new Date(t).toISOString()
      }
      const payload = readPayload(values.payload)
      const { event, decisions } = await engine.emit(source, { kind, key: values.key ?? null, payload, at }, values.act)
      if (values.json) json(values.act ? { event, decisions } : event)
      else {
        console.log(event.id)
        printDecisions(decisions)
      }
      return decisions.some((d) => d.verdict === 'failed') ? 1 : 0
    }

    case 'events': {
      const since = parseSince(values.since, '24h', now)
      const events = log.read({ since, source: values.source, kind: values.kind })
      if (values.json) json(events)
      else if (!events.length) console.log('(no events)')
      else for (const e of events) console.log(`${when(e.at)}  ${pad(e.id, 24)} ${pad(e.source, 12)} ${pad(e.kind, 24)} ${e.key}`)
      return 0
    }

    case 'retry': {
      if (!positionals[1]) throw new UsageError('retry needs an event id')
      const ds = await engine.retry(positionals[1])
      if (values.json) json(ds)
      else printDecisions(ds)
      return ds.some((d) => d.verdict === 'failed') ? 1 : 0
    }

    case 'replay': {
      if (!values.since) throw new UsageError('replay needs --since <duration or time>')
      const ds = await engine.replay(parseSince(values.since, '24h', now), values.rule ?? null, values['dry-run'])
      if (values.json) json(ds)
      else if (!ds.length) console.log('(nothing to replay)')
      else printDecisions(ds)
      return ds.some((d) => d.verdict === 'failed') ? 1 : 0
    }

    case 'test': {
      if (!positionals[1]) throw new UsageError('test needs a rule name')
      if (!values.event) throw new UsageError('test needs --event <file.json>')
      const event = readEventFile(resolve(values.event), now)
      const d = engine.test(positionals[1], event)
      if (values.json) json(d)
      else if (d) console.log(`${d.rule} matches: would ${d.description}`)
      else console.log(`${positionals[1]} does not match`)
      return d ? 0 : 1
    }
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    if (e instanceof UsageError) {
      process.stderr.write(`reactor: ${e.message}\n`)
      process.exitCode = 2
    } else if (e instanceof ReactorError) {
      process.stderr.write(`reactor: ${e.message}\n`)
      process.exitCode = 1
    } else if (e instanceof Error && (e as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`reactor: ${e.message}\n`)
      process.exitCode = 2
    } else {
      process.stderr.write(`reactor: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
      process.exitCode = 2
    }
  }
)

// The engine: sources in, events logged, rules matched, commands
// run through the pool and recorded. `tick` is one pass over everything;
// `serve` is the same on timers with the receiver mounted; `emit` is one
// event from the command line. Nothing here is remembered between passes
// that is not a file under the state directory.

import { formatDuration, type Config, type Rule, type SourceConfig } from './config.ts'
import { ReactorError, UsageError } from './errors.ts'
import type { ActionRecord, Event, Log, RawEvent } from './events.ts'
import type { Paths } from './paths.ts'
import { Pool } from './pool.ts'
import { createReceiver } from './receiver.ts'
import { matchEvent, renderCommand } from './rules.ts'
import { describe, run } from './run.ts'
import { contextFor, loadModuleSource, type Source, type SourceContext } from './source.ts'
import { create as schedule } from './sources/schedule.ts'
import { create as git } from './sources/git.ts'
import { create as webhook } from './sources/webhook.ts'
import { create as poll } from './sources/poll.ts'
import { create as cli } from './sources/cli.ts'
import { create as dir } from './sources/dir.ts'

const BUILT_IN: Record<string, (c: SourceConfig) => Source> = { schedule, git, webhook, poll, cli, dir }

export type Verdict = 'acted' | 'failed' | 'deduped' | 'debounced' | 'limited' | 'dry'

export interface Decision {
  event: string
  rule: string
  verdict: Verdict
  /** What was or would be done. */
  description: string
  record: ActionRecord | null
}

export interface EngineOptions {
  paths: Paths
  config: Config
  log: Log
  now?: () => Date
  note?: (line: string) => void
}

export interface HandleOptions {
  /** Ignore dedupe and debounce: `retry`. */
  force?: boolean
  /** Only this rule. */
  only?: string | null
  dryRun?: boolean
}

/** What `reactor emit` hands over: the kind, and the rest when given. */
export interface Emission {
  kind: string
  key?: string | null
  payload?: Record<string, unknown>
  at?: string | null
}

export class Engine {
  readonly paths: Paths
  readonly config: Config
  readonly log: Log
  readonly now: () => Date
  readonly note: (line: string) => void
  readonly pool: Pool
  sources: Source[] = []

  constructor(o: EngineOptions) {
    this.paths = o.paths
    this.config = o.config
    this.log = o.log
    this.now = o.now ?? (() => new Date())
    this.note = o.note ?? ((line) => process.stderr.write(`reactor: ${line}\n`))
    this.pool = new Pool(o.config.concurrency)
  }

  async loadSources(): Promise<Source[]> {
    this.sources = []
    for (const c of this.config.sources) {
      const factory = BUILT_IN[c.type]
      if (factory) this.sources.push(factory(c))
      else if (c.type.includes('/') || c.type.endsWith('.ts') || c.type.endsWith('.js')) this.sources.push(await loadModuleSource(c, this.paths.configDir))
      else throw new UsageError(`source ${c.name}: unknown type ${c.type}; the types are ${Object.keys(BUILT_IN).join(', ')}, or a module path`)
    }
    return this.sources
  }

  context(source: Source): SourceContext {
    return contextFor(source.name, this.log, { paths: this.paths, config: this.config, now: this.now }, this.note)
  }

  /** Poll one source and log what it saw. */
  async pollSource(source: Source): Promise<Event[]> {
    const raws = await source.poll(this.context(source))
    return raws.map((r) => this.log.append(source.name, r))
  }

  /** Log an event a listener received. */
  receive(source: Source, raw: RawEvent): Event {
    return this.log.append(source.name, raw)
  }

  /** One event from the command line: the source checks it, the log takes it, and with `act` the rules run for it at once. The key defaults to the id. */
  async emit(name: string, e: Emission, act: boolean): Promise<{ event: Event; decisions: Decision[] }> {
    if (!this.sources.length) await this.loadSources()
    const source = this.sources.find((s) => s.name === name)
    if (!source) throw new UsageError(`no source ${name} in ${this.config.path ?? this.paths.config}${this.sources.length ? `; the sources are ${this.sources.map((s) => s.name).join(', ')}` : ''}`)
    if (!source.emit) throw new UsageError(`source ${name} is a ${source.type} source, not cli; only a cli source takes emit`)
    const at = e.at ?? this.now().toISOString()
    const id = this.log.newId(at)
    const raw: RawEvent = { kind: e.kind, key: e.key ?? id, at, payload: e.payload ?? {} }
    const ctx = this.context(source)
    source.emit(ctx, raw, id)
    const event = this.log.append(source.name, raw, id)
    if (!act) return { event, decisions: [] }
    const decisions = await this.handle(event)
    await this.pool.idle()
    source.handled?.(ctx, id)
    return { event, decisions }
  }

  /** The events a source took and has not handled yet - emitted without --act - through the rules, in order, each dropped from the cursor once decided. */
  async drainPending(source: Source): Promise<{ events: Event[]; decisions: Decision[] }> {
    const events: Event[] = []
    const decisions: Decision[] = []
    if (!source.pending || !source.handled) return { events, decisions }
    const ctx = this.context(source)
    for (const id of source.pending(ctx)) {
      const event = this.log.get(id)
      if (event) {
        events.push(event)
        decisions.push(...(await this.handle(event)))
      } else this.note(`${source.name}: pending event ${id} is not in the log; dropped`)
      source.handled(ctx, id)
    }
    return { events, decisions }
  }

  /** The rules an event has, in the order they run. */
  candidates(event: Event, only: string | null): Rule[] {
    return this.config.rules.filter((rule) => (!only || rule.name === only) && matchEvent(rule.on, event))
  }

  /** Every rule for one event; resolves when all have run. */
  handle(event: Event, opts: HandleOptions = {}): Promise<Decision[]> {
    return Promise.all(this.candidates(event, opts.only ?? null).map((rule) => this.decide(rule, event, opts)))
  }

  private decide(rule: Rule, event: Event, opts: HandleOptions): Promise<Decision> {
    const base = { event: event.id, rule: rule.name }
    let command: string
    try {
      command = renderCommand(rule.run, event, rule.name)
    } catch (e) {
      const record = this.log.record({ ...base, action: 'run', at: this.now().toISOString(), ok: false, outcome: {}, error: (e as Error).message })
      return Promise.resolve({ ...base, verdict: 'failed', description: (e as Error).message, record })
    }
    const description = describe(command)
    if (!opts.force && !rule.repeat && this.log.hasKey(rule.name, event.key)) return Promise.resolve({ ...base, verdict: 'deduped', description, record: null })
    if (opts.dryRun) return Promise.resolve({ ...base, verdict: 'dry', description, record: null })
    if (rule.debounce && !opts.force) {
      const st = this.log.ruleState(rule.name)
      const now = this.now()
      st.pending = { event: event.id, key: event.key, since: st.pending?.since ?? now.toISOString(), until: new Date(now.getTime() + rule.debounce).toISOString(), events: [...(st.pending?.events ?? []), event.id] }
      this.log.setRuleState(rule.name, st)
      return Promise.resolve({ ...base, verdict: 'debounced', description, record: null })
    }
    return this.execute(rule, event, command, [])
  }

  /** Check the limit, run the command through the pool, record the outcome, mark the keys. */
  private execute(rule: Rule, event: Event, command: string, collapsed: string[]): Promise<Decision> {
    const base = { event: event.id, rule: rule.name }
    const description = describe(command)
    if (rule.limit) {
      const st = this.log.ruleState(rule.name)
      const now = this.now()
      if (!st.window || now.getTime() - Date.parse(st.window.start) >= rule.limit.windowMs) st.window = { start: now.toISOString(), count: 0, noted: false }
      if (st.window.count >= rule.limit.count) {
        const limit = `${rule.limit.count}/${formatDuration(rule.limit.windowMs)}`
        const record = this.log.record({ ...base, action: 'run', at: now.toISOString(), ok: false, outcome: { limited: true, limit, window: st.window.start }, error: `limit ${limit} hit; not acted, not deduped` })
        if (!st.window.noted) {
          st.window.noted = true
          this.note(`rule ${rule.name}: limit ${limit} hit since ${st.window.start}; further events in the window are recorded as limited, not acted and not deduped, and \`reactor replay --since ${st.window.start} --rule ${rule.name}\` acts on them`)
        }
        this.log.setRuleState(rule.name, st)
        return Promise.resolve({ ...base, verdict: 'limited', description, record })
      }
      this.log.setRuleState(rule.name, st)
    }
    return this.pool.run(async () => {
      const o = await run(command, { event, rule: rule.name, paths: this.paths, log: this.log, timeout: rule.timeout })
      const record: ActionRecord = { ...base, action: 'run', at: this.now().toISOString(), ok: o.ok, outcome: o.outcome, error: o.error }
      if (collapsed.length) record.collapsed = collapsed
      this.log.record(record)
      this.log.markKey(rule.name, event.key)
      const st = this.log.ruleState(rule.name)
      st.lastAction = record.at
      if (rule.limit && st.window) st.window.count++
      this.log.setRuleState(rule.name, st)
      return { ...base, verdict: o.ok ? 'acted' : 'failed', description, record }
    })
  }

  /** Every debounce whose window has closed fires once, on the last event of the burst. */
  async flushDebounces(): Promise<Decision[]> {
    const out: Promise<Decision>[] = []
    for (const rule of this.config.rules) {
      if (!rule.debounce) continue
      const st = this.log.ruleState(rule.name)
      if (!st.pending || this.now().getTime() < Date.parse(st.pending.until)) continue
      const pending = st.pending
      st.pending = null
      this.log.setRuleState(rule.name, st)
      const event = this.log.get(pending.event)
      if (!event) {
        this.note(`rule ${rule.name}: debounced event ${pending.event} is not in the log; dropped`)
        continue
      }
      const collapsed = pending.events.filter((id) => id !== event.id)
      for (const id of collapsed) {
        const e = this.log.get(id)
        if (e) this.log.markKey(rule.name, e.key)
      }
      let command: string
      try {
        command = renderCommand(rule.run, event, rule.name)
      } catch (e) {
        this.log.record({ event: event.id, rule: rule.name, action: 'run', at: this.now().toISOString(), ok: false, outcome: {}, error: (e as Error).message })
        continue
      }
      out.push(this.execute(rule, event, command, collapsed))
    }
    return Promise.all(out)
  }

  /** One pass: every pollable source once, every pending emission, every rule, the debounces, then wait for the pool. A source that cannot be read is a note; a listener is skipped and named; a cli source has nothing to poll, only what was emitted since the last pass. */
  async tick(): Promise<{ events: Event[]; decisions: Decision[]; skipped: string[] }> {
    if (!this.sources.length) await this.loadSources()
    const events: Event[] = []
    const skipped: string[] = []
    const pending: Promise<Decision[]>[] = []
    for (const source of this.sources) {
      if (source.every === null) {
        if (source.listener) skipped.push(source.name)
        else if (source.pending) {
          const d = await this.drainPending(source)
          events.push(...d.events)
          pending.push(Promise.resolve(d.decisions))
        }
        continue
      }
      let seen: Event[]
      try {
        seen = await this.pollSource(source)
      } catch (e) {
        if (e instanceof UsageError) throw e
        this.note(`${source.name}: ${(e as Error).message}`)
        continue
      }
      events.push(...seen)
      for (const e of seen) pending.push(this.handle(e))
    }
    pending.push(this.flushDebounces())
    const decisions = (await Promise.all(pending)).flat()
    await this.pool.idle()
    return { events, decisions, skipped }
  }

  /** The daemon: each source on its interval, the pending emissions and the debounces every second, the receiver for the webhooks. Returns a stop function. */
  async serve(port?: number, host?: string): Promise<{ stop: () => Promise<void>; port: number | null }> {
    if (!this.sources.length) await this.loadSources()
    const timers: NodeJS.Timeout[] = []
    let stopped = false
    const loop = (source: Source, every: number) => {
      const step = async () => {
        if (stopped) return
        try {
          for (const e of await this.pollSource(source)) void this.handle(e).catch((err: Error) => this.note(`${source.name}: ${err.message}`))
        } catch (e) {
          this.note(`${source.name}: ${(e as Error).message}`)
        }
        if (!stopped) timers.push(setTimeout(step, every))
      }
      void step()
    }
    for (const s of this.sources) if (s.every !== null) loop(s, s.every)
    const flush = async () => {
      if (stopped) return
      try {
        for (const s of this.sources) if (s.every === null && s.pending) await this.drainPending(s)
        await this.flushDebounces()
      } catch (e) {
        this.note((e as Error).message)
      }
      if (!stopped) timers.push(setTimeout(flush, 1000))
    }
    void flush()
    const listeners = this.sources.filter((s) => s.listener)
    let server: ReturnType<typeof createReceiver> | null = null
    let bound: number | null = null
    if (listeners.length) {
      server = createReceiver(this, listeners)
      const p = port ?? this.config.receiver.port
      const h = host ?? this.config.receiver.host
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject)
        server!.listen(p, h, () => resolve())
      })
      const addr = server.address()
      bound = addr && typeof addr === 'object' ? addr.port : p
      this.note(`receiver listening on ${h}:${bound} for ${listeners.map((s) => s.listener!.path).join(', ')}`)
    }
    return {
      port: bound,
      stop: async () => {
        stopped = true
        for (const t of timers) clearTimeout(t)
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
        await this.pool.idle()
      }
    }
  }

  /** Re-run every rule for one event, ignoring dedupe and debounce. */
  async retry(id: string): Promise<Decision[]> {
    const event = this.log.get(id)
    if (!event) throw new UsageError(`no event ${id} in ${this.paths.state}`)
    const d = await this.handle(event, { force: true })
    await this.pool.idle()
    if (!d.length) throw new ReactorError(`no rule matches event ${id}`)
    return d
  }

  /** Run the rules over logged events again; dedupe still holds, so only what never acted acts. */
  async replay(since: Date, only: string | null, dryRun: boolean): Promise<Decision[]> {
    if (only && !this.config.rules.some((r) => r.name === only)) throw new UsageError(`no rule ${only} in ${this.paths.config}`)
    const out: Promise<Decision[]>[] = []
    for (const e of this.log.read({ since })) out.push(this.handle(e, { only, dryRun }))
    const d = (await Promise.all(out)).flat()
    await this.pool.idle()
    return d
  }

  /** One rule against one event, dry: does it match, and what would it do. */
  test(name: string, event: Event): Decision | null {
    const rule = this.config.rules.find((r) => r.name === name)
    if (!rule) throw new UsageError(`no rule ${name} in ${this.paths.config}`)
    if (!matchEvent(rule.on, event)) return null
    return { event: event.id, rule: rule.name, verdict: 'dry', description: describe(renderCommand(rule.run, event, rule.name)), record: null }
  }
}

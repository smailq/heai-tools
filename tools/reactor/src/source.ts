// The source contract. A source is a plugin: given its options and a context
// it can read and write its cursor through, it polls once and hands back the
// events it saw with stable keys. A webhook source cannot poll; it exposes a
// listener instead, which `serve` mounts and `tick` reports it cannot run.
// A cli source does neither: it takes events from `reactor emit`. A module
// path exporting `create` is another source.

import { pathToFileURL } from 'node:url'
import type { Config, SourceConfig } from './config.ts'
import { isRecord, UsageError } from './errors.ts'
import type { Log, RawEvent } from './events.ts'
import type { Paths } from './paths.ts'

export interface SourceContext {
  paths: Paths
  /** The whole configuration, for a module source that wants more than its own options. */
  config: Config
  now: () => Date
  cursor<T>(): T | null
  setCursor(value: unknown): void
  /** A line for stderr: a missed slot, a dropped post, a poll that failed. */
  note(message: string): void
}

export interface Listener {
  path: string
  /** Turn one post into an event, or null with a reason when it is dropped. */
  receive(headers: Record<string, string>, body: Buffer): { event: RawEvent } | { drop: string }
}

export interface Source {
  name: string
  type: string
  /** How often `serve` polls it, in ms; null for a source that only listens. */
  every: number | null
  /** One pass; the events it saw. */
  poll(ctx: SourceContext): Promise<RawEvent[]>
  listener: Listener | null
  /** What the cursor says, for `status`. */
  describe(ctx: SourceContext): string
  /** Take one event from `reactor emit`, about to be logged under `id`: refuse it with a UsageError, or list it as pending in the cursor; absent on a source that does not take them. */
  emit?(ctx: SourceContext, raw: RawEvent, id: string): void
  /** The ids of events taken and not yet handled, oldest first; a tick or a serve pass runs the rules over them. */
  pending?(ctx: SourceContext): string[]
  /** One of those has been handled; drop it from the cursor. */
  handled?(ctx: SourceContext, id: string): void
}

export type SourceFactory = (config: SourceConfig) => Source

export function contextFor(name: string, log: Log, base: Omit<SourceContext, 'cursor' | 'setCursor' | 'note'>, note: (m: string) => void): SourceContext {
  return { ...base, cursor: <T>() => log.cursor<T>(name), setCursor: (v) => log.setCursor(name, v), note: (m) => note(`${name}: ${m}`) }
}

export function optDuration(options: Record<string, unknown>, key: string, fallback: number, parse: (v: unknown) => number | null, where: string): number {
  if (options[key] === undefined) return fallback
  const v = parse(options[key])
  if (v === null) throw new UsageError(`${where}: ${key} must be a duration like 60s or 5m`)
  return v
}

export function optString(options: Record<string, unknown>, key: string, where: string, required = false): string | null {
  const v = options[key]
  if (v === undefined || v === null) {
    if (required) throw new UsageError(`${where}: ${key} is required`)
    return null
  }
  if (typeof v !== 'string' || !v) throw new UsageError(`${where}: ${key} must be a string`)
  return v
}

export function rejectUnknown(options: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(options)) if (!allowed.includes(k)) throw new UsageError(`${where}: unknown option ${JSON.stringify(k)}; the options are ${allowed.join(', ')}`)
}

/** A module path: `./sources/mine.ts`, exporting `create(config): Source`. */
export async function loadModuleSource(config: SourceConfig, from: string): Promise<Source> {
  const url = pathToFileURL(new URL(config.type, pathToFileURL(from + '/')).pathname).href
  let mod: unknown
  try {
    mod = await import(url)
  } catch (e) {
    throw new UsageError(`source ${config.name}: cannot load ${config.type}: ${(e as Error).message}`)
  }
  const create = isRecord(mod) ? (mod['create'] ?? (isRecord(mod['default']) ? mod['default']['create'] : mod['default'])) : undefined
  if (typeof create !== 'function') throw new UsageError(`source ${config.name}: ${config.type} must export create(config)`)
  const source = (create as SourceFactory)(config)
  if (!isRecord(source) || typeof source['poll'] !== 'function') throw new UsageError(`source ${config.name}: ${config.type} did not return a source`)
  return source
}

// A webhook: one path, one provider, one secret. It cannot poll; `serve`
// mounts its listener and `tick` reports it cannot run. The provider checks
// the signature and turns the body into { kind, key, payload }; an unsigned
// or unverifiable post is dropped with a reason and counted in the cursor.

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SourceConfig } from '../config.ts'
import { UsageError } from '../errors.ts'
import type { RawEvent } from '../events.ts'
import { optString, rejectUnknown, type Listener, type Source } from '../source.ts'
import { PROVIDERS, type Provider } from '../providers/index.ts'

export interface ReceiverCursor {
  received: number
  dropped: number
  lastReceived: string | null
  lastDrop: { at: string; reason: string } | null
}

/** `env:NAME`, `file:path`, or the secret itself. Null when it cannot be resolved, with the reason. */
export function resolveSecret(spec: string | null, dir: string): { secret: string | null; problem: string | null } {
  if (spec === null) return { secret: null, problem: null }
  if (spec.startsWith('env:')) {
    const v = process.env[spec.slice(4)]
    return v ? { secret: v, problem: null } : { secret: null, problem: `${spec} is not set` }
  }
  if (spec.startsWith('file:')) {
    const p = resolve(dir, spec.slice(5))
    if (!existsSync(p)) return { secret: null, problem: `${spec} does not exist` }
    return { secret: readFileSync(p, 'utf8').trim(), problem: null }
  }
  return { secret: spec, problem: null }
}

export function create(config: SourceConfig): Source {
  const where = `source ${config.name}`
  rejectUnknown(config.options, ['path', 'provider', 'secret', 'kind', 'key'], where)
  const path = optString(config.options, 'path', where, true)!
  if (!path.startsWith('/')) throw new UsageError(`${where}: path must start with /`)
  const providerName = optString(config.options, 'provider', where) ?? 'generic'
  const provider: Provider | undefined = PROVIDERS[providerName]
  if (!provider) throw new UsageError(`${where}: unknown provider ${providerName}; the providers are ${Object.keys(PROVIDERS).join(', ')}`)
  const secretSpec = optString(config.options, 'secret', where)
  const options = { kind: optString(config.options, 'kind', where), key: optString(config.options, 'key', where) }

  let dir = process.cwd()
  const listener: Listener = {
    path,
    receive(headers, body): { event: RawEvent } | { drop: string } {
      const { secret, problem } = resolveSecret(secretSpec, dir)
      if (problem) return { drop: problem }
      if (!secret) return { drop: 'no secret configured; every post is unverifiable' }
      const verdict = provider.verify(headers, body, secret)
      if (verdict !== true) return { drop: verdict }
      let doc: unknown
      try {
        doc = JSON.parse(body.toString('utf8'))
      } catch {
        return { drop: 'body is not JSON' }
      }
      const event = provider.parse(headers, doc, body, options)
      return event ? { event } : { drop: 'the provider could not read the body' }
    }
  }

  return {
    name: config.name,
    type: 'webhook',
    every: null,
    listener,
    describe(ctx) {
      dir = ctx.paths.dir
      const c = ctx.cursor<ReceiverCursor>()
      const { problem } = resolveSecret(secretSpec, dir)
      return `${path} ${providerName}; received ${c?.received ?? 0}, dropped ${c?.dropped ?? 0}${c?.lastReceived ? `; last ${c.lastReceived}` : ''}${problem ? `; PROBLEM ${problem}` : ''}`
    },
    async poll(ctx) {
      dir = ctx.paths.dir
      return []
    }
  }
}

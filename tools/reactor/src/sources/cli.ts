// A named source whose events come only from the command line: `reactor emit
// <source> <kind>` appends one and lists it as pending in the cursor. It has
// no interval and nothing to poll; the next tick or serve pass runs the rules
// over what is pending, in order, and `--act` does that at once. `kinds`
// restricts what may be emitted, any kind by default.

import type { SourceConfig } from '../config.ts'
import { UsageError } from '../errors.ts'
import type { RawEvent } from '../events.ts'
import { rejectUnknown, type Source, type SourceContext } from '../source.ts'

interface Cursor {
  emitted: number
  /** Event ids emitted and not yet handled, oldest first. */
  pending: string[]
  last: { id: string; kind: string; key: string; at: string } | null
}

const EMPTY: Cursor = { emitted: 0, pending: [], last: null }

export function create(config: SourceConfig): Source {
  const where = `source ${config.name}`
  rejectUnknown(config.options, ['kinds'], where)
  let kinds: string[] | null = null
  if (config.options['kinds'] !== undefined) {
    const raw = config.options['kinds']
    if (!Array.isArray(raw) || !raw.length || !raw.every((k) => typeof k === 'string' && k)) throw new UsageError(`${where}: kinds must be a list of kinds`)
    kinds = raw as string[]
  }
  const cursor = (ctx: SourceContext): Cursor => ({ ...EMPTY, pending: [], ...(ctx.cursor<Partial<Cursor>>() ?? {}) })

  return {
    name: config.name,
    type: 'cli',
    every: null,
    listener: null,
    describe(ctx) {
      const c = cursor(ctx)
      return `kinds ${kinds ? kinds.join(', ') : 'any'}; emitted ${c.emitted}, pending ${c.pending.length}${c.last ? `; last ${c.last.at} ${c.last.kind}` : ''}`
    },
    async poll() {
      return []
    },
    emit(ctx, raw, id) {
      if (kinds && !kinds.includes(raw.kind)) throw new UsageError(`${where}: kind ${raw.kind} is not allowed; the kinds are ${kinds.join(', ')}`)
      const c = cursor(ctx)
      c.emitted++
      c.pending.push(id)
      c.last = { id, kind: raw.kind, key: raw.key, at: raw.at ?? ctx.now().toISOString() }
      ctx.setCursor(c)
    },
    pending(ctx) {
      return cursor(ctx).pending
    },
    handled(ctx, id) {
      const c = cursor(ctx)
      c.pending = c.pending.filter((p) => p !== id)
      ctx.setCursor(c)
    }
  }
}

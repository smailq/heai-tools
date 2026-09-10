// A URL. Fetched on an interval; an event when what it answers changes:
// the status code, the value at a JSON pointer, or a hash of the body. A
// fetch that fails is a note in the cursor, and the next interval tries again.

import { parseDuration, type SourceConfig } from '../config.ts'
import { isRecord, UsageError } from '../errors.ts'
import { sha256, type RawEvent } from '../events.ts'
import { optDuration, optString, rejectUnknown, type Source, type SourceContext } from '../source.ts'

interface Cursor {
  value: unknown
  status: number | null
  checkedAt: string | null
  changedAt: string | null
  error: string | null
}

/** RFC 6901: `/status/indicator`, `~1` for `/`, `~0` for `~`. */
export function pointer(doc: unknown, ptr: string): unknown {
  if (ptr === '' || ptr === '/') return doc
  let v: unknown = doc
  for (const raw of ptr.split('/').slice(1)) {
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(v) && /^\d+$/.test(part)) v = v[Number(part)]
    else if (isRecord(v)) v = v[part]
    else return undefined
  }
  return v
}

export function create(config: SourceConfig): Source {
  const where = `source ${config.name}`
  rejectUnknown(config.options, ['url', 'every', 'watch', 'headers', 'timeout'], where)
  const url = optString(config.options, 'url', where, true)!
  const watch = optString(config.options, 'watch', where) ?? 'hash'
  if (watch !== 'status' && watch !== 'hash' && !watch.startsWith('/')) throw new UsageError(`${where}: watch must be status, hash, or a JSON pointer like /status/indicator`)
  const every = optDuration(config.options, 'every', 5 * 60_000, parseDuration, where)
  const timeout = optDuration(config.options, 'timeout', 30_000, parseDuration, where)
  const headers = config.options['headers']
  if (headers !== undefined && (!isRecord(headers) || !Object.values(headers).every((v) => typeof v === 'string'))) throw new UsageError(`${where}: headers must be a mapping of strings`)

  return {
    name: config.name,
    type: 'poll',
    every,
    listener: null,
    describe(ctx) {
      const c = ctx.cursor<Cursor>()
      return `${url} watch ${watch}; ${c?.checkedAt ? `checked ${c.checkedAt}, value ${JSON.stringify(c.value)}` : 'never checked'}${c?.error ? `; PROBLEM ${c.error}` : ''}`
    },
    async poll(ctx: SourceContext): Promise<RawEvent[]> {
      const cursor: Cursor = ctx.cursor<Cursor>() ?? { value: undefined, status: null, checkedAt: null, changedAt: null, error: null }
      const first = cursor.checkedAt === null
      const at = ctx.now().toISOString()
      let value: unknown
      let status: number
      try {
        const res = await fetch(url, { headers: (headers as Record<string, string> | undefined) ?? {}, signal: AbortSignal.timeout(timeout) })
        status = res.status
        const text = await res.text()
        if (watch === 'status') value = status
        else if (watch === 'hash') value = sha256(text)
        else {
          let doc: unknown
          try {
            doc = JSON.parse(text)
          } catch {
            throw new Error(`${url} did not answer JSON`)
          }
          value = pointer(doc, watch)
        }
      } catch (e) {
        cursor.error = (e as Error).message
        cursor.checkedAt = at
        ctx.note(cursor.error)
        ctx.setCursor(cursor)
        return []
      }
      const events: RawEvent[] = []
      const changed = JSON.stringify(value) !== JSON.stringify(cursor.value)
      if (!first && changed)
        events.push({ kind: 'changed', key: `${config.name}@${at}@${sha256(JSON.stringify(value ?? null))}`, at, payload: { url, watch, from: cursor.value ?? null, to: value ?? null, status } })
      if (changed) cursor.changedAt = at
      cursor.value = value
      cursor.status = status
      cursor.checkedAt = at
      cursor.error = null
      ctx.setCursor(cursor)
      return events
    }
  }
}

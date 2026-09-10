// A clock. One event per cron slot, keyed by the slot, so a restart inside a
// slot does not fire it twice; a slot that passed while nothing was running
// is reported in the cursor and on stderr, never replayed.

import { parseCron, previousSlot, slotsBetween, type Cron } from '../cron.ts'
import { parseDuration } from '../config.ts'
import type { SourceConfig } from '../config.ts'
import type { RawEvent } from '../events.ts'
import { optDuration, rejectUnknown, type Source, type SourceContext } from '../source.ts'
import { UsageError } from '../errors.ts'

interface Cursor {
  lastSlot: string | null
  missed: string[]
  missedCount: number
}

export function create(config: SourceConfig): Source {
  const where = `source ${config.name}`
  rejectUnknown(config.options, ['cron', 'utc', 'grace', 'every'], where)
  if (typeof config.options['cron'] !== 'string') throw new UsageError(`${where}: cron is required`)
  const cron: Cron = parseCron(config.options['cron'], where)
  const utc = config.options['utc'] === true
  const grace = optDuration(config.options, 'grace', 5 * 60_000, parseDuration, where)
  const every = optDuration(config.options, 'every', 10_000, parseDuration, where)

  return {
    name: config.name,
    type: 'schedule',
    every,
    listener: null,
    describe(ctx) {
      const c = ctx.cursor<Cursor>()
      return `cron ${cron.text}${utc ? ' utc' : ''}; last slot ${c?.lastSlot ?? '-'}${c?.missedCount ? `; missed ${c.missedCount} (last ${c.missed[c.missed.length - 1]})` : ''}`
    },
    async poll(ctx: SourceContext): Promise<RawEvent[]> {
      const now = ctx.now()
      const cursor: Cursor = ctx.cursor<Cursor>() ?? { lastSlot: null, missed: [], missedCount: 0 }
      const latest = previousSlot(cron, now, utc)
      if (!latest) return []
      const latestIso = latest.toISOString()
      if (cursor.lastSlot === latestIso) return []
      const events: RawEvent[] = []
      // Slots after the last one fired and before the latest were missed - unless there was no last one, when nothing was running to miss them.
      if (cursor.lastSlot) {
        const missed = slotsBetween(cron, new Date(cursor.lastSlot), latest, utc)
        const fresh = now.getTime() - latest.getTime() <= grace
        if (!fresh) missed.push(latest)
        if (missed.length) {
          ctx.note(`missed ${missed.length} slot${missed.length === 1 ? '' : 's'} while nothing was running (${missed[0]!.toISOString()}${missed.length > 1 ? ` .. ${missed[missed.length - 1]!.toISOString()}` : ''}); not replayed`)
          cursor.missed = [...cursor.missed, ...missed.map((d) => d.toISOString())].slice(-20)
          cursor.missedCount += missed.length
        }
        if (fresh) events.push({ kind: 'tick', key: `${config.name}@${latestIso}`, at: latestIso, payload: { slot: latestIso, cron: cron.text, utc } })
      } else if (now.getTime() - latest.getTime() <= grace) events.push({ kind: 'tick', key: `${config.name}@${latestIso}`, at: latestIso, payload: { slot: latestIso, cron: cron.text, utc } })
      cursor.lastSlot = latestIso
      ctx.setCursor(cursor)
      return events
    }
  }
}

// A directory of fact files: the way anything that can create a file - a
// process in a container, a CI job on a mounted volume, a shell hook - hands
// the reactor an event with no CLI, no network and no secret. The file's
// name up to the first dot is the kind, a suffix after it keeps two facts
// apart, and a JSON object body is the payload. A writer writes under a
// `.tmp` name and renames; the poll ignores `.tmp` and dotfiles. Each file
// is one event, logged first and then removed, or moved into `archive`.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseDuration, type SourceConfig } from '../config.ts'
import { isRecord } from '../errors.ts'
import { sha256, type RawEvent } from '../events.ts'
import { optDuration, optString, rejectUnknown, type Source, type SourceContext } from '../source.ts'

interface Cursor {
  taken: number
  last: { file: string; kind: string; at: string } | null
  polledAt: string | null
  error: string | null
}

export function create(config: SourceConfig): Source {
  const where = `source ${config.name}`
  rejectUnknown(config.options, ['path', 'every', 'archive'], where)
  const path = optString(config.options, 'path', where, true)!
  const archive = optString(config.options, 'archive', where)
  const every = optDuration(config.options, 'every', 5_000, parseDuration, where)

  return {
    name: config.name,
    type: 'dir',
    every,
    listener: null,
    describe(ctx) {
      const c = ctx.cursor<Cursor>()
      return `${path}; ${c?.taken ?? 0} taken${c?.last ? `, last ${c.last.kind} (${c.last.file}) at ${c.last.at}` : ''}${c?.error ? `; PROBLEM ${c.error}` : ''}`
    },
    async poll(ctx: SourceContext): Promise<RawEvent[]> {
      const dir = resolve(ctx.paths.dir, path)
      const cursor: Cursor = ctx.cursor<Cursor>() ?? { taken: 0, last: null, polledAt: null, error: null }
      const events: RawEvent[] = []
      try {
        mkdirSync(dir, { recursive: true })
        const files = readdirSync(dir)
          .filter((f) => !f.startsWith('.') && !f.endsWith('.tmp'))
          .map((f) => ({ name: f, full: join(dir, f), st: statSync(join(dir, f)) }))
          .filter((f) => f.st.isFile())
          .sort((a, b) => a.st.mtimeMs - b.st.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        for (const f of files) {
          const text = readFileSync(f.full, 'utf8')
          const kind = f.name.split('.')[0]!
          const at = new Date(f.st.mtimeMs).toISOString()
          let payload: Record<string, unknown> = {}
          if (text.trim()) {
            let parsed: unknown = undefined
            try {
              parsed = JSON.parse(text)
            } catch {
              /* not JSON */
            }
            if (isRecord(parsed)) payload = parsed
            else {
              payload = { body: text }
              ctx.note(`${f.name}: body is not a JSON object; carried as payload.body`)
            }
          }
          events.push({ kind, key: `${f.name}@${f.st.mtimeMs}@${sha256(text).slice(0, 12)}`, at, payload: { ...payload, file: f.name } })
          if (archive) {
            const to = resolve(ctx.paths.dir, archive)
            mkdirSync(to, { recursive: true })
            renameSync(f.full, join(to, `${at.replace(/[:.]/g, '-')}.${f.name}`))
          } else unlinkSync(f.full)
          cursor.taken += 1
          cursor.last = { file: f.name, kind, at }
        }
        cursor.error = null
      } catch (e) {
        cursor.error = (e as Error).message
        ctx.note(cursor.error)
      }
      cursor.polledAt = ctx.now().toISOString()
      ctx.setCursor(cursor)
      return events
    }
  }
}

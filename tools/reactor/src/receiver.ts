// The webhook receiver: an HTTP listener for posts and nothing else. One
// path per webhook source; a post is verified by its provider, logged as an
// event and handled, or dropped with the reason in the response and the
// count in the source's cursor. Loopback by default; TLS and reach are the
// deployment's business.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Source } from './source.ts'
import type { ReceiverCursor } from './sources/webhook.ts'
import type { Engine } from './reactor.ts'

const MAX_BODY = 1024 * 1024

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        resolve(null)
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => resolve(null))
  })
}

const reply = (res: ServerResponse, status: number, body: Record<string, unknown>): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body) + '\n')
}

export function createReceiver(engine: Engine, sources: Source[]): Server {
  const byPath = new Map(sources.filter((s) => s.listener).map((s) => [s.listener!.path, s]))
  return createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]!
    const source = byPath.get(path)
    if (!source) return reply(res, 404, { error: 'no webhook at this path' })
    if (req.method !== 'POST') return reply(res, 405, { error: 'the receiver takes posts only' })
    const body = await readBody(req)
    if (!body) return reply(res, 413, { error: 'body too large or unreadable' })
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v
    const cursor: ReceiverCursor = engine.log.cursor<ReceiverCursor>(source.name) ?? { received: 0, dropped: 0, lastReceived: null, lastDrop: null }
    const r = source.listener!.receive(headers, body)
    if ('drop' in r) {
      cursor.dropped++
      cursor.lastDrop = { at: engine.now().toISOString(), reason: r.drop }
      engine.log.setCursor(source.name, cursor)
      engine.note(`${source.name}: dropped a post: ${r.drop}`)
      return reply(res, r.drop.includes('JSON') || r.drop.includes('could not read') ? 400 : 401, { error: r.drop })
    }
    const event = engine.receive(source, r.event)
    cursor.received++
    cursor.lastReceived = event.at
    engine.log.setCursor(source.name, cursor)
    reply(res, 202, { id: event.id })
    engine.handle(event).catch((e: Error) => engine.note(`${source.name}: ${e.message}`))
  })
}

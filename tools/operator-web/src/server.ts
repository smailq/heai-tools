// The routes: a tab per pane and a page per row, all reads; the map editor's
// page and API, whose save is the one write; the reading as JSON; the static
// files. Every page loads scripts and styles from this server only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { traceJSON, type Timeline } from './flows.ts'
import { showJob, type JobOutput } from './pod.ts'
import type { Html } from './html.ts'
import * as mapeditor from './mapeditor.ts'
import { architectPage, eventPane, firstDefinition, flowPane, flowsPane, isRed, layout, machinesPane, missingPane, podPane, reactorPane, taskPane, tasksPane, jobPane, type Ctx, type Tab } from './pages.ts'
import type { Reader } from './reader.ts'
import { message } from './run.ts'
import { bySlug, counts } from './tracker.ts'

/** public/ beside src/ and beside dist/, so the same code serves from the sources and from a package. */
export const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml'
}

const BODY_LIMIT = 5 * 1024 * 1024

export interface ServerOptions {
  /** Host names, besides an address and localhost, the map editor may be reached under. */
  allowHosts?: string[]
  /** How a flow's timeline is read for its page; tests replace it. */
  trace?: (map: string, id: string) => Promise<Timeline>
  /** How a job's output is read for its page; tests replace it. */
  show?: (project: string, name: string) => Promise<JobOutput>
}

class HttpError extends Error {
  readonly code: number
  constructor(code: number, msg: string) {
    super(msg)
    this.code = code
  }
}

function send(res: ServerResponse, code: number, type: string, body: string | Buffer): void {
  res.writeHead(code, { 'content-type': type })
  res.end(body)
}

const sendJSON = (res: ServerResponse, code: number, body: unknown): void => send(res, code, 'application/json; charset=utf-8', JSON.stringify(body, null, 2))

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > BODY_LIMIT) {
        reject(new HttpError(413, 'body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (e) {
        reject(new HttpError(400, `body: ${message(e)}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * The editor's API answers only the page this server serves. Every request must arrive
 * under a Host that names this machine - an address, localhost, or a name given with
 * --allow-host - so a page on a DNS name rebound to this machine cannot read the map or
 * list directories through a visitor's browser. A write must also be JSON, which a
 * cross-site form cannot send without a preflight this server never answers, from this
 * origin when the browser says where it comes from.
 */
export function apiGuard(req: IncomingMessage, allowed: Set<string>): string {
  const hostHeader = req.headers.host ?? ''
  let host = hostHeader.toLowerCase()
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']'))
  else if (host.includes(':')) host = host.slice(0, host.lastIndexOf(':'))
  if (!isIP(host) && host !== 'localhost' && !allowed.has(host)) {
    return `host ${JSON.stringify(host)} is not this machine's address; name it with --allow-host to use the map editor through it`
  }
  if (req.method === 'GET' || req.method === 'HEAD') return ''
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return 'content type must be application/json'
  const origin = req.headers.origin
  if (origin && origin.replace(/^https?:\/\//, '').toLowerCase() !== hostHeader.toLowerCase()) return 'cross-origin request refused'
  return ''
}

function serveFile(res: ServerResponse, root: string, rel: string): void {
  const file = normalize(join(root, rel))
  if (file !== root && !file.startsWith(root + sep)) throw new HttpError(404, 'not found')
  let st
  try {
    st = statSync(file)
  } catch {
    throw new HttpError(404, 'not found')
  }
  if (!st.isFile()) throw new HttpError(404, 'not found')
  send(res, 200, MIME[extname(file)] ?? 'application/octet-stream', readFileSync(file))
}

export function createApp(reader: Reader, opts: ServerOptions = {}): Server {
  const allowed = new Set((opts.allowHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean))
  const trace = opts.trace ?? traceJSON
  const show = opts.show ?? showJob
  const ctx = (): Ctx => ({ r: reader.reading, now: reader.now(), refresh: Math.max(1, Math.round(reader.opts.interval / 1000)) })
  const page = (res: ServerResponse, tab: Tab, title: string, pane: Html, code = 200): void => {
    const c = ctx()
    send(res, code, 'text/html; charset=utf-8', layout(c, tab, title, pane))
  }
  const missing = (res: ServerResponse, tab: Tab, what: string): void => page(res, tab, 'not found', missingPane(tab, what), 404)

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname
    const read = req.method === 'GET' || req.method === 'HEAD'
    const api = path.startsWith('/architect/api/')
    if (!read && !api) {
      res.setHeader('allow', 'GET, HEAD')
      throw new HttpError(405, "read only: every change is made at the shell with the tool's own command")
    }
    if (api) {
      const why = apiGuard(req, allowed)
      if (why) return sendJSON(res, 403, { error: why })
      return mapApi(req, res, path.slice('/architect/api/'.length))
    }
    const r = reader.reading
    let m: RegExpExecArray | null
    if (path === '/') {
      res.writeHead(302, { location: '/architect/' })
      return void res.end()
    }
    if (path === '/tasks') return page(res, 'tasks', 'tasks', tasksPane(ctx(), url.searchParams.get('active') === '1', url.searchParams.get('sort') ?? ''))
    if ((m = /^\/tasks\/([^/]+)$/.exec(path))) {
      const slug = decodeURIComponent(m[1]!)
      const t = r.tracker ? bySlug(r.tracker, slug) : undefined
      return t ? page(res, 'tasks', t.slug, taskPane(ctx(), t)) : missing(res, 'tasks', `no task ${slug} in the tracker`)
    }
    if (path === '/flows') return page(res, 'flows', 'flows', flowsPane(ctx()))
    // The machines are the flows' own tab, before a flow's page so the word is never read as an id.
    if (path === '/flows/machines' || (m = /^\/flows\/machines\/([^/]+)$/.exec(path))) {
      const name = m ? decodeURIComponent(m[1]!) : firstDefinition(r.flows.definitions, r.flows.flows)
      const def = r.flows.definitions.find((d) => d.name === name) ?? null
      if (m && !def) return missing(res, 'flows', `no definition ${name} in flow's last answer`)
      return page(res, 'flows', def ? `machine ${def.name}` : 'machines', machinesPane(ctx(), def, url.searchParams.get('state') ?? ''))
    }
    if ((m = /^\/flows\/([^/]+)$/.exec(path))) {
      const id = decodeURIComponent(m[1]!)
      // Only an id flow listed is asked about, so nothing from the URL reaches a command line unchecked.
      const f = r.flows.flows.find((x) => x.id === id)
      if (!f) return missing(res, 'flows', `no flow ${id} in flow's last answer`)
      let tl: Timeline | null = null
      let err = ''
      try {
        tl = await trace(r.map, id)
      } catch (e) {
        err = message(e)
      }
      return page(res, 'flows', f.id, flowPane(ctx(), f, tl, err))
    }
    if (path === '/pod') return page(res, 'pod', 'pod', podPane(ctx()))
    if ((m = /^\/pod\/([^/]+)$/.exec(path))) {
      const id = decodeURIComponent(m[1]!)
      // Only a job pod listed is asked about, so nothing from the URL reaches a command line unchecked.
      const j = r.pod.jobs.find((x) => x.name === id)
      if (!j) return missing(res, 'pod', `no job ${id} in pod's last answer`)
      let out: JobOutput | null = null
      let err = ''
      try {
        out = await show(r.project, id)
      } catch (e) {
        err = message(e)
      }
      return page(res, 'pod', `job ${id}`, jobPane(ctx(), j, out, err))
    }
    if (path === '/reactor') return page(res, 'reactor', 'reactor', reactorPane(ctx()))
    if ((m = /^\/reactor\/([^/]+)$/.exec(path))) {
      const id = decodeURIComponent(m[1]!)
      const e = r.reactor.events.find((x) => x.id === id)
      return e ? page(res, 'reactor', `event ${id}`, eventPane(ctx(), e)) : missing(res, 'reactor', `no event ${id} in the last hour`)
    }
    if (path === '/api/state') {
      return sendJSON(res, 200, {
        tracker: r.tracker,
        map: r.map,
        owners: r.owners.owners,
        repositories: r.owners.repos,
        ownersNote: r.owners.note || undefined,
        counts: r.tracker ? counts(r.tracker) : {},
        flows: r.flows,
        pod: r.pod,
        reactor: r.reactor,
        red: isRed(r),
        at: new Date(r.at).toISOString()
      })
    }
    if (path.startsWith('/static/')) return serveFile(res, join(PUBLIC, 'static'), decodeURIComponent(path.slice('/static/'.length)))
    if (path === '/architect') {
      res.writeHead(301, { location: '/architect/' })
      return void res.end()
    }
    if (path === '/architect/' || path === '/architect/index.html') {
      // The editor's page, with the primary tabs put in it from this reading.
      return send(res, 200, 'text/html; charset=utf-8', architectPage(ctx(), readFileSync(join(PUBLIC, 'architect', 'index.html'), 'utf8')))
    }
    if (path.startsWith('/architect/')) return serveFile(res, join(PUBLIC, 'architect'), decodeURIComponent(path.slice('/architect/'.length)))
    throw new HttpError(404, 'not found')
  }

  async function mapApi(req: IncomingMessage, res: ServerResponse, what: string): Promise<void> {
    const r = reader.reading
    const method = req.method
    if (what === 'file' && method === 'GET') {
      if (!r.map) return sendJSON(res, 404, { error: 'no map configured: start with --map <path> or --dir <project>' })
      return sendJSON(res, 200, mapeditor.readMapFile(r.map))
    }
    if (what === 'file' && method === 'PUT') {
      if (!r.map) return sendJSON(res, 404, { error: 'no map configured: start with --map <path> or --dir <project>' })
      const body = (await readBody(req)) as { yaml?: unknown; base?: unknown; force?: unknown }
      if (typeof body?.yaml !== 'string' || !body.yaml.trim()) return sendJSON(res, 400, { error: 'refusing to save an empty map' })
      let v
      try {
        v = await mapeditor.architectCheck(body.yaml)
      } catch (e) {
        return sendJSON(res, 503, { error: `cannot validate, so not saving: ${message(e)}` })
      }
      if (!v.valid) return sendJSON(res, 422, { error: 'the map does not validate; not saved', validation: v })
      // Read, compare and write with no await between, so two saves cannot interleave.
      const cur = mapeditor.readMapFile(r.map)
      if (body.force !== true && cur.version !== (body.base ?? '')) {
        return sendJSON(res, 409, { error: 'the file changed on disk since this page loaded it', file: cur })
      }
      mapeditor.writeAtomic(r.map, body.yaml)
      void reader.readTracker()
      return sendJSON(res, 200, mapeditor.readMapFile(r.map))
    }
    if (what === 'validate' && method === 'POST') {
      const body = (await readBody(req)) as { yaml?: unknown; map?: unknown }
      let text: string
      if (typeof body?.yaml === 'string') text = body.yaml
      else if (body?.map !== undefined) text = mapeditor.mapToYaml(body.map)
      else return sendJSON(res, 400, { error: 'body must be {"yaml": "..."} or {"map": {...}}' })
      try {
        return sendJSON(res, 200, await mapeditor.architectCheck(text))
      } catch (e) {
        // A map that cannot be validated at all is answered as invalid, with why, so the page says it.
        return sendJSON(res, 200, { valid: false, errors: [`cannot validate: ${message(e)}`], warnings: [] })
      }
    }
    if (what === 'serialize' && method === 'POST') {
      const body = (await readBody(req)) as { map?: unknown; base?: unknown }
      if (!body?.map || typeof body.map !== 'object' || Array.isArray(body.map)) return sendJSON(res, 400, { error: 'body must be {"map": {...}, "base"?: "..."}' })
      // The base is the text the page loaded; without one, the file on disk.
      let base = typeof body.base === 'string' ? body.base : ''
      if (typeof body.base !== 'string' && r.map) base = mapeditor.readMapFile(r.map).yaml
      return sendJSON(res, 200, { yaml: mapeditor.mapToYaml(body.map, base || undefined) })
    }
    if (what === 'tree' && method === 'POST') {
      const body = (await readBody(req)) as { repositories?: unknown }
      const repos = body?.repositories
      if (!repos || typeof repos !== 'object' || Array.isArray(repos)) return sendJSON(res, 400, { error: 'body must be {"repositories": {...}}' })
      return sendJSON(res, 200, { repos: await mapeditor.tree(repos as Record<string, { localPath?: unknown }>, r.map ? dirname(r.map) : reader.opts.cwd) })
    }
    if (what === 'tasks' && method === 'POST') {
      await readBody(req).catch(() => null)
      return sendJSON(res, 200, { tasks: mapeditor.taskRows(r.tracker), truncated: false })
    }
    if (what === 'template' && method === 'GET') {
      try {
        return sendJSON(res, 200, { yaml: await mapeditor.template() })
      } catch (e) {
        return sendJSON(res, 503, { error: message(e) })
      }
    }
    return sendJSON(res, 404, { error: `no ${method} /architect/api/${what}` })
  }

  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let csp = "default-src 'self'; frame-ancestors 'none'"
    // The map editor's graph library injects one stylesheet for its container; scripts stay this server's own.
    if (url.pathname.startsWith('/architect/')) csp += "; style-src 'self' 'unsafe-inline'"
    res.setHeader('content-security-policy', csp)
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('cache-control', 'no-store')
    route(req, res, url).catch((e: unknown) => {
      if (res.headersSent) return res.end()
      const code = e instanceof HttpError ? e.code : 500
      if (url.pathname.startsWith('/architect/api/')) sendJSON(res, code, { error: message(e) })
      else send(res, code, 'text/plain; charset=utf-8', message(e))
    })
  })
}

#!/usr/bin/env node
/**
 * The map editor's server: static assets plus a few stateless endpoints.
 *
 * The map itself never lives here. It is pasted into the browser, held in the
 * browser's own storage while it is edited, and exported back out as a file -
 * so this process holds no state, writes nothing, and can be stopped and
 * restarted under an open editor without losing the work in it.
 *
 * The two things a browser cannot do for itself are what the endpoints cover:
 * validating against the schema (`/api/validate`, `/api/serialize`) and reading
 * a repository's file tree from the `localPath` its entry declares
 * (`/api/tree`), which is what the territory highlighting draws on.
 */
import { execFileSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { createValidator, mapToYaml, TEMPLATE } from './validate.ts'

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

// Flags win, then environment variables, then defaults.
const port = Number(argValue('--port') ?? process.env.PORT ?? 8789)
const host = argValue('--host') ?? process.env.HOST ?? '127.0.0.1'
const here = fileURLToPath(new URL('.', import.meta.url))
const schemaPath = resolve(
  argValue('--schema') ??
    process.env.SCHEMA_FILE ??
    join(here, '..', '..', '..', 'schemas', 'architecture.schema.json')
)
const publicDir = join(here, '..', 'public')

// Optional URL prefix the app is mounted under (e.g. `tailscale serve
// --set-path /architect` forwards requests with the prefix intact). The client
// uses relative URLs throughout, so it follows whatever path it was loaded from.
// Optional seed file (`--file architecture.yaml`). The server still never
// writes it: the page reads it once through `/api/file` when the browser holds
// no map yet (and again on request), then edits its own copy as usual.
const seedPath = (() => {
  const v = argValue('--file') ?? process.env.MAP_FILE
  return v ? resolve(v) : null
})()

const rawBasePath = argValue('--base-path') ?? process.env.BASE_PATH ?? ''
const basePath = ('/' + rawBasePath.replace(/^\/+|\/+$/g, '')).replace(/^\/$/, '')

/** Strip the base path; null means "configured, and this request is outside it". */
function stripBasePath(pathname: string): string | null {
  if (!basePath) return pathname
  if (pathname === basePath) return ''
  if (pathname.startsWith(basePath + '/')) return pathname.slice(basePath.length)
  return null
}

const validator = createValidator(schemaPath)

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 5 * 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * The browser must be on OUR page. A cross-site page can post JSON only after a
 * preflight this server never answers, but an explicit check costs nothing and
 * says the rule out loud: /api/tree reads directories off this machine.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true // not a browser, or a same-origin form-less request
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function serveStatic(res: ServerResponse, urlPath: string): void {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1)
  const file = normalize(join(publicDir, rel))
  if (!file.startsWith(publicDir) || !existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
}

// ── The file tree, from each repository's declared localPath ──
// A repository is a path-addressable tree, not necessarily a git checkout: a
// git repository is listed by `git ls-files` so ignored files stay out, and
// anything else is walked directly.

const FILE_LIMIT = 20000
const SKIP_DIRS = new Set(['.git', 'node_modules'])

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
}

function gitFiles(root: string): string[] | null {
  if (!existsSync(join(root, '.git'))) return null
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
    return out.split('\0').filter(Boolean)
  } catch {
    return null
  }
}

function walkFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string, prefix: string): void => {
    if (files.length >= FILE_LIMIT) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable directory: skip it rather than fail the whole tree
    }
    for (const entry of entries) {
      if (files.length >= FILE_LIMIT) return
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), rel)
      } else if (entry.isFile()) {
        files.push(rel)
      }
    }
  }
  walk(root, '')
  return files
}

interface TreeRepo {
  name: string
  localPath: string | null
  root: string | null
  files: string[]
  truncated: boolean
  error?: string
}

function repoTree(repositories: Record<string, { localPath?: unknown }>): { repos: TreeRepo[] } {
  const repos = Object.entries(repositories ?? {}).map(([name, repo]): TreeRepo => {
    const declared = typeof repo?.localPath === 'string' ? repo.localPath : null
    if (!declared) return { name, localPath: null, root: null, files: [], truncated: false }
    const root = resolve(expandHome(declared))
    const base = { name, localPath: declared, root }
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      return { ...base, files: [], truncated: false, error: 'no such directory on this machine' }
    }
    const files = (gitFiles(root) ?? walkFiles(root)).sort()
    return { ...base, files, truncated: files.length >= FILE_LIMIT }
  })
  return { repos }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`)
  const stripped = stripBasePath(url.pathname)
  if (stripped === '') {
    // Bare base path: redirect to the trailing-slash form so the page's
    // relative asset and API URLs resolve under the base path.
    res.writeHead(302, { location: `${basePath}/${url.search}` })
    res.end()
    return
  }
  const pathname = stripped ?? url.pathname
  try {
    if (pathname.startsWith('/api/') && !sameOrigin(req)) {
      sendJson(res, 403, { error: 'cross-origin request refused' })
      return
    }

    if (pathname === '/api/validate' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { yaml?: unknown; map?: unknown }
      if (typeof body.yaml === 'string') {
        sendJson(res, 200, validator.validate(body.yaml))
        return
      }
      if (body.map !== undefined) {
        sendJson(res, 200, validator.validateDoc(body.map))
        return
      }
      sendJson(res, 400, { error: 'body must be {"yaml": "..."} or {"map": {...}}' })
      return
    }

    if (pathname === '/api/serialize' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { map?: unknown }
      if (!body.map || typeof body.map !== 'object') {
        sendJson(res, 400, { error: 'body must be {"map": {...}}' })
        return
      }
      sendJson(res, 200, { yaml: mapToYaml(body.map) })
      return
    }

    if (pathname === '/api/tree' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { repositories?: unknown }
      const repositories = body.repositories
      if (!repositories || typeof repositories !== 'object' || Array.isArray(repositories)) {
        sendJson(res, 400, { error: 'body must be {"repositories": {...}}' })
        return
      }
      sendJson(res, 200, repoTree(repositories as Record<string, { localPath?: unknown }>))
      return
    }

    if (pathname === '/api/file' && req.method === 'GET') {
      if (!seedPath) {
        sendJson(res, 404, { error: 'no map file configured; start with --file <path>' })
        return
      }
      if (!existsSync(seedPath)) {
        sendJson(res, 404, { error: `map file not found: ${seedPath}`, path: seedPath })
        return
      }
      sendJson(res, 200, { path: seedPath, name: basename(seedPath), yaml: readFileSync(seedPath, 'utf8') })
      return
    }

    if (pathname === '/api/template' && req.method === 'GET') {
      sendJson(res, 200, { yaml: TEMPLATE, map: parse(TEMPLATE) })
      return
    }

    if (pathname === '/api/schema' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(readFileSync(schemaPath))
      return
    }

    if (req.method === 'GET') {
      serveStatic(res, pathname)
      return
    }

    res.writeHead(405, { 'content-type': 'text/plain' })
    res.end('method not allowed')
  } catch (e) {
    sendJson(res, 500, { error: (e as Error).message })
  }
})

server.listen(port, host, () => {
  console.log(`map-editor: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`)
  if (basePath) console.log(`map-editor: also serving under base path ${basePath}/`)
  console.log(`map-editor: schema ${schemaPath}`)
  console.log('map-editor: the map is held in the browser - paste it in, export it back out')
  if (seedPath) {
    console.log(
      `map-editor: seeding from ${seedPath}${existsSync(seedPath) ? '' : ' (not found)'} - ` +
        'read only; export to write it back'
    )
  }
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(
      'map-editor: WARNING - listening beyond loopback, and /api/tree lists directories ' +
        'on this machine for whoever reaches the page'
    )
  }
})

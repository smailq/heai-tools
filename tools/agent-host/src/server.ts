// The page and the API, over host.ts. It holds nothing the files do not hold,
// so it can be restarted under an open page; its one addition is a settle
// loop on a short interval, so runs finish and queues drain while nobody is
// typing commands, and `/api/events` fires as records change.
//
// The page is server-rendered: plain HTML forms that POST and redirect, usable
// with the script blocked. The script adds the live log and the list refresh.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ContainerError, HostError, UsageError, type ActorStatus, type Host, type TaskView } from './host.ts'
import { readExit, runFile, TERMINAL, type RunRecord } from './runs.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const publicDir = join(here, '..', 'public')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
}

export interface ServerOptions {
  host: Host
  basePath?: string
  /** How often the server settles on its own, in ms. */
  settleEveryMs?: number
}

export function normalizeBasePath(raw: string | undefined): string {
  return ('/' + (raw ?? '').replace(/^\/+|\/+$/g, '')).replace(/^\/$/, '')
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]!)

const page = (base: string, title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${base}/style.css">
</head>
<body><div class="app" data-base="${esc(base)}">${body}</div><script src="${base}/app.js" defer></script></body>
</html>`

const badge = (text: string, kind = ''): string => `<span class="badge ${esc(kind)}">${esc(text)}</span>`

const when = (s: string | null): string => (s ? s.replace('T', ' ').replace('Z', '') : '-')

const stateOf = (a: ActorStatus): { label: string; kind: string } =>
  a.current ? { label: 'busy', kind: 'busy' } : a.container === 'running' ? { label: 'idle', kind: 'idle' } : { label: a.container, kind: a.container }

function header(base: string, actors: ActorStatus[]): string {
  const running = actors.filter((a) => a.container === 'running').length
  return `<header><h1><a href="${base}/">agent-host</a></h1><span class="count">${running}/${actors.length} actors up</span></header>`
}

function actorList(base: string, actors: ActorStatus[], selected: string | null): string {
  return actors
    .map((a) => {
      const s = stateOf(a)
      return `<a class="row ${a.name === selected ? 'sel' : ''}" href="${base}/actor/${esc(a.name)}">
        <span class="title">${esc(a.name)}</span>
        <span class="meta">${badge(s.label, s.kind)}${a.current ? `<span class="muted">${esc(a.current.task ?? 'prompt')}</span>` : ''}${
          a.queued ? badge(`${a.queued} queued`) : ''
        }${a.resumable.length ? badge('resume', 'resume') : ''}</span>
      </a>`
    })
    .join('')
}

const runRow = (base: string, r: RunRecord): string =>
  `<tr><td><a href="${base}/run/${esc(r.id)}"><code>${esc(r.id)}</code></a></td><td>${esc(r.task ?? '(prompt)')}</td><td>${badge(
    r.status,
    r.status
  )}</td><td>${r.gate ? badge(r.gate.verdict, `gate-${r.gate.verdict}`) : ''}</td><td class="muted">${esc(when(r.startedAt ?? r.queuedAt))}</td></tr>`

function assignForm(base: string, a: ActorStatus, tasks: TaskView[], problems: string[]): string {
  if (a.container !== 'running') return ''
  const mine = tasks.filter((t) => t.routedTo.length === 1 && t.routedTo[0] === a.name && !t.run)
  const others = tasks.filter((t) => !mine.includes(t) && !t.run)
  const option = (t: TaskView, note = '') =>
    `<option value="${esc(t.slug)}" data-body="${esc(t.title)}">${esc(t.slug)} - ${esc(t.title)}${note ? ` (${esc(note)})` : ''}${
      a.resumable.includes(t.slug) ? ' (resume)' : ''
    }</option>`
  return `<h2>Assign</h2>
    ${problems.length ? `<div class="problems-inline"><p>Not assigned:</p><pre>${esc(problems.join('\n'))}</pre></div>` : ''}
    <form class="assign" method="post" action="${base}/actor/${esc(a.name)}/assign">
      <label>task
        <select name="task"><option value="">(none - use the prompt below)</option>
          ${mine.map((t) => option(t)).join('')}
          ${others.map((t) => option(t, `routes to ${t.routedTo.join(', ') || 'nobody'}`)).join('')}
        </select></label>
      <label>or a prompt<textarea name="prompt" rows="4" placeholder="Free-form work, when there is no task for it."></textarea></label>
      <button class="cbtn">assign</button>
    </form>`
}

function actorDetail(base: string, a: ActorStatus, runs: RunRecord[], tasks: TaskView[], log: string, problems: string[]): string {
  const s = stateOf(a)
  const controls =
    a.container === 'running'
      ? `<form method="post" action="${base}/actor/${esc(a.name)}/down" class="ctl"><button class="dbtn"${a.current ? ' data-confirm="1"' : ''}>stop</button>${
          a.current ? '<span class="muted">cancels the current run</span>' : ''
        }</form>`
      : `<form method="post" action="${base}/actor/${esc(a.name)}/up" class="ctl"><button class="cbtn">start</button></form>`
  const territories = a.territories
    .map((t) => `<li><code>${esc(t.name)}</code> <span class="muted">${t.globs.map((g) => esc(g)).join(', ')}</span></li>`)
    .join('')
  const queuedRuns = runs.filter((r) => r.status === 'queued')
  const history = runs.filter((r) => r.status !== 'queued' && r.status !== 'running')
  const current = a.current
    ? `<h2>Current run</h2>
       <p><a href="${base}/run/${esc(a.current.id)}"><code>${esc(a.current.id)}</code></a> · ${esc(a.current.task ?? 'prompt')} · started ${esc(when(a.current.startedAt))}
       <form method="post" action="${base}/run/${esc(a.current.id)}/cancel" class="inline"><button class="dbtn">cancel</button></form></p>
       <pre class="log" data-run="${esc(a.current.id)}" data-live="1">${esc(log)}</pre>`
    : ''
  return `<a class="back" href="${base}/">← all actors</a>
    <h1>${esc(a.name)} ${badge(s.label, s.kind)}</h1>
    <div class="ctls">${controls}<span class="muted">container ${esc(a.container)} · image <code>${esc(a.image)}</code></span></div>
    ${current}
    ${assignForm(base, a, tasks, problems)}
    ${queuedRuns.length ? `<h2>Queued</h2><table class="runs">${queuedRuns.map((r) => runRow(base, r)).join('')}</table>` : ''}
    ${a.resumable.length ? `<p class="muted">Ready to resume: ${a.resumable.map((s) => `<code>${esc(s)}</code>`).join(', ')}</p>` : ''}
    <h2>Territories</h2><ul class="terr">${territories || '<li class="muted">none</li>'}</ul>
    <h2>Context</h2><pre class="ctx">${esc(a.context || '(none)')}</pre>
    <h2>History</h2>${history.length ? `<table class="runs">${history.map((r) => runRow(base, r)).join('')}</table>` : '<p class="muted">no runs yet</p>'}`
}

function runPage(base: string, host: Host, run: RunRecord, actors: ActorStatus[]): string {
  const live = !TERMINAL.includes(run.status)
  const findings = (run.gate?.findings ?? []) as { path?: string; fatal?: boolean; territory?: string | null; owner?: string | null; classification?: string }[]
  const rows = [
    ['actor', `<a href="${base}/actor/${esc(run.actor)}">${esc(run.actor)}</a>`],
    ['task', run.task ? `<code>${esc(run.task)}</code> ${esc(run.title)}` : `(prompt) ${esc(run.title)}`],
    ['ref', `<code>${esc(run.ref)}</code>${run.resumes ? ` resumes <a href="${base}/run/${esc(run.resumes)}">${esc(run.resumes)}</a>` : ''}`],
    ['status', `${badge(run.status, run.status)}${run.exitCode !== null ? ` exit ${run.exitCode}` : ''}${run.error ? ` <span class="err">${esc(run.error)}</span>` : ''}`],
    ['timing', `queued ${esc(when(run.queuedAt))} · started ${esc(when(run.startedAt))} · ended ${esc(when(run.endedAt))}`],
    [
      'gate',
      run.gate
        ? `${badge(run.gate.verdict, `gate-${run.gate.verdict}`)}${run.gate.detail ? ` <span class="muted">${esc(run.gate.detail)}</span>` : ''}${
            findings.filter((f) => f.fatal).length
              ? `<ul>${findings
                  .filter((f) => f.fatal)
                  .map((f) => `<li><code>${esc(f.path ?? '')}</code> ${esc(f.classification ?? '')}${f.territory ? ` - owned by ${esc(f.territory)} (${esc(f.owner ?? '?')})` : ''}</li>`)
                  .join('')}</ul>`
              : ''
          }`
        : '<span class="muted">not yet</span>'
    ],
    [
      'requests',
      run.requests.length
        ? `<ul>${run.requests
            .map((q) => `<li>${q.task ? `<code>${esc(q.task)}</code>` : badge('rejected', 'failed')} ${esc(q.title)} <span class="muted">[${esc(q.territory)}]</span>${q.error ? ` <span class="err">${esc(q.error)}</span>` : ''}</li>`)
            .join('')}</ul>`
        : '<span class="muted">none</span>'
    ],
    ['changed', run.changed.length ? `<ul>${run.changed.map((p) => `<li><code>${esc(p)}</code></li>`).join('')}</ul>` : '<span class="muted">nothing</span>'],
    ...(run.dirty.length ? [['uncommitted', `<ul>${run.dirty.map((p) => `<li><code>${esc(p)}</code></li>`).join('')}</ul>`]] : [])
  ]
  return page(
    base,
    `${run.id} - agent-host`,
    `${header(base, actors)}<main class="single"><section class="detail">
      <a class="back-always" href="${base}/actor/${esc(run.actor)}">← ${esc(run.actor)}</a>
      <h1><code>${esc(run.id)}</code></h1>
      ${live ? `<form method="post" action="${base}/run/${esc(run.id)}/cancel" class="ctl"><button class="dbtn">cancel</button></form>` : ''}
      <table class="fm">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('')}</table>
      <h2>Log</h2><pre class="log" data-run="${esc(run.id)}"${live ? ' data-live="1"' : ''}>${esc(host.log(run.id))}</pre>
      <details><summary>Prompt</summary><pre class="ctx">${esc(host.prompt(run.id))}</pre></details>
    </section></main>`
  )
}

function actorsPage(base: string, host: Host, actors: ActorStatus[], selected: string | null, problems: string[] = []): string {
  const a = selected ? actors.find((x) => x.name === selected) ?? null : null
  const detail = a
    ? actorDetail(base, a, host.runs(a.name), host.tasks(), a.current ? host.log(a.current.id) : '', problems)
    : `<div class="empty"><p>${actors.length ? 'Select an actor' : 'The map declares no llm-agent actors'}</p></div>`
  return page(
    base,
    a ? `${a.name} - agent-host` : 'agent-host',
    `${header(base, actors)}<main class="${a ? 'has-detail' : 'no-detail'}"><aside>${actorList(base, actors, selected)}</aside><section class="detail">${detail}</section></main>`
  )
}

// ── Plumbing ──

const BODY_LIMIT = 1024 * 1024

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > BODY_LIMIT) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** This server starts containers and runs agents, so a write from another origin is refused outright. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function serveStatic(res: ServerResponse, urlPath: string): boolean {
  const file = normalize(join(publicDir, urlPath.slice(1)))
  if (!file.startsWith(publicDir) || !existsSync(file)) return false
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
  return true
}

const statusOf = (e: unknown): number =>
  e instanceof HostError
    ? e.code === 'not-found'
      ? 404
      : e.code === 'conflict'
        ? 409
        : 400
    : e instanceof UsageError
      ? 400
      : e instanceof ContainerError
        ? 502
        : 500

export function createAgentServer(options: ServerOptions): Server {
  const host = options.host
  const base = normalizeBasePath(options.basePath)
  const every = options.settleEveryMs ?? 3000

  // ── Events: settle on an interval, and tell subscribers what changed. ──
  const subscribers = new Set<ServerResponse>()
  let last = new Map<string, string>()
  const snapshot = async (): Promise<{ actors: ActorStatus[]; runs: RunRecord[] }> => ({ actors: await host.status(), runs: host.runs() })
  const broadcast = (event: string, data: unknown) => {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of subscribers) res.write(line)
  }
  let settling = false
  const tick = async () => {
    if (settling) return
    settling = true
    try {
      const notes = await host.settle()
      for (const n of notes) broadcast('note', { note: n })
      if (!subscribers.size) return
      const s = await snapshot()
      const next = new Map<string, string>()
      for (const a of s.actors) next.set(`actor:${a.name}`, JSON.stringify(a))
      for (const r of s.runs) next.set(`run:${r.id}`, JSON.stringify(r))
      for (const [key, value] of next) {
        if (last.get(key) !== value) broadcast(key.startsWith('actor:') ? 'actor' : 'run', JSON.parse(value))
      }
      last = next
    } catch {
      /* the next tick tries again */
    } finally {
      settling = false
    }
  }
  const timer = setInterval(() => void tick(), every)
  timer.unref()

  const server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      if (res.headersSent) {
        res.end()
        return
      }
      const code = statusOf(e)
      const wantsJson = (req.url ?? '').includes('/api/')
      if (wantsJson) {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: (e as Error).message }) + '\n')
      } else {
        res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`${(e as Error).message}\n`)
      }
    })
  })
  server.on('close', () => {
    clearInterval(timer)
    for (const res of subscribers) res.end()
    subscribers.clear()
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (code: number, html: string) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    }
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body, null, 2) + '\n')
    }
    const plain = (code: number, text: string) => {
      res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(text)
    }
    const seeOther = (to: string) => {
      res.writeHead(303, { location: `${base}${to}` })
      res.end()
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    let path = url.pathname
    if (base) {
      if (path === base) path = '/'
      else if (path.startsWith(base + '/')) path = path.slice(base.length)
      else return plain(404, 'not found')
    }
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'POST') return plain(405, 'method not allowed')
    if (method === 'POST' && !sameOrigin(req)) return plain(403, 'cross-origin write refused')
    if (method === 'GET' && path !== '/' && serveStatic(res, path)) return

    // ── The API ──
    if (path.startsWith('/api/')) {
      let m: RegExpMatchArray | null
      if (path === '/api/actors' && method === 'GET') return json(200, await host.status())
      if (path === '/api/map' && method === 'GET') {
        return json(200, { path: host.map.path, hash: host.map.hash, actors: host.map.actors, territories: host.map.territories })
      }
      if (path === '/api/tasks' && method === 'GET') {
        await host.settle()
        return json(200, host.tasks())
      }
      if (path === '/api/events' && method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write(': connected\n\n')
        subscribers.add(res)
        req.on('close', () => subscribers.delete(res))
        return
      }
      if ((m = path.match(/^\/api\/actors\/([a-z0-9][a-z0-9._-]*)$/)) && method === 'GET') {
        const a = await host.actor(m[1]!)
        return json(200, { ...a, runs: host.runs(a.name).slice(0, 20) })
      }
      if ((m = path.match(/^\/api\/actors\/([a-z0-9][a-z0-9._-]*)\/runs$/))) {
        if (method === 'GET') {
          await host.actor(m[1]!)
          return json(200, host.runs(m[1]!))
        }
        const body = JSON.parse((await readBody(req)) || '{}') as { task?: string; prompt?: string }
        const r = await host.assign(m[1]!, { task: body.task, prompt: body.prompt })
        return json(202, { run: r.run, queued: r.queued, warnings: r.warnings })
      }
      if ((m = path.match(/^\/api\/actors\/([a-z0-9][a-z0-9._-]*)\/(up|down)$/)) && method === 'POST') {
        if (m[2] === 'up') return json(202, await host.up(m[1]!))
        const body = JSON.parse((await readBody(req)) || '{}') as { force?: boolean }
        await host.down(m[1]!, { force: body.force === true })
        return json(200, { ok: true })
      }
      if ((m = path.match(/^\/api\/runs\/([^/]+)$/)) && method === 'GET') {
        await host.settle()
        const run = host.run(m[1]!)
        if (!run) return json(404, { error: `no run ${m[1]}` })
        return json(200, { ...run, prompt: host.prompt(run.id) })
      }
      if ((m = path.match(/^\/api\/runs\/([^/]+)\/log$/)) && method === 'GET') {
        const id = m[1]!
        const run = host.run(id)
        if (!run) return json(404, { error: `no run ${id}` })
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' })
        if (url.searchParams.get('follow') !== '1' || TERMINAL.includes(run.status)) {
          res.end(host.log(id))
          return
        }
        return followLog(id, res, req)
      }
      if ((m = path.match(/^\/api\/runs\/([^/]+)\/cancel$/)) && method === 'POST') {
        return json(202, await host.cancel(m[1]!))
      }
      return json(404, { error: 'not found' })
    }

    // ── Writes from the page ──
    if (method === 'POST') {
      const values = Object.fromEntries(new URLSearchParams(await readBody(req)))
      let m: RegExpMatchArray | null
      if ((m = path.match(/^\/actor\/([a-z0-9][a-z0-9._-]*)\/(up|down)$/))) {
        if (m[2] === 'up') await host.up(m[1]!)
        else await host.down(m[1]!, { force: true })
        return seeOther(`/actor/${m[1]}`)
      }
      if ((m = path.match(/^\/actor\/([a-z0-9][a-z0-9._-]*)\/assign$/))) {
        try {
          const r = await host.assign(m[1]!, {
            task: values['task']?.trim() || undefined,
            prompt: values['prompt']?.trim() || undefined
          })
          return seeOther(`/run/${r.run.id}`)
        } catch (e) {
          if (!(e instanceof HostError)) throw e
          const actors = await host.status()
          return send(400, actorsPage(base, host, actors, m[1]!, [e.message]))
        }
      }
      if ((m = path.match(/^\/run\/([^/]+)\/cancel$/))) {
        await host.cancel(m[1]!)
        return seeOther(`/run/${m[1]}`)
      }
      return plain(404, 'not found')
    }

    // ── Reads ──
    if (path === '/') return send(200, actorsPage(base, host, await host.status(), null))
    let m: RegExpMatchArray | null
    if ((m = path.match(/^\/actor\/([a-z0-9][a-z0-9._-]*)$/))) {
      const actors = await host.status()
      if (!actors.some((a) => a.name === m![1])) return send(404, page(base, 'Not found', `${header(base, actors)}<div class="problems"><p>No llm-agent ${esc(m[1]!)}.</p></div>`))
      return send(200, actorsPage(base, host, actors, m[1]!))
    }
    if ((m = path.match(/^\/run\/([^/]+)$/))) {
      await host.settle()
      const run = host.run(m[1]!)
      const actors = await host.status()
      if (!run) return send(404, page(base, 'Not found', `${header(base, actors)}<div class="problems"><p>No run ${esc(m[1]!)}.</p></div>`))
      return send(200, runPage(base, host, run, actors))
    }
    send(404, page(base, 'Not found', `<div class="problems"><p>Nothing here.</p></div>`))
  }

  /** Stream a log as it grows, until the run's `.exit` appears. */
  function followLog(id: string, res: ServerResponse, req: IncomingMessage): void {
    const path = runFile(host.state, id, 'log')
    let sent = 0
    let closed = false
    req.on('close', () => {
      closed = true
    })
    const pump = () => {
      if (closed) return
      const size = existsSync(path) ? statSync(path).size : 0
      if (size > sent) {
        const text = readFileSync(path, 'utf8')
        res.write(text.slice(sent))
        sent = text.length
      }
      if (readExit(host.state, id) !== null || (host.run(id) && TERMINAL.includes(host.run(id)!.status))) {
        // One last read, so nothing written just before the exit is missed.
        const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
        if (text.length > sent) res.write(text.slice(sent))
        res.end()
        return
      }
      setTimeout(pump, 500)
    }
    pump()
  }

  return server
}

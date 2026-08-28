#!/usr/bin/env node
/**
 * A web view of the tracker: the tasks, server-rendered, no client-side
 * script.
 *
 * The files are read fresh on every request, so the view is never stale and the
 * process holds no copy of the tracker to go out of date - the same posture as
 * the map editor, which holds no map. Restarting it under an open page loses
 * nothing, and an invalid file is fixed by fixing the file.
 *
 * Editing goes through the same functions the CLI uses, so a change made here
 * is validated before it is written and regenerates the view after it - the
 * page cannot produce a file the parser would reject, and cannot leave a stale
 * view behind. What it writes is still a file in the repository, so the change
 * is reviewed as a diff like any other.
 *
 * Forms are plain HTML that POST and redirect. There is no client-side script:
 * the view works with JavaScript off, and what the server renders is the whole
 * of it.
 *
 * Layout: an email-client style master-detail split - the list in a left pane,
 * the selected item in the right one, collapsing to one pane at a time on a
 * narrow screen.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load, ValidationError, type Store } from './store.ts'
import { UsageError } from './config.ts'
import {
  PRIORITIES,
  relativeDate,
  today,
  taskOrder,
  TASK_STATUSES,
  type Task
} from './model.ts'
import {
  createTask,
  deleteTask,
  SETTABLE_TASK_KEYS,
  updateTask,
  type TaskFields
} from './edit.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const publicDir = join(here, '..', 'public')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
}

export interface ServerOptions {
  /** The tracker directory to read. */
  dir: string
  /** URL prefix the app is mounted under, e.g. behind a reverse proxy subpath. */
  basePath?: string
  /** Shown in the header; defaults to the tracker directory's name. */
  title?: string
}

/**
 * Normalize a mount prefix to `''` or `/x`, the same shape map-editor uses, so
 * `--base-path tasks`, `/tasks` and `/tasks/` are one option rather than three.
 */
export function normalizeBasePath(raw: string | undefined): string {
  return ('/' + (raw ?? '').replace(/^\/+|\/+$/g, '')).replace(/^\/$/, '')
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}
const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]!)

/**
 * Just enough markdown for a task body: headings, lists, links, code, bold.
 *
 * Deliberately small. The bodies this renders are written to be read as plain
 * markdown in the file first, and a full parser would be a dependency this view
 * does not earn.
 */
export function markdown(src: string, base = ''): string {
  const inline = (s: string): string =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // Cross-links between tasks are relative file links; point them at this app.
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, href: string) => {
        const local = href.match(/^(?:items\/)?([a-z0-9][a-z0-9.-]*)\.md$/)
        const target = local ? `${base}/task/${local[1]}` : href
        if (local || /^(https?:|\/|#)/.test(target)) return `<a href="${target}">${text}</a>`
        return m
      })

  const out: string[] = []
  let inList = false
  for (const line of src.split('\n')) {
    const heading = line.match(/^(#{1,4}) (.*)/)
    const item = line.match(/^[-*] (.*)/)
    if (inList && !item) {
      out.push('</ul>')
      inList = false
    }
    if (heading) {
      const level = heading[1]!.length + 2
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`)
    } else if (item) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${inline(item[1]!)}</li>`)
    } else if (line.trim() === '') {
      out.push('')
    } else {
      out.push(`<p>${inline(line)}</p>`)
    }
  }
  if (inList) out.push('</ul>')
  return out.join('\n')
}

/** Everything one request needs, so the views stay pure functions of it. */
interface View {
  store: Store
  base: string
  name: string
  /**
   * The territory the list is filtered to: a name, `'none'` for untriaged, or
   * null for everything. It is a query parameter rather than a control, so a
   * filtered list is a URL that can be kept and shared.
   */
  filter: string | null
  /** The path the chips link back to, so filtering keeps the selected task. */
  here: string
}

/** The tasks a view lists, which is every task unless a filter says otherwise. */
function visibleTasks(v: View): Task[] {
  if (v.filter === null) return v.store.tasks
  if (v.filter === 'none') return v.store.tasks.filter((t) => !t.territory)
  return v.store.tasks.filter((t) => t.territory === v.filter)
}

/**
 * The filter chips: everything, then each territory in use, then the untriaged
 * pool. Territories with no tasks are left out - a chip that always reads zero
 * is a control that never does anything.
 */
function filterChips(v: View): string {
  const counts = new Map<string, number>()
  for (const task of v.store.tasks) {
    if (task.territory) counts.set(task.territory, (counts.get(task.territory) ?? 0) + 1)
  }
  const declared = v.store.vocabularies.territories
  const names = declared
    ? declared.filter((t) => counts.has(t))
    : [...counts.keys()].sort()
  const untriaged = v.store.tasks.filter((t) => !t.territory).length

  const chip = (value: string | null, label: string, count: number): string => {
    const href = value === null ? v.here : `${v.here}?t=${encodeURIComponent(value)}`
    return `<a class="chip${v.filter === value ? ' on' : ''}" href="${href}">${esc(label)} <span>${count}</span></a>`
  }

  const chips = [
    chip(null, 'all', v.store.tasks.length),
    ...names.map((t) => chip(t, t, counts.get(t) ?? 0)),
    ...(untriaged ? [chip('none', 'untriaged', untriaged)] : [])
  ]
  // One chip is just a label for "everything", so it is not a filter at all.
  return chips.length > 1 ? `<div class="filters">${chips.join('')}</div>` : ''
}

/**
 * The page shell. The stylesheet is linked absolutely rather than relatively:
 * these pages are rendered at several depths (`/`, `/task/<slug>`), so a
 * relative href would resolve differently on each.
 */
const page = (v: Pick<View, 'base' | 'name'>, title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${v.base}/style.css">
</head>
<body><div class="app">${body}</div><script src="${v.base}/app.js" defer></script></body>
</html>`

const header = (v: View, count?: string): string => `<header>
  <h1>${esc(v.name)}</h1>
  <a href="${v.base}/new" class="newlink">+ new task</a>
  ${count ? `<span class="count">${esc(count)}</span>` : ''}
</header>`

const badge = (text: string, kind = ''): string =>
  `<span class="badge ${esc(kind)}">${esc(text)}</span>`

const unset = (note: string): string => `<span class="muted">– (${esc(note)})</span>`


// ── Controls ──────────────────────────────────────────────────────────────
// Which fields a browser may change is a deliberately narrow question.
//
// Priority is the one property edited in place, because triage is what this
// view is for: deciding what matters is a judgement made while reading the
// list, and it is the one change that is safe to make away from the work.
//
// Status and territory are shown but not editable here. Both are decisions
// that travel with a commit - a status move accompanies the work, a territory
// routes the task to an owner - so they go through the CLI or the agent that
// owns the tracker, where the change lands in a branch alongside what caused
// it.
//
// Title and slug are not editable either: the slug is an id, and a title that
// drifts from the body it heads is worse than one edited deliberately in the
// file.

const PRIORITY_CHOICES: { value: string; label: string }[] = [
  ...PRIORITIES.map((p) => ({ value: p, label: p })),
  { value: '', label: 'none' }
]

/** The priority row: one submit button per choice, the current one pressed. */
function priorityControl(v: View, slug: string, current: string): string {
  const buttons = PRIORITY_CHOICES.map(({ value, label }) => {
    const on = value === current
    const tint = value ? `p-${value}` : 'p-none'
    return `<button name="priority" value="${esc(value)}" class="pbtn ${tint}${on ? ' on' : ''}"${
      on ? ' disabled' : ''
    }>${esc(label)}</button>`
  }).join('')
  return `<form class="prio" method="post" action="${v.base}/task/${esc(slug)}/priority">${buttons}</form>`
}


const dateCell = (date: string): string =>
  date ? `${esc(date)} <span class="muted">(${esc(relativeDate(date))})</span>` : unset('unknown')

const rows = (cells: [string, string][]): string =>
  cells.map(([key, value]) => `<tr><th>${esc(key)}</th><td>${value}</td></tr>`).join('')

/** Every frontmatter key of a task, in file order, plus where it lives. */
function taskTable(v: View, task: Task): string {
  const owner = v.store.vocabularies.ownerOf(task.territory)
  return `<table class="fm">${rows([
    ['slug', `<code>${esc(task.slug)}</code>`],
    ['title', esc(task.title)],
    ['status', badge(task.status, task.status)],
    ['priority', priorityControl(v, task.slug, task.priority)],
    [
      'territory',
      task.territory
        ? `${esc(task.territory)}${owner ? ` <span class="muted">owned by ${esc(owner)}</span>` : ''}`
        : unset('untriaged')
    ],
    ['created_at', dateCell(task.created_at)],
    ['modified_at', dateCell(task.modified_at)],
    ['file', `<code>items/${esc(task.slug)}.md</code>`]
  ])}</table>`
}

const problemList = (problems: string[]): string =>
  problems.length
    ? `<div class="problems-inline"><p>The change was not made:</p><pre>${esc(problems.join('\n'))}</pre></div>`
    : ''

/** Deleting moves the file; it is never an unlink, and it asks twice. */
const deleteForm = (v: View, slug: string): string =>
  `<form class="del" method="post" action="${v.base}/task/${esc(slug)}/delete">
     <button class="dbtn">delete task</button>
     <span class="muted">moves the file to deleted/</span>
   </form>`

// ── The new-task form ─────────────────────────────────────────────────────
// The one place a task is composed rather than adjusted, so it takes the
// fields that are worth setting at the moment of capture and leaves the rest
// at their honest defaults.

const option = (value: string, label: string, current: string): string =>
  `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`

const labelled = (label: string, control: string): string =>
  `<label>${esc(label)}${control}</label>`

function newTaskView(v: View, values: Record<string, string>, problems: string[]): string {
  const territories = v.store.vocabularies.territories
  const territoryControl = territories
    ? `<select name="territory">${[
        option('', '(untriaged)', values['territory'] ?? ''),
        ...territories.map((t) => option(t, t, values['territory'] ?? ''))
      ].join('')}</select>`
    : `<input name="territory" value="${esc(values['territory'] ?? '')}" placeholder="(untriaged)">`

  return page(
    v,
    `New task - ${v.name}`,
    `${header(v)}
     <main class="single">
       <section class="detail">
         <a class="back-always" href="${v.base}/">← all tasks</a>
         <h1>New task</h1>
         ${problemList(problems)}
         <form class="newtask" method="post" action="${v.base}/task/new">
           ${labelled('title', `<input name="title" value="${esc(values['title'] ?? '')}" required maxlength="200" autofocus>`)}
           ${labelled(
             'priority',
             `<select name="priority">${[
               option('', '(untriaged)', values['priority'] ?? ''),
               ...PRIORITIES.map((p) => option(p, p, values['priority'] ?? ''))
             ].join('')}</select>`
           )}
           ${labelled('territory', territoryControl)}
           ${labelled(
             'status',
             `<select name="status">${[
               option('backlog', 'backlog (triage pool)', values['status'] ?? 'backlog'),
               option('todo', 'todo (committed)', values['status'] ?? 'backlog')
             ].join('')}</select>`
           )}
           ${labelled(
             'body',
             `<textarea name="body" rows="12" placeholder="Context, motivation, proposed approach, acceptance criteria - free markdown.">${esc(values['body'] ?? '')}</textarea>`
           )}
           <button class="cbtn">create task</button>
         </form>
       </section>
     </main>`
  )
}

/** The confirmation page delete falls back to when the script is not running. */
function confirmDeleteView(v: View, task: Task): string {
  return page(
    v,
    `Delete ${task.slug} - ${v.name}`,
    `${header(v)}
     <main class="single">
       <section class="detail">
         <a class="back-always" href="${v.base}/task/${esc(task.slug)}">← back to the task</a>
         <h1>Delete this task?</h1>
         <p>${esc(task.title)}</p>
         <p class="muted">Its file moves to <code>deleted/${esc(task.slug)}.md</code>. Nothing is unlinked, so this is undone by moving one file back.</p>
         <form class="del" method="post" action="${v.base}/task/${esc(task.slug)}/delete">
           <input type="hidden" name="confirm" value="1">
           <button class="dbtn armed">delete ${esc(task.slug)}</button>
         </form>
       </section>
     </main>`
  )
}


/**
 * The groups one status contributes to the list.
 *
 * Status is the outer order, as the pick-up order in INDEX.md is. The triage
 * pool is the one status worth splitting: a backlog of any size is mostly
 * untriaged, and the few items someone has already ranked are exactly what
 * gets lost in it. So they surface above as `prioritized`, and the rest stay
 * `backlog`. Every other status is one group, because a priority within it is
 * an ordering rather than a division.
 */
interface Group {
  label: string
  tasks: Task[]
}

function groupsOf(tasks: Task[], status: string): Group[] {
  const inStatus = tasks.filter((t) => t.status === status).sort(taskOrder)
  if (!inStatus.length) return []
  if (status !== 'backlog') return [{ label: status, tasks: inStatus }]

  const triaged = inStatus.filter((t) => t.priority)
  const untriaged = inStatus.filter((t) => !t.priority)
  return [
    ...(triaged.length ? [{ label: 'prioritized', tasks: triaged }] : []),
    ...(untriaged.length ? [{ label: 'backlog', tasks: untriaged }] : [])
  ]
}

/**
 * Older titles recede.
 *
 * A tracker accumulates, and in a long list the eye needs somewhere to land:
 * what was touched recently should read as louder than what has been sitting
 * for a month. The fade is deliberately shallow - it is a hint about age, not
 * a second priority system, and nothing becomes hard to read.
 */
export function fade(task: Task, from?: string): string {
  const date = task.modified_at || task.created_at
  if (!date) return ''
  const days = Math.round(
    (Date.parse(`${from ?? today()}T00:00:00`) - Date.parse(`${date}T00:00:00`)) / 86400000
  )
  if (!Number.isFinite(days) || days <= 0) return ''
  const opacity = Math.max(0.72, 1 - days * 0.01)
  return ` style="opacity:${opacity.toFixed(3)}"`
}

function tasksView(v: View, selected: Task | null, problems: string[] = []): string {
  const shown = visibleTasks(v)
  let list = filterChips(v)
  for (const status of TASK_STATUSES) {
    for (const group of groupsOf(shown, status)) {
      list += `<div class="group">${esc(group.label)} (${group.tasks.length})</div>`
      for (const t of group.tasks) {
        list += `<a class="row ${selected?.slug === t.slug ? 'sel' : ''}" href="${v.base}/task/${t.slug}">
          <span class="title"${fade(t)}>${esc(t.title)}</span>
          <span class="meta">${t.priority ? badge(t.priority, `p-${t.priority}`) : ''}
            ${group.label === t.status ? '' : badge(t.status, t.status)}
            ${t.territory ? badge(t.territory) : ''}</span>
        </a>`
      }
    }
  }

  let detail: string
  if (selected) {
    detail = `<a class="back" href="${v.base}/">← all tasks</a>
      <h1>${esc(selected.title)}</h1>
      ${problemList(problems)}
      ${taskTable(v, selected)}
      <article>${markdown(selected.body, v.base)}</article>
      ${deleteForm(v, selected.slug)}`
  } else {
    detail = `<div class="empty"><p>Select a task from the list</p></div>`
  }

  return page(
    v,
    selected ? `${selected.title} - ${v.name}` : `Tasks - ${v.name}`,
    `${header(v, `${v.store.tasks.length} tasks`)}
     <main class="${selected ? 'has-detail' : 'no-detail'}">
       <aside>${list}</aside>
       <section class="detail">${detail}</section>
     </main>`
  )
}

const notFoundPage = (v: View, what: string): string =>
  page(v, `Not found - ${v.name}`, `${header(v)}<div class="problems"><p>${esc(what)}</p></div>`)


// ── Writes ────────────────────────────────────────────────────────────────

const BODY_LIMIT = 1024 * 1024

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * The browser must be on OUR page. This server writes files in the repository,
 * so a form posted from anywhere else is refused outright rather than trusted
 * to be harmless - the same check map-editor makes before it lists directories.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true // not a browser, or a request without a form origin
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** Form values, with every field trimmed; absent and blank are both "unset". */
function formValues(body: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(body)) values[key] = value.trim()
  return values
}

/** The problems an edit reported, in the shape the page lists them. */
function problemsOf(e: unknown): string[] {
  if (e instanceof ValidationError) return e.problems
  if (e instanceof UsageError) return [e.message]
  throw e
}

const pick = (values: Record<string, string>, keys: readonly string[]): Record<string, string> =>
  Object.fromEntries(keys.filter((k) => k in values).map((k) => [k, values[k]!]))

/**
 * A slug, made from the title.
 *
 * Composing a task in a browser should not also mean composing an id, so the
 * title supplies one - kebab-cased, stripped to what a slug may hold. The
 * result is permanent, which is why it is derived once here and never again
 * when the title is edited.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
}

/** The first free slug in the `slug`, `slug-2`, `slug-3` series. */
export function uniqueSlug(store: Store, slug: string): string {
  const taken = new Set(store.tasks.map((t) => t.slug))
  if (!taken.has(slug)) return slug
  for (let n = 2; ; n++) if (!taken.has(`${slug}-${n}`)) return `${slug}-${n}`
}

function serveStatic(res: ServerResponse, urlPath: string): boolean {
  const file = normalize(join(publicDir, urlPath.slice(1)))
  if (!file.startsWith(publicDir) || !existsSync(file)) return false
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
  return true
}

/**
 * Build the server. The tracker is re-read per request, so an invalid file
 * shows as an error page and is fixed by fixing the file, with no restart.
 */
export function createTaskServer(options: ServerOptions): Server {
  const dir = options.dir
  const base = normalizeBasePath(options.basePath)
  const name = options.title ?? 'tasks'

  return createServer((req, res) => {
    void handle(req, res).catch((e) => {
      if (res.headersSent) return
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(`${(e as Error).message}\n`)
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (code: number, html: string) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    }
    const plain = (code: number, text: string) => {
      res.writeHead(code, { 'content-type': 'text/plain' })
      res.end(text)
    }
    /** After a write, redirect so a refresh does not repeat it. */
    const seeOther = (to: string) => {
      res.writeHead(303, { location: `${base}${to}` })
      res.end()
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    // A configured base path is the mount: a request outside it is not ours.
    let path = pathname
    if (base) {
      if (pathname === base) path = '/'
      else if (pathname.startsWith(base + '/')) path = pathname.slice(base.length)
      else return plain(404, 'not found')
    }

    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'POST') return plain(405, 'method not allowed')
    if (method === 'POST' && !sameOrigin(req)) return plain(403, 'cross-origin write refused')
    if (method === 'GET' && path !== '/' && serveStatic(res, path)) return

    let store: Store
    try {
      store = load(dir)
    } catch (e) {
      const problem = e instanceof ValidationError || e instanceof UsageError ? e.message : String(e)
      return send(
        500,
        page({ base, name }, `Error - ${name}`, `<div class="problems">
          <h1>The tracker does not validate</h1>
          <pre>${esc(problem)}</pre>
          <p class="muted">Fix the file and reload; nothing here needs restarting.</p></div>`)
      )
    }

    const filter = url.searchParams.get('t')
    const v: View = { store, base, name, filter, here: `${base}${path === '/' ? '/' : path}` }

    // ── Writes ──
    if (method === 'POST') {
      const values = formValues(await readRequestBody(req))

      if (path === '/task/new') {
        try {
          const slug = slugify(values['title'] ?? '')
          if (!slug) throw new UsageError('a title is required, and is what the slug is made from')
          const fields = pick(values, SETTABLE_TASK_KEYS)
          const unique = uniqueSlug(store, slug)
          createTask(dir, unique, fields as TaskFields, values['body'] ?? '')
          return seeOther(`/task/${unique}`)
        } catch (e) {
          return send(400, newTaskView(v, values, problemsOf(e)))
        }
      }

      let m = path.match(/^\/task\/([a-z0-9.-]+)\/priority$/)
      if (m) {
        const slug = m[1]!
        try {
          updateTask(dir, slug, { priority: values['priority'] ?? '' })
          return seeOther(`/task/${slug}`)
        } catch (e) {
          const current = load(dir)
          const task = current.tasks.find((t) => t.slug === slug)
          const w: View = { ...v, store: current }
          return task
            ? send(400, tasksView(w, task, problemsOf(e)))
            : send(404, notFoundPage(w, `No task ${slug}.`))
        }
      }

      m = path.match(/^\/task\/([a-z0-9.-]+)\/delete$/)
      if (m) {
        const slug = m[1]!
        const task = store.tasks.find((t) => t.slug === slug)
        if (!task) return send(404, notFoundPage(v, `No task ${slug}.`))
        // Without the script the first post lands here unconfirmed, and gets a
        // page that asks - so deleting takes two deliberate acts either way.
        if (!values['confirm']) return send(200, confirmDeleteView(v, task))
        try {
          deleteTask(dir, slug)
          return seeOther('/')
        } catch (e) {
          return send(400, tasksView(v, task, problemsOf(e)))
        }
      }
      return plain(404, 'not found')
    }

    // ── Reads ──
    if (path === '/' || path === '/tasks') return send(200, tasksView(v, null))
    if (path === '/new') return send(200, newTaskView(v, {}, []))

    const m = path.match(/^\/task\/([a-z0-9.-]+)$/)
    if (m) {
      const task = store.tasks.find((t) => t.slug === m[1])
      return task
        ? send(200, tasksView(v, task))
        : send(404, notFoundPage(v, `No task ${m[1]}.`))
    }
    send(404, notFoundPage(v, 'Nothing here.'))
  }
}

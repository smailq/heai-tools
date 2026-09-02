import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createTaskServer, normalizeBasePath } from '../src/server.ts'

const task = (f: Record<string, string> = {}): string =>
  `---\ntitle: ${f['title'] ?? 'A task'}\nstatus: ${f['status'] ?? 'todo'}\npriority: ${f['priority'] ?? ''}\nterritory: ${f['territory'] ?? ''}\ncreated_at: 2026-08-20\nmodified_at: 2026-08-20\n---\n\nBody with [other](other.md).\n`

function tracker(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'task-manager-server-'))
  mkdirSync(join(dir, 'items'), { recursive: true })
  for (const [path, contents] of Object.entries(files)) writeFileSync(join(dir, path), contents)
  return dir
}

const DIR = tracker({
  'config.yaml': 'map: ./map.yaml\n',
  'map.yaml': 'territories:\n  api:\n    owner: api-owner\n  web:\n    owner: web-owner\n',
  'items/one.md': task({ title: 'One', territory: 'api' }),
  'items/other.md': task({ title: 'Other' })
})

let server: Server
let origin: string

before(async () => {
  server = createTaskServer({ dir: DIR, basePath: '/tasks', title: 'tasks' })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => server.close())

const get = (path: string): Promise<Response> => fetch(`${origin}${path}`)

const post = (path: string, fields: Record<string, string>): Promise<Response> =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual'
  })

test('normalizeBasePath makes one option out of three spellings', () => {
  assert.equal(normalizeBasePath('tasks'), '/tasks')
  assert.equal(normalizeBasePath('/tasks'), '/tasks')
  assert.equal(normalizeBasePath('/tasks/'), '/tasks')
  assert.equal(normalizeBasePath(''), '')
  assert.equal(normalizeBasePath(undefined), '')
})

test('the mount root and its pages serve under the base path', async () => {
  for (const path of ['/tasks', '/tasks/', '/tasks/task/one', '/tasks/task/other']) {
    assert.equal((await get(path)).status, 200, path)
  }
})

test('a request outside the mount is not ours', async () => {
  for (const path of ['/', '/task/one', '/tasksomething']) {
    assert.equal((await get(path)).status, 404, path)
  }
})

test('the stylesheet is served from public/, under the mount', async () => {
  const res = await get('/tasks/style.css')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8')
  assert.match(await res.text(), /--accent/)
})

test('pages link the stylesheet absolutely, so every depth resolves it', async () => {
  for (const path of ['/tasks/', '/tasks/task/one']) {
    assert.match(await (await get(path)).text(), /href="\/tasks\/style\.css"/, path)
  }
})

test('a task page shows every frontmatter key, and its two timestamps', async () => {
  const html = await (await get('/tasks/task/one')).text()
  assert.match(html, /<h1>One<\/h1>/)
  for (const key of ['slug', 'title', 'status', 'priority', 'territory', 'created_at', 'modified_at', 'file']) {
    assert.match(html, new RegExp(`<th>${key}</th>`), key)
  }
  assert.match(html, /owned by api-owner/)
  assert.match(html, /items\/one\.md/)
  // Dates read as age, which is what a list of work is actually scanned for.
  assert.match(html, /\(\d+ days ago\)|\(today\)|\(yesterday\)/)
})

test('priority, status and territory are the only fields with controls', async () => {
  const html = await (await get('/tasks/task/one')).text()
  // Priority and status carry buttons...
  assert.match(html, /<form class="prio"[^>]*action="\/tasks\/task\/one\/priority"/)
  for (const value of ['urgent', 'high', 'medium', 'low']) {
    assert.match(html, new RegExp(`name="priority" value="${value}"`), value)
  }
  assert.match(html, /<form class="prio"[^>]*action="\/tasks\/task\/one\/status"/)
  for (const value of ['in-progress', 'in-review', 'blocked', 'todo', 'backlog', 'done', 'canceled']) {
    assert.match(html, new RegExp(`name="status" value="${value}"`), value)
  }
  // ...territory carries one toggle per territory the map declares...
  assert.match(html, /<form class="prio"[^>]*action="\/tasks\/task\/one\/territory"/)
  assert.match(html, /class="pbtn t-set on" title="owned by api-owner">api</)
  assert.match(html, /class="pbtn t-set" title="owned by web-owner">web</)
  // ...and nothing else does: title and slug are shown only.
  for (const key of ['title', 'slug']) {
    assert.doesNotMatch(html, new RegExp(`name="${key}"`), key)
  }
  assert.doesNotMatch(html, /<select/)
  assert.doesNotMatch(html, /name="note"/)
})

test('territory toggles post the set as it would be after the click', async () => {
  // `one` sits in api: the api button posts the set without it, the web
  // button posts the set with web added, and `none` clears it.
  const html = await (await get('/tasks/task/one')).text()
  assert.match(html, /name="territory" value="" class="pbtn t-set on"[^>]*>api</)
  assert.match(html, /name="territory" value="api, web" class="pbtn t-set"[^>]*>web</)
  assert.match(html, /name="territory" value="" class="pbtn t-none">none</)

  const res = await post('/tasks/task/one/territory', { territory: 'web, api' })
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), '/tasks/task/one')
  // Written canonically: sorted, unique, one line.
  assert.match(readFileSync(join(DIR, 'items', 'one.md'), 'utf8'), /territory: api, web\n/)

  const after = await (await get('/tasks/task/one')).text()
  assert.match(after, /class="pbtn t-set on"[^>]*>api</)
  assert.match(after, /class="pbtn t-set on"[^>]*>web</)
  assert.match(after, /owned by api-owner \(api\), web-owner \(web\)/)
  // Every territory the task sits in is a badge in the list, and a chip counts it.
  assert.match(after, /<span class="badge ">api<\/span> <span class="badge ">web<\/span>/)
  assert.match(after, /href="\/tasks\/task\/one\?t=web">web <span>1<\/span>/)
  assert.match(await (await get('/tasks/?t=web')).text(), /href="\/tasks\/task\/one"/)

  // Back to api alone, so the tests after this one see what they expect.
  await post('/tasks/task/one/territory', { territory: 'api' })
  assert.match(readFileSync(join(DIR, 'items', 'one.md'), 'utf8'), /territory: api\n/)
})

test('a territory the map does not declare is refused, and nothing is written', async () => {
  const before = readFileSync(join(DIR, 'items', 'one.md'), 'utf8')
  const res = await post('/tasks/task/one/territory', { territory: 'api, nope' })
  assert.equal(res.status, 400)
  assert.match(await res.text(), /territory &quot;nope&quot; not in/)
  assert.equal(readFileSync(join(DIR, 'items', 'one.md'), 'utf8'), before)
})

test('the current status is the pressed button, and setting one writes it', async () => {
  // Task `one` starts as todo.
  const html = await (await get('/tasks/task/one')).text()
  assert.match(html, /class="pbtn s-todo on" disabled>todo</)
  assert.match(html, /class="pbtn s-in-progress">in-progress</)

  const res = await post('/tasks/task/one/status', { status: 'in-progress' })
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), '/tasks/task/one')
  assert.match(readFileSync(join(DIR, 'items', 'one.md'), 'utf8'), /status: in-progress/)

  const after = await (await get('/tasks/task/one')).text()
  assert.match(after, /class="pbtn s-in-progress on" disabled>in-progress</)
  await post('/tasks/task/one/status', { status: 'todo' })
})

test('an invalid status is refused and nothing is written', async () => {
  const before = readFileSync(join(DIR, 'items', 'other.md'), 'utf8')
  const res = await post('/tasks/task/other/status', { status: 'paused' })
  assert.equal(res.status, 400)
  assert.match(await res.text(), /paused&quot; not in/)
  assert.equal(readFileSync(join(DIR, 'items', 'other.md'), 'utf8'), before)
})

test('the current priority is the pressed button, and cannot be re-submitted', async () => {
  // Task `one` has no priority, so `none` is the pressed one.
  const html = await (await get('/tasks/task/one')).text()
  assert.match(html, /class="pbtn p-none on" disabled>none</)
  assert.match(html, /class="pbtn p-urgent">urgent</)
})

test('setting a priority writes it and redirects back to the task', async () => {
  const res = await post('/tasks/task/one/priority', { priority: 'high' })
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), '/tasks/task/one')
  assert.match(readFileSync(join(DIR, 'items', 'one.md'), 'utf8'), /priority: high/)
  // The view is regenerated as part of the write.
  assert.match(readFileSync(join(DIR, 'INDEX.md'), 'utf8'), /· p:high/)

  const after = await (await get('/tasks/task/one')).text()
  assert.match(after, /class="pbtn p-high on" disabled>high</)
})

test('clearing a priority is a value, not a missing one', async () => {
  await post('/tasks/task/one/priority', { priority: 'low' })
  const res = await post('/tasks/task/one/priority', { priority: '' })
  assert.equal(res.status, 303)
  assert.match(readFileSync(join(DIR, 'items', 'one.md'), 'utf8'), /priority:\n/)
})

test('an invalid priority is refused and nothing is written', async () => {
  const before = readFileSync(join(DIR, 'items', 'other.md'), 'utf8')
  const res = await post('/tasks/task/other/priority', { priority: 'soon' })
  assert.equal(res.status, 400)
  assert.match(await res.text(), /soon&quot; not in/)
  assert.equal(readFileSync(join(DIR, 'items', 'other.md'), 'utf8'), before)
})

// ── Creating ──────────────────────────────────────────────────────────────

test('the new-task page renders, and the header links to it', async () => {
  assert.equal((await get('/tasks/new')).status, 200)
  assert.match(await (await get('/tasks/')).text(), /href="\/tasks\/new" class="newlink"/)
})

test('the new-task form offers only what is worth setting at capture', async () => {
  const html = await (await get('/tasks/new')).text()
  for (const name of ['title', 'priority', 'territory', 'status', 'body']) {
    assert.match(html, new RegExp(`name="${name}"`), name)
  }
  // A closed vocabulary is a set of checkboxes, so the page cannot offer a
  // bad value, and a task can be captured into more than one territory.
  assert.match(html, /<input type="checkbox" name="territory" value="api">/)
  assert.match(html, /<input type="checkbox" name="territory" value="web">/)
  assert.doesNotMatch(html, /<select name="territory">/)
  // Status at capture is only ever the triage pool or the committed queue.
  assert.match(html, /<option value="backlog"/)
  assert.match(html, /<option value="todo"/)
  assert.doesNotMatch(html, /<option value="done"/)
  // The slug is derived from the title, never typed.
  assert.doesNotMatch(html, /name="slug"/)
})

test('creating derives the slug from the title and redirects to it', async () => {
  const res = await post('/tasks/task/new', {
    title: 'Cache the INDEX, please!',
    priority: 'medium',
    territory: 'api',
    status: 'todo',
    body: 'Rebuilt per request.'
  })
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), '/tasks/task/cache-the-index-please')

  const file = readFileSync(join(DIR, 'items', 'cache-the-index-please.md'), 'utf8')
  assert.match(file, /title: Cache the INDEX, please!/)
  assert.match(file, /priority: medium/)
  assert.match(file, /created_at: \d{4}-\d{2}-\d{2}/)
})

test('a title colliding with an existing slug gets the next one free', async () => {
  await post('/tasks/task/new', { title: 'Twice over', status: 'backlog', body: 'One.' })
  const res = await post('/tasks/task/new', { title: 'Twice over', status: 'backlog', body: 'Two.' })
  assert.equal(res.headers.get('location'), '/tasks/task/twice-over-2')
})

test('a title with nothing a slug can use is refused', async () => {
  const res = await post('/tasks/task/new', { title: '!!!', body: 'B' })
  assert.equal(res.status, 400)
  assert.match(await res.text(), /a title is required/)
})

test('checked territories fold into one list on the created task', async () => {
  const res = await fetch(`${origin}/tasks/task/new`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'title=Crosses+a+boundary&territory=web&territory=api&body=B',
    redirect: 'manual'
  })
  assert.equal(res.status, 303)
  const file = readFileSync(join(DIR, 'items', 'crosses-a-boundary.md'), 'utf8')
  assert.match(file, /territory: api, web\n/)
  // The re-rendered form keeps both boxes checked when creation is refused.
  const bad = await fetch(`${origin}/tasks/task/new`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'title=&territory=web&territory=api&body=B',
    redirect: 'manual'
  })
  assert.equal(bad.status, 400)
  const html = await bad.text()
  assert.match(html, /value="api" checked/)
  assert.match(html, /value="web" checked/)
})

test('a rejected creation re-renders the form with what was typed', async () => {
  const res = await post('/tasks/task/new', { title: 'Has a bad territory', territory: 'nope', body: 'B' })
  assert.equal(res.status, 400)
  const html = await res.text()
  assert.match(html, /territory &quot;nope&quot; not in/)
  assert.match(html, /value="Has a bad territory"/)
  assert.match(html, />B<\/textarea>/)
})

// ── Deleting ──────────────────────────────────────────────────────────────

test('the task page offers delete, and says what it does', async () => {
  const html = await (await get('/tasks/task/other')).text()
  assert.match(html, /<form class="del"[^>]*action="\/tasks\/task\/other\/delete"/)
  assert.match(html, /moves the file to deleted\//)
})

test('deleting without confirmation asks first, and deletes nothing', async () => {
  const res = await post('/tasks/task/other/delete', {})
  assert.equal(res.status, 200)
  assert.match(await res.text(), /Delete this task\?/)
  assert.ok(readFileSync(join(DIR, 'items', 'other.md'), 'utf8'))
})

test('a confirmed delete moves the file and returns to the list', async () => {
  const res = await post('/tasks/task/other/delete', { confirm: '1' })
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), '/tasks/')
  assert.ok(!existsSync(join(DIR, 'items', 'other.md')))
  assert.match(readFileSync(join(DIR, 'deleted', 'other.md'), 'utf8'), /title: Other/)
})

// ── Filtering ─────────────────────────────────────────────────────────────

test('the chips count each territory, and the untriaged pool', async () => {
  const html = await (await get('/tasks/')).text()
  assert.match(html, /<a class="chip on" href="\/tasks\/">all <span>\d+<\/span>/)
  assert.match(html, /href="\/tasks\/\?t=api">api <span>\d+<\/span>/)
  assert.match(html, /href="\/tasks\/\?t=none">untriaged <span>\d+<\/span>/)
})

test('a filter narrows the list and marks its own chip', async () => {
  const html = await (await get('/tasks/?t=none')).text()
  assert.match(html, /<a class="chip on" href="\/tasks\/\?t=none">untriaged/)
  // `one` has territory api, so a filter to the untriaged pool excludes it.
  assert.doesNotMatch(html, /href="\/tasks\/task\/one"/)
})

test('filtering keeps the selected task, so the detail pane does not empty', async () => {
  const html = await (await get('/tasks/task/one?t=api')).text()
  assert.match(html, /href="\/tasks\/task\/one\?t=api"/)
  assert.match(html, /<h1>One<\/h1>/)
})

// ── The enhancement script ────────────────────────────────────────────────

test('the page is wrapped for the script, and links it', async () => {
  const html = await (await get('/tasks/')).text()
  assert.match(html, /<div class="app">/)
  assert.match(html, /<script src="\/tasks\/app\.js" defer>/)
  assert.equal((await get('/tasks/app.js')).status, 200)
})

test('a cross-origin write is refused', async () => {
  const res = await fetch(`${origin}/tasks/task/one/priority`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://elsewhere.example' },
    body: 'priority=low',
    redirect: 'manual'
  })
  assert.equal(res.status, 403)
})

test('a write to a slug that does not exist is a 404', async () => {
  assert.equal((await post('/tasks/task/nope/priority', { priority: 'low' })).status, 404)
  assert.equal((await post('/tasks/task/nope/delete', { confirm: '1' })).status, 404)
  assert.equal((await post('/tasks/elsewhere', {})).status, 404)
})

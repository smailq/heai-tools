import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fixtureReading, get, send, serve, type Served } from './helpers.ts'

let s: Served
before(async () => {
  s = await serve(fixtureReading())
})
after(() => s.close())

const TABS = ['href="/architect/"', 'href="/tasks"', 'href="/flows"', 'href="/pod"', 'href="/reactor"']

test('each pane is a tab, and every page carries all of them', async () => {
  const cases: Array<[string, string[]]> = [
    ['/tasks', ['class="optab on"><b>tasks', 'add-place-entity', 'desktop-owner', 'help-requested-by-web-ui', '(blocker canceled)', 'missing frontmatter key: territory']],
    ['/tasks?active=1&sort=slug', ['── active', 'class="on">slug']],
    ['/flows', ['class="optab on"><b>flows', '20260906-024801-session-77f0', '<h2>stuck</h2>', '<h2>definitions</h2>']],
    ['/flows/machines', ['class="optab on"><b>flows', '<svg class="machine"', 'href="/flows/machines" class="on"']],
    ['/architect/', ['class="optab on"><b>architect', 'id="save-btn"']],
    ['/pod', ['class="optab on"><b>pod', 'heai-workshop', '(the clone)', 'agent/desktop-owner/add-place-entity']],
    ['/reactor', ['class="optab on"><b>reactor', '<h2>sources</h2>', '<h2>rules</h2>', 'exited 3']]
  ]
  for (const [path, want] of cases) {
    const r = await get(s.url + path)
    assert.equal(r.status, 200, path)
    for (const w of [...want, ...TABS]) assert.ok(r.body.includes(w), `${path}: missing ${w}`)
  }
})

test('the page is dark, and only dark', async () => {
  const page = await get(s.url + '/tasks')
  assert.match(page.body, /<meta name="color-scheme" content="dark">/)
  const nav = await get(s.url + '/static/nav.css')
  assert.equal(nav.status, 200)
  assert.match(nav.body, /color-scheme: dark/, 'the tokens, for every page, are dark')
  for (const sheet of ['/static/nav.css', '/static/operator.css', '/architect/style.css']) {
    assert.doesNotMatch((await get(s.url + sheet)).body, /prefers-color-scheme|color-scheme: light/, sheet)
  }
})

test('a page per row, and a 404 for a row that is not there', async () => {
  for (const [path, want] of [
    ['/tasks/document-tabs', 'help-requested-by-web-ui'],
    ['/flows/20260906-024801-session-77f0', 'trace'],
    ['/pod/w3', 'agent-desktop-owner-add-place-entity'],
    ['/reactor/20260911-030505-73776c', 'payload']
  ]) {
    const r = await get(s.url + path!)
    assert.equal(r.status, 200, path)
    assert.ok(r.body.includes(want!), `${path}: missing ${want}`)
  }
  for (const path of ['/tasks/nope', '/flows/--help', '/pod/w9', '/reactor/nope', '/flows/machines/nope']) {
    assert.equal((await get(s.url + path)).status, 404, path)
  }
})

test('what the tools report is text, never markup', async () => {
  const reading = fixtureReading()
  reading.tracker!.tasks[0]!.title = '<script>alert(1)</script>'
  reading.flows.flows[0]!.links = { task: '"><img src=x onerror=alert(1)>' }
  const t = await serve(reading)
  try {
    const task = await get(`${t.url}/tasks/${reading.tracker!.tasks[0]!.slug}`)
    assert.ok(!task.body.includes('<script>alert'))
    assert.ok(task.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
    const flows = await get(`${t.url}/flows`)
    assert.ok(!flows.body.includes('<img src=x'))
  } finally {
    await t.close()
  }
})

test('the primary tabs are architect, tasks, flows, pod, reactor, in that order, on every page, the map editor too', async () => {
  for (const path of ['/tasks', '/flows/machines', '/architect/']) {
    const body = (await get(s.url + path)).body
    const order = [...body.matchAll(/class="optab[^"]*"><b>([a-z]+)<\/b>/g)].map((m) => m[1])
    assert.deepEqual(order, ['architect', 'tasks', 'flows', 'pod', 'reactor'], path)
  }
  const editor = (await get(s.url + '/architect/')).body
  assert.ok(!editor.includes('<!-- operator-nav -->'), 'the tabs are put in the editor page')
  assert.ok(editor.includes('class="optab on"><b>architect'))
  assert.equal((await get(s.url + '/machines')).status, 404, 'the machines live under the flows now')
  assert.equal((await get(s.url + '/map/')).status, 404, 'the editor lives under the architect now')
})

test('the flows tab has its own tabs: the flows, and the machines', async () => {
  const list = (await get(s.url + '/flows')).body
  assert.ok(list.includes('<a href="/flows" class="on">flows</a><a href="/flows/machines">machines</a>'))
  const machines = (await get(s.url + '/flows/machines')).body
  assert.ok(machines.includes('<a href="/flows">flows</a><a href="/flows/machines" class="on">machines</a>'))
})

test('the root goes to the first tab, the architect', async () => {
  const r = await get(s.url + '/')
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), '/architect/')
})

test('the panes are read only, and keep their scripts to this server', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal((await send(method, s.url + '/tasks', {})).status, 405, method)
  }
  const r = await get(s.url + '/tasks')
  assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'self'/)
})

test('/api/state is the reading as JSON, red when something is', async () => {
  const r = await get(s.url + '/api/state')
  const out = JSON.parse(r.body) as { tracker: { tasks: unknown[] }; flows: { flows: unknown[] }; red: boolean }
  assert.ok(out.tracker.tasks.length > 0 && out.flows.flows.length > 0)
  assert.equal(out.red, true, 'the tracker fixture carries a broken file')
})

test('static files, and nothing outside them', async () => {
  for (const p of ['/static/nav.css', '/static/operator.css', '/static/operator.js', '/architect/', '/architect/app.js', '/architect/vendor/cytoscape.min.js']) {
    assert.equal((await get(s.url + p)).status, 200, p)
  }
  for (const p of ['/static/../src/cli.ts', '/static/%2e%2e/%2e%2e/package.json', '/architect/..%2f..%2fpackage.json']) {
    assert.equal((await get(s.url + p)).status, 404, p)
  }
})

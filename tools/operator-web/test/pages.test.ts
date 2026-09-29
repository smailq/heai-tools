import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fixtureReading, get, send, serve, type Served } from './helpers.ts'

let s: Served
before(async () => {
  s = await serve(fixtureReading())
})
after(() => s.close())

const TABS = ['href="/tasks"', 'href="/flows"', 'href="/machines"', 'href="/pod"', 'href="/reactor"', 'href="/map/"']

test('each pane is a tab, and every page carries all of them', async () => {
  const cases: Array<[string, string[]]> = [
    ['/tasks', ['class="tab on"><b>tasks', 'add-place-entity', 'desktop-owner', 'help-requested-by-web-ui', '(blocker canceled)', 'missing frontmatter key: territory']],
    ['/tasks?active=1&sort=slug', ['── active', 'class="on">slug']],
    ['/flows', ['class="tab on"><b>flows', '20260906-024801-session-77f0', '<h2>stuck</h2>', '<h2>definitions</h2>']],
    ['/machines', ['class="tab on"><b>machines', '<svg class="machine"']],
    ['/pod', ['class="tab on"><b>pod', 'heai-workshop', '(the clone)', 'agent/desktop-owner/add-place-entity']],
    ['/reactor', ['class="tab on"><b>reactor', '<h2>sources</h2>', '<h2>rules</h2>', 'exited 3']]
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
  const css = await get(s.url + '/static/operator.css')
  assert.equal(css.status, 200)
  assert.match(css.body, /color-scheme: dark/)
  assert.doesNotMatch(css.body, /prefers-color-scheme|color-scheme: light/)
  const map = await get(s.url + '/map/style.css')
  assert.doesNotMatch(map.body, /prefers-color-scheme/)
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
  for (const path of ['/tasks/nope', '/flows/--help', '/pod/w9', '/reactor/nope', '/machines/nope']) {
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

test('the root goes to the tasks', async () => {
  const r = await get(s.url + '/')
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), '/tasks')
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
  for (const p of ['/static/operator.css', '/static/operator.js', '/map/', '/map/app.js', '/map/vendor/cytoscape.min.js']) {
    assert.equal((await get(s.url + p)).status, 200, p)
  }
  for (const p of ['/static/../src/cli.ts', '/static/%2e%2e/%2e%2e/package.json', '/map/..%2f..%2fpackage.json']) {
    assert.equal((await get(s.url + p)).status, 404, p)
  }
})

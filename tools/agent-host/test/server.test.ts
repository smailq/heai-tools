import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createHost, type Host } from '../src/host.ts'
import { createAgentServer, normalizeBasePath } from '../src/server.ts'
import { commitIn, FakeContainers, makeRepo, type Repo } from './helpers.ts'

let repo: Repo
let containers: FakeContainers
let host: Host
let server: Server
let origin: string

before(async () => {
  repo = makeRepo()
  repo.task('t1', { title: 'Task one', territory: 'alpha' })
  containers = new FakeContainers()
  host = await createHost({ mapPath: repo.map, tasksDir: repo.tasks, stateDir: repo.state, configPath: repo.config, containers })
  server = createAgentServer({ host, basePath: '/agents', settleEveryMs: 100 })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => server.close())

const get = (path: string) => fetch(`${origin}${path}`)
const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(body) })
const postForm = (path: string, fields: Record<string, string>) =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual'
  })

test('normalizeBasePath makes one option out of three spellings', () => {
  assert.equal(normalizeBasePath('agents'), '/agents')
  assert.equal(normalizeBasePath('/agents/'), '/agents')
  assert.equal(normalizeBasePath(undefined), '')
})

test('the page lists every llm-agent the map declares, absent ones included', async () => {
  const res = await get('/agents/')
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.match(html, /href="\/agents\/actor\/alpha"/)
  assert.match(html, /href="\/agents\/actor\/beta"/)
  assert.match(html, /absent/)
  assert.match(html, /href="\/agents\/style\.css"/)
  assert.equal((await get('/')).status, 404)
  assert.equal((await get('/agents/actor/smailq')).status, 404)
})

test('the API: actors, up, assign, run, log, tasks, cancel', async () => {
  let res = await get('/agents/api/actors')
  assert.equal(res.status, 200)
  const actors = (await res.json()) as { name: string; container: string }[]
  assert.deepEqual(actors.map((a) => [a.name, a.container]), [['alpha', 'absent'], ['beta', 'absent']])

  res = await postJson('/agents/api/actors/alpha/up', {})
  assert.equal(res.status, 202)
  assert.equal(((await get('/agents/api/actors/alpha')).status), 200)

  res = await postJson('/agents/api/actors/alpha/runs', { task: 't1' })
  assert.equal(res.status, 202)
  const { run, queued } = (await res.json()) as { run: { id: string; status: string; ref: string }; queued: boolean }
  assert.equal(queued, false)
  assert.equal(run.status, 'running')

  res = await get(`/agents/api/runs/${run.id}`)
  assert.equal(res.status, 200)
  const record = (await res.json()) as { status: string; prompt: string }
  assert.equal(record.status, 'running')
  assert.match(record.prompt, /# You are `alpha`/)

  // A second assignment of the same task is a conflict, as JSON.
  res = await postJson('/agents/api/actors/alpha/runs', { task: 't1' })
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /already running/)

  res = await get('/agents/api/tasks')
  const tasks = (await res.json()) as { slug: string; routedTo: string[]; run: string | null }[]
  assert.deepEqual(tasks.map((t) => [t.slug, t.routedTo, t.run]), [['t1', ['alpha'], run.id]])

  // The log follows until the exit file appears.
  const follow = get(`/agents/api/runs/${run.id}/log?follow=1`)
  commitIn(containers.checkoutOf('heai-alpha'), 'alpha/x.md', 'x\n')
  setTimeout(() => containers.finish('heai-alpha', run.id, 0, 'all done\n'), 200)
  res = await follow
  assert.equal(res.status, 200)
  assert.match(await res.text(), /all done/)

  res = await get(`/agents/api/runs/${run.id}`)
  assert.equal(((await res.json()) as { status: string; gate: { verdict: string } }).gate.verdict, 'clean')
  res = await postJson(`/agents/api/runs/${run.id}/cancel`, {})
  assert.equal(res.status, 409)
  res = await get(`/agents/api/actors/alpha/runs`)
  assert.equal(((await res.json()) as unknown[]).length, 1)
  res = await get('/agents/api/map')
  assert.equal(((await res.json()) as { hash: string }).hash, host.map.hash)
})

test('the page: the actor detail, the run page, and the assign form', async () => {
  let res = await get('/agents/actor/alpha')
  let html = await res.text()
  assert.match(html, /idle/)
  assert.match(html, /<h2>History<\/h2>/)
  assert.match(html, /gate-clean/)
  const id = html.match(/\/agents\/run\/([0-9]{8}-[0-9]{6}-alpha-[0-9a-f]{4})/)![1]!
  res = await get(`/agents/run/${id}`)
  html = await res.text()
  assert.equal(res.status, 200)
  assert.match(html, /agent\/alpha\/t1/)
  assert.match(html, /all done/)
  assert.match(html, /<summary>Prompt<\/summary>/)

  // Assigning through the form redirects to the run; an empty form is refused on the same page.
  res = await postForm('/agents/actor/alpha/assign', { task: '', prompt: 'Look around.' })
  assert.equal(res.status, 303)
  assert.match(res.headers.get('location')!, /^\/agents\/run\//)
  res = await postForm('/agents/actor/alpha/assign', { task: '', prompt: '' })
  assert.equal(res.status, 400)
  assert.match(await res.text(), /give a task slug or a prompt/)
})

test('writes from another origin are refused', async () => {
  const res = await fetch(`${origin}/agents/api/actors/beta/up`, { method: 'POST', headers: { origin: 'http://evil.example' } })
  assert.equal(res.status, 403)
})

test('events stream records as they change', async () => {
  const controller = new AbortController()
  const res = await fetch(`${origin}/agents/api/events`, { signal: controller.signal })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + 3000
  while (!/event: actor/.test(text) && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value)
  }
  controller.abort()
  assert.match(text, /event: actor\ndata: \{"name":"alpha"/)
})

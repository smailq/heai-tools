import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROVIDERS } from '../src/providers/index.ts'
import { FIXTURES, makeWorld, until, writeScript } from './helpers.ts'

const body = (name: string): Buffer => readFileSync(join(FIXTURES, name))
const hmac = (alg: string, secret: string, b: Buffer) => createHmac(alg, secret).update(b).digest('hex')
const SECRET = 's3cret'
const opts = { kind: null, key: null }

test('github: signature, kind from event and action, key from the delivery, pull_request fields hoisted', () => {
  const b = body('github-pull_request.json')
  const p = PROVIDERS['github']!
  assert.equal(p.verify({}, b, SECRET), 'no X-Hub-Signature-256 header')
  assert.equal(p.verify({ 'x-hub-signature-256': 'sha256=' + hmac('sha256', 'wrong', b) }, b, SECRET), 'X-Hub-Signature-256 does not match')
  assert.equal(p.verify({ 'x-hub-signature-256': 'sha256=' + hmac('sha256', SECRET, b) }, b, SECRET), true)
  const e = p.parse({ 'x-github-event': 'pull_request', 'x-github-delivery': 'd-1' }, JSON.parse(b.toString()), b, opts)!
  assert.equal(e.kind, 'pull_request.closed')
  assert.equal(e.key, 'd-1')
  assert.equal(e.payload['merged'], true)
  assert.equal(e.payload['merge_commit_sha'], '6dcb09b5b57875f334f61aebed695e2e4193db5e')
  assert.equal(e.payload['number'], 42)
})

test('sentry: signature over the body, kind from resource and action, the issue hoisted with tags as a record', () => {
  const b = body('sentry-issue.json')
  const p = PROVIDERS['sentry']!
  assert.equal(p.verify({}, b, SECRET), 'no Sentry-Hook-Signature header')
  assert.equal(p.verify({ 'sentry-hook-signature': hmac('sha256', 'x', b) }, b, SECRET), 'Sentry-Hook-Signature does not match')
  assert.equal(p.verify({ 'sentry-hook-signature': hmac('sha256', SECRET, b) }, b, SECRET), true)
  const e = p.parse({ 'sentry-hook-resource': 'issue' }, JSON.parse(b.toString()), b, opts)!
  assert.equal(e.kind, 'issue.created')
  assert.equal(e.key, 'issue.created@12345')
  assert.equal(e.payload['title'], 'TypeError: cannot read properties of undefined')
  assert.equal(e.payload['culprit'], 'checkout/pay.ts in submit')
  assert.equal(e.payload['count'], '17')
  assert.equal(e.payload['url'], 'https://sentry.io/organizations/acme/issues/12345/')
  assert.deepEqual(e.payload['tags'], { territory: 'website', level: 'error' })
})

test('vercel: sha1 signature, kind is the type as Vercel names it, name and url hoisted', () => {
  const b = body('vercel-deployment.json')
  const p = PROVIDERS['vercel']!
  assert.equal(p.verify({ 'x-vercel-signature': hmac('sha1', 'x', b) }, b, SECRET), 'x-vercel-signature does not match')
  assert.equal(p.verify({ 'x-vercel-signature': hmac('sha1', SECRET, b) }, b, SECRET), true)
  const e = p.parse({}, JSON.parse(b.toString()), b, opts)!
  assert.equal(e.kind, 'deployment.error')
  assert.equal(e.key, 'evt_5oPhNiNwEmpu5DzB')
  assert.equal(e.payload['name'], 'website')
  assert.equal(e.payload['url'], 'website-abc123.vercel.app')
  assert.equal(e.payload['target'], 'production')
})

test('generic: a bearer token, kind and key from pointers or defaults', () => {
  const b = body('generic.json')
  const p = PROVIDERS['generic']!
  assert.equal(p.verify({}, b, SECRET), 'no Authorization header')
  assert.equal(p.verify({ authorization: 'Bearer nope' }, b, SECRET), 'bearer token does not match')
  assert.equal(p.verify({ authorization: `Bearer ${SECRET}` }, b, SECRET), true)
  const doc = JSON.parse(b.toString())
  assert.deepEqual(p.parse({}, doc, b, opts), { kind: 'health.degraded', key: 'h-77', payload: doc })
  assert.equal(p.parse({}, doc, b, { kind: '/service', key: '/region' })!.kind, 'api')
  assert.equal(p.parse({}, doc, b, { kind: '/service', key: '/region' })!.key, 'eu-west')
  assert.equal(p.parse({}, [1], b, opts)!.key.length, 64, 'no id means a hash of the body')
})

test('the receiver takes posts on each hook path, verifies, logs, acts, and drops the rest', async () => {
  process.env['HOOK_SECRET'] = SECRET
  const w = makeWorld(
    'sources:\n  github: { type: webhook, path: /hook/github, provider: github, secret: env:HOOK_SECRET }\n  generic: { type: webhook, path: /hook/any, secret: "plain" }\n' +
      'rules:\n  - { name: pr-merged, on: { source: github, kind: pull_request.closed, merged: true }, run: scripts/merged.sh }\n'
  )
  // The script has nothing but the environment, and that is enough.
  writeScript(w, 'merged.sh', 'echo "$REACTOR_NUMBER $REACTOR_MERGE_COMMIT_SHA" >> merged.log')
  const { stop, port } = await w.engine.serve(0)
  try {
    const url = `http://127.0.0.1:${port}`
    const b = body('github-pull_request.json')
    let res = await fetch(`${url}/hook/github`, { method: 'POST', body: new Uint8Array(b), headers: { 'content-type': 'application/json' } })
    assert.equal(res.status, 401, 'unsigned is dropped')
    res = await fetch(`${url}/hook/github`, { method: 'POST', body: new Uint8Array(b), headers: { 'x-hub-signature-256': 'sha256=' + hmac('sha256', SECRET, b), 'x-github-event': 'pull_request', 'x-github-delivery': 'd-9' } })
    assert.equal(res.status, 202)
    const { id } = (await res.json()) as { id: string }
    await until(() => existsSync(join(w.paths.state, 'actions', `${id}.pr-merged.json`)))
    const record = JSON.parse(readFileSync(join(w.paths.state, 'actions', `${id}.pr-merged.json`), 'utf8'))
    assert.equal(record.ok, true, record.error)
    assert.equal(readFileSync(join(w.dir, 'merged.log'), 'utf8'), '42 6dcb09b5b57875f334f61aebed695e2e4193db5e\n')
    assert.equal((await fetch(`${url}/hook/github`)).status, 405)
    assert.equal((await fetch(`${url}/nothing`, { method: 'POST', body: '{}' })).status, 404)
    assert.equal((await fetch(`${url}/hook/any`, { method: 'POST', body: 'not json', headers: { authorization: 'Bearer plain' } })).status, 400)
    assert.equal((await fetch(`${url}/hook/any`, { method: 'POST', body: '{"type":"ping"}', headers: { authorization: 'Bearer plain' } })).status, 202)
    const cursor = w.log.cursor<{ received: number; dropped: number; lastDrop: { reason: string } }>('github')!
    assert.equal(cursor.received, 1)
    assert.equal(cursor.dropped, 1)
    assert.equal(cursor.lastDrop.reason, 'no X-Hub-Signature-256 header')
    assert.equal(w.log.read({ source: 'generic' }).length, 1)
  } finally {
    await stop()
  }
})

test('a webhook cannot run under tick and says so', async () => {
  const w = makeWorld('sources:\n  github: { type: webhook, path: /hook/github, provider: github, secret: env:NOPE }\n')
  const r = await w.engine.tick()
  assert.deepEqual(r.skipped, ['github'])
})

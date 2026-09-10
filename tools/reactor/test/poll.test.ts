import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { pointer } from '../src/sources/poll.ts'
import { makeWorld } from './helpers.ts'

interface Answer {
  status: number
  body: string
}

function serve(answer: () => Answer): Promise<{ url: string; server: Server }> {
  const server = createServer((_req, res) => {
    const a = answer()
    res.writeHead(a.status, { 'content-type': 'application/json' })
    res.end(a.body)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server })))
}

test('a JSON pointer', () => {
  assert.equal(pointer({ status: { indicator: 'none' } }, '/status/indicator'), 'none')
  assert.equal(pointer({ a: [1, { 'b/c': 2 }] }, '/a/1/b~1c'), 2)
  assert.equal(pointer({ a: 1 }, '/nope'), undefined)
})

test('an event when the watched value changes: pointer, status, hash', async () => {
  let answer: Answer = { status: 200, body: '{"status":{"indicator":"none"}}' }
  const { url, server } = await serve(() => answer)
  try {
    const w = makeWorld(`sources:\n  st: { type: poll, url: ${url}/status.json, every: 1m, watch: /status/indicator }\n  up: { type: poll, url: ${url}/health, every: 1m, watch: status }\n  hs: { type: poll, url: ${url}/page, every: 1m }\n`)
    await w.engine.loadSources()
    const [st, up, hs] = w.engine.sources as [typeof w.engine.sources[0], typeof w.engine.sources[0], typeof w.engine.sources[0]]
    for (const s of [st, up, hs]) assert.equal((await w.engine.pollSource(s)).length, 0, 'the first answer is recorded, not reported')
    assert.equal(w.log.cursor<{ value: string }>('st')!.value, 'none')
    for (const s of [st, up, hs]) assert.equal((await w.engine.pollSource(s)).length, 0, 'unchanged')
    answer = { status: 503, body: '{"status":{"indicator":"minor"}}' }
    const a = await w.engine.pollSource(st)
    assert.equal(a.length, 1)
    assert.equal(a[0]!.kind, 'changed')
    assert.deepEqual(a[0]!.payload, { url: `${url}/status.json`, watch: '/status/indicator', from: 'none', to: 'minor', status: 503 })
    const b = await w.engine.pollSource(up)
    assert.deepEqual([b[0]!.payload['from'], b[0]!.payload['to']], [200, 503])
    assert.equal((await w.engine.pollSource(hs)).length, 1, 'the body hash moved')
    answer = { status: 200, body: '{"status":{"indicator":"none"}}' }
    const back = await w.engine.pollSource(st)
    assert.equal(back.length, 1, 'the return is a second event')
    assert.notEqual(back[0]!.key, a[0]!.key)
  } finally {
    server.close()
  }
})

test('a fetch that fails is a note in the cursor and no event', async () => {
  const w = makeWorld('sources:\n  dead: { type: poll, url: http://127.0.0.1:1/x, every: 1m, timeout: 2s }\n')
  await w.engine.loadSources()
  assert.equal((await w.engine.pollSource(w.engine.sources[0]!)).length, 0)
  assert.ok(w.log.cursor<{ error: string }>('dead')!.error)
  assert.equal(w.notes.length, 1)
})

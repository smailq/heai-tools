import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chain, makeWorld } from './helpers.ts'

test('trace walks parent, child and waits-on links into one timeline, from an id or a link value', () => {
  const w = makeWorld()
  const ids = chain(w)
  w.clock.tick(1000)
  assert.equal(w.store.settle().length, 1, 'the guard fires: the first run is resumable')
  const t = w.store.trace('task=t2')
  assert.deepEqual(t.flows.map((f) => f.id).sort(), Object.values(ids).sort())
  const moves = t.lines.filter((l) => l.event !== 'link').map((l) => `${l.definition} ${l.from ?? '·'}→${l.to} ${l.by}`)
  assert.deepEqual(moves, [
    'run ·→queued session.sh',
    'run queued→running session.sh',
    'run running→blocked session.sh',
    'request ·→todo session.sh',
    'run ·→queued session.sh',
    'run queued→running session.sh',
    'request todo→in-progress session.sh',
    'run running→succeeded session.sh',
    'request in-progress→in-review session.sh',
    'landing ·→proposed land.sh',
    'landing proposed→landed land.sh',
    'request in-review→done land.sh',
    'run blocked→resumable flow'
  ])
  assert.deepEqual(w.store.trace(ids.landing).flows.map((f) => f.id).sort(), Object.values(ids).sort())
  assert.equal(w.store.trace(`parent=${ids.req}`).flows.length, 4)
  assert.throws(() => w.store.trace('task=nothing'), /no flow is about task=nothing/)
  assert.throws(() => w.store.trace('nothing'), /no flow nothing/)
})

test('stuck lists non-terminal flows idle for that long, with what each waits on', () => {
  const w = makeWorld()
  const run = w.store.start({ definition: 'run', links: { actor: 'a' }, by: 'x' }).id
  w.store.advance(run, { event: 'started', data: {}, by: 'x' })
  w.store.advance(run, { event: 'exited', data: { exitCode: 0, requests: 1 }, by: 'x' })
  const req = w.store.start({ definition: 'request', links: { task: 'one' }, parent: run, by: 'x' }).id
  w.store.link(run, { waitsOn: [req] }, 'x')
  const done = w.store.start({ definition: 'request', links: { task: 'two' }, by: 'x' }).id
  w.store.advance(done, { event: 'canceled', data: {}, by: 'x' })
  w.clock.tick(2 * 3_600_000)
  const entries = w.store.stuck(3_600_000)
  assert.deepEqual(entries.map((e) => [e.flow.id, e.flow.state, e.waits]), [
    [req, 'todo', []],
    [run, 'blocked', [{ id: req, state: 'todo' }]]
  ])
  assert.equal(entries[0]!.idleMs, 2 * 3_600_000)
  w.store.touch(run)
  assert.equal(w.store.stuck(3_600_000).length, 1, 'a touch is activity')
  assert.equal(w.store.stuck(3 * 3_600_000).length, 0)
})

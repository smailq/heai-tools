import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { flowDir } from '../src/core.ts'
import { makeWorld } from './helpers.ts'

test('the clock: a state that outlives its `after` moves, unless it was touched', () => {
  const { store, clock } = makeWorld()
  const { id } = store.start({ definition: 'run', links: { actor: 'a' }, by: 'x' })
  store.advance(id, { event: 'started', data: {}, by: 'x' })
  clock.tick(9 * 60_000)
  assert.deepEqual(store.settle(), [])
  store.touch(id)
  assert.equal(store.get(id)!.expiresAt, new Date(Date.parse(clock.at) + 600_000).toISOString())
  clock.tick(9 * 60_000)
  assert.deepEqual(store.settle(), [], 'the touch reset the lease')
  clock.tick(2 * 60_000)
  assert.deepEqual(store.settle(), [`${id}: running → lost after 10m`])
  const last = store.show(id).lines.at(-1)!
  assert.equal(last.by, 'flow')
  assert.equal(last.event, 'stale')
  assert.equal(last.note, 'running for 10m with no touch')
  assert.deepEqual(store.settle(), [], 'idempotent')
})

test('a guard: a blocked run resumes when every flow it waits on is done, with by flow', () => {
  const { store } = makeWorld()
  const run = store.start({ definition: 'run', links: { actor: 'a' }, by: 'x' }).id
  store.advance(run, { event: 'started', data: {}, by: 'x' })
  store.advance(run, { event: 'exited', data: { exitCode: 0, requests: 2 }, by: 'x' })
  assert.deepEqual(store.settle(), [], 'waiting on nothing yet does not fire the guard')
  const r1 = store.start({ definition: 'request', links: { task: 'one' }, parent: run, by: 'x' }).id
  const r2 = store.start({ definition: 'request', links: { task: 'two' }, parent: run, by: 'x' }).id
  store.link(run, { waitsOn: [r1, r2] }, 'x')
  for (const r of [r1, r2]) {
    store.advance(r, { event: 'picked', data: {}, by: 'x' })
    store.advance(r, { event: 'finished', data: {}, by: 'x' })
  }
  store.advance(r1, { event: 'landed', data: {}, by: 'land.sh' })
  assert.deepEqual(store.settle(), [], 'one of two is not all')
  store.advance(r2, { event: 'landed', data: {}, by: 'land.sh' })
  const notes = store.settle()
  assert.deepEqual(notes, [`${run}: blocked → resumable, ${r1}:done, ${r2}:done`])
  const last = store.show(run).lines.at(-1)!
  assert.equal(last.by, 'flow')
  assert.equal(last.event, 'unblocked')
  assert.ok(existsSync(join(store.dir, 'by-state', 'run', 'resumable', run)))
  assert.ok(existsSync(join(store.dir, 'by-link', 'waits-on', r1, run)))
})

test('two settlers: the second finds the lock held and does nothing', () => {
  const { store, root, clock } = makeWorld()
  const { id } = store.start({ definition: 'run', links: { actor: 'a' }, by: 'x' })
  store.advance(id, { event: 'started', data: {}, by: 'x' })
  clock.tick(11 * 60_000)
  mkdirSync(join(root, 'settle.lock'))
  assert.deepEqual(store.settle(), [])
  assert.equal(store.get(id)!.state, 'running')
  rmSync(join(root, 'settle.lock'), { recursive: true })
  assert.equal(store.settle().length, 1)
  assert.equal(store.get(id)!.state, 'lost')
})

test('a missing or stale snapshot is rebuilt at settle', () => {
  const { store, root } = makeWorld()
  const { id } = store.start({ definition: 'run', links: { actor: 'a' }, by: 'x' })
  rmSync(join(flowDir(root, id), 'state.json'))
  rmSync(join(root, 'by-state'), { recursive: true })
  store.settle()
  assert.ok(existsSync(join(flowDir(root, id), 'state.json')))
  assert.ok(existsSync(join(root, 'by-state', 'run', 'queued', id)))
})

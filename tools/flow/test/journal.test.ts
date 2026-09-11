import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { readJournal, withFlowLock } from '../src/journal.ts'
import { flowDir } from '../src/core.ts'
import { FlowError } from '../src/errors.ts'
import { makeWorld } from './helpers.ts'

test('start, advance and link append one line each; the snapshot and the indexes follow', () => {
  const { store, root, clock } = makeWorld()
  const { id, line } = store.start({ definition: 'run', links: { actor: 'alpha' }, by: 'session.sh', note: 'hand assigned' })
  assert.match(id, /^20260904-165952-run-[0-9a-f]{4}$/)
  assert.deepEqual(line, { seq: 0, at: clock.at, event: 'start', from: null, to: 'queued', by: 'session.sh', data: { links: { actor: 'alpha' } }, note: 'hand assigned' })
  clock.tick(1000)
  const l1 = store.advance(id, { event: 'started', data: {}, by: 'session.sh' })
  assert.equal(l1.seq, 1)
  assert.equal(l1.to, 'running')
  const l2 = store.link(id, { links: { branch: 'agent/alpha/x' } }, 'session.sh')!
  assert.equal(l2.event, 'link')
  assert.equal(l2.from, 'running')
  assert.equal(store.link(id, { links: { branch: 'agent/alpha/x' } }, 'session.sh'), null, 'the same link again records nothing')

  const dir = flowDir(root, id)
  assert.equal(readJournal(join(dir, 'journal.jsonl')).lines.length, 3)
  const snap = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.equal(snap.state, 'running')
  assert.equal(snap.seq, 2)
  assert.equal(snap.since, l1.at)
  assert.deepEqual(snap.links, { actor: 'alpha', branch: 'agent/alpha/x' })
  assert.equal(snap.expiresAt, new Date(Date.parse(l1.at) + 600_000).toISOString())
  assert.ok(existsSync(join(root, 'by-state', 'run', 'running', id)))
  assert.ok(!existsSync(join(root, 'by-state', 'run', 'queued', id)))
  assert.ok(existsSync(join(root, 'by-link', 'branch', 'agent%2Falpha%2Fx', id)))
  assert.ok(existsSync(join(root, '.gitignore')))
  assert.equal(readFileSync(join(dir, 'definition.yaml'), 'utf8'), store.resolveDefinition('run').text)
})

test('the referee: illegal moves, a lost race, a refused writer, a terminal state', () => {
  const { store } = makeWorld()
  const { id } = store.start({ definition: 'request', links: { task: 't' }, by: 'session.sh' })
  assert.throws(() => store.advance(id, { event: 'finished', data: {}, by: 'x' }), (e: FlowError) => e.code === 'refused' && /no transition on finished from todo/.test(e.message) && /the events are picked, canceled/.test(e.message))
  assert.throws(() => store.advance(id, { event: 'picked', data: {}, by: 'x', seq: 3 }), (e: FlowError) => e.code === 'conflict' && /at seq 0, not 3/.test(e.message))
  assert.equal(store.advance(id, { event: 'picked', data: {}, by: 'x', seq: 0 }).to, 'in-progress')
  store.advance(id, { event: 'finished', data: {}, by: 'x' })
  assert.throws(() => store.advance(id, { event: 'landed', data: {}, by: 'human' }), (e: FlowError) => e.code === 'refused' && /human may not take in-review → done on landed; the definition allows land.sh/.test(e.message))
  assert.equal(store.advance(id, { event: 'landed', data: {}, by: 'land.sh' }).to, 'done')
  assert.throws(() => store.advance(id, { event: 'reopened', data: {}, by: 'x' }), (e: FlowError) => e.code === 'refused' && /is done, which is terminal/.test(e.message))
  assert.throws(() => store.advance(id, { event: 'picked', data: {}, by: 'flow' }), /by flow is what the tool signs its own moves as/)
  assert.throws(() => store.advance('nope', { event: 'picked', data: {}, by: 'x' }), (e: FlowError) => e.code === 'not-found')
})

test('links are declared by the definition; required ones are needed at start; targets must exist', () => {
  const { store } = makeWorld()
  assert.throws(() => store.start({ definition: 'run', links: {}, by: 'x' }), /requires link actor/)
  assert.throws(() => store.start({ definition: 'run', links: { actor: 'a', lane: 'core' }, by: 'x' }), /declares no link lane; it declares task, actor, branch/)
  assert.throws(() => store.start({ definition: 'run', links: { actor: 'a' }, waitsOn: ['ghost'], by: 'x' }), (e: FlowError) => e.code === 'not-found')
  const { id } = store.start({ definition: 'run', links: { actor: 'a' }, by: 'x' })
  assert.throws(() => store.link(id, { waitsOn: [id] }, 'x'), /cannot wait on itself/)
  assert.throws(() => store.start({ definition: 'run', id, links: { actor: 'a' }, by: 'x' }), (e: FlowError) => e.code === 'conflict')
  assert.throws(() => store.start({ definition: 'run', id: 'bad id', links: { actor: 'a' }, by: 'x' }), /letters, digits/)
})

test('a torn last line is ignored by readers and cut by the next append', () => {
  const { store, root } = makeWorld()
  const { id } = store.start({ definition: 'run', links: { actor: 'a' }, by: 'x' })
  const journal = join(flowDir(root, id), 'journal.jsonl')
  appendFileSync(journal, '{"seq":1,"at":"2026-')
  const read = readJournal(journal)
  assert.equal(read.lines.length, 1)
  assert.match(read.problems[0]!, /line 2 is torn/)
  assert.equal(store.show(id).problems.length, 1)
  store.advance(id, { event: 'started', data: {}, by: 'x' })
  const text = readFileSync(journal, 'utf8')
  assert.equal(text.split('\n').length, 3, 'two lines and a trailing newline')
  assert.deepEqual(readJournal(journal).problems, [])
  assert.equal(store.get(id)!.seq, 1)
})

test('the per-flow lock waits, then gives up; a stale lock is broken', () => {
  const { root } = makeWorld()
  const dir = join(root, 'flows', 'x')
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'lock'))
  assert.throws(() => withFlowLock(dir, () => 1, 60), (e: FlowError) => e.code === 'locked')
  const old = new Date(Date.now() - 120_000)
  utimesSync(join(dir, 'lock'), old, old)
  assert.equal(withFlowLock(dir, () => 1, 60), 1)
  assert.ok(!existsSync(join(dir, 'lock')))
})

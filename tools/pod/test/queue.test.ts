import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RefusedError, UsageError } from '../src/config.ts'
import { cancel, counts, find, formatDuration, jobs, submit, tail, wait } from '../src/queue.ts'
import { makeWorld } from './helpers.ts'

test('submit writes under a dotted name and renames into place; leftovers of an earlier try are cleared', () => {
  const w = makeWorld()
  mkdirSync(join(w.dirs.queue, '.tmp-j'), { recursive: true })
  writeFileSync(join(w.dirs.queue, '.tmp-j', 'stale'), '')
  assert.equal(submit(w.dirs, w.jobDir('j')), 'j')
  assert.ok(!existsSync(join(w.dirs.queue, '.tmp-j')))
  assert.ok(!existsSync(join(w.dirs.queue, 'j', 'stale')))
  assert.throws(() => submit(w.dirs, w.jobDir('j')), RefusedError)
  w.claim('j')
  assert.throws(() => submit(w.dirs, w.jobDir('j')), RefusedError, 'unique across .running too')
  w.finish('j', {})
  assert.throws(() => submit(w.dirs, w.jobDir('j')), RefusedError, 'and .done')
  assert.throws(() => submit(w.dirs, w.jobDir('x'), { name: '-x' }), UsageError)
  assert.throws(() => submit(w.dirs, join(w.dir, 'nope')), UsageError)
})

test('jobs and find: dotted entries and plain files are not jobs; queued first in name order, then running, then done', () => {
  const w = makeWorld()
  for (const n of ['b', 'a', 'c', 'd']) submit(w.dirs, w.jobDir(n))
  mkdirSync(join(w.dirs.queue, '.tmp-half'))
  writeFileSync(join(w.dirs.queue, 'note.txt'), '')
  mkdirSync(join(w.dirs.done, '.tmp-x'))
  w.claim('c')
  w.claim('d')
  w.finish('d', { status: 'timeout', exit: -1 })
  assert.deepEqual(jobs(w.dirs).map((j) => `${j.name}:${j.place}`), ['a:queued', 'b:queued', 'c:running', 'd:done'])
  assert.equal(find(w.dirs, 'c')!.claim!.worker, 'w1')
  assert.equal(find(w.dirs, 'd')!.result!.status, 'timeout')
  assert.equal(find(w.dirs, 'a')!.result, undefined)
  assert.equal(find(w.dirs, 'nope'), undefined)
  assert.equal(find(w.dirs, '.tmp-half'), undefined)
  assert.deepEqual(counts(w.dirs), { queued: 2, running: 1, done: 1, byStatus: { timeout: 1 } })
  mkdirSync(join(w.dirs.done, 'torn'))
  assert.deepEqual(counts(w.dirs).byStatus, { timeout: 1, unknown: 1 }, 'a done directory without a result counts as unknown')
})

test('cancel: queued is finished here, running gets the file, done is refused, unknown is unknown', () => {
  const w = makeWorld()
  submit(w.dirs, w.jobDir('q'))
  submit(w.dirs, w.jobDir('r'))
  w.claim('r')
  assert.equal(cancel(w.dirs, 'q'), 'canceled')
  const q = find(w.dirs, 'q')!
  assert.equal(q.place, 'done')
  assert.equal(q.result!.status, 'canceled')
  assert.equal(q.result!.exit, -1)
  assert.equal(cancel(w.dirs, 'r'), 'requested')
  assert.ok(existsSync(join(w.dirs.running, 'r', 'cancel')))
  assert.throws(() => cancel(w.dirs, 'q'), RefusedError)
  assert.throws(() => cancel(w.dirs, 'nope'), UsageError)
})

test('wait: returns the done job, null at its own timeout, and throws for a job that is nowhere', async () => {
  const w = makeWorld()
  submit(w.dirs, w.jobDir('j'))
  assert.equal(await wait(w.dirs, 'j', 30, 5), null)
  setTimeout(() => {
    w.claim('j')
    w.finish('j', { status: 'failed', exit: 2 })
  }, 40)
  const done = await wait(w.dirs, 'j', 5000, 5)
  assert.equal(done!.result!.status, 'failed')
  await assert.rejects(wait(w.dirs, 'nope', 10, 5), UsageError)
})

test('tail and durations', () => {
  const w = makeWorld()
  const f = join(w.dir, 'f')
  writeFileSync(f, 'a\nb\nc\n')
  assert.equal(tail(f, 2), 'b\nc\n')
  assert.equal(tail(f, 10), 'a\nb\nc\n')
  assert.equal(tail(join(w.dir, 'missing'), 2), '')
  assert.equal(formatDuration(91234), '1m31s')
  assert.equal(formatDuration(1234), '1.2s')
  assert.equal(formatDuration(3_723_000), '1h2m')
})

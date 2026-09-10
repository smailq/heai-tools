import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeClock, makeWorld } from './helpers.ts'

const YAML = 'sources:\n  nightly: { type: schedule, cron: "0 2 * * *", utc: true }\n  minute:  { type: schedule, cron: "* * * * *", utc: true }\n'

test('one event per slot, keyed by the slot; nothing until the next slot', async () => {
  const w = makeWorld(YAML, makeClock('2026-09-09T02:00:20.000Z'))
  await w.engine.loadSources()
  const nightly = w.engine.sources[0]!
  const first = await w.engine.pollSource(nightly)
  assert.equal(first.length, 1)
  assert.equal(first[0]!.kind, 'tick')
  assert.equal(first[0]!.key, 'nightly@2026-09-09T02:00:00.000Z')
  assert.equal(first[0]!.at, '2026-09-09T02:00:00.000Z')
  assert.deepEqual(first[0]!.payload, { slot: '2026-09-09T02:00:00.000Z', cron: '0 2 * * *', utc: true })
  w.clock.tick(30_000)
  assert.equal((await w.engine.pollSource(nightly)).length, 0, 'the same slot again')
  w.clock.set('2026-09-10T02:00:05.000Z')
  const next = await w.engine.pollSource(nightly)
  assert.equal(next[0]!.key, 'nightly@2026-09-10T02:00:00.000Z')
})

test('a restart inside a slot does not fire it twice: the cursor is a file', async () => {
  const w = makeWorld(YAML, makeClock('2026-09-09T02:00:20.000Z'))
  await w.engine.loadSources()
  assert.equal((await w.engine.pollSource(w.engine.sources[0]!)).length, 1)
  // A second engine over the same state directory, as a restarted daemon would be.
  const again = makeWorld(YAML, makeClock('2026-09-09T02:01:00.000Z'))
  await again.engine.loadSources()
  const src = again.engine.sources[0]!
  const ctxOld = w.engine.context(w.engine.sources[0]!)
  again.log.setCursor('nightly', ctxOld.cursor())
  assert.equal((await again.engine.pollSource(src)).length, 0)
})

test('a slot that passed while nothing ran is reported, not replayed', async () => {
  const w = makeWorld(YAML, makeClock('2026-09-09T02:00:20.000Z'))
  await w.engine.loadSources()
  const nightly = w.engine.sources[0]!
  assert.equal((await w.engine.pollSource(nightly)).length, 1)
  w.clock.set('2026-09-12T09:00:00.000Z')
  const events = await w.engine.pollSource(nightly)
  assert.equal(events.length, 0, 'three nights later at nine in the morning is not three sweeps')
  const cursor = w.log.cursor<{ lastSlot: string; missed: string[]; missedCount: number }>('nightly')!
  assert.equal(cursor.lastSlot, '2026-09-12T02:00:00.000Z')
  assert.deepEqual(cursor.missed, ['2026-09-10T02:00:00.000Z', '2026-09-11T02:00:00.000Z', '2026-09-12T02:00:00.000Z'])
  assert.equal(cursor.missedCount, 3)
  assert.match(w.notes[0]!, /nightly: missed 3 slots/)
})

test('a slot inside the grace after a gap still fires, and only the ones before it are missed', async () => {
  const w = makeWorld(YAML, makeClock('2026-09-09T02:00:20.000Z'))
  await w.engine.loadSources()
  const nightly = w.engine.sources[0]!
  await w.engine.pollSource(nightly)
  w.clock.set('2026-09-11T02:03:00.000Z')
  const events = await w.engine.pollSource(nightly)
  assert.equal(events.length, 1)
  assert.equal(events[0]!.key, 'nightly@2026-09-11T02:00:00.000Z')
  assert.deepEqual(w.log.cursor<{ missed: string[] }>('nightly')!.missed, ['2026-09-10T02:00:00.000Z'])
})

test('the first poll fires the current slot only when it is fresh', async () => {
  const w = makeWorld(YAML, makeClock('2026-09-09T09:00:00.000Z'))
  await w.engine.loadSources()
  assert.equal((await w.engine.pollSource(w.engine.sources[0]!)).length, 0, 'two in the morning was seven hours ago')
  assert.equal((await w.engine.pollSource(w.engine.sources[1]!)).length, 1, 'the minute source is always fresh')
  assert.equal(w.notes.length, 0, 'nothing was missed when nothing was running')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matches, nextSlot, parseCron, previousSlot, slotsBetween } from '../src/cron.ts'

const at = (s: string) => new Date(s)

test('parses fields, lists, ranges, steps and names', () => {
  const c = parseCron('*/15 2,14 1-3 jan,jul mon-fri')
  assert.deepEqual([...c.minute], [0, 15, 30, 45])
  assert.deepEqual([...c.hour], [2, 14])
  assert.deepEqual([...c.dom], [1, 2, 3])
  assert.deepEqual([...c.month], [1, 7])
  assert.deepEqual([...c.dow], [1, 2, 3, 4, 5])
  assert.equal(c.domAny, false)
  assert.equal(parseCron('@daily').hour.size, 1)
  assert.ok(parseCron('0 0 * * 7').dow.has(0))
})

test('refuses what is not cron', () => {
  for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', 'a * * * *', '5-1 * * * *']) assert.throws(() => parseCron(bad), /cron|five fields|cannot read/)
})

test('matches a minute, in UTC when asked', () => {
  const c = parseCron('0 2 * * *')
  assert.equal(matches(c, at('2026-09-09T02:00:30Z'), true), true)
  assert.equal(matches(c, at('2026-09-09T02:01:00Z'), true), false)
  assert.equal(matches(parseCron('* * * * *'), at('2026-09-09T02:01:00Z'), true), true)
})

test('the previous slot is the latest minute at or before now', () => {
  const c = parseCron('0 2 * * *')
  assert.equal(previousSlot(c, at('2026-09-09T02:00:30Z'), true)!.toISOString(), '2026-09-09T02:00:00.000Z')
  assert.equal(previousSlot(c, at('2026-09-09T01:59:00Z'), true)!.toISOString(), '2026-09-08T02:00:00.000Z')
  assert.equal(previousSlot(parseCron('30 4 1 * *'), at('2026-09-09T00:00:00Z'), true)!.toISOString(), '2026-09-01T04:30:00.000Z')
  assert.equal(previousSlot(parseCron('0 9 * * mon'), at('2026-09-09T00:00:00Z'), true)!.toISOString(), '2026-09-07T09:00:00.000Z')
  assert.equal(previousSlot(parseCron('0 0 31 2 *'), at('2026-09-09T00:00:00Z'), true), null)
})

test('the next slot is the first minute strictly after', () => {
  assert.equal(nextSlot(parseCron('0 2 * * *'), at('2026-09-09T02:00:00Z'), true)!.toISOString(), '2026-09-10T02:00:00.000Z')
  assert.equal(nextSlot(parseCron('*/5 * * * *'), at('2026-09-09T02:03:00Z'), true)!.toISOString(), '2026-09-09T02:05:00.000Z')
  assert.equal(nextSlot(parseCron('0 0 1 1 *'), at('2026-09-09T02:03:00Z'), true)!.toISOString(), '2027-01-01T00:00:00.000Z')
})

test('slots between two times, both exclusive', () => {
  const slots = slotsBetween(parseCron('0 * * * *'), at('2026-09-09T02:00:00Z'), at('2026-09-09T05:00:00Z'), true)
  assert.deepEqual(
    slots.map((d) => d.toISOString()),
    ['2026-09-09T03:00:00.000Z', '2026-09-09T04:00:00.000Z']
  )
})

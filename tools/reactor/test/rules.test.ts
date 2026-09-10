import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseConfig, parseRule } from '../src/config.ts'
import type { Event } from '../src/events.ts'
import type { Decision } from '../src/reactor.ts'
import { matchEvent } from '../src/rules.ts'
import { makeWorld, writeScript } from './helpers.ts'

const event = (over: Partial<Event> = {}): Event => ({ id: 'e1', source: 'sentry', kind: 'issue.created', key: 'k1', at: '2026-09-09T10:00:00.000Z', payload: { title: 'Boom', tags: { territory: 'website' } }, ...over })
const rule = (on: Record<string, unknown>) => parseRule({ name: 'r', on, run: 'true' }, 0).on

test('matches on source, kind and kind globs', () => {
  const w = makeWorld()
  assert.equal(matchEvent(rule({ source: 'sentry', kind: 'issue.created' }), event()), true)
  assert.equal(matchEvent(rule({ source: 'vercel' }), event()), false)
  assert.equal(matchEvent(rule({ kind: 'issue.*' }), event()), true)
  assert.equal(matchEvent(rule({ kind: 'deployment.*' }), event()), false)
  assert.equal(matchEvent(rule({}), event()), true)
})

test('every other key is a path into the payload', () => {
  const w = makeWorld()
  assert.equal(matchEvent(rule({ 'tags.territory': 'website' }), event()), true)
  assert.equal(matchEvent(rule({ tags: { territory: 'website' } }), event()), true)
  assert.equal(matchEvent(rule({ title: 'Other' }), event()), false)
  const commit = event({ source: 'repo', kind: 'commit', payload: { branch: 'main', paths: ['a', 'b'] } })
  assert.equal(matchEvent(rule({ branch: 'main' }), commit), true)
  assert.equal(matchEvent(rule({ paths: 'b' }), commit), true, 'a list contains the value')
  const emitted = event({ source: 'tasks_cli', kind: 'task.todo', payload: { slug: 't1', links: { actor: 'alpha' } } })
  assert.equal(matchEvent(rule({ slug: 't1', links: { actor: 'alpha' } }), emitted), true)
  assert.equal(matchEvent(rule({ 'links.actor': 'beta' }), emitted), false)
})

test('cron on a rule filters a clock to the slots it names', () => {
  const w = makeWorld()
  const tick = (slot: string) => event({ source: 'clock', kind: 'tick', payload: { slot, utc: true } })
  assert.equal(matchEvent(rule({ source: 'clock', cron: '0 2 * * *' }), tick('2026-09-09T02:00:00.000Z')), true)
  assert.equal(matchEvent(rule({ source: 'clock', cron: '0 2 * * *' }), tick('2026-09-09T02:01:00.000Z')), false)
})

test('a rule parses its run, debounce, limit and repeat, and refuses the rest', () => {
  const r = parseRule({ name: 'x', on: { source: 's' }, run: 'scripts/x.sh {{ key }}', debounce: '5s', limit: '10/hour', repeat: true }, 0)
  assert.equal(r.run, 'scripts/x.sh {{ key }}')
  assert.equal(r.debounce, 5000)
  assert.deepEqual(r.limit, { count: 10, windowMs: 3_600_000 })
  assert.equal(r.repeat, true)
  assert.throws(() => parseRule({ name: 'x', on: {} }, 0), /run must be a command/)
  assert.throws(() => parseRule({ name: 'x', run: '' }, 0), /run must be a command/)
  assert.throws(() => parseRule({ name: 'x', run: 'a', file: { title: 't' } }, 0), /unknown key "file"/)
  assert.throws(() => parseRule({ name: 'x', run: 'a', fact: { flow: 'f', event: 'e' } }, 0), /unknown key "fact"/)
  assert.throws(() => parseRule({ name: 'x', assign: { for: 'a' } }, 0), /unknown key "assign"/)
  assert.throws(() => parseRule({ name: 'x', run: 'a', limit: '10' }, 0), /limit must be/)
  assert.throws(() => parseConfig('sources: {}\nrules:\n  - { name: a, on: { source: nope }, run: x }\n', 'w'), /not declared/)
  assert.throws(() => parseConfig('rules:\n  - { name: a, run: x }\n  - { name: a, run: y }\n', 'w'), /two rules/)
})

test('a rule fires once per key unless it says repeat', async () => {
  const w = makeWorld(`sources:\n  s: { type: schedule, cron: "* * * * *" }\nrules:\n  - { name: once, on: { source: s }, run: "echo once >> once.log" }\n  - { name: again, on: { source: s }, run: "echo again >> again.log", repeat: true }\n`)
  const e1 = w.log.append('s', { kind: 'tick', key: 'same', payload: {} })
  const e2 = w.log.append('s', { kind: 'tick', key: 'same', payload: {} })
  const d1 = await w.engine.handle(e1)
  const d2 = await w.engine.handle(e2)
  assert.deepEqual(
    d1.map((d: Decision) => d.verdict),
    ['acted', 'acted']
  )
  assert.deepEqual(
    d2.map((d: Decision) => [d.rule, d.verdict]),
    [
      ['once', 'deduped'],
      ['again', 'acted']
    ]
  )
  assert.equal(readFileSync(join(w.dir, 'once.log'), 'utf8'), 'once\n')
  assert.equal(readFileSync(join(w.dir, 'again.log'), 'utf8'), 'again\nagain\n')
  assert.equal(readdirSync(join(w.paths.state, 'keys')).length, 2)
  const record = JSON.parse(readFileSync(join(w.paths.state, 'actions', `${e1.id}.once.json`), 'utf8'))
  assert.equal(record.ok, true)
  assert.equal(record.action, 'run')
  assert.equal(record.outcome.exitCode, 0)
})

test('debounce collapses a burst into one action after the window', async () => {
  const w = makeWorld(`sources:\n  s: { type: schedule, cron: "* * * * *" }\nrules:\n  - { name: burst, on: { source: s }, run: "echo $REACTOR_KEY >> burst.log", debounce: 10s }\n`)
  const events = ['a', 'b', 'c'].map((k) => w.log.append('s', { kind: 'tick', key: k, payload: {} }))
  for (const e of events) assert.equal((await w.engine.handle(e))[0]!.verdict, 'debounced')
  assert.equal(await w.engine.flushDebounces().then((d: Decision[]) => d.length), 0, 'the window is still open')
  assert.equal(existsSync(join(w.dir, 'burst.log')), false)
  w.clock.tick(11_000)
  const fired = await w.engine.flushDebounces()
  assert.equal(fired.length, 1)
  assert.equal(fired[0]!.event, events[2]!.id, 'the last event of the burst')
  assert.deepEqual(fired[0]!.record!.collapsed, [events[0]!.id, events[1]!.id])
  assert.equal(readFileSync(join(w.dir, 'burst.log'), 'utf8'), 'c\n')
  for (const e of events) assert.equal(w.log.hasKey('burst', e.key), true, 'every key of the burst is acted')
  assert.equal(w.log.ruleState('burst').pending, null)
})

test('limit caps actions per window, records the rest as limited, and says so once', async () => {
  const w = makeWorld(`sources:\n  s: { type: schedule, cron: "* * * * *" }\nrules:\n  - { name: capped, on: { source: s }, run: "echo {{ key }} >> capped.log", limit: 2/hour }\n`)
  const verdicts: string[] = []
  const events: Event[] = []
  for (const k of ['1', '2', '3', '4']) {
    const e = w.log.append('s', { kind: 'tick', key: k, payload: {} })
    events.push(e)
    verdicts.push((await w.engine.handle(e))[0]!.verdict)
  }
  assert.deepEqual(verdicts, ['acted', 'acted', 'limited', 'limited'])
  assert.equal(readFileSync(join(w.dir, 'capped.log'), 'utf8'), '1\n2\n')
  const limited = JSON.parse(readFileSync(w.log.actionPath(events[2]!.id, 'capped'), 'utf8'))
  assert.equal(limited.ok, false)
  assert.deepEqual(limited.outcome, { limited: true, limit: '2/1h', window: w.clock.at })
  assert.match(limited.error, /limit 2\/1h hit; not acted, not deduped/)
  assert.deepEqual(w.notes.filter((n) => n.includes('limit')), [`rule capped: limit 2/1h hit since ${w.clock.at}; further events in the window are recorded as limited, not acted and not deduped, and \`reactor replay --since ${w.clock.at} --rule capped\` acts on them`], 'the cap is noted once per window')
  assert.equal(w.log.hasKey('capped', '3'), false, 'a limited event is not deduped, so replay can act on it')
  w.clock.tick(3_600_001)
  assert.equal((await w.engine.handle(w.log.append('s', { kind: 'tick', key: '5', payload: {} })))[0]!.verdict, 'acted', 'a new window')
})

test('a template that cannot render is a failed action, recorded', async () => {
  const w = makeWorld(`sources:\n  s: { type: schedule, cron: "* * * * *" }\nrules:\n  - { name: bad, on: { source: s }, run: "echo {{ key | upcase }}" }\n`)
  const d = await w.engine.handle(w.log.append('s', { kind: 'tick', key: 'k', payload: {} }))
  assert.equal(d[0]!.verdict, 'failed')
  assert.match(d[0]!.record!.error!, /unknown filter/)
})

test('replay honours dedupe and dry-run touches nothing', async () => {
  const w = makeWorld(`sources:\n  s: { type: schedule, cron: "* * * * *" }\nrules:\n  - { name: r, on: { source: s }, run: "echo x >> r.log" }\n`)
  const e = w.log.append('s', { kind: 'tick', key: 'k', payload: {} })
  const dry = await w.engine.replay(new Date(0), null, true)
  assert.deepEqual(
    dry.map((d: Decision) => d.verdict),
    ['dry']
  )
  assert.equal(existsSync(join(w.dir, 'r.log')), false)
  assert.deepEqual((await w.engine.replay(new Date(0), null, false)).map((d: Decision) => d.verdict), ['acted'])
  assert.deepEqual((await w.engine.replay(new Date(0), null, false)).map((d: Decision) => d.verdict), ['deduped'])
  assert.deepEqual((await w.engine.retry(e.id)).map((d: Decision) => d.verdict), ['acted'], 'retry ignores dedupe')
  assert.equal(readFileSync(join(w.dir, 'r.log'), 'utf8'), 'x\nx\n')
  writeScript(w, 'noop.sh', 'exit 0')
})

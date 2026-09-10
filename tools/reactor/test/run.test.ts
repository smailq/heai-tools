import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Event } from '../src/events.ts'
import { describe, RESERVED, run } from '../src/run.ts'
import { makeWorld, writeScript, type World } from './helpers.ts'

const event = (over: Partial<Event> = {}): Event => ({ id: '20260909-100000-abcdef', source: 'sentry', kind: 'issue.created', key: 'issue@1', at: '2026-09-09T10:00:00.000Z', payload: { title: 'Boom', count: 17, ok: true, nested: { a: 1 } }, ...over })
const ctx = (w: World, e: Event, rule = 'r', timeout: number | null = null) => ({ event: e, rule, paths: w.paths, log: w.log, timeout })

test('describe is the command', () => {
  assert.equal(describe('scripts/pick.sh'), 'run scripts/pick.sh')
})

test('run executes in the project directory with the event in its environment and its output in a log', async () => {
  const w = makeWorld()
  const script = writeScript(w, 'dump.sh', 'pwd; env | grep -E "^REACTOR_" | sort; echo "line: $(cat "$REACTOR_EVENT" | head -c 40)"')
  const e = event()
  const o = await run(script, ctx(w, e, 'dumper'))
  assert.equal(o.ok, true, o.error ?? undefined)
  assert.equal(o.outcome['exitCode'], 0)
  const log = readFileSync(o.outcome['log'] as string, 'utf8')
  assert.ok(log.startsWith(w.dir + '\n') || log.startsWith(`/private${w.dir}\n`), 'runs in the project directory')
  for (const line of [`REACTOR_ID=${e.id}`, 'REACTOR_SOURCE=sentry', 'REACTOR_KIND=issue.created', 'REACTOR_KEY=issue@1', 'REACTOR_AT=2026-09-09T10:00:00.000Z', 'REACTOR_RULE=dumper', 'REACTOR_TITLE=Boom', 'REACTOR_COUNT=17', 'REACTOR_OK=true']) assert.ok(log.includes(line + '\n'), line)
  assert.ok(!log.includes('REACTOR_NESTED='), 'only scalars become variables')
  assert.ok(!log.includes('REACTOR_PAYLOAD_'), 'no field collides with the seven')
  assert.match(log, /line: \{\n  "id": "20260909-100000-abcdef"/)
  assert.equal(o.outcome['log'], w.log.actionPath(e.id, 'dumper', 'log'))
  assert.ok(existsSync(w.log.actionPath(e.id, 'dumper', 'event.json')), 'the event as JSON sits beside the record')
})

test('a payload field named like one of the seven goes under REACTOR_PAYLOAD_<FIELD>, and the seven stay the event', async () => {
  assert.deepEqual(RESERVED, ['EVENT', 'ID', 'SOURCE', 'KIND', 'KEY', 'AT', 'RULE'])
  const w = makeWorld()
  const script = writeScript(w, 'dump.sh', 'env | grep -E "^REACTOR_" | sort')
  const e = event({ source: 'tasks_cli', kind: 'task.todo', key: 't1', payload: { id: 'payload-id', kind: 'payload-kind', event: 'payload-event', Source: 'payload-source', Rule: 'x', slug: 't1' } })
  const o = await run(script, ctx(w, e, 'sweep-now'))
  const log = readFileSync(o.outcome['log'] as string, 'utf8')
  for (const line of [`REACTOR_ID=${e.id}`, 'REACTOR_SOURCE=tasks_cli', 'REACTOR_KIND=task.todo', 'REACTOR_KEY=t1', 'REACTOR_RULE=sweep-now', 'REACTOR_SLUG=t1', 'REACTOR_PAYLOAD_ID=payload-id', 'REACTOR_PAYLOAD_KIND=payload-kind', 'REACTOR_PAYLOAD_EVENT=payload-event', 'REACTOR_PAYLOAD_SOURCE=payload-source', 'REACTOR_PAYLOAD_RULE=x']) assert.ok(log.includes(line + '\n'), `${line} in\n${log}`)
  assert.equal(log.split('REACTOR_ID=').length, 2, 'one REACTOR_ID')
  assert.match(log, /^REACTOR_EVENT=.*\.sweep-now\.event\.json$/m)
})

test('run records a non-zero exit, an error, and a timeout', async () => {
  const w = makeWorld()
  const o = await run('echo nope >&2; exit 3', ctx(w, event()))
  assert.equal(o.ok, false)
  assert.equal(o.outcome['exitCode'], 3)
  assert.equal(o.error, 'exited 3')
  assert.equal(readFileSync(o.outcome['log'] as string, 'utf8'), 'nope\n')
  const slow = await run('sleep 5', ctx(w, event({ id: 'slow' }), 'r', 100))
  assert.equal(slow.ok, false)
  assert.equal(slow.outcome['timedOut'], true)
  assert.match(slow.error!, /timed out/)
})

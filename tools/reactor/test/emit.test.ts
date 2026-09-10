// The cli source and `reactor emit`: an event appended by hand, its id
// printed, the key defaulting to the id, the payload from an argument or
// stdin, what is refused, and --act running the rules for it at once.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Decision } from '../src/reactor.ts'
import { cli, cliWith, makeClock, makeWorld, until } from './helpers.ts'

const YAML = `sources:
  clock:     { type: schedule, cron: "* * * * *" }
  tasks_cli: { type: cli, kinds: [task.todo, task.done] }
  notes:     { type: cli }
rules:
  - { name: sweep-now, on: { source: tasks_cli, kind: task.todo }, run: "echo {{ slug }} >> sweep.log" }
  - { name: noted,     on: { source: notes },                      run: "echo $REACTOR_KIND $REACTOR_TEXT >> notes.log" }
`

test('a cli source has no interval, no listener, nothing to poll, and takes emit', async () => {
  const w = makeWorld(YAML)
  await w.engine.loadSources()
  const src = w.engine.sources[1]!
  assert.equal(src.type, 'cli')
  assert.equal(src.every, null)
  assert.equal(src.listener, null)
  assert.equal(typeof src.emit, 'function')
  assert.deepEqual(await w.engine.pollSource(src), [])
  assert.equal(src.describe(w.engine.context(src)), 'kinds task.todo, task.done; emitted 0, pending 0')
  assert.equal(w.engine.sources[2]!.describe(w.engine.context(w.engine.sources[2]!)), 'kinds any; emitted 0, pending 0')
  const r = await w.engine.tick()
  assert.deepEqual(r.skipped, [], 'nothing to skip: a cli source is not a listener')
  assert.equal(r.events.length, 1, 'the clock alone')
})

test('emit appends one event and prints its id; the key defaults to the id', () => {
  const w = makeWorld(YAML)
  const r = cli(w, 'emit', 'tasks_cli', 'task.todo', '--payload', '{"slug":"t1","n":1}')
  assert.equal(r.code, 0, r.stderr)
  const id = r.stdout.trim()
  assert.match(id, /^\d{8}-\d{6}-[0-9a-f]{6}$/)
  assert.equal(r.stdout, id + '\n', 'the id and nothing else')
  const [e] = w.log.read()
  assert.equal(e!.id, id)
  assert.equal(e!.source, 'tasks_cli')
  assert.equal(e!.kind, 'task.todo')
  assert.equal(e!.key, id, 'no --key: the id is the key')
  assert.deepEqual(e!.payload, { slug: 't1', n: 1 })
  assert.ok(!existsSync(join(w.dir, 'sweep.log')), 'nothing runs without --act')
  assert.deepEqual(w.log.actions(), [])
  const keyed = cli(w, 'emit', 'tasks_cli', 'task.todo', '--key', 't1', '--at', '2026-09-01T09:00:00Z')
  assert.equal(keyed.code, 0)
  const later = w.log.read().find((x) => x.id === keyed.stdout.trim())!
  assert.equal(later.key, 't1')
  assert.equal(later.at, '2026-09-01T09:00:00.000Z')
  assert.deepEqual(later.payload, {}, 'no --payload: an empty payload')
  assert.ok(later.id.startsWith('20260901-090000-'), 'the id carries --at')
  const cursor = w.log.cursor<{ emitted: number; pending: string[]; last: { id: string; kind: string; key: string; at: string } }>('tasks_cli')!
  assert.equal(cursor.emitted, 2)
  assert.deepEqual(cursor.pending, [id, later.id], 'both wait for the next tick')
  assert.deepEqual(cursor.last, { id: later.id, kind: 'task.todo', key: 't1', at: '2026-09-01T09:00:00.000Z' })
  const js = cli(w, 'emit', 'notes', 'anything', '--json')
  assert.equal(JSON.parse(js.stdout).kind, 'anything', '--json prints the event')
})

test('--payload - reads stdin', () => {
  const w = makeWorld(YAML)
  const r = cliWith(w, { input: '{"slug":"from-stdin","tags":["a","b"]}\n' }, 'emit', 'tasks_cli', 'task.todo', '--payload', '-')
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(w.log.read()[0]!.payload, { slug: 'from-stdin', tags: ['a', 'b'] })
  const bad = cliWith(w, { input: 'not json' }, 'emit', 'tasks_cli', 'task.todo', '--payload', '-')
  assert.equal(bad.code, 2)
  assert.match(bad.stderr, /--payload must be a JSON object; stdin is not JSON/)
})

test('an unknown source, a source of another type, a kind the source does not allow, and a payload that is not an object are refused, exit 2', () => {
  const w = makeWorld(YAML)
  let r = cli(w, 'emit', 'nope', 'task.todo')
  assert.equal(r.code, 2)
  assert.match(r.stderr, /^reactor: no source nope in .*reactor\.yaml; the sources are clock, tasks_cli, notes\n$/)
  r = cli(w, 'emit', 'clock', 'tick')
  assert.equal(r.code, 2)
  assert.match(r.stderr, /source clock is a schedule source, not cli; only a cli source takes emit/)
  r = cli(w, 'emit', 'tasks_cli', 'task.blocked')
  assert.equal(r.code, 2)
  assert.match(r.stderr, /source tasks_cli: kind task\.blocked is not allowed; the kinds are task\.todo, task\.done/)
  r = cli(w, 'emit', 'tasks_cli', 'task.todo', '--payload', '[1]')
  assert.equal(r.code, 2)
  assert.match(r.stderr, /--payload must be a JSON object, not a list or a scalar/)
  r = cli(w, 'emit', 'tasks_cli', 'task.todo', '--payload', '"x"')
  assert.equal(r.code, 2)
  r = cli(w, 'emit', 'tasks_cli', 'task.todo', '--payload', '{nope')
  assert.equal(r.code, 2)
  assert.match(r.stderr, /--payload must be a JSON object, not "\{nope"/)
  r = cli(w, 'emit', 'tasks_cli', 'task.todo', '--at', 'yesterday')
  assert.equal(r.code, 2)
  assert.match(r.stderr, /--at must be an ISO time/)
  r = cli(w, 'emit', 'tasks_cli', 'task.todo', '--key', '')
  assert.equal(r.code, 2)
  assert.equal(w.log.read().length, 0, 'nothing refused was logged')
  assert.equal(w.log.cursor('tasks_cli'), null, 'nothing refused was counted')
})

test('--act runs the rules for the one event at once and prints the decisions; a repeated key is deduped', () => {
  const w = makeWorld(YAML)
  let r = cli(w, 'emit', 'tasks_cli', 'task.todo', '--key', 't1', '--payload', '{"slug":"t1"}', '--act')
  assert.equal(r.code, 0, r.stderr)
  const [id, decision] = r.stdout.trim().split('\n')
  assert.match(id!, /^\d{8}-\d{6}-[0-9a-f]{6}$/)
  assert.match(decision!, new RegExp(`^${id}\\s+sweep-now\\s+acted\\s+run echo t1 >> sweep.log$`))
  assert.equal(readFileSync(join(w.dir, 'sweep.log'), 'utf8'), 't1\n')
  assert.deepEqual(w.log.cursor<{ pending: string[] }>('tasks_cli')!.pending, [], '--act handled it; nothing waits for a tick')
  const record = w.log.actions(id)[0]!
  assert.equal(record.rule, 'sweep-now')
  assert.equal(record.ok, true)
  r = cli(w, 'emit', 'tasks_cli', 'task.todo', '--key', 't1', '--payload', '{"slug":"t1"}', '--act')
  assert.equal(r.code, 0)
  assert.match(r.stdout, /sweep-now\s+deduped/, 'the same key is the same thing')
  assert.equal(readFileSync(join(w.dir, 'sweep.log'), 'utf8'), 't1\n')
  r = cli(w, 'emit', 'tasks_cli', 'task.todo', '--payload', '{"slug":"t1"}', '--act')
  assert.match(r.stdout, /sweep-now\s+acted/, 'no key: a fresh id, a fresh key')
  assert.equal(readFileSync(join(w.dir, 'sweep.log'), 'utf8'), 't1\nt1\n')
  r = cli(w, 'emit', 'tasks_cli', 'task.done', '--act')
  assert.equal(r.code, 0)
  assert.equal(r.stdout.trim().split('\n').length, 1, 'no rule matches: the id alone')
  r = cli(w, 'emit', 'notes', 'reminder', '--payload', '{"text":"water the plants"}', '--act')
  assert.equal(r.code, 0, r.stderr)
  assert.equal(readFileSync(join(w.dir, 'notes.log'), 'utf8'), 'reminder water the plants\n', 'the payload is in the environment')
  const js = JSON.parse(cli(w, 'emit', 'notes', 'reminder', '--act', '--json').stdout) as { event: { id: string }; decisions: Decision[] }
  assert.equal(js.decisions[0]!.event, js.event.id)
  assert.equal(js.decisions[0]!.verdict, 'acted')
})

test('an event emitted without --act is acted on by the next tick, once; one emitted with --act is not run again', () => {
  const w = makeWorld(YAML)
  const first = cli(w, 'emit', 'tasks_cli', 'task.todo', '--key', 'a', '--payload', '{"slug":"a"}').stdout.trim()
  assert.ok(!existsSync(join(w.dir, 'sweep.log')), 'nothing ran yet')
  let r = cli(w, 'tick')
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /^2 events, 1 decision\n/, 'the clock and the pending emission; only the emission has a rule')
  assert.match(r.stdout, new RegExp(`${first}\\s+sweep-now\\s+acted\\s+run echo a >> sweep.log`))
  assert.equal(readFileSync(join(w.dir, 'sweep.log'), 'utf8'), 'a\n')
  r = cli(w, 'tick')
  assert.match(r.stdout, /^0 events, 0 decisions\n/, 'handled once; the cursor advanced')
  assert.equal(readFileSync(join(w.dir, 'sweep.log'), 'utf8'), 'a\n')
  r = cli(w, 'emit', 'tasks_cli', 'task.todo', '--key', 'b', '--payload', '{"slug":"b"}', '--act')
  assert.match(r.stdout, /sweep-now\s+acted/)
  assert.equal(readFileSync(join(w.dir, 'sweep.log'), 'utf8'), 'a\nb\n')
  r = cli(w, 'tick')
  assert.match(r.stdout, /^0 events, 0 decisions\n/, '--act marked it handled')
  assert.equal(readFileSync(join(w.dir, 'sweep.log'), 'utf8'), 'a\nb\n')
  cli(w, 'emit', 'tasks_cli', 'task.todo', '--key', 'a', '--payload', '{"slug":"a"}')
  cli(w, 'emit', 'tasks_cli', 'task.todo', '--key', 'c', '--payload', '{"slug":"c"}')
  r = cli(w, 'tick')
  assert.match(r.stdout, /sweep-now\s+deduped/, 'a repeated key is deduped by the tick too')
  assert.match(r.stdout, /sweep-now\s+acted\s+run echo c/)
  assert.equal(readFileSync(join(w.dir, 'sweep.log'), 'utf8'), 'a\nb\nc\n')
  assert.match(cli(w, 'status').stdout, /tasks_cli\s+cli.*emitted 4, pending 0/)
})

test('a serve pass acts on what was emitted while it runs', async () => {
  const w = makeWorld('sources:\n  c: { type: cli }\nrules:\n  - { name: r, on: { source: c }, run: "echo $REACTOR_KEY >> served.log" }\n')
  const { stop } = await w.engine.serve()
  try {
    cli(w, 'emit', 'c', 'ping', '--key', 'p1')
    await until(() => existsSync(join(w.dir, 'served.log')))
    assert.equal(readFileSync(join(w.dir, 'served.log'), 'utf8'), 'p1\n')
    await until(() => w.log.cursor<{ pending: string[] }>('c')!.pending.length === 0)
  } finally {
    await stop()
  }
})

test('--act exits 1 when a rule failed, as tick does', () => {
  const w = makeWorld('sources:\n  c: { type: cli }\nrules:\n  - { name: bad, on: { source: c }, run: "exit 3" }\n')
  const r = cli(w, 'emit', 'c', 'x', '--act')
  assert.equal(r.code, 1)
  assert.match(r.stdout, /bad\s+failed\s+run exit 3\s+PROBLEM exited 3/)
})

test('status shows a cli source with its last event', () => {
  const w = makeWorld(YAML, makeClock())
  const before = cli(w, 'status')
  assert.match(before.stdout, /tasks_cli\s+cli\s+from reactor emit\s+last event -\s+kinds task\.todo, task\.done; emitted 0, pending 0\n/)
  assert.match(before.stdout, /notes\s+cli\s+from reactor emit\s+last event -\s+kinds any; emitted 0, pending 0\n/)
  // status reports the last day by the real clock, so the event is dated an hour ago.
  const at = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 3_600_000).toISOString()
  cli(w, 'emit', 'tasks_cli', 'task.done', '--key', 'k', '--at', at)
  const after = cli(w, 'status')
  const shown = at.slice(0, 19).replace('T', ' ')
  assert.match(after.stdout, new RegExp(`tasks_cli\\s+cli\\s+from reactor emit\\s+last event ${shown}\\s+kinds task\\.todo, task\\.done; emitted 1, pending 1; last ${at.replace(/\\./g, '\\\\.')} task\\.done\\n`))
  const js = JSON.parse(cli(w, 'status', '--json').stdout)
  assert.equal(js.sources[1].lastEvent, at)
})

test('a cli source refuses options it does not have, and an empty kinds list', () => {
  assert.throws(() => makeWorld('sources:\n  c: { type: cli, every: 5s }\n'), /\/sources\/c: unknown key "every"; the keys are type, kinds/)
  assert.throws(() => makeWorld('sources:\n  c: { type: cli, kinds: [] }\n'), /\/sources\/c\/kinds/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cli, makeClock, makeWorld } from './helpers.ts'

const YAML = `sources:
  clock:     { type: schedule, cron: "* * * * *" }
  tasks_cli: { type: cli, kinds: [task.todo, task.done] }
rules:
  - { name: pick,     on: { source: clock },                              run: "echo pick >> pick.log" }
  - { name: pick-now, on: { source: tasks_cli, kind: task.todo },         run: "echo now >> pick.log", debounce: 5s }
  - { name: web,      on: { source: tasks_cli, area: website },           run: "echo web-task-{{ slug }} >> web.log" }
`

test('usage and exit codes', () => {
  const w = makeWorld()
  assert.equal(cli(w, '--help').code, 0)
  assert.match(cli(w, '--help').stdout, /reactor emit <source> <kind> \[--key <key>\] \[--payload '<json>' \| --payload -\] \[--at <iso>\] \[--act\]/)
  assert.equal(cli(w).code, 2)
  assert.equal(cli(w, 'nope').code, 2)
  assert.match(cli(w, 'nope').stderr, /unknown command/)
  assert.equal(cli(w, 'retry').code, 2)
  assert.equal(cli(w, 'retry', 'no-such-event').code, 2)
  assert.equal(cli(w, 'replay').code, 2)
  assert.equal(cli(w, 'test', 'x').code, 2)
  assert.equal(cli(w, 'emit').code, 2)
  assert.equal(cli(w, 'emit', 'tasks_cli').code, 2)
  writeFileSync(w.paths.config, 'rules: [ { name: a } ]\n')
  let bad = cli(w, 'status')
  assert.equal(bad.code, 2)
  assert.match(bad.stderr, /^reactor: .*reactor\.yaml: \/rules\/0: run is required/)
  writeFileSync(w.paths.config, 'rules: [ { name: a, file: { title: t } } ]\n')
  bad = cli(w, 'status')
  assert.equal(bad.code, 2)
  assert.match(bad.stderr, /\/rules\/0: unknown key "file"; the keys are name, on, run, debounce, limit, repeat, timeout/)
})

test('the state directory ignores itself', () => {
  const w = makeWorld()
  assert.equal(readFileSync(join(w.paths.state, '.gitignore'), 'utf8'), '*\n')
})

test('tick polls every source once, runs the rules, and prints what it decided; a cli source contributes nothing', () => {
  const w = makeWorld(YAML)
  let r = cli(w, 'tick')
  assert.equal(r.code, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /^1 event, 1 decision\n/)
  assert.match(r.stdout, /pick\s+acted\s+run echo pick/)
  assert.ok(!r.stdout.includes('tasks_cli'), 'nothing to poll, nothing to skip')
  assert.equal(readFileSync(join(w.dir, 'pick.log'), 'utf8'), 'pick\n')
  r = cli(w, 'tick')
  assert.match(r.stdout, /^0 events, 0 decisions\n/, 'the same minute')
})

test('events, status, test, retry and replay read the same files', () => {
  const w = makeWorld(YAML)
  const emitted = cli(w, 'emit', 'tasks_cli', 'task.done', '--key', 'site-fix', '--payload', '{"slug":"site-fix","area":"website"}', '--at', '2026-09-01T09:00:00Z')
  assert.equal(emitted.code, 0, emitted.stderr)
  cli(w, 'tick')
  const events = cli(w, 'events', '--json', '--since', '30d')
  assert.equal(events.code, 0)
  const list = JSON.parse(events.stdout) as Array<{ id: string; source: string; kind: string }>
  assert.deepEqual(
    list.map((e: { source: string; kind: string }) => [e.source, e.kind]),
    [
      ['tasks_cli', 'task.done'],
      ['clock', 'tick']
    ],
    'oldest first, by the time each event carries'
  )
  assert.equal(list[0]!.id, emitted.stdout.trim())
  const acted = list as unknown as Array<{ actions: Array<{ rule: string; event: string; ok: boolean; outcome: Record<string, unknown> }> }>
  assert.deepEqual(acted[0]!.actions.map((a) => [a.rule, a.event === list[0]!.id, a.ok, a.outcome['exitCode']]), [['web', true, true, 0]], 'each event carries the action records rules left on it')
  assert.deepEqual(acted[1]!.actions.map((a) => [a.rule, a.ok]), [['pick', true]], 'the clock tick matched the clock rule')
  assert.equal(JSON.parse(cli(w, 'events', '--json', '--since', '30d', '--source', 'tasks_cli', '--kind', 'task.*').stdout).length, 1)
  assert.match(cli(w, 'events', '--since', '30d').stdout, /tasks_cli\s+task\.done\s+site-fix\s+web → ok$/m, 'the text form says what each rule did')
  assert.ok(!cli(w, 'events').stdout.includes('task.done'), 'the default window is a day, and the emitted event is older')
  const status = cli(w, 'status')
  assert.equal(status.code, 0, status.stderr)
  assert.match(status.stdout, /clock\s+schedule\s+every 10s/)
  assert.match(status.stdout, /tasks_cli\s+cli\s+from heai-reactor emit\s+last event -\s+kinds task\.todo, task\.done; emitted 1, pending 0; last 2026-09-01T09:00:00\.000Z task\.done/)
  assert.match(status.stdout, /pick\s+on source=clock.*ok/)
  assert.match(status.stdout, /web\s+on source=tasks_cli area="website"\s+last .* ok/, 'the tick acted on the emitted event')
  assert.equal(readFileSync(join(w.dir, 'web.log'), 'utf8'), 'web-task-site-fix\n')
  const js = JSON.parse(cli(w, 'status', '--json').stdout)
  assert.equal(js.sources.length, 2)
  assert.deepEqual(js.sources[1].every, null)
  assert.equal(js.sources[1].emits, true)
  assert.equal(js.rules.length, 3)
  assert.equal(js.events.lastHour, 1, 'the clock tick is now; the emitted event carries its own time')
  assert.deepEqual(Object.keys(js), ['state', 'config', 'sources', 'rules', 'events'])

  writeFileSync(join(w.dir, 'e.json'), JSON.stringify({ source: 'tasks_cli', kind: 'task.todo', key: 'k', payload: { slug: 's', area: 'website' } }))
  const t = cli(w, 'test', 'web', '--event', 'e.json')
  assert.equal(t.code, 0)
  assert.equal(t.stdout, 'web matches: would run echo web-task-s >> web.log\n')
  assert.equal(cli(w, 'test', 'pick', '--event', 'e.json').code, 1)
  assert.equal(cli(w, 'test', 'nope', '--event', 'e.json').code, 2)
  assert.equal(readFileSync(join(w.dir, 'web.log'), 'utf8'), 'web-task-site-fix\n', 'test is dry')

  const retry = cli(w, 'retry', list[1]!.id)
  assert.equal(retry.code, 0)
  assert.match(retry.stdout, /pick\s+acted/)
  assert.equal(readFileSync(join(w.dir, 'pick.log'), 'utf8'), 'pick\npick\n')
  const again = cli(w, 'retry', list[0]!.id)
  assert.equal(again.code, 0, again.stderr)
  assert.match(again.stdout, /web\s+acted\s+run echo web-task-site-fix/, 'retry works on an emitted event')
  assert.equal(readFileSync(join(w.dir, 'web.log'), 'utf8'), 'web-task-site-fix\nweb-task-site-fix\n')
  const replay = cli(w, 'replay', '--since', '30d', '--dry-run')
  assert.equal(replay.code, 0)
  assert.match(replay.stdout, /pick\s+deduped/)
  assert.match(replay.stdout, /web\s+deduped/, 'replay works on an emitted event')
  assert.match(cli(w, 'replay', '--since', '1h', '--rule', 'nope').stderr, /no rule nope/)
})

test('a debounced rule fires on a later tick once its window has closed', () => {
  const w = makeWorld(YAML, makeClock())
  let r = cli(w, 'emit', 'tasks_cli', 'task.todo', '--key', 'a', '--act')
  assert.match(r.stdout, /pick-now\s+debounced/)
  assert.ok(!existsSync(join(w.dir, 'pick.log')) || !readFileSync(join(w.dir, 'pick.log'), 'utf8').includes('now'))
  const st = JSON.parse(readFileSync(join(w.paths.state, 'rules', 'pick-now.json'), 'utf8'))
  st.pending.until = new Date(Date.now() - 1000).toISOString()
  writeFileSync(join(w.paths.state, 'rules', 'pick-now.json'), JSON.stringify(st))
  r = cli(w, 'tick')
  assert.match(r.stdout, /pick-now\s+acted/)
  assert.match(readFileSync(join(w.dir, 'pick.log'), 'utf8'), /now/)
})

test('serve runs until told to stop', async () => {
  const w = makeWorld(YAML)
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), 'serve'], { cwd: w.dir, env: { ...process.env, ...w.env } })
  let out = ''
  child.stdout.on('data', (c: Buffer) => (out += c.toString()))
  await new Promise<void>((resolve) => {
    const check = () => (out.includes('reactor serving') ? resolve() : setTimeout(check, 20))
    check()
  })
  await new Promise((r) => setTimeout(r, 300))
  child.kill('SIGTERM')
  const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)))
  assert.equal(code, 0)
  assert.match(out, /reactor serving 2 sources/)
  assert.match(out, /reactor stopping/)
  assert.equal(readFileSync(join(w.dir, 'pick.log'), 'utf8'), 'pick\n', 'the clock ticked once; the cli source did nothing')
})

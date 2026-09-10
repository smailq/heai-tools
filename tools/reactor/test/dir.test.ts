import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, renameSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorld, writeScript } from './helpers.ts'

const YAML = `sources:
  drops: { type: dir, path: drops, every: 1s }
rules:
  - { name: exited, on: { source: drops, kind: exited }, run: "echo {{ flow }}:{{ exitCode }}:{{ file }} >> exited.log" }
`

function drop(dir: string, name: string, body: string, mtimeSec: number): void {
  writeFileSync(join(dir, `${name}.tmp`), body)
  renameSync(join(dir, `${name}.tmp`), join(dir, name))
  utimesSync(join(dir, name), mtimeSec, mtimeSec)
}

test('every file is one event, in modification-time order, kind from the name, payload from the body, then removed', async () => {
  const w = makeWorld(YAML)
  await w.engine.loadSources()
  const src = w.engine.sources[0]!
  assert.equal((await w.engine.pollSource(src)).length, 0, 'an absent directory is created and empty')
  const dir = join(w.dir, 'drops')
  assert.ok(existsSync(dir))
  drop(dir, 'exited.2', '{"flow":"f2","exitCode":1}', 1_700_000_002)
  drop(dir, 'exited', '{"flow":"f1","exitCode":0}', 1_700_000_001)
  drop(dir, 'touch.1', '', 1_700_000_003)
  drop(dir, 'note', 'plain text', 1_700_000_004)
  writeFileSync(join(dir, 'half.tmp'), '{}')
  writeFileSync(join(dir, '.hidden'), '{}')
  const events = await w.engine.pollSource(src)
  assert.deepEqual(
    events.map((e) => [e.kind, e.payload]),
    [
      ['exited', { flow: 'f1', exitCode: 0, file: 'exited' }],
      ['exited', { flow: 'f2', exitCode: 1, file: 'exited.2' }],
      ['touch', { file: 'touch.1' }],
      ['note', { body: 'plain text', file: 'note' }]
    ]
  )
  assert.equal(events[0]!.at, '2023-11-14T22:13:21.000Z', 'the event is dated by the file')
  assert.ok(w.notes.some((n) => /note: body is not a JSON object/.test(n)))
  assert.deepEqual(readdirSync(dir).sort(), ['.hidden', 'half.tmp'], 'taken files are gone; .tmp and dotfiles stay')
  const cursor = w.log.cursor<{ taken: number; last: { kind: string } }>('drops')!
  assert.deepEqual([cursor.taken, cursor.last.kind], [4, 'note'])
  assert.equal((await w.engine.pollSource(src)).length, 0)
})

test('the same fact written twice is two events; archive keeps the files', async () => {
  const w = makeWorld(`sources:\n  drops: { type: dir, path: drops, archive: drops/.done }\n`)
  await w.engine.loadSources()
  const src = w.engine.sources[0]!
  const dir = join(w.dir, 'drops')
  mkdirSync(dir)
  drop(dir, 'touch', '', 1_700_000_001)
  const a = await w.engine.pollSource(src)
  drop(dir, 'touch', '', 1_700_000_002)
  const b = await w.engine.pollSource(src)
  assert.notEqual(a[0]!.key, b[0]!.key, 'a later write of the same name is a new key')
  assert.deepEqual(readdirSync(join(dir, '.done')).sort(), ['2023-11-14T22-13-21-000Z.touch', '2023-11-14T22-13-22-000Z.touch'])
})

test('a rule runs with the file payload in its templates and environment', async () => {
  const w = makeWorld(YAML)
  writeScript(w, 'unused.sh', 'true')
  await w.engine.loadSources()
  const dir = join(w.dir, 'drops')
  mkdirSync(dir)
  drop(dir, 'exited', '{"flow":"f1","exitCode":0}', 1_700_000_001)
  await w.engine.tick()
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(readdirSync(w.dir).includes('exited.log'), true)
  const { readFileSync } = await import('node:fs')
  assert.equal(readFileSync(join(w.dir, 'exited.log'), 'utf8'), 'f1:0:exited\n')
  assert.equal(readdirSync(dir).length, 0)
})

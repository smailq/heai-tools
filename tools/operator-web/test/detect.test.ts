import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Reader } from '../src/reader.ts'
import { fixtureReading, get, serve } from './helpers.ts'

/** A project directory holding only what is named, and a reader over it that asks no tool. */
function project(...have: string[]): Reader {
  const dir = mkdtempSync(join(tmpdir(), 'operator-web-project-'))
  for (const h of have) {
    if (h.endsWith('/')) mkdirSync(join(dir, h), { recursive: true })
    else writeFileSync(join(dir, h), '')
  }
  return new Reader({ tasksDir: join(dir, 'tasks'), mapOverride: join(dir, 'architecture.yaml'), env: { HEAI_DIR: dir }, cwd: dir, interval: 2000, poll: 5000 })
}

const off = (r: Reader): string[] => Object.entries(r.reading.absent).filter(([, why]) => why).map(([tool]) => tool)

test('a tool is found by its files in the project, and only then is its tab on', async () => {
  const cases: Array<[string[], string[]]> = [
    [['architecture.yaml', 'tasks/items/', 'flow/', 'pod/', 'reactor/', 'agents/'], []],
    [['architecture.yaml', 'flow.yaml', 'pod.yaml', 'reactor.yaml'], ['tasks', 'agents']],
    [['tasks/items/'], ['architect', 'flows', 'pod', 'reactor', 'agents']],
    [['pod/'], ['architect', 'tasks', 'flows', 'reactor', 'agents']],
    [['tasks/', 'reactor/'], ['architect', 'tasks', 'flows', 'pod', 'agents']],
    [['agents/'], ['architect', 'tasks', 'flows', 'pod', 'reactor']]
  ]
  for (const [have, want] of cases) {
    const r = project(...have)
    await r.readTracker()
    assert.deepEqual(off(r), want, have.join(' '))
  }
})

test('a project without a tracker still starts; one with none of the tools does not', async () => {
  const r = project('architecture.yaml')
  await r.readTracker()
  assert.equal(r.reading.tracker, null)
  assert.match(r.reading.absent.tasks, /no items\//)
  await assert.rejects(project().start(), /nothing to show here/)
})

test('the tab of a tool that is not there is off: no link, and why in its place', async () => {
  const reading = fixtureReading()
  reading.absent = { ...reading.absent, architect: 'not configured here (no map at /repo/architecture.yaml)', pod: 'not configured here (no pod.yaml or pod/ in the project)' }
  const s = await serve(reading)
  try {
    for (const path of ['/tasks', '/architect/']) {
      const body = (await get(s.url + path)).body
      assert.ok(!body.includes('href="/pod"') && !body.includes('href="/architect/"'), `${path}: an off tab links nowhere`)
      assert.match(body, /<span title="not configured here \(no pod\.yaml or pod\/ in the project\)" aria-disabled="true" class="optab off"><b>pod<\/b><small>not configured here/, path)
      for (const on of ['href="/tasks"', 'href="/flows"', 'href="/reactor"', 'href="/agents"']) assert.ok(body.includes(on), `${path}: missing ${on}`)
      const order = [...body.matchAll(/class="optab[^"]*"><b>([a-z]+)<\/b>/g)].map((m) => m[1])
      assert.deepEqual(order, ['architect', 'tasks', 'flows', 'pod', 'reactor', 'agents'], `${path}: every tab is still shown, in order`)
    }
    const root = await get(s.url + '/')
    assert.equal(root.headers.get('location'), '/tasks', 'the root goes to the first tab that is on')
    assert.equal((await get(s.url + '/pod')).status, 200, 'the page of an off tab still answers at its address')
    const state = JSON.parse((await get(s.url + '/api/state')).body) as { absent: Record<string, string> }
    assert.equal(state.absent['tasks'], '')
    assert.match(state.absent['pod']!, /no pod\.yaml/)
  } finally {
    await s.close()
  }
})

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { mapToYaml } from '../src/mapeditor.ts'
import { emptyReading } from '../src/reader.ts'
import { architectOnPath, FIXTURES, get, send, serve, underHost } from './helpers.ts'

const YAML = readFileSync(join(FIXTURES, 'map', 'architecture.yaml'), 'utf8')
// The map as architect parses it: `heai-architect check architecture.yaml --format json`, its "map".
const MAP = JSON.parse(readFileSync(join(FIXTURES, 'map', 'architecture.json'), 'utf8')) as Record<string, any>

test('an unchanged map written over its own file is the file, byte for byte', () => {
  assert.equal(mapToYaml(MAP, YAML), YAML)
})

test('an edit changes its own lines and no others', () => {
  const edited = structuredClone(MAP)
  edited['territories'].api.owner = 'core-owner'
  const a = YAML.split('\n')
  const b = mapToYaml(edited, YAML).split('\n')
  assert.equal(a.length, b.length)
  const changed = b.filter((l, i) => l !== a[i])
  assert.deepEqual(changed.map((l) => l.trim()), ['owner: core-owner'])
})

test('a new map keeps its keys in order, short lists inline, multiline text as a block', () => {
  const out = mapToYaml({ version: 1, actors: { b: { type: 'human' }, a: { type: 'llm-agent', context: 'one\ntwo\n' } }, territories: { t: { scope: [{ repository: 'app', globs: ['src/**'] }] } } })
  assert.equal(out, 'version: 1\nactors:\n  b:\n    type: human\n  a:\n    type: llm-agent\n    context: |\n      one\n      two\nterritories:\n  t:\n    scope:\n      - repository: app\n        globs: [src/**]\n')
})

/** A server whose map is a copy of the fixture in a temporary directory. */
async function editor(): Promise<{ url: string; path: string; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'operator-web-map-'))
  const path = join(dir, 'architecture.yaml')
  writeFileSync(path, YAML, { mode: 0o640 })
  const s = await serve({ ...emptyReading(), map: path, project: dir })
  return { url: s.url, path, close: s.close }
}

test('the editor page and the file', async () => {
  const e = await editor()
  try {
    assert.equal((await get(e.url + '/map')).status, 301)
    assert.equal((await get(e.url + '/map/')).status, 200)
    const f = await send('GET', e.url + '/map/api/file', undefined)
    assert.equal(f.status, 200)
    assert.equal(f.json['path'], e.path)
    assert.equal(f.json['exists'], true)
    assert.equal(f.json['yaml'], YAML)
  } finally {
    await e.close()
  }
})

test("the editor's API answers only its own page", async () => {
  const e = await editor()
  try {
    // A rebound DNS name reaching this server is refused, even for a read.
    assert.equal(await underHost(e.url + '/map/api/file', 'evil.example'), 403)
    assert.equal(await underHost(e.url + '/map/api/file', 'evil.example:8790'), 403)
    assert.equal(await underHost(e.url + '/map/api/file', '127.0.0.1:8790'), 200)
    assert.equal((await send('PUT', e.url + '/map/api/file', { yaml: 'x' }, { origin: 'http://evil.example' })).status, 403)
    const form = await fetch(e.url + '/map/api/file', { method: 'PUT', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'yaml=x' })
    assert.equal(form.status, 403)
    assert.equal((await send('POST', e.url + '/map/', {})).status, 405, 'the page itself is read only')
  } finally {
    await e.close()
  }
  // A name given with --allow-host is this machine too.
  const s = await serve(emptyReading(), { allowHosts: ['box.tailnet'] })
  try {
    assert.notEqual(await underHost(s.url + '/map/api/file', 'box.tailnet'), 403)
    assert.equal(await underHost(s.url + '/map/api/file', 'other.tailnet'), 403)
  } finally {
    await s.close()
  }
})

test("serialize takes its comments from the page's base, not the file on disk", async () => {
  const e = await editor()
  try {
    writeFileSync(e.path, YAML + '# edited elsewhere\n')
    const r = await send('POST', e.url + '/map/api/serialize', { map: MAP, base: YAML })
    assert.equal(r.json['yaml'], YAML)
  } finally {
    await e.close()
  }
})

const architect = architectOnPath()

test('save: only a valid map, only over the version loaded unless forced, keeping the mode', { skip: !architect && 'architect has no dependencies installed' }, async () => {
  const e = await editor()
  try {
    const base = (await send('GET', e.url + '/map/api/file', undefined)).json['version'] as string
    const edited = YAML.replace('owner: api-owner', 'owner: core-owner')
    assert.equal((await send('PUT', e.url + '/map/api/file', { yaml: 'version: 1\nactors: 3\n', base })).status, 422)
    const saved = await send('PUT', e.url + '/map/api/file', { yaml: edited, base })
    assert.equal(saved.status, 200)
    assert.notEqual(saved.json['version'], base)
    assert.equal(readFileSync(e.path, 'utf8'), edited)
    assert.equal(statSync(e.path).mode & 0o777, 0o640)
    assert.equal((await send('PUT', e.url + '/map/api/file', { yaml: YAML, base })).status, 409, 'a stale save is a conflict')
    assert.equal((await send('PUT', e.url + '/map/api/file', { yaml: YAML, base, force: true })).status, 200)
    assert.equal(readFileSync(e.path, 'utf8'), YAML)
  } finally {
    await e.close()
  }
})

test('validate: a map object or its text, answered by architect', { skip: !architect && 'architect has no dependencies installed' }, async () => {
  const e = await editor()
  try {
    const ok = await send('POST', e.url + '/map/api/validate', { map: MAP })
    assert.equal(ok.json['valid'], true)
    assert.ok(ok.json['map'])
    const bad = await send('POST', e.url + '/map/api/validate', { yaml: 'version: 1\nterritories: {x: {owner: nobody}}\n' })
    assert.equal(bad.json['valid'], false)
    assert.ok((bad.json['errors'] as string[]).length > 0)
  } finally {
    await e.close()
  }
})

test('a project without a map gets one: a save over nothing creates the file', { skip: !architect && 'architect has no dependencies installed' }, async () => {
  const e = await editor()
  try {
    unlinkSync(e.path)
    assert.equal((await send('GET', e.url + '/map/api/file', undefined)).json['exists'], false)
    const r = await send('PUT', e.url + '/map/api/file', { yaml: YAML, base: '' })
    assert.equal(r.status, 200)
    assert.equal(readFileSync(e.path, 'utf8'), YAML)
  } finally {
    await e.close()
  }
})

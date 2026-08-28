import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load, ValidationError } from '../src/store.ts'
import { loadConfig, loadVocabularies, UsageError } from '../src/config.ts'

const task = (fields: Record<string, string>, body = 'Body.'): string =>
  `---\ntitle: ${fields['title'] ?? 'A task'}\nstatus: ${fields['status'] ?? 'todo'}\npriority: ${fields['priority'] ?? ''}\nterritory: ${fields['territory'] ?? ''}\ncreated_at: 2026-08-20\nmodified_at: 2026-08-20\n---\n\n${body}\n`

/** A tracker directory on disk, from a map of relative path to contents. */
function tracker(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'task-manager-'))
  mkdirSync(join(dir, 'items'), { recursive: true })
  for (const [path, contents] of Object.entries(files)) writeFileSync(join(dir, path), contents)
  return dir
}

test('loads every task in a directory, in slug order', () => {
  const dir = tracker({
    'items/two.md': task({ title: 'Two' }),
    'items/one.md': task({ title: 'One', priority: 'high' })
  })
  assert.deepEqual(
    load(dir).tasks.map((t) => t.slug),
    ['one', 'two']
  )
})

test('a directory without items/ is a usage error, not a validation error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-manager-'))
  assert.throws(() => load(dir), UsageError)
})

test('every bad file is reported, not just the first', () => {
  const dir = tracker({
    'items/one.md': task({ status: 'nope' }),
    'items/two.md': 'garbage\n'
  })
  try {
    load(dir)
    assert.fail('expected a ValidationError')
  } catch (e) {
    assert.ok(e instanceof ValidationError)
    assert.equal(e.problems.length, 2)
    assert.ok(e.problems[0]!.startsWith('items/one.md:'))
    assert.ok(e.problems[1]!.startsWith('items/two.md:'))
  }
})

test('a file name that is not a slug is rejected', () => {
  const dir = tracker({ 'items/Not_A_Slug.md': task({}) })
  assert.throws(() => load(dir), /kebab-case slug/)
})

test('an unknown configuration key is a usage error', () => {
  const dir = tracker({ 'config.yaml': 'projects: [app]\n' })
  assert.throws(() => loadConfig(dir), /unknown configuration key "projects"/)
})

test('an absent configuration leaves the territory vocabulary open', () => {
  const vocabularies = loadVocabularies(tracker({}))
  assert.equal(vocabularies.territories, null)
  assert.equal(vocabularies.ownerOf('anything'), null)
})

test('territories and their owners are read from the configured map', () => {
  const dir = tracker({
    'config.yaml': 'map: ./map.yaml\n',
    'map.yaml': 'territories:\n  api:\n    owner: api-owner\n  ui:\n    owner: ui-owner\n'
  })
  const vocabularies = loadVocabularies(dir)
  assert.deepEqual(vocabularies.territories, ['api', 'ui'])
  assert.equal(vocabularies.ownerOf('api'), 'api-owner')
  assert.equal(vocabularies.ownerOf('missing'), null)
})

test('a configured map that cannot be read fails rather than reopening the vocabulary', () => {
  const dir = tracker({ 'config.yaml': 'map: ./nowhere.yaml\n' })
  assert.throws(() => loadVocabularies(dir), /cannot read architecture map/)
})

test('a configured map validates the territory a task claims', () => {
  const files = {
    'config.yaml': 'map: ./map.yaml\n',
    'map.yaml': 'territories:\n  api:\n    owner: api-owner\n'
  }
  assert.equal(load(tracker({ ...files, 'items/one.md': task({ territory: 'api' }) })).tasks.length, 1)
  assert.throws(
    () => load(tracker({ ...files, 'items/one.md': task({ territory: 'ui' }) })),
    /territory "ui" not in \[api\]/
  )
})

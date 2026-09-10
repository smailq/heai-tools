import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverDir, load, ValidationError } from '../src/store.ts'
import { loadConfig, loadVocabularies, parseConfig, SCHEMA_PATH, schemaProblems, UsageError } from '../src/config.ts'

const task = (fields: Record<string, string>, body = 'Body.'): string =>
  `---\ntitle: ${fields['title'] ?? 'A task'}\nstatus: ${fields['status'] ?? 'todo'}\npriority: ${fields['priority'] ?? ''}\nterritory: ${fields['territory'] ?? ''}\ncreated_at: 2026-08-20\nmodified_at: 2026-08-20\n---\n\n${body}\n`

/** A tracker directory on disk, from a map of relative path to contents. */
function tracker(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-'))
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
  const dir = mkdtempSync(join(tmpdir(), 'tasks-'))
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

test('the configuration is checked against the schema: unknown keys, a map that is not a path, every problem at once', () => {
  assert.throws(() => loadConfig(tracker({ 'tasks.yaml': 'projects: [app]\n' })), /unknown configuration key "projects"; the keys are map/)
  assert.throws(() => loadConfig(tracker({ 'tasks.yaml': 'map: 3\n' })), /\/map: must be a path/)
  assert.throws(() => loadConfig(tracker({ 'tasks.yaml': 'map: ""\n' })), /\/map: must be a path/)
  assert.throws(() => loadConfig(tracker({ 'tasks.yaml': '- a\n' })), /must be a mapping/)
  assert.throws(() => loadConfig(tracker({ 'tasks.yaml': 'map: [\n' })), /not valid YAML/)
  assert.deepEqual(schemaProblems({ map: 1, extra: true }).length, 2)
  assert.deepEqual(schemaProblems({}), [])
  assert.deepEqual(parseConfig(''), {})
  assert.deepEqual(parseConfig('map: ../architecture.yaml\n'), { map: '../architecture.yaml' })
  assert.ok(existsSync(SCHEMA_PATH), 'the schema ships with the tool')
})

test('an absent configuration leaves the territory vocabulary open', () => {
  const vocabularies = loadVocabularies(tracker({}))
  assert.equal(vocabularies.territories, null)
  assert.equal(vocabularies.ownerOf('anything'), null)
})

test('territories and their owners are read from the configured map', () => {
  const dir = tracker({
    'tasks.yaml': 'map: ./map.yaml\n',
    'map.yaml': 'territories:\n  api:\n    owner: api-owner\n  ui:\n    owner: ui-owner\n'
  })
  const vocabularies = loadVocabularies(dir)
  assert.deepEqual(vocabularies.territories, ['api', 'ui'])
  assert.equal(vocabularies.ownerOf('api'), 'api-owner')
  assert.equal(vocabularies.ownerOf('missing'), null)
})

test('a child territory without an owner inherits through the parent chain', () => {
  const dir = tracker({
    'tasks.yaml': 'map: ./map.yaml\n',
    'map.yaml': [
      'territories:',
      '  root:',
      '    owner: kyu',
      '  mid:',
      '    parent: root',
      '  leaf:',
      '    parent: mid',
      '  own:',
      '    parent: root',
      '    owner: api-owner',
      '  broken:',
      '    parent: ghost',
      ''
    ].join('\n')
  })
  const vocabularies = loadVocabularies(dir)
  assert.equal(vocabularies.ownerOf('leaf'), 'kyu')
  assert.equal(vocabularies.ownerOf('own'), 'api-owner')
  // A chain the map leaves broken resolves to no owner; judging the map is
  // the validator's business, not this tool's.
  assert.equal(vocabularies.ownerOf('broken'), null)
})

test('a configured map that cannot be read fails rather than reopening the vocabulary', () => {
  const dir = tracker({ 'tasks.yaml': 'map: ./nowhere.yaml\n' })
  assert.throws(() => loadVocabularies(dir), /cannot read architecture map/)
})

test('a configured map validates the territory a task claims', () => {
  const files = {
    'tasks.yaml': 'map: ./map.yaml\n',
    'map.yaml': 'territories:\n  api:\n    owner: api-owner\n'
  }
  assert.equal(load(tracker({ ...files, 'items/one.md': task({ territory: 'api' }) })).tasks.length, 1)
  assert.throws(
    () => load(tracker({ ...files, 'items/one.md': task({ territory: 'ui' }) })),
    /territory "ui" not in \[api\]/
  )
})

test('the tracker is found by flag, then HEAI_TASKS, then HEAI_DIR, then .heai/, then tasks', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tasks-discover-'))
  const none = {}
  assert.equal(discoverDir(undefined, none, cwd), join(cwd, 'tasks'))

  mkdirSync(join(cwd, '.heai', 'tasks'), { recursive: true })
  assert.equal(discoverDir(undefined, none, cwd), join(cwd, '.heai', 'tasks'))

  const project = { HEAI_DIR: '/srv/project' }
  assert.equal(discoverDir(undefined, project, cwd), '/srv/project/tasks')

  const own = { HEAI_DIR: '/srv/project', HEAI_TASKS: 'elsewhere' }
  assert.equal(discoverDir(undefined, own, cwd), join(cwd, 'elsewhere'))

  assert.equal(discoverDir('here', own, cwd), join(cwd, 'here'))
  assert.equal(discoverDir('/abs/here', own, cwd), '/abs/here')
})

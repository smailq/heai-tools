import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTask, deleteTask, updateTask } from '../src/edit.ts'
import { today } from '../src/model.ts'
import { load, ValidationError } from '../src/store.ts'
import { UsageError } from '../src/config.ts'
import { writeIndex } from '../src/render.ts'

function tracker(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'task-manager-edit-'))
  mkdirSync(join(dir, 'items'), { recursive: true })
  for (const [path, contents] of Object.entries(files)) writeFileSync(join(dir, path), contents)
  writeIndex(load(dir))
  return dir
}

const read = (dir: string, file: string): string => readFileSync(join(dir, file), 'utf8')

test('a created task is written in the format the parser demands', () => {
  const dir = tracker()
  const result = createTask(dir, 'do-the-thing', { title: 'Do the thing' }, 'Why, and what done means.')

  assert.equal(result.file, 'items/do-the-thing.md')
  const stamp = today()
  assert.equal(
    read(dir, 'items/do-the-thing.md'),
    `---\ntitle: Do the thing\nstatus: backlog\npriority:\nterritory:\ncreated_at: ${stamp}\nmodified_at: ${stamp}\n---\n\nWhy, and what done means.\n`
  )
  // The round trip is the real check: what was written parses back unchanged.
  assert.equal(load(dir).tasks[0]!.title, 'Do the thing')
})

test('creating regenerates the view, so it is never left behind', () => {
  const dir = tracker()
  createTask(dir, 'one', { title: 'One', priority: 'high' }, 'Body.')
  assert.match(read(dir, 'INDEX.md'), /- \[one\]\(items\/one\.md\) · p:high/)
  assert.match(read(dir, 'INDEX.md'), /\*\*1 tasks?\*\*/)
})

test('a new task defaults to backlog and untriaged', () => {
  const dir = tracker()
  const task = createTask(dir, 'one', { title: 'One' }, 'Body.').store.tasks[0]!
  assert.equal(task.status, 'backlog')
  assert.deepEqual([task.priority, task.territory], ['', ''])
})

test('a slug is an id: it is checked, and never reused', () => {
  const dir = tracker()
  assert.throws(() => createTask(dir, 'Not A Slug', { title: 'x' }, 'b'), UsageError)
  createTask(dir, 'one', { title: 'One' }, 'Body.')
  assert.throws(() => createTask(dir, 'one', { title: 'Again' }, 'Body.'), /already exists/)
})

test('an invalid value is refused, and nothing is written', () => {
  const dir = tracker()
  assert.throws(() => createTask(dir, 'one', { title: 'One', status: 'shipping' as never }, 'b'), ValidationError)
  assert.equal(load(dir).tasks.length, 0)
  assert.doesNotMatch(read(dir, 'INDEX.md'), /items\/one\.md/)
})

test('an update changes the named properties and leaves the rest alone', () => {
  const dir = tracker()
  createTask(dir, 'one', { title: 'One', priority: 'low' }, 'The original body.')
  const result = updateTask(dir, 'one', { status: 'in-progress' })

  assert.deepEqual(result.changed, ['status'])
  const task = load(dir).tasks[0]!
  assert.equal(task.status, 'in-progress')
  assert.equal(task.priority, 'low')
  assert.equal(task.body, 'The original body.')
})

test('an empty value clears a property', () => {
  const dir = tracker()
  createTask(dir, 'one', { title: 'One', priority: 'urgent' }, 'Body.')
  updateTask(dir, 'one', { priority: '' })
  assert.equal(load(dir).tasks[0]!.priority, '')
})

test('setting a property to what it already is reports no change', () => {
  const dir = tracker()
  createTask(dir, 'one', { title: 'One', status: 'todo' }, 'Body.')
  assert.deepEqual(updateTask(dir, 'one', { status: 'todo' }).changed, [])
})

test('a note is appended; a body is never rewritten', () => {
  const dir = tracker()
  createTask(dir, 'one', { title: 'One' }, 'The scope.')
  updateTask(dir, 'one', { status: 'blocked' }, 'Blocked by [two](two.md).')
  const body = load(dir).tasks[0]!.body
  assert.equal(body, 'The scope.\n\nBlocked by [two](two.md).')
})

test('updating an unknown slug is a usage error, not a silent create', () => {
  const dir = tracker()
  assert.throws(() => updateTask(dir, 'nope', { status: 'todo' }), /no task "nope"/)
})

test('a property the format does not have is refused by name', () => {
  const dir = tracker()
  assert.throws(
    () => createTask(dir, 'one', { git_branch: 'wip/x' } as never, 'Body.'),
    /"git_branch" is not a property/
  )
})

test('a territory is checked against the configured map', () => {
  const dir = tracker({
    'config.yaml': 'map: ./map.yaml\n',
    'map.yaml': 'territories:\n  api:\n    owner: api-owner\n'
  })
  createTask(dir, 'one', { title: 'One', territory: 'api' }, 'Body.')
  assert.throws(() => updateTask(dir, 'one', { territory: 'ui' }), /territory "ui" not in \[api\]/)
  assert.equal(load(dir).tasks[0]!.territory, 'api')
})

test('an edit refuses to start from an already-invalid tracker', () => {
  // Built without the helper: the helper renders the views, which would itself
  // fail here. An edit is applied to a tracker that holds, or not at all.
  const dir = mkdtempSync(join(tmpdir(), 'task-manager-edit-'))
  mkdirSync(join(dir, 'items'), { recursive: true })
  writeFileSync(join(dir, 'items', 'bad.md'), 'garbage\n')
  assert.throws(() => createTask(dir, 'one', { title: 'One' }, 'Body.'), ValidationError)
})

// ── Timestamps and deletion ───────────────────────────────────────────────

test('creating stamps both dates; a caller cannot set them', () => {
  const dir = tracker()
  const task = createTask(dir, 'one', { title: 'One' }, 'Body.').store.tasks[0]!
  assert.equal(task.created_at, today())
  assert.equal(task.modified_at, today())
  assert.throws(
    () => createTask(dir, 'two', { created_at: '2020-01-01' } as never, 'Body.'),
    /"created_at" is not a property/
  )
})

test('an edit restamps modified_at and leaves created_at alone', () => {
  const dir = tracker({
    'items/one.md':
      '---\ntitle: One\nstatus: todo\npriority:\nterritory:\ncreated_at: 2020-01-01\nmodified_at: 2020-01-01\n---\n\nBody.\n'
  })
  updateTask(dir, 'one', { status: 'in-progress' })
  const task = load(dir).tasks[0]!
  assert.equal(task.created_at, '2020-01-01')
  assert.equal(task.modified_at, today())
})

test('an edit that changes nothing does not restamp', () => {
  const dir = tracker({
    'items/one.md':
      '---\ntitle: One\nstatus: todo\npriority:\nterritory:\ncreated_at: 2020-01-01\nmodified_at: 2020-01-02\n---\n\nBody.\n'
  })
  updateTask(dir, 'one', { status: 'todo' })
  assert.equal(load(dir).tasks[0]!.modified_at, '2020-01-02')
})

test('deleting moves the file rather than unlinking it', () => {
  const dir = tracker()
  createTask(dir, 'one', { title: 'One' }, 'Body.')
  const result = deleteTask(dir, 'one')

  assert.equal(result.file, 'deleted/one.md')
  assert.equal(load(dir).tasks.length, 0)
  assert.ok(!existsSync(join(dir, 'items', 'one.md')))
  // Still readable at a known path, so a slug others point at is not dangling.
  assert.match(readFileSync(join(dir, 'deleted', 'one.md'), 'utf8'), /title: One/)
  // deleted/ is not read back as tasks, and the view no longer lists it.
  assert.doesNotMatch(read(dir, 'INDEX.md'), /items\/one\.md/)
})

test('deleting an unknown task is a usage error', () => {
  assert.throws(() => deleteTask(tracker(), 'nope'), /no task "nope"/)
})

test('deleting refuses to overwrite an earlier deletion of the same slug', () => {
  const dir = tracker()
  createTask(dir, 'one', { title: 'One' }, 'First.')
  deleteTask(dir, 'one')
  createTask(dir, 'one', { title: 'One again' }, 'Second.')
  assert.throws(() => deleteTask(dir, 'one'), /already exists/)
})

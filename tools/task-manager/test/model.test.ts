import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TASK_KEYS, parseTask, taskOrder, serializeTask, type Task } from '../src/model.ts'

const TASK = `---
title: Do the thing
status: todo
priority: high
territory: api
created_at: 2026-08-20
modified_at: 2026-08-25
---

Some body.
`

const problems = (result: ReturnType<typeof parseTask>): string[] => {
  assert.equal(result.ok, false)
  return result.ok ? [] : result.problems
}

test('parses a well-formed task', () => {
  const result = parseTask('do-the-thing', TASK)
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok && result.value, {
    slug: 'do-the-thing',
    title: 'Do the thing',
    status: 'todo',
    priority: 'high',
    territory: 'api',
    created_at: '2026-08-20',
    modified_at: '2026-08-25',
    body: 'Some body.'
  })
})

test('an empty optional field is unset, not invalid', () => {
  const raw = TASK.replace('priority: high', 'priority:').replace('territory: api', 'territory:')
  const result = parseTask('t', raw)
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.value.priority, '')
})

test('reports every problem in one pass', () => {
  const raw = `---
title:
status: shipping
priority: soon
---
`
  const found = problems(parseTask('t', raw))
  assert.ok(found.some((p) => p.includes('missing frontmatter key: territory')))
  assert.ok(found.some((p) => p.includes('missing frontmatter key: created_at')))
  assert.ok(found.some((p) => p.includes('title must not be empty')))
  assert.ok(found.some((p) => p.includes('body must not be empty')))
  assert.ok(found.some((p) => p.includes('"shipping"')))
  assert.ok(found.some((p) => p.includes('"soon"')))
})

test('the key set is exactly six, and carries nothing tool-specific', () => {
  // A task says what the work is and who owns it; branch, PR, build, release
  // and environment belong to the layer that ships it. Pinned so a field for
  // one of them cannot be added without this failing first.
  assert.deepEqual(TASK_KEYS, [
    'title',
    'status',
    'priority',
    'territory',
    'created_at',
    'modified_at'
  ])
})

test('a task still carrying git_branch is rejected, not ignored', () => {
  const raw = TASK.replace('territory: api', 'git_branch: wip/x\nterritory: api')
  assert.ok(problems(parseTask('t', raw)).includes('unknown frontmatter key: git_branch'))
})

test('a task still carrying release is rejected, not ignored', () => {
  const raw = TASK.replace('territory: api', 'territory: api\nrelease: app-1.0.0')
  assert.ok(problems(parseTask('t', raw)).includes('unknown frontmatter key: release'))
})

test('rejects unknown and duplicate frontmatter keys', () => {
  const raw = TASK.replace('territory: api', 'territory: api\nassignee: kyu\nstatus: todo')
  const found = problems(parseTask('t', raw))
  assert.ok(found.includes('unknown frontmatter key: assignee'))
  assert.ok(found.includes('duplicate frontmatter key: status'))
})

test('missing frontmatter delimiters are named exactly', () => {
  assert.ok(problems(parseTask('t', 'no frontmatter\n'))[0]!.includes("opening '---'"))
  assert.ok(problems(parseTask('t', '---\ntitle: x\n'))[0]!.includes("closing '---'"))
})

test('a closed territory vocabulary is enforced; an open one is not', () => {
  const closed = { territories: ['core'] }
  assert.ok(problems(parseTask('t', TASK, closed))[0]!.includes('territory "api"'))
  assert.equal(parseTask('t', TASK, { territories: null }).ok, true)
})

test('an empty territory passes even a closed vocabulary', () => {
  const raw = TASK.replace('territory: api', 'territory:')
  assert.equal(parseTask('t', raw, { territories: ['core'] }).ok, true)
})

const task = (slug: string, priority: string): Task =>
  ({
    slug,
    priority,
    title: slug,
    status: 'todo',
    territory: '',
    created_at: '',
    modified_at: '',
    body: 'x'
  }) as Task

test('tasks sort by priority, then slug, with untriaged last', () => {
  const sorted = [task('b', ''), task('c', 'low'), task('a', 'urgent'), task('d', 'urgent')]
    .sort(taskOrder)
    .map((t) => t.slug)
  assert.deepEqual(sorted, ['a', 'd', 'c', 'b'])
})

test('serializing round-trips through the parser', () => {
  const original = parseTask('do-the-thing', TASK)
  assert.ok(original.ok)
  const again = parseTask('do-the-thing', serializeTask(original.value))
  assert.deepEqual(again.ok && again.value, original.value)
})

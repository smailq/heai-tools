import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TASK_KEYS,
  normalizeTerritories,
  parseTask,
  pickUpOrder,
  runBlockOf,
  taskOrder,
  taskRecord,
  serializeTask,
  territoriesOf,
  type Task
} from '../src/model.ts'

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

test('a territory list is several names, comma-separated, stored canonically', () => {
  const raw = TASK.replace('territory: api', 'territory: web,api ,  billing')
  const parsed = parseTask('t', raw)
  assert.ok(parsed.ok)
  assert.equal(parsed.value.territory, 'api, billing, web')
  assert.deepEqual(territoriesOf(parsed.value.territory), ['api', 'billing', 'web'])
  assert.equal(normalizeTerritories(' web, api,api '), 'api, web')
  assert.deepEqual(territoriesOf(''), [])
})

test('every name in a territory list is checked against a closed vocabulary', () => {
  const closed = { territories: ['api', 'web'] }
  assert.ok(parseTask('t', TASK.replace('territory: api', 'territory: api, web'), closed).ok)
  const found = problems(parseTask('t', TASK.replace('territory: api', 'territory: api, ui'), closed))
  assert.ok(found.some((p) => p.includes('territory "ui" not in [api, web]')))
})

test('a territory list that repeats a name, or leaves an entry empty, is refused', () => {
  const twice = problems(parseTask('t', TASK.replace('territory: api', 'territory: api, api')))
  assert.ok(twice.some((p) => p.includes('territory lists "api" twice')))
  const gap = problems(parseTask('t', TASK.replace('territory: api', 'territory: api,, web')))
  assert.ok(gap.some((p) => p.includes('has an empty entry')))
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

const RUN_TASK = `---
title: Regenerate the ontology bindings
status: todo
priority: medium
territory: ontology
created_at: 2026-09-01
modified_at: 2026-09-01
---

The bindings under \`packages/ontology/gen\` are stale after the schema change.

\`\`\`sh run
pnpm --filter ontology generate
git add -A && git commit -m "Regenerate ontology bindings"
\`\`\`

Land it on the ontology lane.
`

test('a task carrying a run block validates exactly as one that does not', () => {
  // The block is a body convention, not a frontmatter key: nothing that reads
  // the format changes, and this pins that the parser does not either.
  const parsed = parseTask('regenerate-bindings', RUN_TASK)
  assert.ok(parsed.ok)
  assert.equal(parsed.value.status, 'todo')
  assert.ok(parsed.value.body.startsWith('The bindings under'))
})

test('the run block is the contents of the `sh run` fence, and nothing else', () => {
  const parsed = parseTask('regenerate-bindings', RUN_TASK)
  assert.ok(parsed.ok)
  assert.equal(
    runBlockOf(parsed.value.body),
    'pnpm --filter ontology generate\ngit add -A && git commit -m "Regenerate ontology bindings"'
  )
})

test('a body without a run block reports none', () => {
  assert.equal(runBlockOf('Prose only.'), null)
  assert.equal(runBlockOf('```sh\necho not tagged run\n```'), null)
  assert.equal(runBlockOf('```run\necho wrong order\n```'), null)
  assert.equal(runBlockOf('```sh run\necho never closed'), null)
})

test('the fence may be tildes or longer backticks, and the first block wins', () => {
  assert.equal(runBlockOf('~~~sh run\nmake\n~~~'), 'make')
  assert.equal(runBlockOf('````sh run\n```\ninner\n```\n````'), '```\ninner\n```')
  assert.equal(runBlockOf('```sh run\nfirst\n```\n\n```sh run\nsecond\n```'), 'first')
})

test('a record splits the territory list and carries exactly the frontmatter', () => {
  const parsed = parseTask('t', TASK.replace('territory: api', 'territory: web, api'))
  assert.ok(parsed.ok)
  assert.deepEqual(taskRecord(parsed.value), {
    slug: 't',
    title: 'Do the thing',
    status: 'todo',
    priority: 'high',
    territory: ['api', 'web'],
    created_at: '2026-08-20',
    modified_at: '2026-08-25'
  })
})

test('pick-up order is status section first, then priority, then slug', () => {
  const at = (slug: string, status: string, priority: string): Task =>
    ({ ...task(slug, priority), status }) as Task
  const sorted = [
    at('z-backlog', 'backlog', 'urgent'),
    at('b-todo', 'todo', ''),
    at('a-todo', 'todo', 'low'),
    at('done', 'done', 'urgent'),
    at('doing', 'in-progress', '')
  ]
    .sort(pickUpOrder)
    .map((t) => t.slug)
  assert.deepEqual(sorted, ['doing', 'a-todo', 'b-todo', 'z-backlog', 'done'])
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src', 'cli.ts')
const run = promisify(execFile)

interface Run {
  code: number
  stdout: string
  stderr: string
}

async function cli(...args: string[]): Promise<Run> {
  return withStdin('', ...args)
}

/** Run the CLI with `input` on stdin, for the commands that read a body there. */
async function withStdin(input: string, ...args: string[]): Promise<Run> {
  return invoke({ input, args })
}

interface Invocation {
  input?: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
}

/** Run the CLI as a script would: with an environment and a working directory of its own. */
async function invoke({ input = '', args, env = {}, cwd }: Invocation): Promise<Run> {
  try {
    const child = run(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, cwd })
    child.child.stdin?.end(input)
    const { stdout, stderr } = await child
    return { code: 0, stdout, stderr }
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string }
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

const task = (f: Record<string, string> = {}): string =>
  `---\ntitle: ${f['title'] ?? 'A task'}\nstatus: ${f['status'] ?? 'todo'}\npriority: ${f['priority'] ?? ''}\nterritory: ${f['territory'] ?? ''}\ncreated_at: 2026-08-20\nmodified_at: 2026-08-20\n---\n\nBody.\n`

const temp = (): string => mkdtempSync(join(tmpdir(), 'tasks-cli-'))

test('--help explains itself and exits 0', async () => {
  const r = await cli('--help')
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes('tasks init'))
})

test('a missing or unknown command exits 2', async () => {
  assert.equal((await cli()).code, 2)
  assert.equal((await cli('rebuild')).code, 2)
  assert.equal((await cli('build', 'extra')).code, 2)
})

test('init scaffolds a tracker and builds its view', async () => {
  const dir = join(temp(), 'tasks')
  const r = await cli('init', '--dir', dir)
  assert.equal(r.code, 0)
  for (const f of ['items', 'tasks.yaml', 'README.md', 'INDEX.md']) {
    assert.ok(existsSync(join(dir, f)), `${f} should exist`)
  }
  assert.ok(readFileSync(join(dir, 'README.md'), 'utf8').includes('## Task file format'))
})

test('init records the map it was given, and never clobbers', async () => {
  const root = temp()
  const dir = join(root, 'tasks')
  writeFileSync(join(root, 'architecture.yaml'), 'territories:\n  api:\n    owner: api-owner\n')
  const created = await cli('init', '--dir', dir, '--map', '../architecture.yaml')
  assert.equal(created.code, 0)
  const config = readFileSync(join(dir, 'tasks.yaml'), 'utf8')
  assert.ok(config.includes('map: ../architecture.yaml'))
  assert.ok(readFileSync(join(dir, 'README.md'), 'utf8').includes('../architecture.yaml'))

  writeFileSync(join(dir, 'README.md'), 'mine\n')
  const again = await cli('init', '--dir', dir)
  assert.equal(again.code, 0)
  assert.ok(again.stdout.includes('left alone'))
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'mine\n')
})

test('build writes the view, and --check holds it in step', async () => {
  const dir = join(temp(), 'tasks')
  await cli('init', '--dir', dir)
  writeFileSync(join(dir, 'items', 'one.md'), task({ title: 'One' }))

  const stale = await cli('build', '--dir', dir, '--check')
  assert.equal(stale.code, 1)
  assert.ok(stale.stderr.includes('INDEX.md is stale'))

  const built = await cli('build', '--dir', dir)
  assert.equal(built.code, 0)
  assert.ok(built.stdout.includes('1 task'))
  assert.ok(readFileSync(join(dir, 'INDEX.md'), 'utf8').includes('- [one](items/one.md)'))

  const fresh = await cli('build', '--dir', dir, '--check')
  assert.equal(fresh.code, 0)
  assert.ok(fresh.stdout.includes('is fresh'))
})

test('invalid files exit 1 and name the file', async () => {
  const dir = join(temp(), 'tasks')
  await cli('init', '--dir', dir)
  writeFileSync(join(dir, 'items', 'one.md'), task({ status: 'nope' }))
  const r = await cli('build', '--dir', dir)
  assert.equal(r.code, 1)
  assert.ok(r.stderr.includes('items/one.md'))
})

test('a directory that is not a tracker exits 2', async () => {
  const r = await cli('build', '--dir', temp())
  assert.equal(r.code, 2)
  assert.ok(r.stderr.includes('has no items/'))
})

test('init refuses a map it cannot read, before scaffolding', async () => {
  const dir = join(temp(), 'tasks')
  const r = await cli('init', '--dir', dir, '--map', './nowhere.yaml')
  assert.equal(r.code, 2)
  assert.ok(r.stderr.includes('cannot read architecture map'))
  assert.ok(!existsSync(join(dir, 'tasks.yaml')))
})

test('a bad configuration exits 2, not 1', async () => {
  const dir = join(temp(), 'tasks')
  mkdirSync(join(dir, 'items'), { recursive: true })
  writeFileSync(join(dir, 'tasks.yaml'), 'map: ./nowhere.yaml\n')
  const r = await cli('build', '--dir', dir)
  assert.equal(r.code, 2)
  assert.ok(r.stderr.includes('cannot read architecture map'))
})

async function tracker(): Promise<string> {
  const dir = join(temp(), 'tasks')
  await cli('init', '--dir', dir)
  return dir
}

test('new creates the file and regenerates the view in one step', async () => {
  const dir = await tracker()
  const r = await cli('new', 'do-it', '--title', 'Do it', '--body', 'The scope.', '--dir', dir)
  assert.equal(r.code, 0)
  assert.match(r.stdout, /Created items\/do-it\.md/)
  assert.match(r.stdout, /Wrote INDEX\.md/)
  const file = readFileSync(join(dir, 'items', 'do-it.md'), 'utf8')
  assert.match(file, /^---\ntitle: Do it\nstatus: backlog\npriority:\nterritory:\n/)
  assert.match(file, /created_at: \d{4}-\d{2}-\d{2}\nmodified_at: \d{4}-\d{2}-\d{2}\n---\n\nThe scope\.\n$/)
  // The view is fresh without a separate build, which is the whole point.
  assert.equal((await cli('build', '--dir', dir, '--check')).code, 0)
})

test('a body can be piped in', async () => {
  const dir = await tracker()
  const r = await withStdin('Line one.\n\nLine two.', 'new', 'piped', '--title', 'Piped', '--dir', dir)
  assert.equal(r.code, 0)
  assert.match(readFileSync(join(dir, 'items', 'piped.md'), 'utf8'), /Line one\.\n\nLine two\./)
})

test('new refuses an empty body rather than writing a placeholder', async () => {
  const dir = await tracker()
  const r = await withStdin('   ', 'new', 'empty', '--title', 'Empty', '--dir', dir)
  assert.equal(r.code, 2)
  assert.match(r.stderr, /body must not be empty/)
})

test('new requires a title', async () => {
  const dir = await tracker()
  const r = await cli('new', 'x', '--body', 'b', '--dir', dir)
  assert.equal(r.code, 2)
  assert.match(r.stderr, /--title is required/)
})

test('set changes a property and reports what changed', async () => {
  const dir = await tracker()
  await cli('new', 'one', '--title', 'One', '--body', 'Scope.', '--dir', dir)
  const r = await cli('set', 'one', '--status', 'in-progress', '--dir', dir)
  assert.equal(r.code, 0)
  assert.match(r.stdout, /Updated items\/one\.md: status/)
  assert.match(readFileSync(join(dir, 'INDEX.md'), 'utf8'), /## in-progress \(1\)/)
})

test('set --note appends to the body without rewriting it', async () => {
  const dir = await tracker()
  await cli('new', 'one', '--title', 'One', '--body', 'Scope.', '--dir', dir)
  await cli('set', 'one', '--status', 'blocked', '--note', 'Waiting on review.', '--dir', dir)
  const file = readFileSync(join(dir, 'items', 'one.md'), 'utf8')
  assert.match(file, /Scope\.\n\nWaiting on review\./)
})

test('a body cannot be rewritten through set', async () => {
  const dir = await tracker()
  await cli('new', 'one', '--title', 'One', '--body', 'Scope.', '--dir', dir)
  const r = await cli('set', 'one', '--body', 'Replaced.', '--dir', dir)
  assert.equal(r.code, 2)
  assert.match(r.stderr, /never rewritten/)
})

test('an invalid value exits 1 and leaves the file alone', async () => {
  const dir = await tracker()
  await cli('new', 'one', '--title', 'One', '--body', 'Scope.', '--dir', dir)
  const before = readFileSync(join(dir, 'items', 'one.md'), 'utf8')
  const r = await cli('set', 'one', '--status', 'shipping', '--dir', dir)
  assert.equal(r.code, 1)
  assert.equal(readFileSync(join(dir, 'items', 'one.md'), 'utf8'), before)
})

test('new, set and delete need a task slug', async () => {
  const dir = await tracker()
  assert.equal((await cli('new', '--dir', dir)).code, 2)
  assert.match((await cli('set', '--dir', dir)).stderr, /needs a task slug/)
  assert.match((await cli('delete', 'one', 'two', '--dir', dir)).stderr, /unexpected argument/)
})

test('set with nothing to set says so', async () => {
  const dir = await tracker()
  await cli('new', 'one', '--title', 'One', '--body', 'Scope.', '--dir', dir)
  assert.match((await cli('set', 'one', '--dir', dir)).stderr, /name at least one property/)
})

test('delete moves the task file and regenerates the view', async () => {
  const dir = await tracker()
  await cli('new', 'one', '--title', 'One', '--body', 'Scope.', '--dir', dir)
  const r = await cli('delete', 'one', '--dir', dir)
  assert.equal(r.code, 0)
  assert.match(r.stdout, /Moved items\/one\.md to deleted\/one\.md/)
  assert.ok(existsSync(join(dir, 'deleted', 'one.md')))
  assert.ok(!existsSync(join(dir, 'items', 'one.md')))
  assert.equal((await cli('build', '--dir', dir, '--check')).code, 0)
})

test('the CLI sets every property, and a territory list is one flag', async () => {
  const dir = await tracker()
  await cli('new', 'one', '--title', 'One', '--body', 'Scope.', '--dir', dir)
  const r = await cli('set', 'one', '--status', 'in-review', '--territory', 'web,api', '--dir', dir)
  assert.equal(r.code, 0)
  const file = readFileSync(join(dir, 'items', 'one.md'), 'utf8')
  assert.match(file, /status: in-review/)
  assert.match(file, /territory: api, web\n/)
  assert.match(readFileSync(join(dir, 'INDEX.md'), 'utf8'), /· t:api,web - One/)
})

const RUN_BODY = 'Regenerate after the schema change.\n\n```sh run\npnpm generate\n```\n'

/** A tracker with tasks across sections, priorities and territories, one carrying a run block. */
async function populated(): Promise<string> {
  const dir = await tracker()
  await cli('new', 'triage-me', '--title', 'Triage me', '--body', 'Scope.', '--dir', dir)
  await cli('new', 'ship-it', '--title', 'Ship it', '--status', 'todo', '--priority', 'low', '--territory', 'web', '--body', 'Scope.', '--dir', dir)
  await cli('new', 'fix-it', '--title', 'Fix it', '--status', 'todo', '--priority', 'urgent', '--territory', 'api,web', '--body', 'Scope.', '--dir', dir)
  await cli('new', 'doing-it', '--title', 'Doing it', '--status', 'in-progress', '--territory', 'api', '--body', 'Scope.', '--dir', dir)
  await withStdin(RUN_BODY, 'new', 'regen', '--title', 'Regenerate', '--status', 'todo', '--territory', 'ontology', '--dir', dir)
  return dir
}

test('list --json is every task, frontmatter only, in pick-up order', async () => {
  const dir = await populated()
  const r = await cli('list', '--json', '--dir', dir)
  assert.equal(r.code, 0)
  const tasks = JSON.parse(r.stdout) as Record<string, unknown>[]
  assert.deepEqual(
    tasks.map((t) => t['slug']),
    ['doing-it', 'fix-it', 'ship-it', 'regen', 'triage-me']
  )
  assert.deepEqual(Object.keys(tasks[1]!), [
    'slug', 'title', 'status', 'priority', 'territory', 'created_at', 'modified_at'
  ])
  assert.deepEqual(tasks[1]!['territory'], ['api', 'web'])
  assert.deepEqual(tasks[4]!['territory'], [])
  assert.match(String(tasks[0]!['modified_at']), /^\d{4}-\d{2}-\d{2}$/)
})

test('list follows the same order INDEX.md does', async () => {
  const dir = await populated()
  const listed = (JSON.parse((await cli('list', '--json', '--dir', dir)).stdout) as { slug: string }[]).map((t) => t.slug)
  const indexed = [...readFileSync(join(dir, 'INDEX.md'), 'utf8').matchAll(/^- \[([^\]]+)\]\(items\//gm)].map((m) => m[1])
  assert.deepEqual(listed, indexed)
})

test('list without --json is a plain table', async () => {
  const dir = await populated()
  const r = await cli('list', '--dir', dir)
  assert.equal(r.code, 0)
  const lines = r.stdout.trimEnd().split('\n')
  assert.match(lines[0]!, /^slug\s+status\s+priority\s+territory\s+modified\s+title$/)
  assert.equal(lines.length, 6)
  assert.match(lines[1]!, /^doing-it\s+in-progress\s+-\s+api\s+\d{4}-\d{2}-\d{2}\s+Doing it$/)
  assert.match(lines[2]!, /^fix-it\s+todo\s+urgent\s+api,web\s+/)
})

test('list filters by --status and --territory, together or apart', async () => {
  const dir = await populated()
  const slugs = async (...args: string[]) =>
    (JSON.parse((await cli('list', '--json', '--dir', dir, ...args)).stdout) as { slug: string }[]).map((t) => t.slug)
  assert.deepEqual(await slugs('--status', 'todo'), ['fix-it', 'ship-it', 'regen'])
  assert.deepEqual(await slugs('--territory', 'web'), ['fix-it', 'ship-it'])
  assert.deepEqual(await slugs('--territory', 'api'), ['doing-it', 'fix-it'])
  assert.deepEqual(await slugs('--status', 'todo', '--territory', 'api'), ['fix-it'])
  assert.deepEqual(await slugs('--status', 'canceled'), [])
})

test('list refuses a filter that is not one', async () => {
  const dir = await populated()
  const bad = await cli('list', '--status', 'shipping', '--dir', dir)
  assert.equal(bad.code, 2)
  assert.match(bad.stderr, /status "shipping" not in/)
  const wrong = await cli('list', '--priority', 'high', '--dir', dir)
  assert.equal(wrong.code, 2)
  assert.match(wrong.stderr, /not --priority/)
})

test('show prints the file as it is, or its fields and body as JSON', async () => {
  const dir = await populated()
  const raw = await cli('show', 'fix-it', '--dir', dir)
  assert.equal(raw.code, 0)
  assert.equal(raw.stdout, readFileSync(join(dir, 'items', 'fix-it.md'), 'utf8'))

  const r = await cli('show', 'fix-it', '--json', '--dir', dir)
  assert.equal(r.code, 0)
  const task = JSON.parse(r.stdout) as Record<string, unknown>
  assert.deepEqual(Object.keys(task), [
    'slug', 'title', 'status', 'priority', 'territory', 'created_at', 'modified_at', 'body'
  ])
  assert.equal(task['slug'], 'fix-it')
  assert.deepEqual(task['territory'], ['api', 'web'])
  assert.equal(task['body'], 'Scope.')
  assert.ok(!('run' in task))
})

test('show --json carries the sh run block when the body has one', async () => {
  const dir = await populated()
  const task = JSON.parse((await cli('show', 'regen', '--json', '--dir', dir)).stdout) as Record<string, unknown>
  assert.equal(task['run'], 'pnpm generate')
  assert.equal(task['body'], RUN_BODY.trim())
})

test('list and show exit 2 for a missing slug or a directory that is not a tracker', async () => {
  const dir = await populated()
  const missing = await cli('show', 'nowhere', '--dir', dir)
  assert.equal(missing.code, 2)
  assert.match(missing.stderr, /no task "nowhere"/)
  assert.equal((await cli('show', '--dir', dir)).code, 2)
  assert.equal((await cli('list', '--dir', temp())).code, 2)
  assert.equal((await cli('show', 'x', '--dir', temp())).code, 2)
})

test('list and show exit 1 when a task file is invalid', async () => {
  const dir = await populated()
  writeFileSync(join(dir, 'items', 'broken.md'), task({ status: 'nope' }))
  const listed = await cli('list', '--json', '--dir', dir)
  assert.equal(listed.code, 1)
  assert.match(listed.stderr, /items\/broken\.md/)
  assert.equal((await cli('show', 'fix-it', '--dir', dir)).code, 1)
})

test('the tracker is discovered from the environment when --dir is not given', async () => {
  const project = temp()
  const dir = join(project, 'tasks')
  await cli('init', '--dir', dir)
  await cli('new', 'one', '--title', 'One', '--body', 'Scope.', '--dir', dir)

  const viaDir = await invoke({ args: ['list', '--json'], env: { HEAI_DIR: project }, cwd: tmpdir() })
  assert.equal(viaDir.code, 0, viaDir.stderr)
  assert.equal((JSON.parse(viaDir.stdout) as unknown[]).length, 1)

  const viaTasks = await invoke({ args: ['list', '--json'], env: { HEAI_DIR: '/nowhere', HEAI_TASKS: dir }, cwd: tmpdir() })
  assert.equal(viaTasks.code, 0, viaTasks.stderr)

  const convention = temp()
  mkdirSync(join(convention, '.heai'))
  await cli('init', '--dir', join(convention, '.heai', 'tasks'))
  const viaConvention = await invoke({ args: ['build', '--check'], env: { HEAI_DIR: '', HEAI_TASKS: '' }, cwd: convention })
  assert.equal(viaConvention.code, 0, viaConvention.stderr)

  const bare = await invoke({ args: ['list'], env: { HEAI_DIR: '', HEAI_TASKS: '' }, cwd: temp() })
  assert.equal(bare.code, 2)
  assert.match(bare.stderr, /has no items\//)
})

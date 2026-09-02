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
  try {
    const child = run(process.execPath, [CLI, ...args])
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

const temp = (): string => mkdtempSync(join(tmpdir(), 'task-manager-cli-'))

test('--help explains itself and exits 0', async () => {
  const r = await cli('--help')
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes('task-manager init'))
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
  for (const f of ['items', 'config.yaml', 'README.md', 'INDEX.md']) {
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
  const config = readFileSync(join(dir, 'config.yaml'), 'utf8')
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
  assert.ok(!existsSync(join(dir, 'config.yaml')))
})

test('a bad configuration exits 2, not 1', async () => {
  const dir = join(temp(), 'tasks')
  mkdirSync(join(dir, 'items'), { recursive: true })
  writeFileSync(join(dir, 'config.yaml'), 'map: ./nowhere.yaml\n')
  const r = await cli('build', '--dir', dir)
  assert.equal(r.code, 2)
  assert.ok(r.stderr.includes('cannot read architecture map'))
})

test('serve refuses a port that is not one', async () => {
  const dir = join(temp(), 'tasks')
  await cli('init', '--dir', dir)
  const r = await cli('serve', '--dir', dir, '--port', 'http')
  assert.equal(r.code, 2)
  assert.ok(r.stderr.includes('--port'))
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

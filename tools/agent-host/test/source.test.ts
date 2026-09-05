import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHost, UsageError } from '../src/host.ts'
import { BUILT_IN_SOURCES, loadSource } from '../src/source.ts'
import { FakeContainers, makeRepo } from './helpers.ts'

test('the built-in sources are git and plain, and an unknown one is a usage error naming them', async () => {
  assert.deepEqual(BUILT_IN_SOURCES, ['git', 'plain'])
  const opts = { repoRoot: '/r', checkoutsDir: '/c', base: 'main', stateDir: '/s' }
  assert.equal((await loadSource('git', opts, '/')).name, 'git')
  await assert.rejects(loadSource('svn', opts, '/'), (e: UsageError) => e instanceof UsageError && /git, plain/.test(e.message))
})

test('the plain source: a copy per actor, no git, changed paths by content, an outbox of what changed', async () => {
  const repo = makeRepo('image: heai/agent-echo\nsource: plain\n')
  repo.task('t1', { title: 'One', territory: 'alpha' })
  const containers = new FakeContainers()
  const host = await createHost({ mapPath: repo.map, tasksDir: repo.tasks, stateDir: repo.state, configPath: repo.config, containers })
  assert.equal(host.source.name, 'plain')
  const { checkout } = await host.up('alpha')
  assert.ok(existsSync(join(checkout, 'alpha', 'README.md')))
  assert.ok(!existsSync(join(checkout, '.git')), 'no repository inside the copy')
  assert.ok(!existsSync(join(checkout, '.heai', 'agent-host')), 'the state directory is not copied into itself')
  assert.deepEqual(Object.keys(containers.containers.get('heai-alpha')!.spec.env), ['HEAI_ACTOR'])

  const { run } = await host.assign('alpha', { task: 't1' })
  assert.equal(run.ref, 'alpha/t1')
  const prompt = readFileSync(join(host.state.runsDir, `${run.id}.prompt`), 'utf8')
  assert.match(prompt, /there is no version control here/)
  assert.doesNotMatch(prompt, /branch/)

  // The "agent" edits one file and adds another, in its territory, and one outside it.
  writeFileSync(join(checkout, 'alpha', 'README.md'), 'alpha, edited\n')
  writeFileSync(join(checkout, 'alpha', 'new.md'), 'new\n')
  writeFileSync(join(checkout, 'beta', 'stray.md'), 'oops\n')
  containers.finish('heai-alpha', run.id, 0)
  await host.settle()
  const done = host.run(run.id)!
  assert.equal(done.status, 'succeeded')
  assert.deepEqual(done.changed, ['alpha/README.md', 'alpha/new.md', 'beta/stray.md'])
  assert.equal(done.gate!.verdict, 'violation')
  assert.equal(readFileSync(join(repo.state, 'outbox', run.id, 'alpha', 'new.md'), 'utf8'), 'new\n')
  // The repository itself was not touched.
  assert.equal(readFileSync(join(repo.root, 'alpha', 'README.md'), 'utf8'), 'alpha\n')
})

test('a custom source module is loaded from a path relative to the configuration', async () => {
  const repo = makeRepo('image: heai/agent-echo\nsource: ./my-source.ts\n')
  writeFileSync(
    join(repo.root, '.heai', 'my-source.ts'),
    `import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
export function createSource(options) {
  const calls = []
  return {
    name: 'stub',
    calls,
    refFor: (actor, slug) => 'ws-' + actor + '-' + slug,
    async prepare(actor) { const checkout = join(options.checkoutsDir, actor); mkdirSync(checkout, { recursive: true }); calls.push('prepare'); return { checkout, created: true } },
    env: (actor) => ({ WHO: actor }),
    rules: () => ['Stub rule.'],
    async begin(run) { calls.push('begin ' + run.ref); return null },
    async finish(run) { calls.push('finish ' + run.ref); return { changed: ['alpha/x'], dirty: [], problem: 'nowhere to bring it' } }
  }
}
`
  )
  const containers = new FakeContainers()
  const host = await createHost({ mapPath: repo.map, tasksDir: repo.tasks, stateDir: repo.state, configPath: repo.config, containers })
  assert.equal(host.source.name, 'stub')
  await host.up('alpha')
  assert.equal(containers.containers.get('heai-alpha')!.spec.env['WHO'], 'alpha')
  const { run } = await host.assign('alpha', { prompt: 'go' })
  assert.equal(run.ref, `ws-alpha-${run.id}`)
  assert.match(readFileSync(join(host.state.runsDir, `${run.id}.prompt`), 'utf8'), /- Stub rule\./)
  containers.finish('heai-alpha', run.id, 0)
  const notes = await host.settle()
  assert.match(notes.join('\n'), /nowhere to bring it/)
  assert.deepEqual(host.run(run.id)!.changed, ['alpha/x'])
  assert.equal(host.run(run.id)!.gate!.verdict, 'clean')
  assert.deepEqual((host.source as unknown as { calls: string[] }).calls, ['prepare', `begin ${run.ref}`, `finish ${run.ref}`])

  const bad = makeRepo('source: ./missing.ts\n')
  await assert.rejects(createHost({ mapPath: bad.map, tasksDir: bad.tasks, stateDir: bad.state, configPath: bad.config, containers }), UsageError)
})

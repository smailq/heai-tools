import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHost, HostError, MAX_CHAIN_DEPTH, UsageError, type Host } from '../src/host.ts'
import { writeRequested } from '../src/runs.ts'
import { commitIn, FakeContainers, makeRepo, type Repo } from './helpers.ts'

async function boot(configYaml?: string): Promise<{ repo: Repo; containers: FakeContainers; host: Host }> {
  const repo = makeRepo(configYaml)
  const containers = new FakeContainers()
  const host = await createHost({ mapPath: repo.map, tasksDir: repo.tasks, stateDir: repo.state, configPath: repo.config, containers })
  return { repo, containers, host }
}

test('up clones the repository per actor, starts a labelled container with the two mounts, and is idempotent', async () => {
  const { repo, containers, host } = await boot()
  const r = await host.up('alpha')
  assert.ok(r.created)
  assert.ok(existsSync(join(r.checkout, '.git')))
  const c = containers.containers.get('heai-alpha')!
  assert.equal(c.labels['heai.actor'], 'alpha')
  assert.equal(c.labels['heai.map'], host.map.hash)
  assert.equal(c.spec.mounts[r.checkout], '/work')
  assert.equal(c.spec.mounts[host.state.runsDir], '/heai/runs')
  assert.equal(c.spec.env['HEAI_ACTOR'], 'alpha')
  assert.equal(c.spec.env['GIT_AUTHOR_NAME'], 'alpha')
  assert.deepEqual(c.spec.command, ['sleep', 'infinity'])
  assert.equal(c.spec.image, 'heai/agent-echo')
  assert.deepEqual(await host.up('alpha'), { created: false, started: false, checkout: r.checkout })
  // A stopped container is started again rather than recreated.
  await containers.stop('heai-alpha')
  assert.equal((await host.up('alpha')).started, true)
  assert.ok(existsSync(join(repo.state, '.gitignore')))
})

test('only an llm-agent the map declares can be hosted', async () => {
  const { host } = await boot()
  await assert.rejects(host.up('nobody'), (e: HostError) => e.code === 'not-found')
  await assert.rejects(host.up('smailq'), (e: HostError) => e.code === 'usage')
})

test('resources belong to the image: two actors on one image are sized once, and an actor only picks an image', async () => {
  const { host, containers } = await boot(
    'image: heai/x\nbase: main\nimages:\n  heai/x:\n    cpus: 2\n    memory: 4G\n  heai/y:\n    cpus: 8\nactors:\n  beta:\n    image: heai/y\n'
  )
  await host.up('alpha')
  await host.up('beta')
  const alpha = containers.containers.get('heai-alpha')!.spec
  const beta = containers.containers.get('heai-beta')!.spec
  assert.deepEqual([alpha.image, alpha.cpus, alpha.memory], ['heai/x', 2, '4G'])
  assert.deepEqual([beta.image, beta.cpus, beta.memory], ['heai/y', 8, undefined])
  const { host: h2 } = await boot('envFile: /nowhere/env\n')
  await assert.rejects(h2.up('alpha'), UsageError)
})

test('resources on an actor are refused, pointing at images', async () => {
  const repo = makeRepo('actors:\n  beta:\n    cpus: 2\n')
  await assert.rejects(
    createHost({ mapPath: repo.map, tasksDir: repo.tasks, stateDir: repo.state, configPath: repo.config, containers: new FakeContainers() }),
    (e: UsageError) => e instanceof UsageError && /belongs to an image/.test(e.message)
  )
})

test('configuration that names an unknown actor is refused', async () => {
  const repo = makeRepo('actors:\n  ghost: {}\n')
  await assert.rejects(createHost({ mapPath: repo.map, tasksDir: repo.tasks, stateDir: repo.state, configPath: repo.config, containers: new FakeContainers() }), UsageError)
})

test('assign refuses an actor that is not up, and a task that is not there', async () => {
  const { repo, host } = await boot()
  repo.task('t1', { title: 'Task one', territory: 'alpha' })
  await assert.rejects(host.assign('alpha', { task: 't1' }), (e: HostError) => e.code === 'conflict')
  await host.up('alpha')
  await assert.rejects(host.assign('alpha', { task: 'nope' }), (e: HostError) => e.code === 'not-found')
  await assert.rejects(host.assign('alpha', {}), (e: HostError) => e.code === 'usage')
})

test('a run: branch prepared, prompt written, exec detached; settle finalizes it with a gate verdict and brings the branch home', async () => {
  const { repo, containers, host } = await boot()
  repo.task('t1', { title: 'Task one', territory: 'alpha', priority: 'high' })
  await host.up('alpha')
  const { run, queued, warnings } = await host.assign('alpha', { task: 't1' })
  assert.equal(queued, false)
  assert.deepEqual(warnings, [])
  assert.equal(run.status, 'running')
  assert.equal(run.ref, 'agent/alpha/t1')
  const exec = containers.lastRun('heai-alpha')
  assert.equal(exec.env['HEAI_RUN'], run.id)
  assert.equal(exec.env['HEAI_TASK'], 't1')
  assert.match(exec.script, new RegExp(`r=/heai/runs/${run.id}; /heai/run < \\$r\\.prompt >> \\$r\\.log 2>&1 & echo \\$! > \\$r\\.pid; wait \\$!; echo \\$\\? > \\$r\\.exit`))
  const prompt = readFileSync(join(host.state.runsDir, `${run.id}.prompt`), 'utf8')
  assert.match(prompt, /# You are `alpha`/)
  assert.match(prompt, /# The task: t1/)
  const checkout = containers.checkoutOf('heai-alpha')
  assert.equal(repo.git('-C', checkout, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'agent/alpha/t1')

  // Nothing has happened yet: settle leaves it running.
  assert.deepEqual(await host.settle(), [])
  assert.equal(host.run(run.id)!.status, 'running')
  assert.equal((await host.status()).find((a) => a.name === 'alpha')!.current!.id, run.id)

  // The agent commits inside its territory and the run ends cleanly.
  commitIn(checkout, 'alpha/notes.md', 'hi\n')
  containers.finish('heai-alpha', run.id, 0, 'did the thing\n')
  const notes = await host.settle()
  assert.match(notes.join('\n'), new RegExp(`Run ${run.id} succeeded: exit 0, gate clean, 1 file changed`))
  const done = host.run(run.id)!
  assert.equal(done.status, 'succeeded')
  assert.equal(done.exitCode, 0)
  assert.equal(done.gate!.verdict, 'clean')
  assert.deepEqual(done.changed, ['alpha/notes.md'])
  assert.deepEqual(done.dirty, [])
  // The branch is in the repository for review, and main is untouched.
  assert.equal(repo.git('rev-parse', '--verify', 'agent/alpha/t1').trim().length, 40)
  assert.notEqual(repo.git('rev-parse', 'agent/alpha/t1'), repo.git('rev-parse', 'main'))
  assert.equal(repo.taskStatus('t1'), 'todo', 'the host never judges task state')
  // Settling again changes nothing.
  assert.deepEqual(await host.settle(), [])
})

test('a change outside the territory is a violation, recorded, not a failure', async () => {
  const { repo, containers, host } = await boot()
  repo.task('t1', { title: 'Task one', territory: 'alpha' })
  await host.up('alpha')
  const { run } = await host.assign('alpha', { task: 't1' })
  const checkout = containers.checkoutOf('heai-alpha')
  commitIn(checkout, 'beta/stray.md', 'oops\n')
  writeFileSync(join(checkout, 'alpha', 'uncommitted.md'), 'left behind\n')
  containers.finish('heai-alpha', run.id, 0)
  await host.settle()
  const done = host.run(run.id)!
  assert.equal(done.status, 'succeeded')
  assert.equal(done.gate!.verdict, 'violation')
  assert.equal(done.gate!.violations, 1)
  assert.deepEqual(done.dirty, ['alpha/uncommitted.md'])
})

test('a non-zero exit is a failed run; a vanished container is a lost one', async () => {
  const { repo, containers, host } = await boot()
  repo.task('t1', { title: 'One', territory: 'alpha' })
  repo.task('t2', { title: 'Two', territory: 'beta' })
  await host.up('alpha')
  await host.up('beta')
  const a = (await host.assign('alpha', { task: 't1' })).run
  const b = (await host.assign('beta', { task: 't2' })).run
  containers.finish('heai-alpha', a.id, 2, 'boom\n')
  containers.containers.delete('heai-beta')
  await host.settle()
  assert.equal(host.run(a.id)!.status, 'failed')
  assert.equal(host.run(a.id)!.exitCode, 2)
  assert.equal(host.run(b.id)!.status, 'lost')
})

test('one run at a time per actor: the second queues, and starts when the first ends', async () => {
  const { repo, containers, host } = await boot()
  repo.task('t1', { title: 'One', territory: 'alpha' })
  repo.task('t2', { title: 'Two', territory: 'alpha' })
  await host.up('alpha')
  const first = (await host.assign('alpha', { task: 't1' })).run
  const second = await host.assign('alpha', { task: 't2' })
  assert.equal(second.queued, true)
  assert.equal(second.run.status, 'queued')
  assert.equal((await host.status())[0]!.queued, 1)
  // The same task cannot be assigned twice while it is in flight.
  await assert.rejects(host.assign('alpha', { task: 't2' }), (e: HostError) => e.code === 'conflict')
  containers.finish('heai-alpha', first.id, 0)
  const notes = await host.settle()
  assert.match(notes.join('\n'), new RegExp(`Started ${second.run.id} on alpha`))
  assert.equal(host.run(second.run.id)!.status, 'running')
  assert.equal(containers.lastRun('heai-alpha').env['HEAI_RUN'], second.run.id)
})

test('a queued free-form run keeps its prompt until it starts', async () => {
  const { containers, host } = await boot()
  await host.up('beta')
  const first = (await host.assign('beta', { prompt: 'First.' })).run
  const second = (await host.assign('beta', { prompt: 'Second thing to do.' })).run
  assert.equal(second.title, 'Second thing to do.')
  containers.finish('heai-beta', first.id, 0)
  await host.settle()
  assert.match(readFileSync(join(host.state.runsDir, `${second.id}.prompt`), 'utf8'), /# The task\n\nSecond thing to do\./)
})

test('cancel: a queued run is dropped, a running one is signalled and settles as canceled', async () => {
  const { repo, containers, host } = await boot()
  repo.task('t1', { title: 'One', territory: 'alpha' })
  await host.up('alpha')
  const running = (await host.assign('alpha', { task: 't1' })).run
  const waiting = (await host.assign('alpha', { prompt: 'later' })).run
  assert.equal((await host.cancel(waiting.id)).status, 'canceled')
  assert.equal((await host.status())[0]!.queued, 0)
  await host.cancel(running.id)
  assert.deepEqual(containers.killed, [4242])
  // The wrapper's `wait` records the signal as the exit.
  containers.finish('heai-alpha', running.id, 143)
  await host.settle()
  assert.equal(host.run(running.id)!.status, 'canceled')
  await assert.rejects(host.cancel(running.id), (e: HostError) => e.code === 'conflict')
})

test('down refuses while a run is on, and force cancels it first', async () => {
  const { repo, containers, host } = await boot()
  repo.task('t1', { title: 'One', territory: 'alpha' })
  await host.up('alpha')
  const run = (await host.assign('alpha', { task: 't1' })).run
  await assert.rejects(host.down('alpha'), (e: HostError) => e.code === 'conflict')
  // Force: the run is signalled; play the wrapper writing the exit while down waits.
  setTimeout(() => containers.finish('heai-alpha', run.id, 143), 50)
  await host.down('alpha', { force: true })
  assert.equal(containers.containers.has('heai-alpha'), false)
  assert.equal(host.run(run.id)!.status, 'canceled')
  await assert.rejects(host.down('alpha'), (e: HostError) => e.code === 'not-found')
})

test('working together: a request becomes a task, the requester is blocked, and lands back as todo when the blocker is done', async () => {
  const { repo, containers, host } = await boot()
  repo.task('t2', { title: 'Beta needs alpha', territory: 'beta', priority: 'high' })
  await host.up('beta')
  const run = (await host.assign('beta', { task: 't2' })).run
  const checkout = containers.checkoutOf('heai-beta')
  commitIn(checkout, 'beta/partial.md', 'so far\n')
  containers.request('heai-beta', run.id, 'help', 'Alpha, please add a hook', 'alpha', 'Needed for t2.\n\nDone when: hook exists.\n')
  containers.finish('heai-beta', run.id, 0, 'Committed what I could.\nBlocked: need alpha.\n')
  const notes = await host.settle()
  assert.match(notes.join('\n'), /Filed alpha-please-add-a-hook \(alpha → alpha\), requested by run/)
  assert.match(notes.join('\n'), /Blocked t2 on alpha-please-add-a-hook/)
  const done = host.run(run.id)!
  assert.equal(done.status, 'blocked')
  assert.deepEqual(done.requests, [{ title: 'Alpha, please add a hook', territory: 'alpha', task: 'alpha-please-add-a-hook' }])

  // The tracker now holds the request, at the requester's priority, with provenance; the requester is blocked.
  const filed = readFileSync(join(repo.tasks, 'items', 'alpha-please-add-a-hook.md'), 'utf8')
  assert.match(filed, /^status: todo$/m)
  assert.match(filed, /^priority: high$/m)
  assert.match(filed, /^territory: alpha$/m)
  assert.match(filed, /Requested by `beta` in run `.*`, for \[t2\]\(t2\.md\)\./)
  assert.equal(repo.taskStatus('t2'), 'blocked')
  const t2 = readFileSync(join(repo.tasks, 'items', 't2.md'), 'utf8')
  assert.match(t2, /Blocked by \[alpha-please-add-a-hook\]\(alpha-please-add-a-hook\.md\)/)

  // The request routes to alpha and shows as such; t2 waits on it.
  const tasks = host.tasks()
  assert.deepEqual(tasks.find((t) => t.slug === 'alpha-please-add-a-hook')!.routedTo, ['alpha'])
  assert.deepEqual(tasks.find((t) => t.slug === 't2')!.waitsOn, [{ slug: 'alpha-please-add-a-hook', status: 'todo' }])

  // Nothing moves until the blocker lands.
  assert.deepEqual(await host.settle(), [])
  repo.setTask('alpha-please-add-a-hook', '--status', 'done')
  const after = await host.settle()
  assert.match(after.join('\n'), /Unblocked t2: alpha-please-add-a-hook done/)
  assert.equal(repo.taskStatus('t2'), 'todo')
  assert.match(readFileSync(join(repo.tasks, 'items', 't2.md'), 'utf8'), /Unblocked: \[alpha-please-add-a-hook\]/)
  // Under manual dispatch it is ready to resume, not resumed.
  const beta = (await host.status()).find((a) => a.name === 'beta')!
  assert.deepEqual(beta.resumable, ['t2'])
  assert.equal(beta.current, null)

  // Resuming reuses the branch and tells the agent what happened.
  const resumed = (await host.assign('beta', { task: 't2' })).run
  assert.equal(resumed.resumes, run.id)
  assert.equal(resumed.ref, 'agent/beta/t2')
  const prompt = readFileSync(join(host.state.runsDir, `${resumed.id}.prompt`), 'utf8')
  assert.match(prompt, /# Resuming/)
  assert.match(prompt, /Blocked: need alpha\./)
  assert.equal(readFileSync(join(checkout, 'beta', 'partial.md'), 'utf8'), 'so far\n')
})

test('a request the map cannot route is rejected and fails the run', async () => {
  const { repo, containers, host } = await boot()
  repo.task('t2', { title: 'T2', territory: 'beta' })
  await host.up('beta')
  const run = (await host.assign('beta', { task: 't2' })).run
  containers.request('heai-beta', run.id, 'bad', 'Nowhere', 'nowhere')
  containers.finish('heai-beta', run.id, 0)
  await host.settle()
  const done = host.run(run.id)!
  assert.equal(done.status, 'failed')
  assert.match(done.error!, /the map declares no territory "nowhere"/)
  assert.equal(repo.taskStatus('t2'), 'todo')
})

test('dispatch auto: idle actors take routed todo tasks, resume unblocked ones, and stop at the chain limit', async () => {
  const { repo, containers, host } = await boot('image: heai/agent-echo\nbase: main\ndispatch: auto\n')
  repo.task('a1', { title: 'A1', territory: 'alpha' })
  repo.task('shared', { title: 'Crosses', territory: 'alpha, beta' })
  repo.task('deep', { title: 'Deep', territory: 'beta' })
  writeRequested(host.state, { slug: 'deep', requestedBy: 'x', run: 'r', depth: MAX_CHAIN_DEPTH + 1 })
  await host.up('alpha')
  await host.up('beta')
  const notes = await host.settle()
  assert.match(notes.join('\n'), /Auto-assigned a1 to alpha/)
  assert.match(notes.join('\n'), /Not assigning deep: it sits 4 requests deep/)
  assert.doesNotMatch(notes.join('\n'), /shared/)
  const alpha = host.runs('alpha')[0]!
  assert.equal(alpha.task, 'a1')
  assert.equal(alpha.status, 'running')
  assert.equal(host.runs('beta').length, 0)

  // alpha finishes blocked on beta; beta's request is auto-assigned; when done, a1 resumes on its own.
  containers.request('heai-alpha', alpha.id, 'q', 'Beta, do a thing', 'beta')
  containers.finish('heai-alpha', alpha.id, 0)
  const n2 = await host.settle()
  assert.match(n2.join('\n'), /Auto-assigned beta-do-a-thing to beta/)
  const betaRun = host.runs('beta')[0]!
  commitIn(containers.checkoutOf('heai-beta'), 'beta/thing.md', 'done\n')
  containers.finish('heai-beta', betaRun.id, 0)
  await host.settle()
  assert.equal(host.run(betaRun.id)!.status, 'succeeded')
  repo.setTask('beta-do-a-thing', '--status', 'done')
  const n3 = await host.settle()
  assert.match(n3.join('\n'), /Unblocked a1/)
  assert.match(n3.join('\n'), /Queued a1 to resume on alpha/)
  assert.match(n3.join('\n'), /Started .* on alpha/)
  const resumed = host.runs('alpha')[0]!
  assert.equal(resumed.task, 'a1')
  assert.equal(resumed.resumes, alpha.id)
})

test('build-image resolves shipped images and refuses unknown ones', async () => {
  const { containers, host } = await boot()
  assert.equal(await host.buildImage('echo'), 'heai/agent-echo')
  assert.deepEqual(containers.built, ['heai/agent-echo'])
  await assert.rejects(host.buildImage('nope'), UsageError)
})

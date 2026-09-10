import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flowDir } from '../src/core.ts'
import { resolvePaths } from '../src/cli.ts'
import { chain, cli, DEFS, FIXTURES, makeClock, makeWorld } from './helpers.ts'

test('the journal fixture is exactly what a flow writes: the format contract other tools read', () => {
  const w = makeWorld(makeClock('2026-09-04T16:59:52.000Z'))
  const id = '20260904-165952-run-132f'
  w.store.start({ definition: 'run', id, links: { actor: 'beta', task: 't2' }, by: 'session.sh' })
  w.clock.tick(2000)
  w.store.advance(id, { event: 'started', data: {}, by: 'session.sh' })
  w.clock.tick(2000)
  w.store.link(id, { links: { branch: 'agent/beta/t2' } }, 'session.sh')
  w.clock.tick(2000)
  w.store.advance(id, { event: 'exited', data: { exitCode: 0, requests: 1 }, by: 'session.sh', note: 'filed help-requested-by-beta' })
  assert.equal(readFileSync(join(flowDir(w.root, id), 'journal.jsonl'), 'utf8'), readFileSync(join(FIXTURES, 'journal.jsonl'), 'utf8'))
  const snap = JSON.parse(readFileSync(join(flowDir(w.root, id), 'state.json'), 'utf8'))
  assert.deepEqual(Object.keys(snap), ['id', 'definition', 'state', 'terminal', 'since', 'startedAt', 'seq', 'links', 'parent', 'waitsOn', 'touchedAt', 'expiresAt'])
})

test('exit codes: 0 done, 1 answered no, 2 could not be asked', () => {
  const w = makeWorld()
  assert.equal(cli(w).code, 2, 'no command')
  assert.equal(cli(w, '--help').code, 0)
  assert.equal(cli(w, 'start', 'nope').code, 2, 'unknown definition')
  assert.match(cli(w, 'start', 'nope').stderr, /no definition nope in .*flows; found: landing, request, run/)
  assert.equal(cli(w, 'start', 'run').code, 2, 'a required link is missing')

  const started = cli(w, 'start', 'run', '--link', 'actor=alpha', '--link', 'task=t1', '--by', 'session.sh')
  assert.equal(started.code, 0)
  const id = started.stdout.trim()
  assert.match(id, /^\d{8}-\d{6}-run-[0-9a-f]{4}$/)

  const adv = cli(w, 'advance', id, 'started', '--by', 'session.sh')
  assert.equal(adv.code, 0)
  assert.equal(JSON.parse(adv.stdout).to, 'running', 'advance prints the line it wrote')
  assert.equal(cli(w, 'advance', id, 'started').code, 1, 'an illegal move')
  assert.equal(cli(w, 'advance', id, 'exited', '--seq', '0').code, 1, 'a lost race')
  assert.equal(cli(w, 'advance', id, 'exited', '--data', 'not json').code, 2)
  assert.equal(cli(w, 'advance', id, 'touch').code, 2)
  assert.equal(cli(w, 'advance', id, 'exited', '--by', 'flow').code, 2, 'a reserved writer')
  assert.equal(cli(w, 'show', 'nope').code, 2, 'an unknown flow')
  assert.equal(cli(w, 'touch', id).code, 0)
  assert.equal(cli(w, 'link', id, 'branch=agent/alpha/t1').code, 0)
  assert.equal(cli(w, 'link', id, 'branch=agent/alpha/t1').code, 0)
  assert.match(cli(w, 'link', id, 'branch=agent/alpha/t1').stdout, /Nothing to link/)
  assert.equal(cli(w, 'link', id, 'lane=core').code, 2)

  const req = cli(w, 'start', 'request', '--link', 'task=t2', '--parent', id, '--by', 'session.sh').stdout.trim()
  cli(w, 'advance', req, 'picked')
  cli(w, 'advance', req, 'finished')
  assert.equal(cli(w, 'advance', req, 'landed').code, 1, 'human may not land')
  assert.equal(cli(w, 'advance', req, 'landed', '--by', 'land.sh').code, 0)

  const show = cli(w, 'show', id)
  assert.equal(show.code, 0)
  assert.match(show.stdout, /state {7}running {2}since/)
  assert.match(show.stdout, /links {7}actor=alpha task=t1 branch=agent\/alpha\/t1/)
  assert.match(show.stdout, /queued → running/)
  const shown = JSON.parse(cli(w, 'show', id, '--json').stdout)
  assert.equal(shown.journal.length, 3)

  const list = cli(w, 'list', 'run', '--in', 'running')
  assert.match(list.stdout, new RegExp(`^${id} +run +running`))
  assert.equal(cli(w, 'list', 'run', '--in', 'queued').stdout.trim(), '(no flows)')
  assert.equal(JSON.parse(cli(w, 'list', '--link', 'task=t2', '--json').stdout).length, 1)

  assert.equal(cli(w, 'trace', `task=t1`).code, 0)
  assert.equal(cli(w, 'trace', 'task=zzz').code, 2)
  assert.equal(cli(w, 'stuck').code, 0)
  assert.match(cli(w, 'stuck').stdout, /Nothing stuck for 1h/)
  assert.equal(cli(w, 'stuck', '--older', 'soon').code, 2)
  assert.match(cli(w, 'settle').stdout, /Nothing to settle/)

  assert.equal(cli(w, 'check').code, 0)
  rmSync(join(flowDir(w.root, id), 'state.json'))
  const drift = cli(w, 'check')
  assert.equal(drift.code, 1)
  assert.match(drift.stdout, /state.json is missing/)
  const fixed = cli(w, 'check', '--fix')
  assert.equal(fixed.code, 0)
  assert.match(fixed.stdout, /Rebuilt 2 snapshots/)
  assert.equal(cli(w, 'reindex').code, 0)
})

test('definitions are the files in the flows directory, by the name each declares; --definition bypasses it', () => {
  const w = makeWorld()
  rmSync(join(w.dir, 'flows'), { recursive: true })
  assert.match(cli(w, 'definitions').stdout, /no definitions in /)
  const missing = cli(w, 'start', 'run', '--link', 'actor=a')
  assert.equal(missing.code, 2)
  assert.match(missing.stderr, /no definition run in .*flows\. Give a path with --definition/)
  assert.equal(cli(w, 'start', 'run', '--definition', join(DEFS, 'run.yaml'), '--link', 'actor=a').code, 0)

  // The directory comes from flow.yaml; a file is found by the name it declares, not its file name.
  mkdirSync(join(w.dir, 'defs'))
  writeFileSync(w.config, 'flows: ./defs\n')
  copyFileSync(join(DEFS, 'request.yaml'), join(w.dir, 'defs', 'req.yaml'))
  assert.match(cli(w, 'definitions').stdout, /^request +.*defs\/req\.yaml +todo in-progress in-review done canceled/m)
  assert.equal(cli(w, 'start', 'request', '--link', 'task=t').code, 0)

  // A file that does not validate is listed with its problem and refused by name; a second file with a taken name likewise.
  writeFileSync(join(w.dir, 'defs', 'bad.yaml'), 'name: bad\nstates: [a]\ninitial: a\ntransitions: []\n')
  copyFileSync(join(DEFS, 'request.yaml'), join(w.dir, 'defs', 'twin.yaml'))
  const listed = cli(w, 'definitions').stdout
  assert.match(listed, /^bad +.*bad\.yaml +PROBLEM [\s\S]*state a has no way out/m)
  assert.match(listed, /^request +.*twin\.yaml +PROBLEM names itself request, which .*req\.yaml already declares/m)
  const bad = cli(w, 'start', 'bad')
  assert.equal(bad.code, 2)
  assert.match(bad.stderr, /definition bad at .*bad\.yaml: [\s\S]*state a has no way out/)
  assert.equal(cli(w, 'start', 'request', '--link', 'task=t2').code, 0, 'the first file of that name still serves it')
})

test('the walkthrough, as trace prints it', () => {
  const w = makeWorld()
  const ids = chain(w)
  const out = cli(w, 'trace', 'task=t2').stdout
  const lines = out.trimEnd().split('\n')
  assert.equal(lines.length, 14)
  assert.match(lines[0]!, new RegExp(`^2026-09-04 16:59:52  ${ids.run1} +run +→ queued +session.sh +actor=beta task=t2$`))
  assert.match(lines.at(-1)!, new RegExp(`${ids.run1} +run +blocked → resumable +flow +\\(waits-on all done: ${ids.req}:done\\)$`))
})

test('a definition with hooks validates, and a start pins them with the rest of the text', () => {
  const w = makeWorld()
  const path = join(w.dir, 'flows', 'session.yaml')
  copyFileSync(join(DEFS, 'session.yaml'), path)
  const started = cli(w, 'start', 'session', '--link', 'actor=alpha', '--link', 'task=t1', '--link', 'repo=aw3', '--by', 'start.sh')
  assert.equal(started.code, 0)
  const id = started.stdout.trim()
  assert.equal(readFileSync(join(flowDir(w.root, id), 'definition.yaml'), 'utf8'), readFileSync(path, 'utf8'), 'the pinned copy is the file, byte for byte')
  const shown = JSON.parse(cli(w, 'show', id, '--json').stdout)
  assert.deepEqual(shown.hooks, {
    queued: { run: 'scripts/session/start.sh' },
    exited: { run: 'scripts/session/finish.sh' },
    resumable: { run: 'scripts/session/start.sh' },
    waiting: { run: 'scripts/session/ask.sh' },
    clean: { run: 'scripts/lanes/land.sh' },
    lost: { run: 'scripts/session/requeue.sh' }
  })
  assert.equal(cli(w, 'advance', id, 'canceled').code, 0, 'the from-list sugar made queued → canceled legal')
})

test('show --json and list --json carry what a script needs', () => {
  const w = makeWorld()
  const ids = chain(w)
  const shown = JSON.parse(cli(w, 'show', ids.run1, '--json').stdout)
  for (const k of ['id', 'definition', 'state', 'terminal', 'since', 'links', 'parent', 'waitsOn', 'hooks', 'journal']) assert.ok(k in shown, `show --json has ${k}`)
  assert.deepEqual([shown.id, shown.definition, shown.state, shown.terminal, shown.waitsOn, shown.hooks], [ids.run1, 'run', 'resumable', false, [ids.req], {}])
  assert.deepEqual(shown.links, { actor: 'beta', task: 't2' })
  const listed = JSON.parse(cli(w, 'list', 'request', '--json').stdout)
  assert.equal(listed.length, 1)
  for (const k of ['id', 'definition', 'state', 'terminal', 'since', 'links', 'parent', 'waitsOn']) assert.ok(k in listed[0], `list --json has ${k}`)
  assert.deepEqual([listed[0].id, listed[0].parent, listed[0].terminal], [ids.req, ids.run1, true])
})

test('reindex --repin rewrites every open flow from the definition on disk, and refuses to orphan a state', () => {
  const w = makeWorld()
  const edited = join(w.dir, 'flows', 'run.yaml')
  const ids = chain(w) // run1 resumable, run2 succeeded, req done, landing landed
  const open = cli(w, 'start', 'run', '--link', 'actor=gamma').stdout.trim()
  assert.match(cli(w, 'reindex').stdout, /^Rebuilt 5 snapshots/, 'plain reindex is unchanged')

  // The file gains hooks; only the two open flows follow it.
  const withHooks = readFileSync(edited, 'utf8') + 'hooks:\n  queued: { run: scripts/run/start.sh }\n'
  writeFileSync(edited, withHooks)
  const r = cli(w, 'reindex', '--repin')
  assert.equal(r.code, 0)
  assert.match(r.stdout, /^Repinned 2 of 2 open flows\nRebuilt 5 snapshots/)
  assert.equal(readFileSync(join(flowDir(w.root, ids.run1), 'definition.yaml'), 'utf8'), withHooks)
  assert.equal(readFileSync(join(flowDir(w.root, open), 'definition.yaml'), 'utf8'), withHooks)
  assert.doesNotMatch(readFileSync(join(flowDir(w.root, ids.run2), 'definition.yaml'), 'utf8'), /hooks:/, 'a terminal flow keeps its pinned copy')
  assert.deepEqual(JSON.parse(cli(w, 'show', open, '--json').stdout).hooks, { queued: { run: 'scripts/run/start.sh' } })
  assert.match(cli(w, 'reindex', '--repin').stdout, /^Repinned 0 of 2 open flows \(2 already current\)/)
  assert.equal(cli(w, 'check').code, 0)

  // A definition that drops the state a flow is in: refused, exit 1, nothing written.
  writeFileSync(edited, withHooks.replace('resumable, ', '').replace(/.*resumable.*\n/g, '').replace('{ from: blocked,   to: canceled,  on: canceled }', '{ from: blocked, to: canceled, on: canceled }\n  - { from: blocked, to: running, on: unblocked, requires: { waits-on: { all: [done] } } }'))
  assert.match(cli(w, 'definitions').stdout, /^run +.*run\.yaml +queued/m, 'the edited definition validates on its own')
  const refused = cli(w, 'reindex', '--repin')
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, new RegExp(`${ids.run1}: is resumable, which run at .* no longer has`))
  assert.equal(readFileSync(join(flowDir(w.root, open), 'definition.yaml'), 'utf8'), withHooks, 'nothing was written')

  // A definition file that is gone: exit 2.
  rmSync(edited)
  const gone = cli(w, 'reindex', '--repin')
  assert.equal(gone.code, 2)
  assert.match(gone.stderr, /definition run is not in /)
})

test('resolvePaths: the project directory, then .heai/ when it exists, then the flags and variables', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'flow-paths-'))
  const paths = (values: Record<string, string | undefined>, env: Record<string, string | undefined>) => resolvePaths(values, cwd, env)
  assert.deepEqual(paths({}, {}), { dir: cwd, state: join(cwd, 'flow'), config: join(cwd, 'flow.yaml') })
  mkdirSync(join(cwd, '.heai'))
  assert.deepEqual(paths({}, {}), { dir: cwd, state: join(cwd, '.heai', 'flow'), config: join(cwd, '.heai', 'flow.yaml') })
  assert.deepEqual(paths({}, { HEAI_DIR: '/p' }), { dir: '/p', state: '/p/flow', config: '/p/flow.yaml' })
  assert.deepEqual(paths({}, { HEAI_DIR: 'proj' }), { dir: join(cwd, 'proj'), state: join(cwd, 'proj', 'flow'), config: join(cwd, 'proj', 'flow.yaml') })
  assert.deepEqual(paths({ dir: '/d' }, { HEAI_DIR: '/p' }), { dir: '/d', state: '/d/flow', config: '/d/flow.yaml' }, 'the flag beats the variable')
  assert.deepEqual(paths({}, { HEAI_DIR: '/p', HEAI_FLOW_STATE: '/s' }), { dir: '/p', state: '/s', config: '/p/flow.yaml' })
  assert.deepEqual(paths({ config: 'conf/flow.yaml' }, { HEAI_DIR: '/p' }), { dir: '/p', state: '/p/conf/flow', config: '/p/conf/flow.yaml' }, 'the state follows the configuration')
  assert.deepEqual(paths({ state: '/f/state', config: '/f/flow.yaml' }, { HEAI_DIR: '/p', HEAI_FLOW_STATE: '/s' }), { dir: '/p', state: '/f/state', config: '/f/flow.yaml' })
})

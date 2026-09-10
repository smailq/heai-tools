// Actions: real scripts under a temp project directory, started detached by
// a state entered, polled for the exit file they write when they end.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { flowDir } from '../src/core.ts'
import { envName, readActions } from '../src/actions.ts'
import { CLI, cli, cliEnv, makeWorld, type World } from './helpers.ts'

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** A detached script ends on its own clock; wait for the file it leaves. */
function waitFor(path: string, ms = 20_000): void {
  const deadline = Date.now() + ms
  while (!existsSync(path)) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${path}`)
    sleep(50)
  }
}

const exitOf = (w: World, id: string, name: string): number => {
  const path = join(flowDir(w.root, id), 'actions', `${name}.exit`)
  waitFor(path)
  return Number(readFileSync(path, 'utf8').trim())
}

const envOf = (w: World, id: string, state: string): Record<string, string> => {
  const path = join(w.dir, 'out', `${id}-${state}.env`)
  waitFor(path)
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
  )
}

const HOOKED = `name: hooked
states: [a, b, c, d, z]
initial: a
terminal: [z]
links:
  task: { required: false }
transitions:
  - { from: a, to: b, on: go }
  - { from: b, to: c, on: go }
  - { from: b, to: d, on: stale, after: 1m }
  - { from: c, to: z, on: unblocked, requires: { waits-on: { all: [z] } } }
  - { from: [a, b, c, d], to: z, on: done }
hooks:
  a: { run: scripts/note.sh }
  b: { run: scripts/note.sh }
  d: { run: scripts/note.sh }
  z: { run: scripts/note.sh }
`

const CHAIN = `name: chain
states: [a, b, z]
initial: a
terminal: [z]
links:
  task: { required: false }
transitions:
  - { from: a, to: b, on: go }
  - { from: b, to: z, on: done }
hooks:
  a: { run: scripts/chain.sh }
  b: { run: scripts/note.sh }
`

const MISSING = `name: missing
states: [a, z]
initial: a
terminal: [z]
transitions: [{ from: a, to: z, on: done }]
hooks: { a: { run: scripts/missing.sh } }
`

/** A project directory: the definitions, and scripts that record the environment they got and, for `chain`, make the next move through the CLI. */
function project(): World {
  const w = makeWorld()
  mkdirSync(join(w.dir, 'scripts'))
  writeFileSync(join(w.dir, 'flows', 'hooked.yaml'), HOOKED)
  writeFileSync(join(w.dir, 'flows', 'chain.yaml'), CHAIN)
  writeFileSync(join(w.dir, 'flows', 'missing.yaml'), MISSING)
  const note = join(w.dir, 'scripts', 'note.sh')
  writeFileSync(note, `#!/bin/sh\nmkdir -p out\nenv | grep '^HEAI_' | sort > "out/$HEAI_FLOW-$HEAI_STATE.env"\ncp "$HEAI_LINE" "out/$HEAI_FLOW-$HEAI_STATE.line"\n`)
  chmodSync(note, 0o755)
  // Relies on the conventions: it runs in the project directory, so flow/ and flow.yaml are found with no flag and no path variable.
  const chain = join(w.dir, 'scripts', 'chain.sh')
  writeFileSync(chain, `#!/bin/sh\nscripts/note.sh || exit 9\nunset HEAI_DIR HEAI_FLOW_STATE\nexec "${process.execPath}" "${CLI}" advance "$HEAI_FLOW" go --by chain.sh\n`)
  chmodSync(chain, 0o755)
  return w
}

test('a hook that advances the same flow through the CLI does not deadlock, and the next state runs its hook in turn', () => {
  const w = project()
  const started = cli(w, 'start', 'chain', '--link', 'task=t1', '--by', 'test')
  assert.equal(started.code, 0, started.stderr)
  const id = started.stdout.trim()
  assert.equal(exitOf(w, id, '1-b'), 0, 'the hook for b, started by the advance the hook for a made, ended cleanly')
  assert.equal(exitOf(w, id, '0-a'), 0)
  assert.match(readFileSync(join(flowDir(w.root, id), 'actions', '0-a.log'), 'utf8'), /"to":"b"/, 'the advance printed its line into the log')

  const a = envOf(w, id, 'a')
  assert.deepEqual([a['HEAI_FLOW'], a['HEAI_DEFINITION'], a['HEAI_STATE'], a['HEAI_EVENT'], a['HEAI_SEQ'], a['HEAI_LINK_TASK']], [id, 'chain', 'a', 'start', '0', 't1'])
  assert.equal(a['HEAI_LINE'], join(flowDir(w.root, id), 'actions', '0-a.line.json'))
  const b = envOf(w, id, 'b')
  assert.deepEqual([b['HEAI_STATE'], b['HEAI_EVENT'], b['HEAI_SEQ'], b['HEAI_LINK_TASK']], ['b', 'go', '1', 't1'])
  const added = Object.keys(b).filter((k) => !(k in process.env)).sort()
  assert.deepEqual(added, ['HEAI_DEFINITION', 'HEAI_EVENT', 'HEAI_FLOW', 'HEAI_LINE', 'HEAI_LINK_TASK', 'HEAI_SEQ', 'HEAI_STATE'], 'exactly these, and no path variables')

  const shown = JSON.parse(cli(w, 'show', id, '--json').stdout)
  assert.equal(shown.journal[1].by, 'chain.sh')
  assert.deepEqual(JSON.parse(readFileSync(join(w.dir, 'out', `${id}-b.line`), 'utf8')), shown.journal[1], 'HEAI_LINE holds the journal line')
  assert.deepEqual(
    shown.actions.map((x: Record<string, unknown>) => [x['seq'], x['state'], x['run'], x['exit']]),
    [
      [0, 'a', 'scripts/chain.sh', 0],
      [1, 'b', 'scripts/note.sh', 0]
    ]
  )
  for (const x of shown.actions) {
    assert.deepEqual(Object.keys(x), ['seq', 'state', 'run', 'startedAt', 'pid', 'exit'])
    assert.equal(typeof x['pid'], 'number')
  }
  const text = cli(w, 'show', id).stdout
  assert.match(text, /\nactions\n {4}0 {2}\S+ \S+ {2}a {10}scripts\/chain.sh {2}exit 0\n {4}1 {2}\S+ \S+ {2}b {10}scripts\/note.sh {2}exit 0\n/)
})

test('the record: <seq>-<state>.json, .log and .exit; a link line runs nothing; a state with no hook runs nothing', () => {
  const w = project()
  const { id } = w.store.start({ definition: 'hooked', links: { task: 't' }, by: 'test' })
  const dir = join(flowDir(w.root, id), 'actions')
  const record = JSON.parse(readFileSync(join(dir, '0-a.json'), 'utf8'))
  assert.deepEqual(Object.keys(record), ['seq', 'state', 'run', 'startedAt', 'pid'])
  assert.deepEqual([record.seq, record.state, record.run, record.startedAt], [0, 'a', 'scripts/note.sh', w.clock.at])
  assert.equal(typeof record.pid, 'number')
  assert.equal(exitOf(w, id, '0-a'), 0)
  assert.deepEqual(readdirSync(dir).sort(), ['0-a.exit', '0-a.json', '0-a.line.json', '0-a.log'])

  w.store.link(id, { links: { task: 'u' } }, 'test')
  w.store.advance(id, { event: 'go', data: {}, by: 'test' }) // b, hooked
  w.store.advance(id, { event: 'go', data: {}, by: 'test' }) // c, no hook
  assert.equal(exitOf(w, id, '2-b'), 0)
  assert.deepEqual(
    readActions(flowDir(w.root, id)).map((a) => [a.seq, a.state, a.exit]),
    [
      [0, 'a', 0],
      [2, 'b', 0]
    ]
  )
  assert.equal(envOf(w, id, 'b')['HEAI_LINK_TASK'], 'u', 'the links as they stood when the state was entered')
  assert.equal(envName('waits-on'), 'HEAI_LINK_WAITS_ON')
})

test('the clock and a guard each run the hook of the state they enter, at settle', () => {
  const w = project()
  const { store, clock } = w
  const one = store.start({ definition: 'hooked', links: {}, by: 'test' }).id
  store.advance(one, { event: 'go', data: {}, by: 'test' })
  assert.equal(exitOf(w, one, '1-b'), 0)
  assert.deepEqual([envOf(w, one, 'b')['HEAI_EVENT'], envOf(w, one, 'b')['HEAI_SEQ']], ['go', '1'])

  clock.tick(61_000)
  assert.match(store.settle()[0]!, /b → d after 1m/)
  assert.equal(exitOf(w, one, '2-d'), 0)
  assert.equal(envOf(w, one, 'd')['HEAI_EVENT'], 'stale')
  assert.equal(JSON.parse(readFileSync(join(flowDir(w.root, one), 'actions', '2-d.line.json'), 'utf8')).by, 'flow')

  const two = store.start({ definition: 'hooked', links: {}, by: 'test' }).id
  store.advance(two, { event: 'go', data: {}, by: 'test' })
  store.advance(two, { event: 'go', data: {}, by: 'test' })
  const three = store.start({ definition: 'hooked', links: {}, by: 'test' }).id
  store.link(two, { waitsOn: [three] }, 'test')
  store.advance(three, { event: 'done', data: {}, by: 'test' })
  assert.equal(exitOf(w, three, '1-z'), 0)
  assert.match(store.settle()[0]!, /c → z/)
  assert.equal(exitOf(w, two, '4-z'), 0)
  assert.equal(envOf(w, two, 'z')['HEAI_EVENT'], 'unblocked')

  // check and reindex write no journal line and run nothing.
  const before = readdirSync(join(flowDir(w.root, two), 'actions')).length
  assert.deepEqual(store.check(), [])
  store.reindex()
  assert.equal(readdirSync(join(flowDir(w.root, two), 'actions')).length, before)
})

test('a missing script is exit 127 in the log and the exit file, not an error at spawn time', () => {
  const w = project()
  const started = cli(w, 'start', 'missing', '--by', 'test')
  assert.equal(started.code, 0)
  const id = started.stdout.trim()
  assert.equal(exitOf(w, id, '0-a'), 127)
  assert.match(readFileSync(join(flowDir(w.root, id), 'actions', '0-a.log'), 'utf8'), /scripts\/missing.sh: (No such file or directory|not found)/)
  assert.match(cli(w, 'show', id).stdout, /scripts\/missing.sh {2}exit 127/)
})

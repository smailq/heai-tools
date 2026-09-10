import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { formatDuration, loadDefinition, matchTransition, parseDefinition, parseDuration } from '../src/definition.ts'
import { DEFS } from './helpers.ts'

const run = loadDefinition(join(DEFS, 'run.yaml'))

test('a definition parses into states, links and transitions, and keeps its text', () => {
  assert.equal(run.name, 'run')
  assert.equal(run.initial, 'queued')
  assert.deepEqual(run.terminal, ['succeeded', 'failed', 'canceled', 'lost'])
  assert.deepEqual(run.links, { task: { required: false }, actor: { required: true }, branch: { required: false } })
  assert.equal(run.transitions.length, 11)
  const lost = run.transitions.find((t) => t.to === 'lost')!
  assert.equal(lost.after, 600_000)
  const unblocked = run.transitions.find((t) => t.on === 'unblocked')!
  assert.deepEqual(unblocked.requires, { waitsOn: { all: ['done'] } })
  assert.match(run.text, /^# A session as an earlier tool recorded it/)
})

test('the first transition whose `when` matches the data wins, in file order', () => {
  assert.equal(matchTransition(run, 'running', 'exited', { exitCode: 0, requests: 0 })!.to, 'succeeded')
  assert.equal(matchTransition(run, 'running', 'exited', { exitCode: 0, requests: 1 })!.to, 'blocked')
  assert.equal(matchTransition(run, 'running', 'exited', { exitCode: 1, requests: 0 })!.to, 'failed')
  assert.equal(matchTransition(run, 'running', 'exited', {})!.to, 'failed')
  assert.equal(matchTransition(run, 'queued', 'exited', {}), null)
})

const base = `name: t\nstates: [a, b]\ninitial: a\nterminal: [b]\n`
const refuses = (yaml: string, re: RegExp) => assert.throws(() => parseDefinition(yaml, 't.yaml'), re)

test('a definition that does not validate is refused with every problem named', () => {
  refuses(`${base}transitions: [{ from: a, to: c, on: go }]`, /to must name one of the states/)
  refuses(`${base}transitions: [{ from: a, to: b, on: start }]`, /start is an event the journal writes itself/)
  refuses(`name: t\nstates: [a, b, c]\ninitial: a\nterminal: [b]\ntransitions: [{ from: a, to: b, on: go }]`, /state c has no way out and is not terminal/)
  refuses(`${base}transitions: [{ from: a, to: b, on: go }, { from: b, to: a, on: back }]`, /terminal state b has a way out/)
  refuses(`${base}transitions: [{ from: a, to: b, on: go, after: 1m, when: { x: 1 } }]`, /when reads an event's data/)
  refuses(`${base}transitions: [{ from: a, to: b, on: go, after: 1m, requires: { waits-on: { all: [b] } } }]`, /after and requires cannot combine/)
  refuses(`name: t\nstates: [a]\ninitial: a\nterminal: [a]\ntransitions: []`, /initial state a cannot be terminal/)
  refuses(`${base}extra: 1\ntransitions: [{ from: a, to: b, on: go }]`, /unknown key "extra"/)
  refuses(`${base}transitions: [{ from: a, to: b, on: go, after: soon }]`, /after must be a duration/)
  refuses(`${base}links: { parent: {} }\ntransitions: [{ from: a, to: b, on: go }]`, /reserved for flow-to-flow links/)
  refuses(`${base}transitions: [{ from: a, to: b, on: go, requires: { waits-on: { any: [b] } } }]`, /requires must be/)
  refuses(`not: [valid`, /not valid YAML/)
  // Two problems, both reported.
  assert.throws(() => parseDefinition(`${base}transitions: [{ from: a, to: c, on: go }, { from: z, to: b, on: go }]`, 't.yaml'), (e: Error) => /to must name/.test(e.message) && /from must name/.test(e.message))
})

test('`from: [a, b, c]` is one transition per source, and its problems name the transition', () => {
  const d = parseDefinition(`name: t\nstates: [a, b, c, z]\ninitial: a\nterminal: [z]\ntransitions:\n  - { from: a, to: b, on: go }\n  - { from: b, to: c, on: go }\n  - { from: c, to: a, on: go }\n  - { from: [a, b, c], to: z, on: stop, by: [human] }\n`, 't.yaml')
  assert.equal(d.transitions.length, 6)
  const stops = d.transitions.filter((t) => t.on === 'stop')
  assert.deepEqual(stops.map((t) => t.from), ['a', 'b', 'c'])
  for (const t of stops) assert.deepEqual([t.to, t.by], ['z', ['human']])
  assert.deepEqual(d.hooks, {})
  refuses(`${base}transitions: [{ from: [a, q], to: b, on: go }]`, /transition 1: from lists "q", which is not one of the states/)
  refuses(`${base}transitions: [{ from: [a, a], to: b, on: go }]`, /transition 1: from lists a twice/)
  refuses(`${base}transitions: [{ from: [], to: b, on: go }]`, /transition 1: from lists no states/)
})

test('hooks: one action per state, validated and kept, and never run', () => {
  const session = loadDefinition(join(DEFS, 'session.yaml'))
  assert.equal(session.transitions.filter((t) => t.on === 'canceled').length, 5)
  assert.deepEqual(Object.keys(session.hooks), ['queued', 'exited', 'resumable', 'waiting', 'clean', 'lost'])
  assert.deepEqual(session.hooks['queued'], { run: 'scripts/session/start.sh' })
  assert.deepEqual(session.hooks['waiting'], { run: 'scripts/session/ask.sh' })
  const t = `${base}transitions: [{ from: a, to: b, on: go }]\n`
  refuses(`${t}hooks: [a]`, /hooks must be a mapping/)
  refuses(`${t}hooks: { q: { run: x.sh } }`, /hook q: "q" is not one of the states/)
  refuses(`${t}hooks: { a: { run: x.sh, file: {} } }`, /hook a: unknown key "file"; the one action is run/)
  refuses(`${t}hooks: { a: {} }`, /hook a: run must be a command/)
  refuses(`${t}hooks: { a: { assign: x } }`, /hook a: unknown key "assign"/)
  refuses(`${t}hooks: { a: { run: 3 } }`, /hook a: run must be a command/)
  refuses(`${t}hooks: { a: x.sh }`, /hook a: must be \{ run/)
  // Reported with the definition's other problems, all at once.
  assert.throws(() => parseDefinition(`${base}transitions: [{ from: a, to: c, on: go }]\nhooks: { q: { run: x } }`, 't.yaml'), (e: Error) => /to must name/.test(e.message) && /hook q/.test(e.message))
})

test('durations parse and print', () => {
  assert.equal(parseDuration('10m'), 600_000)
  assert.equal(parseDuration('90s'), 90_000)
  assert.equal(parseDuration('2h'), 7_200_000)
  assert.equal(parseDuration('1d'), 86_400_000)
  assert.equal(parseDuration(30), 30_000)
  assert.equal(parseDuration('soon'), null)
  assert.equal(parseDuration('0m'), null)
  assert.equal(formatDuration(600_000), '10m')
  assert.equal(formatDuration(90_000), '90s')
  assert.equal(formatDuration(7_200_000), '2h')
})

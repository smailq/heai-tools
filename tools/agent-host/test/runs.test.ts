import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dequeue,
  enqueue,
  finalMessage,
  listRuns,
  newRunId,
  openState,
  queued,
  readExit,
  readRun,
  RUN_ID,
  withLock,
  writeRun,
  type RunRecord
} from '../src/runs.ts'

const record = (id: string, actor = 'alpha', status: RunRecord['status'] = 'queued'): RunRecord => ({
  id,
  actor,
  task: null,
  title: 't',
  ref: `agent/${actor}/${id}`,
  status,
  queuedAt: '2026-09-02T15:30:12Z',
  startedAt: null,
  endedAt: null,
  exitCode: null,
  gate: null,
  requests: [],
  resumes: null,
  changed: [],
  dirty: [],
  error: null
})

test('the state directory ignores itself', () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), 'agent-host-state-')), 'agent-host'))
  assert.equal(readFileSync(join(state.dir, '.gitignore'), 'utf8').trim().split('\n').pop(), '*')
  for (const d of [state.runsDir, state.checkoutsDir, state.queueDir, state.blockedDir]) assert.ok(existsSync(d))
})

test('run ids sort chronologically and carry the actor', () => {
  const a = newRunId('alpha', new Date(Date.UTC(2026, 8, 2, 15, 30, 12)))
  const b = newRunId('alpha', new Date(Date.UTC(2026, 8, 2, 15, 30, 13)))
  assert.match(a, RUN_ID)
  assert.match(a, /^20260902-153012-alpha-[0-9a-f]{4}$/)
  assert.ok(a < b)
})

test('records round-trip and list newest first; the queue is ordered by id', () => {
  const state = openState(mkdtempSync(join(tmpdir(), 'agent-host-state-')))
  writeRun(state, record('20260902-100000-alpha-0001'))
  writeRun(state, record('20260902-110000-alpha-0002', 'alpha', 'running'))
  writeRun(state, record('20260902-120000-beta-0003', 'beta'))
  assert.deepEqual(listRuns(state).map((r) => r.id), ['20260902-120000-beta-0003', '20260902-110000-alpha-0002', '20260902-100000-alpha-0001'])
  assert.deepEqual(listRuns(state, 'beta').map((r) => r.id), ['20260902-120000-beta-0003'])
  assert.equal(readRun(state, 'nope'), null)

  enqueue(state, record('20260902-130000-alpha-0005'))
  enqueue(state, record('20260902-120500-alpha-0004'))
  assert.deepEqual(queued(state, 'alpha'), ['20260902-120500-alpha-0004', '20260902-130000-alpha-0005'])
  dequeue(state, 'alpha', '20260902-120500-alpha-0004')
  assert.deepEqual(queued(state, 'alpha'), ['20260902-130000-alpha-0005'])
  assert.deepEqual(queued(state, 'beta'), [])
})

test('the exit file is the signal, and an unparsable one counts as a failure', () => {
  const state = openState(mkdtempSync(join(tmpdir(), 'agent-host-state-')))
  assert.equal(readExit(state, 'r'), null)
  writeFileSync(join(state.runsDir, 'r.exit'), '3\n')
  assert.equal(readExit(state, 'r'), 3)
  writeFileSync(join(state.runsDir, 'r.exit'), 'garbage')
  assert.equal(readExit(state, 'r'), 1)
})

test('the final message is the tail of the log', () => {
  assert.equal(finalMessage('a\nb\nc\n', 2), 'b\nc')
  assert.equal(finalMessage(''), '')
})

test('the settle lock serializes, and a stale one is broken', () => {
  const state = openState(mkdtempSync(join(tmpdir(), 'agent-host-state-')))
  let inner: number | null = null
  const outer = withLock(state, () => {
    inner = withLock(state, () => 2)
    return 1
  })
  assert.equal(outer, 1)
  assert.equal(inner, null)
  // A lock left by a crashed settler, older than a minute, does not block forever.
  mkdirSync(join(state.dir, 'settle.lock'))
  const old = new Date(Date.now() - 120_000)
  utimesSync(join(state.dir, 'settle.lock'), old, old)
  assert.equal(withLock(state, () => 3), 3)
})

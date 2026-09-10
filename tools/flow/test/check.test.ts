import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { flowDir } from '../src/core.ts'
import { chain, makeWorld } from './helpers.ts'

test('check finds drift in snapshots and indexes, and reindex removes it', () => {
  const w = makeWorld()
  const ids = chain(w)
  assert.deepEqual(w.store.check(), [])
  rmSync(join(flowDir(w.root, ids.req), 'state.json'))
  rmSync(join(w.root, 'by-state', 'landing', 'landed', ids.landing))
  mkdirSync(join(w.root, 'by-link', 'task', 'ghost'), { recursive: true })
  writeFileSync(join(w.root, 'by-link', 'task', 'ghost', ids.run1), '')
  const snap = join(flowDir(w.root, ids.run2), 'state.json')
  writeFileSync(snap, readFileSync(snap, 'utf8').replace('"seq": 2', '"seq": 1'))
  const problems = w.store.check()
  assert.deepEqual(problems.map((p) => `${p.id ?? '-'}: ${p.message}`), [
    `${ids.req}: state.json is missing or unreadable`,
    `${ids.run2}: state.json says succeeded at seq 1; the journal says succeeded at seq 2`,
    `-: missing index entry by-state/landing/landed/${ids.landing}`,
    `-: stray index entry by-link/task/ghost/${ids.run1}`
  ])
  assert.equal(w.store.reindex(), 4)
  assert.deepEqual(w.store.check(), [])
})

test('check replays every journal against its pinned definition', () => {
  const w = makeWorld()
  const { id } = w.store.start({ definition: 'run', links: { actor: 'a' }, by: 'x' })
  const journal = join(flowDir(w.root, id), 'journal.jsonl')
  appendFileSync(journal, '{"seq":1,"at":"2026-09-04T17:00:00.000Z","event":"exited","from":"queued","to":"failed","by":"x","data":{}}\n')
  appendFileSync(journal, 'garbage\n')
  appendFileSync(journal, '{"seq":3,"at":"2026-09-04T17:00:01.000Z","event":"started","from":"running","to":"running","by":"x","data":{}}\n')
  const messages = w.store.check().map((p) => p.message)
  assert.ok(messages.includes('journal line 3 does not parse and is ignored'))
  assert.ok(messages.includes('journal line 2: run has no queued → failed on exited'))
  assert.ok(messages.includes('journal line 3 has seq 3, expected 2'))
  assert.ok(messages.includes('journal line 3 leaves running, but the flow was failed'))
  assert.ok(messages.some((m) => /state.json says queued at seq 0/.test(m)))
})

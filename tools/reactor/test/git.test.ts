import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Event } from '../src/events.ts'
import { makeWorld, type World } from './helpers.ts'

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()

function repo(w: World): string {
  const dir = join(w.dir, 'repo')
  mkdirSync(dir)
  git(dir, 'init', '-q', '-b', 'main')
  commit(dir, 'README.md', 'first')
  return dir
}

function commit(dir: string, file: string, subject: string): string {
  const path = join(dir, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${subject}\n`)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', subject)
  return git(dir, 'rev-parse', 'HEAD')
}

const YAML = 'sources:\n  repo: { type: git, path: repo, branches: [main, "integration/*"], every: 60s }\n'

test('the first poll records every branch and emits nothing', async () => {
  const w = makeWorld(YAML)
  repo(w)
  await w.engine.loadSources()
  assert.equal((await w.engine.pollSource(w.engine.sources[0]!)).length, 0)
  const cursor = w.log.cursor<{ branches: Record<string, string> }>('repo')!
  assert.deepEqual(Object.keys(cursor.branches), ['main'])
})

test('one event per new commit, with the paths it changed', async () => {
  const w = makeWorld(YAML)
  const dir = repo(w)
  await w.engine.loadSources()
  const src = w.engine.sources[0]!
  await w.engine.pollSource(src)
  const a = commit(dir, 'packages/core/db/schema.ts', 'Add a table')
  const b = commit(dir, 'web/index.html', 'Tweak the page')
  const events = await w.engine.pollSource(src)
  assert.deepEqual(
    events.map((e: Event) => [e.kind, e.key]),
    [
      ['commit', `main@${a}`],
      ['commit', `main@${b}`]
    ]
  )
  assert.equal(events[0]!.payload['subject'], 'Add a table')
  assert.equal(events[0]!.payload['branch'], 'main')
  assert.equal(events[0]!.payload['author'], 't')
  assert.deepEqual(events[0]!.payload['paths'], ['packages/core/db/schema.ts'])
  assert.deepEqual(events[1]!.payload['paths'], ['web/index.html'])
  assert.equal((await w.engine.pollSource(src)).length, 0, 'nothing new')
})

test('branches created and deleted, watched by glob', async () => {
  const w = makeWorld(YAML)
  const dir = repo(w)
  await w.engine.loadSources()
  const src = w.engine.sources[0]!
  await w.engine.pollSource(src)
  git(dir, 'branch', 'integration/core')
  git(dir, 'branch', 'scratch')
  let events = await w.engine.pollSource(src)
  assert.deepEqual(
    events.map((e: Event) => [e.kind, e.payload['branch']]),
    [['branch-created', 'integration/core']]
  )
  git(dir, 'checkout', '-q', 'integration/core')
  const c = commit(dir, 'packages/core/x.ts', 'On the lane')
  git(dir, 'checkout', '-q', 'main')
  git(dir, 'branch', '-D', 'integration/core')
  events = await w.engine.pollSource(src)
  assert.deepEqual(
    events.map((e: Event) => e.kind),
    ['branch-deleted']
  )
  assert.notEqual(events[0]!.payload['sha'], c, 'the deleted branch is reported at the sha the cursor knew')
})

test('a repository that cannot be read is a note in the cursor, not a crash', async () => {
  const w = makeWorld('sources:\n  repo: { type: git, path: nowhere }\n')
  await w.engine.loadSources()
  assert.equal((await w.engine.pollSource(w.engine.sources[0]!)).length, 0)
  assert.match(w.log.cursor<{ error: string }>('repo')!.error, /git/)
  assert.equal(w.notes.length, 1)
})

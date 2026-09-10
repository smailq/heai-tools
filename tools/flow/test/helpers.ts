// A state directory in a temp dir, with the three fixture definitions
// copied into its flows/, and a clock the tests set by hand so `after` can be exercised
// without waiting. The temp dir is the project directory: an action script
// runs there, and `flow/` and `flow.yaml` sit in it.

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/store.ts'

export const FIXTURES = join(import.meta.dirname, 'fixtures')
export const DEFS = join(FIXTURES, 'definitions')
export const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts')

export interface Clock {
  at: string
  now(): Date
  /** Move the clock forward. */
  tick(ms: number): void
}

export function makeClock(start = '2026-09-04T16:59:52.000Z'): Clock {
  const clock: Clock = {
    at: start,
    now: () => new Date(clock.at),
    tick(ms) {
      clock.at = new Date(Date.parse(clock.at) + ms).toISOString()
    }
  }
  return clock
}

export interface World {
  dir: string
  root: string
  config: string
  clock: Clock
  store: Store
}

export function makeWorld(clock = makeClock()): World {
  const dir = mkdtempSync(join(tmpdir(), 'flow-'))
  const config = join(dir, 'flow.yaml')
  writeFileSync(config, '')
  mkdirSync(join(dir, 'flows'))
  for (const f of ['run.yaml', 'request.yaml', 'landing.yaml']) copyFileSync(join(DEFS, f), join(dir, 'flows', f))
  const root = join(dir, 'flow')
  const store = openStore({ dir: root, configPath: config, project: dir, now: clock.now })
  return { dir, root, config, clock, store }
}

export interface Result {
  code: number
  stdout: string
  stderr: string
}

/** Run the CLI against a world; the exit code is the answer. */
export function cli(world: World, ...args: string[]): Result {
  return cliEnv({}, world, ...args)
}

/** The same, with variables on top of the test's environment. */
export function cliEnv(env: Record<string, string>, world: World, ...args: string[]): Result {
  const flags = ['--dir', world.dir, '--state', world.root, '--config', world.config]
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args, ...flags], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    return { code: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, stdout: err.stdout, stderr: err.stderr }
  }
}

/** The chain the design's walkthrough tells: a run blocks on a request, another run does it, a landing lands it. */
export function chain(w: World) {
  const { store, clock } = w
  const run1 = store.start({ definition: 'run', id: '20260902-165952-run-132f', links: { actor: 'beta', task: 't2' }, by: 'session.sh' }).id
  clock.tick(1000)
  store.advance(run1, { event: 'started', data: {}, by: 'session.sh' })
  clock.tick(1000)
  store.advance(run1, { event: 'exited', data: { exitCode: 0, requests: 1 }, by: 'session.sh', note: 'filed help-requested-by-beta' })
  clock.tick(1000)
  const req = store.start({ definition: 'request', id: '20260902-165954-req-9a01', links: { task: 'help-requested-by-beta' }, parent: run1, by: 'session.sh' }).id
  clock.tick(1000)
  store.link(run1, { waitsOn: [req] }, 'session.sh')
  clock.tick(60_000)
  clock.tick(1000)
  const run2 = store.start({ definition: 'run', id: '20260902-171003-run-a7c2', links: { actor: 'alpha', task: 'help-requested-by-beta' }, parent: req, by: 'session.sh' }).id
  clock.tick(1000)
  store.advance(run2, { event: 'started', data: {}, by: 'session.sh' })
  clock.tick(1000)
  store.advance(req, { event: 'picked', data: {}, by: 'session.sh' })
  clock.tick(120_000)
  clock.tick(1000)
  store.advance(run2, { event: 'exited', data: { exitCode: 0, requests: 0 }, by: 'session.sh' })
  clock.tick(1000)
  store.advance(req, { event: 'finished', data: {}, by: 'session.sh' })
  clock.tick(1000)
  const landing = store.start({ definition: 'landing', id: '20260902-171230-land-04e8', links: { lane: 'core', branch: 'agent/alpha/help-requested-by-beta' }, parent: run2, by: 'land.sh' }).id
  clock.tick(1000)
  store.advance(landing, { event: 'landed', data: {}, by: 'land.sh' })
  clock.tick(1000)
  store.advance(req, { event: 'landed', data: {}, by: 'land.sh' })
  return { run1, req, run2, landing }
}

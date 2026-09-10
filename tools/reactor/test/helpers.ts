// A project directory in a temp dir and a clock the tests set by hand.

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, type Config } from '../src/config.ts'
import { Log } from '../src/events.ts'
import { resolvePaths, type Paths } from '../src/paths.ts'
import { Engine } from '../src/reactor.ts'

export const FIXTURES = join(import.meta.dirname, 'fixtures')
export const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts')

export interface Clock {
  at: string
  now(): Date
  tick(ms: number): void
  set(iso: string): void
}

export function makeClock(start = '2026-09-09T10:00:30.000Z'): Clock {
  const clock: Clock = {
    at: start,
    now: () => new Date(clock.at),
    tick(ms) {
      clock.at = new Date(Date.parse(clock.at) + ms).toISOString()
    },
    set(iso) {
      clock.at = new Date(iso).toISOString()
    }
  }
  return clock
}

export interface World {
  dir: string
  paths: Paths
  config: Config
  log: Log
  engine: Engine
  clock: Clock
  notes: string[]
  env: Record<string, string>
}

export function makeWorld(yaml = '', clock = makeClock()): World {
  const dir = mkdtempSync(join(tmpdir(), 'reactor-'))
  writeFileSync(join(dir, 'reactor.yaml'), yaml)
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  const env = { HEAI_DIR: dir }
  const paths = resolvePaths({}, { HEAI_DIR: dir }, dir)
  const config = loadConfig(paths.config)
  const log = new Log(paths.state, clock.now)
  const notes: string[] = []
  const engine = new Engine({ paths, config, log, now: clock.now, note: (l) => notes.push(l) })
  return { dir, paths, config, log, engine, clock, notes, env }
}

/** A script under the world's scripts/ that does what its body says and exits as told. */
export function writeScript(world: World, name: string, body: string): string {
  const path = join(world.dir, 'scripts', name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return `scripts/${name}`
}

export interface Result {
  code: number
  stdout: string
  stderr: string
}

/** Run the CLI against a world; the exit code is the answer. */
export function cli(world: World, ...args: string[]): Result {
  return cliWith(world, {}, ...args)
}

/** Run the CLI with something on stdin. */
export function cliWith(world: World, opts: { input?: string }, ...args: string[]): Result {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: world.dir, env: { ...process.env, ...world.env }, input: opts.input })
  return { code: r.status ?? 2, stdout: r.stdout, stderr: r.stderr }
}

/** Wait for a condition, polling; a test's clock is not the process's. */
export async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 20))
  }
}

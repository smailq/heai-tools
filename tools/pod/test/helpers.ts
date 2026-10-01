// A project directory in a temp dir, a fake runtime on PATH that records
// argv and replays fixtures, and a CLI runner whose exit code is the answer.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureState, type StateDirs } from '../src/config.ts'
import type { Result as JobResult } from '../src/queue.ts'

export const FIXTURES = join(import.meta.dirname, 'fixtures')
export const FAKE = join(import.meta.dirname, 'fake')
export const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts')

export interface Reply {
  when: string[]
  stdout?: string
  stdoutFile?: string
  stderr?: string
  code?: number
  once?: boolean
}

export interface World {
  /** The project directory: the configuration, the state. */
  dir: string
  state: string
  dirs: StateDirs
  /** Where the fake runtime records and reads. */
  fake: string
  replies(list: Reply[]): void
  calls(): { bin: string; argv: string[] }[]
  /** A directory to submit, holding the files given; a job.json and a prompt in workdir/ when none are. */
  jobDir(name: string, files?: Record<string, string>): string
  /** Play the worker: move a queued job under .running with a claim. */
  claim(name: string, worker?: string): void
  /** Play the worker: finish a running job with a result, its stdout and its stderr. */
  finish(name: string, result: Partial<JobResult>, output?: { stdout?: string; stderr?: string }): void
}

export function makeWorld(): World {
  const dir = mkdtempSync(join(tmpdir(), 'pod-'))
  const fake = join(dir, 'fake')
  mkdirSync(fake)
  const state = join(dir, 'pod')
  const dirs = ensureState(state)
  return {
    dir,
    state,
    dirs,
    fake,
    replies(list) {
      writeFileSync(join(fake, 'replies.json'), JSON.stringify(list))
    },
    calls() {
      const p = join(fake, 'calls.jsonl')
      if (!existsSync(p)) return []
      return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { bin: string; argv: string[] })
    },
    jobDir(name, files = { 'job.json': '{"run": "claude -p < prompt.md"}\n', 'workdir/prompt.md': 'do the thing\n' }) {
      const d = join(dir, 'jobs', name)
      mkdirSync(d, { recursive: true })
      for (const [f, body] of Object.entries(files)) {
        mkdirSync(join(d, f, '..'), { recursive: true })
        writeFileSync(join(d, f), body)
      }
      return d
    },
    claim(name, worker = 'w1') {
      renameSync(join(dirs.queue, name), join(dirs.running, name))
      writeFileSync(join(dirs.running, name, 'claim.json'), JSON.stringify({ worker, started: '2026-09-25T10:00:00.000Z' }))
    },
    finish(name, result, output = {}) {
      const running = join(dirs.running, name)
      const full: JobResult = { job: name, status: 'ok', exit: 0, started: '2026-09-25T10:00:00.000Z', finished: '2026-09-25T10:01:31.234Z', duration_ms: 91234, worker: 'w1', ...result }
      writeFileSync(join(running, 'stdout'), output.stdout ?? '')
      writeFileSync(join(running, 'stderr'), output.stderr ?? '')
      writeFileSync(join(running, 'result.json'), JSON.stringify(full, null, 2) + '\n')
      renameSync(running, join(dirs.done, name))
    }
  }
}

export interface Result {
  code: number
  stdout: string
  stderr: string
}

/** Run the CLI against a world with the fake runtime first on PATH. */
export function cli(world: World, ...args: string[]): Result {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${FAKE}:${process.env['PATH'] ?? ''}`, FAKE_RUNTIME_DIR: world.fake, HEAI_DIR: world.dir }
  delete env['HEAI_POD_STATE']
  try {
    const stdout = execFileSync(process.execPath, [CLI, '--runtime', 'apple', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env })
    return { code: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, stdout: err.stdout, stderr: err.stderr }
  }
}

/** The recorded `container list` with the workshop container present, running or stopped. */
export function listWith(name: string, state: 'running' | 'stopped'): string {
  const doc = JSON.parse(readFileSync(join(FIXTURES, 'container-list.json'), 'utf8')) as Record<string, unknown>[]
  const entry = JSON.parse(JSON.stringify(doc[1])) as { configuration: { id: string }; id: string; status: { state: string } }
  entry.configuration.id = name
  entry.id = name
  entry.status.state = state
  return JSON.stringify([doc[0], entry])
}

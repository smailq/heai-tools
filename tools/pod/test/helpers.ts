// A project directory in a temp dir with a map that names one repository,
// a fake runtime on PATH that records argv and replays fixtures, and a CLI
// runner whose exit code is the answer.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const FIXTURES = join(import.meta.dirname, 'fixtures')
export const HERDR_FIXTURES = join(FIXTURES, 'herdr')
export const FAKE = join(import.meta.dirname, 'fake')
export const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts')

export const fixture = (name: string): string => readFileSync(join(HERDR_FIXTURES, name), 'utf8')

export interface Reply {
  when: string[]
  stdout?: string
  stdoutFile?: string
  stderr?: string
  code?: number
  once?: boolean
}

export interface World {
  /** The project directory: the map, the configuration, the state. */
  dir: string
  map: string
  state: string
  /** Where the fake runtime records and reads. */
  fake: string
  /** A git repository the map's `app` points at. */
  source: string
  replies(list: Reply[]): void
  calls(): { bin: string; argv: string[] }[]
  /** The last recorded `exec ... herdr <group> <command>` argv after `herdr`. */
  herdrCalls(): string[][]
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function makeRepo(path: string): string {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'config', 'user.email', 'test@example.com')
  git(path, 'config', 'user.name', 'test')
  writeFileSync(join(path, 'README.md'), 'hello\n')
  git(path, 'add', '.')
  git(path, 'commit', '-q', '-m', 'init')
  return path
}

export function makeWorld(): World {
  const dir = mkdtempSync(join(tmpdir(), 'pod-'))
  const source = makeRepo(join(dir, 'src', 'app'))
  const map = join(dir, 'architecture.yaml')
  writeFileSync(map, `version: 1\nactors:\n  api-owner: { type: llm-agent }\nrepositories:\n  app: { localPath: src/app }\n  remote-only: { remotePath: https://example.invalid/team/remote-only.git }\n  nowhere: {}\nterritories:\n  api: { owner: api-owner, scope: [{ repository: app, globs: ["**"] }] }\n`)
  const fake = join(dir, 'fake')
  mkdirSync(fake)
  return {
    dir,
    map,
    state: join(dir, 'pod'),
    fake,
    source,
    replies(list) {
      writeFileSync(join(fake, 'replies.json'), JSON.stringify(list))
    },
    calls() {
      const p = join(fake, 'calls.jsonl')
      if (!existsSync(p)) return []
      return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { bin: string; argv: string[] })
    },
    herdrCalls() {
      return this.calls()
        .filter((c) => c.argv[0] === 'exec' && c.argv.includes('herdr'))
        .map((c) => c.argv.slice(c.argv.indexOf('herdr') + 1))
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
  delete env['HEAI_MAP']
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

/** The recorded `agent list` with every agent in the given state. */
export function agentsIn(state: string): string {
  const doc = JSON.parse(fixture('agent-list.json')) as { result: { agents: { agent_status: string }[] } }
  for (const a of doc.result.agents) a.agent_status = state
  return JSON.stringify(doc)
}

/** The replies a fully working container answers with: the recorded Herdr responses keyed by command. */
export function herdrReplies(): Reply[] {
  const r = (when: string[], file: string): Reply => ({ when, stdoutFile: `herdr/${file}` })
  return [
    { when: ['list', '--all'], stdout: listWith('heai-workshop', 'running') },
    r(['herdr', 'worktree', 'create'], 'worktree-create.json'),
    r(['herdr', 'worktree', 'list'], 'worktree-list.json'),
    r(['herdr', 'worktree', 'remove'], 'worktree-remove.json'),
    r(['herdr', 'workspace', 'list'], 'workspace-list-with-agent.json'),
    r(['herdr', 'workspace', 'get'], 'workspace-get.json'),
    r(['herdr', 'workspace', 'focus'], 'workspace-focus.json'),
    r(['herdr', 'workspace', 'close'], 'workspace-close.json'),
    r(['herdr', 'workspace', 'report-metadata'], 'report-metadata.txt'),
    r(['herdr', 'pane', 'list'], 'pane-list-with-agent.json'),
    r(['herdr', 'pane', 'split'], 'pane-split.json'),
    r(['herdr', 'pane', 'run'], 'pane-run.txt'),
    r(['herdr', 'pane', 'read'], 'pane-read.txt'),
    r(['herdr', 'pane', 'wait-output'], 'pane-wait-output.json'),
    r(['herdr', 'agent', 'start'], 'agent-start.json'),
    r(['herdr', 'agent', 'get'], 'agent-get.json'),
    r(['herdr', 'agent', 'list'], 'agent-list.json'),
    r(['herdr', 'agent', 'wait'], 'agent-wait.json'),
    r(['herdr', 'agent', 'prompt'], 'agent-start.json'),
    r(['herdr', 'agent', 'read'], 'pane-read.txt'),
    r(['herdr', 'agent', 'send-keys'], 'agent-send-keys.json'),
    { when: ['herdr', 'status', '--json'], stdout: '{"client":{"version":"0.9.0"},"server":{"status":"running","running":true,"version":"0.9.0","protocol":22}}' },
    { when: ['settled', 'wait'], stdout: '{"workspace":"w4","pane":"w4:p1","agent":"w4","state":"idle","exitCode":0}\n' },
    { when: ['settled', 'prompt'], stdout: '{"workspace":"w4","pane":"w4:p1","agent":"w4","state":"blocked","exitCode":1}\n', code: 1 },
    { when: ['settled', 'run'], stdout: '{"workspace":"w2","pane":"w2:p2","agent":null,"state":"exited","exitCode":1}\n', code: 1 }
  ]
}

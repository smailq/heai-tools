// A governed repository in a temp directory, with a map, a tracker and two
// llm-agents, plus a fake container CLI that "runs" work by writing the files
// a real run would - which is all the host ever sees of one.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContainerCli, ContainerInfo, RunSpec } from '../src/containers.ts'

export const MAP = `version: 1
unowned: fail
actors:
  smailq:
    type: human
    identity: smailq@example.com
  alpha:
    type: llm-agent
    context: |
      You are alpha. Keep alpha/ tidy.
  beta:
    type: llm-agent
    context: Beta's context.
    watches: [alpha, beta]
repositories:
  repo:
    localPath: ..
territories:
  governance:
    owner: smailq
    scope:
      - repository: repo
        globs: ['**']
        exclude:
          territories: [alpha, beta, tracker]
  alpha:
    owner: alpha
    scope:
      - repository: repo
        globs: ['alpha/**']
    context: |
      alpha's own context.
  alpha-sub:
    parent: alpha
    scope:
      - repository: repo
        globs: ['alpha/sub/**']
    context: The sub-territory's context.
  beta:
    owner: beta
    scope:
      - repository: repo
        globs: ['beta/**']
  tracker:
    owner: smailq
    scope:
      - repository: repo
        globs: ['.heai/tasks/**']
`

const sh = (cwd: string, cmd: string, ...args: string[]): string =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const TASK_MANAGER = join(import.meta.dirname, '..', '..', 'task-manager', 'src', 'cli.ts')

export interface Repo {
  root: string
  map: string
  tasks: string
  state: string
  config: string
  git(...args: string[]): string
  task(slug: string, fields: { title: string; territory?: string; status?: string; priority?: string; body?: string }): void
  taskStatus(slug: string): string
  setTask(slug: string, ...args: string[]): void
}

/** A fresh governed repository with `main`, a `.heai/` map and tracker, and one file per territory. */
export function makeRepo(configYaml = 'image: heai/agent-echo\nbase: main\n'): Repo {
  const root = mkdtempSync(join(tmpdir(), 'agent-host-'))
  const git = (...args: string[]) => sh(root, 'git', ...args)
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'tester')
  git('config', 'user.email', 'tester@example.com')
  mkdirSync(join(root, '.heai'), { recursive: true })
  mkdirSync(join(root, 'alpha'), { recursive: true })
  mkdirSync(join(root, 'beta'), { recursive: true })
  writeFileSync(join(root, 'alpha', 'README.md'), 'alpha\n')
  writeFileSync(join(root, 'beta', 'README.md'), 'beta\n')
  writeFileSync(join(root, 'README.md'), 'root\n')
  writeFileSync(join(root, '.heai', 'architecture.yaml'), MAP)
  writeFileSync(join(root, '.heai', 'agent-host.yaml'), configYaml)
  sh(root, process.execPath, TASK_MANAGER, 'init', '--dir', '.heai/tasks', '--map', '../architecture.yaml')
  git('add', '-A')
  git('commit', '-q', '-m', 'initial')
  const tasks = join(root, '.heai', 'tasks')
  const tm = (...args: string[]) => sh(root, process.execPath, TASK_MANAGER, ...args, '--dir', tasks)
  return {
    root,
    map: join(root, '.heai', 'architecture.yaml'),
    tasks,
    state: join(root, '.heai', 'agent-host'),
    config: join(root, '.heai', 'agent-host.yaml'),
    git,
    task(slug, f) {
      const args = ['new', slug, '--title', f.title, '--body', f.body ?? `Body of ${slug}.`, '--status', f.status ?? 'todo']
      if (f.territory) args.push('--territory', f.territory)
      if (f.priority) args.push('--priority', f.priority)
      tm(...args)
    },
    taskStatus(slug) {
      const raw = sh(root, 'cat', join(tasks, 'items', `${slug}.md`))
      return raw.match(/^status: (.*)$/m)?.[1] ?? ''
    },
    setTask(slug, ...args) {
      tm('set', slug, ...args)
    }
  }
}

export interface FakeRun {
  container: string
  env: Record<string, string>
  script: string
}

/**
 * A container CLI that keeps containers in memory and lets a test play the
 * part of the run: `finish(id, exit, log)` writes the files a real run
 * would, after doing whatever git work the test wants in the checkout.
 */
export class FakeContainers implements ContainerCli {
  containers = new Map<string, ContainerInfo & { spec: RunSpec }>()
  execs: FakeRun[] = []
  killed: number[] = []
  built: string[] = []
  /** Mounted runs directory per container, so `finish` knows where to write. */
  runsDirOf(container: string): string {
    const spec = this.containers.get(container)!.spec
    return Object.entries(spec.mounts).find(([, guest]) => guest === '/heai/runs')![0]
  }
  checkoutOf(container: string): string {
    const spec = this.containers.get(container)!.spec
    return Object.entries(spec.mounts).find(([, guest]) => guest === '/work')![0]
  }
  async list() {
    return [...this.containers.values()].map(({ spec: _spec, ...info }) => info)
  }
  async run(spec: RunSpec) {
    this.containers.set(spec.name, { id: spec.name, state: 'running', image: spec.image, labels: spec.labels, spec })
  }
  async start(id: string) {
    this.containers.get(id)!.state = 'running'
  }
  async stop(id: string) {
    this.containers.get(id)!.state = 'stopped'
  }
  async delete(id: string) {
    this.containers.delete(id)
  }
  async execDetached(id: string, opts: { env: Record<string, string>; workdir: string }, args: string[]) {
    if (this.containers.get(id)?.state !== 'running') throw new Error(`${id} is not running`)
    this.execs.push({ container: id, env: opts.env, script: args[args.length - 1]! })
    // A real run writes its pid at once.
    const runsDir = this.runsDirOf(id)
    writeFileSync(join(runsDir, `${opts.env['HEAI_RUN']}.pid`), '4242\n')
  }
  async exec(_id: string, args: string[]) {
    if (args[0] === 'kill') this.killed.push(Number(args[1]))
    return { code: 0, stdout: '', stderr: '' }
  }
  async build(tag: string) {
    this.built.push(tag)
  }
  /** The last run started on a container. */
  lastRun(container: string): FakeRun {
    return [...this.execs].reverse().find((e) => e.container === container)!
  }
  /** Play the run: write its log and exit file. */
  finish(container: string, id: string, exit: number, log = 'done\n') {
    const runsDir = this.runsDirOf(container)
    writeFileSync(join(runsDir, `${id}.log`), log)
    writeFileSync(join(runsDir, `${id}.exit`), `${exit}\n`)
  }
  /** Write a request file as a run would. */
  request(container: string, id: string, name: string, title: string, territory: string, body = 'Please.\n') {
    const dir = join(this.runsDirOf(container), `${id}.requests`)
    if (!existsSync(dir)) mkdirSync(dir)
    writeFileSync(join(dir, `${name}.md`), `---\ntitle: ${title}\nterritory: ${territory}\n---\n\n${body}`)
  }
}

/** Commit a file in an actor's checkout, as the agent would. */
export function commitIn(checkout: string, path: string, content: string, message = 'agent work'): void {
  const full = join(checkout, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  sh(checkout, 'git', 'add', '-A')
  sh(checkout, 'git', 'commit', '-q', '-m', message)
}

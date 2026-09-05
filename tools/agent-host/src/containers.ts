// The slice of Apple's `container` CLI this tool uses, and nothing else.
//
// The CLI is young and its JSON is undocumented, so the parser reads only the
// fields named here, and test/fixtures/container-list.json is real output
// checked in so a format change fails a test rather than a page. Everything
// goes through one `spawn` seam so the host can be driven by a fake in tests.

import { spawn } from 'node:child_process'

/** Something the container CLI made unanswerable: the tool is missing, the service is down, a command failed. */
export class ContainerError extends Error {
  readonly stderr: string
  constructor(message: string, stderr = '') {
    super(message)
    this.name = 'ContainerError'
    this.stderr = stderr
  }
}

export interface ContainerInfo {
  /** The container id, which is the `--name` it was created with. */
  id: string
  /** `running`, `stopped`, or whatever else the CLI reports. */
  state: string
  image: string
  labels: Record<string, string>
}

export interface RunSpec {
  name: string
  image: string
  labels: Record<string, string>
  /** host path → container path */
  mounts: Record<string, string>
  env: Record<string, string>
  envFile?: string
  cpus?: number
  memory?: string
  /** The init process; the host uses `sleep infinity` so work arrives through exec. */
  command: string[]
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** The operations the host needs. A fake implements this in tests. */
export interface ContainerCli {
  /** Every container, running or not. */
  list(): Promise<ContainerInfo[]>
  run(spec: RunSpec): Promise<void>
  start(id: string): Promise<void>
  stop(id: string): Promise<void>
  delete(id: string): Promise<void>
  /** Start a process and return at once; nothing on the host holds it. */
  execDetached(id: string, opts: { env: Record<string, string>; workdir: string }, args: string[]): Promise<void>
  exec(id: string, args: string[]): Promise<ExecResult>
  build(tag: string, contextDir: string, file: string): Promise<void>
}

export type Spawner = (args: string[], stdin?: string) => Promise<ExecResult>

/** Run `container <args>` and collect its output. */
export const spawnContainer: Spawner = (args, stdin) =>
  new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('container', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      reject(e)
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.stderr.on('data', (c: Buffer) => err.push(c))
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') {
        reject(new ContainerError('the `container` CLI is not installed (macOS 26, https://github.com/apple/container)'))
      } else reject(e)
    })
    child.on('close', (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8')
      })
    )
    if (stdin !== undefined) child.stdin.end(stdin)
    else child.stdin.end()
  })

/**
 * The fields this tool reads out of `container list --all --format json`.
 * Anything else the CLI says is ignored, so a new field cannot break this and
 * a renamed one fails the fixture test.
 */
export function parseContainerList(json: string): ContainerInfo[] {
  let doc: unknown
  try {
    doc = JSON.parse(json)
  } catch {
    throw new ContainerError('container list did not return JSON')
  }
  if (!Array.isArray(doc)) throw new ContainerError('container list did not return a JSON array')
  const out: ContainerInfo[] = []
  for (const entry of doc as Record<string, unknown>[]) {
    const configuration = (entry?.['configuration'] ?? {}) as Record<string, unknown>
    const status = (entry?.['status'] ?? {}) as Record<string, unknown>
    const id = configuration['id']
    if (typeof id !== 'string') continue
    const image = (configuration['image'] ?? {}) as Record<string, unknown>
    const labels = (configuration['labels'] ?? {}) as Record<string, unknown>
    out.push({
      id,
      state: typeof status['state'] === 'string' ? status['state'] : 'unknown',
      image: typeof image['reference'] === 'string' ? image['reference'] : '',
      labels: Object.fromEntries(
        Object.entries(labels).filter((kv): kv is [string, string] => typeof kv[1] === 'string')
      )
    })
  }
  return out
}

const serviceHint = 'Ensure the container system service is running: `container system start`'

function failure(what: string, result: ExecResult): ContainerError {
  const detail = result.stderr.trim() || result.stdout.trim()
  const hint = /XPC connection|apiserver|system start/i.test(detail) ? `\n${serviceHint}` : ''
  return new ContainerError(`container ${what} failed (exit ${result.code}): ${detail}${hint}`, result.stderr)
}

/** The real CLI, behind the interface. `run` is the spawn seam. */
export function createContainerCli(run: Spawner = spawnContainer): ContainerCli {
  const ok = async (what: string, args: string[]): Promise<ExecResult> => {
    const result = await run(args)
    if (result.code !== 0) throw failure(what, result)
    return result
  }
  return {
    async list() {
      const result = await ok('list', ['list', '--all', '--format', 'json'])
      return parseContainerList(result.stdout)
    },
    async run(spec) {
      const args = ['run', '-d', '--name', spec.name]
      for (const [k, v] of Object.entries(spec.labels)) args.push('--label', `${k}=${v}`)
      for (const [host, guest] of Object.entries(spec.mounts)) args.push('-v', `${host}:${guest}`)
      for (const [k, v] of Object.entries(spec.env)) args.push('-e', `${k}=${v}`)
      if (spec.envFile) args.push('--env-file', spec.envFile)
      if (spec.cpus !== undefined) args.push('--cpus', String(spec.cpus))
      if (spec.memory !== undefined) args.push('--memory', spec.memory)
      args.push(spec.image, ...spec.command)
      await ok('run', args)
    },
    async start(id) {
      await ok('start', ['start', id])
    },
    async stop(id) {
      await ok('stop', ['stop', id])
    },
    async delete(id) {
      await ok('delete', ['delete', id])
    },
    async execDetached(id, opts, args) {
      const argv = ['exec', '-d', '-w', opts.workdir]
      for (const [k, v] of Object.entries(opts.env)) argv.push('-e', `${k}=${v}`)
      argv.push(id, ...args)
      await ok('exec', argv)
    },
    exec(id, args) {
      return run(['exec', id, ...args])
    },
    async build(tag, contextDir, file) {
      await ok('build', ['build', '-t', tag, '-f', file, contextDir])
    }
  }
}

// The container runtime contract, principle 7: the tool's own code never
// names a runtime. Two built-in implementations sit under runtimes/, each a
// thin argv wrapper over one spawn seam so a fake on PATH can drive it, each
// with its real `list` output recorded under test/fixtures/.

import { spawn } from 'node:child_process'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface ContainerInfo {
  /** The name the container was created with. */
  id: string
  running: boolean
  /** The runtime's own word: running, stopped, exited, created. */
  state: string
  image: string
  labels: Record<string, string>
}

export interface Mount {
  host: string
  container: string
}

export interface RunSpec {
  name: string
  image: string
  labels: Record<string, string>
  mounts: Mount[]
  env: Record<string, string>
  envFile?: string
  cpus?: number
  memory?: string
}

export interface ExecOptions {
  env?: Record<string, string>
  workdir?: string
}

/** The operations the tool needs; both runtimes answer all of them. */
export interface Runtime {
  readonly kind: string
  /** Every container, running or not. */
  list(): Promise<ContainerInfo[]>
  /** Create and start a container from an image; its entrypoint is the process. */
  run(spec: RunSpec): Promise<void>
  start(id: string): Promise<void>
  stop(id: string): Promise<void>
  delete(id: string, force?: boolean): Promise<void>
  /** Run a process in the container and collect its output. */
  exec(id: string, args: string[], opts?: ExecOptions): Promise<ExecResult>
  /** Start a process and return at once; nothing on the host holds it. */
  execDetached(id: string, args: string[], opts?: ExecOptions): Promise<void>
  /** Run a process on this terminal; `tty` asks for one. Resolves with its exit code. */
  execInteractive(id: string, args: string[], tty: boolean): Promise<number>
  build(tag: string, contextDir: string, file: string, buildArgs: Record<string, string>): Promise<void>
}

/** The runtime could not be asked: the CLI is missing, its service is down, a command failed. */
export class RuntimeError extends Error {
  readonly stderr: string
  constructor(message: string, stderr = '') {
    super(message)
    this.name = 'RuntimeError'
    this.stderr = stderr
  }
}

export type Spawner = (bin: string, args: string[]) => Promise<ExecResult>
export type InheritSpawner = (bin: string, args: string[]) => Promise<number>

const missing = (bin: string) => new RuntimeError(`the \`${bin}\` command is not installed or not on PATH`)

/** Run a command and collect its output; the seam every runtime goes through. */
export const spawnCollect: Spawner = (bin, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.stderr.on('data', (c: Buffer) => err.push(c))
    child.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' ? missing(bin) : e))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }))
  })

/** Run a command on this terminal, for `attach` and the raw passthrough. */
export const spawnInherit: InheritSpawner = (bin, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'inherit' })
    child.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' ? missing(bin) : e))
    child.on('close', (code) => resolve(code ?? 1))
  })

/** A spawner bound to one binary that turns a non-zero exit into a RuntimeError. */
export function bound(bin: string, run: Spawner) {
  return async (what: string, args: string[]): Promise<ExecResult> => {
    const result = await run(bin, args)
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim()
      throw new RuntimeError(`${bin} ${what} failed (exit ${result.code})${detail ? `: ${detail}` : ''}`, result.stderr)
    }
    return result
  }
}

/** The `-e K=V` / `-w dir` options both CLIs take on exec, in one place. */
export function execFlags(opts: ExecOptions | undefined): string[] {
  const out: string[] = []
  if (opts?.workdir) out.push('-w', opts.workdir)
  for (const [k, v] of Object.entries(opts?.env ?? {})) out.push('-e', `${k}=${v}`)
  return out
}

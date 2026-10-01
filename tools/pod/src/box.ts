// The one persistent container: up, down, status, build. Nothing here is
// remembered; what is running is asked of the runtime every time, and what
// the queue holds is read from the host's side of the mount.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { QUEUE_MOUNT, RefusedError, UsageError, type StateDirs } from './config.ts'
import { counts, type Counts } from './queue.ts'
import type { ContainerInfo, Mount, Runtime } from './runtime.ts'

export const LABEL = 'heai.tool'

export interface UpOptions {
  name: string
  image: string
  state: StateDirs
  envFile?: string
  mounts: Mount[]
  cpus?: number
  memory?: string
  workers?: number
  timeout?: string
  poll?: string
}

/** `host:container`; the first colon splits, so a host path may not contain one. */
export function parseMount(s: string): Mount {
  const i = s.indexOf(':')
  if (i <= 0 || i === s.length - 1) throw new UsageError(`a mount is host:container, not ${JSON.stringify(s)}`)
  return { host: s.slice(0, i), container: s.slice(i + 1) }
}

export async function find(runtime: Runtime, name: string): Promise<ContainerInfo | undefined> {
  return (await runtime.list()).find((c) => c.id === name)
}

/** The queue, then the caller's mounts. */
export function mountsFor(state: StateDirs, extra: Mount[]): Mount[] {
  return [{ host: state.queue, container: QUEUE_MOUNT }, ...extra]
}

/** What the worker reads from its environment; only what was set. */
export function workerEnv(opts: { workers?: number; timeout?: string; poll?: string }): Record<string, string> {
  const env: Record<string, string> = {}
  if (opts.workers !== undefined) env['WORKERS'] = String(opts.workers)
  if (opts.timeout !== undefined) env['TIMEOUT'] = opts.timeout
  if (opts.poll !== undefined) env['POLL'] = opts.poll
  return env
}

/** Create the container if it does not exist, start it if it is stopped, leave it if it runs. */
export async function up(runtime: Runtime, opts: UpOptions): Promise<'created' | 'started' | 'running'> {
  const existing = await find(runtime, opts.name)
  if (existing?.running) return 'running'
  if (existing) {
    await runtime.start(opts.name)
    return 'started'
  }
  if (opts.envFile && !existsSync(opts.envFile)) throw new UsageError(`env file ${opts.envFile} does not exist`)
  await runtime.run({ name: opts.name, image: opts.image, labels: { [LABEL]: 'pod' }, mounts: mountsFor(opts.state, opts.mounts), env: workerEnv(opts), envFile: opts.envFile, cpus: opts.cpus, memory: opts.memory })
  return 'created'
}

/** Stop the container; refused while a job is running unless forced. A stopped container keeps nothing the queue does not. */
export async function down(runtime: Runtime, name: string, state: StateDirs, force: boolean): Promise<'stopped' | 'already-stopped' | 'absent'> {
  const existing = await find(runtime, name)
  if (!existing) return 'absent'
  if (!existing.running) return 'already-stopped'
  if (!force) {
    const busy = counts(state).running
    if (busy) throw new RefusedError(`${busy} job${busy === 1 ? ' is' : 's are'} still running; wait, or \`down --force\``)
  }
  await runtime.stop(name)
  return 'stopped'
}

export interface Status {
  container: { name: string; state: string; running: boolean; image: string } | null
  queue: Counts
}

/** The runtime's word on the container, and the queue's counts from the host's side. */
export async function status(runtime: Runtime, name: string, state: StateDirs): Promise<Status> {
  const c = await find(runtime, name)
  return { container: c ? { name: c.id, state: c.state, running: c.running, image: c.image } : null, queue: counts(state) }
}

function containerfile(dir: string): string {
  const file = join(dir, 'Containerfile')
  if (!existsSync(file)) throw new UsageError(`no Containerfile in ${dir}`)
  return file
}

/** Build the base image from the Containerfile in `dir`; its first stage compiles the worker from `dir/worker`. */
export async function buildBase(runtime: Runtime, tag: string, dir: string): Promise<{ file: string }> {
  const file = containerfile(dir)
  await runtime.build(tag, dir, file, {})
  return { file }
}

/** Build an extended image from the Containerfile in `dir`, handing it the base's tag as `BASE`. */
export async function buildImage(runtime: Runtime, tag: string, dir: string, base: string): Promise<{ file: string }> {
  const file = containerfile(dir)
  await runtime.build(tag, dir, file, { BASE: base })
  return { file }
}

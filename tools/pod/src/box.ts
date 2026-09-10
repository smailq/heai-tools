// The one persistent container: up, down, status, build. Nothing here is
// remembered; what is running is asked of the runtime every time.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RefusedError, UsageError, type StateDirs } from './config.ts'
import { asAgent, createHerdr, items, type Herdr, type Json } from './herdr.ts'
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

/** The three mounts of the tool's own, then the caller's. */
export function mountsFor(state: StateDirs, extra: Mount[]): Mount[] {
  return [{ host: state.repos, container: '/repos' }, { host: state.worktrees, container: '/worktrees' }, { host: state.inbox, container: '/heai/inbox' }, ...extra]
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
  await runtime.run({ name: opts.name, image: opts.image, labels: { [LABEL]: 'pod' }, mounts: mountsFor(opts.state, opts.mounts), env: {}, envFile: opts.envFile, cpus: opts.cpus, memory: opts.memory })
  return 'created'
}

/** Agents that are `working` right now, by name or pane. */
export async function working(herdr: Herdr): Promise<string[]> {
  try {
    return items(await herdr.call(['agent', 'list']), 'agents')
      .map(asAgent)
      .filter((a) => a.agent_status === 'working')
      .map((a) => a.name ?? a.pane_id)
  } catch {
    return []
  }
}

/** Stop the container; refused while an agent is working unless forced. A stopped container keeps its worktrees and Herdr state. */
export async function down(runtime: Runtime, name: string, force: boolean): Promise<'stopped' | 'already-stopped' | 'absent'> {
  const existing = await find(runtime, name)
  if (!existing) return 'absent'
  if (!existing.running) return 'already-stopped'
  if (!force) {
    const busy = await working(createHerdr(runtime, name))
    if (busy.length) throw new RefusedError(`${busy.join(', ')} ${busy.length === 1 ? 'is' : 'are'} still working; wait, or \`down --force\``)
  }
  await runtime.stop(name)
  return 'stopped'
}

export interface Status {
  container: { name: string; state: string; running: boolean; image: string } | null
  herdr: { running: boolean; version: string | null } | null
  workspaces: number | null
  agents: Record<string, number> | null
}

/** The runtime's word on the container, and Herdr's on itself, its workspaces and its agents. */
export async function status(runtime: Runtime, name: string): Promise<Status> {
  const c = await find(runtime, name)
  const out: Status = { container: c ? { name: c.id, state: c.state, running: c.running, image: c.image } : null, herdr: null, workspaces: null, agents: null }
  if (!c?.running) return out
  const r = await runtime.exec(name, ['herdr', 'status', '--json'])
  if (r.code === 0) {
    try {
      const server = ((JSON.parse(r.stdout) as Json)['server'] ?? {}) as Json
      out.herdr = { running: server['running'] === true, version: typeof server['version'] === 'string' ? server['version'] : null }
    } catch {
      out.herdr = { running: false, version: null }
    }
  } else out.herdr = { running: false, version: null }
  if (!out.herdr.running) return out
  const herdr = createHerdr(runtime, name)
  try {
    out.workspaces = items(await herdr.call(['workspace', 'list']), 'workspaces').length
    const counts: Record<string, number> = {}
    for (const a of items(await herdr.call(['agent', 'list']), 'agents').map(asAgent)) counts[a.agent_status] = (counts[a.agent_status] ?? 0) + 1
    out.agents = counts
  } catch {
    // the server answered status but not the lists; what was learned stands
  }
  return out
}

function containerfile(dir: string): string {
  const file = join(dir, 'Containerfile')
  if (!existsSync(file)) throw new UsageError(`no Containerfile in ${dir}`)
  return file
}

/** Build the base image from the Containerfile in `dir`, pinning herdr to `dir/HERDR_VERSION`. */
export async function buildBase(runtime: Runtime, tag: string, dir: string): Promise<{ file: string; herdrVersion: string }> {
  const file = containerfile(dir)
  const versionFile = join(dir, 'HERDR_VERSION')
  const herdrVersion = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : ''
  await runtime.build(tag, dir, file, herdrVersion ? { HERDR_VERSION: herdrVersion } : {})
  return { file, herdrVersion }
}

/** Build an extended image from the Containerfile in `dir`, handing it the base's tag as `BASE`. */
export async function buildImage(runtime: Runtime, tag: string, dir: string, base: string): Promise<{ file: string }> {
  const file = containerfile(dir)
  await runtime.build(tag, dir, file, { BASE: base })
  return { file }
}

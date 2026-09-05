// The operations: status, up, down, assign, cancel, settle. The CLI and the
// server both call these and nothing else, which is what makes "the CLI works
// without the server" a property of the layout rather than a promise.
//
// Nothing is held in memory across calls. Which actors are running is asked
// of the container CLI each time; everything else is read from the state
// directory. A run is a detached process that writes its own outcome, and
// `settle` is how any caller catches up with what the files now say.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { actorSettings, loadConfig, type Config } from './config.ts'
import { createContainerCli, ContainerError, type ContainerCli, type ContainerInfo } from './containers.ts'
import { runGate } from './gate.ts'
import { loadMap, UsageError, type ArchitectureMap, type Territory } from './map.ts'
import { loadSource, type Source, type SourceRun } from './source.ts'
import { composePrompt } from './prompt.ts'
import { blockTask, fileRequests, unblockLanded, type RequestContext } from './requests.ts'
import {
  chainDepth,
  clearBlocked,
  currentRun,
  dequeue,
  enqueue,
  finalMessage,
  listBlocked,
  listRuns,
  newRunId,
  openState,
  queued,
  readExit,
  readLog,
  readPid,
  readRun,
  runFile,
  TERMINAL,
  withLockAsync,
  writeRun,
  type RunRecord,
  type State
} from './runs.ts'
import { assignable, assignableTo, isTracker, loadTracker, routedTo, type Task } from './tasks.ts'
import { resolveTool } from './tools.ts'

export { UsageError, ContainerError }

/** A question the host can answer "no" to: nothing to do, or not now. */
export class HostError extends Error {
  readonly code: 'not-found' | 'conflict' | 'usage'
  constructor(code: 'not-found' | 'conflict' | 'usage', message: string) {
    super(message)
    this.name = 'HostError'
    this.code = code
  }
}

export const MAX_CHAIN_DEPTH = 3
export const containerName = (actor: string): string => `heai-${actor}`
const IMAGE_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'image')

export type ContainerState = 'running' | 'stopped' | 'absent'

export interface ActorStatus {
  name: string
  context: string
  territories: { name: string; globs: string[]; owner: string | null }[]
  watches: { name: string; globs: string[]; owner: string | null }[]
  container: ContainerState
  image: string
  current: RunRecord | null
  queued: number
  /** The unblocked tasks waiting to be resumed by this actor, under manual dispatch. */
  resumable: string[]
}

export interface TaskView {
  slug: string
  title: string
  status: string
  priority: string
  territories: string[]
  routedTo: string[]
  /** Set when the host blocked it: what it waits on, and which have landed. */
  waitsOn: { slug: string; status: string }[] | null
  /** The run currently on it, if any. */
  run: string | null
}

export interface HostOptions {
  mapPath: string
  tasksDir: string
  stateDir: string
  configPath: string
  containers?: ContainerCli
  now?: () => Date
}

export interface Host {
  map: ArchitectureMap
  config: Config
  state: State
  source: Source
  tasksDir: string
  repoRoot: string
  status(): Promise<ActorStatus[]>
  actor(name: string): Promise<ActorStatus>
  up(actor: string): Promise<{ created: boolean; started: boolean; checkout: string }>
  down(actor: string, opts?: { force?: boolean }): Promise<void>
  assign(actor: string, work: { task?: string; prompt?: string }): Promise<{ run: RunRecord; queued: boolean; warnings: string[] }>
  cancel(id: string): Promise<RunRecord>
  settle(): Promise<string[]>
  runs(actor?: string): RunRecord[]
  run(id: string): RunRecord | null
  log(id: string): string
  prompt(id: string): string
  tasks(): TaskView[]
  buildImage(name: string): Promise<string>
  /** Wait for a run to end, settling as it goes. */
  wait(id: string, opts?: { intervalMs?: number; onLog?: (chunk: string) => void }): Promise<RunRecord>
}

const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z')

/** Build a shipped image (`image/<name>`) or a directory holding a Containerfile, as `heai/agent-<name>`. Needs no map. */
export async function buildImage(name: string, containers: ContainerCli = createContainerCli()): Promise<string> {
  const dir = existsSync(name) && existsSync(join(name, 'Containerfile')) ? name : join(IMAGE_DIR, name)
  if (!existsSync(join(dir, 'Containerfile'))) {
    const known = existsSync(IMAGE_DIR) ? readdirSync(IMAGE_DIR).join(', ') : ''
    throw new UsageError(`no image ${JSON.stringify(name)}: expected ${dir}/Containerfile (shipped: ${known})`)
  }
  const tag = `heai/agent-${name.split('/').filter(Boolean).pop()}`
  await containers.build(tag, dir, join(dir, 'Containerfile'))
  return tag
}

export async function createHost(options: HostOptions): Promise<Host> {
  const map = loadMap(options.mapPath)
  const config = loadConfig(options.configPath, map)
  const state = openState(options.stateDir)
  const containers = options.containers ?? createContainerCli()
  const now = options.now ?? (() => new Date())
  const repoRoot = map.repositoryRoot()
  const tasksDir = options.tasksDir
  const source = await loadSource(
    config.source,
    { repoRoot, checkoutsDir: state.checkoutsDir, base: config.base, stateDir: state.dir },
    dirname(config.path ?? map.path)
  )
  const requestCtx: RequestContext = {
    state,
    map,
    tasksDir,
    taskManager: resolveTool('task-manager', config.taskManager ?? undefined)
  }
  const scopeGate = resolveTool('scope-gate', config.scopeGate ?? undefined)

  const agent = (name: string) => {
    const a = map.actor(name)
    if (!a) throw new HostError('not-found', `the map declares no actor ${JSON.stringify(name)}`)
    if (a.type !== 'llm-agent') throw new HostError('usage', `actor ${name} is a ${a.type}, not an llm-agent`)
    return a
  }
  const checkoutOf = (actor: string) => join(state.checkoutsDir, actor)

  const containerStates = async (): Promise<Map<string, { state: ContainerState; info: ContainerInfo | null }>> => {
    const list = await containers.list()
    const byId = new Map(list.map((c) => [c.id, c]))
    const out = new Map<string, { state: ContainerState; info: ContainerInfo | null }>()
    for (const a of map.agents()) {
      const info = byId.get(containerName(a.name)) ?? null
      out.set(a.name, { state: info ? (info.state === 'running' ? 'running' : 'stopped') : 'absent', info })
    }
    return out
  }

  const tracker = () => (isTracker(tasksDir) ? loadTracker(tasksDir) : null)

  const territoryView = (t: Territory) => ({ name: t.name, globs: t.scope.flatMap((e) => e.globs), owner: t.owner })

  async function statusOf(states: Awaited<ReturnType<typeof containerStates>>): Promise<ActorStatus[]> {
    const tr = tracker()
    return map.agents().map((a) => {
      const c = states.get(a.name)!
      // A task this actor was blocked on that has gone back to todo is a resume waiting to be assigned.
      const resumable = tr
        ? tr.tasks
            .filter((t) => t.status === 'todo' && assignableTo(t, a.name, map))
            .filter((t) => listRuns(state, a.name).some((r) => r.task === t.slug && r.status === 'blocked'))
            .filter((t) => !listRuns(state).some((r) => r.task === t.slug && (r.status === 'running' || r.status === 'queued')))
            .map((t) => t.slug)
        : []
      return {
        name: a.name,
        context: a.context,
        territories: map.owned(a.name).map(territoryView),
        watches: map.watched(a.name).map(territoryView),
        container: c.state,
        image: c.info?.image ?? actorSettings(config, a.name).image,
        current: currentRun(state, a.name),
        queued: queued(state, a.name).length,
        resumable
      }
    })
  }

  // ── Starting a run ──

  const wrapper = (id: string): string =>
    `r=/heai/runs/${id}; /heai/run < $r.prompt >> $r.log 2>&1 & echo $! > $r.pid; wait $!; echo $? > $r.exit`

  const sourceRun = (run: RunRecord): SourceRun => ({ id: run.id, actor: run.actor, slug: run.task, ref: run.ref })

  async function startRun(run: RunRecord, task: Task | null, prompt: string | null): Promise<RunRecord> {
    const problem = await source.begin(sourceRun(run))
    if (problem) {
      run.status = 'failed'
      run.error = problem
      run.endedAt = iso(now())
      writeRun(state, run)
      return run
    }
    const previous = task ? listRuns(state, run.actor).find((r) => r.task === task.slug && r.status === 'blocked') : null
    run.resumes = previous?.id ?? null
    const text = composePrompt({
      map,
      actor: run.actor,
      rules: source.rules(sourceRun(run)),
      task,
      prompt,
      resumes: previous
        ? {
            id: previous.id,
            finalMessage: finalMessage(readLog(state, previous.id)),
            requests: previous.requests.filter((q) => q.task).map((q) => ({ title: q.title, task: q.task! }))
          }
        : null
    })
    writeFileSync(runFile(state, run.id, 'prompt'), text)
    mkdirSync(join(state.runsDir, `${run.id}.requests`), { recursive: true })
    run.status = 'running'
    run.startedAt = iso(now())
    writeRun(state, run)
    try {
      await containers.execDetached(
        containerName(run.actor),
        { env: { HEAI_RUN: run.id, HEAI_TASK: run.task ?? '' }, workdir: '/work' },
        ['sh', '-c', wrapper(run.id)]
      )
    } catch (e) {
      run.status = 'failed'
      run.error = (e as Error).message
      run.endedAt = iso(now())
      writeRun(state, run)
    }
    return run
  }

  function newRecord(actor: string, task: Task | null, prompt: string | null): RunRecord {
    const id = newRunId(actor, now())
    return {
      id,
      actor,
      task: task?.slug ?? null,
      title: task?.title ?? (prompt ?? '').split('\n')[0]!.slice(0, 120),
      ref: source.refFor(actor, task?.slug ?? id),
      status: 'queued',
      queuedAt: iso(now()),
      startedAt: null,
      endedAt: null,
      exitCode: null,
      gate: null,
      requests: [],
      resumes: null,
      changed: [],
      dirty: [],
      error: null
    }
  }

  const activeRunFor = (slug: string): RunRecord | undefined =>
    listRuns(state).find((r) => r.task === slug && (r.status === 'running' || r.status === 'queued'))

  // ── Settling ──

  async function finalize(run: RunRecord, exit: number, notes: string[]): Promise<void> {
    const checkout = checkoutOf(run.actor)
    const canceled = existsSync(runFile(state, run.id, 'canceled'))
    run.exitCode = exit
    run.endedAt = iso(now())

    // The source brings the work home and says what changed; the gate judges the paths.
    const out = await source.finish(sourceRun(run))
    if (out.problem) notes.push(`${run.id}: ${out.problem}`)
    const gate = await runGate({ changed: out.changed, cwd: checkout, mapPath: map.path, actor: run.actor, scopeGate })
    run.gate = gate
    run.changed = out.changed
    run.dirty = out.dirty

    if (canceled) {
      run.status = 'canceled'
    } else {
      const tr = tracker()
      const requester = run.task && tr ? tr.task(run.task) : null
      run.requests = tr ? await fileRequests(requestCtx, run, requester) : []
      const filed = run.requests.filter((q) => q.task).map((q) => q.task!)
      for (const q of run.requests) {
        if (q.task) notes.push(`Filed ${q.task} (${q.territory} → ${map.territory(q.territory)?.owner ?? '?'}), requested by run ${run.id}`)
      }
      const rejected = run.requests.filter((q) => q.error)
      if (filed.length && requester) {
        const error = await blockTask(requestCtx, run, requester, filed)
        if (error) notes.push(`${run.id}: could not block ${requester.slug}: ${error}`)
        else notes.push(`Blocked ${requester.slug} on ${filed.join(', ')}`)
      }
      if (rejected.length) {
        run.status = 'failed'
        run.error = `request${rejected.length > 1 ? 's' : ''} rejected: ${rejected.map((q) => q.error).join('; ')}`
      } else if (exit === 0) {
        run.status = filed.length ? 'blocked' : 'succeeded'
      } else {
        run.status = 'failed'
      }
    }
    writeRun(state, run)
    notes.push(`Run ${run.id} ${run.status}: exit ${exit}, gate ${run.gate.verdict}, ${run.changed.length} file${run.changed.length === 1 ? '' : 's'} changed`)
  }

  async function settleLocked(): Promise<string[]> {
    const notes: string[] = []
    const states = await containerStates()

    for (const run of listRuns(state).filter((r) => r.status === 'running')) {
      const exit = readExit(state, run.id)
      if (exit !== null) await finalize(run, exit, notes)
      else if (states.get(run.actor)?.state !== 'running') {
        run.status = 'lost'
        run.endedAt = iso(now())
        run.error = `container ${containerName(run.actor)} is not running`
        writeRun(state, run)
        notes.push(`Run ${run.id} lost: its container is gone`)
      }
    }

    if (isTracker(tasksDir)) {
      const { unblocked, errors } = await unblockLanded(requestCtx, listBlocked(state), (slug) => clearBlocked(state, slug))
      notes.push(...errors)
      for (const u of unblocked) {
        notes.push(`Unblocked ${u.slug}: ${u.landed.join(', ')} done`)
        if (config.dispatch === 'auto' && map.actor(u.actor)?.type === 'llm-agent') {
          const task = loadTracker(tasksDir).task(u.slug)
          if (task && !activeRunFor(u.slug)) {
            const run = newRecord(u.actor, task, null)
            writeRun(state, run)
            enqueue(state, run)
            notes.push(`Queued ${u.slug} to resume on ${u.actor}`)
          }
        }
      }
    }

    for (const a of map.agents()) {
      if (states.get(a.name)?.state !== 'running' || currentRun(state, a.name)) continue
      const next = queued(state, a.name)[0]
      if (next) {
        dequeue(state, a.name, next)
        const run = readRun(state, next)
        if (!run || run.status !== 'queued') continue
        const task = run.task ? tracker()?.task(run.task) ?? null : null
        const prompt = run.task ? null : readPromptText(run.id)
        await startRun(run, task, prompt)
        notes.push(`Started ${run.id} on ${a.name}`)
        continue
      }
      if (config.dispatch !== 'auto') continue
      const tr = tracker()
      if (!tr) continue
      const candidate = tr.tasks.find(
        (t) => t.status === 'todo' && assignableTo(t, a.name, map) && !activeRunFor(t.slug) && chainDepth(state, t.slug) <= MAX_CHAIN_DEPTH
      )
      const tooDeep = tr.tasks.find((t) => t.status === 'todo' && assignableTo(t, a.name, map) && chainDepth(state, t.slug) > MAX_CHAIN_DEPTH)
      if (tooDeep) notes.push(`Not assigning ${tooDeep.slug}: it sits ${chainDepth(state, tooDeep.slug)} requests deep, past the limit of ${MAX_CHAIN_DEPTH}`)
      if (!candidate) continue
      const run = newRecord(a.name, candidate, null)
      writeRun(state, run)
      await startRun(run, candidate, null)
      notes.push(`Auto-assigned ${candidate.slug} to ${a.name} as ${run.id}`)
    }
    return notes
  }

  /** A queued free-form run keeps its prompt beside the record until it starts. */
  const readPromptText = (id: string): string | null => {
    const path = runFile(state, id, 'request')
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  }

  const settle = async (): Promise<string[]> => (await withLockAsync(state, settleLocked)) ?? []

  // ── The operations ──

  const host: Host = {
    map,
    config,
    state,
    source,
    tasksDir,
    repoRoot,

    async status() {
      await settle()
      return statusOf(await containerStates())
    },

    async actor(name) {
      agent(name)
      const all = await host.status()
      return all.find((a) => a.name === name)!
    },

    async up(actor) {
      agent(actor)
      const { checkout } = await source.prepare(actor)
      const states = await containerStates()
      const c = states.get(actor)!
      if (c.state === 'running') return { created: false, started: false, checkout }
      if (c.state === 'stopped') {
        await containers.start(containerName(actor))
        return { created: false, started: true, checkout }
      }
      const settings = actorSettings(config, actor)
      if (settings.envFile && !existsSync(settings.envFile)) {
        throw new UsageError(`envFile does not exist: ${settings.envFile}`)
      }
      await containers.run({
        name: containerName(actor),
        image: settings.image,
        labels: { 'heai.actor': actor, 'heai.map': map.hash },
        mounts: { [checkout]: '/work', [state.runsDir]: '/heai/runs' },
        env: { HEAI_ACTOR: actor, ...source.env(actor) },
        envFile: settings.envFile,
        cpus: settings.cpus,
        memory: settings.memory,
        command: ['sleep', 'infinity']
      })
      return { created: true, started: true, checkout }
    },

    async down(actor, opts = {}) {
      agent(actor)
      await settle()
      const current = currentRun(state, actor)
      if (current) {
        if (!opts.force) throw new HostError('conflict', `${actor} is on run ${current.id}; cancel it first, or pass --force`)
        await host.cancel(current.id)
        await host.wait(current.id, { intervalMs: 250 })
      }
      const c = (await containerStates()).get(actor)!
      if (c.state === 'absent') throw new HostError('not-found', `${actor} has no container`)
      if (c.state === 'running') await containers.stop(containerName(actor))
      await containers.delete(containerName(actor))
    },

    async assign(actor, work) {
      agent(actor)
      if (!work.task && !work.prompt) throw new HostError('usage', 'give a task slug or a prompt')
      if (work.task && work.prompt) throw new HostError('usage', 'give a task or a prompt, not both')
      await settle()
      const c = (await containerStates()).get(actor)!
      if (c.state !== 'running') throw new HostError('conflict', `${actor} is ${c.state}; run \`agent-host up ${actor}\` first`)

      const warnings: string[] = []
      let task: Task | null = null
      if (work.task) {
        const tr = tracker()
        if (!tr) throw new HostError('usage', `no tracker at ${tasksDir}; assign a --prompt instead`)
        task = tr.task(work.task)
        if (!task) throw new HostError('not-found', `no task ${work.task} in ${tasksDir}`)
        if (!assignable(tr).includes(task)) warnings.push(`${task.slug} is ${task.status}, which is not normally assigned`)
        if (!task.territories.length) warnings.push(`${task.slug} names no territory, so it routes to nobody in particular`)
        else if (!assignableTo(task, actor, map)) {
          warnings.push(`${task.slug} routes to ${routedTo(task, map).join(', ') || 'no owner'}, not ${actor}`)
        }
        const active = activeRunFor(task.slug)
        if (active) throw new HostError('conflict', `${task.slug} is already ${active.status} as run ${active.id}`)
      }
      const run = newRecord(actor, task, work.prompt ?? null)
      if (!task) writeFileSync(runFile(state, run.id, 'request'), work.prompt ?? '')
      writeRun(state, run)
      if (currentRun(state, actor) || queued(state, actor).length) {
        enqueue(state, run)
        return { run, queued: true, warnings }
      }
      await startRun(run, task, work.prompt ?? null)
      return { run, queued: false, warnings }
    },

    async cancel(id) {
      const run = readRun(state, id)
      if (!run) throw new HostError('not-found', `no run ${id}`)
      if (TERMINAL.includes(run.status)) throw new HostError('conflict', `run ${id} is already ${run.status}`)
      if (run.status === 'queued') {
        dequeue(state, run.actor, id)
        run.status = 'canceled'
        run.endedAt = iso(now())
        writeRun(state, run)
        return run
      }
      writeFileSync(runFile(state, id, 'canceled'), '')
      const pid = readPid(state, id)
      if (pid !== null) {
        const r = await containers.exec(containerName(run.actor), ['kill', String(pid)])
        if (r.code !== 0) {
          // Already gone, or the container is: settle will say which.
        }
      }
      return run
    },

    settle,

    runs: (actor) => listRuns(state, actor),
    run: (id) => readRun(state, id),
    log: (id) => readLog(state, id),
    prompt(id) {
      const path = runFile(state, id, 'prompt')
      return existsSync(path) ? readFileSync(path, 'utf8') : ''
    },

    tasks() {
      const tr = tracker()
      if (!tr) return []
      const runsBySlug = new Map<string, RunRecord>()
      for (const r of listRuns(state)) if (r.task && !runsBySlug.has(r.task) && !TERMINAL.includes(r.status)) runsBySlug.set(r.task, r)
      return assignable(tr).map((t) => {
        const b = listBlocked(state).find((x) => x.slug === t.slug) ?? null
        return {
          slug: t.slug,
          title: t.title,
          status: t.status,
          priority: t.priority,
          territories: t.territories,
          routedTo: routedTo(t, map),
          waitsOn: b ? b.waitsOn.map((s) => ({ slug: s, status: tr.task(s)?.status ?? 'missing' })) : null,
          run: runsBySlug.get(t.slug)?.id ?? null
        }
      })
    },

    buildImage: (name) => buildImage(name, containers),

    async wait(id, opts = {}) {
      const interval = opts.intervalMs ?? 1000
      let seen = 0
      for (;;) {
        if (opts.onLog) {
          const log = readLog(state, id)
          if (log.length > seen) {
            opts.onLog(log.slice(seen))
            seen = log.length
          }
        }
        let run = readRun(state, id)
        if (!run) throw new HostError('not-found', `no run ${id}`)
        if (TERMINAL.includes(run.status)) return run
        if (run.status === 'running' && readExit(state, id) !== null) {
          await settle()
          run = readRun(state, id)!
          if (TERMINAL.includes(run.status)) return run
        }
        if (run.status === 'queued') await settle()
        await new Promise((r) => setTimeout(r, interval))
      }
    }
  }
  return host
}

#!/usr/bin/env node
// The commands. Each is a thin call into one module; nothing here is
// remembered between invocations. The container commands ask the runtime;
// the queue commands read and write files under the state directory and
// never touch the container.

import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_BASE, DEFAULT_NAME, defaultRuntime, ensureState, expandHome, parseDuration, positiveInt, readConfig, resolvePaths, RefusedError, UsageError, workerDuration, type Config } from './config.ts'
import { RuntimeError, type Runtime } from './runtime.ts'
import { appleRuntime } from './runtimes/apple.ts'
import { dockerRuntime } from './runtimes/docker.ts'
import { buildBase, buildImage, down, parseMount, status, up } from './box.ts'
import { cancel, find, formatDuration, jobs, submit, tail, wait, type Job } from './queue.ts'

const USAGE = `heai-pod - one container watching a work queue: a job is a directory with a run.sh, the worker runs it, the result lands in .done

  heai-pod up    --image <tag> [--workers n] [--timeout <duration>] [--poll <duration>] [--env-from <path>] [--mount <host>:<container>]... [--cpus n] [--memory m]
  heai-pod down  [--force]                          refused while a job is running
  heai-pod status [--json]                          the container, and the queue's counts
  heai-pod build                                    the base, then every image in the configuration's images:
  heai-pod build base [--tag <image>] [--image-dir <dir>]
  heai-pod build <image> [--image-dir <dir>]        one extended image, FROM the base
  heai-pod shell                                    a shell in the container

  heai-pod submit <dir> [--name <job>] [--timeout <duration>] [--move]   copy (or move) the directory into the queue; prints the job's name
  heai-pod list [--json]                            every job: queued, running, done
  heai-pod show <job> [--lines N] [--json]          the job's claim or result, and the tail of its logs
  heai-pod wait <job> [--timeout <duration>] [--json]   block until it is done; prints the status
  heai-pod cancel <job>                             a queued job is finished as canceled here; a running one is told to stop

Options, on every command:
  --dir <path>         the project directory (default: HEAI_DIR, else the cwd)
  --state <dir>        holds work_queue/ (default: <dir>/pod; HEAI_POD_STATE)
  --config <path>      the configuration (default: <dir>/pod.yaml)
  --runtime <name>     apple, docker or podman (default: the configuration's, else apple on macOS and docker elsewhere)
  --container <name>   the container (default: the configuration's name, else ${DEFAULT_NAME})
  --json               print JSON
  --help

Durations for the worker - --timeout on up and submit, --poll - are Go's: 30s, 5m, 2h, or 0 for no limit. wait's --timeout also takes milliseconds.

Exit codes: 0 done, or a job that finished ok; 1 refused (a running job on down, a job that exists, a job already done) or a job that finished failed, timeout, canceled or crashed; 2 bad usage, a runtime that could not be asked, a job that does not exist, or wait's own timeout.`

const COMMANDS = ['up', 'down', 'status', 'build', 'shell', 'submit', 'list', 'show', 'wait', 'cancel'] as const

const TOOL_DIR = resolve(fileURLToPath(import.meta.url), '..', '..')

function makeRuntime(kind: string): Runtime {
  if (kind === 'apple') return appleRuntime()
  if (kind === 'docker' || kind === 'podman') return dockerRuntime(kind)
  throw new UsageError(`unknown runtime ${JSON.stringify(kind)}; apple, docker or podman`)
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length))

const statusOf = (j: Job): string => (j.place === 'done' ? j.result?.status ?? 'no result' : j.place)

function printJobs(list: Job[]): void {
  if (!list.length) {
    console.log('(no jobs)')
    return
  }
  const w = Math.max(4, ...list.map((j) => j.name.length))
  for (const j of list) {
    const when = j.result?.started ?? j.claim?.started ?? ''
    const took = j.result ? formatDuration(j.result.duration_ms) : ''
    const exit = j.result ? String(j.result.exit) : ''
    console.log(`${pad(j.name, w)}  ${pad(j.place, 8)}  ${pad(statusOf(j), 9)}  ${pad(exit, 4)}  ${pad(took, 8)}  ${when}`.trimEnd())
  }
}

function printJob(j: Job, lines: number): void {
  const rows: [string, string][] = [['job', j.name], ['place', j.place], ['status', statusOf(j)]]
  const r = j.result
  if (r) {
    rows.push(['exit', String(r.exit)])
    if (r.signal) rows.push(['signal', r.signal])
    if (r.error) rows.push(['error', r.error])
    rows.push(['started', r.started], ['finished', r.finished], ['duration', formatDuration(r.duration_ms)], ['worker', r.worker])
  } else if (j.claim) rows.push(['started', j.claim.started], ['worker', j.claim.worker])
  rows.push(['path', j.path])
  for (const [k, v] of rows) console.log(`${pad(k, 9)} ${v}`)
  for (const log of ['stdout', 'stderr']) {
    const text = tail(join(j.path, 'log', log), lines)
    if (text) process.stdout.write(`--- log/${log} (last ${lines} lines)\n${text}`)
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      state: { type: 'string' },
      config: { type: 'string' },
      runtime: { type: 'string' },
      container: { type: 'string' },
      name: { type: 'string' },
      'env-from': { type: 'string' },
      mount: { type: 'string', multiple: true },
      cpus: { type: 'string' },
      memory: { type: 'string' },
      workers: { type: 'string' },
      timeout: { type: 'string' },
      poll: { type: 'string' },
      tag: { type: 'string' },
      image: { type: 'string' },
      'image-dir': { type: 'string' },
      lines: { type: 'string' },
      move: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    }
  })
  if (values.help || !positionals.length) {
    process.stdout.write(USAGE + '\n')
    return values.help ? 0 : 2
  }
  const command = positionals[0] as (typeof COMMANDS)[number]
  if (!COMMANDS.includes(command)) throw new UsageError(`unknown command ${JSON.stringify(command)}`)
  const paths = resolvePaths({ dir: values.dir, state: values.state, config: values.config })
  const config: Config = readConfig(paths.config)
  const state = ensureState(paths.state)
  const json = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + '\n')
  const arg = (i: number, what: string): string => {
    const v = positionals[i]
    if (!v) throw new UsageError(`${command} needs ${what}`)
    return v
  }
  // the queue commands never need a runtime, so a machine without one can still submit and wait
  const runtime = (): Runtime => makeRuntime(values.runtime ?? config.runtime ?? defaultRuntime())
  const container = (): string => values.container ?? config.name ?? DEFAULT_NAME

  switch (command) {
    case 'up': {
      const cpus = values.cpus !== undefined ? Number.parseFloat(values.cpus) : config.resources?.cpus
      if (cpus !== undefined && !Number.isFinite(cpus)) throw new UsageError('--cpus must be a number')
      const image = values.image
      if (!image) throw new UsageError('up needs --image <tag>')
      const name = container()
      const result = await up(runtime(), {
        name,
        image,
        state,
        envFile: values['env-from'] !== undefined ? expandHome(values['env-from']) : config.envFile,
        mounts: [...(config.mounts ?? []), ...(values.mount ?? [])].map(parseMount),
        cpus,
        memory: values.memory ?? config.resources?.memory,
        workers: values.workers !== undefined ? positiveInt(values.workers, '--workers') : config.workers,
        timeout: values.timeout !== undefined ? workerDuration(values.timeout, '--timeout') : config.timeout,
        poll: values.poll !== undefined ? workerDuration(values.poll, '--poll') : config.poll
      })
      console.log(result === 'running' ? `${name} is already running` : result === 'started' ? `Started ${name}` : `Created and started ${name} from ${image}`)
      return 0
    }

    case 'down': {
      const name = container()
      const result = await down(runtime(), name, state, values.force)
      console.log(result === 'stopped' ? `Stopped ${name}` : result === 'absent' ? `${name} does not exist` : `${name} is already stopped`)
      return 0
    }

    case 'status': {
      const name = container()
      const s = await status(runtime(), name, state)
      if (values.json) json(s)
      else {
        console.log(`container  ${name}  ${s.container ? `${s.container.state}  ${s.container.image}` : 'does not exist'}`)
        const by = Object.entries(s.queue.byStatus)
          .sort()
          .map(([k, n]) => `${n} ${k}`)
          .join(', ')
        console.log(`queue      ${s.queue.queued} queued, ${s.queue.running} running, ${s.queue.done} done${by ? ` (${by})` : ''}`)
        console.log(`           ${state.queue}`)
      }
      return s.container?.running ? 0 : 1
    }

    case 'build': {
      const base = config.base ?? DEFAULT_BASE
      const baseDir = resolve(paths.dir, values['image-dir'] ?? config.baseDir ?? join(TOOL_DIR, 'image'))
      const images = config.images ?? {}
      const which = positionals[1]
      const rt = runtime()
      const doBase = async (tag: string) => {
        const r = await buildBase(rt, tag, baseDir)
        console.log(`Built ${tag} from ${r.file}`)
      }
      const doImage = async (tag: string, dir: string) => {
        const r = await buildImage(rt, tag, resolve(paths.dir, dir), base)
        console.log(`Built ${tag} from ${r.file} on ${base}`)
      }
      if (which === undefined) {
        await doBase(base)
        for (const [tag, dir] of Object.entries(images)) await doImage(tag, dir)
      } else if (which === 'base') await doBase(values.tag ?? base)
      else {
        const dir = values['image-dir'] ?? images[which]
        if (!dir) throw new UsageError(`${which} is not in the configuration's images:; give --image-dir <dir>`)
        await doImage(which, dir)
      }
      return 0
    }

    case 'shell':
      return runtime().execInteractive(container(), ['bash', '-l'], true)

    case 'submit': {
      const dir = arg(1, 'a directory')
      const name = submit(state, dir, { name: values.name, timeout: values.timeout !== undefined ? workerDuration(values.timeout, '--timeout') : undefined, move: values.move })
      if (values.json) json(find(state, name))
      else console.log(name)
      return 0
    }

    case 'list': {
      const list = jobs(state)
      if (values.json) json(list)
      else printJobs(list)
      return 0
    }

    case 'show': {
      const name = arg(1, 'a job name')
      const job = find(state, name)
      if (!job) throw new UsageError(`no job named ${name}`)
      const lines = values.lines !== undefined ? positiveInt(values.lines, '--lines') : 20
      if (values.json) json({ ...job, log: { stdout: tail(join(job.path, 'log', 'stdout'), lines), stderr: tail(join(job.path, 'log', 'stderr'), lines) } })
      else printJob(job, lines)
      return 0
    }

    case 'wait': {
      const name = arg(1, 'a job name')
      let timeout: number | undefined
      if (values.timeout !== undefined) {
        const ms = parseDuration(values.timeout)
        if (ms === null) throw new UsageError(`--timeout takes milliseconds or a duration like 30s or 5m, not ${JSON.stringify(values.timeout)}`)
        timeout = ms
      }
      const job = await wait(state, name, timeout)
      if (!job) {
        process.stderr.write(`pod: ${name} is not done after ${values.timeout}\n`)
        return 2
      }
      if (values.json) json(job)
      else console.log(job.result?.status ?? 'no result')
      return job.result?.status === 'ok' ? 0 : 1
    }

    case 'cancel': {
      const name = arg(1, 'a job name')
      const r = cancel(state, name)
      console.log(r === 'canceled' ? `Canceled ${name}; it never ran` : `Asked the worker to stop ${name}`)
      return 0
    }
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    const say = (m: string) => process.stderr.write(`pod: ${m}\n`)
    if (e instanceof UsageError || e instanceof RuntimeError) {
      say(e.message)
      process.exitCode = 2
    } else if (e instanceof RefusedError) {
      say(e.message)
      process.exitCode = 1
    } else if (e instanceof Error && ((e as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS') || (e as NodeJS.ErrnoException).code === 'ENOENT')) {
      say(e.message)
      process.exitCode = 2
    } else {
      say(e instanceof Error ? e.stack ?? e.message : String(e))
      process.exitCode = 2
    }
  }
)

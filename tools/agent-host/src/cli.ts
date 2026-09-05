#!/usr/bin/env node
// The commands. Each one is a thin call into host.ts; every one works on its
// own against the container service and the state directory, with no server.

import { parseArgs } from 'node:util'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { buildImage, ContainerError, createHost, HostError, UsageError, type Host } from './host.ts'
import { actorSettings } from './config.ts'
import { createAgentServer, normalizeBasePath } from './server.ts'
import { TERMINAL, type RunRecord } from './runs.ts'

const USAGE = `agent-host - hosts the map's llm-agent actors, one container each

  agent-host status                          every llm-agent, and what each is doing
  agent-host up <actor> | down <actor> [--force]
  agent-host assign <actor> --task <slug> | --prompt "..." [--wait]
  agent-host runs [<actor>] | show <run-id> | log <run-id> [--follow] | cancel <run-id>
  agent-host tasks                           the tracker's assignable tasks, and who each routes to
  agent-host settle                          bring records up to date, start queued runs
  agent-host build-image [<name>]            build image/<name> (claude, codex, echo) as heai/agent-<name>
  agent-host serve [--port 4747]             the page and the API

Options, on every command:
  --map <path>       the architecture map (default: .heai/architecture.yaml, else architecture.yaml; HEAI_MAP)
  --tasks <dir>      the tracker directory (default: .heai/tasks, else tasks; HEAI_TASKS)
  --state <dir>      where runs, queues and checkouts live (default: agent-host beside the map; HEAI_STATE)
  --config <path>    machinery configuration (default: agent-host.yaml beside the map)
  --json             (status, runs, show, tasks) print JSON
  --port <n> --host <addr> --base-path <prefix>   (serve; or PORT, HOST, BASE_PATH)
  --help

Exit codes: 0 done, 1 answered no (a failed run, a violation, a refusal), 2 bad usage or an unanswerable question.`

const COMMANDS = ['status', 'up', 'down', 'assign', 'runs', 'show', 'log', 'cancel', 'tasks', 'settle', 'build-image', 'serve'] as const

function firstExisting(candidates: string[], fallback: string): string {
  return candidates.find((c) => existsSync(c)) ?? fallback
}

/** Where everything is, from flags, then the environment, then the conventions. */
export function resolvePaths(values: Record<string, string | undefined>, cwd = process.cwd()) {
  const env = process.env
  const map = resolve(cwd, values['map'] ?? env['HEAI_MAP'] ?? firstExisting(['.heai/architecture.yaml'], 'architecture.yaml'))
  const tasks = resolve(cwd, values['tasks'] ?? env['HEAI_TASKS'] ?? firstExisting(['.heai/tasks'], 'tasks'))
  // State sits beside the map, next to the tracker: `.heai/agent-host` when the
  // map is in `.heai/`, `./agent-host` beside `./tasks` when it is at the root.
  const mapDir = dirname(map)
  const state = resolve(cwd, values['state'] ?? env['HEAI_STATE'] ?? join(mapDir, 'agent-host'))
  const config = resolve(cwd, values['config'] ?? join(mapDir, 'agent-host.yaml'))
  return { map, tasks, state, config }
}

const fmtRun = (r: RunRecord): string => {
  const gate = r.gate ? `gate ${r.gate.verdict}` : ''
  const when = r.startedAt ?? r.queuedAt
  return `${r.id}  ${r.status.padEnd(9)} ${(r.task ?? '(prompt)').padEnd(32)} ${when.slice(0, 16).replace('T', ' ')}  ${gate}`.trimEnd()
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

async function statusCommand(host: Host, json: boolean): Promise<number> {
  const notes = await host.settle()
  const actors = await host.status()
  if (json) {
    process.stdout.write(JSON.stringify({ notes, actors }, null, 2) + '\n')
    return 0
  }
  for (const n of notes) console.log(n)
  const w = Math.max(5, ...actors.map((a) => a.name.length))
  console.log(`${pad('actor', w)}  ${pad('container', 9)}  ${pad('state', 7)}  ${pad('current run', 40)}  queued`)
  for (const a of actors) {
    const state = a.current ? 'busy' : a.container === 'running' ? 'idle' : '-'
    const current = a.current ? `${a.current.id} (${a.current.task ?? 'prompt'})` : '-'
    const resume = a.resumable.length ? `  resume: ${a.resumable.join(', ')}` : ''
    console.log(`${pad(a.name, w)}  ${pad(a.container, 9)}  ${pad(state, 7)}  ${pad(current, 40)}  ${a.queued}${resume}`)
  }
  return 0
}

function showRun(host: Host, run: RunRecord): void {
  const dur =
    run.startedAt && run.endedAt
      ? `  (${Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000)}s)`
      : ''
  console.log(`run       ${run.id}`)
  console.log(`actor     ${run.actor}`)
  console.log(`task      ${run.task ?? '(prompt)'}  ${run.title}`)
  console.log(`ref       ${run.ref}${run.resumes ? `  (resumes ${run.resumes})` : ''}`)
  console.log(
    `status    ${run.status}${run.exitCode !== null ? `  exit ${run.exitCode}` : ''}${
      run.startedAt ? `  started ${run.startedAt}` : ''
    }${run.endedAt ? `  ended ${run.endedAt}` : ''}${dur}`
  )
  if (run.error) console.log(`error     ${run.error}`)
  if (run.gate) {
    console.log(`gate      ${run.gate.verdict}${run.gate.detail ? `  ${run.gate.detail}` : ''}`)
    for (const f of run.gate.findings as { path?: string; fatal?: boolean; owner?: string | null; territory?: string | null; classification?: string }[]) {
      if (f.fatal) console.log(`          ${f.path}  ${f.classification ?? ''}${f.territory ? ` owned by ${f.territory} (${f.owner ?? '?'})` : ''}`)
    }
  }
  if (run.requests.length) {
    console.log('requests')
    for (const q of run.requests) console.log(`          ${q.task ?? 'rejected'}  ${q.title}  [${q.territory}]${q.error ? `  ${q.error}` : ''}`)
  }
  if (run.changed.length) {
    console.log('changed')
    for (const p of run.changed) console.log(`          ${p}`)
  }
  if (run.dirty.length) console.log(`dirty     ${run.dirty.length} uncommitted: ${run.dirty.join(', ')}`)
  console.log(`log       ${join(host.state.runsDir, `${run.id}.log`)}`)
}

/** The exit code a finished run answers with. */
export function outcomeCode(run: RunRecord): number {
  if (run.status === 'succeeded') return run.gate && run.gate.verdict !== 'clean' ? 1 : 0
  if (run.status === 'lost') return 2
  return 1
}

const outcomeLine = (run: RunRecord): string =>
  `Run ${run.status}: exit ${run.exitCode ?? '-'}, gate ${run.gate?.verdict ?? '-'}, ${run.changed.length} file${
    run.changed.length === 1 ? '' : 's'
  } changed${run.requests.length ? `, ${run.requests.length} request${run.requests.length === 1 ? '' : 's'} filed` : ''}${
    run.error ? ` - ${run.error}` : ''
  }`

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      map: { type: 'string' },
      tasks: { type: 'string' },
      state: { type: 'string' },
      config: { type: 'string' },
      task: { type: 'string' },
      prompt: { type: 'string' },
      wait: { type: 'boolean', default: false },
      follow: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      port: { type: 'string' },
      host: { type: 'string' },
      'base-path': { type: 'string' },
      help: { type: 'boolean', default: false }
    }
  })
  if (values.help || !positionals.length) {
    process.stdout.write(USAGE + '\n')
    return values.help ? 0 : 2
  }
  const command = positionals[0] as (typeof COMMANDS)[number]
  if (!COMMANDS.includes(command)) throw new UsageError(`unknown command ${JSON.stringify(command)}`)

  // Building an image is about the machine, not a repository: it needs no map.
  if (command === 'build-image') {
    console.log(`Built ${await buildImage(positionals[1] ?? 'claude')}`)
    return 0
  }

  const paths = resolvePaths({ map: values.map, tasks: values.tasks, state: values.state, config: values.config })
  const host = await createHost({ mapPath: paths.map, tasksDir: paths.tasks, stateDir: paths.state, configPath: paths.config })
  const needActor = command === 'up' || command === 'down' || command === 'assign'
  const needRun = command === 'show' || command === 'log' || command === 'cancel'
  if (needActor && !positionals[1]) throw new UsageError(`${command} needs an actor name`)
  if (needRun && !positionals[1]) throw new UsageError(`${command} needs a run id`)

  switch (command) {
    case 'status':
      return statusCommand(host, values.json)

    case 'up': {
      const r = await host.up(positionals[1]!)
      if (r.created) console.log(`Started heai-${positionals[1]} (${actorSettings(host.config, positionals[1]!).image}); checkout ${r.checkout}`)
      else if (r.started) console.log(`Started heai-${positionals[1]} again`)
      else console.log(`heai-${positionals[1]} is already running`)
      return 0
    }

    case 'down':
      await host.down(positionals[1]!, { force: values.force })
      console.log(`Stopped and deleted heai-${positionals[1]}`)
      return 0

    case 'assign': {
      const { run, queued, warnings } = await host.assign(positionals[1]!, { task: values.task, prompt: values.prompt })
      for (const w of warnings) console.error(`warning: ${w}`)
      if (queued) console.log(`Run ${run.id} queued behind ${host.runs(run.actor).filter((r) => r.status === 'running').map((r) => r.id).join(', ') || 'the queue'}`)
      else if (run.status === 'failed') {
        console.log(`Run ${run.id} failed before it started: ${run.error}`)
        return 1
      } else console.log(`Run ${run.id} started on ${run.ref}`)
      if (!values.wait) return 0
      const done = await host.wait(run.id, { onLog: (c) => process.stdout.write(c) })
      console.log(outcomeLine(done))
      return outcomeCode(done)
    }

    case 'runs': {
      const runs = host.runs(positionals[1])
      if (values.json) process.stdout.write(JSON.stringify(runs, null, 2) + '\n')
      else if (!runs.length) console.log('(no runs)')
      else for (const r of runs) console.log(fmtRun(r))
      return 0
    }

    case 'show': {
      await host.settle()
      const run = host.run(positionals[1]!)
      if (!run) throw new HostError('not-found', `no run ${positionals[1]}`)
      if (values.json) process.stdout.write(JSON.stringify(run, null, 2) + '\n')
      else showRun(host, run)
      return 0
    }

    case 'log': {
      const id = positionals[1]!
      const run = host.run(id)
      if (!run) throw new HostError('not-found', `no run ${id}`)
      if (!values.follow || TERMINAL.includes(run.status)) {
        process.stdout.write(host.log(id))
        return 0
      }
      const done = await host.wait(id, { onLog: (c) => process.stdout.write(c) })
      console.log(outcomeLine(done))
      return outcomeCode(done)
    }

    case 'cancel': {
      const run = await host.cancel(positionals[1]!)
      if (run.status === 'canceled') {
        console.log(`Run ${run.id} canceled (it was queued)`)
        return 0
      }
      console.log(`Signalled run ${run.id}; waiting for it to stop`)
      const done = await host.wait(run.id, { intervalMs: 500 })
      console.log(outcomeLine(done))
      return 0
    }

    case 'tasks': {
      await host.settle()
      const tasks = host.tasks()
      if (values.json) process.stdout.write(JSON.stringify(tasks, null, 2) + '\n')
      else if (!tasks.length) console.log(`(no assignable tasks in ${host.tasksDir})`)
      else
        for (const t of tasks) {
          const waits = t.waitsOn ? `  waits on ${t.waitsOn.map((w) => `${w.slug}:${w.status}`).join(', ')}` : ''
          console.log(`${pad(t.slug, 36)} ${pad(t.status, 12)} ${pad(t.priority || '-', 7)} → ${t.routedTo.join(', ') || '(nobody)'}${t.run ? `  run ${t.run}` : ''}${waits}`)
        }
      return 0
    }

    case 'settle': {
      const notes = await host.settle()
      for (const n of notes) console.log(n)
      if (!notes.length) console.log('Nothing to settle')
      return 0
    }

    case 'serve': {
      const port = Number.parseInt(values.port ?? process.env['PORT'] ?? '4747', 10)
      const bind = values.host ?? process.env['HOST'] ?? '127.0.0.1'
      const basePath = normalizeBasePath(values['base-path'] ?? process.env['BASE_PATH'])
      if (!Number.isFinite(port)) throw new UsageError('port must be a number')
      // Fail fast on a service that is down, rather than serving a page that cannot do anything.
      await host.settle()
      const server = createAgentServer({ host, basePath })
      await new Promise<void>((resolve) => server.listen(port, bind, resolve))
      console.log(`agent-host: http://${bind}:${port}${basePath}/`)
      if (bind !== '127.0.0.1' && bind !== 'localhost') {
        console.error('agent-host: WARNING - listening beyond loopback; this page starts containers and runs agents')
      }
      return await new Promise<number>((resolve) => {
        process.on('SIGINT', () => server.close(() => resolve(0)))
        process.on('SIGTERM', () => server.close(() => resolve(0)))
      })
    }
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    if (e instanceof UsageError || e instanceof ContainerError || (e instanceof Error && e.name === 'ERR_PARSE_ARGS_UNKNOWN_OPTION')) {
      process.stderr.write(`agent-host: ${(e as Error).message}\n`)
      process.exitCode = 2
    } else if (e instanceof HostError) {
      process.stderr.write(`agent-host: ${e.message}\n`)
      process.exitCode = e.code === 'usage' ? 2 : 1
    } else if (e instanceof Error && (e as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`agent-host: ${e.message}\n`)
      process.exitCode = 2
    } else {
      process.stderr.write(`agent-host: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
      process.exitCode = 2
    }
  }
)

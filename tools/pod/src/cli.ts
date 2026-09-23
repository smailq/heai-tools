#!/usr/bin/env node
// The commands. Each is a thin call into one module; nothing here is
// remembered between invocations, and every answer comes from the runtime,
// from Herdr inside the container, or from git on the host.

import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_BASE, DEFAULT_NAME, defaultRuntime, ensureState, expandHome, parseDuration, parseEnv, readConfig, resolvePaths, RefusedError, UsageError, type Config } from './config.ts'
import { RuntimeError, type Runtime } from './runtime.ts'
import { appleRuntime } from './runtimes/apple.ts'
import { dockerRuntime } from './runtimes/docker.ts'
import { createHerdr, HerdrError, isPaneId } from './herdr.ts'
import { buildBase, buildImage, down, parseMount, status, up } from './box.ts'
import { createRepos } from './repos.ts'
import { closeWorkspace, getWorkspace, listWorkspaces, openWorkspace, type WorkspaceView } from './workspaces.ts'
import { notify, promptAgent, readTarget, runCommand, sendKeys, settle, startAgent, waitArgs, type Box, type Settled } from './agents.ts'
import { createPodGit, isWorkspaceId, parseSet, type WorkRef } from './git.ts'

const USAGE = `heai-pod - one persistent container running Herdr: a clone per repository, a worktree per piece of work, an agent or a command in it, a fact file when it settles

  heai-pod up    --image <tag> [--env-from <path>] [--mount <host>:<container>]... [--cpus n] [--memory m]
  heai-pod down  [--force]                          refused while an agent is working
  heai-pod status [--json]
  heai-pod build                                    the base, then every image in the configuration's images:
  heai-pod build base [--tag <image>] [--image-dir <dir>]
  heai-pod build <image> [--image-dir <dir>]        one extended image, FROM the base

  heai-pod repo add <name> [<source>]               clone into <state>/repos/<name>; the source is the map's localPath, else remotePath
  heai-pod repo list [--json]
  heai-pod repo fetch [<name>]
  heai-pod repo pull-branch <name> <branch> [--into <path>]   the branch from the clone into the source checkout

  heai-pod open <repo> --branch <name> [--base <ref>] [--actor <name>] [--label <text>] [--set key=value]...   → prints the workspace id
  heai-pod list [--json]
  heai-pod diff  <workspace | repo branch> [--name-only|--stat|--patch] [--base <ref>] [--json]
  heai-pod log   <workspace | repo branch> [-n <count>] [--json]
  heai-pod show  <workspace | repo branch> [--json]
  heai-pod close <workspace> [--keep-worktree] [--force]
  heai-pod attach [<workspace>]                     the Herdr UI in this terminal

  heai-pod start  <workspace> --agent <kind> [--name <name>] [--env K=V]... [--timeout <ms>] [-- <agent args>]   → prints the pane id
  heai-pod prompt <target> <text> | --file <path> [--wait [--timeout <ms>]] [--notify <dir> [--event <name>] [--timeout <ms>]]
  heai-pod run    <workspace> <command> | --file <path> [--env K=V]... [--wait [--timeout <ms>]] [--notify <dir> [--event <name>]]
  heai-pod wait   <target> [--until <state>]... [--timeout <ms>] [--notify <dir> [--event <name>] [--every <duration>]]
  heai-pod read   <target> [--lines N] [--ansi]
  heai-pod keys   <target> <key>...
  heai-pod herdr  -- <any herdr command>

Options, on every command:
  --dir <path>         the project directory (default: HEAI_DIR, else the map's directory, else the cwd)
  --map <path>         the architecture map (default: <dir>/.heai/architecture.yaml, else <dir>/architecture.yaml; HEAI_MAP)
  --state <dir>        repos, worktrees and inbox (default: <dir>/pod; HEAI_POD_STATE)
  --config <path>      the configuration (default: <dir>/pod.yaml)
  --runtime <name>     apple, docker or podman (default: the configuration's, else apple on macOS and docker elsewhere)
  --container <name>   the container (default: the configuration's name, else ${DEFAULT_NAME}); \`--name\` means the same on up, down and status
  --json               print JSON
  --help

Exit codes: 0 done, or settled well (idle, done, a command that exited 0); 1 settled badly (blocked, a failing command) or refused; 2 bad usage, a runtime or container that could not be asked, a workspace or pane that does not exist, a timeout.`

const COMMANDS = ['up', 'down', 'status', 'build', 'repo', 'open', 'list', 'diff', 'log', 'show', 'close', 'attach', 'start', 'prompt', 'run', 'wait', 'read', 'keys', 'herdr'] as const

const TOOL_DIR = resolve(fileURLToPath(import.meta.url), '..', '..')

function makeRuntime(kind: string): Runtime {
  if (kind === 'apple') return appleRuntime()
  if (kind === 'docker' || kind === 'podman') return dockerRuntime(kind)
  throw new UsageError(`unknown runtime ${JSON.stringify(kind)}; apple, docker or podman`)
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length))

function duration(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined
  const ms = parseDuration(raw)
  if (ms === null) throw new UsageError(`${flag} takes milliseconds or a duration like 30s or 5m, not ${JSON.stringify(raw)}`)
  return ms
}

function printWorkspaces(views: WorkspaceView[]): void {
  if (!views.length) {
    console.log('(no workspaces)')
    return
  }
  const w = Math.max(3, ...views.map((v) => v.id.length))
  const r = Math.max(4, ...views.map((v) => (v.repo ?? '-').length))
  const b = Math.max(6, ...views.map((v) => (v.branch ?? '-').length))
  for (const v of views) {
    const agents = v.agents.map((a) => `${a.name ?? a.pane}:${a.kind ?? '?'}=${a.state}`).join(' ')
    console.log(`${pad(v.id, w)}  ${pad(v.repo ?? '-', r)}  ${pad(v.branch ?? '-', b)}  ${pad(v.status, 8)}  ${pad(v.actor ?? '-', 12)}  ${agents || (v.linked ? '(no agent)' : '(the clone)')}`.trimEnd())
  }
}

function printSettled(s: Settled, command: boolean): void {
  console.log(command && s.state === 'exited' ? String(s.exitCode) : s.state)
}

async function main(argv: string[]): Promise<number> {
  const dd = argv.indexOf('--')
  const passthrough = dd >= 0 ? argv.slice(dd + 1) : []
  const { values, positionals } = parseArgs({
    args: dd >= 0 ? argv.slice(0, dd) : argv,
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      map: { type: 'string' },
      state: { type: 'string' },
      config: { type: 'string' },
      runtime: { type: 'string' },
      container: { type: 'string' },
      name: { type: 'string' },
      'env-from': { type: 'string' },
      mount: { type: 'string', multiple: true },
      cpus: { type: 'string' },
      memory: { type: 'string' },
      tag: { type: 'string' },
      image: { type: 'string' },
      'image-dir': { type: 'string' },
      into: { type: 'string' },
      branch: { type: 'string' },
      base: { type: 'string' },
      n: { type: 'string' },
      actor: { type: 'string' },
      label: { type: 'string' },
      set: { type: 'string', multiple: true },
      env: { type: 'string', multiple: true },
      agent: { type: 'string' },
      file: { type: 'string' },
      notify: { type: 'string' },
      event: { type: 'string' },
      every: { type: 'string' },
      timeout: { type: 'string' },
      until: { type: 'string', multiple: true },
      lines: { type: 'string' },
      'name-only': { type: 'boolean', default: false },
      stat: { type: 'boolean', default: false },
      patch: { type: 'boolean', default: false },
      ansi: { type: 'boolean', default: false },
      wait: { type: 'boolean', default: false },
      'keep-worktree': { type: 'boolean', default: false },
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
  const paths = resolvePaths({ dir: values.dir, map: values.map, state: values.state, config: values.config })
  const config: Config = readConfig(paths.config)
  const state = ensureState(paths.state)
  const runtime = makeRuntime(values.runtime ?? config.runtime ?? defaultRuntime())
  const container = values.container ?? (command !== 'start' ? values.name : undefined) ?? config.name ?? DEFAULT_NAME
  const box: Box = { runtime, container, herdr: createHerdr(runtime, container) }
  const json = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + '\n')
  const timeout = duration(values.timeout, '--timeout')
  const podGit = createPodGit({ reposDir: state.repos })
  const arg = (i: number, what: string): string => {
    const v = positionals[i]
    if (!v) throw new UsageError(`${command} needs ${what}`)
    return v
  }

  const resolveWork = async (start = 1): Promise<WorkRef> => {
    const first = arg(start, 'a workspace id, or <repo> <branch>')
    const second = positionals[start + 1]
    if (second && !second.startsWith('--')) return { repo: first, branch: second }
    if (!isWorkspaceId(first)) throw new UsageError('use a workspace id, or <repo> <branch>')
    const ws = await getWorkspace(box.herdr, first)
    const repo = ws.tokens['repo']
    const branch = ws.tokens['branch']
    if (!repo || !branch) throw new UsageError(`workspace ${first} has no repo/branch metadata`)
    return { repo, branch, workspace: first }
  }

  const withGit = async (views: WorkspaceView[]): Promise<WorkspaceView[]> => {
    return Promise.all(
      views.map(async (v) => {
        if (!v.repo || !v.branch) return v
        try {
          return { ...v, git: await podGit.summary({ repo: v.repo, branch: v.branch }) }
        } catch {
          return v
        }
      })
    )
  }

  switch (command) {
    case 'up': {
      const cpus = values.cpus !== undefined ? Number.parseFloat(values.cpus) : config.resources?.cpus
      if (cpus !== undefined && !Number.isFinite(cpus)) throw new UsageError('--cpus must be a number')
      const image = values.image
      if (!image) throw new UsageError('up needs --image <tag>')
      const result = await up(runtime, {
        name: container,
        image,
        state,
        envFile: values['env-from'] !== undefined ? expandHome(values['env-from']) : config.envFile,
        mounts: [...(config.mounts ?? []), ...(values.mount ?? [])].map(parseMount),
        cpus,
        memory: values.memory ?? config.resources?.memory
      })
      console.log(result === 'running' ? `${container} is already running` : result === 'started' ? `Started ${container}` : `Created and started ${container} from ${image}`)
      return 0
    }

    case 'down': {
      const result = await down(runtime, container, values.force)
      console.log(result === 'stopped' ? `Stopped ${container}` : result === 'absent' ? `${container} does not exist` : `${container} is already stopped`)
      return 0
    }

    case 'status': {
      const s = await status(runtime, container)
      if (values.json) json(s)
      else {
        console.log(`container   ${container}  ${s.container ? `${s.container.state}  ${s.container.image}` : 'does not exist'}`)
        if (s.herdr) console.log(`herdr       ${s.herdr.running ? `running${s.herdr.version ? `  ${s.herdr.version}` : ''}` : 'not running'}`)
        if (s.workspaces !== null) console.log(`workspaces  ${s.workspaces}`)
        if (s.agents) console.log(`agents      ${Object.entries(s.agents).map(([k, n]) => `${n} ${k}`).join(', ') || '0'}`)
      }
      return s.container?.running && s.herdr?.running ? 0 : 1
    }

    case 'build': {
      const base = config.base ?? DEFAULT_BASE
      const baseDir = resolve(paths.dir, values['image-dir'] ?? config.baseDir ?? join(TOOL_DIR, 'image'))
      const images = config.images ?? {}
      const which = positionals[1]
      const doBase = async (tag: string) => {
        const r = await buildBase(runtime, tag, baseDir)
        console.log(`Built ${tag} from ${r.file}${r.herdrVersion ? ` with herdr ${r.herdrVersion}` : ''}`)
      }
      const doImage = async (tag: string, dir: string) => {
        const r = await buildImage(runtime, tag, resolve(paths.dir, dir), base)
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

    case 'repo': {
      const repos = createRepos({ reposDir: state.repos, mapPath: paths.map })
      const sub = arg(1, 'add, list, fetch or pull-branch')
      switch (sub) {
        case 'add': {
          const r = await repos.add(arg(2, 'a repository name'), positionals[3])
          console.log(`Cloned ${r.source ?? '?'} into ${r.path}${r.branch ? ` (${r.branch} at ${r.head})` : ''}`)
          return 0
        }
        case 'list': {
          const list = await repos.list()
          if (values.json) json(list)
          else if (!list.length) console.log(`(no clones under ${state.repos})`)
          else for (const r of list) console.log(`${pad(r.name, 16)}  ${pad(r.branch ?? '-', 20)}  ${pad(r.head ?? '-', 8)}  ${r.source ?? '-'}`)
          return 0
        }
        case 'fetch': {
          for (const n of await repos.fetch(positionals[2])) console.log(n)
          return 0
        }
        case 'pull-branch': {
          const r = await repos.pullBranch(arg(2, 'a repository name'), arg(3, 'a branch'), values.into)
          console.log(`Pulled ${r.branch} into ${r.into}`)
          return 0
        }
        default:
          throw new UsageError(`repo ${sub} is not a command; add, list, fetch or pull-branch`)
      }
    }

    case 'open': {
      if (!values.branch) throw new UsageError('open needs --branch <name>')
      const o = await openWorkspace(box.herdr, state.repos, { repo: arg(1, 'a repository'), branch: values.branch, base: values.base, actor: values.actor, label: values.label, set: parseSet(values.set ?? []) })
      if (values.json) json(o)
      else console.log(o.workspace)
      return 0
    }

    case 'list': {
      const views = await withGit(await listWorkspaces(box.herdr))
      if (values.json) json(views)
      else printWorkspaces(views)
      return 0
    }

    case 'diff': {
      const work = await resolveWork()
      const picks = [values['name-only'], values.stat, values.patch].filter(Boolean).length
      if (picks > 1) throw new UsageError('diff takes one of --name-only, --stat or --patch')
      const mode = values.patch ? 'patch' : values.stat ? 'stat' : 'name-only'
      const out = await podGit.diff(work, { base: values.base, mode })
      if (values.json) json({ ...work, base: values.base ?? (await podGit.branchFact(work.repo, work.branch, 'base')), mode, output: out })
      else process.stdout.write(out)
      return 0
    }

    case 'log': {
      const work = await resolveWork()
      const n = values.n !== undefined ? Number.parseInt(values.n, 10) : 20
      if (!Number.isFinite(n) || n <= 0) throw new UsageError('-n must be a positive number')
      const entries = await podGit.log(work, n)
      if (values.json) json({ ...work, entries })
      else for (const e of entries) console.log(`${e.sha}  ${e.date}  ${e.author}  ${e.subject}`)
      return 0
    }

    case 'show': {
      const work = await resolveWork()
      const entry = await podGit.show(work)
      if (values.json) json({ ...work, ...entry })
      else if (entry.sha) console.log(`${entry.sha}\n${entry.committedAt ?? ''}\n${entry.author ?? ''}\n${entry.subject ?? ''}`.trim())
      return 0
    }

    case 'close': {
      const id = arg(1, 'a workspace id')
      const r = await closeWorkspace(box.herdr, id, { keepWorktree: values['keep-worktree'], force: values.force })
      console.log(r === 'closed' ? `Closed ${id}; its worktree is kept` : `Closed ${id} and removed its worktree`)
      return 0
    }

    case 'attach': {
      if (positionals[1]) await box.herdr.call(['workspace', 'focus', positionals[1]])
      return runtime.execInteractive(container, ['herdr'], true)
    }

    case 'start': {
      if (!values.agent) throw new UsageError('start needs --agent <kind>')
      const r = await startAgent(box, arg(1, 'a workspace id'), { kind: values.agent, name: values.name, env: parseEnv(values.env ?? []), timeout, args: passthrough })
      if (values.json) json(r)
      else console.log(r.pane)
      return 0
    }

    case 'prompt': {
      const target = arg(1, 'a pane id or agent name')
      const text = values.file !== undefined ? readFileSync(values.file, 'utf8') : positionals[2]
      if (!text) throw new UsageError('prompt needs text, or --file <path>')
      if (values.wait && values.notify) throw new UsageError('prompt takes --wait or --notify, not both')
      if (values.notify) {
        await notify(box, values.notify, values.event ?? 'settled', undefined, ['prompt', target, text, ...(timeout !== undefined ? ['--timeout', String(timeout)] : [])])
        console.log(`Prompted ${target}; ${values.event ?? 'settled'} will be written to ${values.notify}`)
        return 0
      }
      if (values.wait) {
        const s = await settle(box, ['prompt', target, text, ...(timeout !== undefined ? ['--timeout', String(timeout)] : [])])
        if (values.json) json(s)
        else printSettled(s, false)
        return s.exitCode
      }
      const r = await promptAgent(box, target, text)
      console.log(`Prompted ${target} (${r.state})`)
      return 0
    }

    case 'run': {
      const ws = arg(1, 'a workspace id')
      const command_ = values.file !== undefined ? readFileSync(values.file, 'utf8') : positionals.slice(2).join(' ')
      if (!command_.trim()) throw new UsageError('run needs a command, or --file <path>')
      if (values.wait && values.notify) throw new UsageError('run takes --wait or --notify, not both')
      const r = await runCommand(box, ws, command_, parseEnv(values.env ?? []))
      const settledArgs = ['run', r.pane, r.sentinel, ...(timeout !== undefined ? ['--timeout', String(timeout)] : [])]
      if (values.notify) {
        await notify(box, values.notify, values.event ?? 'settled', undefined, settledArgs)
        console.log(r.pane)
        return 0
      }
      if (values.wait) {
        const s = await settle(box, settledArgs)
        if (values.json) json({ ...s, pane: r.pane })
        else printSettled(s, true)
        return s.exitCode
      }
      console.log(r.pane)
      return 0
    }

    case 'wait': {
      const target = arg(1, 'a pane id or agent name')
      const args = waitArgs(target, values.until ?? [], timeout)
      if (values.notify) {
        const every = duration(values.every, '--every')
        await notify(box, values.notify, values.event ?? (every !== undefined ? 'touch' : 'settled'), every, args)
        console.log(`Waiting on ${target} in the container; ${values.event ?? (every !== undefined ? 'touch' : 'settled')} will be written to ${values.notify}`)
        return 0
      }
      if (values.every !== undefined) throw new UsageError('--every goes with --notify')
      const s = await settle(box, args)
      if (values.json) json(s)
      else printSettled(s, isPaneId(target) && s.state === 'exited')
      return s.exitCode
    }

    case 'read': {
      const lines = values.lines !== undefined ? Number.parseInt(values.lines, 10) : undefined
      if (lines !== undefined && !Number.isFinite(lines)) throw new UsageError('--lines must be a number')
      process.stdout.write(await readTarget(box, arg(1, 'a pane id or agent name'), lines, values.ansi))
      return 0
    }

    case 'keys': {
      await sendKeys(box, arg(1, 'a pane id or agent name'), positionals.slice(2))
      return 0
    }

    case 'herdr': {
      if (!passthrough.length) throw new UsageError('herdr -- <command>: nothing after --')
      return runtime.execInteractive(container, ['herdr', ...passthrough], false)
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
    } else if (e instanceof HerdrError) {
      say(`herdr: ${e.code}: ${e.message}`)
      process.exitCode = e.exit
    } else if (e instanceof Error && ((e as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS') || (e as NodeJS.ErrnoException).code === 'ENOENT')) {
      say(e.message)
      process.exitCode = 2
    } else {
      say(e instanceof Error ? e.stack ?? e.message : String(e))
      process.exitCode = 2
    }
  }
)

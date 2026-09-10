// Agents, prompts and commands in a workspace, and the two ways of waiting:
// `--wait` runs the `settled` helper in the container and blocks on it;
// `--notify` starts the `notify` helper detached, and the fact is written
// whether or not this process is still around.

import { randomBytes } from 'node:crypto'
import { UsageError } from './config.ts'
import { asAgent, isPaneId, object, type Herdr } from './herdr.ts'
import type { Runtime } from './runtime.ts'
import { getWorkspace, rootPane } from './workspaces.ts'

export interface Box {
  runtime: Runtime
  container: string
  herdr: Herdr
}

/** What `settled` prints, and the body of every fact file. */
export interface Settled {
  workspace: string | null
  pane: string | null
  agent: string | null
  state: string
  exitCode: number
}

export interface StartOptions {
  kind: string
  name?: string
  env: Record<string, string>
  timeout?: number
  args: string[]
}

/** The environment a pane opened for a workspace carries: the actor, for git's attribution, and the caller's own. */
export async function paneEnv(herdr: Herdr, workspace: string, env: Record<string, string>): Promise<{ env: Record<string, string>; cwd: string; root: string }> {
  const ws = await getWorkspace(herdr, workspace)
  const root = await rootPane(herdr, workspace)
  const actor = ws.tokens['actor']
  const out: Record<string, string> = actor ? { HEAI_ACTOR: actor, GIT_AUTHOR_NAME: actor, GIT_COMMITTER_NAME: actor } : {}
  Object.assign(out, env)
  return { env: out, cwd: ws.worktree?.checkout_path || root.cwd || '/', root: root.pane_id }
}

/** A new pane in the workspace, below the root, in the worktree, with the environment. */
export async function splitPane(herdr: Herdr, workspace: string, env: Record<string, string>): Promise<{ pane: string; env: Record<string, string> }> {
  const p = await paneEnv(herdr, workspace, env)
  const args = ['pane', 'split', p.root, '--direction', 'down', '--cwd', p.cwd, '--no-focus']
  for (const [k, v] of Object.entries(p.env)) args.push('--env', `${k}=${v}`)
  const r = await herdr.call(args)
  const pane = object(r, 'pane')['pane_id']
  if (typeof pane !== 'string') throw new UsageError(`herdr pane split did not return a pane id`)
  return { pane, env: p.env }
}

/** A pane of its own in the workspace, then `herdr agent start` in it. Returns the pane and the agent's name. */
export async function startAgent(box: Box, workspace: string, opts: StartOptions): Promise<{ pane: string; name: string; state: string }> {
  const name = opts.name ?? workspace
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new UsageError(`an agent name is [a-z][a-z0-9_-]{0,31}, not ${JSON.stringify(name)}`)
  const { pane } = await splitPane(box.herdr, workspace, opts.env)
  const args = ['agent', 'start', name, '--kind', opts.kind, '--pane', pane]
  if (opts.timeout !== undefined) args.push('--timeout', String(opts.timeout))
  if (opts.args.length) args.push('--', ...opts.args)
  const agent = asAgent(object(await box.herdr.call(args), 'agent'))
  return { pane: agent.pane_id || pane, name: agent.name ?? name, state: agent.agent_status }
}

/** `herdr agent prompt`, without waiting. */
export async function promptAgent(box: Box, target: string, text: string): Promise<{ state: string }> {
  const agent = asAgent(object(await box.herdr.call(['agent', 'prompt', target, text]), 'agent'))
  return { state: agent.agent_status }
}

/** A sentinel no output would print by accident; the helper waits for `<sentinel>=<code>`. */
export const newSentinel = (): string => `__heai_exit_${randomBytes(4).toString('hex')}`

/**
 * The line `pane run` sends. A one-line command runs as typed; a script with
 * newlines is carried as base64 so the pane's shell sees one line. Either way
 * the sentinel prints the exit code.
 */
export function commandLine(command: string, sentinel: string): string {
  const body = command.includes('\n') ? `printf '%s' ${Buffer.from(command, 'utf8').toString('base64')} | base64 -d | sh` : command.trim()
  return `${body}; echo "${sentinel}=$?"`
}

/** A new pane in the workspace and the command in it; the pane and sentinel are what a wait needs. */
export async function runCommand(box: Box, workspace: string, command: string, env: Record<string, string>): Promise<{ pane: string; sentinel: string }> {
  if (!command.trim()) throw new UsageError('run needs a command')
  const { pane } = await splitPane(box.herdr, workspace, env)
  const sentinel = newSentinel()
  await box.herdr.call(['pane', 'run', pane, commandLine(command, sentinel)])
  return { pane, sentinel }
}

/** Block on the `settled` helper in the container and read the fact body it prints. */
export async function settle(box: Box, args: string[]): Promise<Settled> {
  const r = await box.runtime.exec(box.container, ['settled', ...args])
  const text = r.stdout.trim()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new UsageError(`settled did not answer with JSON (exit ${r.code}): ${(r.stderr || text).trim().slice(0, 300)}`)
  }
  const b = body as Record<string, unknown>
  const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : null)
  return { workspace: s('workspace'), pane: s('pane'), agent: s('agent'), state: s('state') ?? 'unknown', exitCode: typeof b['exitCode'] === 'number' ? b['exitCode'] : r.code }
}

/** Start the `notify` helper detached: the fact lands in `dir` when the wait settles, with no host process around. */
export async function notify(box: Box, dir: string, event: string, every: number | undefined, settledArgs: string[]): Promise<void> {
  const args = ['notify', dir, event]
  if (every !== undefined) args.push('--every', String(Math.max(1, Math.round(every / 1000))))
  args.push('--', ...settledArgs)
  await box.runtime.execDetached(box.container, args)
}

/** The wait arguments `settled wait` takes, from the CLI's. */
export function waitArgs(target: string, until: string[], timeout: number | undefined): string[] {
  const args = ['wait', target]
  for (const u of until) args.push('--until', u)
  if (timeout !== undefined) args.push('--timeout', String(timeout))
  return args
}

export async function readTarget(box: Box, target: string, lines: number | undefined, ansi: boolean): Promise<string> {
  const args = [isPaneId(target) ? 'pane' : 'agent', 'read', target, '--source', 'recent-unwrapped']
  if (lines !== undefined) args.push('--lines', String(lines))
  if (ansi) args.push('--ansi')
  return box.herdr.text(args)
}

export async function sendKeys(box: Box, target: string, keys: string[]): Promise<void> {
  if (!keys.length) throw new UsageError('keys needs at least one key')
  await box.herdr.call([isPaneId(target) ? 'pane' : 'agent', 'send-keys', target, ...keys])
}

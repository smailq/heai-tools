// `herdr ...` run inside the container, and its JSON read back. Every
// control command prints {"id":..,"result":{...}} on stdout and, on failure,
// {"id":..,"error":{"code","message"}} on stderr with exit 1; a syntax error
// is plain text with exit 2; `pane read` prints text. The shapes under
// test/fixtures/herdr/ were recorded from herdr 0.9.0.

import type { ExecResult, Runtime } from './runtime.ts'

/** What Herdr said no to, or could not be asked. `code` is Herdr's own error code. */
export class HerdrError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'HerdrError'
    this.code = code
  }
  /** 2 when the target does not exist or Herdr could not be reached; 1 when it refused. */
  get exit(): 1 | 2 {
    return /_not_found$|^not_found$|^timeout$|^server_not_running$|^unreachable$|^not-json$|^usage$/.test(this.code) ? 2 : 1
  }
}

export type Json = Record<string, unknown>

/** The `.result` object of a response, or a HerdrError. An empty stdout with exit 0 is `{}` (report-metadata, pane run). */
export function parseHerdr(r: ExecResult): Json {
  if (r.code === 0) {
    const text = r.stdout.trim()
    if (!text) return {}
    let doc: unknown
    try {
      doc = JSON.parse(text)
    } catch {
      throw new HerdrError('not-json', `herdr did not answer with JSON: ${text.slice(0, 200)}`)
    }
    const result = (doc as Json)?.['result']
    return result && typeof result === 'object' ? (result as Json) : {}
  }
  const err = r.stderr.trim()
  try {
    const doc = JSON.parse(err) as Json
    const e = doc['error'] as Json | undefined
    if (e && typeof e['code'] === 'string') throw new HerdrError(e['code'], typeof e['message'] === 'string' ? e['message'] : e['code'])
  } catch (e) {
    if (e instanceof HerdrError) throw e
  }
  if (r.code === 2) throw new HerdrError('usage', `herdr refused the arguments: ${err || r.stdout.trim()}`)
  throw new HerdrError('unreachable', `herdr could not be asked (exit ${r.code}): ${err || r.stdout.trim() || 'no output'}`)
}

/** The Herdr client: every call is one `exec` of `herdr` in the container. */
export interface Herdr {
  /** A control command; the `.result` object. */
  call(args: string[]): Promise<Json>
  /** A command that prints text, such as `pane read`. */
  text(args: string[]): Promise<string>
}

export function createHerdr(runtime: Runtime, container: string): Herdr {
  return {
    async call(args) {
      return parseHerdr(await runtime.exec(container, ['herdr', ...args]))
    },
    async text(args) {
      const r = await runtime.exec(container, ['herdr', ...args])
      if (r.code !== 0) parseHerdr(r)
      return r.stdout
    }
  }
}

// The slices of Herdr's objects this tool reads. Everything else is ignored.

export interface WorkspaceInfo {
  workspace_id: string
  label: string
  agent_status: string
  tokens: Record<string, string>
  worktree: { checkout_path: string; repo_name: string; repo_root: string; is_linked_worktree: boolean } | null
}

export interface PaneInfo {
  pane_id: string
  workspace_id: string
  agent: string | null
  agent_status: string
  cwd: string | null
}

export interface AgentInfo {
  name: string | null
  agent: string | null
  agent_status: string
  pane_id: string
  workspace_id: string
}

export interface WorktreeInfo {
  path: string
  branch: string | null
  open_workspace_id: string | null
  is_linked_worktree: boolean
}

const str = (o: Json, k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null)

export function asWorkspace(o: Json): WorkspaceInfo {
  const wt = o['worktree'] && typeof o['worktree'] === 'object' ? (o['worktree'] as Json) : null
  const tokens = o['tokens'] && typeof o['tokens'] === 'object' ? (o['tokens'] as Record<string, string>) : {}
  return {
    workspace_id: str(o, 'workspace_id') ?? '',
    label: str(o, 'label') ?? '',
    agent_status: str(o, 'agent_status') ?? 'unknown',
    tokens,
    worktree: wt
      ? { checkout_path: str(wt, 'checkout_path') ?? '', repo_name: str(wt, 'repo_name') ?? '', repo_root: str(wt, 'repo_root') ?? '', is_linked_worktree: wt['is_linked_worktree'] === true }
      : null
  }
}

export function asPane(o: Json): PaneInfo {
  return { pane_id: str(o, 'pane_id') ?? '', workspace_id: str(o, 'workspace_id') ?? '', agent: str(o, 'agent'), agent_status: str(o, 'agent_status') ?? 'unknown', cwd: str(o, 'cwd') }
}

export function asAgent(o: Json): AgentInfo {
  return { name: str(o, 'name'), agent: str(o, 'agent'), agent_status: str(o, 'agent_status') ?? 'unknown', pane_id: str(o, 'pane_id') ?? '', workspace_id: str(o, 'workspace_id') ?? '' }
}

export function asWorktree(o: Json): WorktreeInfo {
  return { path: str(o, 'path') ?? '', branch: str(o, 'branch'), open_workspace_id: str(o, 'open_workspace_id'), is_linked_worktree: o['is_linked_worktree'] === true }
}

export const items = (r: Json, key: string): Json[] => (Array.isArray(r[key]) ? (r[key] as Json[]) : [])
export const object = (r: Json, key: string): Json => (r[key] && typeof r[key] === 'object' ? (r[key] as Json) : {})

/** A pane id is `w3:p1`; anything else names an agent. */
export const isPaneId = (target: string): boolean => /^w\d+:p\d+$/.test(target)
export const workspaceOf = (target: string): string => target.split(':')[0]!
/** The lower pane number is the earlier pane; the root pane is the first. */
export const paneNumber = (id: string): number => Number.parseInt(id.split(':p')[1] ?? '0', 10)

// A workspace per piece of work: a Herdr worktree of the clone, on its own
// branch, with what it was opened for recorded as Herdr metadata tokens so
// `list` answers from Herdr alone.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { UsageError } from './config.ts'
import { asAgent, asPane, asWorkspace, asWorktree, items, object, paneNumber, type Herdr, type PaneInfo, type WorkspaceInfo } from './herdr.ts'
import { createPodGit } from './git.ts'
import { spawnCollect } from './runtime.ts'

export const REPOS = '/repos'
export const WORKTREES = '/worktrees'

export interface OpenOptions {
  repo: string
  branch: string
  base?: string
  actor?: string
  label?: string
  set?: Record<string, string>
}

export interface Opened {
  workspace: string
  pane: string
  path: string
  branch: string
}

/** `herdr worktree create` in the clone, then the metadata tokens; prints nothing, returns the ids. */
export async function openWorkspace(herdr: Herdr, reposDir: string, opts: OpenOptions): Promise<Opened> {
  if (!existsSync(join(reposDir, opts.repo, '.git'))) throw new UsageError(`no clone of ${opts.repo} under ${reposDir}; run \`pod repo add ${opts.repo}\``)
  const podGit = createPodGit({ reposDir, run: spawnCollect })
  const current = (await spawnCollect('git', ['-C', join(reposDir, opts.repo), 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || null
  const base = opts.base ?? current ?? null
  const args = ['worktree', 'create', '--cwd', `${REPOS}/${opts.repo}`, '--branch', opts.branch, '--label', opts.label ?? opts.branch, '--no-focus', '--trust-repository']
  if (base) args.splice(6, 0, '--base', base)
  const r = await herdr.call(args)
  const ws = asWorkspace(object(r, 'workspace'))
  const pane = asPane(object(r, 'root_pane'))
  const wt = asWorktree(object(r, 'worktree'))
  const tokens = ['--token', `repo=${opts.repo}`, '--token', `branch=${opts.branch}`]
  if (opts.actor) tokens.push('--token', `actor=${opts.actor}`)
  if (base) tokens.push('--token', `base=${base}`)
  for (const [k, v] of Object.entries(opts.set ?? {})) tokens.push('--token', `${k}=${v}`)
  await herdr.call(['workspace', 'report-metadata', ws.workspace_id, '--source', 'pod', ...tokens])
  const facts: Record<string, string> = {}
  if (base) facts['base'] = base
  if (opts.actor) facts['actor'] = opts.actor
  Object.assign(facts, opts.set ?? {})
  if (Object.keys(facts).length) await podGit.setBranchFacts(opts.repo, opts.branch, facts)
  return { workspace: ws.workspace_id, pane: pane.pane_id, path: wt.path || ws.worktree?.checkout_path || '', branch: wt.branch ?? opts.branch }
}

export interface WorkspaceView {
  id: string
  label: string
  /** From the metadata tokens `open` wrote, or the worktree Herdr reports. */
  repo: string | null
  branch: string | null
  actor: string | null
  path: string | null
  /** False for the clone itself, which Herdr opens as a workspace of its own when the first worktree is created. */
  linked: boolean
  status: string
  tokens: Record<string, string>
  git?: {
    branch: string
    base: string | null
    head: string | null
    subject: string | null
    ahead: number | null
    behind: number | null
    changedFiles: number | null
    lastCommitAt: string | null
  }
  agents: { name: string | null; kind: string | null; pane: string; state: string }[]
  panes: { id: string; agent: string | null; state: string; cwd: string | null }[]
}

/** `workspace list`, `agent list`, `pane list` and one `worktree list` per repository, joined on ids. */
export async function listWorkspaces(herdr: Herdr): Promise<WorkspaceView[]> {
  const workspaces = items(await herdr.call(['workspace', 'list']), 'workspaces').map(asWorkspace)
  if (!workspaces.length) return []
  const agents = items(await herdr.call(['agent', 'list']), 'agents').map(asAgent)
  const panes = items(await herdr.call(['pane', 'list']), 'panes').map(asPane)
  const branches = new Map<string, string | null>()
  const roots = [...new Set(workspaces.map((w) => w.worktree?.repo_root).filter((r): r is string => !!r))]
  for (const root of roots) {
    try {
      for (const wt of items(await herdr.call(['worktree', 'list', '--cwd', root, '--trust-repository']), 'worktrees').map(asWorktree)) branches.set(wt.path, wt.branch)
    } catch {
      // a repository Herdr cannot list leaves its branches to the tokens
    }
  }
  return workspaces.map((w) => {
    const path = w.worktree?.checkout_path ?? null
    return {
      id: w.workspace_id,
      label: w.label,
      repo: w.tokens['repo'] ?? w.worktree?.repo_name ?? null,
      branch: w.tokens['branch'] ?? (path ? branches.get(path) ?? null : null),
      actor: w.tokens['actor'] ?? null,
      path,
      linked: w.worktree?.is_linked_worktree ?? false,
      status: w.agent_status,
      tokens: w.tokens,
      agents: agents.filter((a) => a.workspace_id === w.workspace_id).map((a) => ({ name: a.name, kind: a.agent, pane: a.pane_id, state: a.agent_status })),
      panes: panes
        .filter((p) => p.workspace_id === w.workspace_id)
        .sort((a, b) => paneNumber(a.pane_id) - paneNumber(b.pane_id))
        .map((p) => ({ id: p.pane_id, agent: p.agent, state: p.agent_status, cwd: p.cwd }))
    }
  })
}

/** `workspace get`, as the slice this tool reads. */
export async function getWorkspace(herdr: Herdr, id: string): Promise<WorkspaceInfo> {
  return asWorkspace(object(await herdr.call(['workspace', 'get', id]), 'workspace'))
}

/** The workspace's first pane, the idle shell Herdr made; `start` and `run` split from it. */
export async function rootPane(herdr: Herdr, id: string): Promise<PaneInfo> {
  const panes = items(await herdr.call(['pane', 'list', '--workspace', id]), 'panes').map(asPane)
  const root = panes.sort((a, b) => paneNumber(a.pane_id) - paneNumber(b.pane_id))[0]
  if (!root) throw new UsageError(`workspace ${id} has no pane`)
  return root
}

/** Close the workspace; the worktree goes with it unless kept. */
export async function closeWorkspace(herdr: Herdr, id: string, opts: { keepWorktree: boolean; force: boolean }): Promise<'closed' | 'removed'> {
  if (opts.keepWorktree) {
    await herdr.call(['workspace', 'close', id])
    return 'closed'
  }
  await herdr.call(['worktree', 'remove', '--workspace', id, ...(opts.force ? ['--force'] : []), '--trust-repository'])
  return 'removed'
}

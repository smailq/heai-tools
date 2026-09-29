// The container and its workspaces, from `heai-pod status --json` and, when the
// container and Herdr are up, `heai-pod list --json`.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { message, run, which } from './run.ts'

export interface PodStatus {
  container: { name: string; state: string; running: boolean; image: string } | null
  herdr: { running: boolean; version: string } | null
  workspaces: number | null
  agents: Record<string, number> | null
}

export interface Workspace {
  id: string
  label: string
  repo: string | null
  branch: string | null
  actor: string | null
  path: string | null
  /** False for the clone itself, which Herdr opens as a workspace when the first worktree is created. */
  linked: boolean
  status: string
  tokens: Record<string, string> | null
  agents: Array<{ name: string; kind: string; pane: string; state: string }> | null
  panes: Array<{ id: string; agent: string | null; state: string; cwd: string }> | null
}

export interface PodResult {
  status: PodStatus | null
  workspaces: Workspace[]
  note: string
  failed: boolean
  at: number
}

export const podUp = (s: PodStatus | null): boolean => !!(s?.container?.running && s.herdr?.running)

/** "heai-workshop running · herdr 0.9.0", "heai-workshop stopped", "no container". */
export function podSummary(s: PodStatus | null): string {
  if (!s?.container) return 'no container'
  let out = `${s.container.name} ${s.container.state}`
  if (!s.container.running) return out
  if (!s.herdr?.running) out += ' · herdr not running'
  else out += s.herdr.version ? ` · herdr ${s.herdr.version}` : ' · herdr running'
  return out
}

/** Linked workspaces by their rolled-up state, most first. */
export function byStatus(list: Workspace[]): Array<[string, number]> {
  const c = new Map<string, number>()
  for (const w of list) if (w.linked) c.set(w.status, (c.get(w.status) ?? 0) + 1)
  return [...c].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
}

export const agentText = (w: Workspace): string => (w.agents ?? []).map((a) => `${a.kind} ${a.name}`.trim()).join(', ')

/** Whether pod has anything here: pod.yaml, pod/, or HEAI_POD_STATE. `pod status` creates pod/ when absent. */
export function podConfigured(project: string): string {
  if (process.env['HEAI_POD_STATE']) return ''
  if (!project) return 'no project directory, so nowhere to look for pod.yaml'
  if (existsSync(join(project, 'pod.yaml')) || existsSync(join(project, 'pod'))) return ''
  return 'not configured here (no pod.yaml or pod/ in the project)'
}

export async function pollPod(project: string, now: number): Promise<PodResult> {
  const r: PodResult = { status: null, workspaces: [], note: '', failed: false, at: now }
  const bin = which('heai-pod')
  if (!bin) return { ...r, note: 'heai-pod not on PATH' }
  const why = podConfigured(project)
  if (why) return { ...r, note: why }
  const dir = project ? ['--dir', project] : []
  try {
    // status exits 1 with its JSON when the container or Herdr is down: an answer, not a failure.
    r.status = JSON.parse(await run(bin, ['status', '--json', ...dir], { name: 'pod', exit1OK: true })) as PodStatus
    if (podUp(r.status)) r.workspaces = JSON.parse(await run(bin, ['list', '--json', ...dir], { name: 'pod' })) as Workspace[]
  } catch (e) {
    return { ...r, note: message(e), failed: true }
  }
  return r
}

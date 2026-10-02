// The container and its work queue, from `heai-pod status --json` for the
// container and the queue's counts, and `heai-pod list --json` for every job -
// queued, running and done. The queue is files on the host, so the list is
// asked whether or not the container is up. A job's page asks
// `heai-pod show <job> --json` for the tail of its output.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { message, run, which } from './run.ts'

export interface PodStatus {
  /** Null when the container does not exist. */
  container: { name: string; state: string; running: boolean; image: string } | null
  queue: { queued: number; running: number; done: number; byStatus: Record<string, number> }
}

export interface Job {
  name: string
  /** Where it sits: queued, running or done. */
  place: string
  /** The job's directory on the host. */
  path: string
  claim?: { worker: string; started: string } | null
  result?: {
    job: string
    status: string
    exit: number
    signal?: string
    error?: string
    started: string
    finished: string
    duration_ms: number
    worker: string
  } | null
}

/** `heai-pod show <job> --json`: the job, and the last lines of its stdout and stderr. */
export interface JobOutput extends Job {
  stdout: string
  stderr: string
}

export interface PodResult {
  status: PodStatus | null
  jobs: Job[]
  note: string
  failed: boolean
  at: number
}

export const podUp = (s: PodStatus | null): boolean => !!s?.container?.running

/** "heai-workshop running", "heai-workshop stopped", "no container". */
export const podSummary = (s: PodStatus | null): string => (s?.container ? `${s.container.name} ${s.container.state}` : 'no container')

/** The queue in one phrase: "1 running · 2 queued · 3 done". */
export const queueText = (s: PodStatus | null): string => (s ? `${s.queue.running} running · ${s.queue.queued} queued · ${s.queue.done} done` : '')

/** What the state column shows: the result's status once done, else the place. */
export const jobState = (j: Job): string => (j.place === 'done' ? (j.result?.status ?? 'no result') : j.place)
/** Who has or had the job. */
export const jobWorker = (j: Job): string => j.result?.worker ?? j.claim?.worker ?? ''
/** When the job was claimed. */
export const jobStarted = (j: Job): string => j.result?.started ?? j.claim?.started ?? ''
export const jobExit = (j: Job): string => (j.result ? String(j.result.exit) : '')

/** Pod's own shape for a duration: seconds with one decimal under a minute, then 1m31s, then 1h2m. */
export function podDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

export const jobDuration = (j: Job): string => (j.result ? podDuration(j.result.duration_ms) : '')

/** Counts by a key, most first then by name. */
export function countBy(values: string[]): Array<[string, number]> {
  const c = new Map<string, number>()
  for (const v of values) c.set(v, (c.get(v) ?? 0) + 1)
  return [...c].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
}

/** Whether pod has anything here: pod.yaml, pod/, or HEAI_POD_STATE. `pod status` creates pod/ when absent. */
export function podConfigured(project: string): string {
  if (process.env['HEAI_POD_STATE']) return ''
  if (!project) return 'no project directory, so nowhere to look for pod.yaml'
  if (existsSync(join(project, 'pod.yaml')) || existsSync(join(project, 'pod'))) return ''
  return 'not configured here (no pod.yaml or pod/ in the project)'
}

export async function pollPod(project: string, now: number): Promise<PodResult> {
  const r: PodResult = { status: null, jobs: [], note: '', failed: false, at: now }
  const bin = which('heai-pod')
  if (!bin) return { ...r, note: 'heai-pod not on PATH' }
  const why = podConfigured(project)
  if (why) return { ...r, note: why }
  const dir = project ? ['--dir', project] : []
  let statusErr = ''
  try {
    // status exits 1 with its JSON when the container is down: an answer, not a failure.
    r.status = JSON.parse(await run(bin, ['status', '--json', ...dir], { name: 'pod', exit1OK: true })) as PodStatus
  } catch (e) {
    // A runtime that cannot be asked says nothing of the queue, which is files on the host: list it anyway.
    statusErr = message(e)
  }
  try {
    r.jobs = JSON.parse(await run(bin, ['list', '--json', ...dir], { name: 'pod' })) as Job[]
  } catch (e) {
    return { ...r, note: message(e), failed: true }
  }
  return statusErr ? { ...r, note: statusErr } : r
}

/** `heai-pod show <job> --json --lines 40`, for a job pod listed. */
export async function showJob(project: string, name: string): Promise<JobOutput> {
  const bin = which('heai-pod')
  if (!bin) throw new Error('heai-pod not on PATH')
  return JSON.parse(await run(bin, ['show', name, '--json', '--lines', '40', ...(project ? ['--dir', project] : [])], { name: 'pod' })) as JobOutput
}

// The one reading every page is drawn from: the tracker on one clock, and flow,
// pod and reactor on a slower one, as the terminal screen reads them. It holds
// the last answer of each and nothing else; a tool that fails keeps its last
// answer, marked old.

import { mapPath, projectDir, type Env } from './discover.ts'
import { pollFlows, type FlowsResult } from './flows.ts'
import { resolveOwners, type Owners } from './owners.ts'
import { pollPod, type PodResult } from './pod.ts'
import { pollReactor, type ReactorResult } from './reactor.ts'
import { loadTracker, type Tracker } from './tracker.ts'
import { message } from './run.ts'
import { statSync } from 'node:fs'

export interface Options {
  tasksDir: string
  /** --map, HEAI_MAP or HEAI_DIR's map, already resolved; "" means the tracker's config, else the convention. */
  mapOverride: string
  env: Env
  cwd: string
  /** The tracker's clock, ms. */
  interval: number
  /** The clock for flow, pod and reactor, ms. */
  poll: number
  now?: () => number
}

export interface Reading {
  tracker: Tracker | null
  /** Why the tracker could not be read, when it could not. */
  trackerError: string
  map: string
  owners: Owners
  flows: FlowsResult
  pod: PodResult
  reactor: ReactorResult
  project: string
  at: number
}

export function emptyReading(): Reading {
  return {
    tracker: null,
    trackerError: '',
    map: '',
    owners: { owners: {}, repos: [], note: '', mapMtime: 0 },
    flows: { definitions: [], flows: [], stuck: [], note: '', failed: false, at: 0 },
    pod: { status: null, workspaces: [], note: '', failed: false, at: 0 },
    reactor: { status: null, events: [], note: '', failed: false, at: 0 },
    project: '',
    at: 0
  }
}

export class Reader {
  reading: Reading = emptyReading()
  readonly opts: Options
  private timers: NodeJS.Timeout[] = []
  private slowBusy = false
  private trackerBusy = false

  constructor(opts: Options) {
    this.opts = opts
  }

  now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  /** Reads everything once, then keeps reading until stop. Rejects when there is no tracker at all. */
  async start(): Promise<void> {
    await this.readTracker()
    if (!this.reading.tracker) throw new Error(this.reading.trackerError)
    await this.readSlow()
    this.timers.push(setInterval(() => void this.readTracker(), this.opts.interval))
    this.timers.push(setInterval(() => void this.readSlow(), this.opts.poll))
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }

  async readTracker(): Promise<void> {
    if (this.trackerBusy) return
    this.trackerBusy = true
    try {
      const prev = this.reading
      const at = this.now()
      let tracker: Tracker | null = prev.tracker
      let trackerError = ''
      try {
        tracker = loadTracker(this.opts.tasksDir)
      } catch (e) {
        // Keep the last tracker, and say it is old.
        trackerError = message(e)
      }
      const map = this.opts.mapOverride || mapPath(undefined, {}, tracker?.map ?? '', this.opts.cwd)
      let owners = prev.owners
      let mtime = 0
      try {
        mtime = map ? statSync(map).mtimeMs : 0
      } catch {
        mtime = 0
      }
      // architect is asked again only when the map moved, since validation is not free.
      if (map !== prev.map || mtime !== prev.owners.mapMtime) owners = await resolveOwners(map)
      const project = projectDir(this.opts.env, map, this.opts.tasksDir, this.opts.cwd)
      this.reading = { ...this.reading, tracker, trackerError, map, owners, project, at }
    } finally {
      this.trackerBusy = false
    }
  }

  async readSlow(): Promise<void> {
    if (this.slowBusy) return
    this.slowBusy = true
    try {
      const { map, project } = this.reading
      const now = this.now()
      const [fl, po, re] = await Promise.all([pollFlows(map, now), pollPod(project, now), pollReactor(project, now)])
      const r = this.reading
      const flows = fl.failed && (r.flows.flows.length || r.flows.stuck.length) ? { ...r.flows, note: fl.note, failed: true } : fl
      const pod = po.failed && r.pod.status ? { ...r.pod, note: po.note, failed: true } : po
      const reactor = re.failed && r.reactor.status ? { ...r.reactor, note: re.note, failed: true } : re
      this.reading = { ...this.reading, flows, pod, reactor }
    } finally {
      this.slowBusy = false
    }
  }
}

// The one reading every page is drawn from: the tracker on one clock, and flow,
// pod and reactor on a slower one, as the terminal screen reads them. It holds
// the last answer of each and nothing else; a tool that fails keeps its last
// answer, marked old. Which tools the project has at all is looked for on the
// tracker's clock, so a tab comes on soon after its tool's files appear.

import { mapPath, projectDir, type Env } from './discover.ts'
import { flowConfigured, pollFlows, type FlowsResult } from './flows.ts'
import { podConfigured, pollPod, type PodResult } from './pod.ts'
import { pollReactor, reactorConfigured, type ReactorResult } from './reactor.ts'
import { emptyTerritories, resolveTerritories, type Territories } from './territories.ts'
import { loadTracker, NotATracker, type Tracker } from './tracker.ts'
import { message } from './run.ts'
import { statSync } from 'node:fs'

/** The tools, in the order of their tabs. */
export const TOOLS = ['architect', 'tasks', 'flows', 'pod', 'reactor'] as const
export type Tool = (typeof TOOLS)[number]

/** Why each tool's tab is off: what was looked for in the project and not found; "" for a tool that is there. */
export type Absent = Record<Tool, string>

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
  /** What architect says the map declares; asked again only when the map moves. */
  territories: Territories
  flows: FlowsResult
  pod: PodResult
  reactor: ReactorResult
  absent: Absent
  project: string
  at: number
}

export function emptyReading(): Reading {
  return {
    tracker: null,
    trackerError: '',
    map: '',
    territories: emptyTerritories(),
    flows: { definitions: [], flows: [], stuck: [], note: '', failed: false, at: 0 },
    pod: { status: null, jobs: [], note: '', failed: false, at: 0 },
    reactor: { status: null, events: [], note: '', failed: false, at: 0 },
    absent: { architect: '', tasks: '', flows: '', pod: '', reactor: '' },
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

  /** Reads everything once, then keeps reading until stop. Rejects when the project has none of the tools. */
  async start(): Promise<void> {
    await this.readTracker()
    const { absent, project } = this.reading
    if (TOOLS.every((t) => absent[t])) {
      throw new Error(`${project}: nothing to show here - no map, tasks/items/, flow/, pod/ or reactor/; name the project with --dir`)
    }
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
      let noTracker = ''
      try {
        tracker = loadTracker(this.opts.tasksDir)
      } catch (e) {
        trackerError = message(e)
        // A tracker that is not there is dropped; one that could not be read is kept, and said to be old.
        if (e instanceof NotATracker) {
          tracker = null
          noTracker = `not configured here (no items/ in ${this.opts.tasksDir})`
        }
      }
      const map = this.opts.mapOverride || mapPath(undefined, {}, tracker?.map ?? '', this.opts.cwd)
      let territories = prev.territories
      let mtime = 0
      let noMap = map ? '' : 'not configured here (no architecture.yaml in the project)'
      try {
        mtime = map ? statSync(map).mtimeMs : 0
      } catch {
        mtime = 0
        noMap = `not configured here (no map at ${map})`
      }
      // architect is asked again only when the map moved, since validation is not free.
      if (map !== prev.map || mtime !== prev.territories.mapMtime) territories = await resolveTerritories(map)
      const project = projectDir(this.opts.env, map, this.opts.tasksDir, this.opts.cwd)
      const absent: Absent = { architect: noMap, tasks: noTracker, flows: flowConfigured(map), pod: podConfigured(project), reactor: reactorConfigured(project) }
      this.reading = { ...this.reading, tracker, trackerError, map, territories, absent, project, at }
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

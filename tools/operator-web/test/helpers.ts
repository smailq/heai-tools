// A server over the recorded outputs of the sibling tools, asking none of them;
// and, for the tests that validate, architect on PATH from this repository's sources.

import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Definition, Flow, Stuck, Timeline } from '../src/flows.ts'
import type { Job, JobOutput, PodStatus } from '../src/pod.ts'
import { loadAgents } from '../src/agents.ts'
import { emptyReading, Reader, type Reading } from '../src/reader.ts'
import { newestFirst, type Event, type ReactorStatus } from '../src/reactor.ts'
import { createApp } from '../src/server.ts'
import { loadTracker } from '../src/tracker.ts'

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
export const fixture = <T>(...parts: string[]): T => JSON.parse(readFileSync(join(FIXTURES, ...parts), 'utf8')) as T

/** The minute the flow fixtures were recorded against, so ages are stable. */
export const NOW = Date.UTC(2026, 8, 9, 13, 41, 0)

export function fixtureReading(): Reading {
  return {
    ...emptyReading(),
    tracker: loadTracker(join(FIXTURES, 'tracker')),
    map: '/repo/architecture.yaml',
    territories: { names: ['core', 'desktop', 'ui'], note: '', mapMtime: 0 },
    flows: {
      definitions: fixture<Definition[]>('flow', 'definitions.json'),
      flows: fixture<Flow[]>('flow', 'list.json'),
      stuck: fixture<Stuck[]>('flow', 'stuck.json'),
      note: '',
      failed: false,
      at: NOW
    },
    pod: { status: fixture<PodStatus>('pod', 'status.json'), jobs: fixture<Job[]>('pod', 'list.json'), note: '', failed: false, at: NOW },
    reactor: { status: fixture<ReactorStatus>('reactor', 'status.json'), events: newestFirst(fixture<Event[]>('reactor', 'events.json')), note: '', failed: false, at: NOW },
    agents: loadAgents(FIXTURES),
    project: '/repo',
    at: NOW
  }
}

export interface Served {
  url: string
  reader: Reader
  close: () => Promise<void>
}

/** A server over a reading, on a free port; its reader never polls. */
export async function serve(reading: Reading, opts: { allowHosts?: string[] } = {}): Promise<Served> {
  const reader = new Reader({ tasksDir: '/repo/tasks', mapOverride: reading.map, env: {}, cwd: '/repo', interval: 2000, poll: 5000, now: () => NOW })
  reader.reading = reading
  const server = createApp(reader, {
    ...opts,
    trace: async (): Promise<Timeline> => fixture<Timeline>('flow', 'trace.json'),
    // `heai-pod show <job> --json`: the job as list printed it, and its output's tail.
    show: async (_project, name): Promise<JobOutput> => ({ ...fixture<Job[]>('pod', 'list.json').find((j) => j.name === name)!, stdout: 'merging two entities\n', stderr: 'exit 3: conflict in core\n' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    reader,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

export async function get(url: string): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(url, { redirect: 'manual' })
  return { status: res.status, body: await res.text(), headers: res.headers }
}

export async function send(method: string, url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    json = { text }
  }
  return { status: res.status, json }
}

const ARCHITECT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'architect')

/**
 * Puts heai-architect on PATH, run from this repository's sources as the sample project
 * does, and says whether it could: architect's own dependencies must be installed.
 */
export function architectOnPath(): boolean {
  if (!existsSync(join(ARCHITECT, 'node_modules', 'yaml'))) return false
  const bin = mkdtempSync(join(tmpdir(), 'operator-web-bin-'))
  const script = join(bin, 'heai-architect')
  writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" "${join(ARCHITECT, 'src', 'cli.ts')}" "$@"\n`)
  chmodSync(script, 0o755)
  process.env['PATH'] = bin + delimiter + (process.env['PATH'] ?? '')
  return true
}

/** A request under a Host header of the test's choosing, which fetch does not allow. */
export function underHost(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { host } }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

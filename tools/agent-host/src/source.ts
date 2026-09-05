// The source plugin: everything the host needs from "the code" and nothing
// about how it is versioned.
//
// The map says a repository is a named, path-addressable tree and assumes no
// version-control system, and neither does the host. What it needs is small:
// a checkout per actor to mount, a name for the ref a run works on, a way to
// put the checkout on that ref before a run and to bring the work home after,
// and the list of paths the run changed, which is what the gate judges. A
// plugin answers those; `git` is the built-in one, `plain` works on a bare
// directory copy, and `agent-host.yaml` can name a module of its own.

import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { UsageError } from './map.ts'

export interface SourceRun {
  id: string
  actor: string
  /** The tracker slug, or null for a free-form prompt. */
  slug: string | null
  /** The ref this run works on, from `refFor`. */
  ref: string
}

export interface SourceOptions {
  /** The repository's checkout on this machine, from the map. */
  repoRoot: string
  /** Where per-actor checkouts live: `<state>/checkouts`. */
  checkoutsDir: string
  /** The base the configuration names - a branch for git, whatever it means to another source. */
  base: string
  /** The state directory, for anything else a source needs to remember. */
  stateDir: string
}

export interface SourceFinish {
  /** Repo-root-relative paths the run changed against the base; what the gate judges. */
  changed: string[]
  /** Paths the run left unrecorded - uncommitted, for a source that has commits. */
  dirty: string[]
  /** Why the work could not be brought home, when it could not. */
  problem: string | null
}

export interface Source {
  /** A short name, shown in `status --json` and the README. */
  name: string
  /** The name of the ref a run for `slug` works on, e.g. `agent/<actor>/<slug>`. Stable, so a resumed task finds its own. */
  refFor(actor: string, slug: string): string
  /** Ensure the actor's checkout exists; it is mounted at /work. */
  prepare(actor: string): Promise<{ checkout: string; created: boolean }>
  /** Environment the container gets, so what the agent records is attributed to the actor. */
  env(actor: string): Record<string, string>
  /** Lines for the prompt's "How to work" section: how to record work under this source. */
  rules(run: SourceRun): string[]
  /** Put the checkout on the run's ref, from the base - or back on it, when the run resumes. Null when ready, else why not. */
  begin(run: SourceRun): Promise<string | null>
  /** After the run: bring the work home, and say what changed. */
  finish(run: SourceRun): Promise<SourceFinish>
}

export type SourceFactory = (options: SourceOptions) => Source | Promise<Source>

const BUILT_IN: Record<string, () => Promise<{ createSource: SourceFactory }>> = {
  git: () => import('./sources/git.ts'),
  plain: () => import('./sources/plain.ts')
}

export const BUILT_IN_SOURCES = Object.keys(BUILT_IN)

/**
 * The source the configuration names: a built-in by name, or a module by
 * path (relative to the configuration's directory) exporting `createSource`
 * or a default function of the same shape.
 */
export async function loadSource(name: string, options: SourceOptions, from: string): Promise<Source> {
  let factory: SourceFactory
  if (name in BUILT_IN) {
    factory = (await BUILT_IN[name]!()).createSource
  } else {
    const path = isAbsolute(name) ? name : resolve(from, name)
    if (!existsSync(path)) {
      throw new UsageError(`source ${JSON.stringify(name)} is not built in (${BUILT_IN_SOURCES.join(', ')}) and no module exists at ${path}`)
    }
    let mod: { createSource?: unknown; default?: unknown }
    try {
      mod = (await import(pathToFileURL(path).href)) as typeof mod
    } catch (e) {
      throw new UsageError(`source module ${path} could not be loaded: ${(e as Error).message}`)
    }
    const candidate = mod.createSource ?? mod.default
    if (typeof candidate !== 'function') {
      throw new UsageError(`source module ${path} must export createSource(options) or a default function`)
    }
    factory = candidate as SourceFactory
  }
  const source = await factory(options)
  for (const method of ['refFor', 'prepare', 'env', 'rules', 'begin', 'finish'] as const) {
    if (typeof source?.[method] !== 'function') throw new UsageError(`source ${JSON.stringify(name)} has no ${method}()`)
  }
  return source
}

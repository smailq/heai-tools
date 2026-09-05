// The machinery configuration: the images and what each runs with, the base,
// the credentials file, the dispatch policy, and which image each actor runs.
// None of it belongs in the map - it is about running an actor, not about the
// architecture - so it lives in an optional `agent-host.yaml` beside the map.
//
// Resources and credentials belong to an image, not an actor: the harness is
// what needs the memory and the key, and two actors on one image should not
// be sized twice.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { parse } from 'yaml'
import { UsageError, type ArchitectureMap } from './map.ts'

export interface ImageConfig {
  envFile?: string
  cpus?: number
  memory?: string
}

export interface ActorConfig {
  image?: string
}

/** What one actor runs with, resolved. */
export interface ActorSettings {
  image: string
  envFile?: string
  cpus?: number
  memory?: string
}

export interface Config {
  /** Where it was read from, or null when there was none. */
  path: string | null
  image: string
  base: string
  envFile: string | null
  dispatch: 'manual' | 'auto'
  /** The source plugin: a built-in name (git, plain) or a module path. */
  source: string
  /** Command overrides for the sibling tools, when they are not beside this one. */
  scopeGate: string | null
  taskManager: string | null
  /** Per-image settings, keyed by image name. */
  images: Record<string, ImageConfig>
  /** Which image each actor runs, keyed by the map's actor name. */
  actors: Record<string, ActorConfig>
}

export const DEFAULT_IMAGE = 'heai/agent-claude'
export const DEFAULT_BASE = 'main'

const TOP_KEYS = ['image', 'base', 'envFile', 'dispatch', 'source', 'scopeGate', 'taskManager', 'images', 'actors']
const IMAGE_KEYS = ['envFile', 'cpus', 'memory']
const ACTOR_KEYS = ['image']

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** `~/x` and relative paths resolve against the home directory and the config's own directory. */
function resolvePath(value: string, from: string): string {
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2))
  return isAbsolute(value) ? value : resolve(from, value)
}

/** Read the configuration, or the defaults when there is no file. */
export function loadConfig(path: string, map: ArchitectureMap): Config {
  const config: Config = {
    path: null,
    image: DEFAULT_IMAGE,
    base: DEFAULT_BASE,
    envFile: null,
    dispatch: 'manual',
    source: 'git',
    scopeGate: null,
    taskManager: null,
    images: {},
    actors: {}
  }
  const abs = resolve(path)
  if (!existsSync(abs)) return config
  let doc: unknown
  try {
    doc = parse(readFileSync(abs, 'utf8'))
  } catch (e) {
    throw new UsageError(`configuration is not valid YAML: ${abs}: ${(e as Error).message}`)
  }
  if (doc === null || doc === undefined) return { ...config, path: abs }
  if (!isRecord(doc)) throw new UsageError(`configuration must be a mapping: ${abs}`)
  for (const key of Object.keys(doc)) {
    if (!TOP_KEYS.includes(key)) throw new UsageError(`unknown configuration key ${JSON.stringify(key)} in ${abs}`)
  }
  const from = resolve(abs, '..')
  const string = (key: string): string | undefined => {
    const v = doc[key]
    if (v === undefined) return undefined
    if (typeof v !== 'string' || !v) throw new UsageError(`configuration "${key}" must be a non-empty string: ${abs}`)
    return v
  }
  config.path = abs
  config.image = string('image') ?? config.image
  config.base = string('base') ?? config.base
  const envFile = string('envFile')
  if (envFile) config.envFile = resolvePath(envFile, from)
  const dispatch = string('dispatch')
  if (dispatch !== undefined) {
    if (dispatch !== 'manual' && dispatch !== 'auto') {
      throw new UsageError(`configuration "dispatch" must be manual or auto: ${abs}`)
    }
    config.dispatch = dispatch
  }
  config.source = string('source') ?? config.source
  config.scopeGate = string('scopeGate') ?? null
  config.taskManager = string('taskManager') ?? null

  if (doc['images'] !== undefined) {
    if (!isRecord(doc['images'])) throw new UsageError(`configuration "images" must be a mapping: ${abs}`)
    for (const [name, raw] of Object.entries(doc['images'])) {
      if (!isRecord(raw)) throw new UsageError(`configuration image ${JSON.stringify(name)} must be a mapping: ${abs}`)
      for (const key of Object.keys(raw)) {
        if (!IMAGE_KEYS.includes(key)) throw new UsageError(`unknown key ${JSON.stringify(key)} for image ${name} in ${abs}`)
      }
      const i: ImageConfig = {}
      if (raw['envFile'] !== undefined) {
        if (typeof raw['envFile'] !== 'string' || !raw['envFile']) throw new UsageError(`image ${name}: envFile must be a path`)
        i.envFile = resolvePath(raw['envFile'], from)
      }
      if (raw['cpus'] !== undefined) {
        if (typeof raw['cpus'] !== 'number' || !(raw['cpus'] > 0)) throw new UsageError(`image ${name}: cpus must be a positive number`)
        i.cpus = raw['cpus']
      }
      if (raw['memory'] !== undefined) {
        const m = typeof raw['memory'] === 'number' ? `${raw['memory']}M` : raw['memory']
        if (typeof m !== 'string' || !/^\d+[KMGTP]?$/i.test(m)) throw new UsageError(`image ${name}: memory must be like 8G`)
        i.memory = m
      }
      config.images[name] = i
    }
  }

  if (doc['actors'] !== undefined) {
    if (!isRecord(doc['actors'])) throw new UsageError(`configuration "actors" must be a mapping: ${abs}`)
    for (const [name, raw] of Object.entries(doc['actors'])) {
      const actor = map.actor(name)
      if (!actor) throw new UsageError(`configuration names actor ${JSON.stringify(name)}, which the map does not declare`)
      if (actor.type !== 'llm-agent') throw new UsageError(`configuration names actor ${JSON.stringify(name)}, which is not an llm-agent`)
      if (raw === null) {
        config.actors[name] = {}
        continue
      }
      if (!isRecord(raw)) throw new UsageError(`configuration actor ${JSON.stringify(name)} must be a mapping: ${abs}`)
      for (const key of Object.keys(raw)) {
        if (!ACTOR_KEYS.includes(key)) {
          const hint = IMAGE_KEYS.includes(key) ? ` - ${key} belongs to an image, under "images"` : ''
          throw new UsageError(`unknown key ${JSON.stringify(key)} for actor ${name} in ${abs}${hint}`)
        }
      }
      const a: ActorConfig = {}
      if (raw['image'] !== undefined) {
        if (typeof raw['image'] !== 'string' || !raw['image']) throw new UsageError(`actor ${name}: image must be a string`)
        a.image = raw['image']
      }
      config.actors[name] = a
    }
  }
  return config
}

/** What one actor runs with: its image, and that image's resources and credentials. */
export function actorSettings(config: Config, actor: string): ActorSettings {
  const image = config.actors[actor]?.image ?? config.image
  const own = config.images[image] ?? {}
  return {
    image,
    envFile: own.envFile ?? config.envFile ?? undefined,
    cpus: own.cpus,
    memory: own.memory
  }
}

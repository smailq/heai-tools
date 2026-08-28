// The vocabulary a tracker's `territory` field draws on, and where it comes from.
//
// `territory` is the only task field whose values belong to the repository
// rather than to this tool, so it is not hard-coded here. A tracker declares it
// in `config.yaml` beside its files; with no configuration it stays open and
// any non-empty value is accepted.
//
// Territories are not listed twice: a repository that has an architecture map
// already names them there, together with the actor that owns each one, so the
// config points at the map and the map stays the single source of ownership.

import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { parse } from 'yaml'
import type { Vocabularies, Vocabulary } from './model.ts'

export const CONFIG_FILE = 'config.yaml'

/** A problem with the invocation or the configuration, not with a task file. */
export class UsageError extends Error {}

export interface Config {
  /** Path to an architecture map, relative to the tracker directory. */
  map?: string
}

const CONFIG_KEYS = ['map'] as const

export interface VocabularySet extends Vocabularies {
  /** The configuration as declared, for reporting. */
  config: Config
  /** Where the map was read from, when one is configured. */
  mapPath: string | null
  /** The actor owning a territory, when a map names one. */
  ownerOf(territory: string): string | null
}

function readYaml(path: string, what: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new UsageError(`cannot read ${what}: ${path}`)
  }
  try {
    return parse(text)
  } catch (e) {
    throw new UsageError(`${what} is not valid YAML: ${path}: ${(e as Error).message}`)
  }
}

/** Read `<dir>/config.yaml`, or the empty configuration when there is none. */
export function loadConfig(dir: string): Config {
  const path = resolve(dir, CONFIG_FILE)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new UsageError(`cannot read configuration: ${path}`)
  }
  let doc: unknown
  try {
    doc = parse(text)
  } catch (e) {
    throw new UsageError(`configuration is not valid YAML: ${path}: ${(e as Error).message}`)
  }
  if (doc === null || doc === undefined) return {}
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new UsageError(`configuration must be a mapping: ${path}`)
  }
  const raw = doc as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.includes(key as (typeof CONFIG_KEYS)[number])) {
      throw new UsageError(`unknown configuration key ${JSON.stringify(key)} in ${path}`)
    }
  }
  const config: Config = {}
  if (raw['map'] !== undefined) {
    if (typeof raw['map'] !== 'string' || !raw['map']) {
      throw new UsageError(`configuration "map" must be a path: ${path}`)
    }
    config.map = raw['map']
  }
  return config
}

interface MapView {
  territories: string[]
  owners: Map<string, string>
}

/**
 * Read the territory names and their owners out of an architecture map.
 *
 * Only the shape this tool depends on is checked; the map's own rules belong to
 * the validator that owns them, so a map that this reads is not thereby a valid
 * map. A map that cannot be read at all is an error rather than a silent
 * fallback to an open vocabulary: a tracker that asked to be checked against a
 * map must not quietly stop being checked.
 */
function readMap(path: string): MapView {
  const doc = readYaml(path, 'architecture map')
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new UsageError(`architecture map must be a mapping: ${path}`)
  }
  const territories = (doc as Record<string, unknown>)['territories']
  if (!territories || typeof territories !== 'object' || Array.isArray(territories)) {
    throw new UsageError(`architecture map has no "territories" section: ${path}`)
  }
  const owners = new Map<string, string>()
  for (const [name, value] of Object.entries(territories as Record<string, unknown>)) {
    const owner =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)['owner']
        : undefined
    if (typeof owner === 'string' && owner) owners.set(name, owner)
  }
  return { territories: Object.keys(territories as object), owners }
}

/** Resolve the vocabulary a tracker directory's files are validated against. */
export function loadVocabularies(dir: string, config: Config = loadConfig(dir)): VocabularySet {
  let territories: Vocabulary = null
  let owners = new Map<string, string>()
  let mapPath: string | null = null

  if (config.map !== undefined) {
    mapPath = isAbsolute(config.map) ? config.map : resolve(dir, config.map)
    const view = readMap(mapPath)
    territories = view.territories
    owners = view.owners
  }

  return {
    territories,
    config,
    mapPath,
    ownerOf: (territory: string) => owners.get(territory) ?? null
  }
}

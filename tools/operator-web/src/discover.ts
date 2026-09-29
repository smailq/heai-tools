// Finding the project directory, the tracker and the map the way the other tools
// do: a flag first, then the environment, then HEAI_DIR, then the .heai/
// convention, then the legacy default in the working directory.

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'

export interface Env {
  HEAI_TASKS?: string
  HEAI_MAP?: string
  /** The project directory: the map at its root, the tracker under tasks/, each tool's state beside them. */
  HEAI_DIR?: string
}

export function envFromProcess(): Env {
  return { HEAI_TASKS: process.env['HEAI_TASKS'], HEAI_MAP: process.env['HEAI_MAP'], HEAI_DIR: process.env['HEAI_DIR'] }
}

const abs = (cwd: string, p: string): string => (isAbsolute(p) ? normalize(p) : join(cwd, p))

/** The tracker: --tasks, HEAI_TASKS, $HEAI_DIR/tasks, .heai/tasks if it exists, else tasks. */
export function tasksDir(flag: string | undefined, env: Env, cwd: string): string {
  if (flag) return abs(cwd, flag)
  if (env.HEAI_TASKS) return abs(cwd, env.HEAI_TASKS)
  if (env.HEAI_DIR) return join(abs(cwd, env.HEAI_DIR), 'tasks')
  return existsSync(join(cwd, '.heai/tasks')) ? join(cwd, '.heai/tasks') : join(cwd, 'tasks')
}

/**
 * The map: --map, HEAI_MAP, $HEAI_DIR/architecture.yaml, the tracker's own tasks.yaml
 * (passed as configured), .heai/architecture.yaml if it exists, else architecture.yaml.
 * "" only when nothing exists at all, so a missing map is a fact a page shows.
 */
export function mapPath(flag: string | undefined, env: Env, configured: string, cwd: string): string {
  if (flag) return abs(cwd, flag)
  if (env.HEAI_MAP) return abs(cwd, env.HEAI_MAP)
  if (env.HEAI_DIR) return join(abs(cwd, env.HEAI_DIR), 'architecture.yaml')
  if (configured) return abs(cwd, configured)
  for (const c of ['.heai/architecture.yaml', 'architecture.yaml']) {
    if (existsSync(join(cwd, c))) return join(cwd, c)
  }
  return ''
}

/** The project pod and reactor are asked about: HEAI_DIR, else the map's directory, else the tracker's parent. */
export function projectDir(env: Env, map: string, tasks: string, cwd: string): string {
  if (env.HEAI_DIR) return abs(cwd, env.HEAI_DIR)
  if (map) return dirname(map)
  return dirname(tasks)
}

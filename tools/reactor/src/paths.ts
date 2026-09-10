// Where this tool's own things are. Discovery is the current directory, then
// HEAI_DIR, then the flags: the configuration places the state directory
// beside itself, and the project directory is where scripts run. Where
// anything else is - a tracker, another tool's state - is the script's
// business, found from the project directory.

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface Paths {
  /** The project directory: cwd, HEAI_DIR, or --dir. Scripts run here, and every relative path in reactor.yaml resolves against it. */
  dir: string
  /** `reactor.yaml`: under `.heai/` when that directory exists in the project, else in the project directory. */
  config: string
  /** The directory the configuration sits in; the state and module sources resolve beside it. */
  configDir: string
  /** This tool's state: `reactor` beside the configuration. */
  state: string
}

export interface PathFlags {
  dir?: string | undefined
  state?: string | undefined
  config?: string | undefined
}

export function resolvePaths(flags: PathFlags, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Paths {
  const dir = resolve(cwd, flags.dir ?? env['HEAI_DIR'] ?? '.')
  const config = resolve(dir, flags.config ?? join(existsSync(join(dir, '.heai')) ? '.heai' : '.', 'reactor.yaml'))
  const configDir = dirname(config)
  return {
    dir,
    config,
    configDir,
    state: resolve(dir, flags.state ?? env['HEAI_REACTOR_STATE'] ?? join(configDir, 'reactor'))
  }
}

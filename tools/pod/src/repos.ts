// The clones under <state>/repos, made and updated by the host's git so the
// container never holds credentials for a real repository. `add` is the one
// place the map is read: repositories.<name>.localPath, then remotePath.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse } from 'yaml'
import { RefusedError, UsageError } from './config.ts'
import { spawnCollect, RuntimeError, type Spawner } from './runtime.ts'

export interface RepoInfo {
  name: string
  path: string
  source: string | null
  branch: string | null
  head: string | null
}

/** The map's `repositories.<name>`: localPath resolved against the map's directory, else remotePath. */
export function resolveSource(mapPath: string, name: string): { source: string; from: 'localPath' | 'remotePath' } | null {
  if (!existsSync(mapPath)) return null
  let doc: unknown
  try {
    doc = parse(readFileSync(mapPath, 'utf8'))
  } catch {
    return null
  }
  const repos = (doc as Record<string, unknown> | null)?.['repositories']
  const entry = repos && typeof repos === 'object' ? (repos as Record<string, unknown>)[name] : undefined
  if (!entry || typeof entry !== 'object') return null
  const e = entry as Record<string, unknown>
  if (typeof e['localPath'] === 'string') return { source: isAbsolute(e['localPath']) ? e['localPath'] : resolve(dirname(mapPath), e['localPath']), from: 'localPath' }
  if (typeof e['remotePath'] === 'string') return { source: e['remotePath'], from: 'remotePath' }
  return null
}

export interface Repos {
  add(name: string, source?: string): Promise<RepoInfo>
  list(): Promise<RepoInfo[]>
  fetch(name?: string): Promise<string[]>
  /** The clone's branch into the source checkout; where that is comes from `into`, else the map's localPath. */
  pullBranch(name: string, branch: string, into?: string): Promise<{ into: string; branch: string }>
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function createRepos(opts: { reposDir: string; mapPath: string; run?: Spawner }): Repos {
  const run = opts.run ?? spawnCollect
  const git = async (args: string[], cwd?: string) => {
    const r = await run('git', cwd ? ['-C', cwd, ...args] : args)
    if (r.code !== 0) throw new RefusedError(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`)
    return r.stdout.trim()
  }
  const quiet = async (args: string[], cwd: string): Promise<string | null> => {
    const r = await run('git', ['-C', cwd, ...args])
    return r.code === 0 ? r.stdout.trim() || null : null
  }
  const pathOf = (name: string) => {
    if (!NAME.test(name)) throw new UsageError(`a repository name is letters, digits, dots, dashes and underscores, not ${JSON.stringify(name)}`)
    return join(opts.reposDir, name)
  }
  const info = async (name: string): Promise<RepoInfo> => {
    const path = pathOf(name)
    return { name, path, source: await quiet(['remote', 'get-url', 'origin'], path), branch: await quiet(['rev-parse', '--abbrev-ref', 'HEAD'], path), head: await quiet(['rev-parse', '--short', 'HEAD'], path) }
  }
  const need = (name: string) => {
    const path = pathOf(name)
    if (!existsSync(join(path, '.git'))) throw new UsageError(`no clone of ${name} under ${opts.reposDir}; run \`pod repo add ${name}\``)
    return path
  }
  return {
    async add(name, source) {
      const path = pathOf(name)
      if (existsSync(path)) throw new RefusedError(`${path} already exists`)
      const src = source ?? resolveSource(opts.mapPath, name)?.source
      if (!src) throw new UsageError(`no source for ${name}: give one, or declare repositories.${name}.localPath or remotePath in ${opts.mapPath}`)
      try {
        await git(['clone', '--quiet', src, path])
      } catch (e) {
        if (e instanceof RuntimeError) throw new UsageError(e.message)
        throw e
      }
      return info(name)
    },
    async list() {
      if (!existsSync(opts.reposDir)) return []
      const names = readdirSync(opts.reposDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(opts.reposDir, d.name, '.git')))
        .map((d) => d.name)
        .sort()
      return Promise.all(names.map(info))
    },
    async fetch(name) {
      const names = name ? [name] : (await this.list()).map((r) => r.name)
      const notes: string[] = []
      for (const n of names) {
        const path = need(n)
        await git(['fetch', '--quiet', '--prune', 'origin'], path)
        // the checked-out branch follows its upstream so `--base main` means today's main
        const r = await run('git', ['-C', path, 'merge', '--ff-only', '--quiet', '@{u}'])
        notes.push(r.code === 0 ? `${n}: fetched, ${(await quiet(['rev-parse', '--abbrev-ref', 'HEAD'], path)) ?? 'HEAD'} at ${(await quiet(['rev-parse', '--short', 'HEAD'], path)) ?? '?'}` : `${n}: fetched; ${(r.stderr || r.stdout).trim() || 'the checked-out branch was not fast-forwarded'}`)
      }
      return notes
    },
    async pullBranch(name, branch, into) {
      const path = need(name)
      const target = into ?? (() => {
        const s = resolveSource(opts.mapPath, name)
        return s?.from === 'localPath' ? s.source : undefined
      })()
      if (!target) throw new UsageError(`nowhere to pull ${branch} into: give --into <path>, or declare repositories.${name}.localPath in ${opts.mapPath}`)
      if (!existsSync(join(target, '.git'))) throw new UsageError(`${target} is not a git repository`)
      if ((await quiet(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], path)) === null) throw new UsageError(`the clone of ${name} has no branch ${branch}`)
      await git(['fetch', '--quiet', path, `+refs/heads/${branch}:refs/heads/${branch}`], target)
      return { into: target, branch }
    }
  }
}

// A repository. Polls its branches and emits one event per new commit with
// the changed paths, plus branch-created and branch-deleted. The first poll records where every
// branch is and emits nothing, so a fresh reactor does not replay history.

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { parseDuration, type SourceConfig } from '../config.ts'
import { UsageError, ReactorError } from '../errors.ts'
import { globMatch, type RawEvent } from '../events.ts'
import { optDuration, optString, rejectUnknown, type Source, type SourceContext } from '../source.ts'

interface Cursor {
  branches: Record<string, string>
  polledAt: string | null
  error: string | null
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw new ReactorError(`git ${args[0]}: ${r.error.message}`)
  if (r.status !== 0) throw new ReactorError(`git ${args.join(' ')} exited ${r.status}: ${(r.stderr ?? '').trim()}`)
  return r.stdout
}

export function create(config: SourceConfig): Source {
  const where = `source ${config.name}`
  rejectUnknown(config.options, ['path', 'branches', 'every', 'remote', 'maxCommits'], where)
  const path = optString(config.options, 'path', where, true)!
  const remote = optString(config.options, 'remote', where)
  const every = optDuration(config.options, 'every', 60_000, parseDuration, where)
  const rawBranches = config.options['branches'] ?? ['*']
  if (!Array.isArray(rawBranches) || !rawBranches.every((b) => typeof b === 'string' && b)) throw new UsageError(`${where}: branches must be a list of names or globs`)
  const branches = rawBranches as string[]
  const maxCommits = typeof config.options['maxCommits'] === 'number' ? config.options['maxCommits'] : 200
  const watched = (name: string): boolean => branches.some((g) => globMatch(g, name))

  const heads = (cwd: string): Record<string, string> => {
    const ref = remote ? `refs/remotes/${remote}` : 'refs/heads'
    const out: Record<string, string> = {}
    for (const line of git(cwd, ['for-each-ref', '--format=%(refname)%09%(objectname)', ref]).split('\n')) {
      if (!line) continue
      const [full, sha] = line.split('\t')
      let name = full!.slice(ref.length + 1)
      if (remote && name === 'HEAD') continue
      if (watched(name)) out[name] = sha!
    }
    return out
  }

  const commit = (cwd: string, sha: string, branch: string): RawEvent => {
    const [hash, author, at, subject] = git(cwd, ['show', '--no-patch', '--format=%H%x00%an%x00%aI%x00%s', sha]).trim().split('\0')
    const paths = git(cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-m', '--first-parent', sha])
      .split('\n')
      .filter(Boolean)
    return { kind: 'commit', key: `${branch}@${hash}`, at, payload: { branch, sha: hash, author, at, subject, paths } }
  }

  return {
    name: config.name,
    type: 'git',
    every,
    listener: null,
    describe(ctx) {
      const c = ctx.cursor<Cursor>()
      const n = c ? Object.keys(c.branches).length : 0
      return `${path}${remote ? ` (${remote})` : ''}; ${n} branch${n === 1 ? '' : 'es'}; polled ${c?.polledAt ?? '-'}${c?.error ? `; PROBLEM ${c.error}` : ''}`
    },
    async poll(ctx: SourceContext): Promise<RawEvent[]> {
      const cwd = resolve(ctx.paths.dir, path)
      const cursor: Cursor = ctx.cursor<Cursor>() ?? { branches: {}, polledAt: null, error: null }
      const first = cursor.polledAt === null
      const events: RawEvent[] = []
      try {
        if (remote) git(cwd, ['fetch', '--prune', '--quiet', remote])
        const now = heads(cwd)
        for (const [name, sha] of Object.entries(now)) {
          const old = cursor.branches[name]
          if (old === undefined) {
            if (!first) events.push({ kind: 'branch-created', key: `${name}@created@${sha}`, payload: { branch: name, sha } })
            continue
          }
          if (old === sha) continue
          const shas = git(cwd, ['rev-list', '--reverse', `${old}..${sha}`])
            .split('\n')
            .filter(Boolean)
          if (shas.length > maxCommits) ctx.note(`${name} moved by ${shas.length} commits; reporting the last ${maxCommits}`)
          for (const s of shas.slice(-maxCommits)) events.push(commit(cwd, s, name))
        }
        for (const name of Object.keys(cursor.branches)) if (!(name in now)) events.push({ kind: 'branch-deleted', key: `${name}@deleted@${cursor.branches[name]}`, payload: { branch: name, sha: cursor.branches[name] } })
        cursor.branches = now
        cursor.error = null
      } catch (e) {
        cursor.error = (e as Error).message
        ctx.note(cursor.error)
      }
      cursor.polledAt = ctx.now().toISOString()
      ctx.setCursor(cursor)
      return events
    }
  }
}

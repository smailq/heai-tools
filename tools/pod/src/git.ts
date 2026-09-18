import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { RefusedError, UsageError } from './config.ts'
import { RuntimeError, spawnCollect, type Spawner } from './runtime.ts'

export interface WorkRef {
  repo: string
  branch: string
  workspace?: string
}

export interface GitSummary {
  branch: string
  base: string | null
  head: string | null
  subject: string | null
  ahead: number | null
  behind: number | null
  changedFiles: number | null
  lastCommitAt: string | null
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const keyOf = (branch: string, key: string) => `branch.${branch}.heai-${key}`

export function isWorkspaceId(v: string): boolean {
  return /^w\d+$/.test(v)
}

export function parseSet(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of pairs) {
    const i = p.indexOf('=')
    if (i <= 0 || i === p.length - 1) throw new UsageError(`--set takes key=value, not ${JSON.stringify(p)}`)
    const k = p.slice(0, i)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(k)) throw new UsageError(`--set key ${JSON.stringify(k)} is not a name`)
    out[k] = p.slice(i + 1)
  }
  return out
}

function lines(s: string): number {
  const t = s.trim()
  return t ? t.split('\n').length : 0
}

export function createPodGit(opts: { reposDir: string; run?: Spawner }) {
  const run = opts.run ?? spawnCollect
  const pathOf = (name: string) => {
    if (!NAME.test(name)) throw new UsageError(`a repository name is letters, digits, dots, dashes and underscores, not ${JSON.stringify(name)}`)
    const path = join(opts.reposDir, name)
    if (!existsSync(join(path, '.git'))) throw new UsageError(`no clone of ${name} under ${opts.reposDir}; run \`pod repo add ${name}\``)
    return path
  }
  const git = async (cwd: string, args: string[]): Promise<string> => {
    const r = await run('git', ['-C', cwd, ...args])
    if (r.code !== 0) throw new RefusedError((r.stderr || r.stdout).trim() || `git ${args[0]} failed`)
    return r.stdout.trim()
  }
  const quiet = async (cwd: string, args: string[]): Promise<string | null> => {
    const r = await run('git', ['-C', cwd, ...args])
    return r.code === 0 ? (r.stdout.trim() || null) : null
  }
  const toCount = (s: string | null): number | null => {
    if (!s) return null
    const n = Number.parseInt(s, 10)
    return Number.isFinite(n) ? n : null
  }
  return {
    async setBranchFacts(repo: string, branch: string, facts: Record<string, string>): Promise<void> {
      const path = pathOf(repo)
      for (const [k, v] of Object.entries(facts)) await git(path, ['config', keyOf(branch, k), v])
    },
    async branchFact(repo: string, branch: string, key: string): Promise<string | null> {
      return quiet(pathOf(repo), ['config', '--get', keyOf(branch, key)])
    },
    async ensureNoWorktreePrune(repo: string): Promise<void> {
      await git(pathOf(repo), ['config', 'gc.worktreePruneExpire', 'never'])
    },
    async summary(work: WorkRef, baseOverride?: string): Promise<GitSummary> {
      const path = pathOf(work.repo)
      const base = baseOverride ?? (await quiet(path, ['config', '--get', keyOf(work.branch, 'base')]))
      const head = await quiet(path, ['rev-parse', '--short', work.branch])
      const subject = await quiet(path, ['show', '-s', '--format=%s', work.branch])
      const lastCommitAt = await quiet(path, ['show', '-s', '--format=%cI', work.branch])
      const counts = base ? await quiet(path, ['rev-list', '--left-right', '--count', `${base}...${work.branch}`]) : null
      const [behindRaw, aheadRaw] = (counts ?? '').split('\t')
      const changedFiles = base ? lines(await git(path, ['diff', '--name-only', `${base}...${work.branch}`])) : null
      return {
        branch: work.branch,
        base,
        head,
        subject,
        ahead: toCount(aheadRaw ?? null),
        behind: toCount(behindRaw ?? null),
        changedFiles,
        lastCommitAt
      }
    },
    async diff(work: WorkRef, opts: { base?: string; mode: 'name-only' | 'stat' | 'patch' }): Promise<string> {
      const path = pathOf(work.repo)
      const base = opts.base ?? (await quiet(path, ['config', '--get', keyOf(work.branch, 'base')]))
      if (!base) throw new UsageError(`no base for ${work.repo} ${work.branch}; re-open with --base or set branch.${work.branch}.heai-base`)
      if ((await quiet(path, ['rev-parse', '--verify', '--quiet', base])) === null) throw new UsageError(`the clone of ${work.repo} does not have ${base}; run \`pod repo fetch ${work.repo}\``)
      const args = opts.mode === 'name-only' ? ['diff', '--name-only', `${base}...${work.branch}`] : opts.mode === 'stat' ? ['diff', '--stat', `${base}...${work.branch}`] : ['diff', `${base}...${work.branch}`]
      const r = await run('git', ['-C', path, ...args])
      if (r.code > 1) throw new RefusedError((r.stderr || r.stdout).trim() || 'git diff failed')
      return r.stdout
    },
    async log(work: WorkRef, limit = 20): Promise<Array<{ sha: string; subject: string; author: string; date: string }>> {
      const path = pathOf(work.repo)
      const base = await quiet(path, ['config', '--get', keyOf(work.branch, 'base')])
      const range = base ? `${base}..${work.branch}` : work.branch
      const out = await git(path, ['log', '--no-decorate', '--date=iso-strict', `--max-count=${Math.max(1, limit)}`, '--pretty=format:%h%x1f%s%x1f%an%x1f%cI', range])
      return out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, subject, author, date] = line.split('\x1f')
          return { sha: sha ?? '', subject: subject ?? '', author: author ?? '', date: date ?? '' }
        })
    },
    async show(work: WorkRef): Promise<{ sha: string | null; subject: string | null; author: string | null; committedAt: string | null }> {
      const path = pathOf(work.repo)
      const out = await quiet(path, ['show', '-s', '--format=%H%x1f%s%x1f%an%x1f%cI', work.branch])
      if (!out) return { sha: null, subject: null, author: null, committedAt: null }
      const [sha, subject, author, committedAt] = out.split('\x1f')
      return { sha: sha ?? null, subject: subject ?? null, author: author ?? null, committedAt: committedAt ?? null }
    }
  }
}

export type PodGit = ReturnType<typeof createPodGit>

export function asUsageError(e: unknown): UsageError {
  if (e instanceof UsageError) return e
  if (e instanceof RuntimeError) return new UsageError(e.message)
  if (e instanceof RefusedError) return new UsageError(e.message)
  return new UsageError(e instanceof Error ? e.message : String(e))
}

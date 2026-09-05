// The git source: a clone per actor, a branch per task, and the branch
// fetched back into the repository when a run ends.
//
// A clone rather than a worktree because a worktree's `.git` file points at
// the host's absolute path, which does not exist inside the container; a
// clone is self-contained, and its `origin` is the repository on the host,
// which the agent cannot reach - so an agent can commit all it likes and
// never touch the repository's own refs.

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { UsageError } from '../map.ts'
import type { Source, SourceOptions, SourceRun } from '../source.ts'
import { git, gitOk } from '../tools.ts'

export function createSource(options: SourceOptions): Source {
  const { repoRoot, checkoutsDir, base } = options
  const baseRef = `origin/${base}`
  const checkoutOf = (actor: string) => join(checkoutsDir, actor)

  return {
    name: 'git',

    refFor: (actor, slug) => `agent/${actor}/${slug}`,

    async prepare(actor) {
      const checkout = checkoutOf(actor)
      if (existsSync(join(checkout, '.git'))) return { checkout, created: false }
      if (!(await gitOk(repoRoot, 'rev-parse', '--git-dir'))) {
        throw new UsageError(`the repository at ${repoRoot} is not a git checkout`)
      }
      await git(repoRoot, 'clone', '-q', '--no-hardlinks', repoRoot, checkout)
      // Commits inside the container are the actor's, whatever the image sets up.
      await git(checkout, 'config', 'user.name', actor)
      await git(checkout, 'config', 'user.email', `${actor}@heai`)
      if (!(await gitOk(checkout, 'rev-parse', '--verify', '-q', baseRef))) {
        rmSync(checkout, { recursive: true, force: true })
        throw new UsageError(`the repository has no branch ${base} to base runs on (set "base" in agent-host.yaml)`)
      }
      await git(checkout, 'checkout', '-q', '--detach', baseRef)
      return { checkout, created: true }
    },

    env: (actor) => ({
      GIT_AUTHOR_NAME: actor,
      GIT_COMMITTER_NAME: actor,
      GIT_AUTHOR_EMAIL: `${actor}@heai`,
      GIT_COMMITTER_EMAIL: `${actor}@heai`
    }),

    rules: (run) => [
      `You are on branch \`${run.ref}\` in \`/work\`. Commit your work there with clear messages; do not switch branches, push, or merge.`
    ],

    async begin(run) {
      const checkout = checkoutOf(run.actor)
      await git(checkout, 'fetch', '-q', '--prune', 'origin')
      // Whatever the previous run left uncommitted is kept, not discarded.
      const dirty = (await git(checkout, 'status', '--porcelain')).trim()
      if (dirty) await git(checkout, 'stash', 'push', '-u', '-q', '-m', `agent-host: left uncommitted before ${run.id}`)
      const existing = await gitOk(checkout, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${run.ref}`)
      if (!existing) {
        await git(checkout, 'checkout', '-q', '-B', run.ref, baseRef)
        return null
      }
      // A resumed task continues its own branch, rebased so the landed work is under it.
      await git(checkout, 'checkout', '-q', '-B', run.ref, `origin/${run.ref}`)
      if (await gitOk(checkout, 'rebase', '-q', baseRef)) return null
      await gitOk(checkout, 'rebase', '--abort')
      return `rebasing ${run.ref} onto ${baseRef} conflicts; resolve it by hand and assign again`
    },

    async finish(run) {
      const checkout = checkoutOf(run.actor)
      let problem: string | null = null
      // The branch comes back to the repository so a human can review it there.
      try {
        await git(repoRoot, 'fetch', '-q', checkout, `+refs/heads/${run.ref}:refs/heads/${run.ref}`)
      } catch (e) {
        problem = `could not bring ${run.ref} into the repository: ${(e as Error).message}`
      }
      const dirty = (await git(checkout, 'status', '--porcelain')).split('\n').filter(Boolean).map((l) => l.slice(3).trim())
      let changed: string[] = []
      try {
        changed = (await git(checkout, 'diff', '--name-only', `${baseRef}...HEAD`)).split('\n').filter(Boolean)
      } catch (e) {
        problem = (problem ? problem + '; ' : '') + `could not diff ${run.ref} against ${baseRef}: ${(e as Error).message}`
      }
      return { changed, dirty, problem }
    }
  }
}

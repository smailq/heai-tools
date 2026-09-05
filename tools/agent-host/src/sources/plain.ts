// The plain source: no version control at all. A copy of the tree per actor,
// a content snapshot taken when a run begins, and what differs from it when
// the run ends. The work stays in the checkout; what changed is also copied
// to `<state>/outbox/<run-id>/` so a human has it in one place.
//
// It exists to show the seam is real - the host runs unchanged on it - and
// for a tree that is simply present, with no repository behind it.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { Source, SourceOptions } from '../source.ts'

type Manifest = Record<string, string>

function walk(root: string, dir = root, out: Manifest = {}): Manifest {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(root, full, out)
    else if (entry.isFile()) out[relative(root, full).split(sep).join('/')] = createHash('sha256').update(readFileSync(full)).digest('hex')
  }
  return out
}

export function createSource(options: SourceOptions): Source {
  const { repoRoot, checkoutsDir, stateDir } = options
  const checkoutOf = (actor: string) => join(checkoutsDir, actor)
  const snapshotOf = (actor: string, ref: string) => join(checkoutsDir, `${actor}.${ref.replace(/[^a-z0-9._-]+/gi, '_')}.snapshot.json`)
  const stateAbs = resolve(stateDir)

  return {
    name: 'plain',

    refFor: (actor, slug) => `${actor}/${slug}`,

    async prepare(actor) {
      const checkout = checkoutOf(actor)
      if (existsSync(checkout)) return { checkout, created: false }
      // The state directory lives inside the tree, so a plain recursive copy
      // would copy the checkouts into themselves; this one skips it, and .git.
      const copy = (from: string, to: string) => {
        mkdirSync(to, { recursive: true })
        for (const entry of readdirSync(from, { withFileTypes: true })) {
          const src = join(from, entry.name)
          const abs = resolve(src)
          if (abs === stateAbs || abs.startsWith(stateAbs + sep) || entry.name === '.git') continue
          if (entry.isDirectory()) copy(src, join(to, entry.name))
          else if (entry.isFile()) copyFileSync(src, join(to, entry.name))
        }
      }
      copy(repoRoot, checkout)
      return { checkout, created: true }
    },

    env: () => ({}),

    rules: () => ['You work directly in `/work`. Edit files in place; there is no version control here, and what you leave in the tree is the work.'],

    async begin(run) {
      const checkout = checkoutOf(run.actor)
      const snapshot = snapshotOf(run.actor, run.ref)
      // A resumed task keeps its first snapshot, so its changes accumulate.
      if (!existsSync(snapshot)) writeFileSync(snapshot, JSON.stringify(walk(checkout)))
      return null
    },

    async finish(run) {
      const checkout = checkoutOf(run.actor)
      const snapshot = snapshotOf(run.actor, run.ref)
      const before: Manifest = existsSync(snapshot) ? (JSON.parse(readFileSync(snapshot, 'utf8')) as Manifest) : {}
      const after = walk(checkout)
      const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((p) => before[p] !== after[p]).sort()
      const outbox = join(stateDir, 'outbox', run.id)
      for (const p of changed) {
        const src = join(checkout, p)
        if (!existsSync(src) || !statSync(src).isFile()) continue
        mkdirSync(dirname(join(outbox, p)), { recursive: true })
        copyFileSync(src, join(outbox, p))
      }
      return { changed, dirty: [], problem: null }
    }
  }
}

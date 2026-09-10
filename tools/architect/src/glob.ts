/**
 * Glob semantics for the architecture map, as the README specifies:
 * repo-root-relative with no leading or trailing `/`; `**` matches zero or more
 * whole path segments, `*` stays within one segment, `?` is one character;
 * `[`, `{` and `!` match themselves; matching is case-sensitive; and a glob
 * matches files, never directories.
 *
 * This is deliberately a second implementation of the dialect rather than a
 * shared library: tools here own their dependencies, and a copy whose
 * divergence is caught by tests beats coupling two release cycles. The cases
 * that pin the dialect live in `test/glob.test.ts` on both sides.
 *
 * Beyond matching, the editor has to answer questions about globs as
 * *languages* rather than about the files on disk, because the no-overlap rule
 * is a property of the patterns: `src/**` and `src/legacy/**` overlap the
 * moment both are written, empty or not. `intersects` and `contains` below
 * answer those.
 */

/** A glob the dialect does not accept. The map is wrong. */
export class GlobError extends Error {}

/** A compiled glob: `'**'` marks a segment wildcard, arrays are literal segments. */
export type Pattern = ('**' | string[])[]

const cache = new Map<string, Pattern>()

/** Compile a glob, rejecting anything the dialect does not accept. */
export function compileGlob(glob: string): Pattern {
  const hit = cache.get(glob)
  if (hit) return hit
  if (glob === '') throw new GlobError('empty glob')
  if (glob.startsWith('/') || glob.endsWith('/')) {
    throw new GlobError(`"${glob}": a glob has no leading or trailing /`)
  }
  const pattern: Pattern = glob.split('/').map((seg) => {
    if (seg === '**') return '**'
    if (seg === '') throw new GlobError(`"${glob}": empty path segment`)
    if (seg.includes('**')) {
      throw new GlobError(`"${glob}": ** must be a whole segment, not part of one`)
    }
    return [...seg]
  })
  cache.set(glob, pattern)
  return pattern
}

/** Throw if the glob is not one this dialect accepts. */
export function validateGlob(glob: string): void {
  compileGlob(glob)
}

/**
 * Match one path segment against one glob segment, both as code points so `?`
 * is one character rather than one UTF-16 unit. Greedy with a single remembered
 * `*`, which is the standard linear wildcard match - no backtracking to blow up.
 */
function matchSegment(pat: readonly string[], text: readonly string[]): boolean {
  let p = 0
  let t = 0
  let star = -1
  let mark = 0
  while (t < text.length) {
    if (p < pat.length && (pat[p] === '?' || pat[p] === text[t])) {
      p++
      t++
    } else if (p < pat.length && pat[p] === '*') {
      star = p++
      mark = t
    } else if (star >= 0) {
      p = star + 1
      t = ++mark
    } else {
      return false
    }
  }
  while (p < pat.length && pat[p] === '*') p++
  return p === pat.length
}

export function matchesGlob(path: string, glob: string): boolean {
  const pattern = compileGlob(glob)
  if (path === '') return false
  const parts = path.split('/')

  // The same greedy walk one level up, with `**` as the wildcard. A `**` in the
  // middle may collapse to nothing, so `a/**/c` matches `a/c`; a trailing `**`
  // must still consume a segment, because `src/**` claims the files under
  // `src`, not `src` itself.
  let p = 0
  let t = 0
  let star = -1
  let mark = 0
  while (t < parts.length) {
    const seg = pattern[p]
    if (p < pattern.length && seg !== '**' && matchSegment(seg as string[], [...parts[t]!])) {
      p++
      t++
    } else if (p < pattern.length && seg === '**') {
      star = p++
      mark = t
    } else if (star >= 0) {
      p = star + 1
      t = ++mark
    } else {
      return false
    }
  }
  // Anything left over can only be a trailing `**` with no segment to consume.
  return p === pattern.length
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchesGlob(path, g))
}

// ── Globs as languages ──
// Both walks below are memoized DPs over the two patterns at once. A segment
// list produces at least one segment unless it is empty: a `**` in the middle
// may collapse to nothing, but a trailing one may not.

type Memo = Map<number, boolean>

const memoKey = (i: number, j: number, width: number) => i * width + j

/** Whether two single-segment patterns can produce a common string. */
function segmentsIntersect(a: readonly string[], b: readonly string[]): boolean {
  const memo: Memo = new Map()
  const width = b.length + 1
  const walk = (i: number, j: number): boolean => {
    const key = memoKey(i, j, width)
    const seen = memo.get(key)
    if (seen !== undefined) return seen
    let result: boolean
    if (i === a.length && j === b.length) result = true
    // A `*` may still absorb what is left of the other side, including nothing.
    else if (i < a.length && a[i] === '*') result = walk(i + 1, j) || (j < b.length && walk(i, j + 1))
    else if (j < b.length && b[j] === '*') result = walk(i, j + 1) || (i < a.length && walk(i + 1, j))
    else if (i === a.length || j === b.length) result = false
    else result = (a[i] === '?' || b[j] === '?' || a[i] === b[j]) && walk(i + 1, j + 1)
    memo.set(key, result)
    return result
  }
  return walk(0, 0)
}

/** Whether every string matching `g` also matches `e` - conservatively. */
function segmentContains(e: readonly string[], g: readonly string[]): boolean {
  const memo: Memo = new Map()
  const width = g.length + 1
  const walk = (i: number, j: number): boolean => {
    const key = memoKey(i, j, width)
    const seen = memo.get(key)
    if (seen !== undefined) return seen
    let result: boolean
    if (i === e.length) result = j === g.length
    else if (e[i] === '*') result = walk(i + 1, j) || (j < g.length && walk(i, j + 1))
    // `g` can emit an unbounded run here and `e` cannot absorb it: unprovable.
    else if (j < g.length && g[j] === '*') result = false
    else if (j === g.length) result = false
    else result = (e[i] === '?' || e[i] === g[j]) && walk(i + 1, j + 1)
    memo.set(key, result)
    return result
  }
  return walk(0, 0)
}

/**
 * Whether two globs can match a common path - the question the no-overlap rule
 * asks, answered exactly for this dialect.
 */
export function intersects(globA: string, globB: string): boolean {
  const a = compileGlob(globA)
  const b = compileGlob(globB)
  const memo: Memo = new Map()
  const width = b.length + 1
  const walk = (i: number, j: number): boolean => {
    const key = memoKey(i, j, width)
    const seen = memo.get(key)
    if (seen !== undefined) return seen
    let result: boolean
    if (i === a.length || j === b.length) {
      // One side is spent, so the other must be able to produce nothing more -
      // which a trailing `**` cannot, and a literal segment never can.
      result = i === a.length && j === b.length
    } else if (a[i] === '**') {
      result = i === a.length - 1 ? j < b.length : walk(i + 1, j) || walk(i, j + 1)
    } else if (b[j] === '**') {
      result = j === b.length - 1 ? i < a.length : walk(i, j + 1) || walk(i + 1, j)
    } else {
      result = segmentsIntersect(a[i] as string[], b[j] as string[]) && walk(i + 1, j + 1)
    }
    memo.set(key, result)
    return result
  }
  return walk(0, 0)
}

/**
 * Whether every path matching `glob` also matches `outer`.
 *
 * Conservative: it answers false where it cannot prove containment, so a caller
 * treating "not contained" as a finding may over-report on exotic patterns
 * rather than stay silent on a real one.
 */
export function contains(outer: string, glob: string): boolean {
  const e = compileGlob(outer)
  const g = compileGlob(glob)
  const memo: Memo = new Map()
  const width = g.length + 1
  const walk = (i: number, j: number): boolean => {
    const key = memoKey(i, j, width)
    const seen = memo.get(key)
    if (seen !== undefined) return seen
    let result: boolean
    if (i === e.length) result = j === g.length
    else if (e[i] === '**') {
      // A trailing `**` covers any non-empty tail; elsewhere it may collapse.
      result = i === e.length - 1 ? j < g.length : walk(i + 1, j) || (j < g.length && walk(i, j + 1))
    } else if (j === g.length) result = false
    else if (g[j] === '**') result = false
    else result = segmentContains(e[i] as string[], g[j] as string[]) && walk(i + 1, j + 1)
    memo.set(key, result)
    return result
  }
  return walk(0, 0)
}

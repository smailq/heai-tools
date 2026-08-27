/**
 * Glob semantics for the architecture map, kept deliberately small and
 * mirroring `docs/architecture-map.md`: repo-root-relative with no leading or
 * trailing `/`; `**` matches zero or more whole path segments, `*` stays
 * within one segment, `?` is one character; `[`, `{` and `!` carry no special
 * meaning and match themselves; matching is case-sensitive; and a glob matches
 * files, never directories. Dot-prefixed paths are ordinary paths: `**` claims
 * `.github/workflows/ci.yml` like anything else.
 *
 * This is hand-rolled rather than delegated to minimatch or to Node's built-in
 * `path.matchesGlob`, and both were measured before that choice:
 *
 * - The dialect here is deliberately SMALLER than every standard one, which
 *   read `[`, `{` and `\` as syntax, so a map written against this spec would
 *   change meaning under them.
 * - They exclude dot-prefixed paths from `*` and `**` by default, silently
 *   un-governing exactly the CI config a human-owned territory exists to
 *   protect. minimatch can be told otherwise with `dot: true`;
 *   `path.matchesGlob` takes no options at all.
 * - Both compile to a backtracking regex, so a glob like `*-*-*-*-*.test.ts`
 *   takes exponential time on a long non-matching path: one crafted filename in
 *   a diff hangs the gate, and a gate that never finishes has silently skipped
 *   its check. minimatch measured 264ms at 254 characters where this takes
 *   under a millisecond at 4014. picomatch shipped CVE-2026-33671 for this and
 *   minimatch CVE-2022-3517.
 *
 * Matching below is a two-pointer wildcard walk: linear in the path, with no
 * backtracking to blow up. Every other implementation of this dialect must
 * agree with it, so the cases that distinguish it from gitignore and doublestar
 * are pinned in `test/glob.test.ts` rather than left to the reader.
 */

/** A glob the dialect does not accept. The map is wrong, not the diff. */
export class GlobError extends Error {}

/** A compiled glob: `'**'` marks a segment wildcard, arrays are literal segments. */
type Pattern = ('**' | string[])[]

const cache = new Map<string, Pattern>()

/**
 * Match one path segment against one glob segment, both as code points so `?`
 * is one character rather than one UTF-16 unit. Greedy with a single remembered
 * `*`, which is the standard linear wildcard match.
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

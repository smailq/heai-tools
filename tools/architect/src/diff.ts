/**
 * Extract the set of changed paths from a unified `git diff` on stdin.
 *
 * A gate that silently mis-parses a path lets a violation through, so this
 * errs toward reading MORE paths than fewer: both sides of a rename count,
 * and a header whose two paths cannot be split unambiguously contributes
 * both candidates rather than neither.
 */

/** Undo git's C-style quoting: "a/caf\303\251.txt" -> a/café.txt */
function unquote(raw: string): string {
  const body = raw.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] ?? ''
    if (ch !== '\\') {
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b)
      continue
    }
    const next = body[++i] ?? '\\'
    if (next >= '0' && next <= '7') {
      const octal = body.slice(i, i + 3)
      bytes.push(parseInt(octal, 8) & 0xff)
      i += 2
      continue
    }
    const simple: Record<string, number> = {
      n: 0x0a, t: 0x09, r: 0x0d, b: 0x08, f: 0x0c, v: 0x0b, a: 0x07, '"': 0x22, '\\': 0x5c
    }
    bytes.push(simple[next] ?? Buffer.from(next, 'utf8')[0] ?? 0x5c)
  }
  return Buffer.from(bytes).toString('utf8')
}

/** Strip git's `a/` or `b/` diff prefix, which only header lines carry. */
function stripPrefix(path: string): string {
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2)
  return path
}

function normalize(raw: string, prefixed: boolean): string | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '/dev/null') return null
  const decoded = trimmed.startsWith('"') ? unquote(trimmed) : trimmed
  const path = prefixed ? stripPrefix(decoded) : decoded
  return path === '/dev/null' || path === '' ? null : path
}

/**
 * Split the two paths of a `diff --git` header. Unquoted paths containing
 * spaces are genuinely ambiguous, so when the halves cannot be split cleanly
 * both plausible readings are returned.
 */
function splitHeader(rest: string): string[] {
  if (rest.startsWith('"')) {
    // At least the first path is quoted; find its closing quote.
    let i = 1
    while (i < rest.length) {
      if (rest[i] === '\\') i++
      else if (rest[i] === '"') break
      i++
    }
    const first = rest.slice(0, i + 1)
    const second = rest.slice(i + 1).trim()
    return [first, second]
  }
  const halves = rest.split(' b/')
  if (halves.length === 2) return [halves[0] ?? '', 'b/' + (halves[1] ?? '')]
  // Ambiguous (spaces in the name): keep every candidate split.
  const out: string[] = []
  for (let i = 1; i < halves.length; i++) {
    out.push(halves.slice(0, i).join(' b/'))
    out.push('b/' + halves.slice(i).join(' b/'))
  }
  return out.length ? out : [rest]
}

/**
 * `--- x` / `+++ y` only count as a file header outside a hunk: deleting a
 * line that itself reads `-- x` produces exactly that shape. Inside a hunk the
 * pair is only believed when a hunk header follows it, which is what a real
 * file header in a non-git unified diff looks like.
 */
function isFileHeader(lines: string[], i: number, inHunk: boolean): boolean {
  const line = lines[i] ?? ''
  const minus = line.startsWith('--- ') ? i : line.startsWith('+++ ') ? i - 1 : -1
  if (minus < 0) return false
  if (!(lines[minus] ?? '').startsWith('--- ')) return false
  if (!(lines[minus + 1] ?? '').startsWith('+++ ')) return false
  return !inHunk || (lines[minus + 2] ?? '').startsWith('@@')
}

export function parseDiffPaths(text: string): string[] {
  const paths = new Set<string>()
  let sawHeader = false
  let inHunk = false

  const lines = text.split('\n')
  for (const [i, line] of lines.entries()) {
    if (line.startsWith('diff --git ')) {
      sawHeader = true
      inHunk = false
      for (const candidate of splitHeader(line.slice('diff --git '.length).trim())) {
        const p = normalize(candidate, true)
        if (p) paths.add(p)
      }
    } else if (isFileHeader(lines, i, inHunk)) {
      sawHeader = true
      inHunk = false
      // A trailing timestamp is tab-separated in POSIX diffs; git omits it.
      const p = normalize(line.slice(4).split('\t')[0] ?? '', true)
      if (p) paths.add(p)
    } else if (line.startsWith('@@')) {
      inHunk = true
    } else if (
      !inHunk &&
      (line.startsWith('rename from ') || line.startsWith('rename to ') ||
        line.startsWith('copy to '))
    ) {
      sawHeader = true
      const p = normalize(line.slice(line.indexOf(' ', line.indexOf(' ') + 1) + 1), false)
      if (p) paths.add(p)
    }
  }

  if (!sawHeader) {
    // Tolerate a plain path list, so `git diff --name-only` also works.
    for (const line of lines) {
      const p = normalize(line, false)
      if (p) paths.add(p)
    }
  }

  return [...paths].sort()
}

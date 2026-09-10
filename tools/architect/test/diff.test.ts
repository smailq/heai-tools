import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseDiffPaths } from '../src/diff.ts'

test('reads paths from a unified diff', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,3 @@',
    '-old',
    '+new'
  ].join('\n')
  assert.deepEqual(parseDiffPaths(diff), ['src/a.ts'])
})

test('counts both sides of a rename', () => {
  const diff = [
    'diff --git a/old.ts b/new.ts',
    'similarity index 90%',
    'rename from old.ts',
    'rename to new.ts'
  ].join('\n')
  assert.deepEqual(parseDiffPaths(diff), ['new.ts', 'old.ts'])
})

test('ignores /dev/null for added and deleted files', () => {
  const diff = [
    'diff --git a/gone.ts b/gone.ts',
    'deleted file mode 100644',
    '--- a/gone.ts',
    '+++ /dev/null'
  ].join('\n')
  assert.deepEqual(parseDiffPaths(diff), ['gone.ts'])
})

test('unquotes C-style paths, including non-ASCII', () => {
  const diff = 'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\n'
  assert.deepEqual(parseDiffPaths(diff), ['café.txt'])
})

test('deleted content that looks like a file header is not a path', () => {
  const diff = [
    'diff --git a/notes.md b/notes.md',
    '--- a/notes.md',
    '+++ b/notes.md',
    '@@ -1,2 +1,2 @@',
    '--- fake/header.ts',
    '+++ other/fake.ts'
  ].join('\n')
  assert.deepEqual(parseDiffPaths(diff), ['notes.md'])
})

test('a mode-only change still contributes its path', () => {
  const diff = [
    'diff --git a/script.sh b/script.sh',
    'old mode 100644',
    'new mode 100755'
  ].join('\n')
  assert.deepEqual(parseDiffPaths(diff), ['script.sh'])
})

test('falls back to a plain path list (git diff --name-only)', () => {
  assert.deepEqual(parseDiffPaths('src/a.ts\nsrc/b.ts\n'), ['src/a.ts', 'src/b.ts'])
})

test('empty input yields no paths', () => {
  assert.deepEqual(parseDiffPaths(''), [])
  assert.deepEqual(parseDiffPaths('\n\n'), [])
})

test('a path containing spaces contributes every candidate reading', () => {
  const paths = parseDiffPaths('diff --git a/my file.ts b/my file.ts\n')
  assert.ok(paths.includes('my file.ts'), `got ${JSON.stringify(paths)}`)
})

test('handles multiple files in one diff', () => {
  const diff = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    'diff --git a/b.ts b/b.ts',
    '--- a/b.ts',
    '+++ b/b.ts'
  ].join('\n')
  assert.deepEqual(parseDiffPaths(diff), ['a.ts', 'b.ts'])
})

test('reads every file of a plain (non-git) unified diff', () => {
  const diff = [
    '--- old/a.ts\t2026-01-01',
    '+++ new/a.ts\t2026-01-02',
    '@@ -1 +1 @@',
    '-x',
    '+y',
    '--- old/b.ts\t2026-01-01',
    '+++ new/b.ts\t2026-01-02',
    '@@ -1 +1 @@',
    '-x',
    '+y'
  ].join('\n')
  assert.deepEqual(parseDiffPaths(diff), ['new/a.ts', 'new/b.ts', 'old/a.ts', 'old/b.ts'])
})

test('the a/ b/ prefix is stripped only where git writes it', () => {
  // git adds the prefix in `diff --git` and `---`/`+++` headers and nowhere
  // else, so a real top-level directory named a or b must survive intact.
  assert.deepEqual(parseDiffPaths('a/x.ts\nb/y.ts\n'), ['a/x.ts', 'b/y.ts'])
  assert.deepEqual(
    parseDiffPaths('diff --git a/q b/q\nrename from b/old.ts\nrename to b/new.ts\n'),
    ['b/new.ts', 'b/old.ts', 'q']
  )
  assert.deepEqual(parseDiffPaths('diff --git a/src/x.ts b/src/x.ts\n'), ['src/x.ts'])
})

test('copy to lines contribute their path', () => {
  assert.deepEqual(
    parseDiffPaths('diff --git a/src/a.ts b/src/b.ts\ncopy from src/a.ts\ncopy to src/b.ts\n'),
    ['src/a.ts', 'src/b.ts']
  )
})

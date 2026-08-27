import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { GlobError, compileGlob, matchesGlob } from '../src/glob.ts'

/**
 * The dialect is deliberately smaller than gitignore or doublestar, so the
 * cases that distinguish it are pinned here. Any other implementation of the
 * map's globs must agree with these.
 */

test('* stays within a segment, ** spans them', () => {
  assert.equal(matchesGlob('a.ts', '*.ts'), true)
  assert.equal(matchesGlob('src/a.ts', '*.ts'), false)
  assert.equal(matchesGlob('src/a.ts', 'src/**'), true)
  assert.equal(matchesGlob('src/deep/a.ts', 'src/**'), true)
})

test('** collapses to nothing', () => {
  assert.equal(matchesGlob('a/c', 'a/**/c'), true)
  assert.equal(matchesGlob('a/b/c', 'a/**/c'), true)
  assert.equal(matchesGlob('a/b/d/c', 'a/**/c'), true)
  assert.equal(matchesGlob('lib', '**/lib'), true)
  assert.equal(matchesGlob('x/y/lib', '**/lib'), true)
})

test('a glob matches files, never directories', () => {
  // 'src/**' claims the files under src, not src itself.
  assert.equal(matchesGlob('src', 'src/**'), false)
  assert.equal(matchesGlob('src/a', 'src/**'), true)
})

test('a bare filename matches only at the repository root', () => {
  assert.equal(matchesGlob('LICENSE', 'LICENSE'), true)
  assert.equal(matchesGlob('docs/LICENSE', 'LICENSE'), false)
})

test('? is exactly one character, within a segment', () => {
  assert.equal(matchesGlob('ab', 'a?'), true)
  assert.equal(matchesGlob('abc', 'a?'), false)
  assert.equal(matchesGlob('a/b', 'a?b'), false)
})

test('[, { and ! are literal', () => {
  assert.equal(matchesGlob('a[1].ts', 'a[1].ts'), true)
  assert.equal(matchesGlob('a1.ts', 'a[1].ts'), false)
  assert.equal(matchesGlob('a{b}.ts', 'a{b}.ts'), true)
  assert.equal(matchesGlob('!x.ts', '!x.ts'), true)
  assert.equal(matchesGlob('y.ts', '!x.ts'), false)
})

test('regex metacharacters are literal, not syntax', () => {
  // This dialect compiles to no regex, and every other implementation of it
  // must agree, so the characters that would be syntax elsewhere are pinned.
  for (const ch of ['.', '+', '$', '^', '(', ')', '|', '\\', '[', ']', '{', '}', '!']) {
    assert.equal(matchesGlob(`a${ch}b`, `a${ch}b`), true, `literal ${ch}`)
  }
  assert.equal(matchesGlob('axb', 'a.b'), false)
  assert.equal(matchesGlob('aab', 'a+b'), false)
})

test('? is one character, including outside the basic plane', () => {
  assert.equal(matchesGlob('a\u{1F600}', 'a?'), true)
  assert.equal(matchesGlob('a\u{1F600}b', 'a?'), false)
})

test('matching is case-sensitive', () => {
  assert.equal(matchesGlob('SRC/a.ts', 'src/**'), false)
  assert.equal(matchesGlob('README.md', 'readme.md'), false)
})

test('** alone claims every file', () => {
  assert.equal(matchesGlob('a', '**'), true)
  assert.equal(matchesGlob('a/b/c.ts', '**'), true)
})

test('globs the dialect rejects', () => {
  for (const bad of ['a**', '**.ts', 'x/a**b/y', '/src/**', 'src/', 'a//b', '']) {
    assert.throws(() => compileGlob(bad), GlobError, `expected ${JSON.stringify(bad)} to be rejected`)
  }
})

test('** collapses across several wildcards', () => {
  assert.equal(matchesGlob('a/c', 'a/**/**/c'), true)
  assert.equal(matchesGlob('a/b', '**/**'), true)
  assert.equal(matchesGlob('a', '**/**'), true)
})

test('a pathological glob does not blow up', () => {
  // `*` lowered to a backtracking regex takes exponential time on a long
  // non-matching path, which would hang the gate on one crafted filename.
  const path = 'src/' + 'x-'.repeat(2000) + 'y.test.tsX'
  const started = Date.now()
  assert.equal(matchesGlob(path, 'src/*-*-*-*-*.test.ts'), false)
  assert.ok(Date.now() - started < 1000, 'matching must stay linear in the path')
})

test('dot-prefixed paths are ordinary paths', () => {
  // Standard dialects exclude these from * and ** by default, which would
  // silently un-govern the CI config a human-owned territory exists to protect.
  assert.equal(matchesGlob('.gitignore', '**'), true)
  assert.equal(matchesGlob('.github/workflows/ci.yml', '**'), true)
  assert.equal(matchesGlob('a/.hidden', 'a/**'), true)
  assert.equal(matchesGlob('.gitignore', '*'), true)
})

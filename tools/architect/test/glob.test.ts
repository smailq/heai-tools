import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { GlobError, compileGlob, contains, intersects, matchesGlob } from '../src/glob.ts'

/**
 * The dialect is deliberately smaller than gitignore or doublestar, so the
 * cases that distinguish it are pinned here. This is the one place the
 * dialect is pinned; any other implementation of the map's globs must agree.
 */
describe('matchesGlob', () => {
  it('matches within one segment with * and ?', () => {
    assert.equal(matchesGlob('a.ts', '*.ts'), true)
    assert.equal(matchesGlob('src/a.ts', '*.ts'), false)
    assert.equal(matchesGlob('src/a.ts', 'src/*.ts'), true)
    assert.equal(matchesGlob('src/deep/a.ts', 'src/*.ts'), false)
    assert.equal(matchesGlob('src/a.ts', 'src/?.ts'), true)
    assert.equal(matchesGlob('src/ab.ts', 'src/?.ts'), false)
  })

  it('? is exactly one character, within a segment, including outside the basic plane', () => {
    assert.equal(matchesGlob('ab', 'a?'), true)
    assert.equal(matchesGlob('abc', 'a?'), false)
    assert.equal(matchesGlob('a/b', 'a?b'), false)
    assert.equal(matchesGlob('a\u{1F600}', 'a?'), true)
    assert.equal(matchesGlob('a\u{1F600}b', 'a?'), false)
  })

  it('spans segments with ** and lets a middle ** collapse', () => {
    assert.equal(matchesGlob('a/c', 'a/**/c'), true)
    assert.equal(matchesGlob('a/b/c', 'a/**/c'), true)
    assert.equal(matchesGlob('a/b/x/c', 'a/**/c'), true)
    assert.equal(matchesGlob('lib', '**/lib'), true)
    assert.equal(matchesGlob('x/y/lib', '**/lib'), true)
    assert.equal(matchesGlob('src/deep/a.ts', 'src/**'), true)
    assert.equal(matchesGlob('a/c', 'a/**/**/c'), true)
    assert.equal(matchesGlob('a/b', '**/**'), true)
    assert.equal(matchesGlob('a', '**/**'), true)
  })

  it('** alone claims every file', () => {
    assert.equal(matchesGlob('a', '**'), true)
    assert.equal(matchesGlob('a/b/c.ts', '**'), true)
  })

  it('matches files, never directories', () => {
    // 'src/**' claims the files under src, not src itself.
    assert.equal(matchesGlob('src', 'src/**'), false, 'a trailing ** still needs a segment')
    assert.equal(matchesGlob('src/a', 'src/**'), true)
  })

  it('treats dot-prefixed paths as ordinary paths', () => {
    // Standard dialects exclude these from * and ** by default, which would
    // silently un-govern the CI config a human-owned territory exists to protect.
    assert.equal(matchesGlob('.gitignore', '**'), true)
    assert.equal(matchesGlob('.github/workflows/ci.yml', '**'), true)
    assert.equal(matchesGlob('a/.hidden', 'a/**'), true)
    assert.equal(matchesGlob('.gitignore', '*'), true)
  })

  it('treats [, { and ! as literal characters', () => {
    assert.equal(matchesGlob('a[b].ts', 'a[b].ts'), true)
    assert.equal(matchesGlob('a[1].ts', 'a[1].ts'), true)
    assert.equal(matchesGlob('a1.ts', 'a[1].ts'), false)
    assert.equal(matchesGlob('a{b}.ts', 'a{b}.ts'), true)
    assert.equal(matchesGlob('a.ts', 'a{.ts,.js}'), false)
    assert.equal(matchesGlob('!x', '!x'), true)
    assert.equal(matchesGlob('!x.ts', '!x.ts'), true)
    assert.equal(matchesGlob('y.ts', '!x.ts'), false)
  })

  it('treats regex metacharacters as literal, not syntax', () => {
    // This dialect compiles to no regex, and every other implementation of it
    // must agree, so the characters that would be syntax elsewhere are pinned.
    for (const ch of ['.', '+', '$', '^', '(', ')', '|', '\\', '[', ']', '{', '}', '!']) {
      assert.equal(matchesGlob(`a${ch}b`, `a${ch}b`), true, `literal ${ch}`)
    }
    assert.equal(matchesGlob('axb', 'a.b'), false)
    assert.equal(matchesGlob('aab', 'a+b'), false)
  })

  it('is case-sensitive', () => {
    assert.equal(matchesGlob('SRC/a.ts', 'src/**'), false)
    assert.equal(matchesGlob('README.md', 'readme.md'), false)
  })

  it('matches a bare filename only at the repository root', () => {
    assert.equal(matchesGlob('architecture.yaml', 'architecture.yaml'), true)
    assert.equal(matchesGlob('sub/architecture.yaml', 'architecture.yaml'), false)
    assert.equal(matchesGlob('LICENSE', 'LICENSE'), true)
    assert.equal(matchesGlob('docs/LICENSE', 'LICENSE'), false)
  })

  it('rejects globs the dialect does not accept', () => {
    for (const bad of ['a**', '**.ts', 'x/a**b/y', '/src/**', 'src/', 'a//b', '']) {
      assert.throws(() => compileGlob(bad), GlobError, `expected ${JSON.stringify(bad)} to be rejected`)
    }
  })

  it('stays linear on patterns that blow up a backtracking matcher', () => {
    // `*` lowered to a backtracking regex takes exponential time on a long
    // non-matching path, which would hang the gate on one crafted filename.
    const glob = '*-*-*-*-*-*-*-*-*-*.test.ts'
    const path = 'a'.repeat(4000) + '.ts'
    const started = process.hrtime.bigint()
    assert.equal(matchesGlob(path, glob), false)
    assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 100)
    const long = 'src/' + 'x-'.repeat(2000) + 'y.test.tsX'
    const again = Date.now()
    assert.equal(matchesGlob(long, 'src/*-*-*-*-*.test.ts'), false)
    assert.ok(Date.now() - again < 1000, 'matching must stay linear in the path')
  })
})

describe('intersects', () => {
  it('finds the common paths the no-overlap rule is about', () => {
    assert.equal(intersects('src/**', 'src/legacy/**'), true)
    assert.equal(intersects('src/**', 'docs/**'), false)
    assert.equal(intersects('**', 'anything/at/all'), true)
    assert.equal(intersects('src/*.ts', 'src/a.ts'), true)
    assert.equal(intersects('src/*.ts', 'src/a.js'), false)
    assert.equal(intersects('a/**/c', 'a/c'), true)
    assert.equal(intersects('src/**', 'src'), false, 'a trailing ** never matches the bare directory')
  })

  it('is symmetric', () => {
    for (const [a, b] of [
      ['src/**', 'src/legacy/**'],
      ['**/test/**', 'src/*/x.ts'],
      ['a/*/c', 'a/b/**']
    ] as [string, string][]) {
      assert.equal(intersects(a, b), intersects(b, a), `${a} vs ${b}`)
    }
  })

  it('agrees with the matcher on a witness path', () => {
    assert.equal(intersects('src/**', 'src/legacy/**'), matchesGlob('src/legacy/a.ts', 'src/**'))
  })
})

describe('contains', () => {
  it('proves the containments an exclusion relies on', () => {
    assert.equal(contains('src/**', 'src/legacy/**'), true)
    assert.equal(contains('**', 'src/a.ts'), true)
    assert.equal(contains('src/*.ts', 'src/a.ts'), true)
    assert.equal(contains('src/a.ts', 'src/*.ts'), false)
    assert.equal(contains('src/legacy/**', 'src/**'), false)
    assert.equal(contains('docs/**', 'src/**'), false)
  })

  it('sees through a ** that a narrower pattern sits inside', () => {
    assert.equal(contains('a/**/c', 'a/*/c'), true)
    assert.equal(contains('a/**', 'a/*/**'), true)
    assert.equal(contains('*', 'a*b'), true)
  })
})

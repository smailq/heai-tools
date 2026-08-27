import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { GlobError, compileGlob, contains, intersects, matchesGlob } from '../src/glob.ts'

describe('matchesGlob', () => {
  it('matches within one segment with * and ?', () => {
    assert.equal(matchesGlob('src/a.ts', 'src/*.ts'), true)
    assert.equal(matchesGlob('src/deep/a.ts', 'src/*.ts'), false)
    assert.equal(matchesGlob('src/a.ts', 'src/?.ts'), true)
    assert.equal(matchesGlob('src/ab.ts', 'src/?.ts'), false)
  })

  it('spans segments with ** and lets a middle ** collapse', () => {
    assert.equal(matchesGlob('a/c', 'a/**/c'), true)
    assert.equal(matchesGlob('a/b/x/c', 'a/**/c'), true)
    assert.equal(matchesGlob('src/deep/a.ts', 'src/**'), true)
    assert.equal(matchesGlob('src', 'src/**'), false, 'a trailing ** still needs a segment')
  })

  it('treats dot-prefixed paths as ordinary paths', () => {
    assert.equal(matchesGlob('.github/workflows/ci.yml', '**'), true)
  })

  it('treats [, { and ! as literal characters', () => {
    assert.equal(matchesGlob('a[b].ts', 'a[b].ts'), true)
    assert.equal(matchesGlob('a.ts', 'a{.ts,.js}'), false)
    assert.equal(matchesGlob('!x', '!x'), true)
  })

  it('matches a bare filename only at the repository root', () => {
    assert.equal(matchesGlob('architecture.yaml', 'architecture.yaml'), true)
    assert.equal(matchesGlob('sub/architecture.yaml', 'architecture.yaml'), false)
  })

  it('rejects globs the dialect does not accept', () => {
    assert.throws(() => compileGlob('/src/**'), GlobError)
    assert.throws(() => compileGlob('src/'), GlobError)
    assert.throws(() => compileGlob('**.ts'), GlobError)
    assert.throws(() => compileGlob('a**'), GlobError)
  })

  it('stays linear on patterns that blow up a backtracking matcher', () => {
    const glob = '*-*-*-*-*-*-*-*-*-*.test.ts'
    const path = 'a'.repeat(4000) + '.ts'
    const started = process.hrtime.bigint()
    assert.equal(matchesGlob(path, glob), false)
    assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 100)
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

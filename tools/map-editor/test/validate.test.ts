import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import { createValidator, TEMPLATE, type ArchitectureMap } from '../src/validate.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const validator = createValidator(join(here, '..', '..', '..', 'schemas', 'architecture.schema.json'))

/** A minimal valid map, with the given parts merged over it. */
function map(overrides: Partial<ArchitectureMap> = {}): ArchitectureMap {
  return {
    version: 1,
    actors: {
      kyu: { type: 'human', identity: '@kyu' },
      api: { type: 'llm-agent', context: 'Owns the API.' }
    },
    repositories: { app: { remotePath: 'src.example.com/team/app' } },
    territories: {
      platform: { owner: 'kyu', scope: [{ repository: 'app', globs: ['architecture.yaml'] }] },
      service: { owner: 'api', scope: [{ repository: 'app', globs: ['src/**'] }] }
    },
    ...overrides
  }
}

const check = (m: ArchitectureMap) => validator.validateDoc(m)
const errorsOf = (m: ArchitectureMap) => check(m).errors
const has = (list: string[], needle: string) => list.some((x) => x.includes(needle))

describe('schema', () => {
  it('accepts the starter template', () => {
    const result = validator.validate(TEMPLATE)
    assert.deepEqual(result.errors, [])
    assert.ok(result.map)
  })

  it('accepts a repository that declares a localPath', () => {
    const m = map({ repositories: { app: { remotePath: 'x/y', localPath: '~/Code/app' } } })
    assert.deepEqual(errorsOf(m), [])
  })

  it('reports unparseable YAML rather than throwing', () => {
    const result = validator.validate('version: 1\n  bad: [')
    assert.equal(result.valid, false)
    assert.ok(result.errors[0]!.startsWith('YAML:'))
  })

  it('rejects an unknown top-level key', () => {
    const result = validator.validateDoc({ ...map(), sharedGlobs: [] })
    assert.equal(result.valid, false)
    assert.ok(has(result.errors, 'schema:'))
  })

  it('requires an identity of a human and a context of an llm-agent', () => {
    const noIdentity = check({ ...map(), actors: { kyu: { type: 'human' } } } as ArchitectureMap)
    assert.equal(noIdentity.valid, false)
    const noContext = check({
      ...map(),
      actors: { kyu: { type: 'human', identity: '@kyu' }, api: { type: 'llm-agent' } }
    } as ArchitectureMap)
    assert.equal(noContext.valid, false)
  })
})

describe('referential integrity', () => {
  it('rejects an undeclared owner', () => {
    const m = map()
    m.territories.service!.owner = 'ghost'
    assert.ok(has(errorsOf(m), 'owner "ghost" is not a declared actor'))
  })

  it('rejects a scope entry naming an unknown repository', () => {
    const m = map()
    m.territories.service!.scope[0]!.repository = 'nope'
    assert.ok(has(errorsOf(m), 'unknown repository "nope"'))
  })

  it('rejects dependsOn naming an unknown territory, or itself', () => {
    const m = map()
    m.territories.service!.dependsOn = ['ghost']
    assert.ok(has(errorsOf(m), 'unknown territory "ghost"'))
    m.territories.service!.dependsOn = ['service']
    assert.ok(has(errorsOf(m), 'depends on itself'))
  })

  it('rejects a dependency cycle, once', () => {
    const m = map()
    m.territories.service!.dependsOn = ['platform']
    m.territories.platform!.dependsOn = ['service']
    const cycles = errorsOf(m).filter((e) => e.includes('dependency cycle'))
    assert.equal(cycles.length, 1)
  })

  it('rejects an exclusion naming an unknown territory, or itself', () => {
    const m = map()
    m.territories.service!.scope[0]!.exclude = { territories: ['ghost'] }
    assert.ok(has(errorsOf(m), 'unknown territory "ghost"'))
    m.territories.service!.scope[0]!.exclude = { territories: ['service'] }
    assert.ok(has(errorsOf(m), 'excludes itself'))
  })

  it('rejects a glob the dialect does not accept', () => {
    const m = map()
    m.territories.service!.scope[0]!.globs = ['src/**.ts']
    assert.ok(has(errorsOf(m), '** must be a whole segment'))
  })
})

describe('no overlap', () => {
  it('reports two territories claiming a common path', () => {
    const m = map()
    m.territories.platform!.scope[0]!.globs = ['src/legacy/**']
    assert.ok(has(errorsOf(m), 'platform and service overlap in app'))
  })

  it('is about the globs, not the files that exist', () => {
    const m = map()
    m.territories.platform!.scope[0]!.globs = ['src/*.ts']
    m.territories.service!.scope[0]!.globs = ['src/a.ts']
    assert.ok(has(errorsOf(m), 'overlap in app'))
  })

  it('clears the overlap when an entry excludes the other territory', () => {
    const m = map()
    m.territories.platform!.scope[0]!.globs = ['src/legacy/**']
    m.territories.service!.scope[0]!.exclude = { territories: ['platform'] }
    assert.deepEqual(errorsOf(m), [])
  })

  it('clears the overlap when an entry excludes the pattern directly', () => {
    const m = map()
    m.territories.platform!.scope[0]!.globs = ['src/legacy/**']
    m.territories.service!.scope[0]!.exclude = { globs: ['src/legacy/**'] }
    assert.deepEqual(errorsOf(m), [])
  })

  it('leaves territories in different repositories alone', () => {
    const m = map({
      repositories: { app: {}, site: {} },
      territories: {
        platform: { owner: 'kyu', scope: [{ repository: 'app', globs: ['**'] }] },
        service: { owner: 'api', scope: [{ repository: 'site', globs: ['**'] }] }
      }
    })
    assert.deepEqual(errorsOf(m), [])
  })
})

describe('warnings', () => {
  const warningsOf = (m: ArchitectureMap) => check(m).warnings

  it('flags an actor that owns nothing', () => {
    const m = map()
    m.actors.spare = { type: 'llm-agent', context: 'idle' }
    assert.ok(has(warningsOf(m), 'actors.spare: declared but owns no territory'))
  })

  it('flags a repository no territory scopes', () => {
    const m = map()
    m.repositories.site = {}
    assert.ok(has(warningsOf(m), 'repositories.site: declared but no territory scopes it'))
  })

  it('flags two repositories sharing a remotePath', () => {
    const m = map()
    m.repositories.site = { remotePath: 'src.example.com/team/app' }
    m.territories.platform!.scope.push({ repository: 'site', globs: ['x/**'] })
    assert.ok(has(warningsOf(m), 'share the remotePath'))
  })

  it('flags an exclusion that subtracts nothing', () => {
    const m = map()
    m.territories.service!.scope[0]!.exclude = { globs: ['docs/**'] }
    assert.ok(has(warningsOf(m), 'subtracts nothing'))
  })

  it('flags excluded paths no territory claims', () => {
    const m = map()
    m.territories.service!.scope[0]!.exclude = { globs: ['src/legacy/**'] }
    assert.ok(has(warningsOf(m), '"src/legacy/**" is claimed by no territory'))
  })

  it('flags a map with no human-owned territory', () => {
    const m = map()
    m.territories.platform!.owner = 'api'
    assert.ok(has(warningsOf(m), 'no human-owned territory'))
  })

  it('says nothing about a healthy map', () => {
    assert.deepEqual(check(map()).warnings, [])
  })
})

describe('round trip', () => {
  it('re-reads what it serializes', () => {
    const yaml = stringify(map())
    const result = validator.validate(yaml)
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.map, map())
  })
})

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { actorContext, actorsView, contextChain, loadMap, LoadError, ownerOf, resolveMapPath, territoriesView } from '../src/query.ts'
import type { ArchitectureMap } from '../src/validate.ts'

const MAP: ArchitectureMap = {
  version: 1,
  actors: {
    kyu: { type: 'human', identity: '@kyu' },
    api: { type: 'llm-agent', context: 'Owns the API.' },
    maintainer: { type: 'llm-agent', context: 'Watches.', watches: ['service', 'platform'] }
  },
  repositories: { app: {} },
  territories: {
    platform: { owner: 'kyu', scope: [{ repository: 'app', globs: ['architecture.yaml', 'ci/**'] }], context: 'Governance.' },
    service: { owner: 'api', scope: [{ repository: 'app', globs: ['src/**'] }], context: 'Service context.' },
    'service-db': { parent: 'service', scope: [{ repository: 'app', globs: ['src/db/**'] }], context: 'DB context.' }
  }
}

describe('ownerOf', () => {
  it('resolves a path through globs, children and the parent chain', () => {
    assert.deepEqual(ownerOf(MAP, 'src/db/schema.ts'), { path: 'src/db/schema.ts', repository: 'app', territory: 'service-db', owner: 'api', ownerType: 'llm-agent' })
    assert.equal(ownerOf(MAP, 'src/index.ts').territory, 'service')
    assert.equal(ownerOf(MAP, './ci/build.yml').owner, 'kyu')
    assert.equal(ownerOf(MAP, 'README.md').territory, null)
  })
  it('needs a repository name only when the map governs several', () => {
    const multi: ArchitectureMap = { ...MAP, repositories: { app: {}, web: {} } }
    assert.throws(() => ownerOf(multi, 'src/x'), (e: LoadError) => /name one with --repo/.test(e.message))
    assert.equal(ownerOf(multi, 'src/x', 'app').territory, 'service')
    assert.throws(() => ownerOf(multi, 'src/x', 'nope'), LoadError)
  })
})

describe('views', () => {
  it('list territories with resolved owners, and actors with what they own and watch', () => {
    const t = territoriesView(MAP)
    assert.equal(t.find((x) => x.name === 'service-db')!.owner, 'api')
    assert.equal(t.find((x) => x.name === 'service-db')!.declaredOwner, null)
    assert.deepEqual(territoriesView(MAP, 'api').map((x) => x.name), ['service', 'service-db'])
    const a = actorsView(MAP)
    assert.deepEqual(a.find((x) => x.name === 'maintainer'), { name: 'maintainer', type: 'llm-agent', identity: null, owns: [], watches: ['service', 'platform'], hasContext: true })
  })
})

describe('context', () => {
  it('chains ancestors outermost first and composes an actor from own, owned and watched', () => {
    assert.deepEqual(contextChain(MAP, 'service-db').map((l) => l.from), ['territory:service', 'territory:service-db'])
    const c = actorContext(MAP, 'maintainer')
    assert.deepEqual(c.own.map((l) => l.context), ['Watches.'])
    assert.deepEqual(c.owned, [])
    assert.deepEqual(c.watched.map((w) => [w.territory, w.owner]), [['service', 'api'], ['platform', 'kyu']])
    const api = actorContext(MAP, 'api')
    assert.deepEqual(api.owned.map((o) => o.territory), ['service', 'service-db'])
    assert.throws(() => actorContext(MAP, 'nobody'), LoadError)
  })
})

describe('loading', () => {
  it('reads and validates a file, and reports a missing file or schema as a LoadError', () => {
    const dir = mkdtempSync(join(tmpdir(), 'map-check-'))
    const path = join(dir, 'architecture.yaml')
    writeFileSync(path, stringify(MAP))
    const loaded = loadMap(path)
    assert.equal(loaded.result.valid, true)
    assert.throws(() => loadMap(join(dir, 'missing.yaml')), LoadError)
    assert.throws(() => loadMap(path, join(dir, 'no-schema.json')), LoadError)
    // The conventional location wins when it exists.
    assert.equal(resolveMapPath(undefined, dir), join(dir, 'architecture.yaml'))
    assert.equal(resolveMapPath('other.yaml', dir), join(dir, 'other.yaml'))
  })
})

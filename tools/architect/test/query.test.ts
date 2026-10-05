import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { UsageError } from '../src/errors.ts'
import { contextChain, loadMap, resolveMapPath, territoriesView, territoryOf } from '../src/query.ts'
import type { ArchitectureMap } from '../src/validate.ts'

const MAP: ArchitectureMap = {
  version: 1,
  repositories: { app: {} },
  territories: {
    platform: { scope: [{ repository: 'app', globs: ['architecture.yaml', 'ci/**'] }], context: 'Governance.' },
    service: { scope: [{ repository: 'app', globs: ['src/**'] }], context: 'Service context.' },
    'service-db': { parent: 'service', scope: [{ repository: 'app', globs: ['src/db/**'] }], context: 'DB context.' }
  }
}

describe('territoryOf', () => {
  it('resolves a path through globs and children', () => {
    assert.deepEqual(territoryOf(MAP, 'src/db/schema.ts'), { path: 'src/db/schema.ts', repository: 'app', territory: 'service-db' })
    assert.equal(territoryOf(MAP, 'src/index.ts').territory, 'service')
    assert.equal(territoryOf(MAP, './ci/build.yml').territory, 'platform')
    assert.equal(territoryOf(MAP, 'README.md').territory, null)
  })
  it('needs a repository name only when the map governs several', () => {
    const multi: ArchitectureMap = { ...MAP, repositories: { app: {}, web: {} } }
    assert.throws(() => territoryOf(multi, 'src/x'), (e: UsageError) => /name one with --repo/.test(e.message))
    assert.equal(territoryOf(multi, 'src/x', 'app').territory, 'service')
    assert.throws(() => territoryOf(multi, 'src/x', 'nope'), UsageError)
  })
})

describe('views', () => {
  it('lists every territory with its parent, globs, edges and whether it has context', () => {
    const t = territoriesView(MAP)
    assert.deepEqual(t.map((x) => x.name), ['platform', 'service', 'service-db'])
    assert.deepEqual(t.find((x) => x.name === 'service-db'), {
      name: 'service-db',
      parent: 'service',
      globs: [{ repository: 'app', globs: ['src/db/**'] }],
      dependsOn: [],
      hasContext: true
    })
  })
})

describe('context', () => {
  it('chains ancestors outermost first, and knows no territory it was not given', () => {
    assert.deepEqual(contextChain(MAP, 'service-db').map((l) => l.from), ['territory:service', 'territory:service-db'])
    assert.deepEqual(contextChain(MAP, 'service-db').map((l) => l.context), ['Service context.', 'DB context.'])
    assert.deepEqual(contextChain(MAP, 'platform').map((l) => l.context), ['Governance.'])
    assert.throws(() => contextChain(MAP, 'nowhere'), UsageError)
  })
})

describe('loading', () => {
  it('reads and validates a file, and reports a missing file or schema as a UsageError', () => {
    const dir = mkdtempSync(join(tmpdir(), 'architect-'))
    const path = join(dir, 'architecture.yaml')
    writeFileSync(path, stringify(MAP))
    const loaded = loadMap(path)
    assert.equal(loaded.result.valid, true)
    assert.throws(() => loadMap(join(dir, 'missing.yaml')), UsageError)
    assert.throws(() => loadMap(path, join(dir, 'no-schema.json')), UsageError)
    // The conventional location wins when it exists.
    assert.equal(resolveMapPath(undefined, dir, {}), join(dir, 'architecture.yaml'))
    assert.equal(resolveMapPath('other.yaml', dir, {}), join(dir, 'other.yaml'))
    // HEAI_DIR is the project directory; HEAI_MAP and an explicit path outrank it.
    assert.equal(resolveMapPath(undefined, dir, { HEAI_DIR: '/project' }), '/project/architecture.yaml')
    assert.equal(resolveMapPath(undefined, dir, { HEAI_DIR: 'project' }), join(dir, 'project', 'architecture.yaml'))
    assert.equal(resolveMapPath(undefined, dir, { HEAI_DIR: '/project', HEAI_MAP: 'm.yaml' }), join(dir, 'm.yaml'))
    assert.equal(resolveMapPath('other.yaml', dir, { HEAI_DIR: '/project' }), join(dir, 'other.yaml'))
  })
})

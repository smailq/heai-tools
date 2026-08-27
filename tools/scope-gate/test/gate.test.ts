import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { runGate } from '../src/gate.ts'
import {
  type ArchitectureMap,
  UsageError,
  claims,
  resolveRepository,
  resolveSubject
} from '../src/map.ts'

const map: ArchitectureMap = {
  version: 1,
  actors: {
    smailq: { type: 'human', identity: '@smailq' },
    'api-owner': { type: 'llm-agent', context: 'Owns the API.' }
  },
  repositories: { app: {}, sdk: {} },
  territories: {
    api: {
      owner: 'api-owner',
      scope: [
        { repository: 'app', globs: ['src/api/**'] },
        { repository: 'sdk', globs: ['**'] }
      ]
    },
    web: { owner: 'api-owner', scope: [{ repository: 'app', globs: ['src/web/**'] }] },
    platform: { owner: 'smailq', scope: [{ repository: 'app', globs: ['ci/**'] }] }
  },
  unowned: 'allow'
}

const gate = (subject: string, paths: string[], m: ArchitectureMap = map, repo = 'app') =>
  runGate({ map: m, repository: repo, subject: resolveSubject(m, { name: subject }), paths })

test('a territory subject may change only its own paths', () => {
  const r = gate('api', ['src/api/handler.ts'])
  assert.equal(r.ok, true)
  assert.equal(r.findings[0]?.classification, 'owned')

  const bad = gate('api', ['src/web/page.ts'])
  assert.equal(bad.ok, false)
  assert.equal(bad.findings[0]?.classification, 'foreign')
  assert.equal(bad.findings[0]?.territory, 'web')
})

test('an actor subject may change every territory it owns', () => {
  const r = gate('api-owner', ['src/api/handler.ts', 'src/web/page.ts'])
  assert.equal(r.ok, true)
  assert.equal(r.violations, 0)
})

test('confinement is symmetric: a human is confined too', () => {
  // The map bounds every actor alike, so there is no subject that passes
  // trivially. A human reaching outside their territory fails the gate.
  const r = gate('smailq', ['src/api/handler.ts'])
  assert.equal(r.ok, false)
  assert.equal(r.findings[0]?.classification, 'foreign')

  const own = gate('smailq', ['ci/release.yml'])
  assert.equal(own.ok, true)
})

test('an agent reaching into a human-owned territory fails', () => {
  const r = gate('api-owner', ['ci/release.yml'])
  assert.equal(r.ok, false)
  assert.equal(r.findings[0]?.owner, 'smailq')
  assert.equal(r.findings[0]?.ownerType, 'human')
})

test('the unowned posture decides, and the caller cannot override it', () => {
  const allowed = gate('api', ['stray.txt'])
  assert.equal(allowed.ok, true)
  assert.equal(allowed.findings[0]?.classification, 'unowned')
  assert.equal(allowed.findings[0]?.fatal, false)

  const closed = gate('api', ['stray.txt'], { ...map, unowned: 'fail' })
  assert.equal(closed.ok, false)
  assert.equal(closed.findings[0]?.fatal, true)
})

test("a repository's posture overrides the map's", () => {
  const m: ArchitectureMap = {
    ...map,
    unowned: 'fail',
    repositories: { app: { unowned: 'allow' }, sdk: {} }
  }
  assert.equal(gate('api', ['stray.txt'], m).ok, true)
})

test('scope entries are per-repository', () => {
  // api claims all of sdk, but only src/api/** in app.
  assert.equal(claims(map, 'sdk', 'api', 'anything.ts'), true)
  assert.equal(claims(map, 'app', 'api', 'anything.ts'), false)
  assert.equal(gate('api', ['anything.ts'], map, 'sdk').ok, true)
})

test('exclude by glob subtracts from its own entry', () => {
  const m: ArchitectureMap = {
    ...map,
    territories: {
      everything: {
        owner: 'api-owner',
        scope: [{ repository: 'app', globs: ['**'], exclude: { globs: ['ci/**'] } }]
      },
      platform: map.territories.platform!
    }
  }
  assert.equal(gate('everything', ['src/anything.ts'], m).ok, true)
  // ci/** is excluded, so it belongs to platform and not to the catch-all.
  const r = gate('everything', ['ci/release.yml'], m)
  assert.equal(r.ok, false)
  assert.equal(r.findings[0]?.territory, 'platform')
})

test('exclude by territory subtracts that territory\'s globs', () => {
  const m: ArchitectureMap = {
    ...map,
    territories: {
      everything: {
        owner: 'api-owner',
        scope: [{ repository: 'app', globs: ['**'], exclude: { territories: ['platform'] } }]
      },
      platform: map.territories.platform!
    }
  }
  // No overlap exists, so the catch-all and the carve-out coexist.
  assert.equal(gate('everything', ['src/anything.ts'], m).ok, true)
  assert.equal(gate('platform', ['ci/release.yml'], m).ok, true)
  assert.equal(gate('everything', ['ci/release.yml'], m).findings[0]?.territory, 'platform')
})

test('exclusion never assigns the excluded path', () => {
  // Excluding a path the map gives to nobody leaves it unowned, not owned.
  const m: ArchitectureMap = {
    ...map,
    unowned: 'fail',
    territories: {
      everything: {
        owner: 'api-owner',
        scope: [{ repository: 'app', globs: ['**'], exclude: { globs: ['orphan/**'] } }]
      }
    }
  }
  const r = gate('everything', ['orphan/x.ts'], m)
  assert.equal(r.findings[0]?.classification, 'unowned')
  assert.equal(r.ok, false)
})

test('an overlapping map is reported, never guessed at', () => {
  const m: ArchitectureMap = {
    ...map,
    territories: {
      one: { owner: 'api-owner', scope: [{ repository: 'app', globs: ['src/**'] }] },
      two: { owner: 'smailq', scope: [{ repository: 'app', globs: ['src/api/**'] }] }
    }
  }
  assert.throws(() => gate('one', ['src/api/x.ts'], m), UsageError)
})

test('the repository must be named when the map governs several', () => {
  assert.throws(() => resolveRepository(map), UsageError)
  assert.equal(resolveRepository(map, 'sdk'), 'sdk')
  assert.equal(resolveRepository({ ...map, repositories: { only: {} } }), 'only')
})

test('an unknown subject is a usage error, not a pass', () => {
  assert.throws(() => resolveSubject(map, { name: 'nobody' }), UsageError)
  assert.throws(() => resolveSubject(map, { territory: 'api', actor: 'smailq' }), UsageError)
})

test('a path the carved-out territory itself excludes becomes unowned', () => {
  // Subtraction by territory is not recursive: the catch-all removes what
  // `platform` declares, and platform's own exclusion gives that slice back
  // to nobody.
  const m: ArchitectureMap = {
    ...map,
    unowned: 'fail',
    territories: {
      everything: {
        owner: 'api-owner',
        scope: [{ repository: 'app', globs: ['**'], exclude: { territories: ['platform'] } }]
      },
      platform: {
        owner: 'smailq',
        scope: [{ repository: 'app', globs: ['ci/**'], exclude: { globs: ['ci/vendor/**'] } }]
      }
    }
  }
  const r = gate('everything', ['ci/vendor/tool.sh'], m)
  assert.equal(r.findings[0]?.classification, 'unowned')
  assert.equal(r.ok, false)
})

test('a malformed glob is a map error, whatever the diff contains', () => {
  const m: ArchitectureMap = {
    ...map,
    territories: { bad: { owner: 'api-owner', scope: [{ repository: 'app', globs: ['src/'] }] } }
  }
  // Raised even with nothing to match it against, and as a usage error.
  assert.throws(() => gate('bad', [], m), UsageError)
  assert.throws(() => gate('bad', ['src/x.ts'], m), UsageError)
})

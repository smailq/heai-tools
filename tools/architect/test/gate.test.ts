import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { UsageError } from '../src/errors.ts'
import { resolveRepository, resolveSubject, runGate } from '../src/gate.ts'
import { claims, type ArchitectureMap } from '../src/validate.ts'

const map: ArchitectureMap = {
  version: 1,
  repositories: { app: {}, sdk: {} },
  territories: {
    api: {
      scope: [
        { repository: 'app', globs: ['src/api/**'] },
        { repository: 'sdk', globs: ['**'] }
      ]
    },
    web: { scope: [{ repository: 'app', globs: ['src/web/**'] }] },
    platform: { scope: [{ repository: 'app', globs: ['ci/**'] }] }
  },
  unowned: 'allow'
}

const gate = (scope: string | string[], paths: string[], m: ArchitectureMap = map, repo = 'app') =>
  runGate({ map: m, repository: repo, subject: resolveSubject(m, Array.isArray(scope) ? scope : [scope]), paths })

test('a change may touch only the territory it was scoped to', () => {
  const r = gate('api', ['src/api/handler.ts'])
  assert.equal(r.ok, true)
  assert.equal(r.findings[0]?.classification, 'inside')
  assert.equal(r.findings[0]?.territory, 'api')

  const bad = gate('api', ['src/web/page.ts'])
  assert.equal(bad.ok, false)
  assert.equal(bad.findings[0]?.classification, 'outside')
  assert.equal(bad.findings[0]?.territory, 'web')
  assert.equal(bad.findings[0]?.fatal, true)
})

test('a change scoped to several territories may touch their union, and nothing more', () => {
  const r = gate(['api', 'web'], ['src/api/handler.ts', 'src/web/page.ts'])
  assert.equal(r.ok, true)
  assert.equal(r.violations, 0)
  assert.deepEqual(r.subject.territories, ['api', 'web'])

  const bad = gate(['api', 'web'], ['ci/release.yml'])
  assert.equal(bad.ok, false)
  assert.equal(bad.findings[0]?.territory, 'platform')
})

test('no scope passes trivially: the whole map is not a subject', () => {
  // Every territory named is still a scope; what is not named is outside.
  const r = gate(['api', 'web', 'platform'], ['stray.txt'], { ...map, unowned: 'fail' })
  assert.equal(r.ok, false)
  assert.equal(r.findings[0]?.classification, 'unowned')
})

test('the unowned posture decides, and the caller cannot override it', () => {
  const allowed = gate('api', ['stray.txt'])
  assert.equal(allowed.ok, true)
  assert.equal(allowed.findings[0]?.classification, 'unowned')
  assert.equal(allowed.findings[0]?.fatal, false)
  assert.match(allowed.findings[0]?.note ?? '', /unowned posture/)

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
      everything: { scope: [{ repository: 'app', globs: ['**'], exclude: { globs: ['ci/**'] } }] },
      platform: map.territories.platform!
    }
  }
  assert.equal(gate('everything', ['src/anything.ts'], m).ok, true)
  // ci/** is excluded, so it belongs to platform and not to the catch-all.
  const r = gate('everything', ['ci/release.yml'], m)
  assert.equal(r.ok, false)
  assert.equal(r.findings[0]?.territory, 'platform')
})

test("exclude by territory subtracts that territory's globs", () => {
  const m: ArchitectureMap = {
    ...map,
    territories: {
      everything: { scope: [{ repository: 'app', globs: ['**'], exclude: { territories: ['platform'] } }] },
      platform: map.territories.platform!
    }
  }
  // No overlap exists, so the catch-all and the carve-out coexist.
  assert.equal(gate('everything', ['src/anything.ts'], m).ok, true)
  assert.equal(gate('platform', ['ci/release.yml'], m).ok, true)
  assert.equal(gate('everything', ['ci/release.yml'], m).findings[0]?.territory, 'platform')
})

test('exclusion never assigns the excluded path', () => {
  // Excluding a path the map gives to nobody leaves it unowned, not claimed.
  const m: ArchitectureMap = {
    ...map,
    unowned: 'fail',
    territories: {
      everything: { scope: [{ repository: 'app', globs: ['**'], exclude: { globs: ['orphan/**'] } }] }
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
      one: { scope: [{ repository: 'app', globs: ['src/**'] }] },
      two: { scope: [{ repository: 'app', globs: ['src/api/**'] }] }
    }
  }
  assert.throws(() => gate('one', ['src/api/x.ts'], m), UsageError)
})

test('the repository must be named when the map governs several', () => {
  assert.throws(() => resolveRepository(map), UsageError)
  assert.equal(resolveRepository(map, 'sdk'), 'sdk')
  assert.equal(resolveRepository({ ...map, repositories: { only: {} } }), 'only')
})

test('an unknown or empty scope is a usage error, not a pass', () => {
  assert.throws(() => resolveSubject(map, ['nowhere']), UsageError)
  assert.throws(() => resolveSubject(map, ['api', 'nowhere']), UsageError)
  assert.throws(() => resolveSubject(map, []), UsageError)
  assert.deepEqual(resolveSubject(map, ['api', 'api']).territories, ['api'], 'a territory named twice counts once')
})

test('a path the carved-out territory itself excludes becomes unowned', () => {
  // Subtraction by territory is not recursive: the catch-all removes what
  // `platform` declares, and platform's own exclusion gives that slice back
  // to nobody.
  const m: ArchitectureMap = {
    ...map,
    unowned: 'fail',
    territories: {
      everything: { scope: [{ repository: 'app', globs: ['**'], exclude: { territories: ['platform'] } }] },
      platform: { scope: [{ repository: 'app', globs: ['ci/**'], exclude: { globs: ['ci/vendor/**'] } }] }
    }
  }
  const r = gate('everything', ['ci/vendor/tool.sh'], m)
  assert.equal(r.findings[0]?.classification, 'unowned')
  assert.equal(r.ok, false)
})

test('a child territory carves itself out of its parent, with no exclude written', () => {
  const m: ArchitectureMap = {
    ...map,
    territories: {
      everything: { scope: [{ repository: 'app', globs: ['**'] }] },
      api: { parent: 'everything', scope: [{ repository: 'app', globs: ['src/api/**'] }] }
    }
  }
  // The path sits inside both territories' globs, yet resolves to the child:
  // the parent's effective scope no longer holds it.
  assert.equal(gate('api', ['src/api/handler.ts'], m).ok, true)
  const r = gate('everything', ['src/api/handler.ts'], m)
  assert.equal(r.ok, false)
  assert.equal(r.findings[0]?.territory, 'api')
  assert.equal(gate('everything', ['src/other.ts'], m).ok, true)
  // A change scoped to the parent and the child together may touch both.
  assert.equal(gate(['everything', 'api'], ['src/api/handler.ts', 'src/other.ts'], m).ok, true)
})

test('a malformed glob is a map error, whatever the diff contains', () => {
  const m: ArchitectureMap = {
    ...map,
    territories: { bad: { scope: [{ repository: 'app', globs: ['src/'] }] } }
  }
  // Raised even with nothing to match it against, and as a usage error.
  assert.throws(() => gate('bad', [], m), UsageError)
  assert.throws(() => gate('bad', ['src/x.ts'], m), UsageError)
})

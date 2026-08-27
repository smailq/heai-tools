import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

const MAP = `version: 1
unowned: fail
actors:
  smailq: { type: human, identity: '@smailq' }
  api-owner: { type: llm-agent, context: Owns the API. }
repositories:
  app: {}
territories:
  api:
    owner: api-owner
    scope: [{ repository: app, globs: ['src/**'] }]
  platform:
    owner: smailq
    scope: [{ repository: app, globs: ['ci/**'] }]
`

const dir = mkdtempSync(join(tmpdir(), 'scope-gate-'))
const mapPath = join(dir, 'architecture.yaml')
writeFileSync(mapPath, MAP)

after(() => rmSync(dir, { recursive: true, force: true }))

/** Run the CLI with a diff on stdin; returns its exit code and output. */
function run(args: string[], stdin = ''): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, '--map', mapPath, ...args], {
      input: stdin,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

test('exit 0 when every changed path is owned', () => {
  const r = run(['--territory', 'api'], 'src/a.ts\n')
  assert.equal(r.code, 0)
  assert.match(r.out, /PASS/)
})

test('exit 1 on a boundary violation', () => {
  const r = run(['--territory', 'api'], 'ci/release.yml\n')
  assert.equal(r.code, 1)
  assert.match(r.out, /FAIL/)
  assert.match(r.out, /foreign/)
})

test('exit 1 on an unowned path where the posture fails closed', () => {
  const r = run(['--territory', 'api'], 'stray.txt\n')
  assert.equal(r.code, 1)
  assert.match(r.out, /unowned/)
})

test('confinement is symmetric at the command line', () => {
  assert.equal(run(['--actor', 'smailq'], 'ci/release.yml\n').code, 0)
  assert.equal(run(['--actor', 'smailq'], 'src/a.ts\n').code, 1)
})

test('naming the subject twice is a usage error, not a silent choice', () => {
  const r = run(['api', '--actor', 'smailq'], 'src/a.ts\n')
  assert.equal(r.code, 2)
  assert.match(r.out, /name the subject once/)
})

test('an unknown subject, format, or map exits 2', () => {
  assert.equal(run(['--territory', 'nope'], 'src/a.ts\n').code, 2)
  assert.equal(run(['--territory', 'api', '--format', 'xml'], 'src/a.ts\n').code, 2)
  assert.equal(run(['--territory', 'api', '--map', '/nonexistent.yaml'], 'src/a.ts\n').code, 2)
})

test('json output carries the verdict', () => {
  const r = run(['--territory', 'api', '--format', 'json'], 'ci/release.yml\n')
  const parsed = JSON.parse(r.out) as { ok: boolean; violations: number }
  assert.equal(parsed.ok, false)
  assert.equal(parsed.violations, 1)
})

test('--help exits 0 without a diff', () => {
  const r = run(['--help'])
  assert.equal(r.code, 0)
  assert.match(r.out, /scope-gate/)
})

test('large output survives a pipe', () => {
  // process.exit drops whatever of an async pipe write has not flushed, which
  // truncated --format json at the 64KB pipe buffer and handed CI unparseable
  // output. Enough findings to cross that buffer several times over.
  const paths = Array.from({ length: 4000 }, (_, i) => `ci/gen/f${i}.yml`).join('\n')
  const r = run(['--territory', 'api', '--format', 'json', '--all'], paths)
  assert.ok(r.out.length > 65536, `expected more than one pipe buffer, got ${r.out.length}`)
  const parsed = JSON.parse(r.out) as { findings: unknown[] }
  assert.equal(parsed.findings.length, 4000)
})

test('a real unified diff on stdin', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1234567..89abcde 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,2 @@',
    '-const x = 1',
    '+const x = 2',
    ''
  ].join('\n')
  assert.equal(run(['--territory', 'api'], diff).code, 0)
  assert.equal(run(['--territory', 'platform'], diff).code, 1)
})

test('--all lists owned files that findings alone would omit', () => {
  const quiet = run(['--territory', 'api'], 'src/a.ts\n')
  const loud = run(['--territory', 'api', '--all'], 'src/a.ts\n')
  assert.ok(!quiet.out.includes('src/a.ts'))
  assert.ok(loud.out.includes('src/a.ts'))
})

test('--repo names the diff\'s repository when the map governs several', () => {
  const multi = join(dir, 'multi.yaml')
  writeFileSync(
    multi,
    `version: 1
actors:
  a1: { type: llm-agent, context: c }
repositories:
  app: {}
  sdk: {}
territories:
  api:
    owner: a1
    scope:
      - { repository: app, globs: ['src/**'] }
      - { repository: sdk, globs: ['**'] }
`
  )
  const withRepo = (repo: string) =>
    run(['--territory', 'api', '--repo', repo, '--map', multi], 'anything.ts\n')
  // Scope entries are per-repository: sdk claims everything, app does not.
  assert.equal(withRepo('sdk').code, 0)
  assert.equal(withRepo('app').code, 1)
  // Ambiguous without --repo.
  assert.equal(run(['--territory', 'api', '--map', multi], 'anything.ts\n').code, 2)
})

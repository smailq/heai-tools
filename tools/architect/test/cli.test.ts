import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cli = join(import.meta.dirname, '..', 'src', 'cli.ts')

const VALID = `version: 1
unowned: fail
actors:
  kyu: { type: human, identity: '@kyu' }
  api: { type: llm-agent, context: Owns the API. }
repositories:
  app: {}
territories:
  platform: { owner: kyu, scope: [{ repository: app, globs: ['architecture.yaml', 'ci/**'] }] }
  service: { owner: api, scope: [{ repository: app, globs: ['src/**'] }] }
`

const MULTI = `version: 1
actors:
  a1: { type: llm-agent, context: c }
  kyu: { type: human, identity: '@kyu' }
repositories:
  app: {}
  sdk: {}
territories:
  api:
    owner: a1
    scope:
      - { repository: app, globs: ['src/**'] }
      - { repository: sdk, globs: ['**'] }
  platform: { owner: kyu, scope: [{ repository: app, globs: ['ci/**'] }] }
`

/**
 * Run the command in a directory; stdin is a pipe even when empty, so `gate` never sees a TTY.
 * The host's HEAI_MAP and HEAI_DIR are dropped so discovery is what the test says it is.
 */
function run(args: string[], cwd: string, stdin = '', env: Record<string, string> = {}) {
  const { HEAI_MAP: _map, HEAI_DIR: _dir, ...inherited } = process.env
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', input: stdin, env: { ...inherited, ...env } })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function dir(yaml: string, name = 'architecture.yaml'): string {
  const d = mkdtempSync(join(tmpdir(), 'architect-cli-'))
  writeFileSync(join(d, name), yaml)
  return d
}

describe('the command', () => {
  it('needs a subcommand, and --help exits 0', () => {
    const d = dir(VALID)
    const bare = run([], d)
    assert.equal(bare.code, 2)
    assert.match(bare.err, /a subcommand is required/)
    assert.equal(run(['frobnicate'], d).code, 2)
    const help = run(['--help'], d)
    assert.equal(help.code, 0)
    assert.match(help.out, /architect check/)
    assert.match(help.out, /architect gate/)
    assert.equal(run(['check', '--bogus'], d).code, 2)
  })
})

describe('check', () => {
  it('exits 0 on a valid map, prints warnings, and --strict turns them into 1', () => {
    // Give the map an actor that owns nothing, which is a warning.
    const d = dir(VALID.replace('  api: { type: llm-agent, context: Owns the API. }', '  api: { type: llm-agent, context: Owns the API. }\n  spare: { type: llm-agent, context: Idle. }'))
    const r = run(['check'], d)
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /warning: actors.spare: declared but neither owns nor watches/)
    assert.match(r.out, /valid with 1 warning/)
    assert.equal(run(['check', '--strict'], d).code, 1)
    const j = JSON.parse(run(['check', '--format', 'json'], d).out) as { valid: boolean; warnings: string[]; map: unknown }
    assert.equal(j.valid, true)
    assert.equal(j.warnings.length, 1)
    assert.ok(j.map)
  })
  it('exits 1 on an invalid map and 2 on one that cannot be read', () => {
    const d = dir(VALID.replace('owner: api', 'owner: ghost'))
    const r = run(['check'], d)
    assert.equal(r.code, 1)
    assert.match(r.out, /error: territories.service: owner "ghost" is not a declared actor/)
    assert.equal(run(['check', 'nope.yaml'], d).code, 2)
    assert.equal(run(['check', '--map', 'nope.yaml'], d).code, 2)
    assert.equal(run(['check', '--schema', '/nowhere.json'], d).code, 2)
    assert.equal(run(['check', '--format', 'xml'], d).code, 2)
  })
  it('prefers .heai/architecture.yaml when it exists, for every subcommand', () => {
    const d = mkdtempSync(join(tmpdir(), 'architect-cli-'))
    mkdirSync(join(d, '.heai'))
    writeFileSync(join(d, '.heai', 'architecture.yaml'), VALID)
    writeFileSync(join(d, 'architecture.yaml'), 'version: 2\n')
    assert.match(run(['check'], d).out, /\.heai\/architecture\.yaml: valid/)
    assert.equal(run(['gate', '--actor', 'api'], d, 'src/a.ts\n').code, 0)
    assert.equal(run(['owner', 'src/a.ts'], d).code, 0)
  })
  it('finds the map in HEAI_DIR, after --map and HEAI_MAP and before .heai/', () => {
    const project = dir(VALID)
    // The current directory holds only a .heai map, and a wrong one, so a fall through would show.
    const d = mkdtempSync(join(tmpdir(), 'architect-cli-'))
    mkdirSync(join(d, '.heai'))
    writeFileSync(join(d, '.heai', 'architecture.yaml'), 'version: 2\n')
    const r = run(['check'], d, '', { HEAI_DIR: project })
    assert.equal(r.code, 0, r.err)
    assert.ok(r.out.startsWith(`${join(project, 'architecture.yaml')}: valid`), r.out)
    assert.equal(run(['owner', 'src/a.ts'], d, '', { HEAI_DIR: project }).code, 0)
    assert.equal(run(['gate', '--actor', 'api'], d, 'src/a.ts\n', { HEAI_DIR: project }).code, 0)
    // A relative HEAI_DIR resolves from the current directory.
    writeFileSync(join(d, 'architecture.yaml'), VALID)
    assert.match(run(['check'], d, '', { HEAI_DIR: '.' }).out, /: valid$/m)
    // --map and HEAI_MAP both outrank it.
    const other = dir(VALID, 'other.yaml')
    assert.match(run(['check', '--map', join(other, 'other.yaml')], d, '', { HEAI_DIR: project }).out, /other\.yaml: valid/)
    assert.match(run(['check'], d, '', { HEAI_DIR: project, HEAI_MAP: join(other, 'other.yaml') }).out, /other\.yaml: valid/)
    // A HEAI_DIR without a map is unanswerable, not a fall through to the .heai map beside the caller.
    const empty = mkdtempSync(join(tmpdir(), 'architect-cli-'))
    const missing = run(['check'], d, '', { HEAI_DIR: empty })
    assert.equal(missing.code, 2)
    assert.match(missing.err, /cannot read architecture map/)
  })
})

describe('gate', () => {
  const d = dir(VALID)

  it('exit 0 when every changed path is owned, 1 on a violation or a closed unowned path', () => {
    const ok = run(['gate', '--territory', 'service'], d, 'src/a.ts\n')
    assert.equal(ok.code, 0, ok.err)
    assert.match(ok.out, /PASS/)
    const foreign = run(['gate', '--territory', 'service'], d, 'ci/release.yml\n')
    assert.equal(foreign.code, 1)
    assert.match(foreign.out, /FAIL/)
    assert.match(foreign.out, /foreign/)
    const stray = run(['gate', '--territory', 'service'], d, 'stray.txt\n')
    assert.equal(stray.code, 1)
    assert.match(stray.out, /unowned/)
  })
  it('confinement is symmetric, and a bare name resolves against both namespaces', () => {
    assert.equal(run(['gate', '--actor', 'kyu'], d, 'ci/release.yml\n').code, 0)
    assert.equal(run(['gate', '--actor', 'kyu'], d, 'src/a.ts\n').code, 1)
    assert.equal(run(['gate', 'api'], d, 'src/a.ts\n').code, 0)
    assert.equal(run(['gate', 'service'], d, 'src/a.ts\n').code, 0)
  })
  it('exits 2 for bad usage: a subject named twice, unknown, missing, or a bad format', () => {
    const twice = run(['gate', 'service', '--actor', 'kyu'], d, 'src/a.ts\n')
    assert.equal(twice.code, 2)
    assert.match(twice.err, /name the subject once/)
    assert.equal(run(['gate', '--territory', 'nope'], d, 'src/a.ts\n').code, 2)
    assert.equal(run(['gate'], d, 'src/a.ts\n').code, 2)
    assert.equal(run(['gate', '--territory', 'service', '--format', 'xml'], d, 'src/a.ts\n').code, 2)
    assert.equal(run(['gate', '--territory', 'service', '--map', '/nonexistent.yaml'], d, 'src/a.ts\n').code, 2)
  })
  it('refuses a map that reads but does not validate', () => {
    // The gate runs over the validated map, so a map with an unknown owner
    // is refused rather than judged.
    const bad = dir(VALID.replace('owner: api', 'owner: ghost'))
    const r = run(['gate', '--territory', 'platform'], bad, 'ci/x.yml\n')
    assert.equal(r.code, 2)
    assert.match(r.err, /does not validate/)
    assert.match(r.err, /owner "ghost"/)
  })
  it('json output carries the verdict, and large output survives a pipe', () => {
    const r = run(['gate', '--territory', 'service', '--format', 'json'], d, 'ci/release.yml\n')
    const parsed = JSON.parse(r.out) as { ok: boolean; violations: number; findings: unknown[] }
    assert.equal(parsed.ok, false)
    assert.equal(parsed.violations, 1)
    // Enough findings to cross the 64KB pipe buffer several times over.
    const paths = Array.from({ length: 4000 }, (_, i) => `ci/gen/f${i}.yml`).join('\n')
    const big = run(['gate', '--territory', 'service', '--format', 'json', '--all'], d, paths)
    assert.ok(big.out.length > 65536, `expected more than one pipe buffer, got ${big.out.length}`)
    assert.equal((JSON.parse(big.out) as { findings: unknown[] }).findings.length, 4000)
  })
  it('reads a real unified diff, and --all lists owned files that findings alone would omit', () => {
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
    assert.equal(run(['gate', '--territory', 'service'], d, diff).code, 0)
    assert.equal(run(['gate', '--territory', 'platform'], d, diff).code, 1)
    const quiet = run(['gate', '--territory', 'service'], d, 'src/a.ts\n')
    const loud = run(['gate', '--territory', 'service', '--all'], d, 'src/a.ts\n')
    assert.ok(!quiet.out.includes('src/a.ts'))
    assert.ok(loud.out.includes('src/a.ts'))
  })
  it("--repo names the diff's repository when the map governs several", () => {
    const m = dir(MULTI)
    // Scope entries are per-repository: sdk claims everything, app does not.
    assert.equal(run(['gate', '--territory', 'api', '--repo', 'sdk'], m, 'anything.ts\n').code, 0)
    assert.equal(run(['gate', '--territory', 'api', '--repo', 'app'], m, 'anything.ts\n').code, 1)
    assert.equal(run(['gate', '--territory', 'api'], m, 'anything.ts\n').code, 2)
  })
})

describe('queries', () => {
  it('owner, territories, actors, context and template', () => {
    const d = dir(VALID)
    assert.match(run(['owner', 'src/a.ts'], d).out, /src\/a\.ts  service  owned by api \(llm-agent\)/)
    assert.equal(run(['owner', 'README.md'], d).code, 1)
    assert.equal(JSON.parse(run(['owner', 'src/a.ts', '--json'], d).out).owner, 'api')
    assert.match(run(['territories', '--actor', 'api'], d).out, /^service\s+api/m)
    assert.match(run(['actors'], d).out, /^api\s+llm-agent\s+owns service/m)
    assert.match(run(['context', 'api'], d).out, /# actor:api\n\nOwns the API\./)
    assert.equal(run(['context', 'nobody'], d).code, 2)
    assert.match(run(['template'], d).out, /^version: 1/)
  })
  it('--json carries what a script needs to route a task and compose a prompt', () => {
    const d = dir(VALID.replace('context: Owns the API. }', 'context: Owns the API., watches: [platform] }'))
    const owner = JSON.parse(run(['owner', 'src/a.ts', '--json'], d).out)
    assert.deepEqual(owner, { path: 'src/a.ts', repository: 'app', territory: 'service', owner: 'api', ownerType: 'llm-agent' })
    const territories = JSON.parse(run(['territories', '--json'], d).out) as { name: string }[]
    assert.deepEqual(
      territories.find((t) => t.name === 'service'),
      { name: 'service', owner: 'api', ownerType: 'llm-agent', declaredOwner: 'api', parent: null, globs: [{ repository: 'app', globs: ['src/**'] }], dependsOn: [], hasContext: false }
    )
    const actors = JSON.parse(run(['actors', '--json'], d).out) as { name: string }[]
    assert.deepEqual(actors.find((a) => a.name === 'api'), { name: 'api', type: 'llm-agent', identity: null, owns: ['service'], watches: ['platform'], hasContext: true })
    const context = JSON.parse(run(['context', 'api', '--json'], d).out)
    assert.deepEqual(context.own, [{ from: 'actor:api', context: 'Owns the API.' }])
    assert.deepEqual(context.owned, [{ territory: 'service', layers: [] }])
    assert.deepEqual(context.watched, [{ territory: 'platform', owner: 'kyu', layers: [] }])
  })
  it('refuses to answer for a map that does not validate', () => {
    const d = dir(VALID.replace('owner: api', 'owner: ghost'))
    const r = run(['owner', 'src/a.ts'], d)
    assert.equal(r.code, 2)
    assert.match(r.err, /does not validate/)
  })
})

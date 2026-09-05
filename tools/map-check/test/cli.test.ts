import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cli = join(import.meta.dirname, '..', 'src', 'cli.ts')

const VALID = `version: 1
actors:
  kyu: { type: human, identity: '@kyu' }
  api: { type: llm-agent, context: Owns the API. }
repositories:
  app: {}
territories:
  platform: { owner: kyu, scope: [{ repository: app, globs: ['architecture.yaml'] }] }
  service: { owner: api, scope: [{ repository: app, globs: ['src/**'] }] }
`

function run(args: string[], cwd: string) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function dir(yaml: string, name = 'architecture.yaml'): string {
  const d = mkdtempSync(join(tmpdir(), 'map-check-cli-'))
  writeFileSync(join(d, name), yaml)
  return d
}

describe('validate', () => {
  it('exits 0 on a valid map, prints warnings, and --strict turns them into 1', () => {
    const d = dir(VALID + '  spare: { type: llm-agent, context: Idle. }\n'.replace('  spare', 'x').replace('x', '  spare').replace(/^/, ''))
    // Give the map an actor that owns nothing, which is a warning.
    writeFileSync(join(d, 'architecture.yaml'), VALID.replace("  api: { type: llm-agent, context: Owns the API. }", "  api: { type: llm-agent, context: Owns the API. }\n  spare: { type: llm-agent, context: Idle. }"))
    const r = run([], d)
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /warning: actors.spare: declared but neither owns nor watches/)
    assert.match(r.out, /valid with 1 warning/)
    assert.equal(run(['--strict'], d).code, 1)
    const j = JSON.parse(run(['--format', 'json'], d).out) as { valid: boolean; warnings: string[]; map: unknown }
    assert.equal(j.valid, true)
    assert.equal(j.warnings.length, 1)
    assert.ok(j.map)
  })
  it('exits 1 on an invalid map and 2 on one that cannot be read', () => {
    const d = dir(VALID.replace('owner: api', 'owner: ghost'))
    const r = run([], d)
    assert.equal(r.code, 1)
    assert.match(r.out, /error: territories.service: owner "ghost" is not a declared actor/)
    assert.equal(run(['nope.yaml'], d).code, 2)
    assert.equal(run(['--schema', '/nowhere.json'], d).code, 2)
  })
  it('prefers .heai/architecture.yaml when it exists', () => {
    const d = mkdtempSync(join(tmpdir(), 'map-check-cli-'))
    execFileSync('mkdir', ['-p', join(d, '.heai')])
    writeFileSync(join(d, '.heai', 'architecture.yaml'), VALID)
    writeFileSync(join(d, 'architecture.yaml'), 'version: 2\n')
    assert.match(run([], d).out, /\.heai\/architecture\.yaml: valid/)
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
  it('refuses to answer for a map that does not validate', () => {
    const d = dir(VALID.replace('owner: api', 'owner: ghost'))
    const r = run(['owner', 'src/a.ts'], d)
    assert.equal(r.code, 2)
    assert.match(r.err, /does not validate/)
  })
})

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

// The server listens at import, so it is exercised as the process it is.
const serverPath = join(import.meta.dirname, '..', 'src', 'server.ts')
let child: ChildProcess
let origin: string

before(async () => {
  const port = 18000 + Math.floor(Math.random() * 20000)
  child = spawn(process.execPath, [serverPath, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
  origin = `http://127.0.0.1:${port}`
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (c: Buffer) => {
      if (c.toString().includes('map-editor:')) resolve()
    })
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)))
    setTimeout(() => reject(new Error('server did not start')), 10000)
  })
})
after(() => child.kill())

const post = (path: string, body: unknown) =>
  fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('the endpoints over architect', () => {
  it('validates yaml and a document through the package', async () => {
    const template = (await (await fetch(`${origin}/api/template`)).json()) as { yaml: string; map: unknown }
    assert.match(template.yaml, /^version: 1/)
    const ok = (await (await post('/api/validate', { yaml: template.yaml })).json()) as { valid: boolean; errors: string[] }
    assert.equal(ok.valid, true, ok.errors.join('\n'))
    const bad = (await (await post('/api/validate', { map: { version: 1 } })).json()) as { valid: boolean; errors: string[] }
    assert.equal(bad.valid, false)
    assert.ok(bad.errors.length > 0)
  })
  it('serializes a document to yaml', async () => {
    const r = (await (await post('/api/serialize', { map: { version: 1, actors: {} } })).json()) as { yaml: string }
    assert.match(r.yaml, /^version: 1\nactors: \{\}/)
  })
  it('serves the schema it validates against', async () => {
    const schema = (await (await fetch(`${origin}/api/schema`)).json()) as { title: string }
    assert.equal(schema.title, 'heai-tools architecture map')
  })
})

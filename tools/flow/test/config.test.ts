import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, SCHEMA_PATH, schemaProblems } from '../src/config.ts'

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

test('the schema is draft 2020-12, with an id, a title, and a description on every property', () => {
  assert.ok(existsSync(SCHEMA_PATH))
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>
  assert.equal(schema['$schema'], 'https://json-schema.org/draft/2020-12/schema')
  assert.equal(typeof schema['$id'], 'string')
  assert.equal(typeof schema['title'], 'string')
  assert.ok(isRecord(schema['properties']))
  for (const [k, v] of Object.entries(schema['properties'])) assert.ok(isRecord(v) && typeof v['description'] === 'string', `${k} is described`)
})

test('an absent, empty, or full file loads; the flows directory resolves against the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-config-'))
  const path = join(dir, 'flow.yaml')
  assert.deepEqual(loadConfig(path), { path: null, flows: null })
  writeFileSync(path, '')
  assert.deepEqual(loadConfig(path), { path, flows: null })
  writeFileSync(path, 'flows: ../defs\n')
  assert.deepEqual(loadConfig(path), { path, flows: join(dir, '..', 'defs') })
  writeFileSync(path, 'flows: /abs/defs\n')
  assert.deepEqual(loadConfig(path), { path, flows: '/abs/defs' })
  assert.deepEqual(schemaProblems({ flows: 'x' }), [])
  assert.deepEqual(schemaProblems({}), [])
})

test('every problem is reported at once, each with its path', () => {
  assert.deepEqual(schemaProblems({ bogus: 1, flows: '' }), [
    '/: unknown key "bogus"; the keys are flows',
    '/flows: must be a directory'
  ])
  const dir = mkdtempSync(join(tmpdir(), 'flow-config-'))
  const path = join(dir, 'flow.yaml')
  writeFileSync(path, 'flows: ""\n')
  assert.throws(() => loadConfig(path), new RegExp(`^UsageError: ${path}: /flows: must be a directory$`))
  writeFileSync(path, 'bogus: 1\nflows: ""\n')
  assert.throws(() => loadConfig(path), /2 problems\n  \/: unknown key "bogus"; the keys are flows\n  \/flows: must be a directory/)
  writeFileSync(path, '- a\n')
  assert.throws(() => loadConfig(path), /must be a mapping/)
})

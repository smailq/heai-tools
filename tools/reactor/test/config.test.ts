// reactor.yaml against its schema: every configuration this README shows
// validates - each block on its own, and all of them together as one file -
// and a configuration with an unknown key, a wrong type and a bad duration is
// refused with the path of each problem. The configurations the other tests
// use pass through the same loader in makeWorld, so they are pinned there.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { parseConfig, SCHEMA_PATH, schemaProblems } from '../src/config.ts'
import { isRecord } from '../src/errors.ts'

const README = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8')

/** Every fenced yaml block in a stretch of markdown. */
const yamlBlocks = (md: string): string[] => [...md.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!)

/** The one example under "## Configuration". */
function configurationExample(): string {
  const start = README.indexOf('\n## Configuration')
  assert.ok(start > 0, 'the README has a Configuration section')
  const section = README.slice(start, README.indexOf('\n## ', start + 1))
  const blocks = yamlBlocks(section)
  assert.equal(blocks.length, 1, 'the Configuration section keeps one example')
  return blocks[0]!
}

test('the schema is draft 2020-12, with an id, a title, and a description on every property', () => {
  assert.ok(existsSync(SCHEMA_PATH))
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>
  assert.equal(schema['$schema'], 'https://json-schema.org/draft/2020-12/schema')
  assert.equal(typeof schema['$id'], 'string')
  assert.equal(typeof schema['title'], 'string')
  const undescribed: string[] = []
  const walk = (node: unknown, path: string) => {
    if (!isRecord(node)) return
    if (isRecord(node['properties'])) {
      for (const [k, v] of Object.entries(node['properties'])) {
        if (!isRecord(v) || typeof v['description'] !== 'string') undescribed.push(`${path}/properties/${k}`)
        walk(v, `${path}/properties/${k}`)
      }
    }
    for (const k of ['$defs', 'then', 'items', 'additionalProperties']) if (k in node) walk(node[k], `${path}/${k}`)
    if (isRecord(node['$defs'])) for (const [k, v] of Object.entries(node['$defs'])) walk(v, `${path}/$defs/${k}`)
    if (Array.isArray(node['allOf'])) node['allOf'].forEach((v, i) => walk(v, `${path}/allOf/${i}`))
  }
  walk(schema, '#')
  assert.deepEqual(undescribed, [])
})

test("every yaml block in the README validates on its own, and together they are one configuration that loads", () => {
  const blocks = yamlBlocks(README)
  assert.ok(blocks.length >= 6, 'the README shows the sources, the rules and the configuration')
  const merged: { sources: Record<string, unknown>; rules: unknown[]; [k: string]: unknown } = { sources: {}, rules: [] }
  for (const block of blocks) {
    const doc = parse(block) as Record<string, unknown>
    assert.deepEqual(schemaProblems(doc), [], block)
    for (const [k, v] of Object.entries(doc)) {
      if (k === 'sources' && isRecord(v)) Object.assign(merged.sources, v)
      else if (k === 'rules' && Array.isArray(v)) {
        // A later block restating a rule by name is the same rule.
        for (const r of v) if (!merged.rules.some((m) => isRecord(m) && isRecord(r) && m['name'] === r['name'])) merged.rules.push(r)
      } else merged[k] = v
    }
  }
  const config = parseConfig(stringify(merged), 'README.md')
  assert.ok(config.sources.length >= 9)
  assert.ok(config.sources.some((s) => s.type === 'cli'), 'the README shows a cli source')
  assert.ok(config.rules.length >= 6)
})

test("the README's configuration example loads by itself", () => {
  const config = parseConfig(configurationExample(), 'README.md')
  assert.equal(config.concurrency, 4)
  assert.deepEqual(config.receiver, { host: '127.0.0.1', port: 4949 })
  assert.deepEqual(
    config.sources.map((s) => [s.name, s.type]),
    [
      ['clock', 'schedule'],
      ['sentry', 'webhook'],
      ['tasks_cli', 'cli']
    ]
  )
  assert.deepEqual(config.sources[2]!.options, { kinds: ['task.todo', 'task.done'] })
  assert.deepEqual(
    config.rules.map((r) => r.name),
    ['sweep', 'sentry-to-owner', 'sweep-now']
  )
  assert.deepEqual(config.rules[1]!.limit, { count: 10, windowMs: 3_600_000 })
})

test('every source type and every option the loader accepts validates', () => {
  const yaml = `
concurrency: 2
receiver: { host: 0.0.0.0, port: 8080 }
sources:
  s: { type: schedule, cron: "0 2 * * *", utc: true, grace: 1m, every: 5s }
  g: { type: git, path: ../app, branches: [main, "integration/*"], every: 90, remote: origin, maxCommits: 50 }
  w: { type: webhook, path: /hook/github, provider: github, secret: env:HOOK }
  f: { type: webhook, path: /hook/any, secret: file:.secrets/any, kind: /type, key: /id }
  l: { type: webhook, path: /hook/plain, secret: plain }
  p: { type: poll, url: https://example.com/health, every: 5m, watch: status, headers: { Authorization: Bearer x }, timeout: 2s }
  c: { type: cli, kinds: [task.todo, task.done] }
  n: { type: cli }
  m: { type: ./sources/mine.ts, anything: [1, 2], goes: here }
rules:
  - { name: everything, run: "echo x" }
  - { name: full, on: { source: s, kind: tick, cron: "0 2 * * *", branch: main, links: { actor: a } }, run: scripts/x.sh, debounce: 5s, limit: 10/hour, repeat: true, timeout: 10m }
`
  assert.deepEqual(schemaProblems(parse(yaml)), [])
  const config = parseConfig(yaml, 'w')
  assert.equal(config.sources.length, 9)
  assert.deepEqual(config.sources[6]!.options, { kinds: ['task.todo', 'task.done'] })
  assert.deepEqual(config.sources[7]!.options, {})
  assert.deepEqual(config.sources[8]!.options, { anything: [1, 2], goes: 'here' })
})

test('an empty or absent file is an empty configuration', () => {
  assert.deepEqual(schemaProblems({}), [])
  assert.equal(parseConfig('', null).sources.length, 0)
  assert.equal(parseConfig('sources:\nrules:\n', 'w').rules.length, 0)
})

test('an unknown key, a wrong type and a bad duration are refused together, each with its path', () => {
  const yaml = `
bogus: 1
concurrency: four
sources:
  x: { type: schedule, cron: "* * * * *", grace: 5 minutes, foo: 1 }
  y: { type: nope }
  z: { type: webhook }
  c: { type: cli, every: 5s, kinds: [] }
  Bad Name: { type: cli }
rules:
  - { name: r, on: { source: x }, run: x, debounce: -1, limit: 10, file: { title: t } }
`
  assert.deepEqual(schemaProblems(parse(yaml)), [
    '/: unknown key "bogus"; the keys are sources, rules, concurrency, receiver',
    '/sources: "Bad Name" is not a lowercase word',
    '/sources/x: unknown key "foo"; the keys are type, cron, utc, grace, every',
    '/sources/x/grace: must be a duration like 5s, 10m, 2h or 1d',
    '/sources/y/type: must be one of schedule, git, webhook, poll, cli, dir, or a module path',
    '/sources/z: path is required',
    '/sources/c: unknown key "every"; the keys are type, kinds',
    '/sources/c/kinds: must be a list of kinds like [task.todo, task.done]',
    '/rules/0: unknown key "file"; the keys are name, on, run, debounce, limit, repeat, timeout',
    '/rules/0/debounce: must be a duration like 5s, 10m, 2h or 1d',
    '/rules/0/limit: must be a limit like 10/hour',
    '/concurrency: must be integer'
  ])
  assert.throws(() => parseConfig(yaml, 'reactor.yaml'), (e: Error) => e.name === 'UsageError' && e.message.startsWith('reactor.yaml: 12 problems\n  /: unknown key "bogus"') && e.message.includes('\n  /rules/0/limit: must be a limit like 10/hour'))
  assert.throws(() => parseConfig('rules: [ { name: a } ]\n', 'reactor.yaml'), /^UsageError: reactor.yaml: \/rules\/0: run is required$/)
  assert.throws(() => parseConfig('sources: { s: { type: poll, url: u, watch: nope } }\n', 'reactor.yaml'), /\/sources\/s\/watch: must be status, hash, or a JSON pointer/)
  assert.throws(() => parseConfig('sources: { s: { type: webhook, path: hook } }\n', 'reactor.yaml'), /\/sources\/s\/path: must be a path starting with \//)
  assert.throws(() => parseConfig('sources: { s: { type: git, path: r, every: "5 min" } }\n', 'reactor.yaml'), /\/sources\/s\/every: must be a duration like 5s, 10m, 2h or 1d/)
  assert.throws(() => parseConfig('receiver: { port: "4949" }\n', 'reactor.yaml'), /\/receiver\/port: must be integer/)
  assert.throws(() => parseConfig('flow: { command: flow }\n', 'reactor.yaml'), /\/: unknown key "flow"; the keys are sources, rules, concurrency, receiver/, 'no flow block')
  assert.throws(() => parseConfig('tasks: { dir: tasks }\n', 'reactor.yaml'), /\/: unknown key "tasks"/, 'no tasks block')
})

test('what the schema cannot say is still checked after it', () => {
  assert.throws(() => parseConfig('sources: {}\nrules:\n  - { name: a, on: { source: nope }, run: x }\n', 'w'), /listens to source nope, which is not declared/)
  assert.throws(() => parseConfig('rules:\n  - { name: a, run: x }\n  - { name: a, run: y }\n', 'w'), /two rules are named a/)
  assert.throws(() => parseConfig('sources:\n  c: { type: schedule, cron: "* * * * *" }\nrules:\n  - { name: a, on: { source: c, cron: "not cron" }, run: x }\n', 'w'), /on.cron/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render, renderDeep, renderString } from '../src/template.ts'

const ctx = { payload: { title: 'Boom', tags: { territory: 'website' }, paths: ['a.ts', 'b.ts'], count: 17, empty: '' }, id: 'f-1', links: { actor: 'alpha' } }

test('a path into the context', () => {
  assert.equal(renderString('Sentry: {{ payload.title }}', ctx), 'Sentry: Boom')
  assert.equal(renderString('{{ links.actor }} in {{ id }}', ctx), 'alpha in f-1')
  assert.equal(renderString('{{ payload.paths.1 }}', ctx), 'b.ts')
  assert.equal(renderString('{{ payload.missing.deep }}', ctx), '')
})

test('default fills an absent or empty value', () => {
  assert.equal(renderString("{{ payload.tags.territory | default: 'core' }}", ctx), 'website')
  assert.equal(renderString("{{ payload.tags.owner | default: 'core' }}", ctx), 'core')
  assert.equal(renderString('{{ payload.empty | default: "x" }}', ctx), 'x')
})

test('join renders a list', () => {
  assert.equal(renderString("{{ payload.paths | join: ', ' }}", ctx), 'a.ts, b.ts')
  assert.equal(renderString('{{ payload.paths | join }}', ctx), 'a.ts, b.ts')
  assert.equal(renderString('{{ payload.paths }}', ctx), 'a.ts, b.ts')
})

test('one bare expression keeps its type', () => {
  assert.equal(render('{{ payload.count }}', ctx), 17)
  assert.deepEqual(render('{{ payload.paths }}', ctx), ['a.ts', 'b.ts'])
  assert.equal(render('n={{ payload.count }}', ctx), 'n=17')
})

test('an unknown filter is refused', () => {
  assert.throws(() => render('{{ payload.title | upcase }}', ctx), /unknown filter/)
})

test('renderDeep walks mappings and lists and leaves other scalars alone', () => {
  assert.deepEqual(renderDeep({ a: '{{ id }}', b: ['{{ payload.count }}', true], c: 3 }, ctx), { a: 'f-1', b: [17, true], c: 3 })
})

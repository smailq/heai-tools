import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from '../src/store.ts'
import { renderIndex } from '../src/render.ts'

function tracker(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-'))
  mkdirSync(join(dir, 'items'), { recursive: true })
  for (const [path, contents] of Object.entries(files)) writeFileSync(join(dir, path), contents)
  return dir
}

const task = (f: Record<string, string>): string =>
  `---\ntitle: ${f['title'] ?? 'A task'}\nstatus: ${f['status'] ?? 'todo'}\npriority: ${f['priority'] ?? ''}\nterritory: ${f['territory'] ?? ''}\ncreated_at: 2026-08-20\nmodified_at: 2026-08-20\n---\n\nBody.\n`

test('the index groups by status in pick-up order, with unset fields dashed', () => {
  const store = load(
    tracker({
      'items/alpha.md': task({ title: 'Alpha', status: 'in-progress' }),
      'items/beta.md': task({ title: 'Beta', status: 'backlog', priority: 'low' })
    })
  )
  const out = renderIndex(store)
  assert.ok(out.includes('**2 tasks** - in-progress: 1'))
  assert.ok(out.includes('- [alpha](items/alpha.md) · p:- · t:- - Alpha'))
  assert.ok(out.indexOf('## in-progress') < out.indexOf('## backlog'))
  assert.ok(out.includes('## done (0)\n\n(none)'))
  assert.ok(out.includes('Do not edit by hand'))
})

test('a territory list is one token in the index, so an entry stays greppable', () => {
  const store = load(tracker({ 'items/cross.md': task({ title: 'Cross', territory: 'web, api' }) }))
  assert.ok(renderIndex(store).includes('- [cross](items/cross.md) · p:- · t:api,web - Cross'))
})

test('the index is stable across regenerations', () => {
  const dir = tracker({
    'items/b.md': task({ priority: 'high' }),
    'items/a.md': task({ priority: 'high' })
  })
  assert.equal(renderIndex(load(dir)), renderIndex(load(dir)))
})

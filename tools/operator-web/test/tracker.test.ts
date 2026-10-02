import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { blockerState, bySlug, counts, loadTracker, parseTask, trackerRed } from '../src/tracker.ts'
import { FIXTURES } from './helpers.ts'

const TASK = `---
title: Add place entity: with a colon
status: todo
priority:
territory: desktop, core ,desktop
created_at: 2026-09-01
modified_at: 2026-09-02
---

Blocked by [other](other.md), and more.
`

test('a task file: fields, an empty priority unset rather than invalid, territories sorted and unique, the blocker', () => {
  const t = parseTask('add-place', TASK)
  assert.deepEqual(t.problems, [])
  assert.equal(t.title, 'Add place entity: with a colon')
  assert.equal(t.priority, '')
  assert.deepEqual(t.territories, ['core', 'desktop'])
  assert.equal(t.blocker, 'other')
})

test('every problem in one pass, and no frontmatter is a problem, not a throw', () => {
  const t = parseTask('x', '---\ntitle:\nstatus: nope\nweird: 1\nstatus: todo\n---\n')
  assert.ok(t.problems.includes('unknown frontmatter key: weird'))
  assert.ok(t.problems.includes('duplicate frontmatter key: status'))
  assert.ok(t.problems.includes('missing frontmatter key: priority'))
  assert.ok(t.problems.includes('title must not be empty'))
  assert.ok(t.problems.some((p) => p.startsWith('status "nope" not in')))
  assert.ok(t.problems.includes('body must not be empty'))
  assert.deepEqual(parseTask('y', 'no frontmatter').problems, ["missing frontmatter opening '---'"])
})

test('the fixture tracker: every .md kept, the map resolved against it, pick-up order, blockers, red', () => {
  const tr = loadTracker(join(FIXTURES, 'tracker'))
  assert.equal(tr.tasks.length, 11, 'notes.txt skipped, broken.md kept')
  assert.equal(tr.map, join(FIXTURES, 'architecture.yaml'))
  const c = counts(tr)
  assert.deepEqual([c['in-progress'], c['blocked'], c['todo'], c['backlog'], c['done'], c['canceled']], [1, 3, 2, 1, 1, 1])
  assert.equal(
    tr.tasks.map((t) => t.slug).join(' '),
    'add-place-entity inline-images-from-eml document-tabs merge-two-entities multiple-workspaces do-the-thing help-requested-by-web-ui receipts-rollup-view old-and-done ontology-entity-identity broken'
  )
  assert.equal(blockerState(tr, bySlug(tr, 'document-tabs')!), 'todo')
  assert.equal(blockerState(tr, bySlug(tr, 'multiple-workspaces')!), 'canceled')
  assert.equal(blockerState(tr, bySlug(tr, 'merge-two-entities')!), 'missing')
  assert.equal(blockerState(tr, bySlug(tr, 'do-the-thing')!), '')
  assert.ok(trackerRed(tr))
})

test('a directory without items/ is not a tracker', () => {
  assert.throws(() => loadTracker(mkdtempSync(join(tmpdir(), 'not-tracker-'))), /not a tracker directory/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The palette is task-manager's, token for token, so the two pages read as one
// application. Pinned here because a palette is the kind of thing that gets
// tidied toward whatever a neighbouring file happens to use.
const here = import.meta.dirname
const ours = readFileSync(join(here, '..', 'public', 'style.css'), 'utf8')
const theirs = readFileSync(join(here, '..', '..', 'task-manager', 'public', 'style.css'), 'utf8')

const tokens = (css: string, dark: boolean): Record<string, string> => {
  const block = dark ? css.match(/prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/)![1]! : css.match(/^:root\s*\{([^}]*)\}/m)![1]!
  return Object.fromEntries([...block.matchAll(/(--[a-z-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]))
}

test('every colour token matches task-manager, in both themes', () => {
  for (const dark of [false, true]) {
    const a = tokens(ours, dark)
    const b = tokens(theirs, dark)
    assert.ok(Object.keys(a).length >= 19, `${dark ? 'dark' : 'light'} theme has tokens`)
    assert.deepEqual(a, b, dark ? 'dark' : 'light')
  }
})

test('the states and verdicts each carry a tint', () => {
  for (const cls of ['busy', 'idle', 'blocked', 'failed', 'lost', 'canceled', 'succeeded', 'queued', 'gate-clean', 'gate-violation', 'gate-error']) {
    assert.match(ours, new RegExp(`\\.badge\\.${cls}\\b`), cls)
  }
})

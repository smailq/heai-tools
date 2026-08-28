import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CSS = readFileSync(
  join(dirname(dirname(fileURLToPath(import.meta.url))), 'public', 'style.css'),
  'utf8'
)

/**
 * The palette, pinned.
 *
 * These are the values the tracker this tool was built from uses, copied so
 * the two look like the same application. They are pinned because a palette is
 * the kind of thing that gets "tidied" toward whatever a neighbouring file
 * happens to use, and nothing fails when it does - the page still renders, in
 * the wrong colours.
 */
const LIGHT = {
  '--page': '#f6f7f9',
  '--card': '#ffffff',
  '--text': '#22272e',
  '--muted': '#77808b',
  '--accent': '#2563eb',
  '--border': '#e3e7ec',
  '--sel': '#eaf1fe',
  '--danger': '#b91c1c'
}

/** The badge tints, which carry the meaning a status or a priority has. */
const LIGHT_TINTS = {
  '--tint-neutral': '#eef1f5',
  '--tint-neutral-fg': '#77808b',
  '--tint-red': '#fde8e8',
  '--tint-red-fg': '#b91c1c',
  '--tint-amber': '#fef3c7',
  '--tint-amber-fg': '#92400e',
  '--tint-blue': '#e0edff',
  '--tint-blue-fg': '#1d4ed8',
  '--tint-green': '#e7f6ec',
  '--tint-green-fg': '#15803d',
  '--tint-purple': '#ede9fe',
  '--tint-purple-fg': '#6d28d9'
}

/** The `:root` block for a theme: the bare one, or the one under dark mode. */
function tokens(theme: 'light' | 'dark'): Record<string, string> {
  const start =
    theme === 'light'
      ? CSS.indexOf(':root {')
      : CSS.indexOf(':root {', CSS.indexOf('@media (prefers-color-scheme: dark)'))
  assert.notEqual(start, -1, `no :root block for ${theme}`)
  const block = CSS.slice(start, CSS.indexOf('}', start))
  const found: Record<string, string> = {}
  for (const [, name, value] of block.matchAll(/(--[a-z-]+):\s*([^;]+);/g)) {
    found[name!] = value!.trim()
  }
  return found
}

test('the light palette is the one it was copied from', () => {
  const found = tokens('light')
  for (const [name, value] of Object.entries({ ...LIGHT, ...LIGHT_TINTS })) {
    assert.equal(found[name], value, name)
  }
})

/**
 * The source has only a light theme, so every dark value is derived here. What
 * is pinned is not the values but the relationships they have to hold, since a
 * derived palette is exactly where a single wrong value hides.
 */
const ALL = [...Object.keys(LIGHT), ...Object.keys(LIGHT_TINTS)]

test('dark defines every token, and none of them are the light value', () => {
  const light = tokens('light')
  const dark = tokens('dark')
  for (const name of ALL) {
    assert.ok(dark[name], `${name} missing in dark`)
    assert.notEqual(dark[name], light[name], `${name} is unchanged in dark`)
  }
})

test('the page and card surfaces are distinct in both themes', () => {
  // A card sits above the page. If the two collapse to one value the layout
  // still renders, and every boundary the design relies on disappears.
  for (const theme of ['light', 'dark'] as const) {
    const found = tokens(theme)
    assert.notEqual(found['--page'], found['--card'], `page and card equal in ${theme}`)
  }
})

test('each badge tint pairs a background with its own foreground', () => {
  for (const theme of ['light', 'dark'] as const) {
    const found = tokens(theme)
    for (const name of ALL.filter((n) => n.startsWith('--tint') && !n.endsWith('-fg'))) {
      assert.notEqual(found[name], found[`${name}-fg`], `${name} in ${theme}`)
    }
  }
})

test('a badge carries a tinted background, not just tinted text', () => {
  // The flattening this guards against: keeping the colour on the text and
  // dropping it from the pill, which reads as a different design.
  const block = CSS.slice(CSS.indexOf('.badge.p-urgent'), CSS.indexOf('.muted {'))
  assert.match(block, /background: var\(--tint-red\)/)
  assert.match(block, /background: var\(--tint-green\)/)
  assert.match(block, /background: var\(--tint-purple\)/)
})

test('the two themes declare exactly the same token set', () => {
  // A token defined only in light mode silently keeps its light value in dark
  // mode, which is the one CSS bug a reader will not see coming.
  assert.deepEqual(Object.keys(tokens('light')).sort(), Object.keys(tokens('dark')).sort())
})

test('no colour is used outside the token set', () => {
  const literals = CSS.slice(CSS.indexOf('body {')).match(/#[0-9a-f]{3,8}\b/gi) ?? []
  assert.deepEqual(literals, [], 'colours below the token block must be var(--token)')
})

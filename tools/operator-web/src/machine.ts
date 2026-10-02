// A flow definition drawn as the state machine it is: states as boxes,
// transitions as arrows labelled with the event that takes them and what the
// event must carry. The drawing is laid out here, in layers, and sent as SVG,
// so the page needs no script to show it.
//
// The layout is the layered one state-machine drawings use, cut down to what a
// definition of a dozen states needs:
//
//  1. Walk the machine from its initial state; a transition back to a state still
//     on the walk closes a cycle and is drawn upward, so every other arrow points down.
//  2. Rank each state by its longest path from the initial one.
//  3. Put a layer between every two ranks for the transitions' labels, and give a
//     transition that spans several ranks a waypoint in every layer it crosses, so
//     labels and long arrows take room like states do and nothing is drawn over a box.
//  4. Order each layer to keep arrows short and uncrossed (barycentres, swept down
//     and up), then place each box under the mean of its neighbours without overlap.

import { basename } from 'node:path'
import type { Definition, Transition } from './flows.ts'
import { spelled } from './format.ts'
import { esc } from './html.ts'

export interface Machine {
  def: Definition
  /** How many flows stand in each state: open ones, and in a terminal state the ones that ended there. */
  counts?: Record<string, number>
  /** The state one flow stands in; the moves it made and the states it passed through. */
  current?: string
  taken?: Set<string>
  visited?: Set<string>
  /** Where a state links, or "" for no link. */
  href?: (state: string) => string
}

/** The key of a move in `taken`. */
export const moveKey = (from: string, to: string): string => `${from}\u0000${to}`

// Sizes in pixels, for the page's 12px monospace face.
const CHAR_W = 7.2
const SMALL_W = 6.6
const LINE_H = 14
const NODE_H = 34
const PAD_X = 14
const GAP_X = 26
const GAP_Y = 14
const DUMMY_W = 8
const MARGIN = 20

interface Item {
  state: string // a state's name, or "" for a waypoint
  label: string[] | null
  w: number
  h: number
  x: number
  y: number
  layer: number
  order: number
  loop: string[] | null
}

interface Chain {
  from: string
  to: string
  items: Item[] // source, waypoints, target: all downward
  reversed: boolean // drawn from the last item to the first
  label: string[]
  taken: boolean
}

interface Edge {
  from: string
  to: string
  label: string[]
  wide: boolean
}

const textW = (s: string, w: number): number => [...s].length * w

/** What takes a transition, one line each: the event, then its conditions, indented. */
export function transitionLabel(t: Transition): string[] {
  const lines = [t.on]
  const when = t.when ?? {}
  const keys = Object.keys(when).sort()
  if (keys.length) lines.push('  when ' + keys.map((k) => `${k}=${String(when[k])}`).join(' '))
  if (t.after !== null && t.after !== undefined) lines.push('  after ' + spelled(t.after))
  if (t.requires?.waitsOn.all.length) lines.push('  waits on: all ' + t.requires.waitsOn.all.join('|'))
  if (t.by?.length) lines.push('  by ' + t.by.join(', '))
  return lines
}

/** The script a state runs on entry, by file name and arguments: "▸ start.sh". */
export function hookName(run: string): string {
  const f = run.trim().split(/\s+/)
  if (!f[0]) return ''
  f[0] = basename(f[0])
  return '▸ ' + f.join(' ')
}

/** Words joined into lines of at most width characters, indented as a label's continuation. */
function wrapWords(words: string[], width: number): string[] {
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > width) {
      lines.push('  ' + cur)
      cur = ''
    }
    cur = cur ? `${cur} ${w}` : w
  }
  if (cur) lines.push('  ' + cur)
  return lines
}

const loopWidth = (label: string[]): number => Math.max(30, ...label.map((l) => textW(l, SMALL_W) + 30))

const f1 = (n: number): string => n.toFixed(1)

/** Lays the definition out and returns it as an inline SVG, or "" for a definition with no states. */
export function renderMachine(m: Machine): string {
  const d = m.def
  const states = d.states ?? []
  if (!states.length) return ''
  const terminal = new Set(d.terminal ?? [])
  const hooks = d.hooks ?? {}
  const counts = m.counts ?? {}
  const known = new Set(states)

  // Transitions from three or more states to one, on the same event and conditions, are one
  // rule - "cancel from anywhere" - written once on the state they reach instead of drawn as
  // that many arrows, which would hide the rest. They still rank that state below its sources.
  const groups: Array<{ t: Transition; froms: string[] }> = []
  const byRule = new Map<string, { t: Transition; froms: string[] }>()
  for (const t of d.transitions ?? []) {
    if (!known.has(t.from) || !known.has(t.to)) continue
    const key = t.to + '\u0000' + transitionLabel(t).join('\u0000')
    let g = byRule.get(key)
    if (!g) {
      g = { t, froms: [] }
      byRule.set(key, g)
      groups.push(g)
    }
    g.froms.push(t.from)
  }
  const notes = new Map<string, string[]>()
  const edges: Edge[] = []
  const pair = new Map<string, Edge>()
  for (const g of groups) {
    if (g.froms.length >= 3 && g.t.from !== g.t.to) {
      notes.set(g.t.to, [...(notes.get(g.t.to) ?? []), `← ${transitionLabel(g.t).join(' ')}, from any of`, ...wrapWords(g.froms, 34)])
      for (const f of g.froms) edges.push({ from: f, to: g.t.to, label: [], wide: true })
      continue
    }
    for (const f of g.froms) {
      const k = moveKey(f, g.t.to)
      const e = pair.get(k)
      if (e) {
        e.label.push(...transitionLabel(g.t))
        continue
      }
      const ne: Edge = { from: f, to: g.t.to, label: transitionLabel(g.t), wide: false }
      pair.set(k, ne)
      edges.push(ne)
    }
  }

  // 1. The walk: discovery order, and which transitions close a cycle.
  const out = new Map<string, Edge[]>()
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e])
  const order = new Map<string, number>()
  const onStack = new Set<string>()
  const back = new Set<Edge>()
  const walk = (s: string): void => {
    order.set(s, order.size)
    onStack.add(s)
    for (const e of out.get(s) ?? []) {
      if (e.to === s) continue
      if (onStack.has(e.to)) back.add(e)
      else if (!order.has(e.to)) walk(e.to)
    }
    onStack.delete(s)
  }
  if (d.initial && known.has(d.initial)) walk(d.initial)
  for (const s of states) if (!order.has(s)) walk(s)

  // 2. Ranks: the longest path from the initial state over the downward arrows.
  const down = (e: Edge): [string, string] => (back.has(e) ? [e.to, e.from] : [e.from, e.to])
  const rank = new Map<string, number>(states.map((s) => [s, 0]))
  for (let changed = true, n = 0; changed && n <= states.length; n++) {
    changed = false
    for (const e of edges) {
      if (e.from === e.to) continue
      const [u, v] = down(e)
      if (rank.get(v)! < rank.get(u)! + 1) {
        rank.set(v, rank.get(u)! + 1)
        changed = true
      }
    }
  }

  // The states, as items on the even layers.
  const items = new Map<string, Item>()
  const layers: Item[][] = []
  const put = (it: Item): void => {
    while (layers.length <= it.layer) layers.push([])
    it.order = layers[it.layer]!.length
    layers[it.layer]!.push(it)
  }
  const sorted = [...states].sort((a, b) => order.get(a)! - order.get(b)!)
  for (const s of sorted) {
    const it: Item = { state: s, label: null, w: textW(s, CHAR_W) + 2 * PAD_X, h: 0, x: 0, y: 0, layer: 2 * rank.get(s)!, order: 0, loop: null }
    let lines = 0
    const hook = hooks[s]?.run
    if (hook) {
      it.w = Math.max(it.w, textW(hookName(hook), SMALL_W) + 2 * PAD_X)
      lines++
    }
    for (const n of notes.get(s) ?? []) {
      it.w = Math.max(it.w, textW(n, SMALL_W) + 2 * PAD_X)
      lines++
    }
    if ((counts[s] ?? 0) > 0) it.w += 26
    it.h = NODE_H + lines * LINE_H
    items.set(s, it)
    put(it)
  }

  // 3. The arrows: a waypoint in every layer between their ends, the first carrying the label.
  const chains: Chain[] = []
  for (const e of edges) {
    if (e.wide) continue
    const c: Chain = { from: e.from, to: e.to, items: [], reversed: false, label: e.label, taken: m.taken?.has(moveKey(e.from, e.to)) ?? false }
    if (e.from === e.to) {
      // A transition that stays: a loop on the box's right, its label beside it.
      const it = items.get(e.from)!
      it.loop = e.label
      it.w += loopWidth(e.label)
      chains.push(c)
      continue
    }
    const [u, v] = down(e)
    c.reversed = back.has(e)
    const top = items.get(u)!
    const bottom = items.get(v)!
    c.items.push(top)
    for (let l = top.layer + 1; l < bottom.layer; l++) {
      const wp: Item = { state: '', label: null, w: DUMMY_W, h: 0, x: 0, y: 0, layer: l, order: 0, loop: null }
      if (l === top.layer + 1 && c.label.length) {
        wp.label = c.label
        wp.w = Math.max(wp.w, ...c.label.map((s) => textW(s, SMALL_W) + 14))
        wp.h = c.label.length * LINE_H
      }
      put(wp)
      c.items.push(wp)
    }
    c.items.push(bottom)
    chains.push(c)
  }

  // Neighbours across adjacent layers, from the chains' consecutive items.
  const up = new Map<Item, Item[]>()
  const dn = new Map<Item, Item[]>()
  for (const c of chains) {
    for (let i = 0; i + 1 < c.items.length; i++) {
      const a = c.items[i]!
      const b = c.items[i + 1]!
      dn.set(a, [...(dn.get(a) ?? []), b])
      up.set(b, [...(up.get(b) ?? []), a])
    }
  }

  // 4. Order: barycentres, swept down and up.
  const sortLayer = (l: Item[], nb: Map<Item, Item[]>): void => {
    const key = new Map<Item, number>()
    for (const it of l) {
      const ns = nb.get(it) ?? []
      key.set(it, ns.length ? ns.reduce((s, n) => s + n.order, 0) / ns.length : it.order)
    }
    l.sort((a, b) => key.get(a)! - key.get(b)!)
    l.forEach((it, i) => (it.order = i))
  }
  for (let pass = 0; pass < 8; pass++) {
    if (pass % 2 === 0) for (let i = 1; i < layers.length; i++) sortLayer(layers[i]!, up)
    else for (let i = layers.length - 2; i >= 0; i--) sortLayer(layers[i]!, dn)
  }

  // Place: each item toward its neighbours' mean, keeping order and gaps, the layer recentred.
  const pack = (l: Item[], want: number[]): void => {
    l.forEach((it, i) => {
      it.x = want[i]!
      if (i > 0) {
        const prev = l[i - 1]!
        // Two arrows passing through a layer need only clear each other.
        const gap = !prev.state && !it.state && !prev.label && !it.label ? 10 : GAP_X
        it.x = Math.max(it.x, prev.x + (prev.w + it.w) / 2 + gap)
      }
    })
    if (!l.length) return
    const shift = l.reduce((s, it, i) => s + want[i]! - it.x, 0) / l.length
    for (const it of l) it.x += shift
  }
  for (const l of layers) pack(l, l.map(() => 0))
  for (let pass = 0; pass < 12; pass++) {
    for (let li = 0; li < layers.length; li++) {
      const l = layers[pass % 2 === 1 ? layers.length - 1 - li : li]!
      const want = l.map((it) => {
        const ns = [...(up.get(it) ?? []), ...(dn.get(it) ?? [])]
        return ns.length ? ns.reduce((s, n) => s + n.x, 0) / ns.length : it.x
      })
      pack(l, want)
    }
  }

  // Heights: each layer as tall as its tallest item.
  let y = MARGIN + 18
  let minX = Infinity
  let maxX = -Infinity
  for (const l of layers) {
    const h = l.length ? Math.max(...l.map((it) => it.h)) : 0
    for (const it of l) {
      it.y = y + h / 2
      minX = Math.min(minX, it.x - it.w / 2)
      maxX = Math.max(maxX, it.x + it.w / 2)
    }
    y += h + GAP_Y
  }
  const width = maxX - minX + 2 * MARGIN
  const height = y + MARGIN
  const dx = MARGIN - minX

  const b: string[] = []
  b.push(`<svg class="machine" viewBox="0 0 ${width.toFixed(0)} ${height.toFixed(0)}" width="${width.toFixed(0)}" height="${height.toFixed(0)}" role="img" aria-label="${esc('state machine ' + d.name)}">`)
  b.push('<defs>')
  for (const k of ['arrow', 'arrow-taken']) {
    b.push(`<marker id="m-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="${k}" d="M0,0 L10,5 L0,10 z"/></marker>`)
  }
  b.push('</defs>')

  // The initial state's entry: a dot and a short arrow onto its box.
  const init = d.initial ? items.get(d.initial) : undefined
  if (init) {
    const cx = init.x + dx
    const top = init.y - init.h / 2
    b.push(`<circle class="entry" cx="${f1(cx)}" cy="${f1(top - 18)}" r="5"/><path class="edge" d="M${f1(cx)},${f1(top - 13)} L${f1(cx)},${f1(top - 1)}" marker-end="url(#m-arrow)"/>`)
  }

  // Ports: where each arrow meets a box, spread along its bottom and top edges in the order of what they lead to.
  const ports = new Map<Chain, [number, number]>()
  const spread = (ends: Map<Item, Chain[]>, idx: 0 | 1, near: (c: Chain) => Item): void => {
    for (const [it, cs] of ends) {
      cs.sort((a, b) => near(a).x - near(b).x)
      const boxW = it.loop ? it.w - loopWidth(it.loop) : it.w
      const left = it.x - it.w / 2
      cs.forEach((c, i) => {
        const p = ports.get(c) ?? [0, 0]
        p[idx] = left + (boxW * (i + 1)) / (cs.length + 1)
        ports.set(c, p)
      })
    }
  }
  const bottoms = new Map<Item, Chain[]>()
  const tops = new Map<Item, Chain[]>()
  for (const c of chains) {
    if (c.items.length < 2) continue
    const first = c.items[0]!
    const last = c.items[c.items.length - 1]!
    bottoms.set(first, [...(bottoms.get(first) ?? []), c])
    tops.set(last, [...(tops.get(last) ?? []), c])
  }
  spread(bottoms, 0, (c) => c.items[1]!)
  spread(tops, 1, (c) => c.items[c.items.length - 2]!)

  // Arrows first, under the boxes; the taken ones last, over the rest.
  const drawn = [...chains].sort((a, c) => Number(a.taken) - Number(c.taken))
  for (const c of drawn) {
    if (c.items.length < 2) continue
    const [cls, marker] = c.taken ? ['edge taken', 'arrow-taken'] : ['edge', 'arrow']
    const first = c.items[0]!
    const last = c.items[c.items.length - 1]!
    const [px0, px1] = ports.get(c)!
    const pts: Array<[number, number]> = [[px0 + dx, first.y + first.h / 2]]
    for (const wp of c.items.slice(1, -1)) {
      if (wp.label) {
        // The arrow runs straight down the label's left edge, the text beside it.
        const x = wp.x - wp.w / 2 + 4 + dx
        pts.push([x, wp.y - wp.h / 2 - 2], [x, wp.y + wp.h / 2 + 2])
      } else pts.push([wp.x + dx, wp.y])
    }
    pts.push([px1 + dx, last.y - last.h / 2])
    let p = `M${f1(pts[0]![0])},${f1(pts[0]![1])}`
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1]!
      const [zx, zy] = pts[i]!
      if (ax === zx) {
        p += ` L${f1(zx)},${f1(zy)}`
        continue
      }
      const my = (zy - ay) / 2
      p += ` C${f1(ax)},${f1(ay + my)} ${f1(zx)},${f1(zy - my)} ${f1(zx)},${f1(zy)}`
    }
    const title = `${c.from} → ${c.to}` + (c.label.length ? ': ' + c.label.map((l) => l.trim()).join('; ') : '')
    b.push(`<g class="${cls}"><title>${esc(title)}</title><path d="${p}" ${c.reversed ? 'marker-start' : 'marker-end'}="url(#m-${marker})"/>`)
    for (const wp of c.items.slice(1, -1)) {
      if (!wp.label) continue
      const tx = wp.x - wp.w / 2 + 10 + dx
      const ty = wp.y - wp.h / 2 + LINE_H - 3
      wp.label.forEach((l, i) => {
        const lc = l.startsWith('  ') ? 'label' : 'label on'
        b.push(`<text class="${lc}" x="${f1(tx)}" y="${f1(ty + i * LINE_H)}">${esc(l.trim())}</text>`)
      })
    }
    b.push('</g>')
  }

  // The states.
  for (const s of sorted) {
    const it = items.get(s)!
    const boxW = it.loop ? it.w - loopWidth(it.loop) : it.w
    const x = it.x - it.w / 2 + dx
    const y0 = it.y - it.h / 2
    const cls = ['state']
    if (terminal.has(s)) cls.push('terminal')
    if (s === d.initial) cls.push('initial')
    if (m.visited?.has(s)) cls.push('visited')
    if (s === m.current) cls.push('current')
    const n = counts[s] ?? 0
    if (n > 0) cls.push('occupied')
    const href = m.href?.(s) ?? ''
    if (href) b.push(`<a href="${esc(href)}">`)
    const title = [s, s === d.initial ? 'initial' : terminal.has(s) ? 'terminal' : '', hooks[s] ? `on entry runs ${hooks[s]!.run}` : '', n ? `${n} flow(s) here` : '']
      .filter(Boolean)
      .join(' · ')
    b.push(`<g class="${cls.join(' ')}"><title>${esc(title)}</title>`)
    b.push(`<rect x="${f1(x)}" y="${f1(y0)}" width="${f1(boxW)}" height="${f1(it.h)}" rx="8"/>`)
    if (terminal.has(s)) b.push(`<rect class="inner" x="${f1(x + 3)}" y="${f1(y0 + 3)}" width="${f1(boxW - 6)}" height="${f1(it.h - 6)}" rx="6"/>`)
    const base = y0 + NODE_H / 2 + 4
    b.push(`<text class="name" x="${f1(x + PAD_X)}" y="${f1(base)}">${esc(s)}</text>`)
    let line = 1
    const hook = hooks[s]?.run
    if (hook) b.push(`<text class="sub" x="${f1(x + PAD_X)}" y="${f1(base + line++ * LINE_H)}">${esc(hookName(hook))}</text>`)
    for (const note of notes.get(s) ?? []) b.push(`<text class="sub" x="${f1(x + PAD_X)}" y="${f1(base + line++ * LINE_H)}">${esc(note.trim())}</text>`)
    if (n > 0) {
      b.push(`<g class="count"><rect x="${f1(x + boxW - 28)}" y="${f1(y0 + NODE_H / 2 - 9)}" width="22" height="18" rx="9"/><text x="${f1(x + boxW - 17)}" y="${f1(y0 + NODE_H / 2 + 4)}">${n}</text></g>`)
    }
    if (it.loop) {
      const lx = x + boxW
      b.push(`<path class="edge" d="M${f1(lx)},${f1(y0 + 8)} C${f1(lx + 26)},${f1(y0 - 4)} ${f1(lx + 26)},${f1(y0 + it.h + 4)} ${f1(lx)},${f1(y0 + it.h - 8)}" marker-end="url(#m-arrow)"/>`)
      it.loop.forEach((l, i) => b.push(`<text class="label" x="${f1(lx + 30)}" y="${f1(y0 + LINE_H + i * LINE_H)}">${esc(l.trim())}</text>`))
    }
    b.push('</g>')
    if (href) b.push('</a>')
  }
  b.push('</svg>')
  return b.join('')
}

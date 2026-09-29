import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Definition } from '../src/flows.ts'
import { renderMachine } from '../src/machine.ts'
import { fixture, fixtureReading, get, serve, type Served } from './helpers.ts'

const defs = new Map(fixture<Definition[]>('flow', 'definitions.json').map((d) => [d.name, d]))

const BOX = /<g class="state[^"]*"><title>([^<]*)<\/title><rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g

function boxes(svg: string): Array<{ name: string; x: number; y: number; w: number; h: number }> {
  return [...svg.matchAll(BOX)].map((m) => ({ name: m[1]!.split(' · ')[0]!, x: +m[2]!, y: +m[3]!, w: +m[4]!, h: +m[5]! }))
}

test('every definition draws each state once, in a box no other overlaps, the same way each time', () => {
  for (const [name, d] of defs) {
    const svg = renderMachine({ def: d })
    assert.equal(renderMachine({ def: d }), svg, `${name}: two renderings differ`)
    const bs = boxes(svg)
    assert.equal(bs.length, d.states!.length, name)
    for (let i = 0; i < bs.length; i++) {
      for (const b of bs.slice(i + 1)) {
        const a = bs[i]!
        assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), `${name}: ${a.name} and ${b.name} overlap`)
      }
    }
    // What the initial state leads to first sits below it.
    const init = bs.find((b) => b.name === d.initial)!
    for (const t of d.transitions!) if (t.from === d.initial) assert.ok(bs.find((b) => b.name === t.to)!.y > init.y, `${name}: ${t.to} below ${d.initial}`)
    assert.equal((svg.match(/class="inner"/g) ?? []).length, d.terminal!.length, `${name}: a double border per terminal state`)
  }
})

test('the session: each event and its conditions written, cancel-from-anywhere once, a cycle drawn upward', () => {
  const svg = renderMachine({ def: defs.get('session')!, counts: { blocked: 2 } })
  for (const w of ['>started<', '>answered<', '>after 12h<', '>when exitCode=0<', '>when requested=true<', '>waits on: all done<', '▸ finish.sh', '← canceled, from any of', 'class="state occupied"']) {
    assert.ok(svg.includes(w), `missing ${w}`)
  }
  assert.equal(svg.split('>canceled<').length - 1, 1, 'canceled is written once, as the state itself')
  assert.ok(svg.includes('marker-start="url(#m-arrow)"'), 'no arrow closes a cycle')
})

test('what a definition names is text, never markup', () => {
  const svg = renderMachine({
    def: { name: 'x', path: '', problem: null, states: ['a', '<b>'], initial: 'a', terminal: ['<b>'], transitions: [{ from: 'a', to: '<b>', on: '"><script>alert(1)</script>', when: null, after: null, requires: null, by: null }] }
  })
  assert.ok(!svg.includes('<script>') && !svg.includes('<b>'))
})

let s: Served
before(async () => {
  s = await serve(fixtureReading())
})
after(() => s.close())

test('the machines tab: the busiest definition first, a state narrows the flows, a flow page shows its way', async () => {
  const first = await get(s.url + '/machines')
  assert.ok(first.body.includes('href="/machines/session" class="on"'))
  const blocked = await get(s.url + '/machines/session?state=blocked')
  assert.ok(blocked.body.includes('20260906-024801-session-77f0'))
  assert.ok(!blocked.body.includes('20260906-031244-session-9a1c'), 'a running flow is not blocked')
  const flow = await get(s.url + '/flows/20260906-024801-session-77f0')
  assert.ok(flow.body.includes('class="edge taken"') && flow.body.includes('current'))
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadMap } from '../src/map.ts'
import { composePrompt } from '../src/prompt.ts'
import { MAP } from './helpers.ts'

const dir = mkdtempSync(join(tmpdir(), 'agent-host-prompt-'))
writeFileSync(join(dir, 'architecture.yaml'), MAP)
const map = loadMap(join(dir, 'architecture.yaml'))

test('the map reader finds the llm-agents, what each owns, and resolves owners through parents', () => {
  assert.deepEqual(map.agents().map((a) => a.name), ['alpha', 'beta'])
  assert.deepEqual(map.owned('alpha').map((t) => t.name), ['alpha', 'alpha-sub'])
  assert.equal(map.territory('alpha-sub')!.owner, 'alpha')
  assert.deepEqual(map.contextChain('alpha-sub').map((c) => c.territory), ['alpha', 'alpha-sub'])
  assert.equal(map.hash.length, 8)
  // beta watches alpha, and its own territory, which watching adds nothing to.
  assert.deepEqual(map.watched('beta').map((t) => t.name), ['alpha'])
  assert.deepEqual(map.watched('alpha'), [])
})

test('the prompt composes actor context, territories with layered contexts, the task, then the rules including the source\'s, in that order', () => {
  const text = composePrompt({
    map,
    actor: 'alpha',
    rules: ['You are on branch `agent/alpha/t1` in `/work`. Commit there.'],
    task: { slug: 't1', title: 'Do the thing', status: 'todo', priority: 'high', territories: ['alpha'], body: 'The body.' },
    prompt: null,
    resumes: null
  })
  const at = (s: string) => {
    const i = text.indexOf(s)
    assert.ok(i >= 0, `missing: ${s}`)
    return i
  }
  assert.ok(at('# You are `alpha`') < at('You are alpha. Keep alpha/ tidy.'))
  assert.ok(at('# Your territories') < at('## alpha - `alpha/**`'))
  assert.ok(at('## alpha - `alpha/**`') < at('## alpha-sub - `alpha/sub/**`'))
  // The child carries its parent's context first, marked as such.
  assert.ok(at('_From alpha:_') < at("The sub-territory's context."))
  assert.ok(at('# The task: t1') < at('**Do the thing** (priority high, territory alpha)'))
  assert.ok(at('The body.') < at('# How to work'))
  assert.match(text, /agent\/alpha\/t1/)
  assert.match(text, /\$HEAI_RUN\.requests\/<name>\.md/)
  assert.doesNotMatch(text, /# Resuming/)
})

test('a resumed run is told what it requested and what it said', () => {
  const text = composePrompt({
    map,
    actor: 'beta',
    rules: [],
    task: { slug: 't2', title: 'T2', status: 'todo', priority: '', territories: ['beta'], body: 'B.' },
    prompt: null,
    resumes: { id: 'run-1', finalMessage: 'Blocked: need alpha.', requests: [{ title: 'Help from alpha', task: 'help-from-alpha' }] }
  })
  assert.match(text, /# Resuming/)
  assert.match(text, /run `run-1`/)
  assert.match(text, /- Help from alpha \(task `help-from-alpha`, now done\)/)
  assert.match(text, /> Blocked: need alpha\./)
})

test('watched territories come after owned ones, marked observed-not-owned, with their owner', () => {
  const text = composePrompt({ map, actor: 'beta', rules: [], task: null, prompt: 'Sweep.', resumes: null })
  const at = (s: string) => {
    const i = text.indexOf(s)
    assert.ok(i >= 0, `missing: ${s}`)
    return i
  }
  assert.ok(at('## beta - `beta/**`') < at('# Territories you watch'))
  assert.ok(at('# Territories you watch') < at('## alpha - `alpha/**` (owned by alpha)'))
  assert.ok(at("alpha's own context.") < at('# The task'))
  assert.match(text, /never change them/)
  assert.doesNotMatch(composePrompt({ map, actor: 'alpha', rules: [], task: null, prompt: 'x', resumes: null }), /Territories you watch/)
})

test('a free-form prompt stands in for the task', () => {
  const text = composePrompt({ map, actor: 'beta', rules: [], task: null, prompt: 'Just look around.', resumes: null })
  assert.match(text, /# The task\n\nJust look around\./)
})

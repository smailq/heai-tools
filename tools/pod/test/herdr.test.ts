import { test } from 'node:test'
import assert from 'node:assert/strict'
import { asAgent, asPane, asWorkspace, asWorktree, HerdrError, items, isPaneId, object, parseHerdr, paneNumber, workspaceOf, type Herdr, type Json } from '../src/herdr.ts'
import { listWorkspaces, openWorkspace, rootPane, closeWorkspace } from '../src/workspaces.ts'
import { commandLine, paneEnv } from '../src/agents.ts'
import { fixture, makeWorld } from './helpers.ts'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' })
const failed = (stderr: string, code = 1) => ({ code, stdout: '', stderr })

test('recorded responses: the ids and fields the tool reads are where it reads them', () => {
  const created = parseHerdr(ok(fixture('worktree-create.json')))
  assert.equal(created['type'], 'worktree_created')
  const ws = asWorkspace(object(created, 'workspace'))
  assert.equal(ws.workspace_id, 'w2')
  assert.equal(ws.label, 't1 · api-owner')
  assert.deepEqual(ws.worktree, { checkout_path: '/worktrees/app/agent-api-owner-t1', repo_name: 'app', repo_root: '/repos/app', is_linked_worktree: true })
  assert.equal(asPane(object(created, 'root_pane')).pane_id, 'w2:p1')
  const wt = asWorktree(object(created, 'worktree'))
  assert.equal(wt.branch, 'agent/api-owner/t1')
  assert.equal(wt.path, '/worktrees/app/agent-api-owner-t1')

  const list = items(parseHerdr(ok(fixture('workspace-list.json'))), 'workspaces').map(asWorkspace)
  assert.deepEqual(list.map((w) => [w.workspace_id, w.worktree?.is_linked_worktree]), [['w1', false], ['w2', true]], 'the clone itself is a workspace too')
  assert.deepEqual(list[1]!.tokens, { actor: 'api-owner', branch: 'agent/api-owner/t1', repo: 'app' }, 'the tokens report-metadata wrote come back')

  const started = asAgent(object(parseHerdr(ok(fixture('agent-start.json'))), 'agent'))
  assert.deepEqual(started, { name: 'w4', agent: 'claude', agent_status: 'idle', pane_id: 'w4:p1', workspace_id: 'w4' })
  assert.equal(asAgent(object(parseHerdr(ok(fixture('agent-wait.json'))), 'agent')).agent_status, 'idle')
  assert.equal(parseHerdr(ok(fixture('pane-wait-output.json')))['matched_line'], '__heai_exit=1')
  assert.equal(asPane(object(parseHerdr(ok(fixture('pane-split.json'))), 'pane')).pane_id, 'w2:p2')
  assert.equal(parseHerdr(ok(fixture('worktree-remove.json')))['workspace_id'], 'w3')
  assert.deepEqual(parseHerdr(ok(fixture('workspace-close.json'))), { type: 'ok' })
})

test('an empty success is {}, a JSON error on stderr is a HerdrError with Herdr\'s code, and the exit split follows the code', () => {
  assert.deepEqual(parseHerdr(ok(fixture('report-metadata.txt'))), {})
  assert.deepEqual(parseHerdr(ok(fixture('pane-run.txt'))), {})
  for (const [file, code, exit] of [
    ['agent-get-none.err.json', 'agent_not_found', 2],
    ['agent-wait-until.err.json', 'timeout', 2],
    ['agent-prompt.err.json', 'timeout', 2],
    ['workspace-get-missing.err.json', 'workspace_not_found', 2]
  ] as const) {
    assert.throws(() => parseHerdr(failed(fixture(file))), (e: unknown) => e instanceof HerdrError && e.code === code && e.exit === exit, file)
  }
  assert.throws(() => parseHerdr(failed('{"error":{"code":"agent_blocked","message":"blocked"}}')), (e: unknown) => e instanceof HerdrError && e.exit === 1)
  assert.throws(() => parseHerdr(failed('unknown option: --bogus', 2)), (e: unknown) => e instanceof HerdrError && e.code === 'usage' && e.exit === 2)
  assert.throws(() => parseHerdr(failed('container exec failed: not running', 1)), (e: unknown) => e instanceof HerdrError && e.code === 'unreachable' && e.exit === 2)
  assert.throws(() => parseHerdr(ok('plain text')), (e: unknown) => e instanceof HerdrError && e.code === 'not-json')
  assert.equal(isPaneId('w3:p1'), true)
  assert.equal(isPaneId('w3'), false)
  assert.equal(isPaneId('reviewer'), false)
  assert.equal(workspaceOf('w3:p2'), 'w3')
  assert.equal(paneNumber('w3:p2'), 2)
})

/** A Herdr whose answers are the fixtures, keyed by group and command, and which records what it was asked. */
function fakeHerdr(overrides: Record<string, string> = {}): Herdr & { calls: string[][] } {
  const files: Record<string, string> = {
    'worktree create': 'worktree-create.json',
    'worktree list': 'worktree-list.json',
    'worktree remove': 'worktree-remove.json',
    'workspace list': 'workspace-list-with-agent.json',
    'workspace get': 'workspace-get.json',
    'workspace close': 'workspace-close.json',
    'workspace report-metadata': 'report-metadata.txt',
    'pane list': 'pane-list-with-agent.json',
    'pane split': 'pane-split.json',
    'agent list': 'agent-list.json',
    ...overrides
  }
  const calls: string[][] = []
  return {
    calls,
    async call(args) {
      calls.push(args)
      const key = `${args[0]} ${args[1]}`
      const file = files[key]
      if (!file) return {}
      const text = fixture(file)
      if (file.endsWith('.err.json')) return parseHerdr(failed(text))
      return parseHerdr(ok(text))
    },
    async text(args) {
      calls.push(args)
      return fixture('pane-read.txt')
    }
  }
}

test('open: worktree create in the clone, then the tokens, and the ids Herdr returned', async () => {
  const w = makeWorld()
  const h = fakeHerdr()
  await assert.rejects(openWorkspace(h, join(w.state, 'repos'), { repo: 'app', branch: 'x' }), /no clone of app/)
  mkdirSync(join(w.state, 'repos', 'app', '.git'), { recursive: true })
  const o = await openWorkspace(h, join(w.state, 'repos'), { repo: 'app', branch: 'agent/api-owner/t1', base: 'main', actor: 'api-owner', label: 't1 · api-owner' })
  assert.deepEqual(o, { workspace: 'w2', pane: 'w2:p1', path: '/worktrees/app/agent-api-owner-t1', branch: 'agent/api-owner/t1' })
  assert.deepEqual(h.calls, [
    ['worktree', 'create', '--cwd', '/repos/app', '--branch', 'agent/api-owner/t1', '--base', 'main', '--label', 't1 · api-owner', '--no-focus', '--trust-repository'],
    ['workspace', 'report-metadata', 'w2', '--source', 'pod', '--token', 'repo=app', '--token', 'branch=agent/api-owner/t1', '--token', 'actor=api-owner']
  ])
})

test('list: workspaces, agents, panes and worktrees joined on ids, and nothing remembered', async () => {
  const h = fakeHerdr()
  const views = await listWorkspaces(h)
  assert.deepEqual(
    views.map((v) => ({ id: v.id, repo: v.repo, branch: v.branch, actor: v.actor, linked: v.linked, status: v.status, agents: v.agents, panes: v.panes.map((p) => p.id) })),
    [
      { id: 'w1', repo: 'app', branch: 'main', actor: null, linked: false, status: 'unknown', agents: [], panes: [] },
      { id: 'w4', repo: 'app', branch: null, actor: null, linked: true, status: 'idle', agents: [{ name: 'w4', kind: 'claude', pane: 'w4:p1', state: 'idle' }], panes: ['w4:p1'] }
    ]
  )
  assert.deepEqual(h.calls.map((c) => c.slice(0, 2)), [['workspace', 'list'], ['agent', 'list'], ['pane', 'list'], ['worktree', 'list']])
  assert.deepEqual(await listWorkspaces(fakeHerdr({ 'workspace list': 'workspace-list-final.json' })).then((v) => v.map((x) => x.id)), ['w1'])
})

test('the root pane is the lowest-numbered pane; paneEnv carries the actor into git; close keeps or removes the worktree', async () => {
  const h = fakeHerdr()
  assert.equal((await rootPane(h, 'w4')).pane_id, 'w4:p1')
  const env = await paneEnv(h, 'w2', { EXTRA: '1' })
  assert.deepEqual(env, { env: { HEAI_ACTOR: 'api-owner', GIT_AUTHOR_NAME: 'api-owner', GIT_COMMITTER_NAME: 'api-owner', EXTRA: '1' }, cwd: '/worktrees/app/agent-api-owner-t1', root: 'w4:p1' })
  h.calls.length = 0
  assert.equal(await closeWorkspace(h, 'w2', { keepWorktree: true, force: false }), 'closed')
  assert.equal(await closeWorkspace(h, 'w2', { keepWorktree: false, force: true }), 'removed')
  assert.deepEqual(h.calls, [
    ['workspace', 'close', 'w2'],
    ['worktree', 'remove', '--workspace', 'w2', '--force', '--trust-repository']
  ])
})

test('the command line a run sends: one line as typed, a script as base64, the sentinel after either', () => {
  assert.equal(commandLine('npm test', '__heai_exit_ab12'), 'npm test; echo "__heai_exit_ab12=$?"')
  const script = 'set -e\nnpm ci\nnpm test\n'
  assert.equal(commandLine(script, '__heai_exit_ab12'), `printf '%s' ${Buffer.from(script).toString('base64')} | base64 -d | sh; echo "__heai_exit_ab12=$?"`)
})

test('the fields read out of an object are the ones named, and a missing one is null, not a crash', () => {
  const empty: Json = {}
  assert.deepEqual(asWorkspace(empty), { workspace_id: '', label: '', agent_status: 'unknown', tokens: {}, worktree: null })
  assert.deepEqual(asAgent(empty), { name: null, agent: null, agent_status: 'unknown', pane_id: '', workspace_id: '' })
  assert.deepEqual(asPane(empty), { pane_id: '', workspace_id: '', agent: null, agent_status: 'unknown', cwd: null })
  assert.deepEqual(asWorktree(empty), { path: '', branch: null, open_workspace_id: null, is_linked_worktree: false })
})

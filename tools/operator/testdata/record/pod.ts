// Records `heai-pod status --json` and `heai-pod list --json` through pod's CLI against
// its fake runtime: the Herdr replies are the tests' recorded shapes with a world of one
// clone and three worktrees, each opened with pod's tokens, agents in three states.
// Run from tools/pod (node resolves pod's helpers from there); the first argument is
// the directory to write into.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cli, herdrReplies, listWith, makeWorld } from '../../../pod/test/helpers.ts'

const out = process.argv[2]
if (!out) throw new Error('usage: node pod.ts <out-dir>')

const w = makeWorld()
const worktree = (id: string, n: number, path: string, label: string, status: string, tokens: Record<string, string>, linked = true) => ({
  active_tab_id: `${id}:t1`,
  agent_status: status,
  focused: false,
  label,
  number: n,
  pane_count: linked ? 2 : 1,
  tab_count: 1,
  tokens,
  workspace_id: id,
  worktree: { checkout_path: path, is_linked_worktree: linked, repo_key: '/repos/app/.git', repo_name: 'app', repo_root: '/repos/app' }
})
const open = (id: string, n: number, actor: string, task: string, status: string) =>
  worktree(id, n, `/worktrees/app/agent-${actor}-${task}`, `${actor}/${task}`, status, { repo: 'app', branch: `agent/${actor}/${task}`, actor })
const workspaces = [
  worktree('w1', 1, '/repos/app', 'app', 'unknown', {}, false),
  open('w3', 3, 'desktop-owner', 'add-place-entity', 'working'),
  open('w4', 4, 'web-ui', 'document-tabs', 'idle'),
  open('w2', 2, 'core-reviewer', 'merge-two-entities', 'blocked')
]
const agents = workspaces
  .filter((ws) => ws.worktree.is_linked_worktree)
  .map((ws) => ({
    agent: 'claude',
    agent_status: ws.agent_status,
    cwd: ws.worktree.checkout_path,
    focused: false,
    foreground_cwd: ws.worktree.checkout_path,
    interactive_ready: true,
    name: ws.workspace_id,
    pane_id: `${ws.workspace_id}:p2`,
    revision: 0,
    state_change_seq: 1,
    tab_id: `${ws.workspace_id}:t1`,
    terminal_id: `term_${ws.workspace_id}`,
    workspace_id: ws.workspace_id
  }))
const panes = workspaces.flatMap((ws) => {
  const root = { agent: null, agent_status: 'unknown', cwd: ws.worktree.checkout_path, pane_id: `${ws.workspace_id}:p1`, tab_id: `${ws.workspace_id}:t1`, workspace_id: ws.workspace_id }
  const a = agents.find((x) => x.workspace_id === ws.workspace_id)
  return a ? [root, { ...root, agent: 'claude', agent_status: a.agent_status, pane_id: a.pane_id }] : [root]
})
const worktrees = workspaces.map((ws) => ({ path: ws.worktree.checkout_path, branch: ws.tokens['branch'] ?? 'main', open_workspace_id: ws.workspace_id, is_linked_worktree: ws.worktree.is_linked_worktree }))

const isList = (when: string[]) => when[0] === 'herdr' && when[2] === 'list'
const reply = (group: string, key: string, items: unknown[]) => ({ when: ['herdr', group, 'list'], stdout: JSON.stringify({ id: 'x', result: { type: `${group}_list`, [key]: items } }) })
w.replies([
  ...herdrReplies().filter((r) => !isList(r.when)),
  reply('workspace', 'workspaces', workspaces),
  reply('agent', 'agents', agents),
  reply('pane', 'panes', panes),
  reply('worktree', 'worktrees', worktrees)
])
const must = (r: { code: number; stdout: string; stderr: string }, want: number, name: string) => {
  if (r.code !== want) throw new Error(`${name}: exit ${r.code}\n${r.stderr}`)
  return r.stdout
}
writeFileSync(join(out, 'list.json'), must(cli(w, 'list', '--json'), 0, 'list'))
writeFileSync(join(out, 'status.json'), must(cli(w, 'status', '--json'), 0, 'status'))
w.replies([{ when: ['list', '--all'], stdout: listWith('heai-workshop', 'stopped') }])
writeFileSync(join(out, 'status-stopped.json'), must(cli(w, 'status', '--json'), 1, 'status, stopped'))

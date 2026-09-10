import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentsIn, cli, git, herdrReplies, listWith, makeWorld } from './helpers.ts'

test('exit codes: 0 done, 1 refused, 2 could not be asked; usage', () => {
  const w = makeWorld()
  assert.equal(cli(w).code, 2, 'no command')
  assert.equal(cli(w, '--help').code, 0)
  assert.match(cli(w, '--help').stdout, /pod up/)
  assert.equal(cli(w, 'nope').code, 2)
  assert.equal(cli(w, 'open').code, 2, 'open needs a repository')
  assert.equal(cli(w, 'open', 'app').code, 2, 'open needs --branch')
  assert.equal(cli(w, 'start', 'w2').code, 2, 'start needs --agent')
  assert.equal(cli(w, 'prompt', 'w2').code, 2, 'prompt needs text')
  assert.equal(cli(w, 'run', 'w2').code, 2, 'run needs a command')
  assert.equal(cli(w, 'keys', 'w2:p1').code, 2, 'keys needs a key')
  assert.equal(cli(w, 'herdr').code, 2, 'herdr needs something after --')
  assert.equal(cli(w, 'repo').code, 2)
  assert.equal(cli(w, 'repo', 'frobnicate').code, 2)
  assert.equal(cli(w, 'wait', 'w2', '--every', '60s').code, 2, '--every goes with --notify')
  assert.equal(cli(w, 'wait', 'w2', '--timeout', 'soon').code, 2)
  assert.equal(cli(w, 'list', '--runtime', 'lxc').code, 2)
  assert.ok(existsSync(join(w.state, '.gitignore')), 'the state directory is made on any command')
})

test('up: created from the image, started when stopped, left alone when running; the three mounts and the configuration\'s', () => {
  const w = makeWorld()
  writeFileSync(join(w.dir, 'pod.yaml'), `mounts: ['${join(w.dir, 'flow/flows')}:/heai/flow']\nresources: { cpus: 4, memory: 8G }\n`)
  const envFile = join(w.dir, 'creds.env')
  writeFileSync(envFile, 'X=1\n')
  assert.equal(cli(w, 'up').code, 2, 'up needs --image')
  const created = cli(w, 'up', '--image', 'aw3/workshop', '--env-from', envFile, '--mount', '/x:/y')
  assert.equal(created.code, 0, created.stderr)
  assert.match(created.stdout, /Created and started heai-workshop from aw3\/workshop/)
  const run = w.calls().find((c) => c.argv[0] === 'run')!
  assert.deepEqual(run.argv, [
    'run', '-d', '--name', 'heai-workshop', '-l', 'heai.tool=pod',
    '-v', `${join(w.state, 'repos')}:/repos`, '-v', `${join(w.state, 'worktrees')}:/worktrees`, '-v', `${join(w.state, 'inbox')}:/heai/inbox`,
    '-v', `${join(w.dir, 'flow/flows')}:/heai/flow`, '-v', '/x:/y',
    '--env-file', envFile, '-c', '4', '-m', '8G', 'aw3/workshop'
  ])
  assert.equal(cli(w, 'up', '--image', 'aw3/workshop', '--env-from', '/nope.env').code, 2, 'a missing env file is refused before the runtime is asked')

  w.replies([{ when: ['list', '--all'], stdout: listWith('heai-workshop', 'stopped') }])
  assert.match(cli(w, 'up', '--image', 'aw3/workshop').stdout, /Started heai-workshop/)
  assert.ok(w.calls().some((c) => c.argv[0] === 'start' && c.argv[1] === 'heai-workshop'))

  w.replies([{ when: ['list', '--all'], stdout: listWith('heai-workshop', 'running') }])
  assert.match(cli(w, 'up', '--image', 'aw3/workshop').stdout, /already running/)
  assert.match(cli(w, 'up', '--name', 'other', '--image', 'aw3/workshop').stdout, /Created and started other/, '--name on up is the container')
  assert.match(cli(w, 'up', '--name', 'ops', '--image', 'aw3/ops').stdout, /Created and started ops from aw3\/ops/, '--image picks the image')
  assert.equal(w.calls().at(-1)!.argv.at(-1), 'aw3/ops')
})

test('down: refused while an agent works, forced past it, and a no-op when stopped or absent', () => {
  const w = makeWorld()
  assert.match(cli(w, 'down').stdout, /does not exist/)
  w.replies([{ when: ['list', '--all'], stdout: listWith('heai-workshop', 'stopped') }])
  assert.match(cli(w, 'down').stdout, /already stopped/)
  w.replies([{ when: ['list', '--all'], stdout: listWith('heai-workshop', 'running') }, { when: ['herdr', 'agent', 'list'], stdout: agentsIn('working') }])
  const refused = cli(w, 'down')
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /w4 is still working/)
  assert.ok(!w.calls().some((c) => c.argv[0] === 'stop'))
  assert.equal(cli(w, 'down', '--force').code, 0)
  assert.ok(w.calls().some((c) => c.argv[0] === 'stop' && c.argv[1] === 'heai-workshop'))
  w.replies([{ when: ['list', '--all'], stdout: listWith('heai-workshop', 'running') }, { when: ['herdr', 'agent', 'list'], stdout: agentsIn('idle') }])
  assert.match(cli(w, 'down').stdout, /Stopped heai-workshop/)
})

test('status: the runtime\'s word and Herdr\'s, as text and JSON; 1 when either is down', () => {
  const w = makeWorld()
  const absent = cli(w, 'status')
  assert.equal(absent.code, 1)
  assert.match(absent.stdout, /does not exist/)
  w.replies(herdrReplies())
  const s = cli(w, 'status')
  assert.equal(s.code, 0, s.stderr)
  assert.match(s.stdout, /container {3}heai-workshop {2}running/)
  assert.match(s.stdout, /herdr {7}running {2}0\.9\.0/)
  assert.match(s.stdout, /workspaces {2}2/)
  assert.match(s.stdout, /agents {6}1 idle/)
  const j = JSON.parse(cli(w, 'status', '--json').stdout)
  assert.deepEqual(j, { container: { name: 'heai-workshop', state: 'running', running: true, image: 'docker.io/library/alpine:latest' }, herdr: { running: true, version: '0.9.0' }, workspaces: 2, agents: { idle: 1 } })
})

test('build: the base from the tool\'s image directory with herdr pinned; extended images FROM the base; all of them at once', () => {
  const w = makeWorld()
  const imageDir = join(import.meta.dirname, '..', 'image')
  const herdr = readFileSync(join(imageDir, 'HERDR_VERSION'), 'utf8').trim()
  const r = cli(w, 'build', 'base', '--tag', 'aw3/base')
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(w.calls().find((c) => c.argv[0] === 'build')!.argv, ['build', '-t', 'aw3/base', '-f', join(imageDir, 'Containerfile'), '--build-arg', `HERDR_VERSION=${herdr}`, imageDir])
  assert.equal(cli(w, 'build', 'base', '--image-dir', w.dir).code, 2, 'no Containerfile there')

  mkdirSync(join(w.dir, 'images', 'workshop'), { recursive: true })
  writeFileSync(join(w.dir, 'images', 'workshop', 'Containerfile'), 'ARG BASE\nFROM ${BASE}\n')
  mkdirSync(join(w.dir, 'images', 'ops'), { recursive: true })
  writeFileSync(join(w.dir, 'images', 'ops', 'Containerfile'), 'ARG BASE\nFROM ${BASE}\n')
  writeFileSync(join(w.dir, 'pod.yaml'), 'base: aw3/base\nimages:\n  aw3/workshop: images/workshop\n  aw3/ops: ./images/ops\n')

  const one = cli(w, 'build', 'aw3/workshop')
  assert.equal(one.code, 0, one.stderr)
  assert.match(one.stdout, /Built aw3\/workshop from .* on aw3\/base/)
  assert.deepEqual(w.calls().at(-1)!.argv, ['build', '-t', 'aw3/workshop', '-f', join(w.dir, 'images/workshop/Containerfile'), '--build-arg', 'BASE=aw3/base', join(w.dir, 'images/workshop')])
  assert.equal(cli(w, 'build', 'aw3/unknown').code, 2, 'an image the configuration does not name needs --image-dir')
  assert.equal(cli(w, 'build', 'aw3/unknown', '--image-dir', join(w.dir, 'images/ops')).code, 0)

  const all = cli(w, 'build')
  assert.equal(all.code, 0, all.stderr)
  const tags = all.stdout.trim().split('\n').map((l) => l.split(' ')[1])
  assert.deepEqual(tags, ['aw3/base', 'aw3/workshop', 'aw3/ops'], 'the base first, then every image')
  assert.match(all.stdout, new RegExp(`Built aw3/base from .* with herdr ${herdr}`))
})

test('repo: add from the map\'s localPath, list, fetch, pull-branch into the source; host git only', () => {
  const w = makeWorld()
  const add = cli(w, 'repo', 'add', 'app')
  assert.equal(add.code, 0, add.stderr)
  const clone = join(w.state, 'repos', 'app')
  assert.ok(existsSync(join(clone, '.git')))
  assert.equal(git(clone, 'remote', 'get-url', 'origin'), w.source)
  assert.equal(cli(w, 'repo', 'add', 'app').code, 1, 'exists already')
  assert.equal(cli(w, 'repo', 'add', 'nowhere').code, 2, 'the map names no source')
  assert.equal(cli(w, 'repo', 'add', 'unknown').code, 2, 'not in the map')
  assert.equal(cli(w, 'repo', 'add', 'bad/name', w.source).code, 2)
  assert.equal(cli(w, 'repo', 'add', 'copy', w.source).code, 0, 'a source given outright')
  const list = JSON.parse(cli(w, 'repo', 'list', '--json').stdout)
  assert.deepEqual(list.map((r: { name: string; branch: string }) => [r.name, r.branch]), [['app', 'main'], ['copy', 'main']])
  assert.match(cli(w, 'repo', 'list').stdout, /^app {15}main {18}[0-9a-f]{7} {3}/m)

  // the source moves on; fetch fast-forwards the clone's checked-out branch
  writeFileSync(join(w.source, 'b.txt'), 'b\n')
  git(w.source, 'add', '.')
  git(w.source, 'commit', '-q', '-m', 'second')
  const fetched = cli(w, 'repo', 'fetch', 'app')
  assert.equal(fetched.code, 0, fetched.stderr)
  assert.equal(git(clone, 'rev-parse', 'HEAD'), git(w.source, 'rev-parse', 'HEAD'))
  assert.equal(cli(w, 'repo', 'fetch').code, 0, 'every clone')
  assert.equal(cli(w, 'repo', 'fetch', 'missing').code, 2)

  // work happens on a branch in the clone, as it would in a worktree; pull-branch brings it home
  git(clone, 'checkout', '-q', '-b', 'agent/api-owner/t1')
  writeFileSync(join(clone, 'work.txt'), 'done\n')
  git(clone, 'add', '.')
  git(clone, '-c', 'user.name=api-owner', '-c', 'user.email=a@b', 'commit', '-q', '-m', 'work')
  git(clone, 'checkout', '-q', 'main')
  const pulled = cli(w, 'repo', 'pull-branch', 'app', 'agent/api-owner/t1')
  assert.equal(pulled.code, 0, pulled.stderr)
  assert.match(pulled.stdout, new RegExp(`Pulled agent/api-owner/t1 into ${w.source}`))
  assert.equal(git(w.source, 'rev-parse', 'agent/api-owner/t1'), git(clone, 'rev-parse', 'agent/api-owner/t1'))
  assert.equal(cli(w, 'repo', 'pull-branch', 'app', 'no-such-branch').code, 2)
  assert.equal(cli(w, 'repo', 'pull-branch', 'copy', 'main').code, 2, 'no localPath and no --into')
  assert.equal(cli(w, 'repo', 'pull-branch', 'app', 'main').code, 1, 'git refuses to move the checked-out branch')
  const other = join(w.dir, 'other')
  git(w.dir, 'clone', '-q', w.source, other)
  assert.equal(cli(w, 'repo', 'pull-branch', 'app', 'agent/api-owner/t1', '--into', other).code, 0)
  assert.ok(!w.calls().length, 'nothing here asked the runtime')
})

test('open, list, close: the Herdr commands with the ids they return', () => {
  const w = makeWorld()
  cli(w, 'repo', 'add', 'app')
  w.replies(herdrReplies())
  const opened = cli(w, 'open', 'app', '--branch', 'agent/api-owner/t1', '--base', 'main', '--actor', 'api-owner', '--label', 't1 · api-owner')
  assert.equal(opened.code, 0, opened.stderr)
  assert.equal(opened.stdout.trim(), 'w2', 'the workspace id and nothing else')
  assert.deepEqual(w.herdrCalls(), [
    ['worktree', 'create', '--cwd', '/repos/app', '--branch', 'agent/api-owner/t1', '--base', 'main', '--label', 't1 · api-owner', '--no-focus', '--trust-repository'],
    ['workspace', 'report-metadata', 'w2', '--source', 'pod', '--token', 'repo=app', '--token', 'branch=agent/api-owner/t1', '--token', 'actor=api-owner']
  ])
  assert.equal(cli(w, 'open', 'nope', '--branch', 'x').code, 2, 'no such clone')
  assert.deepEqual(JSON.parse(cli(w, 'open', 'app', '--branch', 'b', '--json').stdout), { workspace: 'w2', pane: 'w2:p1', path: '/worktrees/app/agent-api-owner-t1', branch: 'agent/api-owner/t1' })

  const list = cli(w, 'list')
  assert.equal(list.code, 0, list.stderr)
  assert.match(list.stdout, /^w1 {3}app {3}main {4}unknown {3}- {13}\(the clone\)$/m)
  assert.match(list.stdout, /^w4 {3}app {3}- {7}idle {6}- {13}w4:claude=idle$/m)
  const views = JSON.parse(cli(w, 'list', '--json').stdout)
  assert.equal(views.length, 2)
  assert.deepEqual(views[1].agents, [{ name: 'w4', kind: 'claude', pane: 'w4:p1', state: 'idle' }])

  assert.match(cli(w, 'close', 'w2').stdout, /removed its worktree/)
  assert.match(cli(w, 'close', 'w2', '--keep-worktree').stdout, /worktree is kept/)
  assert.deepEqual(w.herdrCalls().slice(-2), [
    ['worktree', 'remove', '--workspace', 'w2', '--trust-repository'],
    ['workspace', 'close', 'w2']
  ])
  w.replies([{ when: ['list', '--all'], stdout: listWith('heai-workshop', 'running') }, { when: ['herdr', 'workspace', 'list'], stdout: '{"id":"x","result":{"type":"workspace_list","workspaces":[]}}' }])
  assert.equal(cli(w, 'list').stdout.trim(), '(no workspaces)')
})

test('a Herdr refusal is exit 1 with its code; a missing target or an unreachable server is 2', () => {
  const w = makeWorld()
  cli(w, 'repo', 'add', 'app')
  w.replies([{ when: ['herdr', 'worktree', 'create'], stderr: '{"error":{"code":"branch_exists","message":"branch agent/x exists"},"id":"cli:worktree:create"}', code: 1 }])
  const r = cli(w, 'open', 'app', '--branch', 'agent/x')
  assert.equal(r.code, 1)
  assert.match(r.stderr, /herdr: branch_exists: branch agent\/x exists/)
  w.replies([{ when: ['herdr', 'workspace', 'get'], stdoutFile: 'herdr/workspace-get-missing.err.json', code: 1 }])
  assert.equal(cli(w, 'start', 'w9', '--agent', 'claude').code, 2)
  w.replies([{ when: ['exec'], stderr: 'Error: container heai-workshop is not running', code: 1 }])
  const down = cli(w, 'list')
  assert.equal(down.code, 2)
  assert.match(down.stderr, /unreachable/)
})

test('start: a pane of its own with the actor in its environment, then agent start; the pane id printed', () => {
  const w = makeWorld()
  w.replies(herdrReplies())
  const r = cli(w, 'start', 'w2', '--agent', 'claude', '--env', 'FOO=bar', '--timeout', '20s', '--', '--model', 'opus')
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'w4:p1', 'the pane Herdr reported the agent in')
  assert.deepEqual(w.herdrCalls().slice(-3), [
    ['pane', 'list', '--workspace', 'w2'],
    ['pane', 'split', 'w4:p1', '--direction', 'down', '--cwd', '/worktrees/app/agent-api-owner-t1', '--no-focus', '--env', 'HEAI_ACTOR=api-owner', '--env', 'GIT_AUTHOR_NAME=api-owner', '--env', 'GIT_COMMITTER_NAME=api-owner', '--env', 'FOO=bar'],
    ['agent', 'start', 'w2', '--kind', 'claude', '--pane', 'w2:p2', '--timeout', '20000', '--', '--model', 'opus']
  ])
  assert.equal(cli(w, 'start', 'w2', '--agent', 'claude', '--name', 'Reviewer').code, 2, 'a name Herdr would refuse')
  cli(w, 'start', 'w2', '--agent', 'codex', '--name', 'reviewer')
  assert.deepEqual(w.herdrCalls().at(-1), ['agent', 'start', 'reviewer', '--kind', 'codex', '--pane', 'w2:p2'])
})

test('prompt: plain, --wait through settled, --notify through notify detached; text from a file', () => {
  const w = makeWorld()
  w.replies(herdrReplies())
  assert.match(cli(w, 'prompt', 'w4', 'do the thing').stdout, /Prompted w4 \(idle\)/)
  assert.deepEqual(w.herdrCalls().at(-1), ['agent', 'prompt', 'w4', 'do the thing'])

  const file = join(w.dir, 'prompt.txt')
  writeFileSync(file, 'line one\nline two\n')
  const waited = cli(w, 'prompt', 'w4', '--file', file, '--wait', '--timeout', '2m')
  assert.equal(waited.code, 1, 'settled blocked')
  assert.equal(waited.stdout.trim(), 'blocked')
  const settled = w.calls().at(-1)!
  assert.deepEqual(settled.argv, ['exec', 'heai-workshop', 'settled', 'prompt', 'w4', 'line one\nline two\n', '--timeout', '120000'])

  const notified = cli(w, 'prompt', 'w4', 'go', '--notify', '/heai/flow/abc/inbox', '--event', 'exited')
  assert.equal(notified.code, 0, notified.stderr)
  assert.deepEqual(w.calls().at(-1)!.argv, ['exec', '-d', 'heai-workshop', 'notify', '/heai/flow/abc/inbox', 'exited', '--', 'prompt', 'w4', 'go'])
  assert.equal(cli(w, 'prompt', 'w4', 'go', '--wait', '--notify', '/x').code, 2, 'one or the other')
  assert.deepEqual(JSON.parse(cli(w, 'prompt', 'w4', 'go', '--wait', '--json').stdout), { workspace: 'w4', pane: 'w4:p1', agent: 'w4', state: 'blocked', exitCode: 1 })
})

test('run: a fresh pane, the command with its sentinel, the exit code through settled; --file carries a script', () => {
  const w = makeWorld()
  w.replies(herdrReplies())
  const plain = cli(w, 'run', 'w2', 'npm', 'test')
  assert.equal(plain.code, 0, plain.stderr)
  assert.equal(plain.stdout.trim(), 'w2:p2')
  const ran = w.herdrCalls().at(-1)!
  assert.equal(ran[0], 'pane')
  assert.equal(ran[1], 'run')
  assert.equal(ran[2], 'w2:p2')
  assert.match(ran[3]!, /^npm test; echo "__heai_exit_[0-9a-f]{8}=\$\?"$/)

  const waited = cli(w, 'run', 'w2', 'npm test', '--wait', '--timeout', '30s')
  assert.equal(waited.code, 1, 'the command exited 1')
  assert.equal(waited.stdout.trim(), '1')
  const settled = w.calls().at(-1)!.argv
  assert.equal(settled[2], 'settled')
  assert.equal(settled[3], 'run')
  assert.equal(settled[4], 'w2:p2')
  assert.match(settled[5]!, /^__heai_exit_[0-9a-f]{8}$/)
  assert.deepEqual(settled.slice(6), ['--timeout', '30000'])

  const script = join(w.dir, 'job.sh')
  writeFileSync(script, 'set -e\nnpm ci\nnpm test\n')
  const notified = cli(w, 'run', 'w2', '--file', script, '--env', 'CI=1', '--notify', '/heai/inbox', '--event', 'exited')
  assert.equal(notified.code, 0, notified.stderr)
  assert.equal(notified.stdout.trim(), 'w2:p2')
  const calls = w.herdrCalls()
  const split = calls.find((c) => c[0] === 'pane' && c[1] === 'split' && c.includes('CI=1'))!
  assert.ok(split, 'the env reaches the pane')
  const line = calls.at(-1)![3]!
  assert.match(line, /^printf '%s' [A-Za-z0-9+/=]+ \| base64 -d \| sh; echo "__heai_exit_[0-9a-f]{8}=\$\?"$/)
  assert.equal(Buffer.from(line.split(' ')[2]!, 'base64').toString(), 'set -e\nnpm ci\nnpm test\n')
  const detached = w.calls().at(-1)!.argv
  assert.deepEqual(detached.slice(0, 6), ['exec', '-d', 'heai-workshop', 'notify', '/heai/inbox', 'exited'])
  assert.deepEqual(detached.slice(6, 9), ['--', 'run', 'w2:p2'])
})

test('wait: blocking prints the settled state; --notify starts the helper detached; --every is the heartbeat', () => {
  const w = makeWorld()
  w.replies(herdrReplies())
  const r = cli(w, 'wait', 'w4', '--until', 'blocked', '--until', 'done', '--timeout', '5m')
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'idle')
  assert.deepEqual(w.calls().at(-1)!.argv, ['exec', 'heai-workshop', 'settled', 'wait', 'w4', '--until', 'blocked', '--until', 'done', '--timeout', '300000'])
  assert.equal(cli(w, 'wait', 'w4', '--notify', '/heai/flow/abc/inbox', '--event', 'needs-input', '--until', 'blocked').code, 0)
  assert.deepEqual(w.calls().at(-1)!.argv, ['exec', '-d', 'heai-workshop', 'notify', '/heai/flow/abc/inbox', 'needs-input', '--', 'wait', 'w4', '--until', 'blocked'])
  const beat = cli(w, 'wait', 'w4', '--notify', '/heai/flow/abc/inbox', '--every', '60s')
  assert.equal(beat.code, 0)
  assert.match(beat.stdout, /touch will be written/)
  assert.deepEqual(w.calls().at(-1)!.argv, ['exec', '-d', 'heai-workshop', 'notify', '/heai/flow/abc/inbox', 'touch', '--every', '60', '--', 'wait', 'w4'])
  w.replies([{ when: ['settled', 'wait'], stdout: '{"workspace":"w4","pane":"w4:p1","agent":"w4","state":"timeout","exitCode":2}', code: 2 }])
  assert.equal(cli(w, 'wait', 'w4', '--timeout', '1s').code, 2)
})

test('read, keys, attach and the raw passthrough: pane ids go to pane commands, names to agent commands', () => {
  const w = makeWorld()
  w.replies(herdrReplies())
  const read = cli(w, 'read', 'w2:p2', '--lines', '40', '--ansi')
  assert.equal(read.code, 0, read.stderr)
  assert.match(read.stdout, /__heai_exit=1/)
  assert.deepEqual(w.herdrCalls().at(-1), ['pane', 'read', 'w2:p2', '--source', 'recent-unwrapped', '--lines', '40', '--ansi'])
  cli(w, 'read', 'reviewer')
  assert.deepEqual(w.herdrCalls().at(-1), ['agent', 'read', 'reviewer', '--source', 'recent-unwrapped'])
  assert.equal(cli(w, 'keys', 'w4', 'ctrl+c', 'enter').code, 0)
  assert.deepEqual(w.herdrCalls().at(-1), ['agent', 'send-keys', 'w4', 'ctrl+c', 'enter'])
  cli(w, 'keys', 'w4:p1', 'esc')
  assert.deepEqual(w.herdrCalls().at(-1), ['pane', 'send-keys', 'w4:p1', 'esc'])
  assert.equal(cli(w, 'attach', 'w2').code, 0)
  assert.deepEqual(w.calls().slice(-2).map((c) => c.argv), [
    ['exec', 'heai-workshop', 'herdr', 'workspace', 'focus', 'w2'],
    ['exec', '-it', 'heai-workshop', 'herdr']
  ])
  assert.equal(cli(w, 'herdr', '--', 'tab', 'list', '--workspace', 'w2').code, 0)
  assert.deepEqual(w.calls().at(-1)!.argv, ['exec', 'heai-workshop', 'herdr', 'tab', 'list', '--workspace', 'w2'])
  assert.equal(cli(w, 'attach', '--container', 'other').code, 0)
  assert.deepEqual(w.calls().at(-1)!.argv, ['exec', '-it', 'other', 'herdr'])
})

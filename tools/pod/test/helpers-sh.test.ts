// The three helpers in the image, run under sh on the host against a fake
// herdr on PATH that replays the recorded responses. They need jq, as the
// image has; without it here the tests are skipped, not failed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAKE, HERDR_FIXTURES } from './helpers.ts'

const BIN = join(import.meta.dirname, '..', 'image', 'bin')
const hasJq = spawnSync('jq', ['--version']).status === 0

interface Sandbox {
  dir: string
  herdr: string
  inbox: string
  /** `herdr <group> <command>` answers with this fixture on stdout, or on stderr with exit 1 when it is an error fixture. */
  answer(group: string, command: string, fixtureFile: string): void
  run(helper: string, ...args: string[]): { code: number; stdout: string; stderr: string }
  calls(): string[]
}

function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'helpers-'))
  const herdr = join(dir, 'herdr')
  mkdirSync(herdr)
  const inbox = join(dir, 'inbox')
  const env = { ...process.env, PATH: `${FAKE}:${process.env['PATH'] ?? ''}`, FAKE_HERDR_DIR: herdr }
  return {
    dir,
    herdr,
    inbox,
    answer(group, command, fixtureFile) {
      copyFileSync(join(HERDR_FIXTURES, fixtureFile), join(herdr, `${group}-${command}${fixtureFile.endsWith('.err.json') ? '.err.json' : '.json'}`))
    },
    run(helper, ...args) {
      const r = spawnSync('sh', [join(BIN, helper), ...args], { encoding: 'utf8', env })
      return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr }
    },
    calls() {
      const p = join(herdr, 'calls.log')
      return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n') : []
    }
  }
}

test('fact: written under a .tmp name and renamed, body {} when none is given, usage when short', () => {
  const s = sandbox()
  assert.equal(s.run('fact', s.inbox, 'exited', 'w3', '{"exitCode":0}').code, 0)
  assert.equal(readFileSync(join(s.inbox, 'exited.w3'), 'utf8'), '{"exitCode":0}\n')
  assert.equal(s.run('fact', s.inbox, 'touch', 'w3-1').code, 0)
  assert.equal(readFileSync(join(s.inbox, 'touch.w3-1'), 'utf8'), '{}\n')
  assert.deepEqual(readdirSync(s.inbox).sort(), ['exited.w3', 'touch.w3-1'], 'no .tmp is left behind')
  assert.equal(s.run('fact', s.inbox, 'exited').code, 2)
})

test('settled wait: agent get for identity, agent wait for the state; idle is 0, blocked 1, a timeout 2, a vanished agent lost', { skip: !hasJq && 'jq is not installed' }, () => {
  const s = sandbox()
  s.answer('agent', 'get', 'agent-get.json')
  s.answer('agent', 'wait', 'agent-wait.json')
  const r = s.run('settled', 'wait', 'w4', '--until', 'blocked', '--timeout', '5000')
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { workspace: 'w4', pane: 'w4:p1', agent: 'w4', state: 'idle', exitCode: 0 })
  assert.deepEqual(s.calls(), ['agent get w4', 'agent wait w4 --until blocked --timeout 5000'])

  const blocked = JSON.parse(readFileSync(join(HERDR_FIXTURES, 'agent-wait.json'), 'utf8'))
  blocked.result.agent.agent_status = 'blocked'
  writeFileSync(join(s.herdr, 'agent-wait.json'), JSON.stringify(blocked))
  const b = s.run('settled', 'wait', 'w4:p1')
  assert.equal(b.code, 1)
  assert.equal(JSON.parse(b.stdout).state, 'blocked')

  s.answer('agent', 'wait', 'agent-wait-until.err.json')
  const t = s.run('settled', 'wait', 'w4', '--until', 'blocked', '--timeout', '3000')
  assert.equal(t.code, 2)
  assert.deepEqual(JSON.parse(t.stdout), { workspace: 'w4', pane: 'w4:p1', agent: 'w4', state: 'timeout', exitCode: 2 })

  const gone = sandbox()
  gone.answer('agent', 'get', 'agent-get-none.err.json')
  gone.answer('agent', 'wait', 'agent-get-none.err.json')
  const l = gone.run('settled', 'wait', 'w2:p1')
  assert.equal(l.code, 2)
  assert.deepEqual(JSON.parse(l.stdout), { workspace: 'w2', pane: 'w2:p1', agent: null, state: 'lost', exitCode: 2 }, 'a pane id still names its workspace')
  assert.equal(s.run('settled', 'frob', 'w4').code, 2)
  assert.equal(s.run('settled').code, 2)
})

test('settled prompt: agent prompt --wait with the text, and Herdr\'s refusals as states', { skip: !hasJq && 'jq is not installed' }, () => {
  const s = sandbox()
  s.answer('agent', 'get', 'agent-get.json')
  s.answer('agent', 'prompt', 'agent-start.json')
  const r = s.run('settled', 'prompt', 'w4', 'do the thing', '--timeout', '120000')
  assert.equal(r.code, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).state, 'idle')
  assert.equal(s.calls().at(-1), 'agent prompt w4 do the thing --wait --timeout 120000')
  writeFileSync(join(s.herdr, 'agent-prompt.err.json'), '{"error":{"code":"agent_blocked","message":"agent is waiting at a dialog"},"id":"cli:agent:prompt"}')
  const b = s.run('settled', 'prompt', 'w4', 'go')
  assert.equal(b.code, 1)
  assert.equal(JSON.parse(b.stdout).state, 'blocked')
  writeFileSync(join(s.herdr, 'agent-prompt.err.json'), '{"error":{"code":"agent_prompt_stalled","message":"no activity"},"id":"cli:agent:prompt"}')
  const st = s.run('settled', 'prompt', 'w4', 'go')
  assert.equal(st.code, 2)
  assert.equal(JSON.parse(st.stdout).state, 'stalled')
  assert.equal(s.run('settled', 'prompt', 'w4').code, 2, 'no text')
})

test('settled run: pane wait-output on the sentinel; the matched line carries the exit code', { skip: !hasJq && 'jq is not installed' }, () => {
  const s = sandbox()
  s.answer('pane', 'wait-output', 'pane-wait-output.json')
  const r = s.run('settled', 'run', 'w2:p2', '__heai_exit', '--timeout', '15000')
  assert.equal(r.code, 1, 'the recorded command exited 1')
  assert.deepEqual(JSON.parse(r.stdout), { workspace: 'w2', pane: 'w2:p2', agent: null, state: 'exited', exitCode: 1 })
  assert.deepEqual(s.calls(), ['pane wait-output w2:p2 --regex __heai_exit=[0-9]+ --timeout 15000'])
  writeFileSync(join(s.herdr, 'pane-wait-output.err.json'), '{"error":{"code":"timeout","message":"timed out"},"id":"cli:pane:wait-output"}')
  const t = s.run('settled', 'run', 'w2:p2', '__heai_exit')
  assert.equal(t.code, 2)
  assert.equal(JSON.parse(t.stdout).state, 'timeout')
})

test('notify: settled then fact, named <event>.<workspace>; with --every, heartbeat facts until the wait ends', { skip: !hasJq && 'jq is not installed' }, () => {
  const s = sandbox()
  s.answer('agent', 'get', 'agent-get.json')
  s.answer('agent', 'wait', 'agent-wait.json')
  const r = s.run('notify', s.inbox, 'exited', '--', 'wait', 'w4')
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(s.inbox, 'exited.w4'), 'utf8')), { workspace: 'w4', pane: 'w4:p1', agent: 'w4', state: 'idle', exitCode: 0 })
  assert.equal(s.run('notify', s.inbox, 'exited').code, 2, 'nothing after --')

  // a slow wait: the fake herdr sleeps, and the heartbeat writes touch.w4-1, touch.w4-2 meanwhile
  const slow = sandbox()
  slow.answer('agent', 'get', 'agent-get.json')
  writeFileSync(join(slow.dir, 'slow-herdr'), `#!/bin/sh\nif [ "$2" = wait ]; then sleep 2.5; fi\nexec "${join(FAKE, 'herdr')}" "$@"\n`)
  execFileSync('chmod', ['+x', join(slow.dir, 'slow-herdr')])
  mkdirSync(join(slow.dir, 'bin'))
  execFileSync('ln', ['-s', join(slow.dir, 'slow-herdr'), join(slow.dir, 'bin', 'herdr')])
  slow.answer('agent', 'wait', 'agent-wait.json')
  const beat = spawnSync('sh', [join(BIN, 'notify'), slow.inbox, 'touch', '--every', '1', '--', 'wait', 'w4'], { encoding: 'utf8', env: { ...process.env, PATH: `${join(slow.dir, 'bin')}:${process.env['PATH'] ?? ''}`, FAKE_HERDR_DIR: slow.herdr } })
  assert.equal(beat.status, 0, beat.stderr)
  const facts = readdirSync(slow.inbox).sort()
  assert.ok(facts.length >= 1 && facts.every((f) => /^touch\.w4-\d+$/.test(f)), `touches only: ${facts.join(' ')}`)
  assert.equal(readFileSync(join(slow.inbox, facts[0]!), 'utf8'), '{}\n')
})

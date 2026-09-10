import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseAppleList, appleRuntime } from '../src/runtimes/apple.ts'
import { parseDockerPs, dockerRuntime } from '../src/runtimes/docker.ts'
import { RuntimeError, type ExecResult, type Runtime, type Spawner } from '../src/runtime.ts'
import { FIXTURES } from './helpers.ts'

test('apple: the recorded `container list --all --format json` parses to the fields the tool reads', () => {
  const list = parseAppleList(readFileSync(join(FIXTURES, 'container-list.json'), 'utf8'))
  assert.deepEqual(
    list.map((c) => ({ id: c.id, state: c.state, running: c.running, image: c.image })),
    [
      { id: 'buildkit', state: 'stopped', running: false, image: 'ghcr.io/apple/container-builder-shim/builder:0.12.0' },
      { id: 'heai-exp', state: 'running', running: true, image: 'docker.io/library/alpine:latest' }
    ]
  )
  assert.deepEqual(list[1]!.labels, { 'heai.actor': 'exp', 'heai.map': '3f9c1a2e' })
  assert.throws(() => parseAppleList('not json'), RuntimeError)
  assert.throws(() => parseAppleList('{}'), RuntimeError)
  assert.deepEqual(parseAppleList('[{"status":{"state":"running"}}]'), [], 'an entry with no id is skipped')
})

test('docker: the documented `docker ps --format json` lines parse to the same fields', () => {
  const list = parseDockerPs(readFileSync(join(FIXTURES, 'docker-ps.jsonl'), 'utf8'))
  assert.deepEqual(
    list.map((c) => ({ id: c.id, state: c.state, running: c.running, image: c.image })),
    [
      { id: 'boring_keldysh', state: 'running', running: true, image: 'nginx' },
      { id: 'heai-workshop', state: 'exited', running: false, image: 'heai/pod' }
    ]
  )
  assert.deepEqual(list[0]!.labels, { maintainer: 'NGINX Docker Maintainers <docker-maint@nginx.com>' })
  assert.deepEqual(list[1]!.labels, { 'heai.tool': 'pod' })
  assert.deepEqual(parseDockerPs(''), [])
  assert.throws(() => parseDockerPs('nope'), RuntimeError)
})

function recorder(): { calls: string[][]; spawn: Spawner; inherit: (bin: string, args: string[]) => Promise<number> } {
  const calls: string[][] = []
  const ok: ExecResult = { code: 0, stdout: '[]', stderr: '' }
  return {
    calls,
    spawn: async (bin, args) => {
      calls.push([bin, ...args])
      return ok
    },
    inherit: async (bin, args) => {
      calls.push([bin, ...args])
      return 0
    }
  }
}

const spec = { name: 'heai-workshop', image: 'heai/pod', labels: { 'heai.tool': 'pod' }, mounts: [{ host: '/s/repos', container: '/repos' }], env: { A: '1' }, envFile: '/e.env', cpus: 6, memory: '12G' }

async function exercise(rt: Runtime): Promise<void> {
  await rt.list()
  await rt.run(spec)
  await rt.start('heai-workshop')
  await rt.stop('heai-workshop')
  await rt.delete('heai-workshop', true)
  await rt.exec('heai-workshop', ['herdr', 'agent', 'list'], { workdir: '/repos', env: { X: 'y' } })
  await rt.execDetached('heai-workshop', ['notify', '/heai/inbox', 'exited'])
  await rt.execInteractive('heai-workshop', ['herdr'], true)
  await rt.execInteractive('heai-workshop', ['herdr', 'agent', 'list'], false)
  await rt.build('heai/pod', '/tool/image', '/tool/image/Containerfile', { HERDR_VERSION: '0.9.0' })
}

test('apple: every operation is the argv Apple\'s CLI takes', async () => {
  const r = recorder()
  await exercise(appleRuntime(r.spawn, r.inherit))
  assert.deepEqual(r.calls, [
    ['container', 'list', '--all', '--format', 'json'],
    ['container', 'run', '-d', '--name', 'heai-workshop', '-l', 'heai.tool=pod', '-v', '/s/repos:/repos', '-e', 'A=1', '--env-file', '/e.env', '-c', '6', '-m', '12G', 'heai/pod'],
    ['container', 'start', 'heai-workshop'],
    ['container', 'stop', 'heai-workshop'],
    ['container', 'delete', '-f', 'heai-workshop'],
    ['container', 'exec', '-w', '/repos', '-e', 'X=y', 'heai-workshop', 'herdr', 'agent', 'list'],
    ['container', 'exec', '-d', 'heai-workshop', 'notify', '/heai/inbox', 'exited'],
    ['container', 'exec', '-it', 'heai-workshop', 'herdr'],
    ['container', 'exec', 'heai-workshop', 'herdr', 'agent', 'list'],
    ['container', 'build', '-t', 'heai/pod', '-f', '/tool/image/Containerfile', '--build-arg', 'HERDR_VERSION=0.9.0', '/tool/image']
  ])
})

test('docker: the same operations as docker or podman argv', async () => {
  const r = recorder()
  await exercise(dockerRuntime('podman', r.spawn, r.inherit))
  assert.deepEqual(r.calls, [
    ['podman', 'ps', '--all', '--format', '{{json .}}'],
    ['podman', 'run', '-d', '--name', 'heai-workshop', '--label', 'heai.tool=pod', '-v', '/s/repos:/repos', '-e', 'A=1', '--env-file', '/e.env', '--cpus', '6', '--memory', '12G', 'heai/pod'],
    ['podman', 'start', 'heai-workshop'],
    ['podman', 'stop', 'heai-workshop'],
    ['podman', 'rm', '-f', 'heai-workshop'],
    ['podman', 'exec', '-w', '/repos', '-e', 'X=y', 'heai-workshop', 'herdr', 'agent', 'list'],
    ['podman', 'exec', '-d', 'heai-workshop', 'notify', '/heai/inbox', 'exited'],
    ['podman', 'exec', '-it', 'heai-workshop', 'herdr'],
    ['podman', 'exec', 'heai-workshop', 'herdr', 'agent', 'list'],
    ['podman', 'build', '-t', 'heai/pod', '-f', '/tool/image/Containerfile', '--build-arg', 'HERDR_VERSION=0.9.0', '/tool/image']
  ])
})

test('a failing runtime command is a RuntimeError with its stderr, and Apple\'s service hint when it applies', async () => {
  const failing: Spawner = async () => ({ code: 1, stdout: '', stderr: 'XPC connection error' })
  await assert.rejects(appleRuntime(failing).start('x'), (e: unknown) => e instanceof RuntimeError && /container start failed \(exit 1\): XPC connection error\nEnsure the container system service/.test(e.message))
  await assert.rejects(dockerRuntime('docker', failing).stop('x'), (e: unknown) => e instanceof RuntimeError && /docker stop failed/.test(e.message))
  const r = await appleRuntime(failing).exec('x', ['herdr'])
  assert.equal(r.code, 1, 'exec passes the exit code through so herdr\'s own error can be read')
})

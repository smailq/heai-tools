import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ContainerError, createContainerCli, parseContainerList, type ExecResult } from '../src/containers.ts'

const fixture = readFileSync(new URL('./fixtures/container-list.json', import.meta.url), 'utf8')

test('the parser reads only id, state, image and labels out of real `container list` output', () => {
  const list = parseContainerList(fixture)
  assert.equal(list.length, 2)
  const exp = list.find((c) => c.id === 'heai-exp')!
  assert.deepEqual(exp, {
    id: 'heai-exp',
    state: 'running',
    image: 'docker.io/library/alpine:latest',
    labels: { 'heai.actor': 'exp', 'heai.map': '3f9c1a2e' }
  })
  assert.equal(list.find((c) => c.id === 'buildkit')!.state, 'stopped')
})

test('output that is not a JSON array is a ContainerError, not a crash', () => {
  assert.throws(() => parseContainerList('not json'), ContainerError)
  assert.throws(() => parseContainerList('{}'), ContainerError)
  assert.deepEqual(parseContainerList('[]'), [])
  assert.deepEqual(parseContainerList('[{"status":{"state":"running"}}]'), [])
})

test('the CLI slice composes exactly the documented commands', async () => {
  const calls: string[][] = []
  const fake = async (args: string[]): Promise<ExecResult> => {
    calls.push(args)
    return { code: 0, stdout: args[0] === 'list' ? '[]' : '', stderr: '' }
  }
  const cli = createContainerCli(fake)
  await cli.list()
  await cli.run({
    name: 'heai-a',
    image: 'img',
    labels: { 'heai.actor': 'a' },
    mounts: { '/h/co': '/work', '/h/runs': '/heai/runs' },
    env: { HEAI_ACTOR: 'a' },
    envFile: '/h/env',
    cpus: 2,
    memory: '4G',
    command: ['sleep', 'infinity']
  })
  await cli.execDetached('heai-a', { env: { HEAI_RUN: 'r1' }, workdir: '/work' }, ['sh', '-c', 'x'])
  await cli.exec('heai-a', ['kill', '12'])
  await cli.stop('heai-a')
  await cli.delete('heai-a')
  await cli.build('heai/agent-echo', '/img/echo', '/img/echo/Containerfile')
  assert.deepEqual(calls, [
    ['list', '--all', '--format', 'json'],
    ['run', '-d', '--name', 'heai-a', '--label', 'heai.actor=a', '-v', '/h/co:/work', '-v', '/h/runs:/heai/runs', '-e', 'HEAI_ACTOR=a', '--env-file', '/h/env', '--cpus', '2', '--memory', '4G', 'img', 'sleep', 'infinity'],
    ['exec', '-d', '-w', '/work', '-e', 'HEAI_RUN=r1', 'heai-a', 'sh', '-c', 'x'],
    ['exec', 'heai-a', 'kill', '12'],
    ['stop', 'heai-a'],
    ['delete', 'heai-a'],
    ['build', '-t', 'heai/agent-echo', '-f', '/img/echo/Containerfile', '/img/echo']
  ])
})

test('a failed command surfaces stderr and the service hint', async () => {
  const cli = createContainerCli(async () => ({
    code: 1,
    stdout: '',
    stderr: 'Error: interrupted: "XPC connection error: Connection invalid"'
  }))
  await assert.rejects(cli.list(), (e: Error) => e instanceof ContainerError && /container system start/.test(e.message))
})

// Apple's `container` CLI (macOS 26, https://github.com/apple/container).
// Its JSON is undocumented, so the parser reads only the fields named here,
// and test/fixtures/container-list.json is real `container list --all
// --format json` output, checked in so a format change fails a test.

import { bound, execFlags, spawnCollect, spawnInherit, RuntimeError, type ContainerInfo, type InheritSpawner, type Runtime, type Spawner } from '../runtime.ts'

const BIN = 'container'

/** The fields this tool reads out of `container list --all --format json`; anything else is ignored. */
export function parseAppleList(json: string): ContainerInfo[] {
  let doc: unknown
  try {
    doc = JSON.parse(json)
  } catch {
    throw new RuntimeError('container list did not return JSON')
  }
  if (!Array.isArray(doc)) throw new RuntimeError('container list did not return a JSON array')
  const out: ContainerInfo[] = []
  for (const entry of doc as Record<string, unknown>[]) {
    const configuration = (entry?.['configuration'] ?? {}) as Record<string, unknown>
    const status = (entry?.['status'] ?? {}) as Record<string, unknown>
    const id = configuration['id']
    if (typeof id !== 'string') continue
    const image = (configuration['image'] ?? {}) as Record<string, unknown>
    const labels = (configuration['labels'] ?? {}) as Record<string, unknown>
    const state = typeof status['state'] === 'string' ? status['state'] : 'unknown'
    out.push({
      id,
      state,
      running: state === 'running',
      image: typeof image['reference'] === 'string' ? image['reference'] : '',
      labels: Object.fromEntries(Object.entries(labels).filter((kv): kv is [string, string] => typeof kv[1] === 'string'))
    })
  }
  return out
}

const serviceHint = 'Ensure the container system service is running: `container system start`'

export function appleRuntime(run: Spawner = spawnCollect, inherit: InheritSpawner = spawnInherit): Runtime {
  const ok = bound(BIN, run)
  const withHint = async (what: string, args: string[]) => {
    try {
      return await ok(what, args)
    } catch (e) {
      if (e instanceof RuntimeError && /XPC connection|apiserver|system start/i.test(e.stderr)) throw new RuntimeError(`${e.message}\n${serviceHint}`, e.stderr)
      throw e
    }
  }
  return {
    kind: 'apple',
    async list() {
      return parseAppleList((await withHint('list', ['list', '--all', '--format', 'json'])).stdout)
    },
    async run(spec) {
      const args = ['run', '-d', '--name', spec.name]
      for (const [k, v] of Object.entries(spec.labels)) args.push('-l', `${k}=${v}`)
      for (const m of spec.mounts) args.push('-v', `${m.host}:${m.container}`)
      for (const [k, v] of Object.entries(spec.env)) args.push('-e', `${k}=${v}`)
      if (spec.envFile) args.push('--env-file', spec.envFile)
      if (spec.cpus !== undefined) args.push('-c', String(spec.cpus))
      if (spec.memory !== undefined) args.push('-m', spec.memory)
      args.push(spec.image)
      await withHint('run', args)
    },
    async start(id) {
      await withHint('start', ['start', id])
    },
    async stop(id) {
      await withHint('stop', ['stop', id])
    },
    async delete(id, force = false) {
      await withHint('delete', ['delete', ...(force ? ['-f'] : []), id])
    },
    exec(id, args, opts) {
      return run(BIN, ['exec', ...execFlags(opts), id, ...args])
    },
    async execDetached(id, args, opts) {
      await withHint('exec', ['exec', '-d', ...execFlags(opts), id, ...args])
    },
    execInteractive(id, args, tty) {
      return inherit(BIN, ['exec', ...(tty ? ['-it'] : []), id, ...args])
    },
    async build(tag, contextDir, file, buildArgs) {
      const args = ['build', '-t', tag, '-f', file]
      for (const [k, v] of Object.entries(buildArgs)) args.push('--build-arg', `${k}=${v}`)
      args.push(contextDir)
      await withHint('build', args)
    }
  }
}

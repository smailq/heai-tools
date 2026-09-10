// Docker, or Podman through the same argv. `ps --format '{{json .}}'` prints
// one JSON object per line; the fields read here are the documented
// placeholders, and test/fixtures/docker-ps.jsonl is taken from Docker's own
// reference page rather than recorded, since no Docker was at hand.

import { bound, execFlags, spawnCollect, spawnInherit, RuntimeError, type ContainerInfo, type InheritSpawner, type Runtime, type Spawner } from '../runtime.ts'

/** `.Labels` is one string, `k=v,k=v`; a label value may itself hold `=`. */
function parseLabels(s: unknown): Record<string, string> {
  if (typeof s !== 'string' || !s) return {}
  const out: Record<string, string> = {}
  for (const pair of s.split(',')) {
    const eq = pair.indexOf('=')
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return out
}

/** The fields this tool reads out of `docker ps --all --format '{{json .}}'`, one object per line. */
export function parseDockerPs(text: string): ContainerInfo[] {
  const out: ContainerInfo[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      throw new RuntimeError('docker ps did not return one JSON object per line')
    }
    const names = entry['Names']
    if (typeof names !== 'string') continue
    const state = typeof entry['State'] === 'string' ? entry['State'] : 'unknown'
    out.push({
      // a container can have several names; the first is the one it was created with
      id: names.split(',')[0]!,
      state,
      running: state === 'running',
      image: typeof entry['Image'] === 'string' ? entry['Image'] : '',
      labels: parseLabels(entry['Labels'])
    })
  }
  return out
}

export function dockerRuntime(bin: 'docker' | 'podman' = 'docker', run: Spawner = spawnCollect, inherit: InheritSpawner = spawnInherit): Runtime {
  const ok = bound(bin, run)
  return {
    kind: bin,
    async list() {
      return parseDockerPs((await ok('ps', ['ps', '--all', '--format', '{{json .}}'])).stdout)
    },
    async run(spec) {
      const args = ['run', '-d', '--name', spec.name]
      for (const [k, v] of Object.entries(spec.labels)) args.push('--label', `${k}=${v}`)
      for (const m of spec.mounts) args.push('-v', `${m.host}:${m.container}`)
      for (const [k, v] of Object.entries(spec.env)) args.push('-e', `${k}=${v}`)
      if (spec.envFile) args.push('--env-file', spec.envFile)
      if (spec.cpus !== undefined) args.push('--cpus', String(spec.cpus))
      if (spec.memory !== undefined) args.push('--memory', spec.memory)
      args.push(spec.image)
      await ok('run', args)
    },
    async start(id) {
      await ok('start', ['start', id])
    },
    async stop(id) {
      await ok('stop', ['stop', id])
    },
    async delete(id, force = false) {
      await ok('rm', ['rm', ...(force ? ['-f'] : []), id])
    },
    exec(id, args, opts) {
      return run(bin, ['exec', ...execFlags(opts), id, ...args])
    },
    async execDetached(id, args, opts) {
      await ok('exec', ['exec', '-d', ...execFlags(opts), id, ...args])
    },
    execInteractive(id, args, tty) {
      return inherit(bin, ['exec', ...(tty ? ['-it'] : []), id, ...args])
    },
    async build(tag, contextDir, file, buildArgs) {
      const args = ['build', '-t', tag, '-f', file]
      for (const [k, v] of Object.entries(buildArgs)) args.push('--build-arg', `${k}=${v}`)
      args.push(contextDir)
      await ok('build', args)
    }
  }
}

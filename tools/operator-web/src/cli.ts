#!/usr/bin/env node
// heai-operator-web: the operator's panes as a web page, and the map editor.

import { parseArgs } from 'node:util'
import { envFromProcess, mapPath, tasksDir } from './discover.ts'
import { Reader } from './reader.ts'
import { createApp } from './server.ts'

const USAGE = `heai-operator-web - what the heai tools are doing, as a web page, and an editor for the architecture map

  heai-operator-web [--dir <dir>] [--port 8790] [--host 127.0.0.1]

  --dir <dir>          the project directory: the map at its root, tasks/ and each tool's state beside it; or HEAI_DIR
  --tasks <dir>        the tracker; default $HEAI_DIR/tasks, else .heai/tasks, else tasks, or HEAI_TASKS
  --map <path>         the architecture map; default $HEAI_DIR/architecture.yaml, else the tracker's tasks.yaml,
                       else .heai/architecture.yaml, else architecture.yaml, or HEAI_MAP
  --port <n>           the port to listen on (default 8790, or PORT)
  --host <addr>        the address to bind (default 127.0.0.1, or HOST); there is no login, so keep it on loopback
  --allow-host <name>  a host name the map editor may be reached under besides an address or localhost - the
                       name a proxy or a tailnet serves it as; repeat for more
  --interval <s>       the tracker's refresh interval in seconds (default 2)
  --poll <s>           the clock for flow, pod and reactor in seconds (default 5)

It asks the other tools by their released names: heai-architect, heai-flow, heai-pod and heai-reactor on PATH.
The panes only read; the architect tab, the map editor at /architect/, writes the architecture map and nothing else.

exit codes: 0 stopped; 2 no tracker at the resolved directory, bad usage, or the port could not be bound.
`

async function main(argv: string[]): Promise<number> {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        dir: { type: 'string' },
        tasks: { type: 'string' },
        map: { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        'allow-host': { type: 'string', multiple: true },
        interval: { type: 'string' },
        poll: { type: 'string' },
        help: { type: 'boolean', short: 'h' }
      }
    }))
  } catch (e) {
    process.stderr.write(`heai-operator-web: ${(e as Error).message}\n\n${USAGE}`)
    return 2
  }
  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  const seconds = (v: string | undefined, d: number): number => {
    const n = v === undefined ? d : Number(v)
    if (!Number.isFinite(n) || n <= 0) throw new Error(`not a number of seconds: ${v}`)
    return n * 1000
  }
  let interval, poll, port
  try {
    interval = seconds(values.interval, 2)
    poll = seconds(values.poll, 5)
    port = Number(values.port ?? process.env['PORT'] ?? 8790)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`not a port: ${values.port}`)
  } catch (e) {
    process.stderr.write(`heai-operator-web: ${(e as Error).message}\n`)
    return 2
  }
  const host = values.host ?? process.env['HOST'] ?? '127.0.0.1'
  const cwd = process.cwd()
  const env = envFromProcess()
  if (values.dir) env.HEAI_DIR = values.dir
  const tasks = tasksDir(values.tasks, env, cwd)
  // A --map, HEAI_MAP or HEAI_DIR beats the tracker's own config; the reader applies the rest.
  const mapOverride = values.map || env.HEAI_MAP || env.HEAI_DIR ? mapPath(values.map, env, '', cwd) : ''

  const reader = new Reader({ tasksDir: tasks, mapOverride, env, cwd, interval, poll })
  try {
    await reader.start()
  } catch (e) {
    process.stderr.write(`heai-operator-web: ${(e as Error).message}\n`)
    return 2
  }
  const server = createApp(reader, { allowHosts: values['allow-host'] ?? [] })
  const listening = await new Promise<boolean>((resolve) => {
    server.once('error', (e) => {
      process.stderr.write(`heai-operator-web: ${e.message}\n`)
      resolve(false)
    })
    server.listen(port, host, () => resolve(true))
  })
  if (!listening) {
    reader.stop()
    return 2
  }
  const addr = server.address()
  const where = typeof addr === 'object' && addr ? `${addr.address.includes(':') ? `[${addr.address}]` : addr.address}:${addr.port}` : String(addr)
  process.stderr.write(`heai-operator-web: http://${where} - the panes read only, the map editable in the architect tab (ctrl-c to stop)\n`)
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    process.stderr.write('heai-operator-web: WARNING - listening beyond loopback with no login: whoever reaches it sees the project and can edit the map\n')
  }
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      reader.stop()
      server.close(() => resolve())
      server.closeAllConnections()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return 0
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`heai-operator-web: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(2)
  }
)

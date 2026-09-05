// The other heai tools this one shells out to: scope-gate for the verdict,
// task-manager for the tracker writes. Tools do not import each other, so
// these are commands - a sibling checkout's bin when it is there, else the
// installed bin on PATH - and the configuration can name either explicitly.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = fileURLToPath(new URL('.', import.meta.url))

/** The argv prefix that runs a sibling tool. */
export function resolveTool(name: 'scope-gate' | 'task-manager', configured?: string): string[] {
  if (configured) return configured.split(/\s+/).filter(Boolean)
  const sibling = join(here, '..', '..', name, 'src', 'cli.ts')
  if (existsSync(sibling)) return [process.execPath, sibling]
  return [name]
}

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

/** Run a command and collect its output. */
export function runCommand(
  argv: string[],
  opts: { cwd?: string; stdin?: string; env?: Record<string, string> } = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv
    if (!cmd) {
      reject(new Error('empty command'))
      return
    }
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.stderr.on('data', (c: Buffer) => err.push(c))
    child.on('error', reject)
    child.on('close', (code) =>
      resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    )
    child.stdin.end(opts.stdin ?? '')
  })
}

/** `git <args>` in a directory; throws on failure with git's own message. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runCommand(['git', ...args], { cwd })
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || r.stdout).trim()}`)
  return r.stdout
}

/** `git <args>`, answering with whether it succeeded rather than throwing. */
export async function gitOk(cwd: string, ...args: string[]): Promise<boolean> {
  return (await runCommand(['git', ...args], { cwd })).code === 0
}

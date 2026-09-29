// Asking a sibling tool: find its command on PATH, run it with a deadline, and
// turn a failure into the one line worth showing - the last line it wrote to
// stderr - rather than a stack.

import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

/** How long one call to a sibling tool may take. */
export const TIMEOUT_MS = 10_000

/** The command's path when it is on PATH, else null. */
export function which(bin: string): string | null {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue
    const p = join(dir, bin)
    try {
      accessSync(p, constants.X_OK)
      return p
    } catch {
      // not here
    }
  }
  return null
}

export class ToolError extends Error {}

export interface RunOptions {
  /** Exit 1 with output on stdout is an answer, not a failure: `pod status`, `architect check`. */
  exit1OK?: boolean
  timeoutMs?: number
  /** Prefixes the message of a failure, as "flow: ...". */
  name: string
}

/** Runs a command and resolves with its stdout, or rejects with a ToolError saying why in one line. */
export function run(bin: string, args: string[], opts: RunOptions): Promise<string> {
  const timeout = opts.timeoutMs ?? TIMEOUT_MS
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout)
      const e = err as Error & { code?: number | string; killed?: boolean }
      if (opts.exit1OK && e.code === 1 && stdout.trim() !== '') return resolve(stdout)
      let msg = e.message
      const lines = stderr.trim().split('\n').filter(Boolean)
      // A tool that crashed ends with a stack and Node's version; its error line is the one worth showing.
      const thrown = lines.filter((l) => /^[A-Za-z]*Error\b.*:/.test(l))
      if (thrown.length) msg = thrown[thrown.length - 1]!
      else if (lines.length) msg = lines[lines.length - 1]!
      if (e.killed) msg = `timed out after ${timeout / 1000}s`
      if (e.code === 'ENOENT') msg = `${bin} not found`
      const prefix = `${opts.name}: `
      reject(new ToolError(prefix + (msg.startsWith(prefix) ? msg.slice(prefix.length) : msg)))
    })
  })
}

/** The message of anything thrown, for a note on a pane. */
export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

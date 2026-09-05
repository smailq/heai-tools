// The verdict on a finished run: the paths the source says the run changed,
// piped through scope-gate as the actor. The host never judges a diff
// itself; it asks the tool whose job that is and keeps the answer whole.

import type { GateReport } from './runs.ts'
import { runCommand } from './tools.ts'

export interface GateInput {
  /** Repo-root-relative paths the run changed. */
  changed: string[]
  cwd: string
  mapPath: string
  actor: string
  /** argv prefix that runs scope-gate. */
  scopeGate: string[]
}

export async function runGate(input: GateInput): Promise<GateReport> {
  if (!input.changed.length) return { verdict: 'clean', findings: [], violations: 0 }
  const argv = [...input.scopeGate, '--map', input.mapPath, '--actor', input.actor, '--format', 'json']
  let result
  try {
    result = await runCommand(argv, { stdin: input.changed.join('\n') + '\n', cwd: input.cwd })
  } catch (e) {
    return { verdict: 'error', findings: [], violations: 0, detail: (e as Error).message }
  }
  if (result.code === 2) {
    return { verdict: 'error', findings: [], violations: 0, detail: (result.stderr || result.stdout).trim() }
  }
  let parsed: { findings?: unknown[]; violations?: number } = {}
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed
  } catch {
    return { verdict: 'error', findings: [], violations: 0, detail: `scope-gate did not return JSON: ${result.stdout.slice(0, 200)}` }
  }
  return { verdict: result.code === 0 ? 'clean' : 'violation', findings: parsed.findings ?? [], violations: parsed.violations ?? 0 }
}

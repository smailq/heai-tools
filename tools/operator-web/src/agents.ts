// The agents, read from the project's agents/ directory under the shape its
// README states: one file per agent, <name>.md, opening with a frontmatter
// block of exactly name, kind and description, the prompt below it. This tool
// lists them and shows a prompt; it runs nothing. Read from files on the
// tracker's clock, as the tracker is.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface Agent {
  /** The file's name without .md: the agent's id, whatever the frontmatter says. */
  name: string
  kind: string
  description: string
  /** The prompt: everything after the frontmatter. */
  body: string
  /** The file's path. */
  path: string
  /** What the shape found wrong with the file; an agent with problems is still listed. */
  problems: string[]
}

export interface Agents {
  dir: string
  agents: Agent[]
}

export const KEYS = ['name', 'kind', 'description']

/** Whether the project has an agents directory; `status` creates nothing, so this only looks. */
export function agentsConfigured(project: string): string {
  if (!project) return 'no project directory, so nowhere to look for agents/'
  try {
    if (statSync(join(project, 'agents')).isDirectory()) return ''
  } catch {
    // not here
  }
  return 'not configured here (no agents/ in the project)'
}

/** Reads every agent file under project/agents, sorted by name. */
export function loadAgents(project: string): Agents {
  const dir = join(project, 'agents')
  const agents: Agent[] = []
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.md') || file === 'README.md' || file.startsWith('.')) continue
    const path = join(dir, file)
    if (!statSync(path).isFile()) continue
    agents.push(parseAgent(file.slice(0, -3), readFileSync(path, 'utf8'), path))
  }
  return { dir, agents }
}

/** Reads one agent file; every problem is reported in one pass. */
export function parseAgent(name: string, raw: string, path = ''): Agent {
  const a: Agent = { name, kind: '', description: '', body: '', path, problems: [] }
  raw = raw.replaceAll('\r\n', '\n')
  if (!raw.startsWith('---\n')) {
    a.problems.push("missing frontmatter opening '---'")
    a.body = raw.trim()
    return a
  }
  const end = raw.indexOf('\n---\n', 4)
  if (end < 0) {
    a.problems.push("missing frontmatter closing '---'")
    return a
  }
  const fields = new Map<string, string>()
  for (const line of raw.slice(4, end).split('\n')) {
    if (line.trim() === '') continue
    const i = line.indexOf(':')
    if (i <= 0) {
      a.problems.push(`bad frontmatter line: ${JSON.stringify(line)}`)
      continue
    }
    const key = line.slice(0, i).trim()
    const val = line.slice(i + 1).trim()
    if (!KEYS.includes(key)) {
      a.problems.push(`unknown frontmatter key: ${key}`)
      continue
    }
    if (fields.has(key)) {
      a.problems.push(`duplicate frontmatter key: ${key}`)
      continue
    }
    fields.set(key, val)
  }
  for (const key of KEYS) if (!fields.has(key)) a.problems.push(`missing frontmatter key: ${key}`)
  const declared = fields.get('name')
  if (declared !== undefined && declared !== name) a.problems.push(`name ${JSON.stringify(declared)} is not the file's name, ${name}`)
  a.kind = fields.get('kind') ?? ''
  a.description = fields.get('description') ?? ''
  if (fields.has('kind') && !a.kind) a.problems.push('kind must not be empty')
  a.body = raw.slice(end + 5).trim()
  if (!a.body) a.problems.push('the prompt below the frontmatter is empty')
  return a
}

export const agentValid = (a: Agent): boolean => a.problems.length === 0

/** Counts by kind, most first then by name: "worker 5 · gate 3". */
export function kindCounts(list: Agent[]): Array<[string, number]> {
  const c = new Map<string, number>()
  for (const a of list) if (a.kind) c.set(a.kind, (c.get(a.kind) ?? 0) + 1)
  return [...c].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
}

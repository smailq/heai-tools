// Working together: the request files a run writes become tracker tasks, the
// requesting task becomes blocked, and a blocked task whose blockers have all
// landed becomes todo again. Every tracker write goes through the task-manager
// CLI, so the tracker's own validation holds and the host writes only facts
// it alone knows - never a judgement of what is done.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ArchitectureMap } from './map.ts'
import { loadTracker, slugify, uniqueSlug, type Task } from './tasks.ts'
import { requestsDir, writeBlocked, writeRequested, chainDepth, type RequestRecord, type RunRecord, type State } from './runs.ts'
import { runCommand } from './tools.ts'

export interface ParsedRequest {
  file: string
  title: string
  territory: string
  body: string
  problems: string[]
}

/** The request files a run left, parsed leniently and problems collected. */
export function readRequests(state: State, id: string): ParsedRequest[] {
  const dir = requestsDir(state, id)
  if (!existsSync(dir)) return []
  const out: ParsedRequest[] = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const raw = readFileSync(join(dir, file), 'utf8')
    const problems: string[] = []
    const fields: Record<string, string> = {}
    let body = ''
    if (raw.startsWith('---\n')) {
      const end = raw.indexOf('\n---\n', 4)
      if (end === -1) problems.push("missing frontmatter closing '---'")
      else {
        for (const line of raw.slice(4, end).split('\n')) {
          const m = line.match(/^([a-z_]+):[ ]?(.*)$/)
          if (m) fields[m[1]!] = m[2]!.trim()
        }
        body = raw.slice(end + 5).trim()
      }
    } else problems.push("missing frontmatter opening '---'")
    if (!fields['title']) problems.push('title is required')
    if (!fields['territory']) problems.push('territory is required')
    if (!body) problems.push('body is required')
    out.push({ file, title: fields['title'] ?? '', territory: fields['territory'] ?? '', body, problems })
  }
  return out
}

export interface RequestContext {
  state: State
  map: ArchitectureMap
  tasksDir: string
  /** argv prefix for the task-manager CLI. */
  taskManager: string[]
}

async function taskManager(ctx: RequestContext, args: string[], stdin?: string): Promise<string | null> {
  const r = await runCommand([...ctx.taskManager, ...args, '--dir', ctx.tasksDir], { stdin })
  if (r.code !== 0) return (r.stderr || r.stdout).trim() || `task-manager exited ${r.code}`
  return null
}

/**
 * Turn a settled run's request files into tasks. Each becomes a `todo` in the
 * territory it names, at the requesting task's priority, with a provenance
 * line; a request the map cannot route is recorded as rejected, not filed.
 */
export async function fileRequests(ctx: RequestContext, run: RunRecord, requester: Task | null): Promise<RequestRecord[]> {
  const parsed = readRequests(ctx.state, run.id)
  const records: RequestRecord[] = []
  for (const q of parsed) {
    const problems = [...q.problems]
    const territory = ctx.map.territory(q.territory)
    if (q.territory && !territory) problems.push(`the map declares no territory ${JSON.stringify(q.territory)}`)
    if (problems.length) {
      records.push({ title: q.title || q.file, territory: q.territory, task: null, error: `${q.file}: ${problems.join('; ')}` })
      continue
    }
    const tracker = loadTracker(ctx.tasksDir)
    const slug = uniqueSlug(tracker, slugify(q.title) || 'request')
    const provenance = requester
      ? `Requested by \`${run.actor}\` in run \`${run.id}\`, for [${requester.slug}](${requester.slug}.md).`
      : `Requested by \`${run.actor}\` in run \`${run.id}\`.`
    const body = `${q.body}\n\n${provenance}\n`
    const args = ['new', slug, '--title', q.title, '--territory', q.territory, '--status', 'todo', '--body', '-']
    if (requester?.priority) args.push('--priority', requester.priority)
    const error = await taskManager(ctx, args, body)
    if (error) {
      records.push({ title: q.title, territory: q.territory, task: null, error: `${q.file}: ${error}` })
      continue
    }
    writeRequested(ctx.state, {
      slug,
      requestedBy: requester?.slug ?? '',
      run: run.id,
      depth: (requester ? chainDepth(ctx.state, requester.slug) : 0) + 1
    })
    records.push({ title: q.title, territory: q.territory, task: slug })
  }
  return records
}

/** Block the requesting task on what was filed, and remember to watch it. */
export async function blockTask(ctx: RequestContext, run: RunRecord, requester: Task, filed: string[]): Promise<string | null> {
  const links = filed.map((s) => `[${s}](${s}.md)`).join(', ')
  const note = `Blocked by ${links}, requested by \`${run.actor}\` in run \`${run.id}\`.`
  const error = await taskManager(ctx, ['set', requester.slug, '--status', 'blocked', '--note', note])
  if (error) return error
  writeBlocked(ctx.state, { slug: requester.slug, actor: run.actor, waitsOn: filed, run: run.id })
  return null
}

export interface Unblocked {
  slug: string
  actor: string
  landed: string[]
}

/**
 * Every blocked task the host is watching whose blockers are all `done` -
 * landed - goes back to `todo`, with a note saying which blocker landed.
 * Returns what was unblocked, so the caller can resume under `dispatch: auto`.
 */
export async function unblockLanded(
  ctx: RequestContext,
  blocked: { slug: string; actor: string; waitsOn: string[] }[],
  clear: (slug: string) => void
): Promise<{ unblocked: Unblocked[]; errors: string[] }> {
  const unblocked: Unblocked[] = []
  const errors: string[] = []
  if (!blocked.length) return { unblocked, errors }
  const tracker = loadTracker(ctx.tasksDir)
  for (const b of blocked) {
    const task = tracker.task(b.slug)
    if (!task) {
      clear(b.slug)
      continue
    }
    if (task.status !== 'blocked') {
      // A human moved it; the host's watch is over.
      clear(b.slug)
      continue
    }
    const statuses = b.waitsOn.map((s) => tracker.task(s)?.status ?? 'missing')
    if (!statuses.every((s) => s === 'done')) continue
    const note = `Unblocked: ${b.waitsOn.map((s) => `[${s}](${s}.md)`).join(', ')} landed.`
    const error = await taskManager(ctx, ['set', b.slug, '--status', 'todo', '--note', note])
    if (error) {
      errors.push(`unblocking ${b.slug}: ${error}`)
      continue
    }
    clear(b.slug)
    unblocked.push({ slug: b.slug, actor: b.actor, landed: b.waitsOn })
  }
  return { unblocked, errors }
}

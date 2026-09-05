// What an actor is told, composed from the map and the task.
//
// The order is deliberate: the standing guidance frames the work rather than
// trailing it. The actor's own context, then each territory it owns with its
// context chain, then the task, then the host's rules - including how to ask
// another territory for work. Nothing here is harness-specific, and nothing is
// version-control-specific - the source plugin supplies its own rule. The
// result is plain markdown on stdin.

import type { ArchitectureMap, Territory } from './map.ts'
import type { Task } from './tasks.ts'

export interface PromptInput {
  map: ArchitectureMap
  actor: string
  /** How to record work, from the source plugin. */
  rules: string[]
  /** A tracker task, or null for a free-form prompt. */
  task: Task | null
  /** The free-form prompt, when there is no task. */
  prompt: string | null
  /** The run this one continues, when a blocked task resumes. */
  resumes: { id: string; finalMessage: string; requests: { title: string; task: string }[] } | null
}

const globsOf = (t: Territory): string =>
  t.scope.flatMap((e) => e.globs.map((g) => `\`${g}\``)).join(', ') || '(no globs)'

/** The prompt a run reads on stdin. */
export function composePrompt(input: PromptInput): string {
  const { map, actor } = input
  const a = map.actor(actor)
  const out: string[] = []

  out.push(`# You are \`${actor}\``, '')
  if (a?.context) out.push(a.context.trim(), '')

  out.push('# Your territories', '')
  const owned = map.owned(actor)
  if (!owned.length) out.push('_You own no territory. You may change nothing; say so and stop._', '')
  for (const t of owned) {
    out.push(`## ${t.name} - ${globsOf(t)}`, '')
    for (const { territory, context } of map.contextChain(t.name)) {
      if (territory !== t.name) out.push(`_From ${territory}:_`, '')
      out.push(context.trim(), '')
    }
  }

  const watched = map.watched(actor)
  if (watched.length) {
    out.push('# Territories you watch', '', '_Observed, not owned: you may read these and file requests about them, never change them._', '')
    for (const t of watched) {
      out.push(`## ${t.name} - ${globsOf(t)} (owned by ${t.owner ?? 'nobody'})`, '')
      for (const { territory, context } of map.contextChain(t.name)) {
        if (territory !== t.name) out.push(`_From ${territory}:_`, '')
        out.push(context.trim(), '')
      }
    }
  }

  if (input.task) {
    const t = input.task
    const meta = [t.priority && `priority ${t.priority}`, t.territories.length && `territory ${t.territories.join(', ')}`]
      .filter(Boolean)
      .join(', ')
    out.push(`# The task: ${t.slug}`, '', `**${t.title}**${meta ? ` (${meta})` : ''}`, '', t.body.trim(), '')
  } else {
    out.push('# The task', '', (input.prompt ?? '').trim(), '')
  }

  if (input.resumes) {
    const r = input.resumes
    out.push(
      '# Resuming',
      '',
      `You worked on this before, in run \`${r.id}\`, and finished blocked. The work you requested has since landed on the base, and your checkout has been brought up to date with it.`,
      ''
    )
    if (r.requests.length) {
      out.push('You had requested:', '')
      for (const q of r.requests) out.push(`- ${q.title} (task \`${q.task}\`, now done)`)
      out.push('')
    }
    if (r.finalMessage) out.push('Your final message then was:', '', '> ' + r.finalMessage.trim().split('\n').join('\n> '), '')
  }

  out.push(
    '# How to work',
    '',
    `- You are acting as the actor \`${actor}\`, and \`HEAI_ACTOR\` says so.`,
    '- Change only paths inside the territories above. A change anywhere else will be refused by the scope gate; if the task needs one, request it as described below.',
    ...input.rules.map((r) => `- ${r}`),
    '- Never edit the task tracker.',
    '- If the task needs a change outside your territories, do not make it. Write one file per request to `/heai/runs/$HEAI_RUN.requests/<name>.md`, with `title` and `territory` in frontmatter and, in the body, what is needed, why, and how you will know it is done. Then commit what you have and finish, saying what you are blocked on.',
    '- Report what you did and what remains in your final message.',
    ''
  )
  return out.join('\n')
}

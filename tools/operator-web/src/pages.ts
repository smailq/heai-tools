// The pages: one tab per pane, a page per row, and the machines. Every value
// on them passes through html``, so what the tools report is always text.

import { basename } from 'node:path'
import { ageDays, ago, clock, hms, orDash, short, since } from './format.ts'
import { html, raw, type Html } from './html.ts'
import { lineResult, move, openCount, stands, flowsRed, type Definition, type Flow, type Stuck, type Timeline } from './flows.ts'
import { moveKey, renderMachine } from './machine.ts'
import { countBy, jobDuration, jobExit, jobStarted, jobState, jobWorker, podSummary, podUp, queueText, type Job, type JobOutput } from './pod.ts'
import { actionFailed, actionResult, cadence, command, failedActions, limited, logPath, problem, problems, reactorRed, ruleResult, type Event } from './reactor.ts'
import { TOOLS, type Reading, type Tool } from './reader.ts'
import { blockerState, counts, STATUSES, trackerRed, valid, WORKING_SET, type Task } from './tracker.ts'

export type Tab = Tool

export interface Ctx {
  r: Reading
  now: number
  /** Seconds between a page's own refreshes: the tracker's interval. */
  refresh: number
}

export const isRed = (r: Reading): boolean => (r.tracker ? trackerRed(r.tracker) : false) || flowsRed(r.flows) || reactorRed(r.reactor)

const age = (text: string): Html => html`<span class="faint age">${text}</span>`
const filterBox = html`<input type="search" class="filter" placeholder="filter" aria-label="filter rows">`
const table = (head: Html, body: Html | Html[]): Html => html`<div class="scroll"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
const empty = (cols: number, text: string): Html => html`<tr><td colspan="${cols}" class="faint">${text}</td></tr>`
const noteLine = (note: string, failed: boolean, at?: number): Html | null =>
  note ? html`<p class="${failed ? 'warn' : 'faint'}">${failed ? '⚠ ' : ''}${note}${failed && at ? ` · as of ${hms(at)}` : ''}</p>` : null
const links = (l: Record<string, string>): Html[] => Object.entries(l).map(([k, v]) => html`<span class="tag">${k} ${v}</span> `)
const enc = encodeURIComponent

/** The primary tabs, in order; the number key for each is its place in this list. */
export const TABS: readonly Tab[] = TOOLS

const HREF: Record<Tab, string> = { architect: '/architect/', tasks: '/tasks', flows: '/flows', pod: '/pod', reactor: '/reactor' }

/** Where the root goes: the first tab whose tool the project has, else the architect, which can start a map. */
export const firstTab = (r: Reading): string => HREF[TABS.find((t) => !r.absent[t]) ?? 'architect']

/**
 * The header and the primary tabs, shared by every page - the map editor's too, which is why
 * its classes are its own (opnav, optab…) and not the page's: the editor styles header, .tab
 * and .st-* for its own controls. Each tab carries its pane's one-line summary; the tab of a
 * tool the project does not have is off - no link, and what was looked for in place of a summary.
 */
export function nav(ctx: Ctx, tab: Tab): Html {
  const { r, now } = ctx
  const project = basename(r.project || '.')
  const t = r.tracker
  const active = t ? Object.entries(counts(t)).filter(([s]) => WORKING_SET.has(s)).sort((a, b) => STATUSES.indexOf(a[0]) - STATUSES.indexOf(b[0])) : []
  const fl = r.flows
  const st = r.reactor.status
  const failedN = failedActions(r.reactor).length
  const territories = r.territories.names.length
  const sub: Record<Tab, Html | string> = {
    architect: html`${r.map ? basename(r.map) : 'no map'}${territories ? ` · ${territories} territories` : ''}${r.territories.note ? html` · <span class="warn">⚠ ${r.territories.note}</span>` : null}`,
    tasks: t ? `${t.tasks.length} · changed ${ago(t.changed, now)}` : html`<span class="red">⚠ ${r.trackerError}</span>`,
    flows: fl.flows.length || fl.definitions.length
      ? html`${openCount(fl.flows)} open${fl.stuck.length ? html` · <span class="warn">⚠ ${fl.stuck.length} stuck</span>` : null}${flowsRed(fl) ? html` <span class="red">●</span>` : null} · ${fl.definitions.length} machines`
      : orDash(fl.note),
    pod: r.pod.status
      ? html`${podUp(r.pod.status) ? html`<span class="ok">●</span>` : html`<span class="warn">○</span>`} ${podSummary(r.pod.status)} · ${queueText(r.pod.status)}`
      : r.pod.jobs.length
        ? html`<span class="warn">○</span> ${r.pod.jobs.length} jobs · ${orDash(r.pod.note)}`
        : orDash(r.pod.note),
    reactor: st
      ? html`${r.reactor.events.length} events/1h · ${st.rules.length} rules${problems(st) ? html` · <span class="warn">⚠ ${problems(st)}</span>` : null}${failedN ? html` · <span class="red">✗ ${failedN} failed</span>` : null}`
      : orDash(r.reactor.note)
  }
  const one = (name: Tab): Html => {
    const on = name === tab ? ' on' : ''
    const why = r.absent[name]
    if (why) return html`<span title="${why}" aria-disabled="true" class="optab off${on}"><b>${name}</b><small>${why}</small></span>`
    return html`<a href="${HREF[name]}" class="optab${on}"><b>${name}</b><small>${sub[name]}</small></a>`
  }
  return html`<div class="opnav">
<div class="optop">
  <span class="brand">operator</span>
  <span class="project">${project}</span>
  ${t ? html`<span class="meter">tasks ${t.tasks.length}:${active.map(([s, n]) => html` <span class="st st-${s}">${s} ${n}</span>`)}</span>` : null}
  ${isRed(r) ? html`<span class="meter red">● something is red</span>` : null}
  <span class="spacer"></span>
  <span class="faint">every ${ctx.refresh}s · ${hms(now)} UTC</span>
</div>
<nav class="optabs" aria-label="tabs">
${TABS.map(one)}
</nav>
</div>`
}

export function layout(ctx: Ctx, tab: Tab, title: string, pane: Html): string {
  const project = basename(ctx.r.project || '.')
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${title} · ${project} · operator</title>
<link rel="stylesheet" href="/static/nav.css">
<link rel="stylesheet" href="/static/operator.css">
<script src="/static/operator.js" defer></script>
<noscript><meta http-equiv="refresh" content="${ctx.refresh}"></noscript>
</head>
<body data-refresh="${ctx.refresh}">
<div id="live">
${nav(ctx, tab)}
<main>
${pane}
</main>
</div>
<footer class="faint">The panes write nothing: every change to a task, a flow, the pod or the reactor is made at the shell with that tool's own command; only the architect tab writes, and only the map. <a href="/api/state">/api/state</a> is this reading as JSON.</footer>
</body>
</html>`.value
}

/**
 * The map editor's page with the primary tabs above it. The editor's own markup is a
 * file; the tabs are this reading, put where it says <!-- operator-nav -->.
 */
export function architectPage(ctx: Ctx, page: string): string {
  return page
    .replace('<!-- operator-nav -->', nav(ctx, 'architect').value)
    .replace('<body>', `<body data-refresh="${ctx.refresh}">`)
}

/** The flows tab's own tabs: the flows themselves, and the machines they run on. */
function flowsSubnav(on: 'list' | 'machines'): Html {
  return html`<nav class="subtabs" aria-label="flows"><a href="/flows"${on === 'list' ? raw(' class="on"') : ''}>flows</a><a href="/flows/machines"${on === 'machines' ? raw(' class="on"') : ''}>machines</a></nav>`
}

// ── tasks ──

export const SORTS = ['pick-up', 'age', 'slug', 'territory'] as const

export function tasksPane(ctx: Ctx, activeOnly: boolean, sortBy: string): Html {
  const { r, now } = ctx
  const t = r.tracker
  let rows = t ? t.tasks.filter((x) => !(activeOnly && valid(x) && !WORKING_SET.has(x.status))) : []
  const sort = (SORTS as readonly string[]).includes(sortBy) ? sortBy : 'pick-up'
  if (sort === 'age') rows = [...rows].sort((a, b) => (a.modified_at > b.modified_at ? -1 : a.modified_at < b.modified_at ? 1 : 0))
  if (sort === 'slug') rows = [...rows].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
  if (sort === 'territory') {
    rows = [...rows].sort((a, b) => {
      const x = a.territories.join(','), y = b.territories.join(',')
      if ((x === '') !== (y === '')) return x ? -1 : 1
      return x < y ? -1 : x > y ? 1 : 0
    })
  }
  const act = activeOnly ? '&active=1' : ''
  const row = (task: Task): Html => {
    if (!valid(task)) {
      return html`<tr class="bad"><td class="red">invalid</td><td></td><td><a href="/tasks/${enc(task.slug)}">${task.slug}</a></td><td colspan="4" class="red">${task.problems[0]}</td></tr>`
    }
    const b = t ? blockerState(t, task) : ''
    const dead = b === 'missing' || b === 'canceled'
    return html`<tr class="${task.status === 'done' || task.status === 'canceled' ? 'dim' : ''}">
<td><span class="st st-${task.status}">${task.status}</span></td>
<td class="pri pri-${orDash(task.priority)}">${orDash(task.priority)}</td>
<td><a href="/tasks/${enc(task.slug)}">${task.slug}</a></td>
<td class="wide">${orDash(task.territories.join(','))}</td>
<td>${orDash(task.agent)}</td>
<td>${ageDays(task.modified_at, now)}</td>
<td>${task.blocker ? html`← <a href="/tasks/${enc(task.blocker)}">${task.blocker}</a>${dead ? html` <span class="red">(blocker ${b})</span>` : b ? html` <span class="faint">(${b})</span>` : null}` : null}</td>
</tr>`
  }
  return html`<div class="panehead">
  <h1>tasks <span class="faint">── ${activeOnly ? 'active' : 'all'} ${rows.length} of ${t?.tasks.length ?? 0}</span></h1>
  <div class="controls">${filterBox}
    <span class="seg"><a href="?sort=${sort}"${activeOnly ? '' : raw(' class="on"')}>all</a><a href="?active=1&amp;sort=${sort}"${activeOnly ? raw(' class="on"') : ''}>active</a></span>
    <span class="seg">sort ${SORTS.map((s) => html`<a href="?sort=${s}${act}"${s === sort ? raw(' class="on"') : ''}>${s}</a>`)}</span>
  </div>
</div>
${r.trackerError ? html`<p class="warn">⚠ ${r.trackerError}</p>` : null}
${t?.configError ? html`<p class="warn">⚠ ${t.configError}</p>` : null}
${table(
  html`<th>status</th><th>pri</th><th>slug</th><th class="wide">territory</th><th>agent</th><th>age</th><th>blocked by</th>`,
  rows.length ? rows.map(row) : empty(7, '(nothing to show)')
)}`
}

export function taskPane(ctx: Ctx, task: Task): Html {
  const t = ctx.r.tracker!
  const b = blockerState(t, task)
  const dead = b === 'missing' || b === 'canceled'
  return html`<p class="crumbs"><a href="/tasks">← tasks</a></p>
<h1>${task.slug} ${valid(task) ? html`<span class="st st-${task.status}">${task.status}</span>` : html`<span class="red">invalid</span>`}</h1>
${task.problems.length ? html`<ul class="red">${task.problems.map((p) => html`<li>${p}</li>`)}</ul>` : null}
<table class="kv">
<tr><th>title</th><td>${task.title}</td></tr>
<tr><th>status</th><td>${task.status}</td></tr>
<tr><th>priority</th><td>${orDash(task.priority)}</td></tr>
<tr><th>territory</th><td>${task.territories.length ? task.territories.map((x) => html`<div>${x}</div>`) : '(untriaged)'}</td></tr>
<tr><th>agent</th><td>${orDash(task.agent)}</td></tr>
${task.blocker ? html`<tr><th>blocked by</th><td><a href="/tasks/${enc(task.blocker)}">${task.blocker}</a> <span class="${dead ? 'red' : 'faint'}">(${b})</span></td></tr>` : null}
<tr><th>created</th><td>${orDash(task.created_at)}</td></tr>
<tr><th>modified</th><td>${orDash(task.modified_at)} <span class="faint">${ageDays(task.modified_at, ctx.now)}</span></td></tr>
<tr><th>file</th><td><code>${t.dir}/items/${task.slug}.md</code></td></tr>
</table>
<h2>body</h2>
<pre class="body">${task.body}</pre>`
}

// ── flows ──

const inState = (f: Flow, now: number): string => since(f.since, now)

/** How long a flow that has ended took, start to its last move; "-" while it can still move. */
export function flowDuration(f: Flow): string {
  if (!f.terminal) return '-'
  const start = Date.parse(f.startedAt)
  const end = Date.parse(f.since)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '-'
  return short(end - start)
}

/** The last segment of an id, for a table whose row already carries the date and definition. */
export const shortId = (id: string): string => {
  const i = id.lastIndexOf('-')
  return i >= 0 && i < id.length - 1 ? id.slice(i + 1) : id
}

export function flowsPane(ctx: Ctx): Html {
  const { r, now } = ctx
  const fl = r.flows
  const byId = new Set(fl.flows.map((f) => f.id))
  const stuckRow = (s: Stuck): Html => {
    const st = stands(s, fl.flows)
    return html`<tr><td><a href="/flows/${enc(s.flow.id)}">${s.flow.id}</a></td><td>${s.flow.state}</td><td>${short(s.idleMs)}</td>
<td>${s.waits.length ? s.waits.map((w, i) => html`${i ? ', ' : ''}${byId.has(w.id) ? html`<a href="/flows/${enc(w.id)}">${w.id}</a>` : w.id}`) : '-'}</td>
<td class="${st.red ? 'red' : ''}">${orDash(st.text)}</td></tr>`
  }
  const flowRow = (f: Flow): Html => html`<tr class="${f.terminal ? 'dim' : ''}">
<td><a href="/flows/${enc(f.id)}" title="${f.id}">${shortId(f.id)}</a></td>
<td>${f.definition}</td><td>${f.state}</td><td>${inState(f, now)}</td><td>${since(f.startedAt, now)}</td><td>${flowDuration(f)}</td>
<td>${f.waitsOn.length || '-'}</td><td class="wide">${links(f.links)}</td></tr>`
  return html`${flowsSubnav('list')}<div class="panehead">
  <h1>flows <span class="faint">── ${openCount(fl.flows)} open of ${fl.flows.length} · ${fl.stuck.length} stuck older than 1h</span></h1>
  <div class="controls">${filterBox} ${age(`flow ${ago(fl.at, now)}`)}</div>
</div>
${noteLine(fl.note, fl.failed, fl.at)}
${fl.stuck.length ? html`<h2>stuck</h2>${table(html`<th>flow</th><th>state</th><th>idle</th><th>waits on</th><th>stands</th>`, fl.stuck.map(stuckRow))}` : null}
${fl.flows.length ? html`<h2>all flows</h2>` : null}
${table(
  html`<th>id</th><th>definition</th><th>state</th><th>age</th><th>started</th><th>duration</th><th>waits</th><th class="wide">links</th>`,
  fl.flows.length ? fl.flows.map(flowRow) : empty(8, fl.at ? 'no flows' : 'asking flow…')
)}
${fl.definitions.length
  ? html`<h2>definitions</h2>${table(
      html`<th>name</th><th>states</th><th class="wide">path</th>`,
      fl.definitions.map((d) => html`<tr><td><a href="/flows/machines/${enc(d.name)}">${d.name}</a></td><td>${(d.states ?? []).join(' · ')}${d.problem ? html` <span class="red">⚠ ${d.problem}</span>` : null}</td><td class="wide"><code>${d.path}</code></td></tr>`)
    )}`
  : null}`
}

export function flowPane(ctx: Ctx, f: Flow, tl: Timeline | null, traceErr: string): Html {
  const { r, now } = ctx
  const fl = r.flows
  const sk = fl.stuck.find((s) => s.flow.id === f.id)
  const byId = new Map(fl.flows.map((x) => [x.id, x]))
  const def = fl.definitions.find((d) => d.name === f.definition && !d.problem)
  let graph = ''
  if (def && tl) {
    const taken = new Set<string>()
    const visited = new Set<string>()
    for (const l of tl.lines) {
      if (l.id !== f.id) continue
      visited.add(l.to)
      if (l.from !== null && l.from !== l.to) taken.add(moveKey(l.from, l.to))
    }
    graph = renderMachine({ def, current: f.state, taken, visited, href: (s) => `/flows/machines/${enc(def.name)}?state=${enc(s)}#flows` })
  }
  return html`<p class="crumbs"><a href="/flows">← flows</a></p>
<h1>${f.definition} · ${f.state} <span class="faint">in state ${inState(f, now)}</span></h1>
<table class="kv">
<tr><th>id</th><td><code>${f.id}</code></td></tr>
<tr><th>state</th><td>${f.state}${f.terminal ? html` <span class="faint">(terminal)</span>` : null} · started ${since(f.startedAt, now)} ago · seq ${f.seq}</td></tr>
<tr><th>touched</th><td>${f.touchedAt ? `${since(f.touchedAt, now)} ago` : '-'}</td></tr>
<tr><th>expires</th><td>${orDash(f.expiresAt)}</td></tr>
<tr><th>duration</th><td>${flowDuration(f)}</td></tr>
${sk ? html`<tr><th>stuck</th><td class="warn">idle ${short(sk.idleMs)}${stands(sk, fl.flows).text ? ` · waits stand ${stands(sk, fl.flows).text}` : ''}</td></tr>` : null}
</table>
<h2>links</h2>
<table class="kv">
${Object.keys(f.links).length
  ? Object.entries(f.links).map(([k, v]) => html`<tr><th>${k}</th><td>${k === 'task' ? html`<a href="/tasks/${enc(v)}">${v}</a>` : v}</td></tr>`)
  : html`<tr><td class="faint">none</td></tr>`}
${f.waitsOn.map((id) => {
  const w = byId.get(id)
  return html`<tr><th>waits on</th><td><a href="/flows/${enc(id)}">${id}</a> ${w ? html`<span class="${w.terminal ? 'red' : 'faint'}">(${w.state})</span>` : html`<span class="red">(missing)</span>`}</td></tr>`
})}
</table>
${graph ? html`<h2>where it stands <span class="faint">its definition, <a href="/flows/machines/${enc(f.definition)}">${f.definition}</a>, with the moves it made</span></h2><div class="scroll machine-wrap">${raw(graph)}</div>` : null}
<h2>trace <span class="faint">heai-flow trace ${f.id} --json</span></h2>
${traceErr ? html`<p class="warn">⚠ ${traceErr}</p>` : null}
${table(
  html`<th>at</th><th>flow</th><th>seq</th><th>change</th><th>by</th><th>result</th>`,
  tl?.lines.length
    ? tl.lines.map(
        (l) =>
          html`<tr class="${l.id !== f.id ? 'dim' : ''}"><td>${clock(l.at, now)}</td><td>${l.id !== f.id ? html`<a href="/flows/${enc(l.id)}">${l.definition} ${shortId(l.id)}</a>` : l.definition}</td><td>${l.seq}</td><td>${move(l)}</td><td>${orDash(l.by)}</td><td>${lineResult(l)}</td></tr>`
      )
    : empty(6, 'no lines')
)}`
}

// ── machines ──

/** The definition worth seeing first: the one with the most open flows. */
export function firstDefinition(defs: Definition[], flows: Flow[]): string {
  let best = defs[0]?.name ?? ''
  let most = -1
  for (const d of defs) {
    const open = flows.filter((f) => f.definition === d.name && !f.terminal).length
    if (open > most) [best, most] = [d.name, open]
  }
  return best
}

export function machinesPane(ctx: Ctx, def: Definition | null, state: string): Html {
  const { r, now } = ctx
  const fl = r.flows
  const names = fl.definitions.map((d) => d.name)
  if (!def) {
    return html`${flowsSubnav('machines')}<div class="panehead"><h1>machines <span class="faint">── no definitions</span></h1></div>${noteLine(fl.note, fl.failed, fl.at)}<p class="faint">${fl.at ? 'no definitions' : 'asking flow…'}</p>`
  }
  const mine = fl.flows.filter((f) => f.definition === def.name)
  const countsBy: Record<string, number> = {}
  for (const f of mine) countsBy[f.state] = (countsBy[f.state] ?? 0) + 1
  const base = `/flows/machines/${enc(def.name)}`
  const graph = renderMachine({ def, counts: countsBy, current: state || undefined, href: (s) => (s === state ? `${base}#flows` : `${base}?state=${enc(s)}#flows`) })
  const rows = mine.filter((f) => !state || f.state === state)
  return html`${flowsSubnav('machines')}<div class="panehead">
  <h1>machines <span class="faint">── ${names.length} definitions · ${def.name}: ${(def.states ?? []).length} states, ${(def.transitions ?? []).length} transitions, ${openCount(mine)} open</span></h1>
  <div class="controls">
    <span class="seg">${names.map((n) => html`<a href="/flows/machines/${enc(n)}"${n === def.name ? raw(' class="on"') : ''}>${n}</a>`)}</span>
    ${age(`flow ${ago(fl.at, now)}`)}
  </div>
</div>
${noteLine(fl.note, fl.failed, fl.at)}
${def.problem ? html`<p class="red">⚠ ${def.problem}: flow refuses this definition, so there is no machine to draw</p>` : null}
<p class="faint legend">
  <span class="lg"><svg width="14" height="14" aria-hidden="true"><circle class="entry" cx="7" cy="7" r="5"/></svg> starts here</span>
  <span class="lg"><span class="box term"></span> terminal</span>
  <span class="lg"><span class="box occ"></span> flows in it, with how many</span>
  <span class="lg">← a rule from many states, written on the state it reaches</span>
  <span class="lg">▸ the hook that runs on entry</span>
  <span class="lg">an arrow pointing up closes a cycle</span>
</p>
${graph ? html`<div class="scroll machine-wrap">${raw(graph)}</div>` : null}
<p class="faint"><code>${def.path}</code>${def.links && Object.keys(def.links).length ? html` · links: ${Object.entries(def.links).map(([k, v]) => html`<span class="tag">${k}${v.required ? '*' : ''}</span>`)}<span class="faint">(* required)</span>` : null}</p>
<h2 id="flows">flows of ${def.name}${state ? html` in <b>${state}</b> · <a href="${base}#flows">all states</a>` : null}</h2>
${table(
  html`<th>id</th><th>state</th><th>age</th><th>started</th><th>duration</th><th class="wide">links</th>`,
  rows.length
    ? rows.map(
        (f) =>
          html`<tr class="${f.terminal ? 'dim' : ''}"><td><a href="/flows/${enc(f.id)}" title="${f.id}">${f.id}</a></td><td>${f.state}</td><td>${inState(f, now)}</td><td>${since(f.startedAt, now)}</td><td>${flowDuration(f)}</td><td class="wide">${links(f.links)}</td></tr>`
      )
    : empty(6, state ? `no flows in ${state}` : 'no flows')
)}`
}

// ── pod ──

/** A job's state coloured by what it means: moving green, waiting yellow, gone wrong red, over dim. */
const JOB_CLASS: Record<string, string> = { running: 'ag-running', queued: 'ag-waiting', ok: 'ag-idle', failed: 'ag-failed', timeout: 'ag-failed', crashed: 'ag-failed', canceled: 'ag-idle', 'no result': 'ag-failed' }
const jobStateCell = (j: Job): Html => html`<span class="ag ${JOB_CLASS[jobState(j)] ?? ''}">${jobState(j)}</span>`

export function podPane(ctx: Ctx): Html {
  const { r, now } = ctx
  const p = r.pod
  const row = (j: Job): Html => html`<tr class="${j.place === 'done' && j.result?.status === 'ok' ? 'dim' : ''}">
<td><a href="/pod/${enc(j.name)}">${j.name}</a></td><td>${j.place}</td><td>${jobStateCell(j)}</td><td>${orDash(jobExit(j))}</td><td>${orDash(jobDuration(j))}</td>
<td>${jobStarted(j) ? clock(jobStarted(j), now) : '-'}</td><td>${orDash(jobWorker(j))}</td></tr>`
  const done = p.status ? countBy(Object.entries(p.status.queue.byStatus).flatMap(([k, n]) => Array<string>(n).fill(k))) : []
  return html`<div class="panehead">
  <h1>pod <span class="faint">── ${p.status ? html`${podUp(p.status) ? html`<span class="ok">●</span>` : html`<span class="warn">○</span>`} ${podSummary(p.status)} · ${queueText(p.status)}${done.length ? ` (${done.map(([s, n]) => `${s} ${n}`).join(' · ')})` : ''}` : `${p.jobs.length} jobs`}</span></h1>
  <div class="controls">${filterBox} ${age(`pod ${ago(p.at, now)}`)}</div>
</div>
${noteLine(p.note, p.failed, p.at)}
${p.status && !podUp(p.status) && p.jobs.some((j) => j.place === 'queued') ? html`<p class="warn">○ ${podSummary(p.status)}: the queued jobs wait for a container</p>` : null}
${table(
  html`<th>job</th><th>place</th><th>state</th><th>exit</th><th>took</th><th>started</th><th>worker</th>`,
  p.jobs.length ? p.jobs.map(row) : empty(7, p.at ? 'no jobs' : 'asking pod…')
)}`
}

export function jobPane(ctx: Ctx, j: Job, out: JobOutput | null, err: string): Html {
  const res = j.result
  const tail = (name: string, text: string | undefined): Html => html`<h2>${name} <span class="faint">last 40 lines · heai-pod show ${j.name}</span></h2><pre class="body">${text?.trim() ? text : '(empty)'}</pre>`
  return html`<p class="crumbs"><a href="/pod">← pod</a></p>
<h1>job ${j.name} ${jobStateCell(j)}</h1>
<table class="kv">
<tr><th>place</th><td>${j.place}</td></tr>
<tr><th>state</th><td>${jobState(j)}</td></tr>
${res ? html`<tr><th>exit</th><td>${res.exit}${res.signal ? ` · ${res.signal}` : ''}</td></tr>` : null}
${res?.error ? html`<tr><th>error</th><td class="red">${res.error}</td></tr>` : null}
<tr><th>started</th><td>${orDash(jobStarted(j))}</td></tr>
${res ? html`<tr><th>finished</th><td>${res.finished}</td></tr><tr><th>took</th><td>${jobDuration(j)}</td></tr>` : null}
<tr><th>worker</th><td>${orDash(jobWorker(j))}</td></tr>
<tr><th>path</th><td><code>${j.path}</code></td></tr>
</table>
${err ? html`<p class="warn">⚠ ${err}</p>` : null}
${tail('stdout', out?.stdout)}
${tail('stderr', out?.stderr)}`
}

// ── reactor ──

const resultClass = (a: { ok: boolean; outcome: Record<string, unknown> | null; error: string | null }): string =>
  actionFailed(a as never) ? 'red' : limited(a as never) ? 'warn' : 'ok'

export function reactorPane(ctx: Ctx): Html {
  const { r, now } = ctx
  const re = r.reactor
  const st = re.status
  const failedN = failedActions(re).length
  return html`<div class="panehead">
  <h1>reactor <span class="faint">── ${st ? html`${st.sources.length} sources${problems(st) ? html` <span class="warn">⚠ ${problems(st)}</span>` : null} · ${st.rules.length} rules · ` : null}${re.events.length} events in the last hour${failedN ? html` · <span class="red">${failedN} failed</span>` : null}</span></h1>
  <div class="controls">${filterBox} ${age(`reactor ${ago(re.at, now)}`)}</div>
</div>
${noteLine(re.note, re.failed, re.at)}
${st
  ? html`<h2>sources</h2>${table(
      html`<th>source</th><th>type</th><th>cadence</th><th>last</th><th>/1h</th><th class="wide">cursor</th>`,
      st.sources.map(
        (s) =>
          html`<tr><td>${problem(s) ? html`<span class="warn">○</span>` : html`<span class="ok">●</span>`} ${s.name}</td><td>${s.type}</td><td>${cadence(s)}</td><td>${s.lastEvent ? clock(s.lastEvent, now) : '-'}</td><td>${s.lastHour}</td><td class="wide">${problem(s) ? html`<span class="warn">⚠ ${problem(s)}</span>` : s.cursor}</td></tr>`
      )
    )}
<h2>rules</h2>${table(
      html`<th>rule</th><th class="wide">on</th><th>run</th><th>last</th><th>result</th>`,
      st.rules.map(
        (rule) =>
          html`<tr><td>${rule.name}</td><td class="wide">${rule.on}</td><td><code>${rule.run}</code></td><td>${rule.lastAction ? clock(rule.lastAction.at, now) : '-'}</td><td class="${rule.lastAction ? (actionFailed(rule.lastAction) ? 'red' : '') : 'faint'}">${ruleResult(rule)}${rule.pending ? html` <span class="faint">· debounce until ${clock(rule.pending.until, now)}</span>` : null}</td></tr>`
      )
    )}`
  : null}
<h2>events <span class="faint">newest first · heai-reactor events --since 1h</span></h2>
${table(
  html`<th>at</th><th>source</th><th>kind</th><th class="wide">key</th><th>rule → result</th>`,
  re.events.length
    ? re.events.map(
        (e) =>
          html`<tr><td><a href="/reactor/${enc(e.id)}">${clock(e.at, now)}</a></td><td>${e.source}</td><td>${e.kind}</td><td class="wide">${e.key}</td><td>${e.actions?.length ? e.actions.map((a, i) => html`${i ? ', ' : ''}${a.rule} → <span class="${resultClass(a)}">${actionResult(a)}</span>`) : html`<span class="faint">-</span>`}</td></tr>`
      )
    : empty(5, re.at ? 'no events in the last hour' : 'asking reactor…')
)}`
}

export function eventPane(ctx: Ctx, e: Event): Html {
  return html`<p class="crumbs"><a href="/reactor">← reactor</a></p>
<h1>${e.source} · ${e.kind} <span class="faint">${clock(e.at, ctx.now)}</span></h1>
<table class="kv">
<tr><th>id</th><td><code>${e.id}</code></td></tr>
<tr><th>source</th><td>${e.source}</td></tr>
<tr><th>kind</th><td>${e.kind}</td></tr>
<tr><th>key</th><td><code>${e.key}</code></td></tr>
<tr><th>at</th><td>${e.at}</td></tr>
</table>
<h2>actions</h2>
${table(
  html`<th>at</th><th>rule</th><th>action</th><th>result</th><th class="wide">command</th><th class="wide">log</th>`,
  e.actions?.length
    ? e.actions.map((a) => html`<tr><td>${clock(a.at, ctx.now)}</td><td>${a.rule}</td><td>${a.action}</td><td class="${resultClass(a)}">${actionResult(a)}</td><td class="wide"><code>${orDash(command(a))}</code></td><td class="wide"><code>${orDash(logPath(a))}</code></td></tr>`)
    : empty(6, 'no rule acted on it')
)}
<h2>payload</h2>
<pre class="body">${JSON.stringify(e.payload, null, 2)}</pre>`
}

export function missingPane(tab: Tab, what: string): Html {
  return html`<p class="crumbs"><a href="/${tab}">← ${tab}</a></p><h1>not found</h1><p class="faint">${what}</p>`
}

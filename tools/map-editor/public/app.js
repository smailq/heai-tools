// The architecture map editor.
//
// The map is the browser's: it arrives through the paste dialog, lives in
// localStorage while it is edited, and leaves through Export. The server is
// stateless - it validates, serializes, and lists the files under a
// repository's localPath, and holds nothing between requests.
//
// mode 'system': mapState (a plain object mirroring the schema) is the source
// of truth, rendered as a diagram + inspector, serialized on export.
// mode 'raw': the textarea is the source of truth - the fallback for YAML the
// system view cannot represent, such as a map that does not parse yet.

const STORE_KEY = 'heai-tools.map-editor.v1'

const statusEl = document.getElementById('status')
const storeNoteEl = document.getElementById('store-note')
const exportBtn = document.getElementById('export-btn')
const pasteBtn = document.getElementById('paste-btn')
const fileBtn = document.getElementById('file-btn')
const modeBtn = document.getElementById('mode-btn')
const problemList = document.getElementById('problem-list')
const problemsBar = document.getElementById('problems-bar')
const problemsToggle = document.getElementById('problems-toggle')
const problemsSummary = document.getElementById('problems-summary')
const problemsChevron = document.getElementById('problems-chevron')
const systemView = document.getElementById('system-view')
const rawEditor = document.getElementById('raw-editor')
const canvas = document.getElementById('canvas')
const canvasWrap = document.getElementById('canvas-wrap')
const inspector = document.getElementById('inspector')
const generalPage = document.getElementById('general-page')
const actorsPage = document.getElementById('actors-page')
const tabGeneral = document.getElementById('tab-general')
const tabActors = document.getElementById('tab-actors')
const tabTerritories = document.getElementById('tab-territories')
const addHumanBtn = document.getElementById('add-human-btn')
const addAgentBtn = document.getElementById('add-agent-btn')
const addRepoBtn = document.getElementById('add-repo-btn')
const addTerritoryBtn = document.getElementById('add-territory-btn')
const filetreeEl = document.getElementById('filetree')

const SVG_NS = 'http://www.w3.org/2000/svg'
const AGENT_COLORS = ['#2563eb', '#0d9488', '#7c3aed', '#db2777', '#ca8a04', '#0284c7', '#dc2626', '#4f46e5']
const HUMAN_COLOR = '#d97706'

let mode = 'system'
let mapState = null
let lastValidation = null
let debounceTimer = null
let selection = null // null | {type:'territory'|'actor', id}
// On the Actors tab a territory can be focused WITHIN the selected owner: the
// owner keeps the 1st-layer tree highlight, this territory gets the 2nd layer
// and the bottom editor.
let subTerritory = null
let editingField = null // key of the single inspector field currently in edit mode
let activeTab = 'territories' // 'general' | 'actors' | 'territories'
let lastChangeAt = null

// ── The browser-side store ──

function persist() {
  try {
    const payload =
      mode === 'raw'
        ? { yaml: rawEditor.value, map: null }
        : { yaml: null, map: mapState ? normalizedMap() : null }
    payload.updatedAt = new Date().toISOString()
    localStorage.setItem(STORE_KEY, JSON.stringify(payload))
    lastChangeAt = payload.updatedAt
  } catch {
    // A browser with storage disabled still edits fine; it just forgets.
    lastChangeAt = new Date().toISOString()
  }
  renderStoreNote()
}

function readStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function renderStoreNote() {
  if (!mapState && mode === 'system' && !rawEditor.value) {
    storeNoteEl.textContent = 'nothing loaded — paste a map to begin'
    return
  }
  const at = lastChangeAt ? new Date(lastChangeAt) : null
  storeNoteEl.textContent =
    'held in this browser' + (at ? ` · last change ${at.toLocaleTimeString()}` : '')
}

function emptyMap() {
  return { version: 1, actors: {}, repositories: {}, territories: {} }
}

function normalizedMap() {
  const map = JSON.parse(JSON.stringify(mapState))
  const dropEmpty = (obj, key) => {
    const v = obj[key]
    if (v === undefined) return
    if (v === '' || (Array.isArray(v) && v.length === 0)) delete obj[key]
    else if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) delete obj[key]
  }
  for (const actor of Object.values(map.actors ?? {})) {
    dropEmpty(actor, 'identity')
    dropEmpty(actor, 'context')
  }
  for (const repo of Object.values(map.repositories ?? {})) {
    dropEmpty(repo, 'remotePath')
    dropEmpty(repo, 'localPath')
  }
  for (const territory of Object.values(map.territories ?? {})) {
    dropEmpty(territory, 'context')
    dropEmpty(territory, 'dependsOn')
    for (const entry of territory.scope ?? []) {
      if (entry.exclude) {
        dropEmpty(entry.exclude, 'globs')
        dropEmpty(entry.exclude, 'territories')
        dropEmpty(entry, 'exclude')
      }
    }
  }
  return map
}

function actorType(name) {
  return mapState && mapState.actors[name] ? mapState.actors[name].type : null
}

function isHumanOwner(owner) {
  return actorType(owner) === 'human'
}

function ownerColor(owner) {
  if (!mapState || !mapState.actors[owner]) return 'var(--muted)'
  if (isHumanOwner(owner)) return HUMAN_COLOR
  const agents = Object.keys(mapState.actors).filter((n) => !isHumanOwner(n))
  const i = agents.indexOf(owner)
  return i >= 0 ? AGENT_COLORS[i % AGENT_COLORS.length] : 'var(--muted)'
}

function setStatus(text, cls) {
  statusEl.textContent = text
  statusEl.className = 'status ' + (cls || '')
}

// ── Problems bar ──

let problemsExpanded = false

function syncProblemsExpansion() {
  problemList.hidden = !problemsExpanded
  problemsChevron.textContent = problemsExpanded ? '▾' : '▸'
}

function renderProblems(validation) {
  problemList.innerHTML = ''
  const errors = validation ? validation.errors : []
  const warnings = validation ? validation.warnings : []
  if (errors.length === 0 && warnings.length === 0) {
    problemsBar.hidden = true
    problemsExpanded = false
    syncProblemsExpansion()
    return
  }
  const add = (text, cls) => {
    const li = document.createElement('li')
    li.textContent = text
    li.className = cls
    problemList.appendChild(li)
  }
  errors.forEach((e) => add(e, 'err'))
  warnings.forEach((w) => add(w, 'warn'))
  const parts = []
  if (errors.length > 0) parts.push(`${errors.length} error${errors.length === 1 ? '' : 's'}`)
  if (warnings.length > 0) parts.push(`${warnings.length} warning${warnings.length === 1 ? '' : 's'}`)
  problemsSummary.textContent = parts.join(' · ')
  problemsBar.className = errors.length > 0 ? 'err' : 'warn'
  problemsBar.hidden = false
  syncProblemsExpansion()
}

problemsToggle.addEventListener('click', () => {
  problemsExpanded = !problemsExpanded
  syncProblemsExpansion()
})

function applyValidation(validation) {
  lastValidation = validation
  renderProblems(validation)
  if (!validation) setStatus('', '')
  else if (!validation.valid) setStatus('Invalid', 'err')
  else if (validation.warnings.length > 0) setStatus('Valid (warnings)', 'warn')
  else setStatus('Valid', 'ok')
  updateButtons()
}

function updateButtons() {
  const hasContent = mode === 'raw' ? rawEditor.value.trim() !== '' : mapState !== null
  exportBtn.disabled = !hasContent
  modeBtn.disabled = !hasContent && mode === 'system'
  modeBtn.textContent = mode === 'system' ? 'Raw YAML' : 'System view'
}

async function validateNow() {
  if (mode === 'system' && !mapState) {
    applyValidation(null)
    return
  }
  const body = mode === 'raw' ? { yaml: rawEditor.value } : { map: normalizedMap() }
  const res = await fetch('api/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  applyValidation(await res.json())
}

function scheduleValidate() {
  updateButtons()
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(validateNow, 400)
}

// ── Small helpers ──

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v)
  return node
}

function btn(label, onclick, className) {
  const b = el('button', className || 'i-btn', label)
  b.type = 'button'
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    onclick()
  })
  return b
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function words(value) {
  return value.split(/[\s,]+/).filter(Boolean)
}

// Rename a key in an object while preserving insertion order.
function renameKey(obj, oldKey, newKey) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) out[k === oldKey ? newKey : k] = v
  return out
}

function select(sel) {
  selection = sel
  subTerritory = null
  editingField = null
  if (sel && sel.type === 'territory') activeTab = 'territories'
  else if (sel && sel.type === 'actor') activeTab = 'actors'
  renderAll()
}

// Focus an owner AND one of their territories (Actors tab): the owner keeps the
// 1st-layer highlight, the territory gets the 2nd layer plus the editor.
function selectOwnerAndTerritory(tName) {
  const territory = mapState.territories[tName]
  const owner = territory && territory.owner
  if (!owner || !mapState.actors[owner]) return select({ type: 'territory', id: tName })
  selection = { type: 'actor', id: owner }
  subTerritory = tName
  editingField = null
  activeTab = 'actors'
  renderAll()
}

/** Re-render, re-validate, and write the change through to the browser store. */
function refresh() {
  renderAll()
  scheduleValidate()
  persist()
}

// ── Tabs ──

function setTab(tab) {
  if (tab !== activeTab) {
    // Leaving a tab abandons whatever was selected on it.
    selection = null
    subTerritory = null
    editingField = null
  }
  activeTab = tab
  renderAll()
}

function syncTabs() {
  tabGeneral.classList.toggle('active', activeTab === 'general')
  tabActors.classList.toggle('active', activeTab === 'actors')
  tabTerritories.classList.toggle('active', activeTab === 'territories')
  generalPage.hidden = activeTab !== 'general'
  actorsPage.hidden = activeTab !== 'actors'
  canvasWrap.hidden = activeTab !== 'territories'
  // The General tab edits in place; the bottom inspector serves the other tabs.
  inspector.hidden = activeTab === 'general'
  addHumanBtn.hidden = activeTab !== 'actors' || !mapState
  addAgentBtn.hidden = activeTab !== 'actors' || !mapState
  addTerritoryBtn.hidden = activeTab !== 'territories' || !mapState
}

tabGeneral.addEventListener('click', () => setTab('general'))
tabActors.addEventListener('click', () => setTab('actors'))
tabTerritories.addEventListener('click', () => setTab('territories'))

// ── General page: map-wide settings, edited in place ──

function postureGroup(label, current, options, hint, apply) {
  const wrap = el('div', 'i-group')
  wrap.appendChild(el('span', 'i-label', label))
  const body = el('div', 'i-group-body')
  body.appendChild(choiceSelect(current, options, apply))
  wrap.appendChild(body)
  const section = document.createDocumentFragment()
  section.appendChild(wrap)
  section.appendChild(el('p', 'i-hint', hint))
  return section
}

function renderGeneral() {
  generalPage.innerHTML = ''
  if (!mapState) return
  const section = el('div', 'res-section')

  const versionWrap = el('div', 'i-group')
  versionWrap.appendChild(el('span', 'i-label', 'schema version'))
  versionWrap.appendChild(el('div', 'i-value mono', String(mapState.version)))
  section.appendChild(versionWrap)

  section.appendChild(
    postureGroup(
      'unowned paths',
      mapState.unowned || 'fail',
      [
        ['fail', 'fail - every path must belong to a territory'],
        ['allow', 'allow - partial map, unowned paths are legal']
      ],
      'Posture for paths no territory claims. Allowing them lets a repository adopt the map one territory at a time; each repository can override it from its ⋯ → Edit dialog.',
      (v) => {
        if (v === 'fail') delete mapState.unowned
        else mapState.unowned = v
        refresh()
      }
    )
  )

  section.appendChild(
    postureGroup(
      'undeclared dependencies',
      mapState.undeclaredDependencies || 'fail',
      [
        ['fail', 'fail - the declared graph and the code stay in lockstep'],
        ['warn', 'warn - advisory, for a codebase the map does not yet describe']
      ],
      'Posture for a dependency the code takes that the importing territory does not declare. A repository or a single territory can override it.',
      (v) => {
        if (v === 'fail') delete mapState.undeclaredDependencies
        else mapState.undeclaredDependencies = v
        refresh()
      }
    )
  )

  generalPage.appendChild(section)
}

// ── Actors page ──

actorsPage.addEventListener('click', () => select(null))

// A small territory node (owner-colored bar + name + globs). On this tab a
// click focuses the owner (1st layer) and the territory itself (2nd layer +
// bottom editor) without leaving the tab.
function territoryNodeButton(tName) {
  const t = mapState.territories[tName]
  const node = el('button', 't-node' + (subTerritory === tName ? ' selected' : ''))
  node.type = 'button'
  const bar = el('span', 't-node-bar')
  bar.style.background = ownerColor(t.owner)
  node.appendChild(bar)
  const body = el('span', 't-node-body')
  body.appendChild(el('span', 't-node-name', tName))
  const globs = (t.scope || []).flatMap((s) => s.globs || [])
  body.appendChild(el('span', 't-node-sub', truncate(globs.join(' '), 36) || '(no globs)'))
  node.appendChild(body)
  node.addEventListener('click', (e) => {
    e.stopPropagation()
    selectOwnerAndTerritory(tName)
  })
  return node
}

function appendOwnerCard(grid, card, owned) {
  if (owned.length > 0) {
    const row = el('div', 'res-row')
    row.appendChild(card)
    row.appendChild(el('span', 'res-arrow', '→'))
    const nodes = el('div', 'res-row-nodes')
    for (const tn of owned) nodes.appendChild(territoryNodeButton(tn))
    row.appendChild(nodes)
    grid.appendChild(row)
  } else {
    grid.appendChild(card)
  }
}

function territoriesOwnedBy(name) {
  return Object.entries(mapState.territories)
    .filter(([, t]) => t.owner === name)
    .map(([n]) => n)
}

function renderActorsPage() {
  actorsPage.innerHTML = ''
  if (!mapState) return
  const groups = [
    ['llm-agent', 'Agents', 'No llm-agents declared yet.'],
    ['human', 'Humans', 'No humans declared yet - the map should fall inside a territory one of them owns.']
  ]
  for (const [type, heading, empty] of groups) {
    const section = el('div', 'res-section')
    section.appendChild(el('h2', '', heading))
    const grid = el('div', 'res-grid')
    const names = Object.keys(mapState.actors).filter((n) => mapState.actors[n].type === type)
    for (const name of names) {
      const actor = mapState.actors[name]
      const owned = territoriesOwnedBy(name)
      const card = el('button', 'res-card' + (selection && selection.type === 'actor' && selection.id === name ? ' selected' : ''))
      card.type = 'button'
      card.addEventListener('click', (e) => {
        e.stopPropagation()
        select({ type: 'actor', id: name })
      })
      const title = el('span', 'res-title')
      const dot = el('span', 'chip-dot')
      dot.style.background = ownerColor(name)
      title.appendChild(dot)
      title.appendChild(document.createTextNode(name))
      card.appendChild(title)
      if (actor.identity) card.appendChild(el('span', 'res-sub mono', actor.identity))
      if (actor.context) card.appendChild(el('span', 'res-sub', truncate(actor.context.trim().split('\n')[0], 90)))
      card.appendChild(
        el('span', 'res-meta', owned.length > 0 ? `owns: ${owned.join(', ')}` : 'owns no territory')
      )
      appendOwnerCard(grid, card, owned)
    }
    if (names.length === 0) grid.appendChild(el('p', 'i-hint', empty))
    section.appendChild(grid)
    actorsPage.appendChild(section)
  }
}

function uniqueName(existing, base) {
  let n = base
  for (let i = 2; existing[n]; i++) n = `${base}-${i}`
  return n
}

function addActor(type) {
  if (!mapState) return
  const name = uniqueName(mapState.actors, type === 'human' ? 'new-human' : 'new-agent')
  mapState.actors[name] = type === 'human' ? { type, identity: '' } : { type, context: '' }
  select({ type: 'actor', id: name })
  editingField = 'name'
  renderInspector()
  scheduleValidate()
  persist()
}

addHumanBtn.addEventListener('click', () => addActor('human'))
addAgentBtn.addEventListener('click', () => addActor('llm-agent'))
addRepoBtn.addEventListener('click', () => openRepoModal(null))

addTerritoryBtn.addEventListener('click', () => {
  if (!mapState) return
  const name = uniqueName(mapState.territories, 'new-territory')
  const defaultOwner = Object.keys(mapState.actors)[0] || ''
  mapState.territories[name] = {
    owner: defaultOwner,
    scope: [{ repository: Object.keys(mapState.repositories)[0] || '', globs: [] }]
  }
  select({ type: 'territory', id: name })
  editingField = 'name'
  renderInspector()
  scheduleValidate()
  persist()
})

// ── Canvas: repositories as containers, territories as nodes, edges as arrows ──

const NODE_H = 52
const NODE_GAP = 10
const REPO_HEAD = 40
const REPO_PAD = 12
const COL_GAP = 56
const CANVAS_PAD = 24

function renderCanvas() {
  canvas.innerHTML = ''
  if (!mapState) {
    const label = svgEl('text', { x: CANVAS_PAD, y: 44, class: 'canvas-empty' })
    label.textContent = 'No map loaded — paste one in to draw the system.'
    canvas.appendChild(label)
    canvas.setAttribute('width', 600)
    canvas.setAttribute('height', 80)
    return
  }
  const repoNames = Object.keys(mapState.repositories)

  const defs = svgEl('defs')
  const marker = svgEl('marker', {
    id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5,
    markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse'
  })
  marker.appendChild(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'edge-arrow' }))
  defs.appendChild(marker)
  canvas.appendChild(defs)

  if (repoNames.length === 0) {
    const label = svgEl('text', { x: CANVAS_PAD, y: 44, class: 'canvas-empty' })
    label.textContent = 'Add a repository, then territories, to draw the system.'
    canvas.appendChild(label)
    canvas.setAttribute('width', 600)
    canvas.setAttribute('height', 80)
    return
  }

  const availW = Math.max(canvasWrap.clientWidth - 2 * CANVAS_PAD, 260)
  const colW = Math.max(220, Math.min(300, Math.floor(availW / repoNames.length) - COL_GAP))

  // Territories grouped per repo (a territory appears in every repo it scopes).
  const perRepo = new Map(repoNames.map((r) => [r, []]))
  for (const [tName, t] of Object.entries(mapState.territories)) {
    const seen = new Set()
    for (const entry of t.scope || []) {
      if (perRepo.has(entry.repository) && !seen.has(entry.repository)) {
        perRepo.get(entry.repository).push(tName)
        seen.add(entry.repository)
      }
    }
  }

  const nodeAnchor = new Map() // territory -> {x, y, w, h} of its first-drawn node
  let maxBottom = 0

  repoNames.forEach((repoName, col) => {
    const x = CANVAS_PAD + col * (colW + COL_GAP)
    const y = CANVAS_PAD
    const members = perRepo.get(repoName)
    const boxH = REPO_HEAD + REPO_PAD + Math.max(members.length, 1) * (NODE_H + NODE_GAP)
    maxBottom = Math.max(maxBottom, y + boxH)

    const g = svgEl('g', { class: 'repo-box' })
    g.appendChild(svgEl('rect', { x, y, width: colW, height: boxH, rx: 12, class: 'repo-rect' }))
    const head = svgEl('text', { x: x + 14, y: y + 24, class: 'repo-name' })
    head.textContent = repoName
    g.appendChild(head)
    const sub = svgEl('text', { x: x + 14, y: y + REPO_HEAD - 4, class: 'repo-sub' })
    const repo = mapState.repositories[repoName]
    sub.textContent = truncate(repo.remotePath || repo.localPath || '(no path)', 34)
    g.appendChild(sub)
    canvas.appendChild(g)

    members.forEach((tName, row) => {
      const t = mapState.territories[tName]
      const nx = x + REPO_PAD
      const ny = y + REPO_HEAD + REPO_PAD + row * (NODE_H + NODE_GAP)
      const nw = colW - 2 * REPO_PAD
      const isSel = selection && selection.type === 'territory' && selection.id === tName
      const node = svgEl('g', { class: 'territory-node' + (isSel ? ' selected' : '') })
      node.appendChild(svgEl('rect', { x: nx, y: ny, width: nw, height: NODE_H, rx: 8, class: 'node-rect' }))
      node.appendChild(svgEl('rect', { x: nx, y: ny, width: 5, height: NODE_H, rx: 2.5, fill: ownerColor(t.owner) }))
      const nameText = svgEl('text', { x: nx + 14, y: ny + 21, class: 'node-name' })
      const spans = new Set((t.scope || []).map((s) => s.repository)).size > 1
      nameText.textContent = truncate(tName, 22) + (spans ? ' ⧉' : '')
      node.appendChild(nameText)
      const ownerText = svgEl('text', { x: nx + 14, y: ny + 39, class: 'node-owner' })
      ownerText.setAttribute('fill', ownerColor(t.owner))
      ownerText.textContent = t.owner
      node.appendChild(ownerText)
      node.addEventListener('click', (e) => {
        e.stopPropagation()
        select({ type: 'territory', id: tName })
      })
      canvas.appendChild(node)
      if (!nodeAnchor.has(tName)) nodeAnchor.set(tName, { x: nx, y: ny, w: nw, h: NODE_H })
    })
  })

  // Edges: from → to (from depends on to).
  for (const [from, t] of Object.entries(mapState.territories)) {
    for (const to of t.dependsOn || []) {
      const a = nodeAnchor.get(from)
      const b = nodeAnchor.get(to)
      if (!a || !b) continue
      let d
      if (Math.abs(a.x - b.x) < 1) {
        // Same column: loop out to the left of the repo box.
        const sx = a.x
        const sy = a.y + a.h / 2
        const tx = b.x
        const ty = b.y + b.h / 2
        const bulge = 34 + Math.abs(sy - ty) * 0.08
        d = `M ${sx} ${sy} C ${sx - bulge} ${sy}, ${tx - bulge} ${ty}, ${tx} ${ty}`
      } else {
        const leftToRight = a.x < b.x
        const sx = leftToRight ? a.x + a.w : a.x
        const sy = a.y + a.h / 2
        const tx = leftToRight ? b.x : b.x + b.w
        const ty = b.y + b.h / 2
        const dx = Math.max(28, Math.abs(tx - sx) / 3) * (leftToRight ? 1 : -1)
        d = `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`
      }
      canvas.appendChild(svgEl('path', { d, class: 'edge', 'marker-end': 'url(#arrow)' }))
    }
  }

  const totalW = CANVAS_PAD * 2 + repoNames.length * colW + (repoNames.length - 1) * COL_GAP
  canvas.setAttribute('width', Math.max(totalW, canvasWrap.clientWidth - 2))
  canvas.setAttribute('height', maxBottom + CANVAS_PAD)
}

canvasWrap.addEventListener('click', () => select(null))

// ── Inspector: edits ONE field at a time ──

function fieldRow({ key, label, value, commit, multiline, mono, placeholder }) {
  // Labeled fields stack label-above-value for the narrow sidebar; label-less
  // fields (list items) stay inline.
  const row = el('div', 'i-field' + (label ? '' : ' inline'))
  if (editingField === key) {
    const input = multiline ? el('textarea', 'i-input i-textarea') : el('input', 'i-input')
    if (!multiline) input.type = 'text'
    if (multiline) input.rows = 6
    input.value = value ?? ''
    input.placeholder = placeholder || ''
    input.spellcheck = false
    const ok = btn('✓', () => {
      commit(input.value)
      editingField = null
      refresh()
    }, 'i-btn i-ok')
    const cancel = btn('✕', () => {
      editingField = null
      renderEditors()
    }, 'i-btn')
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !multiline) {
        e.preventDefault()
        ok.click()
      } else if (e.key === 'Escape') {
        cancel.click()
      }
    })
    if (label) {
      const head = el('div', 'i-field-head')
      head.appendChild(el('span', 'i-label', label))
      const btns = el('div', 'i-edit-btns')
      btns.appendChild(ok)
      btns.appendChild(cancel)
      head.appendChild(btns)
      row.appendChild(head)
      row.appendChild(input)
    } else {
      row.appendChild(input)
      row.appendChild(ok)
      row.appendChild(cancel)
    }
    row.classList.add('editing')
    setTimeout(() => input.focus(), 0)
  } else {
    const valEl = el('div', 'i-value' + (mono ? ' mono' : '') + (value ? '' : ' empty'))
    valEl.textContent = value || placeholder || '—'
    const edit = btn('✎', () => {
      editingField = key
      renderEditors()
    }, 'i-btn')
    if (label) {
      const head = el('div', 'i-field-head')
      head.appendChild(el('span', 'i-label', label))
      head.appendChild(edit)
      row.appendChild(head)
      row.appendChild(valEl)
    } else {
      row.appendChild(valEl)
      row.appendChild(edit)
    }
    row.addEventListener('dblclick', () => edit.click())
  }
  return row
}

function inspectorHeader(kind, title, color, onDelete) {
  const head = el('div', 'i-head')
  if (color) {
    const dot = el('span', 'chip-dot')
    dot.style.background = color
    head.appendChild(dot)
  }
  head.appendChild(el('span', 'i-kind', kind))
  head.appendChild(el('span', 'i-title', title))
  if (onDelete) {
    const del = btn('Delete', onDelete, 'i-btn i-danger')
    del.style.marginLeft = 'auto'
    head.appendChild(del)
  }
  return head
}

// Re-render every surface that hosts one-field-at-a-time editors.
function renderEditors() {
  renderInspector()
  renderGeneral()
}

function renderInspector() {
  inspector.innerHTML = ''
  if (!mapState) return
  if (subTerritory && mapState.territories[subTerritory]) {
    return renderTerritoryInspector(subTerritory)
  }
  if (!selection) {
    inspector.appendChild(
      el('p', 'i-hint', 'Select an actor or a territory to inspect and edit it — one field at a time.')
    )
    return
  }
  if (selection.type === 'actor') renderActorInspector(selection.id)
  else if (selection.type === 'territory') renderTerritoryInspector(selection.id)
}

function choiceSelect(value, options, onchange) {
  const node = el('select', 'i-select')
  for (const [optValue, label] of options) {
    const opt = el('option', '', label)
    opt.value = optValue
    if (optValue === value) opt.selected = true
    node.appendChild(opt)
  }
  node.addEventListener('click', (e) => e.stopPropagation())
  node.addEventListener('change', () => onchange(node.value))
  return node
}

function repoSelect(value, onchange) {
  const names = Object.keys(mapState.repositories)
  if (!names.includes(value)) names.unshift(value || '')
  return choiceSelect(
    value,
    names.map((name) => [name, name || '(pick repository)']),
    onchange
  )
}

function ownsGroup(name) {
  const owned = territoriesOwnedBy(name)
  const wrap = el('div', 'i-group')
  wrap.appendChild(el('span', 'i-label', 'owns'))
  const body = el('div', 'i-group-body i-chips')
  if (owned.length === 0) body.appendChild(el('span', 'i-hint', 'no territories yet'))
  for (const n of owned) {
    const chip = el('button', 'chip')
    chip.type = 'button'
    const dot = el('span', 'chip-dot')
    dot.style.background = ownerColor(name)
    chip.appendChild(dot)
    chip.appendChild(el('span', '', n))
    chip.addEventListener('click', (e) => {
      e.stopPropagation()
      select({ type: 'territory', id: n })
    })
    body.appendChild(chip)
  }
  wrap.appendChild(body)
  return wrap
}

function renderActorInspector(name) {
  const actor = mapState.actors[name]
  if (!actor) return select(null)
  inspector.appendChild(
    inspectorHeader(actor.type, name, ownerColor(name), () => {
      delete mapState.actors[name]
      select(null)
      scheduleValidate()
      persist()
    })
  )
  inspector.appendChild(
    fieldRow({
      key: 'name', label: 'name', value: name, mono: true,
      commit: (v) => {
        const next = v.trim()
        if (!next || next === name) return
        mapState.actors = renameKey(mapState.actors, name, next)
        for (const t of Object.values(mapState.territories)) if (t.owner === name) t.owner = next
        selection = { type: 'actor', id: next }
      }
    })
  )

  const typeRow = el('div', 'i-field')
  typeRow.appendChild(el('span', 'i-label', 'type'))
  typeRow.appendChild(
    choiceSelect(
      actor.type,
      [
        ['llm-agent', 'llm-agent - works inside the territories it owns'],
        ['human', 'human - accountable for the territories they own']
      ],
      (v) => {
        actor.type = v
        // The schema requires an identity of a human and a context of an agent:
        // materialize the field so the inspector can edit it in place.
        if (v === 'human' && actor.identity === undefined) actor.identity = ''
        if (v === 'llm-agent' && actor.context === undefined) actor.context = ''
        refresh()
      }
    )
  )
  inspector.appendChild(typeRow)

  inspector.appendChild(
    fieldRow({
      key: 'identity', label: 'identity', value: actor.identity, mono: true,
      placeholder: actor.type === 'human'
        ? '@handle or email — whatever the surrounding tooling resolves'
        : 'optional — only where this actor acts under an account of its own',
      commit: (v) => (actor.identity = v.trim())
    })
  )
  inspector.appendChild(
    fieldRow({
      key: 'context', label: 'context', value: actor.context, multiline: true, mono: true,
      placeholder: actor.type === 'llm-agent'
        ? 'Role, focus, and standing guidance across every territory this agent owns.'
        : 'Optional annotation.',
      commit: (v) => (actor.context = v)
    })
  )
  inspector.appendChild(ownsGroup(name))
  if (actor.type === 'human') {
    inspector.appendChild(
      el('p', 'i-hint', 'A human-owned territory is where the paths that govern what agents may do belong — CI, guard tooling, repo-wide docs, and the map itself.')
    )
  }
}

function scopeEntryEditor(t, name, entry, i) {
  const box = el('div', 'i-entry')
  const head = el('div', 'i-entry-head')
  head.appendChild(repoSelect(entry.repository, (v) => {
    entry.repository = v
    refresh()
  }))
  const spacer = el('span', '')
  spacer.style.flex = '1'
  head.appendChild(spacer)
  head.appendChild(btn('✕', () => {
    t.scope.splice(i, 1)
    refresh()
  }, 'i-btn i-danger'))
  box.appendChild(head)

  box.appendChild(
    fieldRow({
      key: `scope-${i}`, label: 'globs', value: (entry.globs || []).join(' '), mono: true,
      placeholder: 'src/** docs/**',
      commit: (v) => (entry.globs = words(v))
    })
  )

  box.appendChild(
    fieldRow({
      key: `exclude-globs-${i}`, label: 'exclude globs', value: (entry.exclude?.globs || []).join(' '), mono: true,
      placeholder: 'patterns this entry subtracts from its own globs',
      commit: (v) => {
        const globs = words(v)
        if (globs.length === 0) {
          if (entry.exclude) delete entry.exclude.globs
        } else {
          entry.exclude = entry.exclude || {}
          entry.exclude.globs = globs
        }
        if (entry.exclude && Object.keys(entry.exclude).length === 0) delete entry.exclude
      }
    })
  )

  const others = Object.keys(mapState.territories).filter((n) => n !== name)
  if (others.length > 0) {
    const wrap = el('div', 'i-group')
    wrap.appendChild(el('span', 'i-sublabel', 'exclude territories'))
    const body = el('div', 'i-group-body i-chips')
    for (const other of others) {
      const current = entry.exclude?.territories || []
      const active = current.includes(other)
      const chip = el('button', 'chip dep' + (active ? ' selected' : ''))
      chip.type = 'button'
      const dot = el('span', 'chip-dot')
      dot.style.background = ownerColor(mapState.territories[other].owner)
      chip.appendChild(dot)
      chip.appendChild(el('span', '', other))
      chip.addEventListener('click', (e) => {
        e.stopPropagation()
        const next = active ? current.filter((x) => x !== other) : [...current, other]
        if (next.length === 0) {
          if (entry.exclude) delete entry.exclude.territories
        } else {
          entry.exclude = entry.exclude || {}
          entry.exclude.territories = next
        }
        if (entry.exclude && Object.keys(entry.exclude).length === 0) delete entry.exclude
        refresh()
      })
      body.appendChild(chip)
    }
    wrap.appendChild(body)
    box.appendChild(wrap)
  }
  return box
}

function renderTerritoryInspector(name) {
  const t = mapState.territories[name]
  if (!t) return select(null)
  inspector.appendChild(
    inspectorHeader('territory', name, ownerColor(t.owner), () => {
      delete mapState.territories[name]
      for (const other of Object.values(mapState.territories)) {
        if (other.dependsOn) {
          other.dependsOn = other.dependsOn.filter((x) => x !== name)
          if (other.dependsOn.length === 0) delete other.dependsOn
        }
        for (const entry of other.scope || []) {
          if (!entry.exclude?.territories) continue
          entry.exclude.territories = entry.exclude.territories.filter((x) => x !== name)
          if (entry.exclude.territories.length === 0) delete entry.exclude.territories
          if (Object.keys(entry.exclude).length === 0) delete entry.exclude
        }
      }
      if (subTerritory === name) {
        subTerritory = null
        refresh()
      } else {
        select(null)
        scheduleValidate()
        persist()
      }
    })
  )
  inspector.appendChild(
    fieldRow({
      key: 'name', label: 'name', value: name, mono: true,
      commit: (v) => {
        const next = v.trim()
        if (!next || next === name) return
        mapState.territories = renameKey(mapState.territories, name, next)
        for (const other of Object.values(mapState.territories)) {
          if (other.dependsOn) other.dependsOn = other.dependsOn.map((x) => (x === name ? next : x))
          for (const entry of other.scope || []) {
            if (!entry.exclude?.territories) continue
            entry.exclude.territories = entry.exclude.territories.map((x) => (x === name ? next : x))
          }
        }
        if (subTerritory === name) subTerritory = next
        else selection = { type: 'territory', id: next }
      }
    })
  )

  // Owner: a select commits immediately (still one decision at a time).
  const ownerRow = el('div', 'i-field')
  ownerRow.appendChild(el('span', 'i-label', 'owner'))
  const ownerSel = el('select', 'i-select')
  const addOption = (parent, value, label) => {
    const opt = el('option', '', label ?? value)
    opt.value = value
    if (value === t.owner) opt.selected = true
    parent.appendChild(opt)
  }
  if (!mapState.actors[t.owner]) addOption(ownerSel, t.owner || '', t.owner || '(pick owner)')
  for (const [type, label] of [['llm-agent', 'llm-agents'], ['human', 'humans']]) {
    const names = Object.keys(mapState.actors).filter((n) => mapState.actors[n].type === type)
    if (names.length === 0) continue
    const group = el('optgroup')
    group.label = label
    for (const n of names) addOption(group, n)
    ownerSel.appendChild(group)
  }
  ownerSel.style.borderLeft = `4px solid ${ownerColor(t.owner)}`
  ownerSel.addEventListener('click', (e) => e.stopPropagation())
  ownerSel.addEventListener('change', () => {
    t.owner = ownerSel.value
    refresh()
  })
  ownerRow.appendChild(ownerSel)
  inspector.appendChild(ownerRow)

  const scopeWrap = el('div', 'i-group')
  scopeWrap.appendChild(el('span', 'i-label', 'scope'))
  const scopeBody = el('div', 'i-group-body')
  if (!t.scope) t.scope = []
  t.scope.forEach((entry, i) => scopeBody.appendChild(scopeEntryEditor(t, name, entry, i)))
  scopeBody.appendChild(btn('+ scope entry', () => {
    t.scope.push({ repository: Object.keys(mapState.repositories)[0] || '', globs: [] })
    editingField = `scope-${t.scope.length - 1}`
    refresh()
  }, 'i-btn i-add'))
  scopeWrap.appendChild(scopeBody)
  inspector.appendChild(scopeWrap)

  inspector.appendChild(
    fieldRow({
      key: 'context', label: 'context', value: t.context, multiline: true, mono: true,
      placeholder: 'Invariants, review discipline, and background needed to work in and review this territory.',
      commit: (v) => {
        if (v.trim() === '') delete t.context
        else t.context = v
      }
    })
  )

  // Depends-on: checkbox chips commit immediately.
  const others = Object.keys(mapState.territories).filter((n) => n !== name)
  if (others.length > 0) {
    const depWrap = el('div', 'i-group')
    depWrap.appendChild(el('span', 'i-label', 'depends on'))
    const depBody = el('div', 'i-group-body i-chips')
    for (const other of others) {
      const current = t.dependsOn || []
      const active = current.includes(other)
      const chip = el('button', 'chip dep' + (active ? ' selected' : ''))
      chip.type = 'button'
      const dot = el('span', 'chip-dot')
      dot.style.background = ownerColor(mapState.territories[other].owner)
      chip.appendChild(dot)
      chip.appendChild(el('span', '', other))
      chip.addEventListener('click', (e) => {
        e.stopPropagation()
        t.dependsOn = active ? current.filter((x) => x !== other) : [...current, other]
        if (t.dependsOn.length === 0) delete t.dependsOn
        refresh()
      })
      depBody.appendChild(chip)
    }
    depWrap.appendChild(depBody)
    inspector.appendChild(depWrap)
    inspector.appendChild(
      el('p', 'i-hint', 'Edges are direct and do not compose: naming B does not grant what B depends on. The whole graph must stay acyclic.')
    )
  }

  const undeclaredRow = el('div', 'i-field')
  undeclaredRow.appendChild(el('span', 'i-label', 'undeclared dependencies'))
  undeclaredRow.appendChild(
    choiceSelect(
      t.undeclaredDependencies || '',
      [
        ['', `inherit (${mapState.undeclaredDependencies || 'fail'})`],
        ['fail', 'fail'],
        ['warn', 'warn - advisory for this territory only']
      ],
      (v) => {
        if (v) t.undeclaredDependencies = v
        else delete t.undeclaredDependencies
        refresh()
      }
    )
  )
  inspector.appendChild(undeclaredRow)
}

inspector.addEventListener('click', (e) => e.stopPropagation())

// ── Repository edit modal (opened from the Repositories panel's ⋯ menu) ──

const modalBackdrop = document.getElementById('modal-backdrop')
const rmTitle = document.getElementById('repo-modal-title')
const rmName = document.getElementById('rm-name')
const rmRemote = document.getElementById('rm-remote')
const rmLocal = document.getElementById('rm-local')
const rmUnowned = document.getElementById('rm-unowned')
const rmUndeclared = document.getElementById('rm-undeclared')
const rmError = document.getElementById('rm-error')
let modalRepo = null // repository being edited, or null when creating

function openRepoModal(name) {
  if (!mapState) return
  modalRepo = name
  rmTitle.textContent = name ? `Edit repository — ${name}` : 'Add repository'
  const repo = name ? mapState.repositories[name] : null
  rmName.value = name || ''
  rmRemote.value = repo?.remotePath || ''
  rmLocal.value = repo?.localPath || ''
  rmUnowned.options[0].textContent = `inherit from map (${mapState.unowned || 'fail'})`
  rmUnowned.value = repo?.unowned || ''
  rmUndeclared.options[0].textContent = `inherit from map (${mapState.undeclaredDependencies || 'fail'})`
  rmUndeclared.value = repo?.undeclaredDependencies || ''
  rmError.textContent = ''
  modalBackdrop.hidden = false
  rmName.focus()
}

function closeRepoModal() {
  modalBackdrop.hidden = true
  modalRepo = null
}

document.getElementById('rm-cancel').addEventListener('click', closeRepoModal)
modalBackdrop.addEventListener('click', (e) => {
  if (e.target === modalBackdrop) closeRepoModal()
})

document.getElementById('rm-save').addEventListener('click', () => {
  const next = rmName.value.trim()
  if (!next) {
    rmError.textContent = 'name is required'
    return
  }
  if (next !== modalRepo && mapState.repositories[next]) {
    rmError.textContent = `a repository named "${next}" already exists`
    return
  }
  const repo = modalRepo ? mapState.repositories[modalRepo] : {}
  const assign = (key, value) => {
    if (value) repo[key] = value
    else delete repo[key]
  }
  assign('remotePath', rmRemote.value.trim())
  assign('localPath', rmLocal.value.trim())
  assign('unowned', rmUnowned.value)
  assign('undeclaredDependencies', rmUndeclared.value)
  if (!modalRepo) {
    mapState.repositories[next] = repo
  } else if (next !== modalRepo) {
    mapState.repositories = renameKey(mapState.repositories, modalRepo, next)
    for (const t of Object.values(mapState.territories)) {
      for (const s of t.scope || []) if (s.repository === modalRepo) s.repository = next
    }
  }
  closeRepoModal()
  refresh()
  loadTree()
})

// ── Repository ⋯ menu ──

let openMenuEl = null

function closeRepoMenu() {
  if (openMenuEl) {
    openMenuEl.remove()
    openMenuEl = null
  }
}
document.addEventListener('click', closeRepoMenu)

function openRepoMenu(name, anchor) {
  closeRepoMenu()
  const menu = el('div', 'ft-menu')
  const edit = el('button', 'ft-menu-item', 'Edit')
  edit.type = 'button'
  edit.addEventListener('click', (e) => {
    e.stopPropagation()
    closeRepoMenu()
    openRepoModal(name)
  })
  const del = el('button', 'ft-menu-item danger', 'Delete')
  del.type = 'button'
  del.addEventListener('click', (e) => {
    e.stopPropagation()
    closeRepoMenu()
    delete mapState.repositories[name]
    refresh()
  })
  menu.appendChild(edit)
  menu.appendChild(del)
  const rect = anchor.getBoundingClientRect()
  menu.style.top = `${rect.bottom + 2}px`
  menu.style.left = `${Math.max(8, rect.right - 110)}px`
  document.body.appendChild(menu)
  openMenuEl = menu
}

// ── File tree: each repository at the localPath its entry declares ──
// Selecting a territory highlights the files its globs claim; clicking a file
// selects the territory that claims it.

let treeData = null
const expandedDirs = new Set() // `${repo} ${dir}` opened by the user
const collapsedDirs = new Set() // manual override against selection auto-expand
let treeSignature = ''

// Same glob semantics as the scope gate: `**` spans path segments, `*` stays
// within one, `?` is one character, a bare filename matches only at the root.
function globToRegExp(glob) {
  const segments = glob.split('/')
  let out = ''
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1
    if (seg === '**') {
      // Zero or more whole segments, and it swallows the separator after it -
      // except as the last segment, where it still needs one segment to match.
      out += last ? '[^/]+(?:/[^/]+)*' : '(?:[^/]+/)*'
      return
    }
    for (const ch of seg) {
      if (ch === '*') out += '[^/]*'
      else if (ch === '?') out += '[^/]'
      else if ('\\^$.|+()[]{}'.includes(ch)) out += '\\' + ch
      else out += ch
    }
    if (!last) out += '/'
  })
  return new RegExp(`^${out}$`)
}

function territoryGlobs(repoName, territory) {
  return (territory.scope || [])
    .filter((s) => s.repository === repoName)
    .flatMap((s) => s.globs || [])
}

function claimingTerritory(path, repoName) {
  if (!mapState) return null
  for (const [name, t] of Object.entries(mapState.territories)) {
    if (territoryGlobs(repoName, t).some((g) => globToRegExp(g).test(path))) return name
  }
  return null
}

async function loadTree() {
  if (!mapState) return
  try {
    const res = await fetch('api/tree', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repositories: mapState.repositories })
    })
    if (!res.ok) return
    treeData = await res.json()
    renderTree()
  } catch {
    // Server briefly unavailable; keep the current tree.
  }
}

// Re-list only when the repositories or their paths change, plus a slow tick
// so edits made on disk show up without a reload.
function maybeReloadTree() {
  if (!mapState) return
  const signature = JSON.stringify(
    Object.entries(mapState.repositories).map(([n, r]) => [n, r.localPath || ''])
  )
  if (signature === treeSignature) return
  treeSignature = signature
  loadTree()
}
setInterval(() => {
  maybeReloadTree()
}, 1500)
setInterval(loadTree, 15000)

function buildTree(files) {
  const root = { dirs: new Map(), files: [] }
  for (const path of files) {
    const parts = path.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] })
      node = node.dirs.get(parts[i])
    }
    node.files.push({ name: parts[parts.length - 1], p: path })
  }
  return root
}

function renderTree() {
  filetreeEl.innerHTML = ''
  if (!mapState) {
    filetreeEl.appendChild(el('div', 'ft-empty', 'No map loaded.'))
    return
  }
  const selT =
    mode === 'system' && selection && selection.type === 'territory' && mapState.territories[selection.id]
      ? selection.id
      : null
  const selActor =
    mode === 'system' && selection && selection.type === 'actor' && mapState.actors[selection.id]
      ? selection.id
      : null
  // 1st layer: the selected territory, or every territory the selected actor
  // owns, merged. 2nd layer: the territory focused within the actor.
  const highlightTerritories = selT
    ? [selT]
    : selActor
      ? territoriesOwnedBy(selActor)
      : null
  const focusTerritory =
    mode === 'system' && activeTab === 'actors' && subTerritory && mapState.territories[subTerritory]
      ? subTerritory
      : null
  const repoNames = Object.keys(mapState.repositories)

  for (const name of repoNames) {
    const treeRepo = treeData && treeData.repos ? treeData.repos.find((r) => r.name === name) : null
    const files = treeRepo ? treeRepo.files : []
    const section = el('div', 'ft-repo')
    const head = el('div', 'ft-repo-head')
    head.appendChild(el('span', 'ft-repo-name', name))
    const menuBtn = el('button', 'ft-menu-btn', '⋯')
    menuBtn.type = 'button'
    menuBtn.title = 'Repository actions'
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      openRepoMenu(name, menuBtn)
    })
    head.appendChild(menuBtn)
    section.appendChild(head)
    const repo = mapState.repositories[name]
    if (repo.remotePath) section.appendChild(el('div', 'ft-repo-meta', repo.remotePath))

    if (!repo.localPath) {
      section.appendChild(
        el('div', 'ft-empty', 'no localPath — add one from ⋯ → Edit to list this repository')
      )
      filetreeEl.appendChild(section)
      continue
    }
    if (treeRepo && treeRepo.error) {
      section.appendChild(el('div', 'ft-empty', `${repo.localPath}: ${treeRepo.error}`))
      filetreeEl.appendChild(section)
      continue
    }
    if (!treeRepo) {
      section.appendChild(el('div', 'ft-empty', 'listing…'))
      filetreeEl.appendChild(section)
      continue
    }
    if (treeRepo.truncated) {
      section.appendChild(el('div', 'ft-empty', `first ${files.length} files`))
    }

    const matchFiles = (names2) => {
      const set = new Set()
      const regs = names2
        .flatMap((tn) => territoryGlobs(name, mapState.territories[tn]))
        .map(globToRegExp)
      if (regs.length > 0) {
        for (const f of files) if (regs.some((r) => r.test(f))) set.add(f)
      }
      return set
    }
    const ancestorDirs = (set) => {
      const dirs = new Set()
      if (!set) return dirs
      for (const p of set) {
        const parts = p.split('/')
        let acc = ''
        for (let i = 0; i < parts.length - 1; i++) {
          acc = acc ? `${acc}/${parts[i]}` : parts[i]
          dirs.add(acc)
        }
      }
      return dirs
    }
    const matchSet = highlightTerritories ? matchFiles(highlightTerritories) : null
    const match2Set = focusTerritory ? matchFiles([focusTerritory]) : null

    const body = el('div', 'ft-body')
    renderTreeDir(buildTree(files), '', 0, {
      repo: name,
      matchSet,
      matchDirs: ancestorDirs(matchSet),
      match2Set,
      match2Dirs: ancestorDirs(match2Set),
      body,
      autoExpand: matchSet !== null && matchSet.size > 0 && matchSet.size <= 400
    })
    section.appendChild(body)
    filetreeEl.appendChild(section)
  }
  if (repoNames.length === 0) {
    filetreeEl.appendChild(el('div', 'ft-empty', 'No repositories — add one with +'))
  }
}

function renderTreeDir(node, dirPath, depth, ctx) {
  for (const d of [...node.dirs.keys()].sort()) {
    const full = dirPath ? `${dirPath}/${d}` : d
    const key = `${ctx.repo} ${full}`
    const auto = ctx.autoExpand && ctx.matchDirs.has(full)
    const isOpen = (expandedDirs.has(key) || auto) && !collapsedDirs.has(key)
    const row = el(
      'div',
      'ft-row ft-dir' +
        (ctx.matchSet && ctx.matchDirs.has(full) ? ' match' : '') +
        (ctx.match2Set && ctx.match2Dirs.has(full) ? ' match2' : '')
    )
    row.style.paddingLeft = `${8 + depth * 13}px`
    row.appendChild(el('span', 'ft-chevron', isOpen ? '▾' : '▸'))
    row.appendChild(el('span', 'ft-name', d))
    row.addEventListener('click', (e) => {
      e.stopPropagation()
      if (isOpen) {
        collapsedDirs.add(key)
        expandedDirs.delete(key)
      } else {
        expandedDirs.add(key)
        collapsedDirs.delete(key)
      }
      renderTree()
    })
    ctx.body.appendChild(row)
    if (isOpen) renderTreeDir(node.dirs.get(d), full, depth + 1, ctx)
  }
  for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
    const matchCls = ctx.matchSet && ctx.matchSet.has(f.p) ? ' match' : ''
    const match2Cls = ctx.match2Set && ctx.match2Set.has(f.p) ? ' match2' : ''
    const row = el('div', `ft-row ft-file${matchCls}${match2Cls}`)
    row.style.paddingLeft = `${8 + depth * 13 + 13}px`
    row.appendChild(el('span', 'ft-name', f.name))
    const claiming = claimingTerritory(f.p, ctx.repo)
    const ownerName = claiming ? mapState.territories[claiming].owner : null
    row.title = claiming ? `territory: ${claiming} · owner: ${ownerName}` : 'unowned'
    row.addEventListener('click', (e) => {
      e.stopPropagation()
      if (!claiming) return
      if (activeTab === 'actors') return selectOwnerAndTerritory(claiming)
      select({ type: 'territory', id: claiming })
    })
    ctx.body.appendChild(row)
  }
}

function renderAll() {
  syncTabs()
  renderGeneral()
  renderActorsPage()
  if (activeTab === 'territories') renderCanvas()
  renderInspector()
  renderTree()
  renderStoreNote()
  updateButtons()
}

window.addEventListener('resize', () => {
  if (mode === 'system' && mapState && activeTab === 'territories') renderCanvas()
})

// ── Mode switching ──

async function serializeCurrent() {
  if (mode === 'raw') return rawEditor.value
  if (!mapState) return ''
  const res = await fetch('api/serialize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ map: normalizedMap() })
  })
  return (await res.json()).yaml
}

modeBtn.addEventListener('click', async () => {
  if (mode === 'system') {
    const yaml = await serializeCurrent()
    mode = 'raw'
    rawEditor.value = yaml
    rawEditor.hidden = false
    systemView.hidden = true
  } else {
    const res = await fetch('api/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ yaml: rawEditor.value })
    })
    const validation = await res.json()
    if (!validation.valid) {
      applyValidation(validation)
      setStatus('Fix the errors before switching to the system view', 'err')
      return
    }
    mode = 'system'
    mapState = validation.map
    rawEditor.hidden = true
    systemView.hidden = false
    renderAll()
  }
  persist()
  validateNow()
  updateButtons()
})

rawEditor.addEventListener('input', () => {
  scheduleValidate()
  persist()
})

// ── Export ──

exportBtn.addEventListener('click', async () => {
  const yaml = await serializeCurrent()
  if (!yaml) return
  const url = URL.createObjectURL(new Blob([yaml], { type: 'application/yaml' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'architecture.yaml'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  setStatus('Exported ✓', 'ok')
  setTimeout(validateNow, 1200)
})

// ── The paste dialog: how a map gets in ──

const pasteBackdrop = document.getElementById('paste-backdrop')
const pasteInput = document.getElementById('paste-input')
const pasteError = document.getElementById('paste-error')
const pasteCancel = document.getElementById('paste-cancel')

function openPasteDialog(initial) {
  pasteInput.value = initial ?? ''
  pasteError.textContent = ''
  pasteCancel.hidden = false
  pasteBackdrop.hidden = false
  pasteInput.focus()
}

function closePasteDialog() {
  pasteBackdrop.hidden = true
}

pasteBtn.addEventListener('click', () => openPasteDialog(''))
pasteCancel.addEventListener('click', closePasteDialog)
pasteBackdrop.addEventListener('click', (e) => {
  if (e.target === pasteBackdrop) closePasteDialog()
})

document.getElementById('paste-template').addEventListener('click', async () => {
  const res = await fetch('api/template')
  pasteInput.value = (await res.json()).yaml
  pasteError.textContent = ''
  pasteInput.focus()
})

document.getElementById('paste-load').addEventListener('click', async () => {
  const yaml = pasteInput.value
  if (yaml.trim() === '') {
    pasteError.textContent = 'paste a map, or start from the template'
    return
  }
  const res = await fetch('api/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ yaml })
  })
  const validation = await res.json()
  adopt(yaml, validation)
  closePasteDialog()
})

/**
 * Take a YAML text as the map being edited. A map that validates opens in the
 * system view; one that does not opens in raw mode with its problems listed, so
 * a half-written file can still be brought the rest of the way here.
 */
function adopt(yaml, validation) {
  selection = null
  subTerritory = null
  editingField = null
  if (validation && validation.valid) {
    mode = 'system'
    mapState = validation.map
    rawEditor.value = ''
  } else {
    mode = 'raw'
    rawEditor.value = yaml
    mapState = null
  }
  rawEditor.hidden = mode !== 'raw'
  systemView.hidden = mode === 'raw'
  applyValidation(validation)
  renderAll()
  persist()
  treeSignature = ''
  maybeReloadTree()
}

// ── The seed file: `--file` on the server ──
//
// Loaded once when the browser holds nothing, and again on the Reload button.
// The server never writes it; what is edited here is still the browser's copy.

let seedName = null

async function loadSeedFile() {
  let res
  try {
    res = await fetch('api/file')
  } catch {
    return false
  }
  if (!res.ok) return false
  const { name, yaml } = await res.json()
  seedName = name
  fileBtn.textContent = `Reload ${name}`
  fileBtn.hidden = false
  const v = await fetch('api/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ yaml })
  })
  adopt(yaml, await v.json())
  return true
}

/** Show the Reload button without loading, when the browser already holds a map. */
async function revealSeedButton() {
  try {
    const res = await fetch('api/file')
    if (!res.ok) return
    const { name } = await res.json()
    seedName = name
    fileBtn.textContent = `Reload ${name}`
    fileBtn.hidden = false
  } catch {
    // no seed file, or no server: the button stays hidden
  }
}

fileBtn.addEventListener('click', () => loadSeedFile())

// ── Start ──

async function start() {
  const stored = readStore()
  lastChangeAt = stored?.updatedAt ?? null
  if (stored && (stored.map || stored.yaml)) revealSeedButton()
  if (stored && stored.map) {
    mode = 'system'
    mapState = stored.map
    rawEditor.hidden = true
    systemView.hidden = false
    renderAll()
    validateNow()
    maybeReloadTree()
    return
  }
  if (stored && typeof stored.yaml === 'string' && stored.yaml.trim() !== '') {
    const res = await fetch('api/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ yaml: stored.yaml })
    })
    adopt(stored.yaml, await res.json())
    return
  }
  if (await loadSeedFile()) return
  mapState = null
  renderAll()
  applyValidation(null)
  openPasteDialog('')
}

start()

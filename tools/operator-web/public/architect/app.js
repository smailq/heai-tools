// The architecture map editor, served by heai-operator-web at /architect/.
//
// The map is the file operator reads: it is loaded from there, edited here, and
// written back by Save - only when architect calls it valid, and only over the
// version this page loaded, unless you choose to overwrite a newer one. Unsaved
// edits are kept in localStorage as a draft, so a reload or a restarted server
// loses nothing. Paste and Export still bring a map in and take a copy out.
//
// mode 'system': mapState (a plain object mirroring the schema) is the source
// of truth, rendered as a diagram + inspector, serialized on export.
// mode 'raw': the textarea is the source of truth - the fallback for YAML the
// system view cannot represent, such as a map that does not parse yet.

// The draft's key names the map file, so two projects served on one origin keep two drafts.
let storeKey = 'heai-operator.map-editor.v1'

const statusEl = document.getElementById('status')
const storeNoteEl = document.getElementById('store-note')
const exportBtn = document.getElementById('export-btn')
const pasteBtn = document.getElementById('paste-btn')
const fileBtn = document.getElementById('file-btn')
const saveBtn = document.getElementById('save-btn')
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
const tabGeneral = document.getElementById('tab-general')
const tabTerritories = document.getElementById('tab-territories')
const addRepoBtn = document.getElementById('add-repo-btn')
const addTerritoryBtn = document.getElementById('add-territory-btn')
const filetreeEl = document.getElementById('filetree')

let mode = 'system'
let mapState = null
let lastValidation = null
let debounceTimer = null
let selection = null // null | {type:'territory'|'task', id}
let editingField = null // key of the single inspector field currently in edit mode
let activeTab = 'territories' // 'general' | 'territories'
let lastChangeAt = null
// The map file: {path, name, exists, version} from api/file, or null when no map is configured.
let fileInfo = null
// The file version this page's edits are based on, and whether they differ from it.
let baseVersion = null
// The text of that version: the comments and layout a save from the system view keeps.
let baseYaml = null
let dirty = false
let saving = false

// ── The browser-side store ──

function persist(edited = true) {
  if (edited) dirty = true
  try {
    const payload =
      mode === 'raw'
        ? { yaml: rawEditor.value, map: null }
        : { yaml: null, map: mapState ? normalizedMap() : null }
    payload.updatedAt = new Date().toISOString()
    payload.base = baseVersion
    payload.baseYaml = baseYaml
    payload.dirty = dirty
    localStorage.setItem(storeKey, JSON.stringify(payload))
    lastChangeAt = payload.updatedAt
  } catch {
    // A browser with storage disabled still edits fine; it just forgets.
    lastChangeAt = new Date().toISOString()
  }
  renderStoreNote()
  updateButtons()
}

function readStore() {
  try {
    const raw = localStorage.getItem(storeKey)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function renderStoreNote() {
  const where = fileInfo ? fileInfo.path : 'no map file configured'
  storeNoteEl.title = where
  storeNoteEl.classList.toggle('dirty', dirty)
  if (!mapState && mode === 'system' && !rawEditor.value) {
    storeNoteEl.textContent = fileInfo && !fileInfo.exists
      ? `${fileInfo.name} does not exist yet — paste a map or start from the template, then Save`
      : 'nothing loaded — paste a map to begin'
    return
  }
  const at = lastChangeAt ? new Date(lastChangeAt) : null
  storeNoteEl.textContent = dirty
    ? `${where} · unsaved changes` + (at ? ` · last change ${at.toLocaleTimeString()}` : '')
    : `${where} · saved`
}

function emptyMap() {
  return { version: 1, repositories: {}, territories: {} }
}

function normalizedMap() {
  const map = JSON.parse(JSON.stringify(mapState))
  const dropEmpty = (obj, key) => {
    const v = obj[key]
    if (v === undefined) return
    if (v === '' || (Array.isArray(v) && v.length === 0)) delete obj[key]
    else if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) delete obj[key]
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

/** Ancestors of a territory, nearest first; cycle-safe on a mid-edit map. */
function ancestorsOf(name) {
  const out = []
  const seen = new Set([name])
  let cur = mapState && mapState.territories[name] ? mapState.territories[name].parent : undefined
  while (cur !== undefined && mapState.territories[cur] && !seen.has(cur)) {
    out.push(cur)
    seen.add(cur)
    cur = mapState.territories[cur].parent
  }
  return out
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
  saveBtn.disabled = saving || !fileInfo || !hasContent || !dirty || (lastValidation !== null && !lastValidation.valid)
  saveBtn.title = !fileInfo
    ? 'no map file configured'
    : lastValidation && !lastValidation.valid
      ? 'fix the errors to save'
      : `write ${fileInfo.path}`
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
  editingField = null
  // A territory and a task are both inspected beside the drawing.
  if (sel) activeTab = 'territories'
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
    editingField = null
  }
  activeTab = tab
  renderAll()
}

function syncTabs() {
  tabGeneral.classList.toggle('active', activeTab === 'general')
  tabTerritories.classList.toggle('active', activeTab === 'territories')
  generalPage.hidden = activeTab !== 'general'
  canvasWrap.hidden = activeTab !== 'territories'
  // The General tab edits in place; the inspector beside the drawing serves the territories.
  inspector.hidden = activeTab === 'general'
  addTerritoryBtn.hidden = activeTab !== 'territories' || !mapState
}

tabGeneral.addEventListener('click', () => setTab('general'))
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

// ── The tracker's tasks, shown per territory ──
//
// Read through the server, read-only: the tasks tool owns every write. A task
// names the territories it is scoped to and the agent meant to do it; the
// territory inspector lists the open tasks in it, and a task opens its detail.

// Statuses in the tracker's pick-up order: active work first, then the
// committed queue. The backlog and the terminal states stay out of the view.
const TASK_ORDER = ['in-progress', 'in-review', 'blocked', 'todo']
const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low']

/**
 * The territories a task sits in. The tracker writes one or more names,
 * comma-separated, in the one `territory` field; a task that crosses a
 * boundary lists every territory it touches.
 */
function taskTerritories(t) {
  return String(t.territory || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * The prioritized open tasks in any of these territories, in pick-up order.
 * Only triaged work shows - a task with no priority, or still in the backlog,
 * is not on anyone's plate yet.
 */
function openTasksFor(names) {
  if (!tasksData || !Array.isArray(tasksData.tasks)) return []
  const set = new Set(names)
  return tasksData.tasks
    .filter(
      (t) =>
        taskTerritories(t).some((name) => set.has(name)) &&
        TASK_ORDER.includes(t.status) &&
        PRIORITY_ORDER.includes(t.priority)
    )
    .sort(
      (a, b) =>
        TASK_ORDER.indexOf(a.status) - TASK_ORDER.indexOf(b.status) ||
        PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority)
    )
}

/** One row of a task: its status, priority, title and the agent it is assigned to. */
function taskRow(t) {
  const isSel = selection && selection.type === 'task' && selection.id === t.slug
  const row = el('button', 'task-row' + (isSel ? ' selected' : ''))
  row.type = 'button'
  row.title = [t.slug, t.modified_at].filter(Boolean).join(' · ')
  row.appendChild(el('span', `task-status st-${t.status}`, t.status))
  row.appendChild(el('span', `task-prio p-${t.priority}`, t.priority))
  row.appendChild(el('span', 'task-title', t.title || t.slug))
  row.appendChild(el('span', 'task-agent', t.agent || '—'))
  row.addEventListener('click', (e) => {
    e.stopPropagation()
    select({ type: 'task', id: t.slug })
  })
  return row
}

/** The open tasks in a territory, under the territory's own fields; nothing when the tracker is not there. */
function tasksGroup(name) {
  if (!tasksData || !Array.isArray(tasksData.tasks)) return null
  const open = openTasksFor([name])
  const wrap = el('div', 'i-group')
  wrap.appendChild(el('span', 'i-label', open.length === 0 ? 'open tasks' : `open tasks · ${open.length}`))
  const body = el('div', 'i-group-body i-tasks')
  if (open.length === 0) body.appendChild(el('span', 'i-hint', 'no prioritized open task is scoped here'))
  for (const t of open) body.appendChild(taskRow(t))
  wrap.appendChild(body)
  return wrap
}

function uniqueName(existing, base) {
  let n = base
  for (let i = 2; existing[n]; i++) n = `${base}-${i}`
  return n
}

addRepoBtn.addEventListener('click', () => openRepoModal(null))

addTerritoryBtn.addEventListener('click', () => {
  if (!mapState) return
  const name = uniqueName(mapState.territories, 'new-territory')
  mapState.territories[name] = {
    scope: [{ repository: Object.keys(mapState.repositories)[0] || '', globs: [] }]
  }
  select({ type: 'territory', id: name })
  editingField = 'name'
  renderInspector()
  scheduleValidate()
  persist()
})

// ── Canvas: a free-form territory graph, rendered with Cytoscape.js ──
// Repositories are compound containers, a parent territory is a compound
// holding its children, and dependency edges are arrows. Nodes drag freely,
// the canvas pans and zooms, and the force layout re-runs only when the
// graph's shape changes - so an arrangement survives ordinary edits.

let cy = null
let cyShapeKey = ''
let cyNeedsLayout = false

/** A CSS custom property as a concrete color, for the canvas renderer. */
function cssColor(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** The map as Cytoscape elements: compound repos, nested territories, dep edges. */
function canvasElements() {
  const els = []
  const repoNames = Object.keys(mapState.repositories)
  const firstInstance = new Map() // territory -> node id of its first instance
  for (const repoName of repoNames) {
    const repo = mapState.repositories[repoName]
    els.push({
      data: {
        id: `repo:${repoName}`,
        label: `${repoName} · ${truncate(repo.remotePath || repo.localPath || '(no path)', 34)}`
      },
      classes: 'repo'
    })
  }
  for (const repoName of repoNames) {
    const members = Object.keys(mapState.territories).filter((n) =>
      (mapState.territories[n].scope || []).some((s) => s.repository === repoName)
    )
    const memberSet = new Set(members)
    for (const tName of members) {
      const t = mapState.territories[tName]
      const p = t.parent
      // A child nests inside its parent's compound when the parent shares
      // this repository; cycles mid-edit fall back to the repo container.
      const nested =
        p !== undefined && p !== tName && memberSet.has(p) && !ancestorsOf(p).includes(tName)
      const id = `t:${repoName}:${tName}`
      if (!firstInstance.has(tName)) firstInstance.set(tName, id)
      const spans = new Set((t.scope || []).map((s) => s.repository)).size > 1
      // ⊂ only where the relation is not visible as containment itself.
      const stray = !nested && p !== undefined
      // Under the name, what the territory claims in this repository.
      const globs = territoryGlobs(repoName, t)
      els.push({
        data: {
          id,
          territory: tName,
          parent: nested ? `t:${repoName}:${p}` : `repo:${repoName}`,
          label:
            truncate(tName, 24) + (spans ? ' ⧉' : '') + (stray ? ` ⊂ ${truncate(p, 14)}` : ''),
          sub: truncate(globs.join(' '), 30) || '(no globs)'
        },
        classes: 'territory'
      })
    }
  }
  for (const [from, t] of Object.entries(mapState.territories)) {
    for (const to of t.dependsOn || []) {
      const a = firstInstance.get(from)
      const b = firstInstance.get(to)
      if (!a || !b || a === b) continue
      els.push({ data: { id: `dep:${from}:${to}`, source: a, target: b }, classes: 'dep' })
    }
  }
  return els
}

function cyStyles() {
  const border = cssColor('--border', '#d1d5db')
  const text = cssColor('--text', '#111827')
  const muted = cssColor('--muted', '#6b7280')
  const bg = cssColor('--bg', '#ffffff')
  const panel = cssColor('--panel', '#f3f4f6')
  const accent = cssColor('--accent', '#2563eb')
  const mono = 'ui-monospace, Menlo, monospace'
  return [
    {
      selector: 'node.repo',
      style: {
        shape: 'round-rectangle',
        'background-color': panel,
        'background-opacity': 0.55,
        'border-color': border,
        'border-width': 1.5,
        label: 'data(label)',
        color: muted,
        'font-size': 11,
        'font-family': mono,
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': -8,
        padding: 20
      }
    },
    {
      selector: 'node.territory',
      style: {
        shape: 'round-rectangle',
        'background-color': bg,
        'border-color': muted,
        'border-width': 2,
        width: 'label',
        height: 'label',
        padding: 9,
        label: (ele) => `${ele.data('label')}\n${ele.data('sub')}`,
        'text-wrap': 'wrap',
        'text-valign': 'center',
        'text-halign': 'center',
        color: text,
        'font-size': 11,
        'font-family': mono
      }
    },
    {
      // A parent territory is a container: panel-toned, its name on the rim.
      selector: 'node.territory:parent',
      style: {
        'background-color': panel,
        'background-opacity': 0.4,
        'text-valign': 'top',
        'text-margin-y': -6,
        padding: 16
      }
    },
    {
      selector: 'node.territory.sel',
      style: { 'border-color': accent, 'border-width': 3 }
    },
    {
      selector: 'edge.dep',
      style: {
        'curve-style': 'bezier',
        width: 1.5,
        'line-color': border,
        'line-opacity': 0.9,
        'target-arrow-shape': 'triangle',
        'target-arrow-color': border,
        'arrow-scale': 1.1
      }
    }
  ]
}

function runCanvasLayout() {
  // fcose is compound-aware, so nested territories land without overlaps;
  // plain cose is the fallback if the plugin failed to load.
  try {
    cy.layout({
      name: 'fcose',
      quality: 'proof',
      animate: false,
      randomize: true,
      fit: true,
      padding: 28,
      nodeSeparation: 90,
      idealEdgeLength: 110,
      nestingFactor: 0.9
    }).run()
  } catch {
    cy.layout({ name: 'cose', animate: false, fit: true, padding: 28 }).run()
  }
}

function renderCanvas() {
  const empty = !mapState
    ? 'No map loaded — paste one in to draw the system.'
    : Object.keys(mapState.repositories).length === 0
      ? 'Add a repository, then territories, to draw the system.'
      : null
  if (empty) {
    if (cy) {
      cy.destroy()
      cy = null
      cyShapeKey = ''
    }
    canvas.textContent = empty
    canvas.className = 'canvas-empty'
    return
  }
  if (!cy) {
    canvas.textContent = ''
    canvas.className = ''
    cy = cytoscape({
      container: canvas,
      style: cyStyles(),
      wheelSensitivity: 0.2,
      minZoom: 0.2,
      maxZoom: 2.5
    })
    cy.on('tap', 'node.territory', (evt) => {
      select({ type: 'territory', id: evt.target.data('territory') })
    })
    cy.on('tap', (evt) => {
      if (evt.target === cy) select(null)
    })
  }

  const els = canvasElements()
  const shape = JSON.stringify(
    els.map((e) => [e.data.id, e.data.parent ?? '', e.data.source ?? '', e.data.target ?? '']).sort()
  )
  if (shape !== cyShapeKey) {
    cyShapeKey = shape
    cy.elements().remove()
    cy.add(els)
    cyNeedsLayout = true
  } else {
    // Same graph, changed details: update the labels in place so the
    // arrangement (including anything the user dragged) is left alone.
    for (const e of els) {
      if (e.data.source !== undefined) continue
      cy.getElementById(e.data.id).data({
        label: e.data.label,
        sub: e.data.sub ?? ''
      })
    }
  }

  cy.nodes('.sel').removeClass('sel')
  if (selection && selection.type === 'territory') {
    cy.nodes()
      .filter((n) => n.data('territory') === selection.id)
      .addClass('sel')
  }

  // Laying out inside a hidden (zero-size) container degenerates; wait for
  // the tab to be visible, which re-enters here via syncTabs.
  if (!canvasWrap.hidden && canvas.clientWidth > 0) {
    cy.resize()
    if (cyNeedsLayout) {
      cyNeedsLayout = false
      runCanvasLayout()
    }
  }
}

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

function inspectorHeader(kind, title, onDelete) {
  const head = el('div', 'i-head')
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
  if (!selection) {
    inspector.appendChild(
      el('p', 'i-hint', 'Select a territory to inspect and edit it — one field at a time.')
    )
    return
  }
  if (selection.type === 'territory') renderTerritoryInspector(selection.id)
  else if (selection.type === 'task') renderTaskInspector(selection.id)
}

/**
 * Read-only task detail, from the tracker beside the map. The tasks tool
 * owns every write, so this shows the file, not an editor.
 */
function renderTaskInspector(slug) {
  const task =
    tasksData && Array.isArray(tasksData.tasks)
      ? tasksData.tasks.find((t) => t.slug === slug)
      : null
  if (!task) {
    inspector.appendChild(el('p', 'i-hint', `Task "${slug}" is no longer in the tracker.`))
    return
  }
  const territories = taskTerritories(task)
  inspector.appendChild(inspectorHeader('task', task.title || task.slug))

  const field = (label, node) => {
    const row = el('div', 'i-field')
    row.appendChild(el('span', 'i-label', label))
    row.appendChild(typeof node === 'string' ? el('span', 'i-static', node) : node)
    inspector.appendChild(row)
  }

  field('slug', task.slug)

  const state = el('div', 'i-chips')
  state.appendChild(el('span', `task-status st-${task.status}`, task.status))
  if (task.priority) state.appendChild(el('span', `task-prio p-${task.priority}`, task.priority))
  field('state', state)

  if (territories.length > 0) {
    const wrap = el('div', 'i-chips')
    for (const tName of territories) {
      // A territory the map no longer declares is named, but opens nothing.
      const known = Boolean(mapState.territories[tName])
      const chip = el('button', 'chip' + (known ? '' : ' unknown'))
      chip.type = 'button'
      chip.disabled = !known
      chip.title = known ? '' : 'not a territory of this map'
      chip.appendChild(el('span', '', tName))
      chip.addEventListener('click', (e) => {
        e.stopPropagation()
        select({ type: 'territory', id: tName })
      })
      wrap.appendChild(chip)
    }
    field(territories.length === 1 ? 'territory' : 'territories', wrap)
  }

  // Who is meant to do it: a name the project resolves, which this editor only shows.
  field('agent', task.agent || '— unassigned')

  const dates = [
    task.created_at ? `created ${task.created_at}` : '',
    task.modified_at ? `modified ${task.modified_at}` : ''
  ]
    .filter(Boolean)
    .join(' · ')
  if (dates) field('dates', dates)

  if (task.body) {
    const row = el('div', 'i-field')
    row.appendChild(el('span', 'i-label', 'body'))
    row.appendChild(el('pre', 'i-taskbody', task.body))
    inspector.appendChild(row)
  }

  inspector.appendChild(
    el('p', 'i-hint', 'Read-only here — tasks change through heai-tasks at the shell.')
  )
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
    inspectorHeader('territory', name, () => {
      delete mapState.territories[name]
      for (const other of Object.values(mapState.territories)) {
        // Children of the deleted territory move up a level.
        if (other.parent === name) {
          if (t.parent !== undefined) other.parent = t.parent
          else delete other.parent
        }
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
        mapState.territories = renameKey(mapState.territories, name, next)
        for (const other of Object.values(mapState.territories)) {
          if (other.parent === name) other.parent = next
          if (other.dependsOn) other.dependsOn = other.dependsOn.map((x) => (x === name ? next : x))
          for (const entry of other.scope || []) {
            if (!entry.exclude?.territories) continue
            entry.exclude.territories = entry.exclude.territories.map((x) => (x === name ? next : x))
          }
        }
        selection = { type: 'territory', id: next }
      }
    })
  )

  // Parent: a select commits immediately. Cycles and containment are the
  // validator's to report; the select only rules out the trivial self-parent.
  const parentRow = el('div', 'i-field')
  parentRow.appendChild(el('span', 'i-label', 'parent'))
  const parentSel = el('select', 'i-select')
  const parentOption = (value, label) => {
    const opt = el('option', '', label ?? value)
    opt.value = value
    if (value === (t.parent ?? '')) opt.selected = true
    parentSel.appendChild(opt)
  }
  parentOption('', '(none - a top-level territory)')
  for (const other of Object.keys(mapState.territories).filter((n) => n !== name)) {
    parentOption(other)
  }
  parentSel.addEventListener('click', (e) => e.stopPropagation())
  parentSel.addEventListener('change', () => {
    if (parentSel.value === '') delete t.parent
    else t.parent = parentSel.value
    refresh()
  })
  parentRow.appendChild(parentSel)
  inspector.appendChild(parentRow)
  if (t.parent !== undefined) {
    inspector.appendChild(
      el('p', 'i-hint', 'A child carves its scope out of its parent: the globs must sit inside the parent’s, and the parent no longer holds what the child claims.')
    )
  }

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

  // The tracker's open tasks scoped here, after the territory's own fields.
  const tasks = tasksGroup(name)
  if (tasks) inspector.appendChild(tasks)
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
  const matches = Object.entries(mapState.territories)
    .filter(([, t]) => territoryGlobs(repoName, t).some((g) => globToRegExp(g).test(path)))
    .map(([n]) => n)
  // A child's claim beats its ancestors': the parent's effective scope no
  // longer holds a carved-out path. Among unrelated matches (an invalid,
  // overlapping map) the first still wins, as before.
  return matches.find((n) => !matches.some((m) => m !== n && ancestorsOf(m).includes(n))) ?? null
}

// The tracker's tasks, read through the server (read-only; the task-manager
// CLI owns every write). null until the first successful fetch.
let tasksData = null

async function loadTasks() {
  if (!mapState) return
  try {
    const res = await fetch('api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repositories: mapState.repositories })
    })
    if (!res.ok) return
    tasksData = await res.json()
    // The inspector lists tasks under a territory and shows a task's detail; nothing else reads them.
    if (selection && editingField === null) renderInspector()
  } catch {
    // Server briefly unavailable; keep the current tasks.
  }
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
  loadTasks()
}
setInterval(() => {
  maybeReloadTree()
}, 1500)
setInterval(loadTree, 15000)
setInterval(loadTasks, 15000)

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
  // The selected territory's files are highlighted; a selected task highlights the territories it is scoped to.
  let highlightTerritories = null
  if (mode === 'system' && selection) {
    if (selection.type === 'territory' && mapState.territories[selection.id]) highlightTerritories = [selection.id]
    else if (selection.type === 'task') {
      const task = tasksData && Array.isArray(tasksData.tasks) ? tasksData.tasks.find((t) => t.slug === selection.id) : null
      if (task) highlightTerritories = taskTerritories(task).filter((n) => mapState.territories[n])
    }
  }
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

    const body = el('div', 'ft-body')
    renderTreeDir(buildTree(files), '', 0, {
      repo: name,
      matchSet,
      matchDirs: ancestorDirs(matchSet),
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
    const row = el('div', 'ft-row ft-dir' + (ctx.matchSet && ctx.matchDirs.has(full) ? ' match' : ''))
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
    const row = el('div', `ft-row ft-file${matchCls}`)
    row.style.paddingLeft = `${8 + depth * 13 + 13}px`
    row.appendChild(el('span', 'ft-name', f.name))
    const claiming = claimingTerritory(f.p, ctx.repo)
    row.title = claiming ? `territory: ${claiming}` : 'unowned: no territory claims this path'
    row.addEventListener('click', (e) => {
      e.stopPropagation()
      if (claiming) select({ type: 'territory', id: claiming })
    })
    ctx.body.appendChild(row)
  }
}

function renderAll() {
  syncTabs()
  renderGeneral()
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
    body: JSON.stringify(baseYaml === null ? { map: normalizedMap() } : { map: normalizedMap(), base: baseYaml })
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
  persist(false)
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

// ── The map file ──
//
// Loaded when the page opens, and again on Reload; written by Save.

function markClean(version, yaml) {
  baseVersion = version
  baseYaml = yaml
  dirty = false
  persist(false)
}

async function fetchFile() {
  try {
    const res = await fetch('api/file')
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function showFile(info) {
  fileInfo = info
  if (info) storeKey = 'heai-operator.map-editor.v1:' + info.path
  fileBtn.hidden = !(info && info.exists)
  if (info) fileBtn.textContent = `Reload ${info.name}`
}

/** Load the map file into the editor; false when there is none to load. */
async function loadFile() {
  const info = await fetchFile()
  showFile(info)
  if (!info || !info.exists) return false
  const v = await fetch('api/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ yaml: info.yaml })
  })
  adopt(info.yaml, await v.json())
  markClean(info.version, info.yaml)
  return true
}

fileBtn.addEventListener('click', async () => {
  if (dirty && !confirm('Discard the unsaved changes and reload the file?')) return
  await loadFile()
  setStatus('Reloaded', '')
  setTimeout(validateNow, 1200)
})

async function save(force = false) {
  const yaml = await serializeCurrent()
  if (!yaml || !fileInfo) return
  saving = true
  updateButtons()
  setStatus('Saving…', '')
  let res, body
  try {
    res = await fetch('api/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ yaml, base: baseVersion ?? '', force })
    })
    body = await res.json()
  } catch (e) {
    saving = false
    setStatus('Not saved: the server did not answer', 'err')
    updateButtons()
    return
  }
  saving = false
  if (res.ok) {
    showFile(body)
    markClean(body.version, body.yaml)
    setStatus('Saved ✓', 'ok')
    setTimeout(validateNow, 1200)
    return
  }
  if (res.status === 409) {
    updateButtons()
    const overwrite = confirm(
      `${fileInfo.name} changed on disk since this page loaded it.\n\n` +
        'OK overwrites it with what is here. Cancel keeps your edits unsaved, so you can ' +
        'export them, or reload the file to take the newer version.'
    )
    if (overwrite) return save(true)
    setStatus('Not saved: the file changed on disk', 'err')
    return
  }
  if (res.status === 422 && body.validation) {
    applyValidation(body.validation)
    setStatus('Not saved: the map does not validate', 'err')
    return
  }
  setStatus('Not saved: ' + (body.error || res.status), 'err')
  updateButtons()
}

saveBtn.addEventListener('click', () => save())

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault()
    if (!saveBtn.disabled) save()
  }
})

window.addEventListener('beforeunload', (e) => {
  // The draft is in localStorage either way; this only asks before leaving it there.
  if (dirty) e.preventDefault()
})

// ── Start ──

/** Restore a draft from localStorage as the map being edited. */
async function restoreDraft(stored) {
  if (stored.map) {
    mode = 'system'
    mapState = stored.map
    rawEditor.hidden = true
    systemView.hidden = false
    renderAll()
    validateNow()
    maybeReloadTree()
  } else {
    const res = await fetch('api/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ yaml: stored.yaml })
    })
    adopt(stored.yaml, await res.json())
  }
  baseVersion = stored.base ?? null
  baseYaml = stored.baseYaml ?? null
  dirty = true
  persist(false)
}

async function start() {
  const info = await fetchFile()
  showFile(info)
  const stored = readStore()
  lastChangeAt = stored?.updatedAt ?? null
  const hasDraft = stored && stored.dirty && (stored.map || (typeof stored.yaml === 'string' && stored.yaml.trim() !== ''))
  const current = info && info.exists ? info.version : ''
  if (hasDraft && (stored.base ?? '') === current) {
    await restoreDraft(stored)
    setStatus('Restored unsaved changes', 'warn')
    return
  }
  if (hasDraft &&
      confirm('This browser holds unsaved edits to the map, but the file changed on disk since they were made.\n\n' +
        'OK keeps the edits (Save will then ask before overwriting the newer file). Cancel discards them and loads the file.')) {
    await restoreDraft(stored)
    return
  }
  if (await loadFile()) return
  mapState = null
  baseVersion = ''
  baseYaml = null
  renderAll()
  applyValidation(null)
  renderStoreNote()
  openPasteDialog('')
}

start()

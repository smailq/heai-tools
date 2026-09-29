// The map editor's server side. The page (public/architect/, the architect tab) draws the architecture
// map and edits one field at a time; these endpoints validate through architect,
// serialize an edited map back to YAML without losing the file's comments, list
// the files each repository's localPath holds, and save the map - the one write
// this server makes, and only of the map.

import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { Document, isMap, isScalar, isSeq, parseDocument, Scalar, YAMLMap, YAMLSeq, type Node, Pair } from 'yaml'
import { message, run, which } from './run.ts'
import type { Tracker } from './tracker.ts'
import { valid } from './tracker.ts'

// ── The file ──

export interface FileState {
  path: string
  name: string
  exists: boolean
  yaml: string
  version: string
}

/** A version names one content of the map, so a save can say which one it replaces. */
export const version = (text: string): string => createHash('sha256').update(text).digest('hex')

export function readMapFile(path: string): FileState {
  const st: FileState = { path, name: basename(path), exists: false, yaml: '', version: '' }
  try {
    const text = readFileSync(path, 'utf8')
    return { ...st, exists: true, yaml: text, version: version(text) }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return st
    throw e
  }
}

/** Replaces path with text through a temporary file beside it, keeping the old file's mode, so no reader sees half a map. */
export function writeAtomic(path: string, text: string): void {
  let mode = 0o644
  try {
    mode = statSync(path).mode & 0o777
  } catch {
    // a new file
  }
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(tmp, text)
    chmodSync(tmp, mode)
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
}

// ── Validation, by architect ──

export interface Validation {
  valid: boolean
  errors: string[]
  warnings: string[]
  map?: unknown
}

/**
 * Validates a map's text with `heai-architect check --format json`, the reference
 * validator, through a temporary file: check takes a path, and the text being
 * edited is not the map on disk. Rejects when architect cannot be asked at all.
 */
export async function architectCheck(text: string): Promise<Validation> {
  const bin = which('heai-architect')
  if (!bin) throw new Error('heai-architect not on PATH')
  const dir = mkdtempSync(join(tmpdir(), 'heai-operator-web-'))
  const file = join(dir, 'architecture.yaml')
  try {
    writeFileSync(file, text)
    // check exits 1 for an invalid map and still prints its answer.
    const out = JSON.parse(await run(bin, ['check', file, '--format', 'json'], { name: 'architect', exit1OK: true, timeoutMs: 15_000 })) as Validation & { path?: string }
    delete out.path
    return { valid: out.valid, errors: out.errors ?? [], warnings: out.warnings ?? [], ...(out.map !== undefined ? { map: out.map } : {}) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function template(): Promise<string> {
  const bin = which('heai-architect')
  if (!bin) throw new Error('heai-architect not on PATH')
  return run(bin, ['template'], { name: 'architect' })
}

// ── Serializing, keeping the file's comments ──

const TO_STRING = { indent: 2, indentSeq: true, lineWidth: 0, flowCollectionPadding: false } as const

/** Short lists of plain values read best inline, as maps write globs and dependsOn; multiline strings as blocks. */
function style(node: unknown): void {
  if (isSeq(node)) {
    if (node.items.length <= 8 && node.items.every((i) => isScalar(i) && !(typeof i.value === 'string' && i.value.includes('\n')))) node.flow = true
    node.items.forEach(style)
  } else if (isMap(node)) {
    for (const p of node.items) style(p.value)
  } else if (isScalar(node) && typeof node.value === 'string' && node.value.includes('\n')) {
    node.type = Scalar.BLOCK_LITERAL
  }
}

function fresh(doc: Document, value: unknown): Node {
  const n = doc.createNode(value) as Node
  style(n)
  return n
}

const plainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * next as a node of doc, built from old wherever next leaves old's value as it was: a
 * mapping keeps old's pairs - their comments, their blank lines - in next's order; a list
 * merges item by item; a scalar that did not change keeps its quoting.
 */
function merge(doc: Document, old: unknown, next: unknown): Node {
  if (plainObject(next) && isMap(old)) {
    const pairs = new Map<unknown, Pair>()
    for (const p of (old as YAMLMap).items) pairs.set(isScalar(p.key) ? p.key.value : p.key, p as Pair)
    const items: Pair[] = []
    for (const [k, v] of Object.entries(next)) {
      const p = pairs.get(k)
      if (p) {
        p.value = merge(doc, p.value, v)
        items.push(p)
      } else items.push(new Pair(fresh(doc, k), fresh(doc, v)))
    }
    ;(old as YAMLMap).items = items
    return old as YAMLMap
  }
  if (Array.isArray(next) && isSeq(old)) {
    const seq = old as YAMLSeq
    seq.items = next.map((v, i) => (i < seq.items.length ? merge(doc, seq.items[i], v) : fresh(doc, v)))
    if (!next.length) seq.flow = true
    return seq
  }
  if (isScalar(old) && !plainObject(next) && !Array.isArray(next)) {
    if (old.value === next) return old
    old.value = next
    if (typeof next === 'string' && next.includes('\n')) old.type = Scalar.BLOCK_LITERAL
    else if (old.type === Scalar.BLOCK_LITERAL || old.type === Scalar.BLOCK_FOLDED) old.type = undefined
    return old
  }
  return fresh(doc, next)
}

/**
 * Puts back the spacing a line had before its trailing comment, on every line otherwise as
 * it was. The yaml library also writes the comment after a key whose value is a block
 * (`platform:   # the human one`) on the line below; where the base had them on one line,
 * they are joined again.
 */
function realignComments(out: string, base: string): string {
  const collapse = (l: string): string => l.replace(/\s+#/g, ' #')
  const orig = new Map<string, string>()
  for (const l of base.split('\n')) if (l.includes('#')) orig.set(collapse(l), l)
  const lines: string[] = []
  for (const l of out.split('\n')) {
    const prev = lines[lines.length - 1]
    if (prev !== undefined && l.trim().startsWith('#') && !prev.trim().startsWith('#')) {
      const joined = orig.get(collapse(`${prev} ${l.trim()}`))
      if (joined !== undefined) {
        lines[lines.length - 1] = joined
        continue
      }
    }
    lines.push(l.includes(' #') ? (orig.get(collapse(l)) ?? l) : l)
  }
  return lines.join('\n')
}

/**
 * A map object as YAML. With a base - the YAML the map was loaded from - everything the
 * object leaves as it was keeps the base's comments, quoting, blank lines and comment
 * alignment, so a saved map differs from the file by the lines that were edited.
 */
export function mapToYaml(map: unknown, base?: string): string {
  if (base) {
    const doc = parseDocument(base)
    if (!doc.errors.length && isMap(doc.contents)) {
      doc.contents = merge(doc, doc.contents, map) as never
      return realignComments(doc.toString(TO_STRING), base)
    }
  }
  const doc = new Document()
  doc.contents = fresh(doc, map) as never
  return doc.toString(TO_STRING)
}

// ── The file tree, from each repository's localPath ──

const FILE_LIMIT = 20_000
const SKIP = new Set(['.git', 'node_modules'])

export interface TreeRepo {
  name: string
  localPath: string | null
  root: string | null
  files: string[]
  truncated: boolean
  error?: string
}

function gitFiles(root: string): Promise<string[] | null> {
  try {
    statSync(join(root, '.git'))
  } catch {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    execFile('git', ['-C', root, 'ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024, timeout: 15_000 }, (err, stdout) => {
      resolve(err ? null : stdout.split('\0').filter(Boolean).slice(0, FILE_LIMIT))
    })
  })
}

function walkFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // an unreadable directory is skipped rather than failing the whole tree
    }
    for (const e of entries) {
      if (files.length >= FILE_LIMIT) return
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(join(dir, e.name))
      } else if (e.isFile()) files.push(relative(root, join(dir, e.name)).split(sep).join('/'))
    }
  }
  walk(root)
  return files
}

/** Each repository's files, from the localPath its entry declares; a relative one resolves against the map's directory. */
export async function tree(repositories: Record<string, { localPath?: unknown }>, base: string): Promise<TreeRepo[]> {
  const out: TreeRepo[] = []
  for (const [name, repo] of Object.entries(repositories)) {
    const declared = typeof repo?.localPath === 'string' && repo.localPath ? repo.localPath : null
    if (!declared) {
      out.push({ name, localPath: null, root: null, files: [], truncated: false })
      continue
    }
    let root = declared === '~' || declared.startsWith('~/') ? join(homedir(), declared.slice(1)) : declared
    if (!isAbsolute(root)) root = join(base, root)
    let dir = false
    try {
      dir = statSync(root).isDirectory()
    } catch {
      dir = false
    }
    if (!dir) {
      out.push({ name, localPath: declared, root, files: [], truncated: false, error: 'no such directory on this machine' })
      continue
    }
    const files = ((await gitFiles(root)) ?? walkFiles(root)).sort()
    out.push({ name, localPath: declared, root, files, truncated: files.length >= FILE_LIMIT })
  }
  return out
}

/** The tracker this server reads, in the shape the editor's Actors tab lists. */
export function taskRows(t: Tracker | null): object[] {
  return (t?.tasks ?? []).filter(valid).map((task) => ({
    slug: task.slug,
    title: task.title,
    status: task.status,
    priority: task.priority,
    territory: task.territories.join(','),
    created_at: task.created_at,
    modified_at: task.modified_at,
    body: task.body.slice(0, 4000)
  }))
}

export { message }

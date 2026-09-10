// The small `{{ }}` templates a rule may use: a path into the event, and two
// filters, `default` and `join`. Nothing else; a rule that needs logic runs
// a command. A template that is one expression and nothing around it keeps
// the value's type, so `{{ payload.number }}` in a fact's data stays a number.

import { isRecord, UsageError } from './errors.ts'

const EXPR = /\{\{\s*([^}]*?)\s*\}\}/g

function lookup(root: unknown, path: string): unknown {
  let v: unknown = root
  for (const part of path.split('.')) {
    if (part === '') continue
    if (Array.isArray(v) && /^\d+$/.test(part)) v = v[Number(part)]
    else if (isRecord(v)) v = v[part]
    else return undefined
  }
  return v
}

function unquote(raw: string): string {
  const s = raw.trim()
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) return s.slice(1, -1)
  return s
}

const empty = (v: unknown): boolean => v === undefined || v === null || v === ''

export function stringify(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(stringify).join(', ')
  return JSON.stringify(v)
}

function evaluate(expr: string, ctx: unknown): unknown {
  const [pathRaw, ...filters] = expr.split('|')
  let v = lookup(ctx, pathRaw!.trim())
  for (const f of filters) {
    const m = f.trim().match(/^([a-z]+)(?::\s*(.*))?$/)
    if (!m) throw new UsageError(`template: cannot read filter ${JSON.stringify(f.trim())}`)
    const [, name, arg] = m
    if (name === 'default') {
      if (empty(v)) v = unquote(arg ?? '')
    } else if (name === 'join') {
      const sep = arg === undefined ? ', ' : unquote(arg)
      v = Array.isArray(v) ? v.map(stringify).join(sep) : stringify(v)
    } else throw new UsageError(`template: unknown filter ${JSON.stringify(name)}; the filters are default and join`)
  }
  return v
}

/** Render one template string against a context. */
export function render(template: string, ctx: unknown): unknown {
  const whole = template.match(/^\{\{\s*([^}]*?)\s*\}\}$/)
  if (whole) return evaluate(whole[1]!, ctx)
  return template.replace(EXPR, (_, expr: string) => stringify(evaluate(expr, ctx)))
}

export const renderString = (template: string, ctx: unknown): string => stringify(render(template, ctx))

/** Render every string inside a value, recursively; other scalars pass through. */
export function renderDeep(value: unknown, ctx: unknown): unknown {
  if (typeof value === 'string') return render(value, ctx)
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, ctx))
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, ctx)]))
  return value
}

// HTML by tagged template: every interpolated value is escaped unless it is
// already markup, so a task title, a flow's link or an event payload can never
// become part of the page.

export class Html {
  readonly value: string
  constructor(value: string) {
    this.value = value
  }
  toString(): string {
    return this.value
  }
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

type Value = Html | string | number | boolean | null | undefined | Value[]

function render(v: Value): string {
  if (v === null || v === undefined || v === false) return ''
  if (v instanceof Html) return v.value
  if (Array.isArray(v)) return v.map(render).join('')
  return esc(String(v))
}

export function html(strings: TemplateStringsArray, ...values: Value[]): Html {
  let out = strings[0]!
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1]!
  })
  return new Html(out)
}

/** Markup made elsewhere and already safe: the state-machine SVG. */
export const raw = (s: string): Html => new Html(s)

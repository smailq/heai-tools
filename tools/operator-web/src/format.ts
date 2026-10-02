// Numbers as the screen writes them: a duration in one unit, an age, a time of day.

/** A duration in one unit: 42s, 6m, 2h, 3d; under a second, ms. */
export function short(ms: number): string {
  if (ms < 0) ms = 0
  if (ms < 1000 && ms > 0) return `${Math.floor(ms)}ms`
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 48 * 3_600_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}

/** "6m ago", or "-" for never. */
export const ago = (t: number, now: number): string => (t ? `${short(now - t)} ago` : '-')

/** How long ago a timestamp was, "-" when it does not read. */
export function since(ts: string | null | undefined, now: number): string {
  const t = ts ? Date.parse(ts) : NaN
  return Number.isNaN(t) ? '-' : short(now - t)
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** A timestamp as the time of day when it is today, else the date and time; UTC, as the tools record it. */
export function clock(ts: string | null | undefined, now: number): string {
  const t = ts ? new Date(ts) : null
  if (!t || Number.isNaN(t.getTime())) return '-'
  const n = new Date(now)
  const time = `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`
  if (t.getUTCFullYear() === n.getUTCFullYear() && t.getUTCMonth() === n.getUTCMonth() && t.getUTCDate() === n.getUTCDate()) return time
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${time.slice(0, 5)}`
}

/** A YYYY-MM-DD as days ago: "today", "3d". */
export function ageDays(date: string, now: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return '-'
  const d = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const n = new Date(now)
  const today = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())
  const days = Math.floor((today - d) / 86_400_000)
  return days <= 0 ? 'today' : `${days}d`
}

export const orDash = (s: string | null | undefined): string => (s ? s : '-')

/** A time of day for the header. */
export function hms(now: number): string {
  const n = new Date(now)
  return `${pad(n.getUTCHours())}:${pad(n.getUTCMinutes())}:${pad(n.getUTCSeconds())}`
}

/** An interval as a definition spells it: 12h, 10m, 90s. */
export function spelled(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}

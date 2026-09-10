// Cron, parsed here: five fields, `*`, lists, ranges, steps, month and day
// names, and the @ aliases. A slot is a minute the expression names; the
// schedule source asks for the latest slot at or before now, and for the
// slots between two times, which is how a missed one is reported.

import { UsageError } from './errors.ts'

export interface Cron {
  text: string
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  /** Vixie's rule: when both day fields are restricted, a date matches either. */
  domAny: boolean
  dowAny: boolean
}

const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *'
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function parseField(raw: string, min: number, max: number, names: string[], where: string): { set: Set<number>; any: boolean } {
  const set = new Set<number>()
  const bad = (): never => {
    throw new UsageError(`${where}: cannot read ${JSON.stringify(raw)} in ${JSON.stringify(where)}`)
  }
  const value = (s: string): number => {
    const i = names.indexOf(s.toLowerCase())
    if (i >= 0) return min + i
    if (!/^\d+$/.test(s)) bad()
    return Number(s)
  }
  let any = false
  for (const part of raw.split(',')) {
    const m = part.match(/^([^/]+)(?:\/(\d+))?$/)
    if (!m) bad()
    const [, range, stepRaw] = m!
    const step = stepRaw ? Number(stepRaw) : 1
    if (step < 1) bad()
    let lo: number
    let hi: number
    if (range === '*') {
      lo = min
      hi = max
      if (!stepRaw) any = true
    } else if (range!.includes('-')) {
      const [a, b] = range!.split('-')
      lo = value(a!)
      hi = value(b!)
    } else {
      lo = value(range!)
      hi = stepRaw ? max : lo
    }
    if (lo < min || hi > max || lo > hi) bad()
    for (let v = lo; v <= hi; v += step) set.add(v)
  }
  return { set, any }
}

export function parseCron(text: string, where = 'cron'): Cron {
  const expr = (ALIASES[text.trim()] ?? text).trim().split(/\s+/)
  if (expr.length !== 5) throw new UsageError(`${where}: ${JSON.stringify(text)} must have five fields: minute hour day month weekday`)
  const minute = parseField(expr[0]!, 0, 59, [], text)
  const hour = parseField(expr[1]!, 0, 23, [], text)
  const dom = parseField(expr[2]!, 1, 31, [], text)
  const month = parseField(expr[3]!, 1, 12, MONTHS, text)
  const dow = parseField(expr[4]!, 0, 7, DAYS, text)
  if (dow.set.has(7)) {
    dow.set.delete(7)
    dow.set.add(0)
  }
  return { text, minute: minute.set, hour: hour.set, dom: dom.set, month: month.set, dow: dow.set, domAny: dom.any, dowAny: dow.any }
}

interface Calendar {
  y(d: Date): number
  mo(d: Date): number
  day(d: Date): number
  h(d: Date): number
  mi(d: Date): number
  dow(d: Date): number
  make(y: number, mo: number, day: number, h: number, mi: number): Date
}

const LOCAL: Calendar = {
  y: (d) => d.getFullYear(),
  mo: (d) => d.getMonth(),
  day: (d) => d.getDate(),
  h: (d) => d.getHours(),
  mi: (d) => d.getMinutes(),
  dow: (d) => d.getDay(),
  make: (y, mo, day, h, mi) => new Date(y, mo, day, h, mi)
}
const UTC: Calendar = {
  y: (d) => d.getUTCFullYear(),
  mo: (d) => d.getUTCMonth(),
  day: (d) => d.getUTCDate(),
  h: (d) => d.getUTCHours(),
  mi: (d) => d.getUTCMinutes(),
  dow: (d) => d.getUTCDay(),
  make: (y, mo, day, h, mi) => new Date(Date.UTC(y, mo, day, h, mi))
}

const cal = (utc: boolean): Calendar => (utc ? UTC : LOCAL)

function dayMatches(c: Cron, k: Calendar, d: Date): boolean {
  const dom = c.dom.has(k.day(d))
  const dow = c.dow.has(k.dow(d))
  if (c.domAny && c.dowAny) return true
  if (c.domAny) return dow
  if (c.dowAny) return dom
  return dom || dow
}

/** Whether the minute `d` falls in is one the expression names. */
export function matches(c: Cron, d: Date, utc = false): boolean {
  const k = cal(utc)
  return c.month.has(k.mo(d) + 1) && dayMatches(c, k, d) && c.hour.has(k.h(d)) && c.minute.has(k.mi(d))
}

const floorMinute = (d: Date): Date => new Date(Math.floor(d.getTime() / 60_000) * 60_000)
const LIMIT = 200_000

/** The latest slot at or before `now`, or null when the expression never fires. */
export function previousSlot(c: Cron, now: Date, utc = false): Date | null {
  const k = cal(utc)
  let d = floorMinute(now)
  const floor = now.getTime() - 5 * 366 * 86_400_000
  for (let i = 0; i < LIMIT && d.getTime() >= floor; i++) {
    if (!c.month.has(k.mo(d) + 1)) d = k.make(k.y(d), k.mo(d), 0, 23, 59)
    else if (!dayMatches(c, k, d)) d = k.make(k.y(d), k.mo(d), k.day(d) - 1, 23, 59)
    else if (!c.hour.has(k.h(d))) d = k.make(k.y(d), k.mo(d), k.day(d), k.h(d) - 1, 59)
    else if (!c.minute.has(k.mi(d))) d = k.make(k.y(d), k.mo(d), k.day(d), k.h(d), k.mi(d) - 1)
    else return d
  }
  return null
}

/** The first slot strictly after `after`, or null when the expression never fires again within five years. */
export function nextSlot(c: Cron, after: Date, utc = false): Date | null {
  const k = cal(utc)
  let d = new Date(floorMinute(after).getTime() + 60_000)
  const ceiling = after.getTime() + 5 * 366 * 86_400_000
  for (let i = 0; i < LIMIT && d.getTime() <= ceiling; i++) {
    if (!c.month.has(k.mo(d) + 1)) d = k.make(k.y(d), k.mo(d) + 1, 1, 0, 0)
    else if (!dayMatches(c, k, d)) d = k.make(k.y(d), k.mo(d), k.day(d) + 1, 0, 0)
    else if (!c.hour.has(k.h(d))) d = k.make(k.y(d), k.mo(d), k.day(d), k.h(d) + 1, 0)
    else if (!c.minute.has(k.mi(d))) d = k.make(k.y(d), k.mo(d), k.day(d), k.h(d), k.mi(d) + 1)
    else return d
  }
  return null
}

/** Every slot after `after` and before `until`, both exclusive, at most `cap` of them. */
export function slotsBetween(c: Cron, after: Date, until: Date, utc = false, cap = 1000): Date[] {
  const out: Date[] = []
  let d: Date | null = after
  while (out.length < cap) {
    d = nextSlot(c, d, utc)
    if (!d || d.getTime() >= until.getTime()) break
    out.push(d)
  }
  return out
}

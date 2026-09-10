// Matching: whether a rule's `on` describes an event. Source and kind by
// name, a cron against a schedule slot, and every other key as a path into
// the payload that must equal the value given.

import { matches as cronMatches, parseCron } from './cron.ts'
import { isRecord } from './errors.ts'
import { globMatch, type Event } from './events.ts'
import type { Match, Rule } from './config.ts'
import { renderString } from './template.ts'

function lookup(root: unknown, path: string): unknown {
  let v: unknown = root
  for (const part of path.split('.')) {
    if (Array.isArray(v) && /^\d+$/.test(part)) v = v[Number(part)]
    else if (isRecord(v)) v = v[part]
    else return undefined
  }
  return v
}

const equal = (actual: unknown, expected: unknown): boolean => {
  if (Array.isArray(actual) && !Array.isArray(expected)) return actual.some((a) => equal(a, expected))
  if (typeof actual === 'number' && typeof expected === 'string') return String(actual) === expected
  return actual === expected
}

export function matchEvent(on: Match, event: Event): boolean {
  if (on.source !== null && on.source !== event.source) return false
  if (on.kind !== null && !globMatch(on.kind, event.kind)) return false
  if (on.cron !== null) {
    const slot = event.payload['slot']
    if (typeof slot !== 'string') return false
    if (!cronMatches(parseCron(on.cron), new Date(slot), event.payload['utc'] === true)) return false
  }
  for (const [k, expected] of Object.entries(on.fields)) {
    const actual = lookup(event.payload, k)
    if (isRecord(expected)) {
      if (!isRecord(actual) || !Object.entries(expected).every(([kk, vv]) => equal(lookup(actual, kk), vv))) return false
    } else if (!equal(actual, expected)) return false
  }
  return true
}

/** The context a template sees: the payload's fields at the top, then the event's. */
export function templateContext(event: Event, rule: string): Record<string, unknown> {
  return { ...event.payload, payload: event.payload, event: { id: event.id, source: event.source, kind: event.kind, key: event.key, at: event.at }, source: event.source, kind: event.kind, key: event.key, at: event.at, rule }
}

/** A rule's command with every template rendered against the event. */
export const renderCommand = (command: string, event: Event, rule: string): string => renderString(command, templateContext(event, rule))

export const matchingRules = (rules: Rule[], event: Event): Rule[] => rules.filter((r) => matchEvent(r.on, event))

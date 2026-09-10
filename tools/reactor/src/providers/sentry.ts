// Sentry: Sentry-Hook-Signature is an HMAC-SHA256 of the raw body, the
// resource is a header and the action is in the body, so kind is
// <resource>.<action>: issue.created, issue.resolved. The issue's fields are
// hoisted to the top of the payload - title, culprit, count, firstSeen, url -
// and its tags become a record, so `{{ payload.tags.territory }}` reads.

import { isRecord } from '../errors.ts'
import { sha256 } from '../events.ts'
import type { Provider } from './index.ts'
import { hmacHex, sameDigest } from './sign.ts'

export const sentry: Provider = {
  verify(headers, body, secret) {
    const sig = headers['sentry-hook-signature']
    if (!sig) return 'no Sentry-Hook-Signature header'
    return sameDigest(sig, hmacHex('sha256', secret, body)) ? true : 'Sentry-Hook-Signature does not match'
  },
  parse(headers, doc, body) {
    if (!isRecord(doc)) return null
    const resource = headers['sentry-hook-resource'] ?? 'event'
    const action = typeof doc['action'] === 'string' ? doc['action'] : 'received'
    const data = isRecord(doc['data']) ? doc['data'] : {}
    const issue = isRecord(data['issue']) ? data['issue'] : isRecord(data['event']) ? data['event'] : {}
    const tags: Record<string, unknown> = {}
    if (Array.isArray(issue['tags'])) {
      for (const t of issue['tags']) if (isRecord(t) && typeof t['key'] === 'string') tags[t['key']] = t['value']
    } else if (isRecord(issue['tags'])) Object.assign(tags, issue['tags'])
    const id = typeof issue['id'] === 'string' || typeof issue['id'] === 'number' ? String(issue['id']) : null
    const payload: Record<string, unknown> = { ...doc, id, title: issue['title'] ?? null, culprit: issue['culprit'] ?? null, count: issue['count'] ?? null, firstSeen: issue['firstSeen'] ?? null, url: issue['permalink'] ?? issue['web_url'] ?? null, tags }
    return { kind: `${resource}.${action}`, key: `${resource}.${action}@${id ?? headers['request-id'] ?? sha256(body.toString('utf8'))}`, payload }
  }
}

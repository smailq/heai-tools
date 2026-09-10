// Vercel: x-vercel-signature is an HMAC-SHA1 of the raw body; the body is
// { id, type, createdAt, payload }. kind is the type as Vercel names it -
// deployment.created, deployment.succeeded, deployment.error - and the
// deployment's name and url are hoisted to the top of the payload.

import { isRecord } from '../errors.ts'
import { sha256 } from '../events.ts'
import type { Provider } from './index.ts'
import { hmacHex, sameDigest } from './sign.ts'

export const vercel: Provider = {
  verify(headers, body, secret) {
    const sig = headers['x-vercel-signature']
    if (!sig) return 'no x-vercel-signature header'
    return sameDigest(sig, hmacHex('sha1', secret, body)) ? true : 'x-vercel-signature does not match'
  },
  parse(_headers, doc, body) {
    if (!isRecord(doc) || typeof doc['type'] !== 'string') return null
    const inner = isRecord(doc['payload']) ? doc['payload'] : {}
    const deployment = isRecord(inner['deployment']) ? inner['deployment'] : {}
    const payload: Record<string, unknown> = { ...inner, type: doc['type'], id: doc['id'] ?? null, createdAt: doc['createdAt'] ?? null, name: deployment['name'] ?? inner['name'] ?? null, url: deployment['url'] ?? inner['url'] ?? null }
    return { kind: doc['type'], key: typeof doc['id'] === 'string' ? doc['id'] : sha256(body.toString('utf8')), payload }
  }
}

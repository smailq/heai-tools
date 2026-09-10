// Generic: any JSON, authorized by a bearer token. kind comes from the
// source's `kind` pointer, else the body's `kind` or `type`, else `event`;
// key from its `key` pointer, else the body's `id`, else a hash of the body.

import { isRecord } from '../errors.ts'
import { sha256 } from '../events.ts'
import { pointer } from '../sources/poll.ts'
import type { Provider } from './index.ts'
import { sameDigest } from './sign.ts'

export const generic: Provider = {
  verify(headers, _body, secret) {
    const auth = headers['authorization']
    if (!auth) return 'no Authorization header'
    if (!auth.startsWith('Bearer ')) return 'Authorization is not a bearer token'
    return sameDigest(auth.slice(7).trim(), secret) ? true : 'bearer token does not match'
  },
  parse(_headers, doc, body, options) {
    const payload: Record<string, unknown> = isRecord(doc) ? doc : { body: doc }
    const kindRaw = options.kind ? pointer(doc, options.kind) : (payload['kind'] ?? payload['type'])
    const kind = typeof kindRaw === 'string' && kindRaw ? kindRaw : 'event'
    const keyRaw = options.key ? pointer(doc, options.key) : payload['id']
    const key = keyRaw === undefined || keyRaw === null ? sha256(body.toString('utf8')) : String(keyRaw)
    return { kind, key, payload }
  }
}

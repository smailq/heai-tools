// GitHub: X-Hub-Signature-256 over the raw body, kind <event>.<action>,
// key the delivery id. For a pull_request event, `merged`, `merge_commit_sha`
// and `number` are hoisted to the top of the payload so a rule can say
// `merged: true` and a template `{{ payload.merge_commit_sha }}`.

import { isRecord } from '../errors.ts'
import { sha256 } from '../events.ts'
import type { Provider } from './index.ts'
import { hmacHex, sameDigest } from './sign.ts'

export const github: Provider = {
  verify(headers, body, secret) {
    const sig = headers['x-hub-signature-256']
    if (!sig) return 'no X-Hub-Signature-256 header'
    if (!sig.startsWith('sha256=')) return 'X-Hub-Signature-256 is not sha256='
    return sameDigest(sig.slice(7), hmacHex('sha256', secret, body)) ? true : 'X-Hub-Signature-256 does not match'
  },
  parse(headers, doc, body) {
    if (!isRecord(doc)) return null
    const event = headers['x-github-event']
    if (!event) return null
    const action = typeof doc['action'] === 'string' ? doc['action'] : null
    const payload: Record<string, unknown> = { ...doc }
    const pr = doc['pull_request']
    if (isRecord(pr)) {
      payload['merged'] ??= pr['merged'] ?? false
      payload['merge_commit_sha'] ??= pr['merge_commit_sha'] ?? null
      payload['number'] ??= pr['number']
    }
    return { kind: action ? `${event}.${action}` : event, key: headers['x-github-delivery'] ?? sha256(body.toString('utf8')), payload }
  }
}

// Signature helpers the providers share: an HMAC over the raw body, and a
// constant-time comparison of two digests.

import { createHmac, timingSafeEqual } from 'node:crypto'

export const hmacHex = (algorithm: string, secret: string, body: Buffer): string => createHmac(algorithm, secret).update(body).digest('hex')

export function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a.toLowerCase(), 'utf8')
  const y = Buffer.from(b.toLowerCase(), 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

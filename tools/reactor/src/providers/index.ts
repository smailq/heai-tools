// A provider is a parser of thirty lines: it checks the signature its
// service sends and turns the body into { kind, key, payload }. A fifth
// provider is a fifth file here.

import type { RawEvent } from '../events.ts'
import { github } from './github.ts'
import { sentry } from './sentry.ts'
import { vercel } from './vercel.ts'
import { generic } from './generic.ts'

export interface ProviderOptions {
  kind: string | null
  key: string | null
}

export interface Provider {
  /** `true`, or why the post is dropped. */
  verify(headers: Record<string, string>, body: Buffer, secret: string): true | string
  parse(headers: Record<string, string>, doc: unknown, body: Buffer, options: ProviderOptions): RawEvent | null
}

export const PROVIDERS: Record<string, Provider> = { github, sentry, vercel, generic }

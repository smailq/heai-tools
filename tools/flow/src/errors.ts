// The two kinds of "no". A UsageError is the caller's mistake - a bad flag, an
// unknown flow or definition, a definition that does not validate - and exits
// 2. A FlowError is an answer: the move is not legal, the race was lost, the
// lock is held; those exit 1. `not-found` is a question that could not be
// asked, so the CLI maps it to 2 like a usage error.

export class UsageError extends Error {
  override name = 'UsageError'
}

export type FlowErrorCode = 'refused' | 'conflict' | 'not-found' | 'locked'

export class FlowError extends Error {
  override name = 'FlowError'
  code: FlowErrorCode
  constructor(code: FlowErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

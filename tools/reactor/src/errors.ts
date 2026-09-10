// Two kinds of failure, matching the exit-code split every tool here makes:
// a UsageError is exit 2, the question could not be asked; a ReactorError
// is exit 1, the answer was no - an action failed, a rule refused.

export class UsageError extends Error {
  override name = 'UsageError'
}

export class ReactorError extends Error {
  override name = 'ReactorError'
}

export const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

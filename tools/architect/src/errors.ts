/**
 * A problem that makes the question unanswerable, as opposed to a "no": the map
 * or the schema cannot be read, the map does not validate, or the invocation is
 * wrong. Exit 2, the split every tool here makes.
 */
export class UsageError extends Error {}

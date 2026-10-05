// The library surface: what a TypeScript program imports by package name. Everything here is also reachable from the `architect` command.
export { UsageError } from './errors.ts'
export {
  claims,
  createValidator,
  entriesFor,
  TEMPLATE,
  unownedPosture,
  type ArchitectureMap,
  type Exclusion,
  type Repository,
  type ScopeEntry,
  type Territory,
  type UndeclaredPosture,
  type UnownedPosture,
  type ValidationResult,
  type Validator
} from './validate.ts'
export { compileGlob, contains, GlobError, intersects, matchesAny, matchesGlob, validateGlob } from './glob.ts'
export {
  contextChain,
  DEFAULT_SCHEMA,
  loadMap,
  resolveMapPath,
  territoriesView,
  territoryOf,
  type ContextLayer,
  type LoadedMap,
  type TerritoryAnswer,
  type TerritoryView
} from './query.ts'
export { parseDiffPaths } from './diff.ts'
export {
  claimants,
  resolveRepository,
  resolveSubject,
  runGate,
  subjectGlobs,
  type Classification,
  type Finding,
  type GateInput,
  type GateResult,
  type Subject
} from './gate.ts'

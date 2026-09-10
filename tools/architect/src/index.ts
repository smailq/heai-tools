// The library surface: what map-editor and any other tool import by package
// name. Everything here is also reachable from the `architect` command.
export { UsageError } from './errors.ts'
export {
  claims,
  createValidator,
  effectiveOwner,
  entriesFor,
  TEMPLATE,
  unownedPosture,
  type Actor,
  type ActorType,
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
  actorContext,
  actorsView,
  contextChain,
  DEFAULT_SCHEMA,
  loadMap,
  ownerOf,
  resolveMapPath,
  territoriesView,
  type ActorView,
  type ContextLayer,
  type LoadedMap,
  type OwnerAnswer,
  type TerritoryView
} from './query.ts'
export { parseDiffPaths } from './diff.ts'
export {
  claimants,
  resolveRepository,
  resolveSubject,
  runGate,
  subjectGlobs,
  territoriesOwnedBy,
  type Classification,
  type Finding,
  type GateInput,
  type GateResult,
  type Subject,
  type SubjectKind,
  type SubjectRequest
} from './gate.ts'

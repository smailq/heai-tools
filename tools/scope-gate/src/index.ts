export { GlobError, compileGlob, matchesAny, matchesGlob, validateGlob } from './glob.ts'
export { parseDiffPaths } from './diff.ts'
export {
  type Actor,
  type ActorType,
  type ArchitectureMap,
  type Exclusion,
  type Repository,
  type ScopeEntry,
  type Subject,
  type SubjectKind,
  type SubjectRequest,
  type Territory,
  type UnownedPosture,
  UsageError,
  actorType,
  claimants,
  claims,
  entriesFor,
  loadMap,
  ownerOf,
  resolveRepository,
  resolveSubject,
  territoriesOwnedBy,
  unownedPosture,
  validateGlobs
} from './map.ts'
export {
  type Classification,
  type Finding,
  type GateInput,
  type GateResult,
  runGate,
  subjectGlobs
} from './gate.ts'

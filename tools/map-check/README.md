# @heai-tools/map-check

The reference validator for the architecture map, as a command and as a library, with the map queries other tools need.

```sh
npm install
node src/cli.ts architecture.yaml     # valid, or every error and warning; exit 0, 1 or 2
node src/cli.ts owner src/db/schema.ts
```

Requires Node 22.18 or newer, which runs the TypeScript sources directly.
`npm install` pulls two runtime dependencies: a YAML parser and a JSON Schema validator.

## Two surfaces, one implementation

**The command** reads a map, checks it against [`schemas/architecture.schema.json`](../../schemas/architecture.schema.json) and then against every rule [`docs/architecture-map.md`](../../docs/architecture-map.md) lists as one a validator must enforce beyond the schema, and answers with the exit-code split every tool here uses.
CI runs it; a human runs it before committing a map; another tool shells out to it for an answer about the map.

**The library**, `@heai-tools/map-check`, is the same code behind a package name: `createValidator`, the glob dialect, and the queries.
`map-editor` depends on it by name and validates on every keystroke through it.
That is the "published" path the design principles allow: a tool never imports another's source, but may depend on another's package, resolved locally by `file:../map-check` and, once published, by version.

Because the sources are TypeScript run directly, the package resolves through a symlink so Node strips types outside `node_modules`; publishing to a registry would need an emitted `dist/`, which is deferred until there is a consumer outside this repository.

## The spec is normative; this is its reference

Every error and warning the spec lists is enforced here, and only here in full: `scope-gate` carries a partial reader of its own because a CI gate must not depend on a second install, and it is held to the spec and to this tool's test cases, not to this tool's code.
The glob dialect lives here too; `scope-gate` implements it separately, and `test/glob.test.ts` holds the same cases on both sides, which is what keeps them agreeing.
A rule added to the spec is added here in the same review.

## The command

```
map-check [<map>] [--format text|json] [--schema <path>] [--strict]
map-check owner <path> [--repo <name>] [--json]
map-check territories [--actor <name>] [--json]
map-check actors [--json]
map-check context <actor>|<territory> [--json]
map-check template
```

`<map>` defaults to `.heai/architecture.yaml`, else `architecture.yaml`, or `HEAI_MAP`.
The schema defaults to this repository's, beside the tools, or `HEAI_SCHEMA` / `--schema`, so a linked install finds the contract and a copied one is told where it is.

**Validate** (the bare command) prints each error and warning on its own line, then one line saying `valid`, `valid with N warnings`, or `N errors`.
`--strict` makes warnings fail too, for a CI that wants a clean map.
`--format json` prints `{ "path", "valid", "errors": [], "warnings": [], "map": {...} }` - the shape `map-editor`'s API returns - with `map` the parsed document when it has no errors.

**owner** resolves one repository-relative path to the territory whose effective scope holds it - globs, minus exclusions, minus children - and that territory's owner and owner type.
`--repo` names the repository when the map governs several.
This is the lookup every path-attributing tool needs once: which lane a run lands in, which actor an alert routes to.

**territories** and **actors** list what the map declares with owners resolved through the parent chain, globs, parents, dependency edges, and what each actor owns and watches.
**context** prints what an actor is composed with - its own context, then each owned territory's chain, then each watched one marked as watched with its owner - or a territory's chain, ancestors outermost first.
An `agents build` projection is a shell-out to it.

**template** prints the starter map the editor seeds a new document with.

A query refuses, with exit `2`, to answer for a map that does not validate: an owner resolved over an overlapping map would be a guess.

### Exit codes

| code | meaning |
| --- | --- |
| `0` | valid; or the query answered (for `owner`, the path is claimed) |
| `1` | errors; warnings under `--strict`; or the path is unowned |
| `2` | the map or the schema cannot be read, the map is not version 1, a query over an invalid map, or bad usage |

It is the same split `scope-gate` and `task-manager` make.

## The library

```ts
import { createValidator, loadMap, ownerOf, actorContext, matchesGlob } from '@heai-tools/map-check'

const { result } = loadMap('architecture.yaml')          // { valid, errors, warnings, map }
if (result.map) ownerOf(result.map, 'src/db/schema.ts')  // { territory, owner, ownerType, ... }
```

`src/index.ts` is the whole surface: the types, `createValidator` with `validate(yaml)` and `validateDoc(object)`, `effectiveOwner`, `claims`, `unownedPosture`, `TEMPLATE`; the glob dialect (`compileGlob`, `matchesGlob`, `matchesAny`, `intersects`, `contains`, `validateGlob`); and the queries (`loadMap`, `resolveMapPath`, `ownerOf`, `territoriesView`, `actorsView`, `contextChain`, `actorContext`).
Anything not exported there is not part of the contract.

## Tests

```sh
npm test        # the glob dialect, the schema and semantic rules, the queries, the command
npm run typecheck
```

`test/glob.test.ts` pins the dialect - the same cases `scope-gate` pins.
`test/validate.test.ts` pins every rule the spec lists.
`test/cli.test.ts` pins the exit codes and both output formats against a spawned process.

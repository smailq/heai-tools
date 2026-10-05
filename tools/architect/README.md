# @heai-tools/architect

The architecture map as one tool: it validates the map, answers questions about it, and checks a diff against the territory a change was scoped to, as a command and as a TypeScript library.

```sh
heai-architect check                                      # the map is valid, or every error and warning
heai-architect territory src/core/db/schema.ts            # which territory claims a path
git diff origin/main... | heai-architect gate api         # did this change stay inside api?
```

Requires Node 22.18 or newer. Released as `@heai-tools/architect` on npm: `npm install -g @heai-tools/architect` puts `heai-architect` on PATH.
From this directory, `npm install` pulls two runtime dependencies, a YAML parser and a JSON Schema validator, and builds the command into `dist/`; `npm link` puts it on the path as `heai-architect`. During development `node src/cli.ts` runs the sources directly.

## The map

The architecture map is one file, by convention `architecture.yaml`, holding a system's **territories**, **architectural guardrails**, and a **visualizable picture of the architecture**, across one or more repositories.
It plays four roles:

- **Defines** the architecture - each governed path falls in at most one territory, exactly one where the map is exhaustive, and each territory declares which territories it may depend on.
- **Enforces** it - the map is the direct input to the guardrails: the scope gate in this tool, and the import-boundary and context checks that read the same file, in CI and locally.
- **Informs whoever works there** - a territory carries a `context`, what anyone working or judging in it needs to know, and `heai-architect context <territory>` prints it for a prompt.
- **Lets a team manage the architecture** - a boundary, an edge, or a territory's context changes by editing this one file, so the review of that edit *is* the architectural decision.
  Visualizations render from the map, never from a separate diagram.

What the map does not hold is who does the work.
A unit of work - a task - names the territory it is scoped to and whoever will do it; the map says where that territory is and what it takes to work there, and the gate holds the change inside it.
Agents, reviewers, approvers and the order they run in are the process's, not the architecture's.

Its shape is [`schemas/architecture.schema.json`](schemas/architecture.schema.json), a JSON Schema whose field descriptions are the reference for each key.
This section is the rest: what the fields mean together, the rules the schema cannot express, and what the tool does with them.

### An example

```yaml
version: 1
unowned: fail                      # a path no territory claims is a violation

repositories:
  app:
    remotePath: github.com/example/app
    localPath: ../app              # where a checkout sits on this machine

territories:
  platform:                        # CI, the map, guard tooling: what governs the rest
    scope:
      - repository: app
        globs: ['architecture.yaml', '.github/**', 'ci/**']
    context: A change here changes what every other change is judged by; it lands only through the approval flow.

  core:
    scope:
      - repository: app
        globs: ['src/core/**']
    context: |
      Invariants: no I/O in the domain model; every aggregate has a test.

  core-db:                         # a child: carved out of core, with core's context layered on its own
    parent: core
    scope:
      - repository: app
        globs: ['src/core/db/**']
    context: Migrations are append-only.

  api:
    scope:
      - repository: app
        globs: ['src/api/**']
    dependsOn: [core]              # api may import core, and nothing else
    undeclaredDependencies: warn   # while its imports are still being described
    context: Keep handlers thin; business rules live in core.

  docs:                            # a catch-all that yields to its siblings
    scope:
      - repository: app
        globs: ['**']
        exclude:
          territories: [platform, core, api]
```

Against this map:

```
$ heai-architect territory src/core/db/schema.ts
src/core/db/schema.ts  core-db

$ printf 'src/api/x.ts\nsrc/core/y.ts\n' | heai-architect gate api
scope gate: FAIL
  scope       territory api
  repository  app
  changed     2 files changed, 1 violation

  ✗ outside  src/core/y.ts
             in core, outside the scope; scope the task to it or move the boundary

  the scope is: src/api/**

$ heai-architect context core-db
# territory:core

Invariants: no I/O in the domain model; every aggregate has a test.

# territory:core-db

Migrations are append-only.
```

### Version

Every map declares `version: 1`.
A version the tooling does not recognize is a schema error, never a best-effort read.

### Repositories

The `repositories` section declares each repository the map governs, by a short name that scope entries reference.
A repository is a named, path-addressable tree: no version-control system or host is assumed.
An entry may name a `remotePath` for tools that need to reach it, and a `localPath`, absolute or relative to the map's directory, where a checkout sits on the machine reading the map, so a tool that reads the files resolves them from the map rather than being told on every invocation.
A `localPath` is a local convenience and not part of the architecture: a map is equally valid on a machine where that path does not exist.

A monorepo declares one entry; a multi-repo system declares several and one map governs them all.
Every scope entry names its repository, so reading any entry never requires context from elsewhere in the file, and a territory can span repositories.

### Territories

A territory is a named set of paths, with a context for whoever works or judges in it.
It is the unit a change is scoped to: a task names its territory, and the gate holds the change inside it.
The paths that govern what every other change is judged by - CI configs, guard tooling, repo-wide docs, the map itself - are a territory like any other; what protects them is the process that lands a change there, not a kind of owner.

**Scope** is a list of `{ repository, globs, exclude? }` entries.
Entries within one territory union, and each entry applies only to the repository it names.
A territory can claim an entire repository with `**` and carve out what other territories own.

**Exclusion** subtracts from the entry's own globs within the same repository: a path belongs to the entry when it matches at least one glob and no exclusion.
`exclude.globs` names patterns directly; `exclude.territories` names territories and subtracts the globs each declares for this repository, so a catch-all need not restate its siblings' patterns.
Subtraction by territory is not recursive: it subtracts that territory's declared globs, not that territory's own exclusions.
Exclusion never assigns the excluded path, which belongs to whichever territory claims it, or is unowned.

**Children.**
A territory may declare a `parent`, carving itself out of another territory rather than standing beside it.
A child's declared globs must fall within its parent's, and the parent's *effective* scope is what remains after each child's declared globs are subtracted.
This is `exclude` turned right-side out: the parent no longer restates which subtrees its children took, and adding a child cannot leave a stale exclusion behind.
Like `exclude.territories`, the subtraction is not recursive - the parent loses the child's declared globs, not the child's own exclusions - so a path a child excludes belongs to whichever territory claims it, or is unowned.
The `undeclaredDependencies` posture defaults from the nearest ancestor that sets it, and ancestor contexts layer onto the child's own, so subdividing a tree for structure restates nothing.
Dependency edges do not flow down or up: `dependsOn` names the child or the parent exactly, and depending on a parent grants nothing about its children.
The relation must be a forest - no cycles, no territory its own parent.

**Effective scope and no overlap.**
A territory's effective scope is its declared globs, minus its entries' exclusions, minus the declared globs of each territory naming it as parent.
No path may fall in more than one territory's effective scope.
A child inside its parent's globs is therefore no overlap, since the parent's effective scope no longer holds those paths; two children of one parent claiming the same path still is.
Overlap is a property of the globs, compared as the sets of paths they can match, never of the files that happen to exist: `src/**` and `src/legacy/**` overlap the moment both are written, empty or not.
A map is therefore valid on its own terms, and no commit elsewhere can invalidate one that was valid when reviewed.
Which territory claims a path is a single lookup rather than a precedence contest, because of this rule.

**Dependency edges.**
A territory's `dependsOn` lists the territories it may import from, or depend on packages of.
A territory that declares none may depend on none, and the declarations together form a graph that must be acyclic.
Edges do not compose: if `api` depends on `core` and `core` on `db`, `api` may not import `db` until it names `db`.
Within one repository these edges are import rules that graph tools enforce, resolving both sides from path to territory.
Across repositories they constrain declared package dependencies, but resolving a package name to a territory is the surrounding tooling's job.
Declaring edges on the territory keeps its whole definition in one place.

**Context.**
Context is the map's one annotation mechanism, held in the map itself so it cannot drift from the boundary it describes.
A territory's `context` holds what anyone working or judging in it needs to know - what is where, what must stay true, what relies on it, the review discipline - and is optional for every territory.
The layers compose: a change in a territory is read against each ancestor territory's context, outermost first, and then the territory's own, where they have one.
`heai-architect context <territory>` prints that composition; what else a worker or a judge is prompted with - its role, its instructions - is the process's to prepend.

### Postures

**`unowned`** decides what becomes of a path that matches no territory.
Under `fail`, the default, the path is a scope gate violation, which keeps the map exhaustive.
Under `allow`, it passes, so a repository can declare one territory and leave the rest ungoverned; partial maps are legal.
A repository may override the map-level posture, so a newly onboarded repository can be mid-adoption while the others stay exhaustive.
The effective posture is the repository's own, else the map's, else `fail`.

**`undeclaredDependencies`** decides what becomes of a dependency the code takes that the importing territory's `dependsOn` does not declare.
Under `fail`, the default, it is a violation, which keeps the declared graph and the code in lockstep.
Under `warn`, it is an advisory finding, so the map can land on a codebase whose imports it does not yet describe.
The violation belongs to the importing territory, so the effective posture is that territory's own, else the nearest ancestor territory's, else that of the repository holding the importing side, else the map's, else `fail`.
A dependency with an unowned path on either side is not an undeclared dependency, since there is no territory to name.

Both postures govern only what they name.
A path outside the scope a change was given fails under every setting, and there is deliberately no flag to override either posture, because a caller that could opt out of fail-closed would make the posture meaningless.

### Names and globs

Repositories and territories share one name format: lowercase, opening with a letter or digit, otherwise letters, digits, `.`, `_` and `-`.

The glob dialect is deliberately small, and `src/glob.ts` implements it:

- Repo-root-relative, with no leading or trailing `/`; a bare filename matches only at the repository root.
- `**` matches zero or more path segments and is always a whole segment, so `a/**/c` matches `a/c`; `*` stays within one segment; `?` is one character.
- A trailing `**` still needs a segment, so `src/**` claims the files under `src` and not a file named `src`.
- A glob where `**` is not alone in its segment, such as `a**` or `**.ts`, is a validation error.
- No character classes, brace expansion, or negation: `[`, `{` and `!` match themselves, and subtraction is what `exclude` is for.
- Dot-prefixed paths are ordinary paths: `**` claims `.github/workflows/ci.yml` like anything else.
- Matching is case-sensitive, and a glob matches files, never directories, so claiming a directory's contents means ending the glob with `**`.

Matching is a two-pointer wildcard walk, linear in the path, so a crafted filename cannot hang the gate the way a backtracking regex would.
Beyond matching, the tool decides whether two globs can match a common path and whether one glob contains another, which is what the no-overlap and child-containment rules are properties of.
`test/glob.test.ts` pins every case that distinguishes the dialect from gitignore and doublestar.

## Validation

`heai-architect check` validates against the schema first, then against the rules the schema cannot express.
A schema failure is reported alone, since the rules assume the shape.

**Errors** make the map wrong:

- Every `scope[].repository` names a key of `repositories`.
- Every territory `parent` names a key of `territories`; the relation is a forest, acyclic and with no territory its own parent.
- Every child's declared globs are contained, per repository and as glob languages, in its parent's declared globs for that repository, so a child cannot claim a repository its parent does not.
- Every name in `dependsOn` names a key of `territories`; the graph is acyclic, and no territory depends on itself.
- Every name in `exclude.territories` names a key of `territories`, and no territory excludes itself.
- Every glob is one the dialect accepts.
- No path is matched by more than one territory's effective scope, compared after exclusions and children's subtractions and as glob languages rather than against the files on disk.

**Warnings** are worth looking at before they become wrong:

- An exclusion that subtracts nothing from its entry, judged as languages: `exclude.globs: ['ci/**']` does not warn merely because `ci/` is empty today.
- An exclusion that restates what a child's `parent` relation already subtracts, since the redundant mirror invites drift when the child's scope changes.
- Paths an entry excludes that no territory claims: deleting a territory without updating the exclusions that mirrored it leaves those paths unowned, which nothing else catches.
- Two repositories sharing a `remotePath`, since two names for one tree let two territories claim the same path without ever overlapping.
- A declared repository that no territory's scope names.

Containment and overlap are judged conservatively.
Where an exclusion subtracts more subtly than covering a whole glob, or a child glob is covered only by the union of several parent globs, the finding is still reported: a false finding on an exotic pair of patterns is better than silence on a real one, and the map is what gets rewritten either way.

## The command

```
heai-architect check [<map>] [--format text|json] [--strict]
heai-architect gate <territory>... [--repo <name>] [--format text|json] [--all]
heai-architect territory <path> [--repo <name>] [--json]
heai-architect territories [--json]
heai-architect context <territory> [--json]
heai-architect template

  --map <path>      the map; default HEAI_MAP, else $HEAI_DIR/architecture.yaml, else .heai/architecture.yaml, else architecture.yaml
  --schema <path>   the schema; default the tool's own schemas/architecture.schema.json, or HEAI_SCHEMA
```

A subcommand is required; bare `heai-architect` prints usage and exits `2`.
The map and schema flags are global, so every subcommand finds the map the same way.
`--map` names it outright; else `HEAI_MAP` names it; else `HEAI_DIR`, when set, is the project directory and the map is its `architecture.yaml`; else `.heai/architecture.yaml` if it exists, else `architecture.yaml`, from the current directory.
`HEAI_DIR` is the project directory every tool shares, so a script run with it set never names the map, and a `HEAI_DIR` without a map is exit `2`, never a fall through to the current directory.
The schema defaults to the one shipped with the tool, in its own `schemas/`, so a linked install and a published one both find it.

The map is read once, by the validator, and every subcommand runs over the validated document.
`check` reports what the validator found; every other subcommand refuses, with exit `2`, to answer over a map with errors, because a territory resolved over an overlapping map, or a verdict over a map with a broken parent chain, would be a guess.
Warnings do not refuse.

**check** prints each error and warning on its own line, then one line saying `valid`, `valid with N warnings`, or `N errors`.
The positional, if any, is the map.
`--strict` makes warnings fail too, for a CI that wants a clean map.
`--format json` prints `{ "path", "valid", "errors": [], "warnings": [], "map": {...} }`, with `map` the parsed document when it has no errors.

**gate** reads a diff from stdin, is told on the command line which territory the change was scoped to, and answers with the exit code; the next section has the details.

**territory** resolves one repository-relative path to the territory whose effective scope holds it.
`--repo` names the repository when the map governs several.
This is the lookup every path-attributing tool needs once: which territory a change touched, which territory an alert is about.

**territories** lists every territory with its parent, globs per repository, dependency edges, and whether it has context.
**context** prints a territory's chain, ancestors outermost first: what a prompt for work or review in that territory starts from.

**template** prints a starter map, the one [`operator-web`](../operator-web)'s map editor offers a new map from.

### Exit codes

| code | meaning |
| --- | --- |
| `0` | valid; the diff is clean; the query answered, and for `territory` the path is claimed |
| `1` | errors, or warnings under `--strict`; a path outside the scope; the path is unowned |
| `2` | the map or the schema cannot be read; a query or gate over a map with errors; bad usage |

It is the same split every other tool here makes.
Exit `2` covers anything that makes the question unanswerable rather than answered "no": an unknown territory, no territory at all, an unknown `--format`, a missing or unparseable map, and a map with errors.

## The gate

```sh
# What a branch changed, against the territory its task was scoped to.
git diff origin/main... | heai-architect gate api

# Include untracked files: git diff does not report them until they are marked.
git add -AN && git diff HEAD | heai-architect gate api

# A task scoped to cross a boundary names every territory it may touch.
git diff origin/main... | heai-architect gate api core

# A map governing several repositories needs to be told which one.
git diff origin/main... | heai-architect gate api --repo app

# In CI, with the result as JSON.
git diff --name-only origin/main... | heai-architect gate "$TERRITORY" --format json > scope.json
```

**What it is for.**
A unit of work stays in the area it was scoped to: an agent given a task in `api` does not wander into `core`, or into the files that govern every other change, because it felt like it.
The gate answers that one question - did the change stay where it was supposed to be - mechanically, before any review, and never whether the change was good.
Whether a change *inside* its scope is sound, or architectural, is a judgment, and the process puts a reviewer in front of it; the territory's context is what that reviewer reads it against.

**Scope.**
The gate's subject is one or more territories, each declared in the map, and a change may touch their union.
How a change comes by its scope is outside the map: the task that produced it names the territory, and a task that must cross a boundary names both, which makes the crossing a visible decision when the task is filed rather than something found in the diff.
No scope passes trivially: naming every territory still leaves unowned paths to the posture, and nothing widens a scope but naming more of it.
A bare positional and `--territory` mean the same thing, and may be mixed.

`--repo` names which repository the diff came from, defaulting to the only one when the map declares one; a diff carries no indication, so a map governing several has to be told.
`--all` lists every changed file in the text format, not only findings.

**Classification.**

| classification | meaning | fails |
| --- | --- | --- |
| `inside` | in a territory the change was scoped to | no |
| `outside` | in another territory | yes |
| `unowned` | no territory claims it | only where the effective `unowned` posture is `fail` |

**Reading the diff.**
A unified diff is expected, and a plain path list from `git diff --name-only` works too.
Both sides of a rename count, C-quoted and non-ASCII paths are decoded, and content that merely looks like a file header, such as a deleted line reading `-- x`, is not mistaken for one.
The parser errs toward reading more paths than fewer, since a path it misses is a violation it silently permits.

**JSON output.**
`--format json` prints one object, whatever the verdict.
`findings` carries every changed path, in path order, whether or not it failed; `--all` affects only the text format.

```json
{
  "ok": false,
  "repository": "app",
  "subject": { "territories": ["api"] },
  "unownedPosture": "fail",
  "changedFiles": 2,
  "findings": [
    { "path": "src/api/x.ts", "classification": "inside", "territory": "api", "fatal": false },
    { "path": "src/core/y.ts", "classification": "outside", "territory": "core", "fatal": true }
  ],
  "violations": 1
}
```

| field | meaning |
| --- | --- |
| `ok` | true when nothing failed; matches exit code `0` |
| `repository` | the repository the diff was checked against |
| `subject` | the territories the change was scoped to |
| `unownedPosture` | the posture in force for this repository, `fail` or `allow` |
| `changedFiles` | how many paths the diff yielded |
| `violations` | how many findings are `fatal` |
| `findings[].classification` | `inside`, `outside`, or `unowned` |
| `findings[].territory` | the territory that claims the path, or `null` when unowned |
| `findings[].fatal` | whether this finding fails the gate |
| `findings[].note` | present only where a finding needs explaining, such as an unowned path the posture allows |

A script that gates a change parses exactly this, or reads only the verdict off the exit code.

## The library

```ts
import { loadMap, territoryOf, runGate, resolveSubject, resolveRepository, parseDiffPaths } from '@heai-tools/architect'

const { result } = loadMap('architecture.yaml')          // { valid, errors, warnings, map }
if (result.map) {
  territoryOf(result.map, 'src/core/db/schema.ts')       // { path, repository, territory }
  runGate({
    map: result.map,
    repository: resolveRepository(result.map),
    subject: resolveSubject(result.map, ['api']),
    paths: parseDiffPaths(diffText)
  })                                                     // { ok, findings, violations, ... }
}
```

`src/index.ts` is the whole surface, and anything not exported there is not part of the contract.

| area | exported |
| --- | --- |
| types | `ArchitectureMap`, `Repository`, `Territory`, `ScopeEntry`, `Exclusion`, `UnownedPosture`, `UndeclaredPosture`, `ValidationResult`, `Validator` |
| validating | `createValidator` with `validate(yaml)` and `validateDoc(object)`, `loadMap`, `resolveMapPath`, `DEFAULT_SCHEMA`, `TEMPLATE`, `UsageError` |
| the map | `claims`, `claimants`, `entriesFor`, `unownedPosture` |
| globs | `compileGlob`, `validateGlob`, `matchesGlob`, `matchesAny`, `intersects`, `contains`, `GlobError` |
| queries | `territoryOf`, `territoriesView`, `contextChain`, and their types |
| the gate | `runGate`, `resolveSubject`, `resolveRepository`, `subjectGlobs`, `parseDiffPaths`, `Subject`, `Finding`, `Classification`, `GateInput`, `GateResult` |

`territoryOf` takes a path and answers with the territory whose effective scope holds it.
`UsageError` is the one exit-`2` class: an unreadable map or schema, a map with errors, an unknown territory or repository.

No tool in this repository imports the library: [`operator-web`](../operator-web)'s map editor validates every edit through `heai-architect check --format json`, since tools meet through commands and files rather than each other's code.
The package's exports point at `dist/`, which `npm install` builds here, so a dependent imports compiled JavaScript and never the TypeScript sources.

`runGate` is handed a map object rather than a path, so a library caller may hand it one the validator has not seen.
It still refuses, as a `UsageError`, a glob outside the dialect and a path two territories claim, so such a caller gets a message rather than a stack trace; over a map `loadMap` returned, neither branch is reachable.

## Limitations

- **Dependency edges are declared, not enforced.**
  `check` validates that `dependsOn` names real territories and forms an acyclic graph, and the `undeclaredDependencies` posture is parsed and resolved, but nothing here reads imports.
  The import-boundary check is a separate tool's job; the map's semantics above are what it must implement.
- **Cross-repository dependencies are the surrounding tooling's.**
  Resolving a package name to a territory is outside the map, so only the within-repository import check is normative.
- **Context freshness is not checked.**
  Comparing when a territory's context last changed against the last change to its files needs the map's history, which this tool does not read.
- **The scope is told, never inferred.**
  The gate needs the territory on the command line; there is no default from the environment, and the diff itself is never what decides the scope.
- **Nothing protects the map but the process.**
  A change to the map file is a change like any other to the gate; that it lands only through review and approval is the landing flow's to enforce.
- **The repository is told, never inferred.**
  A multi-repository map needs `--repo` on every gate and territory call, even from inside a checkout the map names by `localPath`.
- **Overlap and containment over-report on exotic patterns.**
  Two globs an exclusion separates only in combination, or a child glob covered only by the union of its parent's globs, are reported as findings.
  The map is rewritten to a form the checker can prove, which has been a clearer map every time so far.
- **The dialect has no classes, braces, or negation**, and a glob written in another dialect's syntax is matched literally, without a warning.

## Potential future features

Ideas, not commitments.

- **An import-boundary check** that enforces `dependsOn` under the `undeclaredDependencies` posture, reading a language-agnostic import graph and resolving both ends of each edge through `territory`.
- **A hook mode** that reads a harness's pre-edit event on stdin and denies an edit outside the task's scope, naming the territory, so the gate answers while the agent can still stop rather than at review time.
- **A default scope from the environment**, so a harness that knows which task a session works on need not repeat its territory on every call.
- **Repository inference** from the current directory, matched against each repository's `localPath`, so `--repo` is needed only when the answer is ambiguous.
- **A warning for foreign glob syntax**: `[`, `{` and `!` mean something in every neighbouring dialect, so a validator warning would catch the habit before it becomes a silent mismatch.
- **Deprecated edges**: a `dependsOn` edge that still passes but warns, for a dependency being refactored away.
- **Composable maps**, split into files that compose into one reviewed picture without one file as the bottleneck.
- **Context freshness**, comparing a territory's context against its files through the map's history, as a warning.

## Tests

```sh
npm test          # the glob dialect, the schema and rules, the queries, the diff parser, the gate, the command
npm run typecheck
```

`test/glob.test.ts` pins the dialect.
`test/validate.test.ts` pins every rule listed under Validation.
`test/gate.test.ts` pins classification, posture, the union of several territories, exclusion and the parent relation over map objects.
`test/diff.test.ts` pins the diff parser against renames, quoting and look-alike headers.
`test/cli.test.ts` pins every subcommand's exit codes and both output formats against a spawned process.

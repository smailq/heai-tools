# @heai-tools/architect

The architecture map as one tool: it validates the map, answers questions about it, and checks a diff against its ownership boundaries, as a command and as a TypeScript library.

```sh
architect check                                      # the map is valid, or every error and warning
architect owner src/core/db/schema.ts                # which territory claims a path, and who owns it
git diff origin/main... | architect gate --actor api-owner   # may this actor have made this change?
```

Requires Node 22.18 or newer, which runs the TypeScript sources directly.
From this directory, `npm install` pulls two runtime dependencies, a YAML parser and a JSON Schema validator, and `node src/cli.ts` runs the command; `npm link` puts `architect` on the path.

## The map

The architecture map is one file, by convention `architecture.yaml`, holding a system's **territory ownership**, **architectural guardrails**, and a **visualizable picture of the architecture**, across one or more repositories.
It plays four roles:

- **Defines** the architecture - each governed path has at most one owner, exactly one where the map is exhaustive, and each territory declares which territories it may depend on.
- **Enforces** it - the map is the direct input to the guardrails: the scope gate in this tool, and the import-boundary and context checks that read the same file, in CI and locally.
- **Steers agents** - every llm-agent carries a `context`, and each territory it owns may add its own.
- **Lets humans manage the architecture** - a boundary, an owner, an edge, or a territory's context changes by editing this one file, so the review of that edit *is* the architectural decision.
  Visualizations render from the map, never from a separate diagram.

Its shape is [`schemas/architecture.schema.json`](schemas/architecture.schema.json), a JSON Schema whose field descriptions are the reference for each key.
This section is the rest: what the fields mean together, the rules the schema cannot express, and what the tool does with them.

### An example

```yaml
version: 1
unowned: fail                      # a path no territory claims is a violation

actors:
  smailq:
    type: human
    identity: '@smailq'
  api-owner:
    type: llm-agent
    context: |
      You own the HTTP API. Keep handlers thin; business rules live in core.
  core-owner:
    type: llm-agent
    context: |
      You own the domain model and the database layer.
    watches: [api]                 # sees api's changes and context; may not change it

repositories:
  app:
    remotePath: github.com/example/app
    localPath: ../app              # where a checkout sits on this machine

territories:
  platform:                        # the human-owned territory: CI, the map, guard tooling
    owner: smailq
    scope:
      - repository: app
        globs: ['architecture.yaml', '.github/**', 'ci/**']
    context: The map protects everything else, so it must fall inside a human-owned territory itself.

  core:
    owner: core-owner
    scope:
      - repository: app
        globs: ['src/core/**']
    context: |
      Invariants: no I/O in the domain model; every aggregate has a test.

  core-db:                         # a child: carved out of core, inherits core's owner
    parent: core
    scope:
      - repository: app
        globs: ['src/core/db/**']
    context: Migrations are append-only.

  api:
    owner: api-owner
    scope:
      - repository: app
        globs: ['src/api/**']
    dependsOn: [core]              # api may import core, and nothing else
    undeclaredDependencies: warn   # while its imports are still being described

  docs:                            # a catch-all that yields to its siblings
    owner: smailq
    scope:
      - repository: app
        globs: ['**']
        exclude:
          territories: [platform, core, api]
```

Against this map:

```
$ architect owner src/core/db/schema.ts
src/core/db/schema.ts  core-db  owned by core-owner (llm-agent)

$ printf 'src/api/x.ts\nsrc/core/y.ts\n' | architect gate --actor api-owner
scope gate: FAIL
  subject     actor api-owner (owns api)
  repository  app
  changed     2 files changed, 1 violation

  ✗ foreign  src/core/y.ts
             owned by core (core-owner, llm-agent); delegate the change or move the boundary

  api-owner may change: src/api/**

$ architect actors
smailq               human      owns platform, docs
api-owner            llm-agent  owns api
core-owner           llm-agent  owns core, core-db  watches api
```

### Version

Every map declares `version: 1`.
A version the tooling does not recognize is a schema error, never a best-effort read.

### Actors

The `actors` section declares everything that can own a territory, keyed by name, and each actor's `type` is `human` or `llm-agent`.
One namespace for every kind of owner makes a name unique by construction and an owner a single lookup, and the `type` enum is where further kinds of owner are added.
Declaring an actor grants it nothing: territories assign the paths.

A `human` carries an `identity`, a handle or email that the surrounding tooling resolves; other actors carry one only where they act under an account of their own.
An `llm-agent` carries a `context`, inline markdown with its role, focus, and standing guidance across every territory it owns; a human may.

An actor may also `watches` territories it does not own: a maintainer watching for bugs and health across a module, a reviewer watching what it reviews.
Watching grants nothing.
Confinement is unchanged, and a watcher that needs a change files a task for the territory's owner.
It only steers the surrounding tooling - which contexts the actor is composed with, which changes and events reach it - so that an observer role is declared in the map rather than improvised in a prompt.

### Repositories

The `repositories` section declares each repository the map governs, by a short name that scope entries reference.
A repository is a named, path-addressable tree: no version-control system or host is assumed.
An entry may name a `remotePath` for tools that need to reach it, and a `localPath`, absolute or relative to the map's directory, where a checkout sits on the machine reading the map, so a tool that reads the files resolves them from the map rather than being told on every invocation.
A `localPath` is a local convenience and not part of the architecture: a map is equally valid on a machine where that path does not exist.

A monorepo declares one entry; a multi-repo system declares several and one map governs them all.
Every scope entry names its repository, so reading any entry never requires context from elsewhere in the file, and a territory can span repositories.

### Territories

A territory is a named set of paths with one owner, a declared actor.
Human-owned territories hold the paths that govern what llm-agents may do - CI configs, guard tooling, repo-wide docs, the map itself - and name the person accountable for them.

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
`owner` is optional on a child and defaults from the nearest ancestor that declares one, so subdividing one owner's tree for structure does not restate the owner; a child may equally declare its own `owner`, handing the carved-out paths to a different actor, and that declaration is what its own children then default from.
The `undeclaredDependencies` posture defaults the same way, and ancestor contexts layer onto the child's own.
Dependency edges do not flow down or up: `dependsOn` names the child or the parent exactly, and depending on a parent grants nothing about its children.
The relation must be a forest - no cycles, no territory its own parent - and a territory without a parent must declare an owner.

**Effective scope and no overlap.**
A territory's effective scope is its declared globs, minus its entries' exclusions, minus the declared globs of each territory naming it as parent.
No path may fall in more than one territory's effective scope.
A child inside its parent's globs is therefore no overlap, since the parent's effective scope no longer holds those paths; two children of one parent claiming the same path still is.
Overlap is a property of the globs, compared as the sets of paths they can match, never of the files that happen to exist: `src/**` and `src/legacy/**` overlap the moment both are written, empty or not.
A map is therefore valid on its own terms, and no commit elsewhere can invalidate one that was valid when reviewed.
Ownership of a path is a single lookup rather than a precedence contest, because of this rule.

**Dependency edges.**
A territory's `dependsOn` lists the territories it may import from, or depend on packages of.
A territory that declares none may depend on none, and the declarations together form a graph that must be acyclic.
Edges do not compose: if `api` depends on `core` and `core` on `db`, `api` may not import `db` until it names `db`.
Within one repository these edges are import rules that graph tools enforce, resolving both sides from path to territory.
Across repositories they constrain declared package dependencies, but resolving a package name to a territory is the surrounding tooling's job.
Declaring edges on the territory keeps its whole definition in one place.

**Context.**
Context is the map's one annotation mechanism, held in the map itself so it cannot drift from the boundary it describes or fall outside the map's own protection.
A territory's `context` holds the invariants, review discipline, and background needed to work in and review the territory, and is optional whoever owns it.
The layers compose: an llm-agent working in a territory receives its own `context`, each ancestor territory's, outermost first, and the territory's own, where they have one.
`architect context <actor>` prints that composition.

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
Confinement - an actor changing a path it does not own - fails under every setting, and there is deliberately no flag to override either posture, because a caller that could opt out of fail-closed would make the posture meaningless.

### Names and globs

Actors, repositories, and territories share one name format: lowercase, opening with a letter or digit, otherwise letters, digits, `.`, `_` and `-`.

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

`architect check` validates against the schema first, then against the rules the schema cannot express.
A schema failure is reported alone, since the rules assume the shape.

**Errors** make the map wrong:

- Every `scope[].repository` names a key of `repositories`.
- Every territory `owner` names a key of `actors`; a territory without a `parent` declares an `owner`.
- Every territory `parent` names a key of `territories`; the relation is a forest, acyclic and with no territory its own parent.
- Every child's declared globs are contained, per repository and as glob languages, in its parent's declared globs for that repository, so a child cannot claim a repository its parent does not.
- Every name in `dependsOn` names a key of `territories`; the graph is acyclic, and no territory depends on itself.
- Every name in `exclude.territories` names a key of `territories`, and no territory excludes itself.
- Every name in an actor's `watches` names a key of `territories`.
- Every glob is one the dialect accepts.
- No path is matched by more than one territory's effective scope, compared after exclusions and children's subtractions and as glob languages rather than against the files on disk.

**Warnings** are worth looking at before they become wrong:

- An exclusion that subtracts nothing from its entry, judged as languages: `exclude.globs: ['ci/**']` does not warn merely because `ci/` is empty today.
- An exclusion that restates what a child's `parent` relation already subtracts, since the redundant mirror invites drift when the child's scope changes.
- Paths an entry excludes that no territory claims: deleting a territory without updating the exclusions that mirrored it leaves those paths unowned, which nothing else catches.
- Two repositories sharing a `remotePath`, since two names for one tree let two territories own the same path without ever overlapping.
- A declared repository that no territory's scope names.
- An actor declared but neither owning nor watching a territory.
- An actor watching a territory it owns, by declaration or inheritance.
- No human-owned territory at all, since the map protects everything else and so must protect itself.

Containment and overlap are judged conservatively.
Where an exclusion subtracts more subtly than covering a whole glob, or a child glob is covered only by the union of several parent globs, the finding is still reported: a false finding on an exotic pair of patterns is better than silence on a real one, and the map is what gets rewritten either way.

## The command

```
architect check [<map>] [--format text|json] [--strict]
architect gate <name> | --territory <name> | --actor <name>  [--repo <name>] [--format text|json] [--all]
architect owner <path> [--repo <name>] [--json]
architect territories [--actor <name>] [--json]
architect actors [--json]
architect context <actor>|<territory> [--json]
architect template

  --map <path>      the map; default HEAI_MAP, else $HEAI_DIR/architecture.yaml, else .heai/architecture.yaml, else architecture.yaml
  --schema <path>   the schema; default this repository's, or HEAI_SCHEMA
```

A subcommand is required; bare `architect` prints usage and exits `2`.
The map and schema flags are global, so every subcommand finds the map the same way.
`--map` names it outright; else `HEAI_MAP` names it; else `HEAI_DIR`, when set, is the project directory and the map is its `architecture.yaml`; else `.heai/architecture.yaml` if it exists, else `architecture.yaml`, from the current directory.
`HEAI_DIR` is the project directory every tool shares, so a script run with it set never names the map, and a `HEAI_DIR` without a map is exit `2`, never a fall through to the current directory.
The schema defaults to this repository's, beside the tools, so a linked install finds it and a copied one is told where it is.

The map is read once, by the validator, and every subcommand runs over the validated document.
`check` reports what the validator found; every other subcommand refuses, with exit `2`, to answer over a map with errors, because an owner resolved over an overlapping map, or a verdict over a map with a broken parent chain, would be a guess.
Warnings do not refuse.

**check** prints each error and warning on its own line, then one line saying `valid`, `valid with N warnings`, or `N errors`.
The positional, if any, is the map.
`--strict` makes warnings fail too, for a CI that wants a clean map.
`--format json` prints `{ "path", "valid", "errors": [], "warnings": [], "map": {...} }`, with `map` the parsed document when it has no errors.

**gate** reads a diff from stdin, is told on the command line who the change is attributed to, and answers with the exit code; the next section has the details.

**owner** resolves one repository-relative path to the territory whose effective scope holds it, and that territory's owner and owner type.
`--repo` names the repository when the map governs several.
This is the lookup every path-attributing tool needs once: which lane a run lands in, which actor an alert routes to.

**territories** lists every territory with its owner resolved through the parent chain and that owner's type, its declared owner, parent, globs per repository, dependency edges, and whether it has context; `--actor` keeps only one actor's.
With `--json` a script routes a task from this one call: the territory's `owner` and `ownerType` say who and what kind of actor, `parent` says where it sits.
**actors** lists every actor with its type, what it owns, and what it watches.
**context** prints what an actor is composed with - its own context, then each owned territory's chain, then each watched one marked as watched with its owner - or a territory's chain, ancestors outermost first.
An agent definition generated from the map is a shell-out to it.

**template** prints a starter map, the one `map-editor` seeds a new document with.

### Exit codes

| code | meaning |
| --- | --- |
| `0` | valid; the diff is clean; the query answered, and for `owner` the path is claimed |
| `1` | errors, or warnings under `--strict`; a boundary violation; the path is unowned |
| `2` | the map or the schema cannot be read; a query or gate over a map with errors; bad usage |

It is the same split `tasks` and `agent-host` make.
Exit `2` covers anything that makes the question unanswerable rather than answered "no": an unknown subject, a subject named twice, an unknown `--format`, a missing or unparseable map, and a map with errors.

## The gate

```sh
# What an agent's branch changed, against the territory it declared.
git diff origin/main... | architect gate --territory api

# Include untracked files: git diff does not report them until they are marked.
git add -AN && git diff HEAD | architect gate --territory api

# An actor working across every territory it owns.
git diff origin/main... | architect gate --actor api-owner

# A map governing several repositories needs to be told which one.
git diff origin/main... | architect gate --territory api --repo app

# In CI, with the result as JSON.
git diff --name-only origin/main... | architect gate --territory "$TERRITORY" --format json > scope.json
```

**Attribution.**
A change is attributed to exactly one declared actor; how the surrounding tooling decides which one is outside the map, so this tool is told.
Confinement is symmetric: a change fails when it reaches a path its actor does not own, whether that actor is a human or an llm-agent.
Reaching beyond a territory means changing the map first, so a boundary crossing is always a reviewed edit.
No subject passes trivially.

**Subject.**
Exactly one, and required.
A bare positional name is resolved against both namespaces and must be qualified if it is both a territory and an actor.
Giving a positional name together with `--territory` or `--actor` is an error rather than a silent choice between them.

| option | argument | what it allows |
| --- | --- | --- |
| `--territory` | territory name | that one territory's paths |
| `--actor` | actor name | every territory that actor owns |
| *(positional)* | either | resolved against both namespaces |

`--repo` names which repository the diff came from, defaulting to the only one when the map declares one; a diff carries no indication, so a map governing several has to be told.
`--all` lists every changed file in the text format, not only findings.

**Classification.**

| classification | meaning | fails |
| --- | --- | --- |
| `owned` | inside a territory the subject may change | no |
| `foreign` | owned by another territory | yes |
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
  "subject": { "kind": "actor", "name": "api-owner", "territories": ["api"] },
  "unownedPosture": "fail",
  "changedFiles": 2,
  "findings": [
    { "path": "src/api/x.ts", "classification": "owned", "territory": "api", "owner": "api-owner", "ownerType": "llm-agent", "fatal": false },
    { "path": "src/core/y.ts", "classification": "foreign", "territory": "core", "owner": "core-owner", "ownerType": "llm-agent", "fatal": true }
  ],
  "violations": 1
}
```

| field | meaning |
| --- | --- |
| `ok` | true when nothing failed; matches exit code `0` |
| `repository` | the repository the diff was checked against |
| `subject` | what was named, the territories it may change, and for a territory subject its owner |
| `unownedPosture` | the posture in force for this repository, `fail` or `allow` |
| `changedFiles` | how many paths the diff yielded |
| `violations` | how many findings are `fatal` |
| `findings[].classification` | `owned`, `foreign`, or `unowned` |
| `findings[].territory` | the owning territory, or `null` when unowned |
| `findings[].owner` | that territory's actor, or `null` |
| `findings[].ownerType` | `human` or `llm-agent`, or `null` |
| `findings[].fatal` | whether this finding fails the gate |
| `findings[].note` | present only where a finding needs explaining, such as an unowned path the posture allows |

`agent-host` parses exactly this, keeps `findings` whole on the run, and reads the verdict off the exit code.

## The library

```ts
import { loadMap, ownerOf, runGate, resolveSubject, resolveRepository, parseDiffPaths } from '@heai-tools/architect'

const { result } = loadMap('architecture.yaml')          // { valid, errors, warnings, map }
if (result.map) {
  ownerOf(result.map, 'src/core/db/schema.ts')           // { territory, owner, ownerType, ... }
  runGate({
    map: result.map,
    repository: resolveRepository(result.map),
    subject: resolveSubject(result.map, { actor: 'api-owner' }),
    paths: parseDiffPaths(diffText)
  })                                                     // { ok, findings, violations, ... }
}
```

`src/index.ts` is the whole surface, and anything not exported there is not part of the contract.

| area | exported |
| --- | --- |
| types | `ArchitectureMap`, `Actor`, `ActorType`, `Repository`, `Territory`, `ScopeEntry`, `Exclusion`, `UnownedPosture`, `UndeclaredPosture`, `ValidationResult`, `Validator` |
| validating | `createValidator` with `validate(yaml)` and `validateDoc(object)`, `loadMap`, `resolveMapPath`, `DEFAULT_SCHEMA`, `TEMPLATE`, `UsageError` |
| the map | `claims`, `claimants`, `effectiveOwner`, `entriesFor`, `unownedPosture`, `territoriesOwnedBy` |
| globs | `compileGlob`, `validateGlob`, `matchesGlob`, `matchesAny`, `intersects`, `contains`, `GlobError` |
| queries | `ownerOf`, `territoriesView`, `actorsView`, `contextChain`, `actorContext`, and their view types |
| the gate | `runGate`, `resolveSubject`, `resolveRepository`, `subjectGlobs`, `parseDiffPaths`, `Subject`, `SubjectRequest`, `Finding`, `Classification`, `GateInput`, `GateResult` |

`ownerOf` takes a path and answers with the territory and its owner; `effectiveOwner` takes a territory and answers with its owner through the parent chain.
`UsageError` is the one exit-`2` class: an unreadable map or schema, a map with errors, an unknown subject or repository.

`map-editor` depends on this package by name, resolved locally by `file:../architect`, and validates on every keystroke through `createValidator`.
Because the sources are TypeScript run directly, the package resolves through a symlink so Node strips types outside `node_modules`.

`runGate` is handed a map object rather than a path, so a library caller may hand it one the validator has not seen.
It still refuses, as a `UsageError`, a glob outside the dialect, a territory whose parent chain resolves no owner, and a path two territories claim, so such a caller gets a message rather than a stack trace; over a map `loadMap` returned, none of those branches is reachable.

## Limitations

- **Dependency edges are declared, not enforced.**
  `check` validates that `dependsOn` names real territories and forms an acyclic graph, and the `undeclaredDependencies` posture is parsed and resolved, but nothing here reads imports.
  The import-boundary check is a separate tool's job; the map's semantics above are what it must implement.
- **Cross-repository dependencies are the surrounding tooling's.**
  Resolving a package name to a territory is outside the map, so only the within-repository import check is normative.
- **Context freshness is not checked.**
  Comparing when a territory's context last changed against the last change to its files needs the map's history, which this tool does not read.
- **The map-protects-itself warning is approximate.**
  The rule is that the map file falls inside a human-owned territory; the check is that some human-owned territory exists, since the tool does not know which path the map will be committed at.
- **Attribution is told, never inferred.**
  The gate needs a subject on the command line; there is no default from the environment or from the user's identity.
- **The repository is told, never inferred.**
  A multi-repository map needs `--repo` on every gate and owner call, even from inside a checkout the map names by `localPath`.
- **Overlap and containment over-report on exotic patterns.**
  Two globs an exclusion separates only in combination, or a child glob covered only by the union of its parent's globs, are reported as findings.
  The map is rewritten to a form the checker can prove, which has been a clearer map every time so far.
- **The dialect has no classes, braces, or negation**, and a glob written in another dialect's syntax is matched literally, without a warning.
- **The package is not published.**
  The sources run directly under Node 22.18 or newer and resolve through a symlink; a registry publish would need an emitted `dist/`.

## Potential future features

Ideas, not commitments; the root README's list holds the ones that span tools.

- **An import-boundary check** that enforces `dependsOn` under the `undeclaredDependencies` posture, reading a language-agnostic import graph and resolving both ends of each edge through `owner`.
- **A hook mode** that reads a harness's pre-edit event on stdin and denies an edit outside the actor's territories, naming the owner, so the gate answers while the agent can still stop rather than at review time.
- **A default subject from the environment**, so a harness that sets which actor a session acts as need not repeat it on every call, and a human's identity resolves to their declared actor.
- **Repository inference** from the current directory, matched against each repository's `localPath`, so `--repo` is needed only when the answer is ambiguous.
- **A warning for foreign glob syntax**: `[`, `{` and `!` mean something in every neighbouring dialect, so a validator warning would catch the habit before it becomes a silent mismatch.
- **Deprecated edges**: a `dependsOn` edge that still passes but warns, for a dependency being refactored away.
- **A group actor type**, so a team stands behind a territory as one owner and the no-overlap rule holds unchanged.
- **Composable maps**, split into files that compose into one reviewed picture without one file as the bottleneck.
- **Context freshness**, comparing a territory's context against its files through the map's history, as a warning.

## Tests

```sh
npm test          # the glob dialect, the schema and rules, the queries, the diff parser, the gate, the command
npm run typecheck
```

`test/glob.test.ts` pins the dialect.
`test/validate.test.ts` pins every rule listed under Validation.
`test/gate.test.ts` pins classification, posture, symmetry, exclusion and the parent relation over map objects.
`test/diff.test.ts` pins the diff parser against renames, quoting and look-alike headers.
`test/cli.test.ts` pins every subcommand's exit codes and both output formats against a spawned process.

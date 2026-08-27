# The architecture map

The architecture map is the foundation of heai-tools: one file holding a system's **architectural guardrails**, **territory ownership**, and a **visualizable picture of the architecture**, across one or more repositories.
It plays four roles:

- **Defines** the architecture - each governed path has at most one owner, exactly one where the map is exhaustive, and each territory declares which territories it may depend on.
- **Enforces** it - the map is the direct input to the guardrails: the diff-scope gate, the import-boundary rules, and the context checks all execute from it, in CI and locally.
- **Steers agents** - every llm-agent carries a `context`, and each territory it owns may add its own.
- **Lets humans manage the architecture** - a boundary, an owner, an edge, or a territory's context changes by editing this one file, so the review of that edit *is* the architectural decision.
  Visualizations render from the map, never from a separate diagram.

The schema lives at [`schemas/architecture.schema.json`](../schemas/architecture.schema.json).
By convention the file is named `architecture.yaml`.
Every map declares `version: 1`; a version the tooling does not recognize is a hard error, never a best-effort read.

## Core concepts

**Owners are declared actors.**
The top-level `actors` section declares everything that can own a territory, keyed by name; each actor's `type` is `human` or `llm-agent`.
One namespace for every kind of owner makes a name unique by construction and an owner a single lookup, and the `type` enum is where further kinds of owner are added.
An actor of type `human` carries an `identity` - handle or email, whatever the surrounding tooling resolves; other actors carry one only where they act under an account of their own.
Declaring an actor grants it nothing: territories assign the paths.
An llm-agent carries a `context`, inline markdown with its role, focus, and standing guidance across every territory it owns; a human may.

**Territories.**
A territory is a named set of paths with one owner, a declared actor: an llm-agent (e.g. `api-owner`) or a human (e.g. `smailq`).
Human-owned territories hold the paths that govern what llm-agents may do - CI configs, guard tooling, repo-wide docs, the map itself - and name the person accountable for them.

**Repositories are explicit.**
A required top-level `repositories` section declares each repository by short name.
A repository is a named, path-addressable tree: no version-control system or host is assumed, and an entry may name a `remotePath` for tools that need to reach it.
A monorepo declares one entry; a multi-repo system declares several and one map governs them all:

- **Territory scope** is a list of `{repository, globs, exclude?}` entries, so a territory can span repositories, or claim an entire repository with `**` and carve out what other territories own.
- **Every reference names its repository**, so reading any entry never requires context from elsewhere in the file.

**Partial maps are legal.**
The `unowned` posture decides what becomes of a path that matches no territory.
Under `fail`, the default, the path is a scope-gate violation, which keeps the map exhaustive.
Under `allow`, it passes, so a repository can declare one territory and leave the rest ungoverned.
A repository may override the map-level posture, so a newly onboarded repository can be mid-adoption while the others stay exhaustive.
The posture governs unowned paths only; confinement holds under either setting.

**Context is inline.**
Context is the map's one annotation mechanism, held in the map itself so it cannot drift from the boundary it describes or fall outside the map's own protection.
A territory's `context` holds the invariants, review discipline, and background needed to work in and review the territory, and is optional whoever owns it.
The layers compose: an llm-agent working in a territory receives its own `context` and the territory's, where the territory has one.
A freshness check compares when a territory's `context` last changed, via the map file's own history, against the last change to the files in its scope.
Context outpaced by its code warns; staleness is a judgment call for the owner's next review, not a merge blocker.

**Dependency edges.**
A territory's `dependsOn` lists the territories it may import from, or depend on packages of.
A territory that declares none may depend on none, and the declarations together form a graph that must be acyclic.
Edges do not compose: if `api` depends on `core` and `core` on `db`, `api` may not import `db` until it names `db`.
Within one repository these edges are import rules that graph tools enforce, resolving both sides from path to territory.
Across repositories they constrain declared package dependencies, but resolving a package name to a territory is the surrounding tooling's job, as attribution is: only the within-repository check is normative here.
Declaring edges on the territory keeps its whole definition in one place.

**Undeclared dependencies.**
The `undeclaredDependencies` posture decides what becomes of a dependency the code takes that the importing territory's `dependsOn` does not declare.
Under `fail`, the default, it is a violation, which keeps the declared graph and the code in lockstep.
Under `warn`, it is an advisory finding, so the map can land on a codebase whose imports it does not yet describe, and each stray edge is declared or severed on its own schedule.
A repository may override the map-level posture, and so may a territory, so one legacy territory can be advisory while the rest stays enforced.
The posture governs dependency edges only; confinement holds under either setting.

## Semantics

- **Attribution**: every change a gate checks is made on behalf of exactly one declared actor.
  How the surrounding tooling determines which actor is outside this map.
- **Confinement**: a change fails when it reaches a path its actor does not own, llm-agent and human alike.
  Reaching beyond a territory means changing the map first, so a boundary crossing is always a reviewed edit.
- **Name format**: actors, repositories, and territories share one format - lowercase, opening with a letter or digit, otherwise letters, digits, `.`, `_` and `-`.
- **Scope entries are per-repository**: an entry applies only to the repository it names.
- **Glob semantics**, kept deliberately small:
  - Repo-root-relative, with no leading or trailing `/`; a bare filename matches only at the repository root.
  - `**` matches zero or more path segments and is always a whole segment, so `a/**/c` matches `a/c`; `*` stays within one segment; `?` is one character.
  - A glob where `**` is not alone in its segment, such as `a**` or `**.ts`, is a validation error.
  - No character classes, brace expansion, or negation: `[`, `{` and `!` match themselves, and subtraction is what `exclude` is for.
  - Matching is case-sensitive, and a glob matches files, never directories, so claiming a directory's contents means ending the glob with `**`.
- **Unowned paths**: a file matching no territory is a violation unless the effective `unowned` posture is `allow`.
  The effective posture is the repository's own, else the map's, else `fail`.
- **Undeclared dependencies**: a dependency the code takes is a violation when the importing territory's `dependsOn` does not name the imported territory, unless the effective posture is `warn`.
  Within a repository both sides resolve from path to territory, which is the normative case; across repositories, resolving a declared package dependency to a territory is left to the surrounding tooling.
  The violation belongs to the importing territory, so the effective posture is that territory's own, else that of the repository holding the importing side, else the map's, else `fail`.
  The check covers every dependency the code takes, not only those a change touches.
  A dependency with an unowned path on either side is not an undeclared dependency, since there is no territory to name: unowned paths are the `unowned` posture's business.
- **Exclusion**: a scope entry's `exclude` subtracts from its own `globs` within the same repository, so a path belongs to the entry when it matches at least one glob and no exclusion.
  `exclude.globs` names patterns directly; `exclude.territories` names territories and subtracts the globs each declares for this repository, so a catch-all need not restate its siblings' patterns.
  Subtraction by territory is not recursive: it subtracts that territory's declared globs, not that territory's own exclusions.
  Exclusion never assigns the excluded path, which belongs to whichever territory claims it, or is unowned.
- **No overlap**: no path may be matched by more than one *territory's* scope, once exclusions are subtracted.
  Entries within one territory union instead, and an `exclude` subtracts only from the entry declaring it.
  Overlap is a property of the globs, compared as the sets of paths they can match, never of the files that happen to exist: `src/**` and `src/legacy/**` overlap the moment both are written, empty or not.
  A map is therefore valid on its own terms, and no commit elsewhere can invalidate one that was valid when reviewed.

## Rules a validator must enforce beyond JSON Schema

Errors:

- Every `scope[].repository` must name a key of `repositories`.
- Every territory `owner` must name a key of `actors`.
- Every name in a territory's `dependsOn` must name a key of `territories`; the relation must be acyclic, and no territory may depend on itself.
- Every name in an `exclude.territories` list must name a key of `territories`, and no territory may exclude itself.
- No path may be matched by more than one territory's scope, compared after exclusions and as glob languages rather than against the files on disk.

Warnings:

- An exclusion that subtracts nothing from its entry, judged as languages: `exclude.globs: ['ci/**']` does not warn merely because `ci/` is empty today.
- Paths an entry excludes that no territory claims - deleting a territory without updating the exclusions that mirrored it leaves those paths unowned, which nothing else catches.
- Two `repositories` entries sharing a `remotePath`, compared as exact strings, since two names for one tree let two territories own the same path without ever overlapping.
- A declared repository that no territory's scope names.
- An actor declared but owning no territory.
- A map file falling outside every human-owned territory, since the map protects everything else and so must protect itself.

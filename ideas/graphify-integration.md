# Using graphify with heai-tools

*Idea report, 2026-08-28. Assessment of [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify) as a companion to heai-tools; not a commitment.*

## The core fit

Graphify and heai-tools sit on opposite sides of the same question.
The architecture map is the **declared** architecture: territories, owners, and `dependsOn` edges a human reviewed.
Graphify extracts the **observed** architecture: actual `imports`, `calls`, and `inherits` edges from tree-sitter AST parsing, plus Leiden-clustered communities, written to `graphify-out/graph.json` at the repository root.
Declared versus observed is exactly the comparison this tooling wants to make and currently cannot, because nothing in heai-tools reads the code itself.

Relevant graphify facts, as of this writing:

- Installed with `uv tool install graphifyy`; invoked as a CLI (`graphify extract`, `graphify hook install`) or as a `/graphify` skill in Claude Code, Cursor, Codex, Gemini CLI, and others.
- `--code-only` extraction is deterministic and local - pure tree-sitter, no LLM, no API keys, roughly 40 languages.
- Edges are tagged `EXTRACTED` (explicit in the source), `INFERRED`, or `AMBIGUOUS`.
- Outputs: `graph.json` (queryable, designed to be committed, with a merge driver), `graph.html` (interactive view), `GRAPH_REPORT.md`; a post-commit hook keeps the graph fresh.
- Query surface: `query`, `path`, `explain` over the persisted graph; incremental `--update`; `.graphifyignore` for exclusions.
- The `graph.json` schema is explicitly undocumented.

Four uses, roughly in order of value.

## 1. The missing import-boundary tool

The biggest one.
The design doc punts deliberately: `dependsOn` and the `undeclaredDependencies` posture "belong to an import-boundary tool" - which does not exist yet, and building one means per-language import parsing across every ecosystem adopters use.
Graphify already does that extraction, and `--code-only` is the mode that matters: deterministic and reproducible is precisely what a fail-closed CI gate requires.

The dep-gate then becomes thin and language-agnostic: read `graph.json`, take each cross-file import edge, resolve both endpoint file paths through the map's globs to territories - a lookup scope-gate already implements - and check the importing territory's `dependsOn` under the effective posture.

Two caveats:

- **Only `EXTRACTED` edges may fail the gate.** `INFERRED` and `AMBIGUOUS` edges are advisory findings at best - the mirror of the over-report-but-never-stay-silent rule the map-editor applies to overlaps.
- **It puts a third-party tool in the enforcement path**, which cuts against the near-zero-dependency discipline. Worth it only if the consumed slice of `graph.json` is minimal - file-path-to-file-path import edges and the `EXTRACTED` tag - and pinned by tests the way the glob dialect is, so a schema change breaks a pinned test rather than a CI verdict.

## 2. Map bootstrapping - the adoption accelerator

Writing `architecture.yaml` for an existing codebase is the hardest step of adoption, and it is exactly what graphify's community detection answers: Leiden clusters *are* candidate territories, and the cross-community import edges *are* candidate `dependsOn` declarations.

A `heai map suggest` - or a map-editor **Import from graphify…** beside **Paste YAML…** - could read `graph.json` and emit a draft partial map: communities as territories with globs covering their files, observed edges as `dependsOn`, everything else left to the `unowned: allow` posture.
The human then does what the map-editor is built for: review, rename, assign owners, tighten.
Day one turns from writing YAML from scratch into editing a proposal, while the reviewed map stays the source of truth.

## 3. Drift detection in `heai doctor`

With both files present, cheap continuous comparisons fall out:

- **A declared `dependsOn` edge no code uses** - the README's "deprecated edges" idea with evidence attached: the tool can say this edge has been unused for N commits, consider removing it.
- **Two territories whose files inter-import more heavily than the boundary implies** - a split or merge candidate.
- **A graphify community straddling a territory boundary** - the declared boundary may be in the wrong place.

None of this gates.
It is the staleness-is-a-judgment-call register, the same as context freshness: high-signal input for the human managing the map, surfaced by `heai doctor` or a CI warning.
Graphify's post-commit hook keeping `graph.json` fresh is what makes running it on every PR viable.

## 4. Territory-scoped context for agents

Graphify extracts design rationale - `# WHY:`, `# NOTE:`, `# HACK:` comments and docstrings - as graph nodes, and answers `query`, `explain`, and `path` questions over the persisted graph.

- Generated agent files (see [heai-directory-convention.md](heai-directory-convention.md)) could instruct an agent to run `/graphify explain` on its territory's concepts before starting work: observed structure complementing the map's curated `context`.
- The context-freshness check gets sharper: not only "files changed after the context did," but *what* changed structurally in the territory since the context was written.
- Both projects ship as agent skills, so the heai skill can simply *use* graphify where present rather than integrate with it: before proposing a map change, ask graphify what actually connects the territories involved.

## Fit with the `.heai` convention

- `graphify-out/` is derived data: `cache/` belongs gitignored, while `graph.json` is designed to be committed (relative paths, merge driver). In map terms it is generated output like `INDEX.md` - it should sit in a territory, the human-owned tooling one or its own, rather than be left unowned, and hand-edits are meaningless.
- `.graphifyignore` should exclude `.heai/tasks/` and generated agent files, or the graph fills with tracker noise.
- Multi-repo maps do not line up one-to-one: graphify runs per directory tree, so a multi-repo map means one `graph.json` per repository, resolved through the proposed `~/.heai/repos.yaml` registry. The dep-gate's cross-repo story stays "the surrounding tooling's job," unchanged.

## The honest risk

Graphify is a young external project and `graph.json`'s schema is undocumented.
The split that keeps this safe: anything load-bearing - the dep-gate - consumes a minimal, test-pinned slice; bootstrapping and doctor-drift are advisory and can tolerate looseness.
If the schema drifts faster than that holds, the fallback is unchanged from today: the import-boundary tool gets written in-house, and graphify remains useful for the advisory uses alone.

# What heai-tools can take from ECC

*Idea report, 2026-09-04. A study of [affaan-m/ECC](https://github.com/affaan-m/ECC) ("Everything Claude Code", MIT, at `e04ea0b`) for what heai-tools can reuse and what new tools it suggests. Not a commitment; a companion to [oh-my-claudecode-study.md](oh-my-claudecode-study.md).*

## What ECC is

A catalogue: 68 agents, 286 skills, 94 commands, per-language rule sets and a hook graph, shipped to seven harnesses (Claude, Codex, Cursor, Gemini, OpenCode, Pi, Zed) from one source tree, plus an alpha Rust control plane (`ecc2/`).
The durable unit is `skills/*/SKILL.md`; everything else is a harness adapter.
It is a library, not a system; most of it is domain content heai-tools has no use for, and a few pieces are exactly the shape we need.

## 1. Prompt content worth lifting

- **`agents/code-reviewer.md`, lines 34-107: the best reviewer contract in either repository.** A **Pre-Report Gate** of four questions before any finding is written (can I cite the exact line; can I name the input, state and bad outcome; have I read the callers, imports and tests; is the severity defensible), a rule that HIGH and CRITICAL require the snippet, the failure scenario and why existing guards do not catch it, or are demoted, an explicit statement that **zero findings is a valid review** and manufactured findings are the primary failure mode of LLM reviewers, and a list of common false positives to skip ("consider adding error handling" where the caller handles it, magic numbers that are HTTP codes, "function too long" on a switch or a test table, "possible null dereference" after a narrowing guard). Harness-neutral; ready to be a reviewer actor's `context`.
- **`agents/{silent-failure-hunter,type-design-analyzer,comment-analyzer,pr-test-analyzer}.md`**: single-purpose review lenses, about sixty lines each. Good as territory `context` fragments where a territory has one dominant risk.
- **`agents/planner.md`** plan format (Overview, Requirements, Architecture changes, steps with file paths, risks): the body template for a task a planning run files.
- **`agents/spec-miner.md`**: extract "Requirement (WHEN → THEN)" and "Invariant" blocks per capability from existing code, with a sample-and-expand budget. A protocol for drafting a territory's `context` from its files.
- **`rules/common/agents.md`, the Delegation Completion Contract**: "your final message IS the deliverable"; "if you delegate, you own collection"; decompose only when the work cannot fit one context. Written after an observed failure where research agents returned "waiting" and orphaned their children. Belongs in agent-host's standing rules.
- **`skills/loop-design-check/SKILL.md`**: the judgment layer for autonomous loops. A four-condition gate on whether a loop should exist at all (the task repeats, verification can be automated, the budget can take it, the agent can run and see results); a five-point "machine-decidable goal" test where boundaries ("what it must NOT do") are defined beside the done criterion and reconciliation against an external fact beats "all tests pass"; and the red line that *judgment stays with the human*: the machine grinds toward the goal, the human decides whether the goal is right. This is the rationale for agent-host's `dispatch: manual` default and "a human at each landing", and the README should cite it.

Not worth lifting as text: the "Prompt Defense Baseline" pasted atop every agent, the per-language reviewer and build-resolver pairs, anything with a numeric mandate like "80% coverage".

## 2. Mechanisms

- **Three enforcing hooks** out of a large graph (`hooks/hooks.json`, `scripts/hooks/`): `config-protection.js` blocks edits to linter and formatter configuration, because agents edit them to make checks pass; `block-no-verify.js` blocks `--no-verify` and `core.hooksPath` overrides; `gateguard-fact-force.js` is a deny → state the facts → allow gate before the first edit of a file (list importers, the affected API, quote the instruction). `stop-format-typecheck.js` batches a typecheck of every file edited in a response through an accumulator. Everything else warns or measures. ECC's `docs/architecture/harness-adapter-compliance.md` is honest that hooks are "instruction-backed" on Codex and Gemini - whatever heai-tools does with hooks must stay optional and the diff gate stays the verdict.
- **`skills/safety-guard/SKILL.md` Freeze Mode**: lock Write and Edit to one directory tree. Territory confinement as a pre-edit hook, without a map. With a map, the tree comes from the actor's globs.
- **GitHub-native coordination** (`scripts/github-coordination.js`, `config/github-native-coordination.json`, `commands/epic-*.md`): an issue is the unit of work; a coordination block in its body holds owner, dependencies, validation and review state; labels carry available / claimed / ready / blocked / validated; an `unblock` sweep reopens blocked epics whose dependencies closed. tasks plus agent-host's blocked-and-unblock loop already do this on files. The transferable part is that the *policy* is a JSON document: review required, validation required, epic-only branches.
- **`skills/team-agent-orchestration/SKILL.md` work-item card**: Owner, Scope (files, branch, forbidden areas), State, Evidence, Merge gate. Evidence and merge gate are the two fields the tracker format lacks.
- **`skills/delivery-gate/SKILL.md`**: a Stop gate built only from deterministic checks (mtimes, disk, regex), explicitly separated from reasoning gates. The principle: a gate checks machine-verifiable facts.
- **`skills/{eval-harness,agent-eval,skill-comply}/SKILL.md`**: YAML task definitions with a judge, pass@k across runs, cost and time; and a compliance run that executes the same task at three prompt strictness levels and measures whether a rule is actually followed.
- **State** (`docs/design/ecc-memory-vault.md`, `schemas/provenance.schema.json`): markdown as the source of truth with SQLite only as an index, create-only writes, `trust: unreviewed` on every entry, a secret scan before writing, and provenance (source, timestamp, confidence, author) required on anything learned.
- **Cross-harness packaging** (`docs/architecture/cross-harness.md`): one source, thin per-harness adapters, a compliance matrix rendered from code and checked in CI. `.codex/agents/*.toml` shows a Codex agent as TOML with `sandbox_mode` and `developer_instructions` - the target shape for an `agents build` projection beyond Claude.

## 3. Proposals, in order

1. **`architect hook`, again.** ECC's freeze mode and `config-protection.js` are the precedents from this side: a pre-edit deny that names the owning territory, and a deny list that falls out of the map for free (the map, the schema, CI configuration, human-owned governance paths). Same proposal as the OMC report's first; two independent repositories converged on it.
2. **Evidence on a run, "done when" on a task.** A "Done when" body convention the prompt tells the agent to satisfy, and an `evidence` section on the run record: commands run and their exit codes, captured from a `/heai/runs/<id>.evidence` file the agent appends to. ECC's verifier, eval-harness and delivery-gate all rest on "fresh output, not claims".
3. **Reviewer actor pattern.** A map recipe: a `reviewer` llm-agent owning no territory, with the code-reviewer contract above as `context`; an agent-host run kind that assigns it a finished run's ref and stores the verdict beside the gate's. Author and reviewer stay separate passes by declaration.
4. **`heai doctor` checks.** Beyond the existing idea: a committed env file, a task blocked on a slug that is canceled or missing, an actor with no `context`, a running container whose `heai.map` label no longer matches the map. `commands/harness-audit.md` is the model.
5. **Context mining.** A map-editor or CLI helper that drafts a territory's `context` from its files with the spec-miner protocol (requirements, invariants, deferred list) for a human to trim. Pairs with the graphify bootstrap idea.
6. **Compliance runs.** With a non-echo image, run the same task three times at decreasing prompt strictness and count how often the gate says clean. Built on `assign --wait --json`; makes the standing rules measurable.

## 4. Not worth taking

The catalogue (286 skills, mostly domain and business content), the multi-harness install machinery (`install.sh`, `manifests/`, twelve schemas), ECC Pro and the GitHub App, the memory vault and "instinct" learning loops, `ecc2/` (a Rust TUI and SQLite session store: the supervisor heai-tools deliberately avoided), the GAN planner/generator/evaluator trio, the per-language rules directories, and the hook graph as a whole - only the three enforcing hooks carry a mechanism.

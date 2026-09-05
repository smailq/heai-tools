# What heai-tools can take from ponytail

*Idea report, 2026-09-04. A study of [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (MIT, at `974d940`) for what heai-tools' agents can reuse. Not a commitment; a companion to [ecc-study.md](ecc-study.md) and [oh-my-claudecode-study.md](oh-my-claudecode-study.md).*

## What ponytail is

A ruleset, not a library.
One `skills/ponytail/SKILL.md` of about a hundred and twenty lines tells a coding agent to be "the laziest senior dev in the room": before writing code, stop at the first rung of a seven-rung ladder that holds - does this need to exist, is it already in the codebase, does the standard library do it, does the platform, does an installed dependency, can it be one line, and only then the minimum that works.
Around that one file sit five more skills (`ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, `ponytail-help`), a compact `AGENTS.md` copy of the rules for hosts without skills, three small Node hooks that inject the text into a session and its subagents, thin adapters for some twenty harnesses, and a benchmark.
There is nothing to import: everything usable is prose, a comment convention, a hook shape and a measurement method.

## 1. Prose worth lifting

- **The ladder, as standing rules for every actor.** The seven rungs plus "the ladder runs *after* you understand the problem, not instead of it", "bug fix = root cause: grep every caller before you edit", and the non-negotiables (validation at trust boundaries, error handling that prevents data loss, security, accessibility, anything explicitly requested) are harness-neutral and fit `agent-host`'s `# How to work` section unchanged.
  The same ladder exists in oh-my-claudecode's `minimal-code-discipline` skill; ponytail's is the better written of the two and carries the benchmark.
- **One rule needs a heai-tools exception.** Rung 2, "already in this codebase → reuse it, don't rewrite", and the review tag `yagni: ... inline it until a second one exists` are exactly what design principle 1 forbids across tools: the glob dialect is written twice in `scope-gate` and `map-check` on purpose.
  An actor working on this repository needs the sentence "a copy pinned by shared tests across two tools is deliberate; do not merge it" beside the ladder, or the first `ponytail-review` of `tools/` will list the duplicates as debt.
- **Output discipline, with the host's rule last.** "Code first, then at most three lines: what was skipped, when to add it" is right for a run, and it conflicts with the host's "report what you did and what remains in your final message", which `agent-host` stores and feeds back on resume.
  Ponytail carves out "explanation the user explicitly asked for is not debt", so the conflict resolves as long as the host's rules come after the ladder in the prompt, which `prompt.ts` already does.
- **"Lazy code without its check is unfinished."** Non-trivial logic leaves one runnable check behind, the smallest thing that fails if the logic breaks; trivial one-liners need none.
  This is the smallest statement of a done criterion in any of the three studied projects and belongs in the standing rules verbatim.

## 2. Mechanisms

- **`ponytail:` markers and the debt ledger.** A deliberate shortcut with a known ceiling is marked in a comment - `# ponytail: global lock, per-account locks if throughput matters` - naming the ceiling and the upgrade trigger; `/ponytail-debt` harvests them into a ledger, one row per marker, and flags any without a trigger as `no-trigger`.
  For heai-tools this is a tracker feature that needs no model: a sweep that greps the markers, resolves each file to its territory through the map, and files a `backlog` task per marker through `task-manager new`, keyed by a hash of the comment so a rerun files nothing twice.
  A marker with no trigger becomes a task with no done criterion, which is the gap the ECC study already names.
  The sweep is a `watcher` schedule rule with a `run` action, or a script until `watcher` exists.
- **`ponytail-review` as a reviewer lens.** A review that hunts complexity only, one line per finding - `<file>:L<n>: <tag> <what to cut>. <replacement>.` with tags `delete stdlib native yagni shrink` - ending in `net: -<N> lines possible.` or `Lean already. Ship.`, and explicitly out of scope for correctness, security and performance.
  It is advisory, never edits, and is machine-parseable, which makes it a `context` fragment for the reviewer actor the ECC and oh-my-claudecode studies propose, run on a finished run's ref, its lines stored beside the gate verdict.
  It should not gate: a `net` line is a suggestion, and the design line from the ECC study holds - review informs, hard gates fail closed.
- **The subagent hook.** `hooks/ponytail-subagent.js` fires on `SubagentStart`, reads `agent_type` from stdin, applies an optional regex in `PONYTAIL_SUBAGENT_MATCHER`, and re-injects the rules, so a subagent spawned by the harness inherits them.
  This is the mechanism heai-tools is missing for territory confinement: today an actor's territories reach only the top-level prompt, and a subagent the harness spawns starts with none of them.
  A `SubagentStart` hook in the `heai/agent-claude` image that re-emits "you are `$HEAI_ACTOR`; change only these paths; requests go here" from the run's prompt file closes that gap for the Claude image, at the cost of one hook file and a settings entry in the Containerfile.
  The gate stays the verdict; the hook is steering.
- **Mode filtering of one file.** `ponytail-instructions.js` keeps one `SKILL.md` and derives the `lite`, `full` and `ultra` variants by filtering table rows and example lines tagged with the mode.
  The idea - one source, views derived by a filter - is the repository's own "derived views are regenerated" rule applied to prompt text, and the intensity levels themselves are not needed: `full` is the one to paste.
- **`scripts/check-rule-copies.js`.** Normalises seven host-specific copies of the rules and byte-compares each against `AGENTS.md`, then asserts that ten invariant phrases ("in this codebase", "ONE runnable check", "input validation at trust boundaries") are present in both `SKILL.md` and `AGENTS.md`; exit `1` on drift.
  The copy check is what `--check` already does elsewhere here.
  The invariant check is new and cheap: a `prompt.test.ts` case that the composed prompt still contains the sentences that matter - never edit the tracker, the request protocol, the confinement rule - would catch a refactor of `prompt.ts` that drops one.
- **The benchmark method.** Headless Claude Code, one model (Haiku 4.5), twelve feature tasks on a real FastAPI and React repository, four runs per arm, arms of baseline, ponytail and two rival prompts; code size from `git diff` added lines, safety by executing the produced functions against adversarial inputs as a binary pass, tokens, cost and time from the session logs.
  Result: 54% fewer lines, 22% fewer tokens, 20% lower cost, 27% less time, safety unchanged.
  The author states the limits: one model, n=4, wide variance on the frontend tasks, four cells lost to timeouts.
  Take the method, not the numbers: it is a working template for measuring a prompt change on `agent-host` runs, and it needs one prerequisite this repository lacks - a run record that carries tokens, cost and duration.

## 3. Proposals, in order

1. **Standing rules.** Add the ladder, the root-cause rule, the non-negotiables and the one-runnable-check rule to `agent-host`'s `# How to work`, with the principle-1 exception for deliberate copies. Prose only; pin the invariant phrases in `prompt.test.ts`.
2. **A `SubagentStart` hook in the Claude image** that re-injects the actor's identity and confinement from the prompt file. One hook script, one settings entry, a test against a recorded hook payload.
3. **A debt sweep.** `ponytail:` markers to `backlog` tasks by territory, deduplicated by content hash, `no-trigger` markers filed without a done criterion and shown as such. A script first, a `watcher` rule when it exists.
4. **Usage on the run record.** The runner wrapper writes tokens, cost and duration beside `.exit` when the harness reports them (`claude -p --output-format json` does); `agent-host` stores them. This is what makes proposal 5 measurable and is useful on its own on the status page.
5. **The reviewer actor's complexity lens.** `ponytail-review`'s format and tags as one `context` fragment of the reviewer actor recipe, stored beside the gate verdict, never gating.

## 4. Not worth taking

- The intensity levels and their flag file, the `/ponytail` command family, the statusline badge and the setup nudge: session ergonomics for an interactive harness, which a run is not.
- The persona voice; the rules read the same without it.
- The twenty harness adapters and the marketplace packaging: heai-tools has three images behind one runner contract, and text on stdin reaches all of them.
- `/ponytail-audit` and `/ponytail-gain`: the first is the review lens over a whole tree, better run on a territory as a task than shipped as a command; the second is a scoreboard of the author's benchmark.
- The benchmark numbers as evidence for this repository: one model, one repository, self-reported, and lines-of-code as the headline metric.

# What the ideas put in a project directory

*Re-hash, 2026-09-11. The four idea reports - [ECC](ecc-study.md), [oh-my-claudecode](oh-my-claudecode-study.md), [ponytail](ponytail-study.md), [marketing automation](marketing-automation.md) - were written against `agent-host`, `watcher` and the lane scripts, which are gone. Under [project.md](../project.md) the tools know no process, so nearly every proposal that was "a feature of agent-host" is now a file in the project directory. This document reads each report again with that in mind and says, for each item, which file it becomes.*

*Every claim below was checked against the source, cloned at the commits in the table. Line numbers are from those checkouts; the four studies' own line references were not always right, and where they were wrong or overstated this document says so rather than repeating them. Not a commitment; the last sections are what it adds up to and what is still missing.*

| repository | studied at | read at | licence | drift |
| --- | --- | --- | --- | --- |
| [affaan-m/ECC](https://github.com/affaan-m/ECC) | `e04ea0b` | `c9148d0b` | MIT, Affaan Mustafa | 56 commits; 4 named files changed, no prompt text moved |
| [Yeachan-Heo/oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) | `aaf3882` | `4820f5641` | MIT, Yeachan Heo | 37 commits; only `skills/launch` changed, not at the cited lines |
| [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | `974d940` | `356918e` | MIT, DietrichGebert | 9 commits, documentation only |
| [ericosiu/ai-marketing-skills](https://github.com/ericosiu/ai-marketing-skills) | unpinned | `09694f0` | MIT, Single Grain (the content-OS starter carries a second notice) | n/a |

Everything lifted is MIT and needs its notice carried. Two of the four are prose-only for our purposes; the code worth copying is under two hundred lines in total.

## Where an idea can land

Six places, and one protocol. Everything below is one of them.

| place | what goes there | read by |
| --- | --- | --- |
| `architecture.yaml` `context` on an actor or territory | role, invariants, review lenses, the negative scope | `heai-architect context <actor>`, composed into the prompt |
| `prompts/rules.md` | standing rules and long protocols too big for the map | the start script, appended after the map's context and the task |
| `flows/<name>.yaml` | states, `by:` on every move a person must make, `when:` on the data a script reports, `after:` clocks | `heai-flow` |
| `scripts/<process>/<move>.sh` | the mechanics: open a workspace, compose a prompt, run checks, judge a diff, file a task, advance a flow | hooks in a definition, rules in `reactor.yaml` |
| `reactor.yaml` | schedules, the `dir` source over `pod/inbox`, the `git` source over `main`, rate limits on dispatch | `heai-reactor` |
| `images/<name>/` | the Containerfile plus what it `COPY`s: skills under `/root/.claude/skills`, hooks and a `settings.json`, extra toolchains | `heai-pod build` |
| `tasks/README.md` and task bodies | the "Done when" section, the provenance line, the `run` block, amendment notes | scripts through `heai-tasks show --json`; the agent, who reads the task |

The protocol is the fact file. Inside the container the agent has `fact <dir> <event> <suffix> [<json>]` on its PATH and `/heai/inbox` mounted; `heai-pod prompt --notify /heai/inbox --event exited` writes one when the agent settles, and the agent can write its own - a request, a verdict, an evidence record. On the host a `dir` source in `reactor.yaml` over `pod/inbox` turns each file into an event and a rule runs a script that advances the flow with the file's JSON as `--data`. (`project.md` describes an inbox per flow that `heai-flow settle` folds; `flow` does not implement it, so this document uses the reactor path that `examples.md` and `sample_project` use. See the last section.)

### The two hook shapes, settled by reading them

Both repositories' pre-edit hooks are Claude Code `PreToolUse` hooks, and they deny in two different ways. This is the one mechanical fact worth having exactly right, because the image's `scope.sh` has to pick one.

- **Exit 2 and stderr.** ECC's `scripts/hooks/config-protection.js:133-140` returns `{exitCode: 2, stderr: "BLOCKED: ..."}`; the stderr text is what reaches the agent. Registered in `hooks/hooks.json:76-80`, matcher `Write|Edit|MultiEdit`, timeout 5.
- **JSON on stdout, exit 0.** ECC's `gateguard-fact-force.js:1201-1216` and OMC's `scripts/pre-tool-enforcer.mjs:1716-1724` both print `{"continue":true,"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}` and exit 0.

Either is a valid denial. The first is three lines of shell; take it. The field to read is `tool_input.file_path`, with `tool_input.file` as ECC's fallback (`config-protection.js:93`) and `tool_input.edits[].file_path` for multi-edits.

Injection is a third shape. Ponytail's `hooks/ponytail-runtime.js:82-87` writes `{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"<text>"}}`, and its comment records that raw stdout is *dropped* on `SubagentStart` though it is honoured on `SessionStart` - so the JSON is mandatory there. Its `hooks/ponytail-subagent.js:45-48` deliberately injects without reading stdin at all unless a matcher variable is set, because a hook that waits on stdin can stall every subagent spawn on Windows. Keep that property: a heai hook that prints a fixed text needs no stdin.

### The start script, once

Most of the prompt content below lands here, so its shape is worth fixing:

```sh
# scripts/session/start.sh - the hook on queued and resumable
ws=$(heai-pod open "$HEAI_LINK_REPO" --branch "agent/$HEAI_LINK_ACTOR/$HEAI_LINK_TASK" --actor "$HEAI_LINK_ACTOR")
heai-flow link "$HEAI_FLOW" workspace="$ws" map="$(git rev-parse HEAD:architecture.yaml)"
scope=$(heai-architect territories --actor "$HEAI_LINK_ACTOR" --json | jq -r '[.[].globs[]] | join(":")')
{ heai-architect context "$HEAI_LINK_ACTOR"          # the map: role, territories, what it watches
  heai-tasks show "$HEAI_LINK_TASK"                  # the work, with its Done when
  [ -f "flow/flows/$HEAI_FLOW/report.md" ] && cat "flow/flows/$HEAI_FLOW/report.md"   # the hand-off, on resume
  cat prompts/rules.md                               # the host's rules, last
} > "flow/flows/$HEAI_FLOW/prompt.md"
heai-pod start "$ws" --agent claude --env HEAI_SCOPE="$scope" --env HEAI_FLOW="$HEAI_FLOW"
heai-pod prompt "$ws" --file "flow/flows/$HEAI_FLOW/prompt.md" --notify /heai/inbox --event exited
heai-flow advance "$HEAI_FLOW" started --by start.sh
```

Map, task, hand-off, rules, in that order. Ponytail's note that the host's rules must come last holds; so does OMC's, which enforces a fixed composition order in code rather than by convention (`src/agents/prompt-ssot/types.ts`, `SECTION_KIND_RANK`: policy, task contract, safety, provider, tier, role, workflow, output). `HEAI_SCOPE` is what the in-image hooks read; `map=` on the flow is what makes a stale map visible later.

## 1. ECC

### Into the map

**The reviewer contract is `agents/code-reviewer.md:29-111`**, not 34-107 as the study says, and it is the best single artefact in either repository. Five blocks: confidence filtering (29-37), the Pre-Report Gate (39-53), HIGH/CRITICAL require proof (55-64), zero findings is valid (66-74), and the false-positive list (76-111). Add `290-297`, which the study missed and which closes the loop: *"Do not withhold approval to appear rigorous. If the diff is clean, approve it."* The gate itself:

> Before writing a finding, answer all four questions. If any answer is "no" or "unsure", downgrade severity or drop the finding. ... **Can I cite the exact line?** ... **Can I describe the concrete failure mode?** Name the input, state, and bad outcome. If you cannot name the trigger, you are pattern-matching, not reviewing. ... **Have I read the surrounding context?** ... **Is the severity defensible?**

and the sentence that justifies the whole thing:

> Manufactured findings, filler nits, speculative "consider using X", and hypothetical edge cases without a trigger are the primary failure mode of LLM reviewers.

About ninety usable lines, harness-neutral except line 23's `git diff --staged`. They become the `context` of a `reviewer` actor that owns nothing and `watches` the territories it reviews - the map already has `watches` for exactly this, so `heai-architect context reviewer` prints the contract followed by each watched territory's context, marked as watched. Lines 113-257 are a React/Node checklist with numeric mandates ("functions over 50 lines"); leave them.

**The four single-purpose lenses** (`agents/silent-failure-hunter.md`, `type-design-analyzer.md`, `comment-analyzer.md`, `pr-test-analyzer.md`) are 50-59 lines each, but nine of those are a boilerplate "Prompt Defense Baseline" and the usable content is about thirty - the study's "about sixty lines each" doubles it. Each compresses to one or two sentences of territory `context` where one risk dominates. The silent-failure list (`19-49`) is the most transferable: empty catch blocks, log-and-forget, `.catch(() => [])` fallbacks, lost stack traces, missing timeout or rollback. So: `core-db: { context: "Migrations are append-only. Hunt silent failures: no empty catch, no log-and-forget, no fallback that swallows the error." }`

**Context mining** is `agents/spec-miner.md`, and the part to take is the budget, not the format. "Sample and Expand" (`57-68`): start at entry files, trace one level, stop at an external boundary, after three barren files, or at fifteen files, and list the rest as `deferred`. Plus the guardrails (`189-198`): *"Never invent behavior"*, *"The actual contract is what callers rely on, not what docs claim"*, *"Flag, don't fix"*. Lines 99-187 are OpenSpec's own document format and are not wanted. This is the prompt inside `scripts/map/mine-context.sh`, which runs it over one territory's globs with `heai-pod prompt --wait` in a throwaway workspace and prints a draft `context` for a person to trim. A script, because its output is a map edit and a map edit is a reviewed commit.

### Into `prompts/rules.md`

**The Delegation Completion Contract**, `rules/common/agents.md:44-52`, verbatim, three numbered rules: *"Your final message IS the deliverable"*; *"If you delegate, you own collection"*; *"Decompose only when the work cannot fit in one context - depth is an outcome, not a plan."* Its rationale line is worth keeping too, because it is an observed failure rather than a theory: research agents spawned children, returned "waiting", and orphaned every result.

### Into flows and scripts

- **Reviewer as a flow.** `flows/review.yaml`: `open → clear | watch | block`, `links: { session, branch }`, hook `open: scripts/review/start.sh`, which opens a workspace on the session's branch as actor `reviewer`, prompts with `heai-architect context reviewer` plus the diff, and notifies `--event reviewed`. The reviewer ends by writing `fact /heai/inbox reviewed "$HEAI_FLOW" '{"verdict":"watch","findings":[...]}'`; a rule on `dir kind: reviewed` advances the review with that JSON as `--data`, and three `when: { verdict: ... }` transitions sort it. Author and reviewer are separate by actor, so "never self-approve" is the map's doing, not the prompt's. Whether review gates is one line: `requires: { waits-on: { all: [clear, watch] } }` on the landing definition, or its absence.
- **"Done when" on a task, machine checks in the finish script.** A `## Done when` section in the task body, by convention a list of commands; `scripts/session/finish.sh` runs each with `heai-pod run "$ws" "<cmd>" --wait` before the gate, then advances `gated --data '{"verdict":"clean","failed":0,"checks":[...]}'`. `session.yaml` reads it with `when: { verdict: clean, failed: 0 }`. The principle behind the split is `skills/delivery-gate/SKILL.md:11-17`: *"using only deterministic checks ... No AI inference"*, and *"delivery-gate checks machine-verifiable facts; self-audit checks output quality"*. What ECC's gate actually checks is library file mtimes, disk space and a rationalization regex; only the sentence transfers, as a comment at the top of `finish.sh`.
- **Doctor.** `scripts/doctor.sh` on the nightly rule: `heai-architect check --strict`, `heai-tasks build --check`, `heai-flow check`, a task `blocked` whose blocker is `canceled` or missing, an llm-agent with no `context`, a tracked `.env`, a flow whose `map` link is not the map's current blob. Exit `1` and `operator --once` is red. `commands/harness-audit.md` is a twelve-category cloud-platform scorecard and is not a model for the checks, but two of its lines are the right output contract: the script is the source of truth, *"do not rescore manually"*, and *"include exact file paths"* (`25`, `60-63`).
- **Compliance runs.** `skills/skill-comply/SKILL.md:13` has the ladder in three words - *"supportive → neutral → competing"* - meaning the same task run against a prompt that backs the rule, ignores it, and pushes against it. `scripts/bench/compliance.sh` is that: the same task three times against three `prompts/rules.md` variants, `--wait` each, counting gate verdicts. Note that ECC's own eval harness cannot execute candidates at all - `skills/eval-harness/SKILL.md:239-263`, added since the study, says execution is refused without an OS boundary - so there is nothing runnable to borrow, only the ladder. The pod is that boundary, which is the point.

### Into the image

`images/dev/hooks/scope.sh`, one `PreToolUse` hook, roughly fifteen lines: read stdin, take `tool_input.file_path`, test it against `HEAI_SCOPE`, and on a miss exit 2 with *"outside your territories; file a request instead"*. Three ECC hooks collapse into it:

- `config-protection.js` (176 lines) is a list of linter and formatter filenames; in a map that list is redundant, because CI and tooling already sit in a human-owned territory and the scope test covers them. Its one idea worth keeping is the ENOENT carve-out (`117-131`): creating a config that does not exist is allowed, only modification is blocked.
- `block-no-verify.js` (564 lines) is mostly a shell tokenizer so that quoted text and `;`/`&&` segments parse correctly. A five-line `grep` for `--no-verify` and `core.hooksPath` accepts some false positives and is the right trade here. Note it is not registered directly: it is the first entry of `PRE_BASH_HOOKS` in `scripts/hooks/bash-hook-dispatcher.js:23-27`.
- `gateguard-fact-force.js` (1347 lines) is the deny-before-first-edit gate, and **the study overstates it**. It is described as "deny → state the facts → allow", but nothing checks that any facts were stated: the second touch of the same path is allowed unconditionally (`1274-1283`). What it really implements is "make the agent stop once per file", with thirty-minute session state under `~/.gateguard/`. That is still worth having, and it is about twenty lines keyed on `session_id`, but it should be described honestly.

A fourth, `stop-format-typecheck.js`, the study lists among the enforcing hooks; it is not. It swallows formatter failures (`97-99`), writes tsc errors to stderr only (`152-155`), and always exits 0. On the host `finish.sh` can typecheck the whole tree, so neither it nor its `post-edit-accumulator.js` companion is needed.

`skills/safety-guard/SKILL.md`'s Freeze Mode (`42-50`) is prose only: line 70 says it "uses PreToolUse hooks", but no script in the repository references it and no command exposes it. It stays a precedent, not a source.

### Into the tracker

`agents/planner.md:57-98` is the plan body template - Overview, Requirements, Architecture Changes with file paths, phased steps with Action/Why/Dependencies/Risk, Testing Strategy, Risks and Mitigations, Success Criteria - documented in `tasks/README.md`, which `init` writes once and never rewrites, so a project can extend it. Drop the worked example's "80%+ coverage" line. From `skills/team-agent-orchestration/SKILL.md:23-27` and its JSON at `45-60`, the work-item card has five fields; three exist here already, and the other two land as data rather than frontmatter: evidence is the `--data` on `gated`, the merge gate is `by:` on `landed`. Its `acceptance` and `handoff` fields are "Done when" and `report.md` under other names. Provenance on a filed task is a body line naming the rule, the event and the source; `schemas/provenance.schema.json` requires `source`, `created_at`, `confidence` and `author`, but it is about imported *skills*, not memory or tasks, and `confidence` means nothing on a task.

### Already the case, or not here

GitHub-native coordination's policy-as-JSON is `by:` plus reactor rules; its `unblock` sweep is `settle` firing `requires: { waits-on: { all: [done] } }`. Cross-harness packaging is `images/<name>/` and `--agent codex`; `.codex/agents/*.toml` is nine lines of `model`, `sandbox_mode` and `developer_instructions`, and heai passes the prompt on stdin, so no projection is needed. The memory vault, the 286-skill catalogue, the installer and `ecc2/` are unchanged from the study's verdict.

`skills/loop-design-check/SKILL.md` earns a paragraph in `flows/README.md` rather than a file, and two quotes carry it: the four-condition gate (`37-42`) - the task repeats weekly or more, verification can be automated, the budget can take it, the agent can run and see results, *"miss any one → don't build a loop"* - and the red lines (`75`, `109-112`): *"the 'done' cell is flipped by a human only. The loop is the worker, not the acceptance officer."* That is the rationale for `by: [human]` and for `limit:` on the dispatch rule, and it belongs next to them.

### New since the study, worth a line

`skills/operator-approval-loop/SKILL.md` is the most relevant addition: sha256-hashed drafts and epoch-keyed decisions so that *"a stale approval cannot release a rewritten draft"*, plus one active claim per obligation. That is the same concern as `--seq` on `advance`, and it bears directly on the marketing `approved → publishing by: [human]` move below. `docs/architecture/session-adapter-contract.md` defines a canonical session snapshot shape, a useful reference for what `heai-flow show --json` should carry. And one caution: commit `c11753d0` replaced an autonomous-harness skill that documented a fabricated API endpoint. Lift protocols from this repository; verify anything that names an endpoint or a tool.

## 2. oh-my-claudecode

### Into the map

**`src/agents/prompt-ssot/sections.ts` is 255 lines holding 22 sections**, and the four role deltas are three lines each. They are short enough to quote whole, and they are the actor `context` blocks:

> `role/reviewer` (146-148): You are the read-only review lane. Evaluate the change across architecture (boundaries, layering, risks), product (user-visible behavior, acceptance criteria, regressions), and code (maintainability, tests, unsafe shortcuts). Return CLEAR, WATCH, or BLOCK with evidence; never edit the code under review.

> `role/verifier` (155-157): You are the completion-evidence lane. Every acceptance criterion gets a VERIFIED / PARTIAL / MISSING status with fresh evidence: real test output, clean diagnostics, successful builds. "It should work" is not verification; words like "should", "probably", and "seems to" demand an actual run.

> `role/executor` (137-139): implement the assigned bounded slice end to end, read the relevant code first, match existing conventions, make the smallest working change, run the focused tests that cover it, and report changed files, verification commands and results, and remaining risks.

> `role/planner` (128-130): planning output is read-only - never edit product source, run mutating commands, commit, push, or open PRs *before explicit execution approval*. That last clause assumes OMC's approval step; here it is "before the task is `in-progress`".

Reviewer and verifier are actors owning nothing; executor is the standing text every territory owner already carries; planner, if a project wants one, is an actor whose territory is `tasks/` in the project directory, and `tools/tasks/agent/tasks.md` is already written to be its `context`. One correction: the study's appendix verifier text ends with *"Verdict PASS, FAIL or INCOMPLETE, with an evidence table"*, which is in neither `sections.ts` nor `skills/verify/SKILL.md`. Treat that sentence as unsourced and drop it, or write it deliberately.

The long-form agents supply three more lenses, all harness-neutral prose:

- `agents/critic.md:108-134`, Self-Audit and Realist Check. For each finding: confidence, *"could the author refute this with context I lack?"*, flaw or preference; then the realistic worst case, the mitigation being ignored, how fast it would be detected, and whether momentum is inflating it. Line 132 is the rule that makes it work: every downgrade states what mitigates it. Lines 136-146 add adaptive harshness - escalate on any critical or three majors - which is worth having too.
- `agents/code-reviewer.md:84`: *"recall is the reviewer's responsibility; precision is the consumer's"*, with `83` making a request not to nitpick into ranking guidance, and `40`, `57` and `120` sending a low-confidence critical to Open Questions where it does not gate. Note its verdicts are APPROVE / REQUEST CHANGES, not the CLEAR/WATCH/BLOCK of `sections.ts`; pick one vocabulary for the `reviewed` fact and keep it.
- `agents/tracer.md:48-56` is the six-tier evidence hierarchy, with `64`: a hypothesis that survives only because nobody looked for disconfirming evidence stays low confidence.

`agents/explore.md:45-53` is the context budget, and it is the one that needs rewriting rather than lifting: it names `lsp_document_symbols`, `ast_grep_search` and Read's `offset`/`limit`. The idea - check size before reading, outline over 200 lines, at most five parallel reads - restates as `wc -l`, `grep -n`, `sed -n`.

The *not responsible for* and *hand off to* lines (`executor.md:12`, `critic.md:18,53`, `architect.md:13,34`) are ownership and dependency edges written as prose. They are not written by hand here: `scripts/agents/build.sh` derives them from `heai-architect territories --json`, where every territory the actor does not own is the negative scope and the hand-off is the request protocol.

### Into `prompts/rules.md`

The standing rules trace to specific lines, and all of them are three-line sections: deletion over addition, reuse before writing, no new dependency without a request, small reversible diffs (`sections.ts:30-33`); never self-approve in the pass that authored the change (`:100`); verify before claiming - *"identify what proves the claim, run the verification, read the output, then report with evidence"* (`:88`); the final report names changed files, verification commands with their actual results, simplifications made and remaining risks, and never presents partial work as complete (`:246-247`); the commit trailers (`:61-70`, six of them - the study's appendix drops `Scope-risk:`). Add:

- `templates/rules/karpathy-guidelines.md:41`, *"every changed line should trace directly to the user's request"*, and `:35`, *"if you notice unrelated dead code, mention it - don't delete it"*. Fifty-nine lines, no coupling at all.
- The final-response contract, `code-reviewer.md:157-159` and `architect.md:102-104`: the last assistant message is the deliverable, never a content-free sign-off.
- Three strikes, which appears in three places; `skills/launch/SKILL.md:118` is the cleanest: the same verification failure surviving three repair attempts halts that lane with a root-cause hypothesis for the human.
- Advisory versus hard, `sections.ts:109-112`: advisory checks fail open with a bounded, visible warning; hard checks fail closed only for secrets and privacy, destructive mutation, release authority, proven corruption, and security boundaries.

### Into flows and scripts

- **Blocked has a shape.** `skills/launch/SKILL.md:112` is the source: on a decision it cannot make, a worker stops *before* the decision-dependent mutation, records the question as options, a recommendation and a reversibility note, exits through the failed transition, and nobody reopens it in the same run. Here that is the request protocol: the prompt says to write `fact /heai/inbox request $HEAI_FLOW '{"territory":..,"title":..,"options":[..],"recommend":..,"reversible":..}'` and stop. A rule on `dir kind: request` runs `scripts/request/file.sh`, which refuses a fact missing any of the three parts (exit 1, the fact archived), else files `heai-tasks new` in the named territory with a provenance line, starts a `request` flow, links the session `--waits-on` it, and lets `finish.sh` report `requested: true` on `gated`. `session.yaml` already has every state for this. One thing the appendix adds that OMC does not say: *"commit what you have"*. Keep it, but know it is ours.
- **Three strikes, as a script.** `scripts/session/requeue.sh` counts `failed` and `violation` flows for the task with `heai-flow list session --link task=$slug --json`; under three it starts a new session, at three it files a task in the human territory with the last action log as the root-cause note and blocks the task. A script with a number in it, which is where policy goes.
- **Hand-off.** `finish.sh` saves `heai-pod read "$ws" --lines 60` as `flow/flows/$id/report.md`; `start.sh` on `resumable` prepends it. Decided / Rejected / Risks / Files / Remaining is what `prompts/rules.md` already asks for in the final message, so the tail of the screen *is* the hand-off.
- **Receipts and verify.** `session.yaml` declares links `base`, `head`, `map`; `finish.sh` sets base and head from the clone under `pod/repos/<name>`, which lives on the host; `scripts/session/verify.sh <id>` re-runs the gate from those three and reports drift. OMC's envelope is `{schemaVersion, kind, issue, createdAt, payload}` (`receipts/epic-3698/README.md:14-20` - the study omits `issue`), and its rule that matters is `33-36`: evidence carries the exact `sha` it was produced against, and a non-green result is kept as truth rather than discarded.
- **Verification tiers → `checks.yaml`.** `src/verification/tier-selector.ts` is 131 dependency-free lines and its rules are four lines of YAML: security or architectural paths → thorough; more than 20 files → thorough; fewer than 5 files and under 100 lines and full coverage → light; otherwise standard. Each tier carries an `evidenceRequired` list (light: diagnostics clean; standard: plus build passes; thorough: plus full review, all tests, no regressions). Drop its `agent` and `model` fields, which bind to OMC agent names, and drop its regex path detectors: "sensitive" is a property the map already states, so `finish.sh` asks `heai-architect owner` instead of matching `auth|secret|token` against paths.
- **Evaluator contract.** `src/autoresearch/contracts.ts:8-12` is frontmatter `evaluator: {command, format: json}`; the command prints `{pass: boolean, score?: number}`, and `parseEvaluatorResult` (`179-202`) throws on non-JSON, a non-object, a missing or non-boolean `pass`, or a non-numeric `score` - fail-closed, as the study says. A real example is five lines with `command: npm run build`. Here it is a fenced `check` block under "Done when", extracted from `heai-tasks show --json` and run through `heai-pod run --file`.
- **Declarative deliverables.** `templates/deliverables.json` is 25 lines: per stage, `files`, `minSize` (default 200 bytes), `requiredSections` (substring match) and `requiredPatterns` (regex). The study calls it advisory; it is weaker than that. `scripts/verify-deliverables.mjs:213-218` computes its issues and then discards them, printing `{continue:true, suppressOutput:true}` in every branch. The check logic is real and about forty lines; the reporting was removed on purpose. As a per-task "done when" it only needs to be made blocking, which here means printing the failures and exiting non-zero so `when:` sees them.
- **Projections with digests.** `src/projection/manifest.ts` records `{kind, sourcePath, outputPath, digest, byteLength, gitBlob?}` per file under a manifest of `{schemaVersion, engineVersion, sourceRevision, generatedAt, projections[]}`, and normalises CRLF and trailing newlines before hashing (`46-51`). The study's `{source, output, sha256, sourceRevision}` flattens two levels and conflates this with a second manifest module whose `sourceRevision` is a hand-bumped label like `2026-08-13.1`, not a hash - which is worth knowing, because a hand-bumped revision is exactly the drift the mechanism is supposed to catch. For `scripts/agents/build.sh --check`, source path, output path, digest and the map's blob sha are enough; run it from a `git` rule on commits to `main` touching `architecture.yaml`, and in CI beside `heai-tasks build --check`.
- **Stale verdicts.** `src/team/cli-worker-contract.ts:45-54` is the payload the study quotes, and the identity fields (`claim_token`, `task_version`, `launch_attempt_id`) are what let a settle step reject a verdict from an earlier run. Here that is `--seq` on `advance`, which `flow` already has, so the review script passes it. Two details: its verdicts are `approve|revise|reject`, and line 129 says that a worker which cannot reach a verdict writes `revise` with an explanatory finding rather than exiting silently - a good rule for the `reviewed` fact.

### Into the image

The pre-edit territory gate is the same `scope.sh` as ECC's, and the confirmation is worth stating plainly: OMC has a dependency-free glob matcher with deny-over-allow and a `..` escape check (`src/team/permissions.ts:27-135`, about 80 portable lines, no regex and so no ReDoS) and a `PreToolUse` hook that can deny, and **it never wires them together**. The hook's 1975 lines deny on state, routing and skill misuse, and never look at `tool_input.file_path` for scoping. Its own header says path scoping is advisory because workers run in full-auto. Inside the pod the deny is real, which is the whole argument for doing what OMC declined to. If the matcher is ported rather than done with shell `case`, exercise the single-star backtrack at `77-83` first, which decides "was this a `*` or a `**`" by peeking backwards at the pattern.

Skills go under `images/dev/skills/<name>/SKILL.md`, `COPY`d to `/root/.claude/skills`, so any project on that image has them and a `context` can say "run the review skill": `verify` (37 lines, no coupling, lift whole), `minimal-code-discipline` (59 lines, ladder at `30-42`, non-negotiables at `46-51`, drop its `level: 3` frontmatter and one cross-reference), `execute` (49 lines, drop the Scale section naming OMC's own modes), and `review` (42 lines; its frontmatter name is `omc-review`, and the lines that matter are `32`, *"the reviewer must not be the author's same active context"*, `35`, *"no findings is a valid result"*, and `36-37`, the advisory-by-default gate split). Repository-specific skills belong in the governed repository's `.claude/skills/`, inside a human-owned territory, so a change to a skill is a reviewed diff.

### Into the tracker

`docs/adr/03664-ralph-prd-criterion-amendment.md:16-24` is the amendment ledger entry: `kind` (replaced or superseded), the `original` verbatim, an optional `replacement`, a `reason`, `evidence` of at least ten characters, an `authority` and a `timestamp`; a malformed ledger, or an original still active, invalidates the whole document on read (`39`). Here most of it is free, because `tasks` never rewrites a body and only appends notes. The convention is that a "Done when" line changes by a note quoting the original verbatim with a reason and an author. From `skills/ralph/SKILL.md:51`: completion is never inferred from branch or PR state, which is a warning signal only; `53-69` makes "done" a list of observable checks (`fileExists`, `fileContains`, `gitGrep`) and still requires a reviewer pass afterwards.

### Already the case, and what is deferred

Derived status is `operator`; `src/team/phase-controller.ts` computes a phase from the distribution of task statuses and stores nothing, which is the same discipline as `INDEX.md`. Append-only logs are the journal and `reactor/events`. The launch handshake is `heai-pod start` printing a pane id before `started` is advanced.

`heai bench` becomes `scripts/bench/gate.sh` first - fixture diffs against a fixture map, no model - then `scripts/bench/review.sh` over `heai-pod prompt --wait`. OMC's benchmark layout is the template: per-lens directories (`code-reviewer`, `debugger`, `executor`, `harsh-critic` - not `critic` as the study says) each with `prompts/`, `fixtures/`, `ground-truth/`, a runner, shared scorer and reporter, committed baselines, and `--dry-run`, `--save-baseline`, `--compare`. Ground truth is `{fixtureId, expectedVerdict, isCleanBaseline, findings[{id, severity, category, summary, keywords[], location}]}` and the scorer matches on keywords; two clean baselines exist purely to measure false positives.

One addition since the study fits here: `skills/ask-navigator/SKILL.md`, which charts a foggy effort into decision tickets on the tracker and works one per session, *"produces decisions, never deliverables"*. That is the planner actor whose territory is `tasks/`.

## 3. ponytail

### Into `prompts/rules.md`

`skills/ponytail/SKILL.md` is 120 lines and about sixty of them are the rules; the rest is persona and session ergonomics. What to take, by line:

| lines | what |
| --- | --- |
| 36-42 | the seven rungs: does this need to exist, already in this codebase, stdlib, native platform, installed dependency, one line, then the minimum that works |
| 44-48 | *"The ladder is a reflex, not a research project - but it runs after you understand the problem, not instead of it."* |
| 50-54 | *"Bug fix = root cause, not symptom ... grep every caller of the function you're about to touch ... one guard in the shared function is a smaller diff than a guard in every caller"* |
| 58-64 | the rules, ending with the `ponytail:` marker convention and its example |
| 68-75 | output discipline: code first, then at most three lines, with the carve-out that explanation the user asked for is not debt |
| 92-95 | the non-negotiables: input validation at trust boundaries, error handling that prevents data loss, security, accessibility, anything explicitly requested |
| 97-101 | *"Never lazy about understanding the problem. The ladder shortens the solution, never the reading."* |
| 107-112 | *"Lazy code without its check is unfinished"* - one runnable check for non-trivial logic, none for trivial one-liners, *"YAGNI applies to tests too"* |

Strip the frontmatter, the 3am persona, `## Persistence` (26-30), `## Intensity` (77-88) and `## Boundaries` (114-120). There is a fourth carve-out at 103-105 about hardware calibration that the study missed; drop it unless the project has hardware.

Two findings change how this is copied. **The mode filter is not a tag system**: `hooks/ponytail-instructions.js:11-41` filters by two regexes, a table row whose first cell is a mode name and a bullet beginning `- <mode>: "`, and only six lines in the whole file are mode-specific. So "one source, views derived by a filter" is thinner than the study implies, and pasting `full` means pasting nearly everything. **And `AGENTS.md` is not a copy.** It is a 32-line condensed rewrite that drops the output-discipline section and the marker example entirely. Copying it instead of the skill silently loses two rules.

The principle-1 exception - *a copy pinned by shared tests across two tools is deliberate; do not merge it* - is not a standing rule. It is the `context` of the `tools` territory in this repository's own map, because it is true here and nowhere else.

### Into the reviewer's context

`skills/ponytail-review/SKILL.md` is 57 lines and the machine-readable part is four of them: the line format `<file>:L<n>: <tag> <what to cut>. <replacement>.` (`18-19`), the five tags `delete stdlib native yagni shrink` (`23-27`), and the close, `net: -<N> lines possible.` or `Lean already. Ship.` (`46-48`). Scope is explicit at `52-56`: correctness, security and performance are out, a single smoke test is never flagged, and it lists without applying. One paragraph of the `reviewer` actor's `context`, its lines carried in `findings` and its `net` in the data, never gating.

### Into scripts

**The debt sweep.** `skills/ponytail-debt/SKILL.md` gives the grep (`20`): `grep -rnE '(#|//) ?ponytail:' .`; the marker grammar (`31`): `ponytail: <ceiling>, <upgrade path>`; and the ledger row (`29`): file and line, what was simplified, the ceiling, the upgrade trigger. Two cautions the study does not carry. The grep hits prose in markdown - it finds thirty matches in ponytail's own repository, most of them documentation - so `scripts/debt/sweep.sh` must restrict to code extensions. And `no-trigger` detection is a model's judgement in prose, not a regex, so a script either files every marker and lets a human tag the triggerless ones, or asks an agent. Filing is `heai-tasks new debt-<8 hex of file:line:text> --status backlog --territory <heai-architect owner>`; a slug already taken is exit 2 and the sweep moves on, which is what makes a rerun file nothing twice.

**Invariant phrases.** `scripts/check-rule-copies.js` is 76 lines: byte-compare seven host copies against `AGENTS.md` (`19-27`), then assert that a list of phrases is a substring of both `SKILL.md` and `AGENTS.md` (`44-58`), exit 1 on any failure. The list is **nine phrases, not ten**: `in this codebase`, `naive heuristic`, `ONE runnable check`, `flimsier algorithm`, `input validation at trust boundaries`, `prevents data loss`, `security`, `accessibility`, `Lazy code without its check is unfinished`. The copy check is what `--check` does elsewhere here; the invariant check is the new and cheap one, as a `scripts/test.sh` case that composes a prompt for a fixture actor and greps it for the sentences that must never be lost - never edit the tracker, the request protocol, the confinement rule.

**The benchmark method.** `benchmarks/agentic/run.py` is the working template, and the study got its most useful mechanical detail wrong. Tokens, cost and duration do not come from session logs: the runner invokes `claude -p <prompt> --model ... --output-format json ... --append-system-prompt <no-run guard>` and saves stdout as `_claude.json` (`259-269`), which carries `total_cost_usd`, `duration_ms`, `num_turns`, `usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}` and `permission_denials`. That is far simpler for `finish.sh` than parsing a harness transcript, and it is the route to take. The rest of the method: five arms including baseline, 300 seconds per cell with a tree-kill, code size from `git diff --cached --numstat` added lines with tests split out, and safety scored by importing the produced module and running adversarial inputs. Two LLM judges also run, which the study does not mention. One thing to note before copying the command: it passes `--permission-mode bypassPermissions`, which is how it avoids prompts. That is acceptable exactly because the pod is a container, and it is worth saying so in the script rather than leaving it as an unexplained flag.

### Into the image

`images/dev/hooks/subagent.sh`, one `SubagentStart` hook: print `{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"you are $HEAI_ACTOR; change only $HEAI_SCOPE; requests go to /heai/inbox"}}` and exit. Both variables are in the pane's environment from the start script. Read no stdin - ponytail's own default path does not, for a documented reason - and skip the mode flag file and matcher regex, which are a plugin's concerns, not ours. Registration goes beside `scope.sh` in the image's `settings.json`; ponytail registers through a plugin manifest, which is the shape to avoid copying.

### Not here

Confirmed as the study says: `ponytail-gain` (a fixed ASCII scoreboard of the author's medians), `ponytail-help`, the statusline, the mode tracker, the command family, the MCP server, and the twenty-odd harness adapters. Nothing has changed in the rules, hooks, scripts or benchmark since the study.

## 4. Marketing automation

This report was already a project directory; only the tool names have moved, and reading the skills turned up several things that change the design.

### The rename

| in the report | now |
| --- | --- |
| `marketing-operator/` with `agent-host.yaml`, `lanes.yaml`, `watcher.yaml` | the project directory with `pod.yaml`, `reactor.yaml`, and the lanes as `landing`, `checkpoint`, `promotion`, `release` definitions with their scripts |
| `marketing/` beside it | `repositories.content.localPath` in the map; `heai-pod repo add content` |
| `territories.<t>.paths` | `scope: [{ repository: content, globs: [...] }]` |
| `by: [agent-host, watcher]` | `by: [pick.sh]`, the script the dispatch rule runs |
| `by: [human, lanes]` on landing and promotion | `by: [human]`; `land.sh` and `promote.sh` are what the human runs |
| `on: released, by: [human, lanes]` | `approved → publishing on release by: [human]`, then `publishing → published \| failed by: [publish.sh]`: the person's move is the decision, the hook on `publishing` runs the script, and the script's move is the fact |
| `by: [growth-analyst, inbox]` on readback | a `readback` fact from the analyst's container, a `dir` rule, `heai-flow advance ... --by readback.sh` |
| the `watcher` schedules and the playbook rule | `schedule` sources, and a `git` source on `main` of the content repository whose rule reads `paths` from `REACTOR_EVENT` and files one task per writer whose channel's playbook moved |
| `pacing-alert.py` exit 1 | the analyst writes one `alert` fact per alert; a rule files a task to `lead` |
| the `marketing` image under `tools/agent-host/image/` | `images/marketing/Containerfile` in the project directory |

### What reading the skills changes

**The image's dependency list is shorter than the report says.** Neither skill imports `requests`; `pacing-alert.py` uses stdlib `urllib.request`. The actual list is `apt-get install python3 python3-pip` plus `ffmpeg` only if `editorial-brain.py` is wanted, and `pip install numpy>=1.24 scipy>=1.10 feedparser>=6.0 anthropic>=0.39` plus `yt-dlp` for the same script. Everything else is standard library.

**Only two of the eight scripts need a credential, and the split falls exactly where the report wants it.** `content-transform.py` (unless `--template-only`) and `editorial-brain.py` need `ANTHROPIC_API_KEY`, both container-side, so the pod env file. `pacing-alert.py` needs three platform URLs and three tokens, which are host-side, so they live with the publish and metrics scripts and never enter a container. The other five need nothing.

**Vendoring the skills into `brand`'s territory is not merely tidy, it is forced.** `content-transform.py` reads its voice and style guide through `VOICE_CONFIG_FILE` and `STYLE_GUIDE_FILE`, so those two can live anywhere - and neither ships upstream, so `brand/` has to supply both. But `references/patterns.md`, the rejection-pattern file the panel checks every round, has **no environment override**: it is read from the skill directory. So a lead-owned `patterns.md` means the skill directory itself sits in `lead`'s territory, which is what the report proposed for other reasons. Upstream it is a fifteen-line empty template.

**Three numbers in the report are wrong, and one of them matters.** The panel threshold in `content-ops/SKILL.md:103` is 90 over a maximum of three rounds, as the report says, but `content-transform.py`'s own built-in panel uses 95. The deterministic scorer's default threshold is 60, not the panel's number, and its weights live in a machine-written file inside the data directory - so if the rubric is meant to be lead-owned, that file's territory needs deciding. And `content-quality-gate.py` **never exits non-zero**: a failed gate prints a warning and returns 0. As the lane check the report proposes, it needs a wrapper that reads `filtered_draft_count` from its output. Its input shape is also not the drafts on disk: it wants `{"drafts":[{id,platform,draft}]}`, so something must convert `content/<channel>/drafts/*.md` first.

**The readback loop has a gap nobody has closed.** `autogrowth-weekly-scorecard.py` does not read the JSON that `experiment-engine.py` writes; it parses `results.tsv` and `playbook.tsv`, and there is no JSON path in the code despite its docstring. Wiring the weekly scorecard into the loop needs an export step that does not exist upstream. That is a script in the project directory, and it should be named as work rather than assumed.

Smaller corrections: the engine has a sixth subcommand, `list`; its per-agent directory holds a third file, `active.json`; and `score` can return a per-variant `crash` alongside the four experiment-level states. `growth-engine/SKILL.md` has no YAML frontmatter at all, so as a vendored Claude Code skill it will not advertise itself and the task body must name it. `skill-safety.yml` is a GitHub Actions workflow that runs a PII scan and checks for a marketing CTA; reading it before vendoring, as the report advises, yields nothing about agent conduct. Telemetry opt-out is not an environment variable: it is `{"opted_in": false}` in `~/.ai-marketing-skills/telemetry-config.json`, which the image should bake, and the preamble's paths are repository-root-relative so they break on vendoring anyway. One script writes outside its data directory - `editorial-brain.py` caches into `/tmp` - which is fine in a container and worth knowing.

### The lifecycle sentence, verified

`content-os-portable-starter/README.md:39-41` states the chain `SIGNAL -> CANDIDATE -> EVIDENCE_READY -> DRAFT -> REVIEW -> APPROVED_FOR_DRAFT_WRITE -> DRAFT_WRITTEN -> APPROVED_FOR_PUBLISH -> PUBLISHED -> READBACK -> LEARNING`, then: *"Each transition must be persisted, attributable, idempotent, and blocked when its required approval or evidence is absent."* Three of those four are what `flow` is - the journal persists, `--by` attributes, `by:` and `requires:` block - and the fourth, idempotence, is the one the project's scripts have to supply themselves, with a lock or a content hash, exactly as the debt sweep does. Its neighbouring gates at `27-35` are the same three moves the report splits out: drafting is not publishing, publishing is separately approved, fail closed.

### The open questions, settled by what exists

1. *Panel inside the writer or as `editor`.* `editor` is the review flow of sections 1 and 2, unchanged; a channel that wants one run per batch runs the panel inside the writer. Both are legal, and `requires:` on landing is the single line that decides whether `editor` gates.
2. *Where `log` at publish belongs.* In `publish.sh`, the hook on `publishing`, because a hook runs on the host where the credentials are, and the experiment log write then never touches a writer's branch.
3. *A flow per draft.* Yes; `flow/by-link/experiment/<id>/` and `heai-flow trace experiment=<id>` are what make hundreds of them navigable, and the batch is the task they all link.
4. *Committing `experiments/`.* Unchanged: commit it until it hurts, then point `GROWTH_ENGINE_DATA_DIR` at state and copy only `playbook.json` in.

Add a fifth, from ECC's newest skill: a draft approved by a person and then rewritten must not stay approved. Hash the draft at the `approved` move and have `publish.sh` refuse a head whose hash has moved. That is the same concern `--seq` handles for verdicts.

### Phasing, renamed

Phase 1 needs only the map, the tracker, `pod` and a human running `heai-flow start session` by hand. Phase 2 is the four landing definitions. Phase 3 is the `piece` and `experiment` definitions. Phase 4 is the schedules. Every phase is a directory of files copied in and edited, and because `flow` and `reactor` are built, phases 3 and 4 no longer wait on a tool.

## What it adds up to: the software template

The four reports converge on one starter directory, which is what `templates/software/` should be when it is remade:

```
prompts/rules.md                   standing rules: ladder, non-negotiables, one runnable check, final message, three strikes, trailers
architecture.yaml                  a human territory over ci, the map and .claude; a `reviewer` actor that watches and owns nothing
tasks/README.md                    the contract plus: the Done when section, the provenance line, the amendment note, the plan template
checks.yaml                        three tiers of commands and the thresholds that pick one
flows/session.yaml                 the flow README's session, with links base, head, map and `when: { verdict: clean, failed: 0 }`
flows/request.yaml                 as in sample_project
flows/review.yaml                  open → clear | watch | block, advanced by the reviewer's fact
flows/{landing,checkpoint,promotion,release}.yaml   the removed template's four, with `by: [human]` where a person decides
scripts/session/{start,finish,requeue,verify,cancel}.sh
scripts/request/file.sh            the request fact into a task and a waits-on link; refuses a fact without options, a recommendation and a reversibility note
scripts/review/start.sh
scripts/landing/{land,announce}.sh  scripts/checkpoint/check.sh  scripts/promotion/promote.sh  scripts/release/release.sh
scripts/debt/sweep.sh              ponytail: markers into backlog tasks by territory, code extensions only
scripts/agents/build.sh            .claude/agents/*.md and AGENTS.md from the map, with a digest; --check
scripts/map/mine-context.sh        a draft context for one territory, with the sample-and-expand budget
scripts/doctor.sh                  every --check the tools have, plus the cross-tool ones; exit 1 is red on operator
scripts/pick.sh                    the one script with a policy in it: todo tasks into sessions, with a lock
scripts/test.sh                    the worked day against a fake harness; the invariant phrases in a composed prompt
reactor.yaml                       clock, tasks_cli, dir over pod/inbox (exited, request, reviewed, alert), git over main, nightly
images/dev/{Containerfile,settings.json,hooks/scope.sh,hooks/subagent.sh,skills/}
pod.yaml
```

Everything in it is copied and edited; no tool reads any of it by name. The prose files carry their upstream MIT notices.

## Still tool changes, small and later

Only three items in the four reports do not fit the project directory as the tools stand, and none is needed to start:

- `tasks` recognizing a fenced `check` block the way it recognizes `run`, once two projects' finish scripts have extracted it with `awk`.
- `pod` carrying usage on a settled fact. The shape is now known rather than guessed: `claude -p --output-format json` prints `total_cost_usd`, `duration_ms`, `num_turns` and a `usage` object, so the helper can lift four fields without parsing a transcript.
- `flow`'s per-flow inbox from `project.md`, or the decision that the reactor's `dir` source is the inbox and `project.md` is corrected. The second is a documentation change and the smaller one.

`architect` accepting a harness hook payload directly is not proposed: the in-image hook reads `HEAI_SCOPE` from the pane's environment, which the start script sets from `heai-architect territories --json`, and the gate on the host stays the only verdict.

## Corrections to the four studies

Worth keeping separately, because each one would have been copied forward otherwise.

1. ECC's reviewer contract is at `agents/code-reviewer.md:29-111`, not 34-107, and the study misses `290-297`, the instruction not to withhold approval to seem rigorous.
2. ECC's `gateguard-fact-force.js` does not verify that facts were stated. It allows the second touch of any path unconditionally. It is "stop once per file", not "deny → state the facts → allow".
3. ECC's `stop-format-typecheck.js` never blocks and swallows its own failures; it is not one of the enforcing hooks.
4. ECC's four review lenses are about thirty usable lines each, not sixty.
5. ECC's `safety-guard` freeze mode is prose with no implementation anywhere in the repository.
6. OMC's `policy/commit-protocol` and `safety/hard-boundaries` are section ids inside `sections.ts`, not paths; `benchmarks/critic` is `benchmarks/harsh-critic`.
7. OMC's verifier appendix text ends with a sentence about a PASS/FAIL/INCOMPLETE verdict table that is in no OMC file. It is ours, not theirs.
8. OMC's `verify-deliverables.mjs` computes its findings and then discards them; the study's "advisory" overstates what it does.
9. OMC's projection manifest is two levels deep and the study flattens it, conflating a sha256 `sourceRevision` with a second module's hand-bumped label.
10. Ponytail's copy-checker asserts nine invariant phrases, not ten.
11. Ponytail's benchmark takes tokens, cost and duration from `claude -p --output-format json` stdout, not from session logs.
12. Ponytail's `AGENTS.md` is a condensed rewrite that drops the output-discipline rule and the marker example; it is not a copy of the skill.
13. Ponytail's debt grep matches prose in markdown; a sweep needs an extension filter, and `no-trigger` is a judgement, not a regex.
14. The marketing skills import no `requests`; the weekly scorecard reads TSV files the engine never writes; `content-quality-gate.py` always exits 0; `content-transform.py`'s internal panel threshold is 95 and the deterministic scorer's is 60; `references/patterns.md` has no environment override; `skill-safety.yml` is a CI workflow, not a policy.

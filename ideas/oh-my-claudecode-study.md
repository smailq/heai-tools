# What heai-tools can take from oh-my-claudecode

*Idea report, 2026-09-04. A study of [Yeachan-Heo/oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) (OMC, MIT, at `aaf3882`, v5.2.0) for what heai-tools can reuse and what new tools it suggests. Not a commitment; a companion to [ecc-study.md](ecc-study.md).*

## What OMC is

A multi-agent orchestration layer for Claude Code: 20 agent definitions, 35 skills, a 12-event hook graph, and about 400k lines of TypeScript that keep a team of harness sessions working a backlog - workers in tmux panes, a leader mailing them tasks, Stop hooks that refuse to let a session end while a plan has unfinished stories.
It is the opposite of heai-tools in scale and in posture: it is a supervisor, and most of its size is the cost of being one.
Its own lightweight-workflow epic (`docs/design/ISSUE-3698-LIGHTWEIGHT-WORKFLOW-PLAN.md`) exists to undo that, and its `remaining-risk.json` admits the reduction did not happen.
Read that as a cautionary tale, and take the small, specific things below.

## 1. Prompt content worth lifting

**The single best artifact is `src/agents/prompt-ssot/sections.ts`**, not the agent files.
It is a registry of about twenty normative sections, each three to eight lines, with an `id`, an `owner`, a `version`, and one rule: every clause is authored exactly once, then composed into per-role files under `generated/prompt-ssot/` with a header carrying the source revision and a digest, and `prompt-ssot:check` fails CI on a stale projection.
That is the shape of heai-tools' own `context` blocks, and the mechanism the `agents build` idea in [heai-directory-convention.md](heai-directory-convention.md) wants.
The role sections are near drop-in `context` text for llm-agent actors (adapted versions in the appendix):

- **Reviewer**: read-only lane, returns CLEAR / WATCH / BLOCK with evidence, never edits the code under review.
- **Verifier**: every acceptance criterion gets VERIFIED / PARTIAL / MISSING with fresh evidence; "should", "probably" and "seems to" demand an actual run.
- **Executor**: implement the bounded slice end to end, smallest working change, report changed files, verification commands with results, remaining risks.
- **Planner**: planning is read-only; no product source edits, mutating commands, commits or pushes before explicit approval.

Standing rules worth adding to agent-host's composed prompt, from the same file: prefer deletion over addition; reuse before writing; no new dependency without a request; small reversible diffs; never self-approve in the pass that authored the change; a final report names changed files, verification commands with their actual output, and remaining risks.

**Long-form agents** in `agents/*.md` share one skeleton worth copying as a `context` template: Role with an explicit *not responsible for* list naming the other actor, Why this matters, Success criteria, Constraints with a *hand off to* line, an investigation protocol, an output format, failure modes to avoid, and a final checklist.
The negative scope and the hand-off line are ownership and dependency edges written as prose - a map already has both, so a generated agent file can write those lines from the map.

Strongest individually:

- `agents/critic.md`: **Self-Audit** and **Realist Check** phases. For each major finding: confidence, "could the author refute this with context I lack?", flaw or preference; then "what is the realistic worst case, what existing mitigation am I ignoring, how fast would it be detected, am I inflating because I found momentum?" Every downgrade must state what mitigates it. Liftable verbatim as reviewer `context`.
- `agents/code-reviewer.md`: "recall is the reviewer's responsibility; precision is the consumer's" - a request not to nitpick is ranking guidance, never permission to drop findings. Severity *and* confidence per finding; a low-confidence critical goes to open questions and does not gate.
- `agents/tracer.md`: a six-tier evidence-strength hierarchy and "a hypothesis that survives only because nobody looked for disconfirming evidence stays low confidence".
- `agents/explore.md`: a context budget section (check size before reading, outline over 200 lines, at most five parallel reads).
- `templates/rules/karpathy-guidelines.md`: 59 lines, no coupling. "Every changed line should trace directly to the request"; "if you notice unrelated dead code, mention it, don't delete it".

**Skills**: `skills/{execute,review,verify}/SKILL.md` are the canonical minimal forms, forty lines each, Goal / Workflow / Rules / Output. `review` states the gate split cleanly: *advisory by default - review informs, it does not gate; hard gates (release, security, destructive operations) stay separate and fail closed*. `skills/minimal-code-discipline/SKILL.md` is a self-contained YAGNI ladder (existence first, reuse, stdlib before dependency, shortest correct diff, mark the accepted ceiling in a comment) with non-negotiables that must never be minimized away. `skills/launch/SKILL.md` carries the **verifiability test** for the human/agent boundary: *if this is done wrong, can the system detect it, and can it redo or roll back automatically? Both yes, agent; otherwise, human.*

## 2. Contracts worth adopting

- **The last message is the deliverable.** Several agents end with a Final Response Contract: the last assistant message is what callers see; never end with "done" or "looks good". agent-host already treats the tail of the log as the run's report, so its prompt should say this.
- **Blocked is terminal, and has a shape.** `skills/launch/SKILL.md` C4: on a decision it cannot make, a worker stops *before* the decision-dependent mutation, records the question as options, a recommendation and a reversibility note, and exits through the failed transition; nobody reopens it in the same run. heai-tools' "file a request and finish blocked" is the same move; the request body should require those three parts.
- **Three strikes.** The same verification failure surviving three repair attempts halts the lane with a root-cause hypothesis for the human (`launch`, `executor.md`, `architect.md` all say it). A cheap rule for the prompt and for `dispatch: auto`.
- **Completion is never inferred from git state.** `skills/ralph/SKILL.md`: branch or PR state is a warning signal only; done is a declared observable check, and even then a reviewer pass. agent-host's gate verdict is not "done" either; the README should say so.
- **Criteria may be amended, never weakened silently.** `docs/adr/03664-ralph-prd-criterion-amendment.md`: an acceptance criterion is retired only by a ledger entry keeping the original verbatim plus reason, evidence, authority and timestamp; a malformed ledger invalidates the whole document on read. The anti-drift rule tasks should adopt for "done when" lines.
- **Commit trailers as the decision record** (`policy/commit-protocol`): `Constraint:`, `Rejected:`, `Directive:`, `Confidence:`, `Scope-risk:`, `Not-tested:`. Since everything in heai-tools is reviewed as a diff, this puts the agent's reasoning where the reviewer reads.
- **Hand-off document**: ten to twenty lines, Decided / Rejected / Risks / Files / Remaining, written to a file the next stage reads first. Files, harness-neutral, and the shape a cooperation request's body should take.
- **Structured verdict through a file, not chat** (`src/team/cli-worker-contract.ts`): harnesses that cannot call tools write `{role, task_id, verdict, summary, findings[{severity, message, file, line}], claim_token, task_version, launch_attempt_id}` to a pre-agreed path the orchestrator polls. The identity fields let a settle step reject a stale verdict from an earlier run of the same task - easy to under-build, painful to retrofit.
- **Advisory versus hard** (`safety/hard-boundaries`): advisory checks fail open with a visible warning; only secrets, destructive mutation, release authority, integrity and security boundaries fail closed.

## 3. Mechanisms worth taking

- **A pre-edit territory gate.** OMC has a dependency-free, ReDoS-safe glob matcher with deny-over-allow and a `..` escape check (`src/team/permissions.ts`), and a `PreToolUse` hook that can deny a tool call with a reason (`scripts/pre-tool-enforcer.mjs`). It never wires the two together - the file's own header says path scoping is "advisory only" because its workers run in full-auto mode. heai-tools can do what OMC declined to: an `architect hook` that reads the tool call, resolves `HEAI_ACTOR`, and denies an edit outside the actor's territories naming the owner. Inside agent-host's container the deny is enforceable, not a suggestion.
- **Declarative deliverables** (`templates/deliverables.json`, `scripts/verify-deliverables.mjs`): per stage, required files, minimum size, required sections and patterns. Advisory in OMC; as a per-task "done when" contract for agent-host it need only be made blocking.
- **Evaluator contract** (`missions/*/sandbox.md`, `src/autoresearch/contracts.ts`): frontmatter `evaluator: {command, format: json}`; the command emits `{pass, score?}`; parsed fail-closed. Two files, no service: a machine-decidable "done" for a task.
- **Receipts** (`receipts/epic-3698/README.md`): a small envelope `{schemaVersion, kind, createdAt, payload}` binding evidence to an exact SHA, with non-green results kept as truth. agent-host's run record is already most of one; adding the base and head SHAs and a `verify` that re-derives the verdict makes a run auditable after its container is gone.
- **Verification tiers** (`src/verification/tier-selector.ts`): files and lines changed, architectural or security-touching paths, test coverage, mapped to light / standard / thorough, each with an `evidenceRequired` list. 130 lines, no dependencies; the natural way to scale the settle step.
- **Projections with digests** (`src/projection/manifest.ts`): a manifest of `{source, output, sha256, sourceRevision}` per generated file, so "this agent ran against a stale map" is a digest comparison. This is how `agents build --check` should work, and how agent-host can label a container with the map hash it was told (it already does) and warn when the map has moved.
- **Derived status** (`src/team/phase-controller.ts`): the team's phase is computed from the distribution of task statuses, never stored. Same discipline as `INDEX.md` and agent-host's settle.
- **Append-only event logs** (`events.jsonl`, the ultragoal `ledger.jsonl`) and **launch handshakes** (`launch-attempts/{expected,ack,decision}.json`) - the second answers "did my detached run actually start?", which agent-host currently infers from the pid file alone.
- **Benchmarks with ground truth** (`benchmarks/{code-reviewer,critic,debugger,executor}/`): fixtures with deliberately embedded flaws, `ground-truth/*.json` per finding, a snapshot of the prompt under test, clean baselines to measure false positives, a `--dry-run` that validates the pipeline without model spend, committed baselines for regression.

## 4. Proposals, in order

1. **`architect hook`: the gate in-session.** A second input format for the existing verdict: read a harness's pre-edit event on stdin, exit 2 with the owning territory named when the path is outside `HEAI_ACTOR`'s scope. Same map, same rules, delivered while the agent can still stop. Feature of architect.
2. **`agents build` done as prompt-ssot.** Actor and territory contexts become versioned sections; projections (`.claude/agents/*.md`, `AGENTS.md`, agent-host's prompt) compose in canonical order with a digest header; `--check` fails on stale or stray files. Feature of a new `heai` command or of agent-host, which already composes the prompt.
3. **Done criteria on a task.** A "Done when" body convention with an optional `evaluator:` command, parsed fail-closed, plus the amendment ledger rule. agent-host records the evaluator's `{pass, score}` beside the gate verdict and refuses to call a run `succeeded` when the evaluator says no. Feature of tasks and agent-host.
4. **Run receipts and a `verify`.** The run record gains base and head SHAs and the map hash; `agent-host verify <run>` re-runs the gate from those and reports drift. Feature of agent-host.
5. **A reviewer actor recipe.** A map recipe: an llm-agent owning nothing, given the reviewer or critic `context` from the appendix; an agent-host run kind that assigns it a finished run's ref and stores CLEAR / WATCH / BLOCK beside the gate verdict, honouring "never self-approve in the pass that authored the change". Doc plus a small agent-host feature.
6. **`heai bench`.** Fixtures with ground truth for the gate (a diff touching two territories must be refused - no model needed), then for reviewer and verifier actors through agent-host. Deterministic scorer first, model runner second, `--dry-run` and committed baselines from day one. New tool.

## 5. Not worth taking

- The supervisor: tmux panes, pane scraping, idle nudges by `send-keys`, the leader/worker mailbox, `runtime-v2.ts` (5k lines), `bridge.ts`, merge orchestration, auto-commit after every edit. The last two fight "everything reviewed as a diff" directly.
- Regex intent inference (role routing by keyword, completion-claim detection). heai-tools already knows the owner declaratively.
- The graph workflow engine, hook registry with shadow cutover, model-tier routing tables, SQLite, `better-sqlite3`, `ast-grep`, the committed `dist/`.
- `commands/*.md` (22 near-identical stubs), the 1200-line notifications skill, twelve translated READMEs, seminar slides, geobench, contributor leaderboards.
- Stop-hook persistence loops ("the boulder never stops"): 2600 lines to keep a session alive against the harness. A detached run plus a settle step gets the outcome without the fight.

## Appendix: adapted texts

Adapted from OMC (MIT) into harness-neutral wording, for use as map `context` or as agent-host standing rules.

**Standing rules for any llm-agent**

> - Prefer deletion over addition when behaviour is preserved. Reuse existing utilities before writing new ones. Add no dependency without an explicit request.
> - Keep diffs small, reversible and easy to review. Every changed line should trace to the task; mention unrelated problems, do not fix them.
> - Never approve your own work in the pass that authored it.
> - Verify before claiming completion: say what would prove the claim, run it, read the output, report with the evidence. "Should", "probably" and "seems to" mean run it.
> - Your final message is the deliverable: changed files, the verification commands with their actual results, simplifications made, remaining risks. Never end with "done".
> - The same failure surviving three repair attempts stops the work, with a root-cause hypothesis for a human.
> - Commit trailers when a decision was made: `Constraint:`, `Rejected: <alternative> | <why>`, `Directive:`, `Confidence:`, `Not-tested:`.

**Reviewer actor**

> You are the read-only review lane. Evaluate the change across architecture (boundaries, layering, risks), behaviour (acceptance criteria, regressions) and code (maintainability, tests, unsafe shortcuts). Return CLEAR, WATCH or BLOCK with evidence; never edit the code under review.
> Recall is your responsibility; precision is the reader's: a request not to nitpick is ranking guidance, never permission to drop a finding. Give every finding a severity and a confidence; a low-confidence critical goes under Open Questions and does not decide the verdict.
> Before finalizing, for each major finding: could the author refute this with context you lack? Is it a flaw or a preference? What is the realistic worst case, what existing mitigation are you ignoring, how fast would it be detected? Every downgrade states what mitigates it. A clean review is a valid review.

**Verifier actor**

> You are the completion-evidence lane. Every acceptance criterion gets VERIFIED, PARTIAL or MISSING with fresh evidence: real test output, clean diagnostics, a successful build, run by you now. Reject on sight: "should", "probably", "seems to", "all tests pass" without output, a type check not run, a build not run. Verdict PASS, FAIL or INCOMPLETE, with an evidence table.

**Filing a request (the blocked shape)**

> Stop before the change you cannot make. Write the request with: the options you see, the one you recommend, and whether the choice is reversible. Commit what you have. Finish saying what you are blocked on; do not work around it.

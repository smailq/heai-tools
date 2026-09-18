# Git inside pod: a tight integration, and the exemption it needs

*Proposal, 2026-09-18. `pod` already runs two gits - the host's, over the clones under `pod/repos`, and Herdr's, over the worktrees inside the container - and admits to neither. Everything a process actually wants to know about a piece of work is a git question (what changed, against what, is it committed, is it home) and today every one of those is answered by a script reaching around the tool: [`examples.md:96`](../examples.md) runs `git -C pod/repos/app diff --name-only "main...$branch"` because `pod` offers nothing. This document proposes making git a first-class part of `pod` alongside Herdr, and says plainly which design principle that breaks and what the amended principle should read. Not a commitment.*

*Revised the same day after a review against the sources, and again after the three questions the review left open were answered: `pod` stays local and never pushes, the fact file carries only what is committed, and there is no `pod git --` escape hatch. The review found one hazard that already exists (host `git gc` can prune live container worktrees), one contradiction with the fact-file protocol in the proposed exemption, and one design gap - everything was keyed by a workspace id the README itself calls non-durable. All three are folded in below; the last section lists every change.*

## The short version

Five things, in order of how much they are worth:

1. **An exemption, written down first.** Principles 1, 3 and 5 in [`README.md`](../README.md) say each tool stands alone, tools cooperate through files, and anything outside this repository is a plugin. Git and Herdr are neither peer tools nor plugins: they are the substrate `pod` is made of, the way a filesystem is the substrate `tasks` is made of. The principles need one reviewed paragraph saying so before any of the rest lands.
2. **One git model, three layers, with a rule about which layer answers.** Reads about a *branch* run on the host, in the clone. Anything touching a *working tree* runs in the container, through Herdr. Nothing else runs git at all.
3. **A git surface on the command line**: `diff`, `log`, `show`, `commit`, and git facts inside `list --json` and `status`. This is the part that deletes `git -C pod/repos/app ...` from every project's scripts.
4. **Git in the fact file.** `--notify` today reports an agent's mood. It should also report what the agent produced: branch, head, base, commits ahead. A flow that wants "the agent finished and committed something" should not need a second poller in `reactor.yaml` to learn the second half.
5. **Attribution that survives review.** The actor reaches the pane as `GIT_AUTHOR_NAME`; there is no email, no committer identity worth trusting, and no trailer tying a commit to the workspace, the actor or the task. Provenance is the whole argument for running agents in a pod; it should be in the commit, not only in the journal.

## 1. The exemption

The README is explicit that the principles bind: *"These hold for every tool in `tools/` and for every tool proposed. A change that breaks one needs a reviewed edit to this section first."* So the edit comes first, and this is the proposed wording, to be added as a note under the five:

> **Git and Herdr are pod's substrate, not its peers.**
> Principles 1, 3 and 5 govern how the tools in this repository relate to *each other*. They do not govern the things a tool is built out of. `pod` may depend on git and on Herdr as deeply as it needs to: call them directly, model their objects, pin their versions, and refuse to run without them. A branch, a worktree, a commit and a workspace are `pod`'s own vocabulary, not a plugin's.
> The exemption is narrow, and these still hold for `pod`: no other heai tool may be invoked by it or may invoke it; what it learns from git reaches another tool only as a file or as the output of its own command line; and `pod/repos` and `pod/worktrees` are its own, read and written by nothing else. `pod/inbox` is not covered by that last clause - it is a mailbox, and a `dir` source in `reactor.yaml` reading it is principle 3 working as intended.

What the exemption buys, stated as a test: after it, `heai-pod diff <ws> --name-only | heai-architect gate --actor <a>` is idiomatic, and `git -C pod/repos/app ...` in a project's script is a smell. What it does not buy: `pod` calling `heai-architect` itself, `pod` knowing what a flow or a task is, or `flow` reading `pod/repos`.

Two smaller consequences worth naming in the same edit. Principle 4, *formats are plain, small and universal*, is unaffected and in fact strengthened: the new outputs are JSON objects and porcelain-stable text. Principle 2, *the command line is the primary interface*, is what forces the work: every git fact this proposal exposes has to be reachable as a command and as `--json`, not only as a field some other tool could look up.

## 2. Where git leaks today

Read against the current sources.

| seam | today | what it costs |
| --- | --- | --- |
| the gate's input | scripts run `git -C pod/repos/<name> diff --name-only "main...<branch>"` | every project hardcodes the clone layout, the base ref and the three-dot form; `pod` could change any of them and break them all |
| the base ref | `open --base <ref>` is passed to `herdr worktree create` and then forgotten - `workspaces.ts` records `repo`, `branch` and `actor` as metadata tokens, not `base` | nothing downstream can compute "what this work changed" without being told the base again, out of band |
| what came back | `list --json` reports Herdr's view: id, label, tokens, path, agents, panes. No head, no dirtiness, no ahead/behind | `operator` can show that an agent is idle but not whether it committed; a human decides by opening a terminal |
| the fact file | `{"workspace","pane","agent","state","exitCode"}` | "exited 0" and "exited 0 having committed nothing" are the same event to a flow |
| attribution | `agents.ts:40` sets `HEAI_ACTOR`, `GIT_AUTHOR_NAME`, `GIT_COMMITTER_NAME`; the base image sets a system-wide `user.email heai@localhost` | every agent's commits share one email, the committer is only as trustworthy as the name, and nothing in the commit names the workspace or the task |
| work coming home | `repo pull-branch` fetches the branch into a host checkout, and that is the whole of it | this one is right as it stands, and this proposal keeps it: `pod` is local, and the push to a real remote is a script's decision, made from the host checkout `pull-branch` filled |
| the worktree on the host | a worktree's `.git` points at `/repos/<name>/.git`, a container path, so host git does not resolve in `pod/worktrees/...` | the one genuinely confusing thing about the layout, documented in the README and otherwise unmitigated |
| stale worktrees | `close --keep-worktree` leaves files and the registration; nothing ever prunes | Herdr already reports `is_prunable` per worktree (see `test/fixtures/herdr/worktree-list.json`) and `pod` ignores it |
| concurrent git | `repo fetch` fast-forwards the clone from the host while agents commit in worktrees of the same object store | no lock, no guard, and the failure is a confusing git error in someone else's pane |

## 3. The model, and the rule about which layer answers

```
host git  ──► pod/repos/<name>          the host's git: clone, fetch, pull-branch; reads never write a remote
                    │  shared object store and ref store
container git ──►  /worktrees/<name>/<branch>   Herdr's git: worktree create/remove, the agent's commits
pod       ──► the only thing that narrates either to a caller
```

The rule: **a question about a branch is answered on the host, in the clone; an action on a working tree is performed in the container, through Herdr.** A commit made in a worktree is in the clone's ref store the instant it is made, because a linked worktree shares the common directory, so every read - `diff`, `log`, `show`, ahead/behind, head sha - is a host operation needing no container at all, and therefore works while the container is down. Dirtiness, staging and committing are working-tree operations and go through the container. Nothing runs git in `pod/worktrees` from the host, ever; the README's warning about the unresolvable `.git` file becomes a design rule instead of a caveat.

Two corollaries worth building on:

- **`pod` reads work without the box running.** `pod diff`, `pod log`, `pod list --git` against a stopped container are legitimate and should be. Only `status` needs the runtime.
- **`pod` is local, all the way down.** The container never gains a remote, and `pod` never writes to one: `clone` and `fetch` read `origin`, `pull-branch` moves a branch between two directories on the host, and nothing in this proposal adds a push. Landing is a decision with a policy in it, so it is a script - a flow's hook or a reactor rule - that runs `repo pull-branch` into a host checkout and pushes from there with its own credentials. That keeps the exemption's last clause honest: the script touches its own checkout, never `pod/repos`.
- **The durable key is `<repo> <branch>`, not the workspace id.** The README already says it: *the branch is the durable name of the work; the workspace id is Herdr's handle on it for as long as the server runs.* `close` removes the workspace and its tokens; a Herdr restart may renumber. A gate or a landing script runs exactly then. So every read below takes either a workspace id or a `<repo> <branch>` pair, the workspace form is sugar that resolves to the pair through the tokens, and anything `pod` needs to remember about a branch lives in git, not in Herdr: `git config branch.<branch>.heai-base <ref>` on the clone, with `heai-actor` and any caller-supplied `heai-task` beside it. The tokens become a cache of the same facts for `list`.
- **The clone must be told not to prune.** A linked worktree's registration under `pod/repos/<name>/.git/worktrees/` points at `/worktrees/...`, a container path. On the host that path does not exist, so host `git worktree prune` - and `git gc`, which runs it with a three-month expiry - would delete the registration of a *live* worktree. This is not a new risk; `repo fetch` can trigger auto-gc today. `repo add` sets `gc.worktreePruneExpire=never` on the clone, and pruning is a container operation. See section 7.

## 4. The surface

Proposed additions, in the shape the existing commands take. Everything prints plain text and takes `--json`.

```sh
heai-pod open <repo> --branch <n> --base <ref> [--set k=v]...   # base recorded in the clone's git config, and defaulted
heai-pod diff  <work> [--name-only|--stat|--patch] [--base <ref>] [--json]
heai-pod log   <work> [-n <count>] [--json]            # the branch's commits since base
heai-pod show  <work> [--json]                         # head sha, subject, author, committed at
heai-pod commit <workspace> -m <msg> [--all]           # in the container, attributed and trailered
heai-pod repo prune [<name>]                           # in the container: worktrees Herdr reports prunable
```

`<work>` is a workspace id, `w2`, or a `<repo> <branch>` pair; the reads take either and need no container. `commit` takes a workspace only, because it needs the working tree. There is deliberately no `pod git -- <cmd>`: an escape hatch is how a surface stays incomplete, and a project that needs a git command `pod` lacks has `repo pull-branch` and its own checkout.

**`diff` is the one that matters.** `heai-pod diff <ws> --name-only` is `git diff --name-only <base>...<branch>` in the clone, with the base taken from the workspace's recorded token, so `examples.md`'s gate script becomes:

```sh
if heai-pod diff "$HEAI_LINK_WORKSPACE" --name-only | heai-architect gate --actor "$HEAI_LINK_ACTOR"
```

which knows no paths, no clone layout and no base ref. The old line keeps working; nothing about the clone changes.

**`--base` becomes durable.** `open` writes `branch.<branch>.heai-base` into the clone's config, and `heai-actor` beside it, and, when `--base` is absent, resolves and records the clone's checked-out branch by name rather than leaving it implicit. A name, not a sha: the three-dot diff finds the merge base, so `main` moving after `open` still gives "what this work changed". `--set k=v` stores any further caller fact the same way - `--set task=t1` is how a task id reaches a commit trailer without `pod` learning what a task is. The same facts go into the Herdr tokens for `list`, but git is the copy that outlives the workspace. This is a small change in `workspaces.ts` and `repos.ts` and the precondition for all of the above.

**Git in `list --json` and `status`.** Each workspace gains a `git` object, computed on the host in one batched call per repository:

```json
{"branch":"agent/api-owner/t1","base":"main","head":"9f21c0a","subject":"cache the index","ahead":3,"behind":0,"changedFiles":7,"dirty":true,"lastCommitAt":"2026-09-18T11:02:14Z"}
```

`dirty` is the only field needing the container; it is `null` when the container is down, and the rest still answers. The data for an `operator` line reading "idle, 3 commits, clean" is then there in the JSON it already reads; the line itself is a change to `operator`, and the one a human actually looks at.

**Git in the fact file.** The body gains the same object under `git`, so a `dir` source in `reactor.yaml` carries it as event data and a flow's `when:` can branch on `ahead > 0` without a `git` source polling the same clone a minute later:

```json
{"workspace":"w2","pane":"w2:p2","agent":"w2","state":"idle","exitCode":0,
 "git":{"branch":"agent/api-owner/t1","base":"main","head":"9f21c0a","ahead":3}}
```

This is the one piece that must be computed **inside** the container, because `--notify` detaches and the host process is gone by the time it settles. `settled` gains a small git read in the pane's own worktree - `git -C <cwd>` resolves there, and the base comes from `branch.<branch>.heai-base` through the shared config - and `fact` merges it into the body. It stays POSIX shell and `jq`, and it is the only new code that runs in the box. The fact reports what is committed and nothing else: `branch`, `base`, `head`, `ahead`. The working tree's state is `list --json`'s to report, where a wrong answer is cheap, not the event a flow acts on; a flow that wants to catch an agent that stopped with uncommitted work asks `list --json` when the fact arrives.

**Attribution.** The pane's environment gains `GIT_AUTHOR_EMAIL` and `GIT_COMMITTER_EMAIL` from a new `identity:` block in `pod.yaml` (`<actor>@<domain>`, defaulting to the current `heai@localhost`), and `pod commit` appends trailers:

```
Heai-Actor: api-owner
Heai-Workspace: w2
Heai-Branch: agent/api-owner/t1
```

The actor comes from the branch's config, the workspace from the tokens, and anything set with `--set` at `open` becomes a trailer of its own, `Heai-Task:` for `--set task=t1`. Trailers, not a message convention, because `git log --format='%(trailers:key=Heai-Actor)'` is a query and prose is not. An agent committing on its own is unaffected; only `pod commit` trailers. `commit` refuses the clone's own workspace - the one `list` shows as `linked: false`, which Herdr opens when the first worktree is made - because a commit there lands on the clone's checked-out branch, not on a piece of work.

**Coming home stays as it is.** `repo pull-branch <name> <branch> [--into <path>]` is the one way work leaves `pod/`, and the script that calls it owns what happens next - a push, a pull request, a merge - with the credentials and the policy that script has. `pull-branch` gains the branch's `heai-*` facts on stdout with `--json`, so the script does not have to ask twice.

**Safety, as refusals rather than documentation.** `repo fetch` takes a lock file under the state directory so two fetches do not interleave; it cannot move a worktree's branch, and git refuses that on its own, so no further guard is claimed. `diff` against a base the clone does not have refuses, exit 2, naming the ref and `repo fetch` - a read that works with the container down must not quietly reach the network. Each of these is a line in the exit-code table the README already has.

## 5. What `pod` delegates to Herdr, stated once

The exemption cuts both ways: being allowed to depend on Herdr deeply means deciding what *not* to reimplement. The division to write into the README:

| Herdr owns | pod owns |
| --- | --- |
| making and removing worktrees, and the branch at creation | the clone, `fetch` and `pull-branch` |
| the workspace, its panes, its metadata tokens | what the tokens mean: repo, branch, base, actor |
| the agent's lifecycle and state | what the agent produced, in git terms |
| the worktree's `is_prunable`, `is_detached`, `branch` | acting on those - `repo prune`, run in the container, and refusing a detached workspace |
| resuming agents on restore | nothing; `pod` does not second-guess it |

Two mechanical follow-ons. `image/HERDR_VERSION` pins 0.9.0 and the client in `herdr.ts` reads exactly the fields recorded in `test/fixtures/herdr/`; a tighter integration means a version probe at `up` that refuses a container whose Herdr is below the pinned floor, exit 2, rather than failing later on a missing field - through `herdr --version` if it exists, which the fixtures do not show, else the `version` a `status` response carries, to be recorded first. And the fixtures become the contract: any field this proposal starts reading needs a recorded response before the code reads it.

## 6. Phases

Each phase is independently useful and independently reviewable.

1. **The exemption.** The README paragraph above, plus the delegation table, plus a matching note in [`project.md`](../project.md)'s pod section. No code. Everything else depends on it being accepted as written.
2. **`base` becomes durable, and a git read layer.** `branch.<branch>.heai-*` written at `open`; `gc.worktreePruneExpire=never` set at `repo add` and on every existing clone at first use; a `git.ts` in `tools/pod/src` that runs host git in the clone, resolves `<work>` to a `<repo> <branch>` pair, and returns the object above; `list --json` and `status` carry it. Tests against a real temporary clone, not a fake - host git is cheap to fake badly and there is no reason to.
3. **The read commands.** `diff`, `log`, `show`, and `--json` on `pull-branch`. `examples.md` and `sample_project/scripts` switch to `heai-pod diff`; the old form stays valid and undocumented.
4. **The fact file's git object.** `settled` and `fact` in `image/bin`, with the helper tests under `sh` extended; a fixture for the merged body. Additive - a new key in the same object - so nothing that reads today's facts changes.
5. **Write operations and hygiene.** `commit` with trailers, `identity:` in `pod.yaml` and its schema entry, `repo prune`, the fetch lock, the Herdr version probe.

Phases 1 and 2 are the proposal's core; 3 is what callers feel; 4 and 5 can wait behind a real use.

## 7. Risks, and what this does not do

- **Host git can prune live worktrees, today.** The clone's `.git/worktrees/<id>/gitdir` names a container path. On the host it is missing, so `git worktree prune` there removes it, and auto-gc runs `worktree prune` with a three-month expiry - a clone that has been fetched from the host for long enough loses a worktree that is still open in the container. Phase 2 sets `gc.worktreePruneExpire=never` on every clone; `repo prune` runs only in the container; and no host command in this proposal runs `gc` or `prune`. The failure mode before the fix is silent, which is why it is first here.
- **Ownership on the bind mount.** The container's git writes as root into `pod/repos/<name>/.git`; the host's git then writes into the same object store as the invoking user. `safe.directory` handles the trust check and not the permissions. Phase 2 should fail loudly on a permission error and say which side wrote last, rather than producing a half-updated ref store. Worth a shared-repository setting on the clone.
- **Two writers, one object store.** Host `fetch` and container commits are concurrent by construction. Git's own locking makes this safe for refs; the lock proposed above is for `pod`'s sequencing, not git's correctness. No phase here introduces a host operation that rewrites history in the clone, and none should.
- **The surface grows.** `pod` gains five commands and a config block, against a README that is already long. The mitigation is that four of them are one git invocation each and share one module; if `git.ts` grows past a few hundred lines, that is the signal the rule in section 3 has been broken somewhere.
- **Not proposed:** a `pod` that knows what a flow, a task or the map is; git operations in `pod/worktrees` from the host; a second remote inside the container; a push from anywhere in `pod`; rewriting `reactor`'s `git` source, which watches the *real* repository's branches and is a different job from watching a workspace's branch.

## 8. Decisions

The review left three questions open; they are answered, and the answers are already applied above.

1. **`push` does not belong in `pod`.** Every operation of `pod` is local. Pushing to a remote is a decision with a policy in it, and it is made by a script - a flow's hook or a reactor rule - from the host checkout that `repo pull-branch` fills. `pod` never holds a credential for a remote's write side and never needs one.
2. **`dirty` is not in the fact file.** The fact carries what is committed. The working tree is `list --json`'s to describe.
3. **No `pod git -- <cmd>`.** The surface is `diff`, `log`, `show`, `commit` and the facts in `list --json`, `status`, `pull-branch --json` and the fact file. Anything a project needs beyond that is a sign the surface is short, to be filed against this document, not routed around.

## 9. What the review changed

Against the first draft, in the order of the findings:

1. `repo prune` ran `git worktree prune` without saying where; on the host that deletes live worktrees' registrations. It is a container operation now, `gc.worktreePruneExpire=never` is set on every clone in phase 2, and the pre-existing auto-gc hazard is the first risk in section 7.
2. The exemption said nothing but `pod` reads under `pod/`, which contradicts reactor's `dir` source over `pod/inbox`, and said git facts leave only as files, which misses `operator` reading `list --json`. Both clauses reworded.
3. Every command was keyed by a workspace id that dies with `close` or a Herdr restart. Reads now take `<repo> <branch>` as well, and the workspace form is sugar.
4. `base` lived in a Herdr token and was lost at `close`. It lives in `branch.<branch>.heai-base` on the clone now, with the actor and `--set` facts beside it; the token is a cache.
5. A `repo fetch` refusal about moving a branch a workspace holds described something fetch cannot do. Removed; the lock stays.
6. `diff` fetched a missing base itself, putting the network inside a read that is meant to work offline. It refuses and names `repo fetch`.
7. `push` was proposed without saying it only makes sense for a `remotePath` origin; for a `localPath` checkout it is `pull-branch` from the wrong side. The review narrowed it; the decision in section 8 then removed it altogether.
8. The fact's git object was read from `/repos/<repo>`; it is read in the pane's worktree, one location, and `dirty` is out of the fact.
9. `commit` on the clone's own workspace was not refused. It is.
10. Three overstatements softened: `operator` does not get a new line "for free", adding a key to the fact is not a protocol change, and `herdr --version` is unverified.

Then, once the three questions in section 8 were answered: `push` is gone from the surface, the model and the phases; `dirty` is gone from the fact file and its example; `pod git --` is gone from the surface and phase 3; and `pull-branch` gains `--json` so a landing script gets the branch's facts from the one command it already calls.


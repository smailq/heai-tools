# Git inside pod: a tight integration, and the exemption it needs

*Proposal, 2026-09-18. `pod` already runs two gits - the host's, over the clones under `pod/repos`, and Herdr's, over the worktrees inside the container - and admits to neither. Everything a process actually wants to know about a piece of work is a git question (what changed, against what, is it committed, is it home) and today every one of those is answered by a script reaching around the tool: [`examples.md:96`](../examples.md) runs `git -C pod/repos/app diff --name-only "main...$branch"` because `pod` offers nothing. This document proposes making git a first-class part of `pod` alongside Herdr, and says plainly which design principle that breaks and what the amended principle should read. Not a commitment.*

## The short version

Five things, in order of how much they are worth:

1. **An exemption, written down first.** Principles 1, 3 and 5 in [`README.md`](../README.md) say each tool stands alone, tools cooperate through files, and anything outside this repository is a plugin. Git and Herdr are neither peer tools nor plugins: they are the substrate `pod` is made of, the way a filesystem is the substrate `tasks` is made of. The principles need one reviewed paragraph saying so before any of the rest lands.
2. **One git model, three layers, with a rule about which layer answers.** Reads about a *branch* run on the host, in the clone. Anything touching a *working tree* runs in the container, through Herdr. Nothing else runs git at all.
3. **A git surface on the command line**: `diff`, `log`, `show`, `commit`, `push`, and git facts inside `list --json` and `status`. This is the part that deletes `git -C pod/repos/app ...` from every project's scripts.
4. **Git in the fact file.** `--notify` today reports an agent's mood. It should also report what the agent produced: branch, head, base, ahead, dirty, files changed. A flow that wants "the agent finished and committed something" should not need a second poller in `reactor.yaml` to learn the second half.
5. **Attribution that survives review.** The actor reaches the pane as `GIT_AUTHOR_NAME`; there is no email, no committer identity worth trusting, and no trailer tying a commit to the workspace, the actor or the task. Provenance is the whole argument for running agents in a pod; it should be in the commit, not only in the journal.

## 1. The exemption

The README is explicit that the principles bind: *"These hold for every tool in `tools/` and for every tool proposed. A change that breaks one needs a reviewed edit to this section first."* So the edit comes first, and this is the proposed wording, to be added as a note under the five:

> **Git and Herdr are pod's substrate, not its peers.**
> Principles 1, 3 and 5 govern how the tools in this repository relate to *each other*. They do not govern the things a tool is built out of. `pod` may depend on git and on Herdr as deeply as it needs to: call them directly, model their objects, pin their versions, and refuse to run without them. A branch, a worktree, a commit and a workspace are `pod`'s own vocabulary, not a plugin's.
> The exemption is narrow, and these still hold for `pod`: no other heai tool may be invoked by it or may invoke it; nothing it learns from git reaches another tool except as a file; and no tool other than `pod` may read or write anything under `pod/`.

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
| work coming home | `repo pull-branch` fetches the branch into a host checkout; there is no push | the last hop to the real remote is left to the caller, which is the hop that needs credentials the container does not have - exactly the hop `pod` is best placed to own |
| the worktree on the host | a worktree's `.git` points at `/repos/<name>/.git`, a container path, so host git does not resolve in `pod/worktrees/...` | the one genuinely confusing thing about the layout, documented in the README and otherwise unmitigated |
| stale worktrees | `close --keep-worktree` leaves files and the registration; nothing ever prunes | Herdr already reports `is_prunable` per worktree (see `test/fixtures/herdr/worktree-list.json`) and `pod` ignores it |
| concurrent git | `repo fetch` fast-forwards the clone from the host while agents commit in worktrees of the same object store | no lock, no guard, and the failure is a confusing git error in someone else's pane |

## 3. The model, and the rule about which layer answers

```
host git  ──► pod/repos/<name>          the only credentialed git: clone, fetch, push, pull-branch
                    │  shared object store and ref store
container git ──►  /worktrees/<name>/<branch>   Herdr's git: worktree create/remove, the agent's commits
pod       ──► the only thing that narrates either to a caller
```

The rule: **a question about a branch is answered on the host, in the clone; an action on a working tree is performed in the container, through Herdr.** A commit made in a worktree is in the clone's ref store the instant it is made, because a linked worktree shares the common directory, so every read - `diff`, `log`, `show`, ahead/behind, head sha - is a host operation needing no container at all, and therefore works while the container is down. Dirtiness, staging and committing are working-tree operations and go through the container. Nothing runs git in `pod/worktrees` from the host, ever; the README's warning about the unresolvable `.git` file becomes a design rule instead of a caveat.

Two corollaries worth building on:

- **`pod` reads work without the box running.** `pod diff`, `pod log`, `pod list --git` against a stopped container are legitimate and should be. Only `status` needs the runtime.
- **Credentials stay where they are.** The container never gains a remote. `push` is a host operation from the clone to `origin`, which is the clone's own source - the map's `localPath` or `remotePath` that `repos.ts` already resolves.

## 4. The surface

Proposed additions, in the shape the existing commands take. Everything prints plain text and takes `--json`.

```sh
heai-pod open <repo> --branch <n> --base <ref> ...     # --base recorded as a metadata token, and defaulted
heai-pod diff  <workspace> [--name-only|--stat|--patch] [--base <ref>] [--json]
heai-pod log   <workspace> [-n <count>] [--json]       # the branch's commits since base
heai-pod show  <workspace> [--json]                    # head sha, subject, author, committed at
heai-pod git   <workspace> -- <any git command>        # the escape hatch, run in the clone, branch-scoped
heai-pod commit <workspace> -m <msg> [--all]           # in the container, attributed and trailered
heai-pod push  <workspace> [--remote origin] [--force-with-lease]   # host, clone to origin
heai-pod repo prune [<name>]                           # worktrees Herdr reports prunable, then `git worktree prune`
```

**`diff` is the one that matters.** `heai-pod diff <ws> --name-only` is `git diff --name-only <base>...<branch>` in the clone, with the base taken from the workspace's recorded token, so `examples.md`'s gate script becomes:

```sh
if heai-pod diff "$HEAI_LINK_WORKSPACE" --name-only | heai-architect gate --actor "$HEAI_LINK_ACTOR"
```

which knows no paths, no clone layout and no base ref. The old line keeps working; nothing about the clone changes.

**`--base` becomes durable.** `open` writes a `base=<ref>` token beside `repo`, `branch` and `actor`, and, when `--base` is absent, resolves and records the clone's current default branch rather than leaving it implicit. Every later read uses the token. This is a two-line change in `workspaces.ts` and the precondition for all of the above.

**Git in `list --json` and `status`.** Each workspace gains a `git` object, computed on the host in one batched call per repository:

```json
{"branch":"agent/api-owner/t1","base":"main","head":"9f21c0a","subject":"cache the index","ahead":3,"behind":0,"changedFiles":7,"dirty":true,"lastCommitAt":"2026-09-18T11:02:14Z"}
```

`dirty` is the only field needing the container; it is `null` when the container is down, and the rest still answers. `operator` gets "idle, 3 commits, clean" for free, which is the line a human actually reads.

**Git in the fact file.** The body gains the same object under `git`, so a `dir` source in `reactor.yaml` carries it as event data and a flow's `when:` can branch on `ahead > 0` without a `git` source polling the same clone a minute later:

```json
{"workspace":"w2","pane":"w2:p2","agent":"w2","state":"idle","exitCode":0,
 "git":{"branch":"agent/api-owner/t1","base":"main","head":"9f21c0a","ahead":3,"dirty":false}}
```

This is the one piece that must be computed **inside** the container, because `--notify` detaches and the host process is gone by the time it settles. `settled` gains a small git read against `/repos/<repo>` - the same object store, seen from the other side - and `fact` merges it into the body. It stays POSIX shell and `jq`, and it is the only new code that runs in the box.

**Attribution.** The pane's environment gains `GIT_AUTHOR_EMAIL` and `GIT_COMMITTER_EMAIL` from a new `identity:` block in `pod.yaml` (`<actor>@<domain>`, defaulting to the current `heai@localhost`), and `pod commit` appends trailers:

```
Heai-Actor: api-owner
Heai-Workspace: w2
Heai-Branch: agent/api-owner/t1
```

The actor and workspace come from the workspace's tokens, so a caller that wants a task id on the commit passes it as a label token at `open` and gets `Heai-Task:` without `pod` learning what a task is. Trailers, not a message convention, because `git log --format='%(trailers:key=Heai-Actor)'` is a query and prose is not. An agent committing on its own is unaffected; only `pod commit` trailers.

**Safety, as refusals rather than documentation.** `push` refuses a branch with no commits ahead of base, exit 1. `repo fetch` takes a lock file under the state directory so two fetches do not interleave, and refuses to move a branch that any open workspace holds. `diff` against a base the clone does not have fetches once and then refuses, exit 2, naming the ref. Each of these is a line in the exit-code table the README already has.

## 5. What `pod` delegates to Herdr, stated once

The exemption cuts both ways: being allowed to depend on Herdr deeply means deciding what *not* to reimplement. The division to write into the README:

| Herdr owns | pod owns |
| --- | --- |
| making and removing worktrees, and the branch at creation | the clone, and every remote operation |
| the workspace, its panes, its metadata tokens | what the tokens mean: repo, branch, base, actor |
| the agent's lifecycle and state | what the agent produced, in git terms |
| the worktree's `is_prunable`, `is_detached`, `branch` | acting on those - `repo prune`, and refusing a detached workspace |
| resuming agents on restore | nothing; `pod` does not second-guess it |

Two mechanical follow-ons. `image/HERDR_VERSION` pins 0.9.0 and the client in `herdr.ts` reads exactly the fields recorded in `test/fixtures/herdr/`; a tighter integration means a version probe at `up` that refuses a container whose `herdr --version` is below the pinned floor, exit 2, rather than failing later on a missing field. And the fixtures become the contract: any field this proposal starts reading needs a recorded response before the code reads it.

## 6. Phases

Each phase is independently useful and independently reviewable.

1. **The exemption.** The README paragraph above, plus the delegation table, plus a matching note in [`project.md`](../project.md)'s pod section. No code. Everything else depends on it being accepted as written.
2. **`base` becomes durable, and a git read layer.** The `base` token at `open`; a `git.ts` in `tools/pod/src` that runs host git in the clone and returns the object above; `list --json` and `status` carry it. Tests against a real temporary clone, not a fake - host git is cheap to fake badly and there is no reason to.
3. **The read commands.** `diff`, `log`, `show`, `git --`. `examples.md` and `sample_project/scripts` switch to `heai-pod diff`; the old form stays valid and undocumented.
4. **The fact file's git object.** `settled` and `fact` in `image/bin`, with the helper tests under `sh` extended; a fixture for the merged body. This is the phase that changes the protocol, so it carries the version note in the README.
5. **Write operations and hygiene.** `commit` with trailers, `push` with its refusals, `identity:` in `pod.yaml` and its schema entry, `repo prune`, the fetch lock, the Herdr version probe.

Phases 1 and 2 are the proposal's core; 3 is what callers feel; 4 and 5 can wait behind a real use.

## 7. Risks, and what this does not do

- **Ownership on the bind mount.** The container's git writes as root into `pod/repos/<name>/.git`; the host's git then writes into the same object store as the invoking user. `safe.directory` handles the trust check and not the permissions. Phase 2 should fail loudly on a permission error and say which side wrote last, rather than producing a half-updated ref store. Worth a shared-repository setting on the clone.
- **Two writers, one object store.** Host `fetch` and container commits are concurrent by construction. Git's own locking makes this safe for refs; the lock proposed above is for `pod`'s sequencing, not git's correctness. No phase here introduces a host operation that rewrites history in the clone, and none should.
- **The surface grows.** `pod` gains eight commands and a config block, against a README that is already long. The mitigation is that six of them are one git invocation each and share one module; if `git.ts` grows past a few hundred lines, that is the signal the rule in section 3 has been broken somewhere.
- **Not proposed:** a `pod` that knows what a flow, a task or the map is; git operations in `pod/worktrees` from the host; a second remote inside the container; rewriting `reactor`'s `git` source, which watches the *real* repository's branches and is a different job from watching a workspace's branch.

## 8. Open questions

1. **Does `push` belong here at all?** It is the one command that touches the real remote with real credentials, and a project may well want that to be a script with a policy in it, the way `pick.sh` is. The argument for `pod` owning it is that `pod` owns the clone and nothing else may read under `pod/`; the argument against is that landing is a decision, not a mechanic.
2. **Should `dirty` be in the fact file?** It needs a working-tree read in the container at settle time, which is the one place a wrong answer is expensive. Reporting only what is committed - `ahead`, `head` - is honest and cheaper.
3. **`pod git -- <cmd>` as an escape hatch.** It keeps projects from reaching around the tool while the surface is incomplete, and it is also how the surface stays incomplete forever. Ship it in phase 3 and reconsider at the first release where nothing in the repository uses it.

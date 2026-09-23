# @heai-tools/pod

Persistent containers holding the development tools an actor needs - git, language toolchains, cloud CLIs, coding agents - each running a [Herdr](https://herdr.dev) server so that many pieces of work run in it side by side, each in its own git worktree.
A base image carries Herdr and the tool's helpers; the user builds one or more images on it with the project's tools, and runs a container from whichever fits.
A command line lets a script or a human open a worktree, start an agent or a command in it, send a prompt, wait, read, and attach.

The tool keeps no record of work.
A piece of work is a Herdr workspace, named by the id Herdr gave it, and the caller keeps its own record under that id.

```sh
npm install && npm link                                          # builds dist/ and puts `heai-pod` on PATH
heai-pod build                                            # the base image, then every image in pod.yaml
heai-pod up --image aw3/workshop                          # one container from that image, herdr server inside
heai-pod repo add app ~/Code/app                          # a clone
ws=$(heai-pod open app --branch agent/api-owner/t1 --actor api-owner)   # prints w2
heai-pod start "$ws" --agent claude                       # prints w2:p2
heai-pod prompt "$ws" --file prompt.md --notify /heai/inbox --event exited
heai-pod run "$ws" "npm test" --wait                      # prints the exit code, and exits with it
heai-pod attach "$ws"                                     # the Herdr UI, at that workspace
```

Requires Node 22.18 or newer, and one of Apple's `container` CLI, Docker or Podman on the host. Released as `@heai-tools/pod` on npm: `npm install -g @heai-tools/pod` puts `heai-pod` on PATH.
`npm install` pulls two runtime dependencies, a YAML parser and a JSON Schema validator, and builds the command into `dist/`; during development `node src/cli.ts` runs the sources directly.

## The shape of it

```
image/Containerfile ─ herdr, git, jq, the helpers ─────────────────────► heai/pod-base
  <project>/images/<x>/Containerfile ─ FROM ${BASE}, plus toolchains, agents ─► aw3/workshop, aw3/ops, ...
                                                                                     │
  heai-pod up --image aw3/workshop ───────────────────────────────► one persistent container
                                                                          herdr server, headless
  /repos/<name>       a clone per repository, on a mounted volume                     │
  /worktrees/...      one worktree per piece of work, on a mounted volume             │
                                                                                     │
  heai-pod open app --branch agent/api-owner/t1 ──► herdr worktree create ──► w2   (Herdr's id)
  heai-pod start w2 --agent claude              ──► pane split + agent start ──► w2:p2
  heai-pod prompt w2 "..." --notify /heai/inbox --event exited ──► a fact file when settled
  heai-pod run w2 "npm test" --wait              ──► pane split + pane run + wait-output
  heai-pod attach w2                             ──► the human, in Herdr, at that workspace
```

- **A base image, and the user's images on it.** The tool ships the base `Containerfile` - Herdr, git, jq, the in-container helpers, `herdr server` as the entrypoint.
  Each extended image is a `Containerfile` of the user's that starts `FROM ${BASE}` and installs the project's toolchains and agents; the configuration lists them by tag.
- **One persistent container per name, from one image.** `up --image <tag>` creates it and it stays up; `down` stops it.
  Run one container for every actor or one per actor with `--container`, each from the image that suits it; the actor is a property of a workspace, not of the container.
- **A clone per repository, a worktree per piece of work.** `/repos/<name>` is a full clone the host keeps in sync with the real repository; every workspace opened for it is a worktree of that clone, made by Herdr, on its own branch.
- **Herdr's ids are the ids.** `open` prints the workspace id Herdr returned, `w2`; `start` prints the pane, `w2:p2`; every later command takes one of those or the agent's name.
- **Facts on request.** `prompt`, `run` and `wait` take `--notify <dir>`: when the agent settles or the command exits, a helper inside the container writes one fact file into that directory by write-and-rename.
  The directory is whatever the caller mounted.

## Images

The **base image** is [`image/Containerfile`](image/Containerfile), tagged `heai/pod-base` unless the configuration's `base:` says otherwise:

```dockerfile
FROM docker.io/library/debian:bookworm-slim
ARG HERDR_VERSION=0.9.0
RUN apt-get install ... git ca-certificates curl jq ripgrep openssh-client procps
RUN curl -fsSL "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-$(uname -m)" -o /usr/local/bin/herdr
COPY herdr.toml /etc/herdr/config.toml
COPY bin/ /heai/bin/
RUN git config --system safe.directory '*' && git config --system user.name heai && git config --system user.email heai@localhost
ENV PATH=/heai/bin:$PATH HERDR_CONFIG_PATH=/etc/herdr/config.toml HOME=/root
ENTRYPOINT ["herdr", "server"]
```

`build base` passes `image/HERDR_VERSION` as `HERDR_VERSION`, so the Herdr release is pinned.
[`image/herdr.toml`](image/herdr.toml) sets `[worktrees] directory = "/worktrees"`, the headless size, bash as the shell, and `resume_agents_on_restore = true`, so a container restarted by `down` and `up` brings each agent's conversation back into its pane.
Git's `safe.directory` is opened because the clones arrive over a bind mount owned by another uid; the system-level name and email are a fallback that the actor's name overrides.

An **extended image** is a directory of the user's holding a `Containerfile` that starts from the base and adds the project's tools.
[`image/example/Containerfile`](image/example/Containerfile) is one to copy:

```dockerfile
ARG BASE=heai/pod-base
FROM ${BASE}
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm python3 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code @openai/codex \
 && herdr integration install claude && herdr integration install codex
```

`build <tag>` passes the base's tag as `BASE`, so an image built against a renamed base needs no edit.
Install each agent's Herdr integration beside the agent - `herdr integration install claude` - so Herdr classifies its states from the integration's reports rather than from the screen.
Entrypoint, environment and helpers are inherited from the base; an extended image adds and never has to repeat them.
Credentials are not in any image: `up --env-from <path>` hands an env file to the runtime unread.

Several images serve several containers: one image per kind of actor, or one per project sharing a base, each run with `up --container <name> --image <tag>`.

## The container

```
heai-pod up    --image <tag> [--env-from <path>] [--mount <host>:<container>]... [--cpus n] [--memory m]
heai-pod down  [--force]
heai-pod status [--json]
heai-pod build                                       the base, then every image in the configuration's images:
heai-pod build base [--tag <image>] [--image-dir <dir>]
heai-pod build <image> [--image-dir <dir>]           one extended image, FROM the base
```

`up` creates the container from `--image` if it does not exist and starts it if it is stopped.
It mounts three directories of its own plus any the configuration or the caller adds:

| container path | host path | holds |
| --- | --- | --- |
| `/repos` | `<state>/repos` | the clones; they survive the container being recreated |
| `/worktrees` | `<state>/worktrees` | the worktrees; a human can open one from the host |
| `/heai/inbox` | `<state>/inbox` | a default place for fact files |

Any directory named on `--notify` must be mounted; every workspace in the container can write into it.

`down` refuses, exit `1`, while any agent is `working` unless `--force`; a stopped container keeps its Herdr state and its worktrees.
`status` is the runtime's word on the container plus `herdr status` inside it, the workspace count and the agents by state; it exits `1` when either the container or Herdr is not running.
`build` with no argument builds the base and then every image under `images:`, in order.
`build base` builds the base alone, from the tool's own `image/`, or `baseDir:` from the configuration, or `--image-dir`.
`build <tag>` builds one extended image from the directory `images:` names for that tag, or from `--image-dir`, passing the base's tag as the `BASE` build argument.
Relative directories in the configuration are resolved against the project directory.

The **runtime** is chosen with `--runtime` or `runtime:`: `apple` wraps Apple's `container` CLI, `docker` and `podman` wrap those two.
The default is `apple` on macOS and `docker` elsewhere.

## Repositories

```
heai-pod repo add <name> [<source>]          clone into <state>/repos/<name>
heai-pod repo list [--json]
heai-pod repo fetch [<name>]                 fetch origin and fast-forward the clone's checked-out branch
heai-pod repo pull-branch <name> <branch> [--into <path>]   the branch from the clone into a host checkout
```

The clone is made and updated **by the host**, on the mounted volume, so the container never needs credentials for the real repository.
`pull-branch` is how work comes home: it fetches `refs/heads/<branch>` from the clone into the checkout named by `--into`.
Git refuses to move a branch that is checked out there, and that refusal is exit `1`.
Inside the container, git is Herdr's: `herdr worktree create` makes the worktree and the branch, and the agent commits on it.

When `repo add` is given no source and an architecture map is present (`--map`, see Configuration), the source is `repositories.<name>.localPath`, else `remotePath`; `pull-branch` without `--into` uses `localPath`.
Nothing else in the map is read.

A worktree's `.git` file points into `/repos/<name>/.git`, a container path, so git on a worktree from the host does not resolve; the files under `<state>/worktrees` are readable, and git on them is `run`'s job.

## Workspaces

```
heai-pod open <repo> --branch <name> [--base <ref>] [--actor <name>] [--label <text>] [--set key=value]...   → prints the workspace id
heai-pod list [--json]
heai-pod diff <workspace | repo branch> [--name-only|--stat|--patch] [--base <ref>] [--json]
heai-pod log  <workspace | repo branch> [-n <count>] [--json]
heai-pod show <workspace | repo branch> [--json]
heai-pod close <workspace> [--keep-worktree] [--force]
heai-pod attach [<workspace>]
```

`open` is `herdr worktree create --cwd /repos/<repo> --branch <name> [--base <ref>] --label <label> --no-focus --trust-repository` and prints the workspace id.
The branch is the durable name of the work; the workspace id is Herdr's handle on it for as long as the server runs.
`open` records repo, branch, base and actor as Herdr workspace metadata, and writes the same facts as `branch.<branch>.heai-*` in the clone's git config.
`--set key=value` writes additional `heai-*` facts under the branch and mirrors them as workspace tokens.
The worktree lands at `/worktrees/<repo>/<branch with / as ->`, which is `<state>/worktrees/...` on the host.

`close` removes the worktree and the workspace; with `--keep-worktree` it closes the workspace and leaves the files, and `open` on the same branch later reopens them.
`attach` opens the Herdr UI in this terminal, focused on the workspace named; the human sees every workspace, because that is what Herdr shows.

`list --json` gives, for each workspace, Herdr's id, label and metadata tokens, the repository, branch and worktree path, a host-git summary (`base`, `head`, `ahead/behind`, changed file count and last commit), the rolled-up agent status, every agent in it with its kind, name, pane and state, and every pane.
The clone itself appears as a workspace, `linked: false`, because Herdr opens the source repository as one when the first worktree is created.

## Agents, prompts and commands

```
heai-pod start  <workspace> --agent <kind> [--name <name>] [--env K=V]... [--timeout <ms>] [-- <agent args>]   → prints the pane id
heai-pod prompt <target> <text> | --file <path> [--wait [--timeout <ms>]] [--notify <dir> [--event <name>]]
heai-pod run    <workspace> <command> | --file <path> [--env K=V]... [--wait [--timeout <ms>]] [--notify <dir> [--event <name>]]
heai-pod wait   <target> [--until <state>]... [--timeout <ms>] [--notify <dir> [--event <name>] [--every <duration>]]
heai-pod read   <target> [--lines N] [--ansi]
heai-pod keys   <target> <key>...
heai-pod herdr  -- <any herdr command>
```

`<target>` is a pane id, `w2:p2`, or an agent name; `<workspace>` is `w2`.
`start` splits a pane below the workspace's root pane, in the worktree, and runs `herdr agent start` in it; the agent's name defaults to the workspace id, and the root pane stays an idle shell for whoever attaches.
The pane carries `HEAI_ACTOR`, `GIT_AUTHOR_NAME` and `GIT_COMMITTER_NAME` from the workspace's actor, so every commit made in it is attributed to that actor; `--env` adds the caller's own variables.
`prompt` sends text to the agent.
`run` splits a pane the same way and runs the command with a sentinel appended so the exit code is known; a `--file` with newlines is carried as base64 and piped to `sh`, so a multi-line script runs as one.
`read` and `keys` read a pane's screen and send keys to it; `herdr --` passes any other Herdr command through on this terminal.
Durations - `--timeout`, `--every` - are milliseconds, or `30s`, `5m`, `2h`.

**Waiting, two ways.**
`--wait` blocks and prints the settled state - `idle`, `done`, `blocked`, or for a command its exit code - and exits `0` for `idle`, `done` or a command that exited `0`, `1` for `blocked` or a failing command, `2` for a timeout, a stalled prompt or a target that is gone.
`--notify <dir>` starts the wait **inside the container**, detached, and returns at once; when the wait settles, a helper writes a fact file into `<dir>`.
The host process may be long gone by then; the fact is written anyway.
`prompt` and `run` take one of the two, not both.

**The fact file.**
Named by `--event`, default `settled`; written as `<event>.<workspace>.tmp` then renamed to `<event>.<workspace>`, so a reader never sees a torn file and two workspaces reporting the same event do not collide.
Its body is one JSON object with the workspace and pane ids, the agent's name and settled state, and for a command the exit code.
When the workspace has git metadata, it also carries a committed-work summary (`branch`, `base`, `head`, `ahead`):

```json
{"workspace":"w2","pane":"w2:p2","agent":"w2","state":"idle","exitCode":0,"git":{"branch":"agent/api-owner/t1","base":"main","head":"9f21c0a","ahead":3}}
```

`exitCode` is `0` for `idle` and `done`, `1` for `blocked`, the command's own for `exited`, and `2` for `timeout`, `stalled` and `lost`.
`wait <ws> --until blocked --notify <dir> --event needs-input` reports that an agent stopped to ask, without polling.

**A heartbeat.**
`wait <ws> --notify <dir> --every 60s` writes a `touch.<workspace>-<n>` fact with an empty body every minute until the agent settles, and no settled fact.

## The helpers in the image

Three POSIX shell scripts under `/heai/bin`, the only code that runs inside the container:

| helper | does |
| --- | --- |
| `fact <dir> <event> <suffix> [<json>]` | writes one fact file by write-and-rename |
| `settled wait <target> [--until ...] [--timeout ms]` | `herdr agent get` for identity, `herdr agent wait` for the state, printed as the fact body, exit status the `exitCode` |
| `settled prompt <target> <text> [--timeout ms]` | the same through `herdr agent prompt --wait`, so the wait is for the prompted turn |
| `settled run <pane> <sentinel> [--timeout ms]` | `herdr pane wait-output --regex '<sentinel>=[0-9]+'`, the exit code lifted from the matched line |
| `notify <dir> <event> [--every s] -- <settled args>` | `settled`, then `fact`; what `--notify` starts detached; with `--every`, touches instead |

They call `herdr` and `jq` and write files; nothing else.
`--wait` on the host runs the same `settled` helper in the foreground, so the two ways of waiting cannot disagree.

## Configuration

Optional, `pod.yaml` in the project directory:

```yaml
runtime: apple                     # or docker, podman
name: heai-workshop                # the default --container
base: heai/pod-base                # the base image's tag
baseDir: ./base                    # where the base Containerfile is; the tool's own image/ when unset
images:                            # extended images, tag → directory holding a Containerfile
  aw3/workshop: ./images/workshop
  aw3/ops: ./images/ops
envFile: ~/.heai/pod.env
mounts:                            # added to every `up`
  - ~/Code/project/inbox:/heai/project-inbox
resources: { cpus: 6, memory: 12G }
```

[`schemas/pod.schema.json`](schemas/pod.schema.json) is the formal definition: JSON Schema, draft 2020-12, with every key and its type.
A file that does not validate is refused with every problem it has, before any command runs.
Relative directories are resolved against the project directory, and `~` is expanded in every path.

Common options on every command:

| option | default |
| --- | --- |
| `--dir <path>` | `HEAI_DIR`, else the directory of an explicit `--map`, else the cwd |
| `--state <dir>` | `HEAI_POD_STATE`, else `<dir>/pod`; holds `repos/`, `worktrees/`, `inbox/` and a `.gitignore` of `*` |
| `--config <path>` | `<dir>/pod.yaml` |
| `--map <path>` | `HEAI_MAP`, else `<dir>/.heai/architecture.yaml`, else `<dir>/architecture.yaml`; only read by `repo add` and `repo pull-branch` |
| `--runtime <name>` | `runtime:` from the configuration, else `apple` on macOS and `docker` elsewhere |
| `--container <name>` | `name:` from the configuration |

### Exit codes

| code | meaning |
| --- | --- |
| `0` | done, or settled well: `idle`, `done`, a command that exited `0` |
| `1` | settled badly - `blocked`, a failing command - or refused: a busy container on `down`, a clone that exists, a branch git would not move, a Herdr refusal such as a branch that exists |
| `2` | bad usage, a runtime or container that could not be asked, a workspace, pane or agent that does not exist, a timeout |

Herdr's own error code is printed on stderr, `pod: herdr: agent_not_found: ...`; `*_not_found`, `timeout` and `server_not_running` are `2`, anything else it refused is `1`.

## Layout

```
tools/pod/
  package.json            @heai-tools/pod, Node 22.18+, two dependencies: yaml and ajv
  schemas/pod.schema.json   the formal definition of pod.yaml
  image/
    Containerfile         the base image: herdr, git, jq, the helpers
    herdr.toml            the in-container Herdr configuration
    HERDR_VERSION         the pinned herdr release the Containerfile downloads
    bin/fact, bin/settled, bin/notify
    example/Containerfile an extended image to copy: FROM the base, plus toolchains and agents
  src/
    cli.ts                the commands
    runtime.ts            the runtime contract; runtimes/apple.ts, runtimes/docker.ts
    herdr.ts              `herdr ...` in the container, its JSON read back
    box.ts                up, down, status, build
    repos.ts              clone, list, fetch, pull-branch
    workspaces.ts         open, list, close, the root pane
    agents.ts             start, prompt, run, wait, read, keys; settled and notify
    config.ts             paths, pod.yaml, the state directory
  test/
    fixtures/container-list.json   real Apple `container list` output
    fixtures/docker-ps.jsonl       `docker ps --format '{{json .}}'` as documented
    fixtures/herdr/                herdr responses recorded from 0.9.0
    fake/                          a container/docker shim that replays fixtures; a herdr shim for the helpers
    *.test.ts                      the runtime parsers and argv, the herdr client, every command against the fake runtime, the helpers under sh, paths and configuration
```

Run the tests with `npm test`.

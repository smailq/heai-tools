# @heai-tools/pod

One container that watches a directory of jobs.
A **job** is a directory a producer drops into `work_queue/`: a `run.sh` saying what to do, and the code, the instructions, whatever the work needs.
A **worker** inside the container takes jobs one at a time, runs `sh run.sh` in each, and moves it to `.done/` with a `result.json`.
The worker never reads inside a job beyond `run.sh` and one optional file, and the producer never reaches inside the container: the directory is the whole of the contract.

Pod knows nothing about git, agents, tasks or flows.
What goes in a job and what comes out is the producer's business, written into `run.sh`; the image is a toolbox, and pod only moves directories and keeps the result honest.

Requires Node 22.18 or newer, and one of Apple's `container` CLI, Docker or Podman on the host.
Building the base image needs nothing else: the worker is compiled inside the build.
Released as `@heai-tools/pod` on npm: `npm install -g @heai-tools/pod` puts `heai-pod` on PATH.

## Tutorial

Ten minutes, in an empty directory. Steps 1 to 5, 8 and 9 were run as written; 6 and 7 need your own repository and an API key.

**1. Install, and build the base image.**

```sh
npm install -g @heai-tools/pod        # or, from this directory: npm install && npm link
mkdir ~/pod-tour && cd ~/pod-tour
heai-pod build base                   # heai/pod-base: Debian, git, jq, and the worker compiled in the build
```

The first build downloads two images and compiles a small Go program; later builds are seconds.

**2. Start a container.**

```sh
heai-pod up --image heai/pod-base --poll 1s
heai-pod status
```

`up` created a container named `heai-workshop`, mounted `./pod/work_queue` into it at `/work_queue`, and started the worker.
`status` shows the container and an empty queue, and names the queue directory on the host.
`./pod/` is the tool's state; it carries a `.gitignore` of `*`, so it never ends up in a commit.

**3. Your first job.**

A job is a directory with a `run.sh`.
Make one, hand it to `submit`, and wait for it:

```sh
mkdir hello
cat > hello/run.sh <<'EOF'
echo "hello from $JOB, running in $(pwd)"
ls -a
echo "and this goes to stderr" >&2
EOF
heai-pod submit hello                 # prints: hello
heai-pod wait hello                   # prints: ok
heai-pod show hello
```

`submit` copied the directory into the queue, the worker ran `sh run.sh` inside it, and `wait` returned as soon as the job landed under `.done/`.
`show` prints the result - status, exit code, when it started and finished, which worker had it - and the tail of both logs.
The listing in stdout shows what the worker added beside your files: `claim.json` while it ran, `log/` with the output, `result.json` when it finished.

**4. Where everything is.**

```sh
heai-pod list
ls pod/work_queue/.done/hello
cat pod/work_queue/.done/hello/result.json
cat pod/work_queue/.done/hello/log/stdout
```

Nothing is hidden in the container.
A job is in one of three places - the top of `work_queue/` while queued, `.running/` while a worker has it, `.done/` after - and `result.json` is the one file the worker writes about it.
Any script can read these without `heai-pod`.

**5. Failing, timing out, canceling.**

```sh
mkdir broken && echo 'exit 3' > broken/run.sh
heai-pod submit broken && heai-pod wait broken        # prints: failed; exits 1

mkdir slow && echo 'sleep 600' > slow/run.sh
heai-pod submit slow --timeout 5s && heai-pod wait slow    # prints: timeout, five seconds later

mkdir slower && echo 'sleep 600' > slower/run.sh
heai-pod submit slower
sleep 2 && heai-pod cancel slower                     # Asked the worker to stop slower
heai-pod wait slower                                  # prints: canceled

mkdir empty && touch empty/notes.md
heai-pod submit empty && heai-pod wait empty          # prints: failed
heai-pod show empty                                   # error     no run.sh in the job
```

`wait` exits `0` only for `ok`, `1` for every other status, so a script can branch on it.
A `cancel` of a job that is still queued finishes it right there; a running one gets a `cancel` file and the worker stops it within a poll.
`list` now shows all five, with the status, exit code and how long each took.

**6. A job on your code.**

Put a clone in the job, and let `run.sh` work on it.
A worktree would not survive the mount; a clone does.

```sh
mkdir -p tests/repos
git clone -q ~/Code/app tests/repos/app
echo 'cd repos/app && npm test' > tests/run.sh
heai-pod submit tests --name app-tests --timeout 30m
heai-pod wait app-tests && echo "green" || heai-pod show app-tests --lines 40
```

The base image has git but no node, so this one needs an image with the project's toolchain, which is the next step.
Whatever `run.sh` changes, it changes in `repos/app` inside the job; when the job is done, that clone is at `pod/work_queue/.done/app-tests/repos/app`, and the host can fetch a branch from it, diff it, or delete it.

**7. An image with your tools, and an agent.**

An extended image is a `Containerfile` that starts `FROM ${BASE}` and installs what your jobs call.
Copy the example and name it in `pod.yaml`:

```sh
mkdir -p images/dev && cp "$(npm root -g)/@heai-tools/pod/image/example/Containerfile" images/dev/
cat > pod.yaml <<'EOF'
images:
  tour/dev: ./images/dev
envFile: ~/.heai/pod.env             # ANTHROPIC_API_KEY=... ; handed to the runtime, never read by pod
workers: 2
timeout: 1h
EOF
heai-pod build                       # the base, then tour/dev
heai-pod down && heai-pod up --image tour/dev
```

The example installs node, python and claude.
Now a job can prompt the agent: the prompt is a file, `run.sh` is the one line that runs claude on it.

```sh
mkdir -p agent/repos && git clone -q ~/Code/app agent/repos/app
git -C agent/repos/app checkout -q -b agent/add-readme
cat > agent/prompt.md <<'EOF'
Add a README.md explaining what this project does. Commit it on the current branch.
EOF
echo 'cd repos/app && claude -p --dangerously-skip-permissions < ../../prompt.md > ../../out.md' > agent/run.sh
heai-pod submit agent --name add-readme --timeout 20m
heai-pod wait add-readme && git -C ~/Code/app fetch pod/work_queue/.done/add-readme/repos/app agent/add-readme:agent/add-readme
```

The branch is now in your real repository, for a human to read and merge.
Pod did not know a branch was involved.

**8. From a script.**

This is the whole loop a producer runs, with or without the command:

```sh
# with heai-pod
job=$(mktemp -d) && echo 'make check' > "$job/run.sh" && cp -r src "$job/"
name=$(heai-pod submit "$job" --name "check-$(date +%s)" --move)
if heai-pod wait "$name"; then echo "passed"; else heai-pod show "$name"; fi

# with nothing but the filesystem: write under a dotted name, rename into place, wait for .done
q=pod/work_queue
mkdir -p "$q/.tmp-check" && echo 'make check' > "$q/.tmp-check/run.sh" && mv "$q/.tmp-check" "$q/check"
until [ -f "$q/.done/check/result.json" ]; do sleep 1; done
jq -r .status "$q/.done/check/result.json"
```

The second form is the protocol itself, and it is what a hook in another tool does when it would rather not depend on this one.

**9. Stopping, and tidying.**

```sh
heai-pod down                        # refused while a job runs; --force cancels them on the way out
rm -rf pod/work_queue/.done/*        # pod never deletes a finished job; that is yours to do
```

A stopped container keeps nothing the queue does not; `up` brings it back, and the worker picks up whatever was queued while it was away.
Jobs it had been running when it was killed come back as `crashed`, so nothing is silently lost.

## The protocol

```
work_queue/                     host: <state>/work_queue     container: /work_queue
  <job>/                        queued: dropped by a producer, taken in name order
  .running/<job>/               claimed by a worker; holds claim.json while it runs
  .done/<job>/                  finished; holds result.json and log/
```

**A job is a directory at the top of the queue whose name does not start with a dot, holding a `run.sh`.**
A name is letters, digits, `.`, `_` and `-`, and is unique across the three places; `submit` refuses a name that exists anywhere.
Dotted entries at the top level are never jobs, and that is what makes a drop safe: a producer writes the directory as `.tmp-<job>`, then renames it to `<job>`.
On one filesystem the rename is atomic, so the worker never sees a half-written job.
`submit` does exactly this; a script that knows the layout can do it with `mkdir` and `mv`.

**The worker reads one file inside a job besides `run.sh`**, `job.json`, and only its `timeout`:

```json
{"timeout": "2h"}
```

A Go duration - `30m`, `2h`, `90s` - or `0` for no limit; absent, the worker's default applies.
Anything else in `job.json` is the producer's business.

**Claiming** is one rename, `<job>` into `.running/`.
A rename that fails means another worker has it, so several containers can share one queue.
The worker then writes `.running/<job>/claim.json`:

```json
{"worker": "a1b2c3", "started": "2026-09-25T10:00:00.000Z"}
```

**Running** is `sh run.sh` with the job directory as the working directory, `JOB` and `JOB_DIR` in the environment, stdout and stderr captured to `log/stdout` and `log/stderr` inside the job, in its own process group, under the timeout.
`run.sh` need not be executable, and it calls whatever the image installed: a test suite, an agent, a build.

**Finishing** is `result.json` written into the running directory by write-and-rename, then the directory renamed into `.done/`.
The directory appearing under `.done/` is the whole of "it is done", and `result.json` is always in it when it appears.
`claim.json` and any `cancel` file are removed first.

```json
{
  "job": "t1-cache",
  "status": "ok",
  "exit": 0,
  "started": "2026-09-25T10:00:00.000Z",
  "finished": "2026-09-25T10:01:31.234Z",
  "duration_ms": 91234,
  "worker": "a1b2c3"
}
```

| status | meaning | `exit` |
| --- | --- | --- |
| `ok` | `run.sh` exited 0 | 0 |
| `failed` | it exited non-zero, died of a signal, or could not be started; `error` says why when the worker refused it | its code; -1 with `signal` or `error` |
| `timeout` | killed at the job's timeout, or the worker's default | -1, `signal` |
| `canceled` | a `cancel` file appeared in `.running/<job>/`, or the worker was stopped while it ran | -1 |
| `crashed` | found under `.running/` when the worker started: the worker died with it | -1 |

Times are RFC 3339 in UTC with milliseconds.
A job refused before it ran - no `run.sh`, a `job.json` that does not parse, a timeout that is not a duration - is `failed` with `error` and no `log/`.

**Canceling** is a file: create `.running/<job>/cancel` and the worker sends the process group `SIGTERM`, then `SIGKILL` five seconds later, within one poll.
**Recovery** is by name: at start, a worker moves what it left under `.running/` to `.done/` as `crashed`, judged by `claim.json`'s `worker`, and leaves other workers' claims alone.
A claimless entry has no owner and is taken as the starting worker's.
**Several at once** is `WORKERS=n`; the worker never runs more than that, and takes jobs in name order, so a producer that wants an order prefixes names with one.

Nothing is ever deleted: `.done/` grows until someone removes what they have read.

## The image

The **base image** is [`image/Containerfile`](image/Containerfile), tagged `heai/pod-base` unless the configuration's `base:` says otherwise.
Its first stage compiles the worker from [`image/worker/`](image/worker), a Go program with no dependencies; its second stage is Debian with git, jq, ripgrep and curl, and the worker at `/heai/bin/worker` as the entrypoint.
Nothing in it knows what a job does: that is the job's `run.sh`.

An **extended image** is a directory of the user's holding a `Containerfile` that starts `FROM ${BASE}` and installs the project's toolchains and agents, so that a `run.sh` can call them.
[`image/example/`](image/example) is one to copy: node, python and claude.
`build <tag>` passes the base's tag as `BASE`, so an image built against a renamed base needs no edit.
Credentials are not in any image: `up --env-from <path>` hands an env file to the runtime unread, and the worker passes its whole environment to `run.sh`.

The worker takes its settings from the environment `up` sets: `WORKERS` (default 1), `TIMEOUT` (default `1h`), `POLL` (default `2s`), and `WORKER` for its name (default the container's hostname).
Its log goes to the container's stdout, one line per claim and per finish.

### A job's shape

Only `run.sh` is pod's; the rest is a convention the other tools' examples follow:

```
<job>/
  run.sh          what to do: a command, or an agent on the prompt
  job.json        optional, {"timeout": "2h"}
  prompt.md       the instructions for the agent, when run.sh runs one
  repos/<name>/   the code as the producer put it, changed in place
  out/            whatever run.sh chooses to hand back
  log/            stdout and stderr, the worker's
  result.json     the worker's, once done
```

A `run.sh` for an agent is one line, `cd repos/app && claude -p < ../../prompt.md > ../../out/answer.md`; for a test suite, `cd repos/app && npm test`.
Code goes in however the producer likes - a `git clone` of a local checkout, a copy, an unpacked archive - and comes back the same way: `.done/<job>/repos/app` is a clone the host can fetch a branch from, diff, or discard.
A git worktree does not survive the mount, since its `.git` file points at a path in the other filesystem; a clone does.

## The command

```
heai-pod up    --image <tag> [--workers n] [--timeout <duration>] [--poll <duration>] [--env-from <path>] [--mount <host>:<container>]... [--cpus n] [--memory m]
heai-pod down  [--force]
heai-pod status [--json]
heai-pod build                                       the base, then every image in the configuration's images:
heai-pod build base [--tag <image>] [--image-dir <dir>]
heai-pod build <image> [--image-dir <dir>]           one extended image, FROM the base
heai-pod shell                                       bash in the container

heai-pod submit <dir> [--name <job>] [--timeout <duration>] [--move]   → prints the job's name
heai-pod list [--json]
heai-pod show <job> [--lines N] [--json]
heai-pod wait <job> [--timeout <duration>] [--json]  → prints the status
heai-pod cancel <job>
```

**The container.**
`up` creates the container from `--image` if it does not exist and starts it if it is stopped.
It mounts `<state>/work_queue` at `/work_queue` plus any mount the configuration or the caller adds, and passes `--workers`, `--timeout` and `--poll` to the worker as its environment, from the flags, else the configuration, else not at all.
`down` refuses, exit `1`, while `.running/` holds a job unless `--force`; forced, the worker finishes each running job as `canceled` on its way out.
`status` is the runtime's word on the container plus the queue's counts, read from the host's side; it exits `1` when the container is not running.
`build` with no argument builds the base and then every image under `images:`, in order; `build base` builds the base alone, from the tool's own `image/`, or `baseDir:` from the configuration, or `--image-dir`; `build <tag>` builds one extended image from the directory `images:` names for that tag, or from `--image-dir`.
`shell` is an interactive bash in the container, for looking around.

**The queue.**
`submit` copies the directory into the queue under the name given, else the directory's own, and prints the name; `--move` moves it instead, and `--timeout` writes the job's timeout into its `job.json`, joining whatever the file already says.
`list` prints every job, queued in name order, then running, then done, with its status, exit code, duration and start time.
`show` prints a job's claim or result and the last `--lines` lines of each log, twenty by default.
`wait` blocks until the job is under `.done/` and prints its status; `--timeout` bounds the wait.
`cancel` finishes a queued job as `canceled` right there, with a result of the host's, and gives a running job its `cancel` file for the worker to act on; a done job is refused.

The five queue commands touch only files and never ask the runtime, so a machine without one can still submit, wait and read.
A script that knows the protocol can skip them.

The **runtime** is chosen with `--runtime` or `runtime:`: `apple` wraps Apple's `container` CLI, `docker` and `podman` wrap those two.
The default is `apple` on macOS and `docker` elsewhere.

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
  - ~/Code/project/shared:/heai/shared
resources: { cpus: 6, memory: 12G }
workers: 2                         # jobs at once
timeout: 2h                        # the default job timeout; 0 for none
poll: 2s                           # how often the worker looks
```

[`schemas/pod.schema.json`](schemas/pod.schema.json) is the formal definition: JSON Schema, draft 2020-12, with every key and its type.
A file that does not validate is refused with every problem it has, before any command runs.
Relative directories are resolved against the project directory, and `~` is expanded in every path.

Common options on every command:

| option | default |
| --- | --- |
| `--dir <path>` | `HEAI_DIR`, else the cwd |
| `--state <dir>` | `HEAI_POD_STATE`, else `<dir>/pod`; holds `work_queue/` and a `.gitignore` of `*` |
| `--config <path>` | `<dir>/pod.yaml` |
| `--runtime <name>` | `runtime:` from the configuration, else `apple` on macOS and `docker` elsewhere |
| `--container <name>` | `name:` from the configuration, else `heai-workshop`; `--name` is always a job's name, never the container's |

Durations for the worker - `--timeout` on `up` and `submit`, `--poll`, and the configuration's - are Go's: digits and one unit of `ms`, `s`, `m` or `h`, or `0` for no limit.
`wait --timeout` also takes a bare number of milliseconds.

### Exit codes

| code | meaning |
| --- | --- |
| `0` | done, or a job that finished `ok` |
| `1` | refused - a running job on `down`, a job name that exists, a `cancel` of a done job - or a job that finished `failed`, `timeout`, `canceled` or `crashed` |
| `2` | bad usage, a runtime or container that could not be asked, a job that does not exist, or `wait`'s own timeout |

## Layout

```
tools/pod/
  package.json            @heai-tools/pod, Node 22.18+, two dependencies: yaml and ajv
  schemas/pod.schema.json   the formal definition of pod.yaml
  image/
    Containerfile         the base image: a Go stage compiling the worker, then Debian with git, jq and the worker
    worker/               the worker: main.go (flags, signals), worker.go (the protocol), worker_test.go
    example/Containerfile an extended image to copy: node, python, claude
  src/
    cli.ts                the commands
    runtime.ts            the runtime contract; runtimes/apple.ts, runtimes/docker.ts
    box.ts                up, down, status, build
    queue.ts              the protocol from the host: submit, list, find, wait, cancel
    config.ts             paths, pod.yaml, the state directory
  test/
    fixtures/container-list.json   real Apple `container list` output
    fixtures/docker-ps.jsonl       `docker ps --format '{{json .}}'` as documented
    fake/                          a container/docker shim that replays fixtures
    *.test.ts                      the runtime parsers and argv, every command against the fake runtime, the queue with the worker played by hand, paths and configuration
```

Run the Node tests with `npm test`, and the worker's with `go test ./...` from `image/worker`.

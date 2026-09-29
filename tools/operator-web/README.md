# operator-web

[`operator`](../operator)'s panes as a web page - the tasks, the flows, the pod and the reactor, one tab each - plus two the terminal has no room for: every flow definition drawn as its **state machine**, and an **editor for the architecture map**.
It reads each tool's own files and asks each tool's own CLI, holds nothing but the last thing it read, and changes nothing but the map, and that only when you press Save.

```sh
npm install -g @heai-tools/operator-web      # or, from this directory: npm install && npm link
heai-operator-web --dir path/to/project      # http://127.0.0.1:8790
```

Requires Node 22.18 or newer. It asks the other tools by their released names: `heai-architect`, `heai-flow`, `heai-pod` and `heai-reactor` on PATH; a tool that is missing, or not configured in the project, leaves its tab saying so.
The page has one theme, dark.

There is no login. It binds to loopback by default, and it should stay there: an address anyone can reach shows them the project's tasks, branches and event payloads, lets them list directories through the map editor's file tree, and lets them edit the map.

## The tabs

Each tab carries its pane's one-line summary in the tab bar - counts, `⚠` and `●` - so the tabs that are not open still say how things stand, as the terminal's one-line panes do.
Pages refresh themselves in place every `--interval`, keeping the filter and the scroll; without JavaScript they reload. `/` reaches the filter; `1` to `4` are tasks, flows, pod and reactor, as on the terminal.

| route | what it shows |
| --- | --- |
| `/tasks` | every task, in pick-up order, with the actor its territories route to and where its blocker stands; `?active=1` narrows to the working set, `?sort=age\|slug\|territory` reorders |
| `/tasks/<slug>` | the task: frontmatter, territories with their owners, the blocker, the file, the body |
| `/flows` | the stuck flows and where their waits stand, every flow flow lists, and the definitions |
| `/flows/<id>` | the flow: its record, links and waits, its definition drawn with the moves it made, and its timeline from `heai-flow trace <id> --json` |
| `/machines`, `/machines/<definition>` | a definition drawn as its state machine, with how many flows stand in each state; `?state=` lists the flows in one |
| `/pod`, `/pod/<id>` | the container and every workspace; a workspace's tokens, agents and panes |
| `/reactor`, `/reactor/<id>` | the sources, the rules and the last hour's events; an event with every action a rule took and its payload |
| `/map/` | the map editor |
| `/api/state` | the whole reading as JSON, with `red` true when anything shown is red |

### The machines

`/machines` draws each flow definition as the state machine it is, one at a time, the one with the most open flows first.
States are boxes: the initial one entered by a dot, a terminal one double-bordered, the script a state's hook runs on entry under its name, and a count on every state flows stand in - open flows, or for a terminal state the flows that ended there - linking to the table of them below.
Transitions are arrows labelled with the event that makes them and, a line each, what else it takes: `when` the event's data must say, `after` the clock, `waits on` what the flows it waits on must reach, and `by` who may make it.
A transition back to an earlier state closes a cycle and is drawn pointing up, so every other arrow points down and the drawing reads from start to finish.
One rule from three or more states to the same one - the usual `canceled` from anywhere - is written once, on the state it reaches, rather than drawn as that many arrows.

The machine is `heai-flow definitions --json`, which carries each definition whole, so this tool reads no flow YAML.
The drawing is laid out on the server - ranked by longest path from the initial state, a layer between ranks for the labels, waypoints for arrows that cross ranks, barycentre ordering - and sent as SVG, so it needs no script and no library. States are not coloured by name: a state is whatever its definition calls it.

### The map editor

`/map/` views and edits the architecture map - the file the tasks tab asks architect about for `routes to` - as a system: repositories as containers and territories as nodes with `dependsOn` as arrows, the actors with what each owns and watches and the open tasks in each territory, and the map-wide postures, each field edited on its own with live validation.
It is the browser app that began as the standalone `map-editor`, with the graph library it draws with ([cytoscape](https://js.cytoscape.org) and the fcose layout, MIT, their licences in [`public/map/vendor/LICENSES.txt`](public/map/vendor/LICENSES.txt)) shipped in the package, so nothing is fetched from elsewhere.

It opens the map file and edits a copy in the page; **Save** writes it back. That is the one write this tool makes, and it is guarded:

- **Only a valid map is written.** Every edit is validated by `heai-architect check --format json`, the reference validator, on the text being edited; Save runs it once more and refuses a map with errors. Without architect on PATH nothing validates, so nothing saves.
- **Only over the version the page loaded.** Save names the version it edited; if the file changed on disk since, the page says so and asks before overwriting, and declining keeps the edits unsaved, to export or to reload over.
- **Only an edit's own lines change.** The system view edits a plain object, so the server merges it back into the YAML the page loaded: every key, list item and value left as it was keeps its comments, quoting, blank lines and comment alignment, and a saved map differs from the file by the lines that were edited. Raw YAML mode saves its text as typed.
- **Nothing is half-written.** The file is replaced by a rename, keeping its mode.
- Unsaved edits are kept in the browser as a draft, per map file, so a reload or a restarted server loses nothing. **Paste YAML…** and **Export .yaml** still bring a map in and take a copy out; a project without a map starts from the paste dialog or architect's template, and Save creates the file.

A repository's `localPath`, which the file tree lists files from, resolves against the map file's directory.

The editor's endpoints are under `/map/api/`: `GET file`, `PUT file` (the save), `POST validate`, `serialize`, `tree` and `tasks`, and `GET template`.
They answer only the page this server serves: every request must arrive under a `Host` that is an address, `localhost`, or a name given with `--allow-host`, so a page on a DNS name rebound to this machine cannot read the map or list directories through a visitor's browser; and a write must be JSON from the same origin, which a cross-site form cannot send.

## Where the numbers come from

Everything is read on two clocks into one reading every browser shares, so ten open tabs cost the tools no more than one:

- **The tracker** is read from its files every `--interval`, under the format contract the tasks tool's README states. This is a reader of that format written beside the tasks tool's own, as operator's is, because tools meet in their files and not in each other's code (root README, principles 1 and 3).
- **Owners and repositories** are `heai-architect territories --json` and `heai-architect check --format json`, asked again only when the map's mtime moves.
- **Flows** are `heai-flow definitions --json`, `list --json` and `stuck --json`, run with `--dir` set to the map's directory, every `--poll`; a flow's page asks `heai-flow trace <id> --json` once per view, and only for an id flow listed. flow is asked only when `flow.yaml` or `flow/` sits beside the map, or `HEAI_FLOW_STATE` is set, because `heai-flow list` creates `flow/` when it is absent.
- **The pod** is `heai-pod status --json` and, when the container and Herdr are up, `heai-pod list --json`; asked only when `pod.yaml` or `pod/` is in the project, or `HEAI_POD_STATE` is set.
- **The reactor** is `heai-reactor status --json` and `events --since 1h --json`; asked only when `reactor.yaml`, `.heai/reactor.yaml` or `reactor/` is in the project, or `HEAI_REACTOR_STATE` is set.
- **A tool that fails** keeps its last answer, and its tab says `⚠ <reason> · as of <time>`.

Times are shown in UTC, as the tools record them.

## Discovery

The same as operator's: flags first, then the specific environment variables, then the project directory, then the `.heai/` convention, then the working directory.

| what | flag | environment | default |
| --- | --- | --- | --- |
| the project | `--dir <dir>` | `HEAI_DIR` | the map's directory, else the tracker's parent |
| the tracker | `--tasks <dir>` | `HEAI_TASKS` | `$HEAI_DIR/tasks`, else `.heai/tasks` if it exists, else `tasks` |
| the map | `--map <path>` | `HEAI_MAP` | `$HEAI_DIR/architecture.yaml`, else the tracker's `tasks.yaml` `map:`, else `.heai/architecture.yaml`, else `architecture.yaml` |

## The CLI

```
heai-operator-web [--dir <dir>] [--tasks <dir>] [--map <path>]
                  [--port 8790] [--host 127.0.0.1] [--allow-host <name>]...
                  [--interval 2] [--poll 5]
```

`--port` and `--host` also read `PORT` and `HOST`. `--allow-host` names a host the map editor may be reached under besides an address or `localhost` - the name a reverse proxy or a tailnet serves it as; repeat it for more.

| code | meaning |
| --- | --- |
| `0` | stopped by ctrl-c or SIGTERM |
| `2` | no tracker at the resolved directory, bad usage, or the port could not be bound |

## Layout

```
src/cli.ts         flags, discovery, the listener
src/reader.ts      the reading, on its two clocks
src/tracker.ts     the tracker's files
src/owners.ts      heai-architect territories and check
src/flows.ts       heai-flow definitions, list, stuck, trace
src/pod.ts         heai-pod status and list
src/reactor.ts     heai-reactor status and events
src/server.ts      the routes and the guards
src/pages.ts       the pages, through html`` (src/html.ts), which escapes everything it is given
src/machine.ts     a flow definition's state-machine layout, as SVG
src/mapeditor.ts   the map editor's endpoints: validate, serialize keeping comments, tree, save
public/static/     the pages' stylesheet and the script that refreshes them in place
public/map/        the map editor's page and app, and the vendored graph library
test/fixtures/     the sibling tools' recorded output, and a map with comments to round-trip
```

```sh
npm test           # the pages, the machines and the editor over the recorded output; save and validate run architect from ../architect when its dependencies are installed
npm run typecheck
```

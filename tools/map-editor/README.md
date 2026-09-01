# @heai-tools/map-editor

A web editor for the architecture map: the system drawn from the map, an inspector that edits one field at a time, and live validation against the schema and the rules in [`docs/architecture-map.md`](../../docs/architecture-map.md).

```sh
npm install
npm start        # http://localhost:8789
```

Requires Node 22.18 or newer, which runs the TypeScript sources directly.

## The map lives in the browser

The editor does not read or write `architecture.yaml`.
A map arrives through the **Paste YAML…** dialog, is held in the browser's own storage while it is edited, and leaves through **Export .yaml**.
Nothing is written back to the file it came from, so what lands in the repository is a file you moved there yourself.

That keeps the server stateless: it can be restarted under an open editor, and the map is never at risk from a process holding a stale copy of it.
The store is per-browser and per-origin; clearing site data discards whatever has not been exported.

`--file architecture.yaml` seeds the editor: when the browser holds no map yet, the page reads that file once (through `GET /api/file`) instead of opening the paste dialog, and a **Reload** button re-reads it on demand.
The file is still never written - export to bring edits back to it.

A pasted map that does not validate opens in **Raw YAML** mode with its problems listed, so a half-written file can be finished here rather than rejected.

## The three tabs

| tab | what it edits |
| --- | --- |
| General | `unowned` and `undeclaredDependencies`, the map-wide postures |
| Actors | the humans and llm-agents that can own a territory, and what each owns |
| Territories | the system drawing: repositories as containers, territories as nodes, `dependsOn` as arrows |

Selecting a territory highlights the files its globs claim in the file tree; selecting an actor highlights everything it owns.
Clicking a file selects the territory that claims it, which is the fastest way to ask "who owns this?".

Every field is edited one at a time, deliberately: a boundary, an owner, or an edge is an architectural decision, and the editor is shaped so each one is a separate act rather than a bulk edit.

## Listing files: `localPath`

A repository entry's `localPath` says where a checkout of that tree sits on this machine, and the file tree lists it from there - a git checkout through `git ls-files`, anything else by walking the directory (`.git` and `node_modules` skipped, 20000 files maximum).
Set it from a repository's **⋯ → Edit** dialog.
A relative `localPath` resolves against the server's working directory, since the editor holds no map file to resolve it against - start the server from the tree the map governs, and `localPath: .` means that tree.
A repository without one still appears; it simply lists no files.

`localPath` is the one part of a map that is about the machine rather than the architecture, and a map is valid whether or not the path exists here.

## Validation

Validation runs on every edit, against the schema first and then the semantic rules the schema cannot express: referential integrity of owners, repositories, `dependsOn` and `exclude.territories`; an acyclic dependency graph; the glob dialect; and the no-overlap rule.

Overlap is a property of the **globs**, not of the files on disk: `src/**` and `src/legacy/**` overlap the moment both are written, empty or not, so a map that was valid when reviewed cannot be invalidated by a commit elsewhere.
An `exclude` clears a reported overlap when it provably covers one of the two globs, which is what `exclude.territories` and a mirrored `exclude.globs` do.
Where subtraction is subtler than that, the overlap is still reported: over-reporting on an exotic pair of patterns is better than silence on a real one.

Warnings cover what is worth looking at before it becomes wrong - an actor owning nothing, a repository no territory scopes, two repositories sharing a `remotePath`, an exclusion that subtracts nothing or that strands paths no territory claims, and a map with no human-owned territory to fall inside.

## Endpoints

The server serves the page and four stateless endpoints; none of them touch the map file.

| endpoint | purpose |
| --- | --- |
| `POST /api/validate` | `{"yaml": "..."}` or `{"map": {...}}` → `{valid, errors, warnings, map?}` |
| `POST /api/serialize` | `{"map": {...}}` → `{yaml}` |
| `POST /api/tree` | `{"repositories": {...}}` → the files under each entry's `localPath` |
| `GET /api/file` | the `--file` seed as `{path, name, yaml}`; 404 when none is configured |
| `GET /api/template` | the starter map, as YAML and as an object |
| `GET /api/schema` | the schema being validated against |

## Options

| option | environment | default | meaning |
| --- | --- | --- | --- |
| `--port` | `PORT` | `8789` | port to listen on |
| `--host` | `HOST` | `127.0.0.1` | address to bind |
| `--schema` | `SCHEMA_FILE` | `../../schemas/architecture.schema.json` | schema to validate against |
| `--file` | `MAP_FILE` | none | a map file to seed the browser from (read only) |
| `--base-path` | `BASE_PATH` | none | URL prefix the app is mounted under, e.g. behind `tailscale serve --set-path` |

`/api/tree` lists directories on the machine running the server, for whoever reaches the page.
That is why the default binding is loopback: bind wider only inside a container or behind a trusted proxy.

## Tests

```sh
npm test        # glob dialect, glob relations, schema and semantic rules
npm run typecheck
```

`test/glob.test.ts` pins the dialect - the same cases `scope-gate` pins, because both implement it separately and must agree.

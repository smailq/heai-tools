# operator - design

*Design, 2026-09-06, trimmed on 2026-09-09 to what is not built, and again on 2026-09-10 when the pod and reactor panes landed. The tasks, flows, pod and reactor panes are built and described in [`README.md`](README.md); a sessions pane, built on 2026-09-09, was folded into the flows pane on 2026-09-10 - one pane per definition does not scale, so the flows pane lists whichever definition `d` chooses, which replaces this document pane by pane as they land; the keys `e`, `a`, `c` and `s` that wrote through the sibling CLIs were built and then removed on 2026-09-10, so the screen only reads. The actors, runs and lanes panes, the `agent-host` provider, and the `pages` line were removed from the plan when [`docs/project.md`](../../docs/project.md) moved process out of the tools: sessions are flows now, lanes are one project's files, and nothing has a page.*

`operator`: one full-screen terminal view, in the shape of `htop`, of what every heai-tools tool is doing right now.
It refreshes on its own and answers a keypress at once.
It holds no state, runs no server, changes nothing, and learns everything it shows by asking each tool's own CLI or reading each tool's own files.

## What the survey found

*A survey of terminal UI libraries and of the `htop` family, done before this design. The findings that chose the stack and the conventions are listed with links so the choices can be checked.*

**Libraries.**

- The 2026 field has settled into three shapes ([melker's comparison](https://github.com/wistrand/melker/blob/main/agent_docs/tui-comparison.md), [LogRocket](https://blog.logrocket.com/7-tui-libraries-interactive-terminal-apps/)): Elm-style frameworks that own the loop ([Bubble Tea](https://github.com/charmbracelet/bubbletea), Go, v2 in 2026, 38k stars), immediate-mode libraries where you own the loop ([Ratatui](https://github.com/ratatui/awesome-ratatui), Rust, 8.x, 19k stars), and React-style declarative renderers ([Ink](https://github.com/vadimdemedes/ink), Node; [OpenTUI](https://opentui.com/docs/core-concepts/renderer/), TypeScript over a Zig core). [Textual](https://blog.logrocket.com/7-tui-libraries-interactive-terminal-apps/) (Python) is community-maintained since its company wound down in 2025; Blessed (Node) has been dead since 2016.
- **Flicker is solved at the protocol level now.** Ink 6.7+ and Bubble Tea v2 emit [DEC synchronized output](https://github.com/wistrand/melker/blob/main/agent_docs/tui-comparison.md) (`CSI ? 2026 h/l`), so a frame lands atomically; before that, flicker-free meant a cell-diffing renderer of your own.
- **Ink** is what Claude Code, Copilot CLI and Shopify's CLI are built on, requires React and Yoga, caps at 30 frames a second, and [sits above 50 MB resident](https://betterstack.com/community/guides/scaling-nodejs/opentui-react/) - a lot of machinery for a status table.
- **OpenTUI** is faster than Ink and pre-1.0, and its native core [requires Bun](https://github.com/luongnv89/asm/issues/224), a second JavaScript runtime this repository does not otherwise use.
- **Bubble Tea versus Ratatui** ([one comparison](https://dev.to/rosgluk/terminal-ui-bubbletea-go-vs-ratatui-rust-2plj), [another](https://blog.tng.sh/2026/03/go-vs-rust-for-tui-development-deep.html)): Ratatui uses a third less memory on a dashboard pushing a thousand updates a second, and costs the borrow checker and a hand-written event loop; Bubble Tea is "the fastest path to a polished TUI", with [Bubbles](https://github.com/charmbracelet/bubbles) supplying table, viewport, help and key-binding components and Lip Gloss the layout. This tool updates a few tables every couple of seconds; the performance case for Rust does not arise.
- **Zero dependencies in Node is possible** - the alternate screen, `setRawMode`, [`readline.emitKeypressEvents`](https://nodejs.org/api/readline.html) and `stdout.on('resize')` are all built in - and it means writing the frame buffer, the diff, the key parser, the table layout and the resize logic by hand, which is most of what a framework is.

**The `htop` family.**

- The layout is fixed header, scrolling body, key bar ([htop guide](https://www.dolpa.me/htop-a-comprehensive-user-guide/)); the header carries meters, the body one sortable table, the bar the function keys with their meanings written next to them, so the screen teaches itself.
- The interval is a flag (`-d`) and a key, and users [ask for it in the UI](https://github.com/htop-dev/htop/issues/356) when it is not; sorting is one key per column; a search and a filter are separate keys.
- `htop` persists its setup in `~/.config/htop/htoprc` and is meant to be tuned live rather than by editing that file.
- `top -b -n1` is the family's batch mode: the same screen, once, to stdout, which is what makes a monitor scriptable.
- Newer tools (k9s, lazygit, btop) keep the bar but bind letters rather than function keys, add `?` for a full help overlay, and open a detail view on Enter.

## The stack, and why

**Go, Bubble Tea v2, Lip Gloss.**
A single static binary that starts in milliseconds, which matters for a program a person opens and closes all day; an Elm loop where each tool's poll is a command that returns a message, so a slow CLI never blocks a keypress and each pane refreshes on its own clock; synchronized output for free; and a plain string renderer that a golden file pins.

It is the first tool here not written in TypeScript.
The root README says tools will target different languages, and this is the one whose job - a full-screen loop over a terminal - is what Go's TUI ecosystem was built for.
What it costs is a second reader of the tracker's frontmatter, in Go, pinned by the same fixture the tasks tool's tests use: a copy on purpose, exactly principle 1's second clause.

The two alternatives considered, kept here so the choice can be revisited:

- **Node with no dependencies**, for a uniform toolchain and `npm link` like the rest. The cost is a renderer, key parser and layout engine written by hand, four or five hundred lines that are not about heai-tools, and no framework's answers to resize, mouse and bracketed paste.
- **Node with Ink**, for the framework without the second language. React and Yoga for a screen of tables, a 30 fps cap that does not matter and 50 MB that slightly does, and a JSX build step the other tools avoid.

## The conventions every pane keeps

Built panes keep these and unbuilt ones must:

- **A provider per tool.** Each knows how to detect its tool - the binary on `PATH`, and its configuration or state directory beside the map - how to poll it, and how to draw its pane. A tool that is not installed is one dimmed line; a tool installed but not configured beside this map is one dimmed line saying so; a tool that is present is a pane.
- **Polling is asking the tool, not reimplementing it.** Where a tool answers in JSON the provider runs that command and shows its answer, and a recording of that answer under `testdata/` is the format contract, pinned by a test.
- **Each pane has its own clock**, and its title carries the age of its data; a poll that fails leaves the pane as it was, marked stale with the reason.
- **Nothing is remembered between frames but the last answer.** No cache on disk, no history, no state directory.
- **No writes.** Every command this tool runs is a query. The first build bound four writes to keys, each a sibling CLI run verbatim and shown on the bar; they went, so that a change is made where it is recorded, at the shell, and the screen is only a reading.
- **Sixteen colours**, so the screen follows the terminal's theme; `NO_COLOR` and a dumb terminal degrade to bold and dim.

## The panes not built

### map - `heai-architect check --format json`

One line, which is also a header meter:

```
 map  ✓ valid  0 errors  2 warnings                                          architecture.yaml  changed 2h ago
```

Table, when selected or when the map has errors, since an invalid map is the first thing to fix:

```
 map ── ✗ invalid  1 error  2 warnings ────────────────────────────────────── architecture.yaml  changed 8s ago
 level    where                                   message
 error    territories.mail.dependsOn               unknown territory `messaging`
 warning  actors.extensions-owner                  owns nothing and watches nothing
 warning  territories.website / territories.web    exclude subtracts nothing: `apps/website/legacy/**` matches no glob
```

The map pane polls on the file's mtime, not on a clock; `changed 8s ago` is the mtime, so a human who just saved sees the verdict of what they saved.
The owners provider already runs `check --format json` when the mtime moves, for the repositories; this pane is the same answer's `errors` and `warnings` drawn, so it costs no second command.

### reactor and pod - built

Both landed on 2026-09-10 and are described in the README. Two departures from the reactor pane as it was drawn here, kept so the choice can be revisited:

- **Quiet is not marked.** The drawing made a source `○` when it had not produced or polled within twice its interval. `status --json` says when a source last produced but not when it last polled, and a git source with no commits for a day is quiet and fine; so only a source whose own cursor reports a `PROBLEM` is `○`, and the problem is shown in its words.
- **Actions come with the events.** The first build read `actions/<event>.<rule>.json` under reactor's state directory, because no reactor command joined events to the actions they caused; `heai-reactor events --json` now carries each event's actions, and the reader went the same day.

The pod pane had no drawing here: it grew out of the workspaces block the sessions pane carried, which moved to a pane of its own once `heai-pod status --json` gave the container a line to stand on.

### A pane whose tool is absent, unconfigured, or not answering

The three dimmed forms, each one line, as the built panes already draw them:

```
 reactor   not installed  (no `heai-reactor` on PATH)
 reactor   not configured here  (no reactor.yaml or reactor/ beside the map)
 flows     ⚠ flow: timed out after 10s · as of 13:59:40
```

A stale pane keeps its last table under that title; a pane that has never answered has nothing to keep and stays a line.

## What v1 deliberately leaves out

- **Any write.** No task move, no session start or cancel, no tick: each is the tool's own command, run by a hook or a human at the shell.
- **History and graphs.** No sparkline of sessions per hour, no log of what the screen saw. The tools' files are the history; `heai-flow trace` is the graph.
- **Persisted setup.** Sort, filter and hidden columns reset on exit. `htop` keeps them in `htoprc`; where this tool would keep them is the project's `.heai/`, and that is not adopted yet.
- **Mouse.** Bubble Tea supports it; the key bar is the interface, and mouse comes later if asked for.
- **Themes and 24-bit colour.** Sixteen colours is the point.
- **Remote hosts.** It shows the directory it is run in. Watching another machine is `ssh host operator`.

## Open questions

1. **A pane for the map, or a header meter.** The map's verdict is one line; a pane earns its height only when the map has errors. The first build may be the meter alone, with the table only while errors exist.
2. **Whether the stuck threshold is a key.** `heai-flow stuck` defaults to an hour and takes `--older`; the pane uses the default. A key to widen or narrow it costs nothing and may be wanted.
3. **Whether any key should write again.** The four that did were removed; if one comes back, the convention it kept - the sibling CLI verbatim, shown on the bar before it runs and with its outcome after - is the one to keep.

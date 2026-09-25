// heai-operator: an htop-shaped terminal view of what the heai tools are doing:
// the tracker's tasks, the flows that are stuck or of one definition, the
// container's workspaces, and what the reactor has seen and done.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/smailq/heai-tools/tools/operator/internal/discover"
	"github.com/smailq/heai-tools/tools/operator/internal/flows"
	"github.com/smailq/heai-tools/tools/operator/internal/pod"
	"github.com/smailq/heai-tools/tools/operator/internal/reactor"
	"github.com/smailq/heai-tools/tools/operator/internal/tracker"
	"github.com/smailq/heai-tools/tools/operator/internal/ui"
	"github.com/smailq/heai-tools/tools/operator/internal/web"
)

const usage = `heai-operator - what the heai tools are doing, on one screen

  heai-operator                  the screen
  heai-operator --once           the screen, once, to stdout, then exit (every task; --active for the working set)
  heai-operator --json           the tracker, the flows, the pod and the reactor as the screen read them, then exit
  heai-operator --serve <addr>   the screen as a web page, one tab per pane, and the map editor at /map/;
                                 e.g. --serve 127.0.0.1:8080

  --dir <dir>         the project directory: the map at its root, tasks/ and flow/ under it; or HEAI_DIR
  --tasks <dir>       the tracker; default $HEAI_DIR/tasks, else .heai/tasks, else tasks, or HEAI_TASKS
  --map <path>        the architecture map, for "routes to" and for flow; default $HEAI_DIR/architecture.yaml,
                      else the tracker's tasks.yaml, else .heai/architecture.yaml, else architecture.yaml, or HEAI_MAP
  --interval <dur>    the tracker's refresh interval (default 2s)
  --poll <dur>        the clock for the panes that ask flow, pod and reactor (default 5s)
  --active            --once: only the active tasks - in-progress, in-review, blocked, todo
  --width <n>         --once: columns to render (default $COLUMNS, else 120)
  --serve-host <name> --serve: a host name the map editor may be reached under, besides an address
                      or localhost - the name a proxy or tailnet serves it as; comma-separated

exit codes: 0 shown, and under --once/--json nothing red; 1 something is red - an invalid task file,
a blocked task whose blocker is canceled or missing, a stuck flow waiting on a flow that ended
without done, or a reactor rule that ran and failed in the last hour; 2 no tracker, or bad usage.
`

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	fs := flag.NewFlagSet("heai-operator", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	// Parse prints a bad flag itself; the usage follows below, on stderr for a mistake and on stdout for --help.
	fs.Usage = func() {}
	dirFlag := fs.String("dir", "", "")
	tasksFlag := fs.String("tasks", "", "")
	mapFlag := fs.String("map", "", "")
	interval := fs.Duration("interval", 2*time.Second, "")
	poll := fs.Duration("poll", 5*time.Second, "")
	once := fs.Bool("once", false, "")
	asJSON := fs.Bool("json", false, "")
	active := fs.Bool("active", false, "")
	width := fs.Int("width", 0, "")
	serve := fs.String("serve", "", "")
	serveHost := fs.String("serve-host", "", "")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			// --help and -h are a request, not a mistake: the usage on stdout, exit 0.
			fmt.Fprint(os.Stdout, usage)
			return 0
		}
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "heai-operator: unexpected argument %q\n%s", fs.Arg(0), usage)
		return 2
	}

	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, "heai-operator:", err)
		return 2
	}
	env := discover.EnvFromOS()
	if *dirFlag != "" {
		env.HEAI_DIR = *dirFlag
	}
	opts := ui.Options{
		TasksDir:     discover.Tasks(*tasksFlag, env, cwd),
		Cwd:          cwd,
		Interval:     *interval,
		SlowInterval: *poll,
	}
	// A --map, HEAI_MAP or HEAI_DIR beats the tracker's own config; discover.Map applies the rest per snapshot.
	if *mapFlag != "" || env.HEAI_MAP != "" || env.HEAI_DIR != "" {
		opts.MapOverride = discover.Map(*mapFlag, env, "", cwd)
	}
	if env.HEAI_DIR != "" {
		opts.Project = discover.Project(env, "", "", cwd)
	}

	if *once || *asJSON {
		now := time.Now()
		snap := ui.Load(opts, ui.Snapshot{})
		if snap.Err != nil {
			fmt.Fprintln(os.Stderr, "heai-operator:", snap.Err)
			return 2
		}
		project := ui.New(opts).WithSnapshot(snap).Project()
		fl := ui.LoadFlows(snap.MapPath, now)
		po, re := ui.LoadPod(project, now), ui.LoadReactor(project, now)
		if *asJSON {
			return printJSON(snap, fl, po, re)
		}
		return printOnce(opts, snap, fl, po, re, *active, *width)
	}

	if *serve != "" {
		return runServer(opts, *serve, strings.Split(*serveHost, ","))
	}

	m := ui.New(opts)
	if _, err := tea.NewProgram(m).Run(); err != nil {
		fmt.Fprintln(os.Stderr, "heai-operator:", err)
		return 2
	}
	return 0
}

// runServer serves the panes and the map editor over HTTP until interrupted. Every
// route but the editor's is a read, and the editor writes only the map. It binds
// where it is told: there is no login, so an address other than loopback shows the
// project, and lets anyone who can reach it edit the map.
func runServer(opts ui.Options, addr string, hosts []string) int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	srv := web.New(opts)
	srv.AllowHosts(hosts...)
	if err := srv.Run(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "heai-operator:", err)
		return 2
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fmt.Fprintln(os.Stderr, "heai-operator:", err)
		return 2
	}
	hs := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	fmt.Fprintf(os.Stderr, "heai-operator: serving http://%s - the panes read only, the map editable at /map/ (ctrl-c to stop)\n", ln.Addr())
	go func() {
		<-ctx.Done()
		shut, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = hs.Shutdown(shut)
	}()
	if err := hs.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, "heai-operator:", err)
		return 2
	}
	return 0
}

func printOnce(opts ui.Options, snap ui.Snapshot, fl flows.Result, po pod.Result, re reactor.Result, active bool, width int) int {
	opts.Plain = true
	opts.NoSplit = true
	if width <= 0 {
		if c, err := strconv.Atoi(os.Getenv("COLUMNS")); err == nil && c > 0 {
			width = c
		} else {
			width = 120
		}
	}
	m := ui.New(opts).WithSnapshot(snap).WithFlows(fl).WithPod(po).WithReactor(re)
	if active {
		m = m.WithActive()
	}
	m = m.WithSize(width, m.OnceHeight())
	fmt.Println(m.Render())
	if m.Red() {
		return 1
	}
	return 0
}

func printJSON(snap ui.Snapshot, fl flows.Result, po pod.Result, re reactor.Result) int {
	out := struct {
		Tracker *tracker.Tracker  `json:"tracker"`
		Map     string            `json:"map,omitempty"`
		Owners  map[string]string `json:"owners,omitempty"`
		Repos   []string          `json:"repositories,omitempty"`
		Note    string            `json:"ownersNote,omitempty"`
		Counts  map[string]int    `json:"counts"`
		Flows   flows.Result      `json:"flows"`
		Pod     pod.Result        `json:"pod"`
		Reactor reactor.Result    `json:"reactor"`
		Red     bool              `json:"red"`
		At      time.Time         `json:"at"`
	}{snap.Tracker, snap.MapPath, snap.Owners.Owners, snap.Owners.Repos, snap.Owners.Note, snap.Tracker.Counts(), fl, po, re, snap.Tracker.Red() || fl.Red() || re.Red(), snap.At}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, "heai-operator:", err)
		return 2
	}
	if out.Red {
		return 1
	}
	return 0
}

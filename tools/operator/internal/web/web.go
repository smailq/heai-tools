// Package web is the screen in a browser: the same four panes the terminal
// shows - tasks, flows, pod, reactor - one tab each, read on the same clocks
// from the same tools, and as read-only as the terminal: every route is a GET,
// and every command it runs is a query. The fifth tab, the map editor, is the
// exception: it writes the architecture map, and nothing else (mapeditor.go).
package web

import (
	"context"
	"embed"
	"encoding/json"
	"html/template"
	"io/fs"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/smailq/heai-tools/tools/operator/internal/flows"
	"github.com/smailq/heai-tools/tools/operator/internal/pod"
	"github.com/smailq/heai-tools/tools/operator/internal/reactor"
	"github.com/smailq/heai-tools/tools/operator/internal/tracker"
	"github.com/smailq/heai-tools/tools/operator/internal/ui"
)

//go:embed templates/*.html
var templateFS embed.FS

//go:embed static
var staticFS embed.FS

//go:embed map
var mapFS embed.FS

// State is one reading of every pane: the tracker with its owners, and the three sibling polls.
type State struct {
	Snap    ui.Snapshot
	Flows   flows.Result
	Pod     pod.Result
	Reactor reactor.Result
}

// Red reports whether anything the screen would show red is there, as --json says it.
func (s State) Red() bool {
	return (s.Snap.Tracker != nil && s.Snap.Tracker.Red()) || s.Flows.Red() || s.Reactor.Red()
}

// Server holds the last reading and serves it; it keeps nothing else.
type Server struct {
	opts ui.Options
	tmpl map[string]*template.Template

	mu    sync.RWMutex
	state State
	// saveMu makes the map editor's check-then-write one step.
	saveMu sync.Mutex
	// hosts are the names, beyond an address or localhost, a writing request may arrive under.
	hosts map[string]bool
	// trace is how a flow's timeline is read for its page; tests replace it.
	trace func(mapPath, id string) (flows.Timeline, error)
}

// New builds a server; Run starts its clocks, or Seed gives it a reading.
func New(opts ui.Options) *Server {
	if opts.Interval <= 0 {
		opts.Interval = 2 * time.Second
	}
	if opts.SlowInterval <= 0 {
		opts.SlowInterval = 5 * time.Second
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	s := &Server{opts: opts, trace: flows.TraceJSON}
	s.tmpl = parseTemplates(s)
	return s
}

// AllowHosts names hosts the map editor may be reached under besides an IP address or
// localhost - the name a proxy or a tailnet serves it as.
func (s *Server) AllowHosts(names ...string) {
	if s.hosts == nil {
		s.hosts = map[string]bool{}
	}
	for _, n := range names {
		if n = strings.ToLower(strings.TrimSpace(n)); n != "" {
			s.hosts[n] = true
		}
	}
}

// Seed replaces the reading, for tests.
func (s *Server) Seed(st State) {
	s.mu.Lock()
	s.state = st
	s.mu.Unlock()
}

func (s *Server) snapshot() State {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.state
}

// Run reads the tracker on Interval and asks flow, pod and reactor on SlowInterval
// until ctx ends. The first tracker reading is taken before it returns, so a
// missing tracker is an error the caller can exit on.
func (s *Server) Run(ctx context.Context) error {
	first := ui.Load(s.opts, ui.Snapshot{})
	if first.Err != nil {
		return first.Err
	}
	s.mu.Lock()
	s.state.Snap = first
	s.mu.Unlock()
	s.pollSlow()

	go s.loop(ctx, s.opts.Interval, func() {
		prev := s.snapshot().Snap
		next := ui.Load(s.opts, prev)
		s.mu.Lock()
		if next.Err != nil && prev.Tracker != nil {
			// Keep the last tracker, and say it is old.
			prev.Err = next.Err
			next = prev
		}
		s.state.Snap = next
		s.mu.Unlock()
	})
	go s.loop(ctx, s.opts.SlowInterval, s.pollSlow)
	return nil
}

func (s *Server) loop(ctx context.Context, every time.Duration, f func()) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			f()
		}
	}
}

// pollSlow asks the three sibling tools at once and keeps each one's last answer when it fails, as the terminal does.
func (s *Server) pollSlow() {
	cur := s.snapshot()
	mapPath := cur.Snap.MapPath
	project := ui.New(s.opts).WithSnapshot(cur.Snap).Project()
	now := s.opts.Now()

	var wg sync.WaitGroup
	var fl flows.Result
	var po pod.Result
	var re reactor.Result
	wg.Add(3)
	go func() { defer wg.Done(); fl = ui.LoadFlows(mapPath, now) }()
	go func() { defer wg.Done(); po = ui.LoadPod(project, now) }()
	go func() { defer wg.Done(); re = ui.LoadReactor(project, now) }()
	wg.Wait()

	s.mu.Lock()
	defer s.mu.Unlock()
	if fl.Failed && (len(s.state.Flows.Flows) > 0 || len(s.state.Flows.Stuck) > 0) {
		s.state.Flows.Note, s.state.Flows.Failed = fl.Note, true
	} else {
		s.state.Flows = fl
	}
	if po.Failed && s.state.Pod.Status != nil {
		s.state.Pod.Note, s.state.Pod.Failed = po.Note, true
	} else {
		s.state.Pod = po
	}
	if re.Failed && s.state.Reactor.Status != nil {
		s.state.Reactor.Note, s.state.Reactor.Failed = re.Note, true
	} else {
		s.state.Reactor = re
	}
}

// Handler is every route: one tab per pane, a page per row, the JSON --json prints, and the static files.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/tasks", http.StatusFound)
	})
	mux.HandleFunc("GET /tasks", s.tasks)
	mux.HandleFunc("GET /tasks/{slug}", s.task)
	mux.HandleFunc("GET /flows", s.flowList)
	mux.HandleFunc("GET /flows/{id}", s.flow)
	mux.HandleFunc("GET /pod", s.podList)
	mux.HandleFunc("GET /pod/{id}", s.workspace)
	mux.HandleFunc("GET /reactor", s.reactorList)
	mux.HandleFunc("GET /reactor/{id}", s.event)
	mux.HandleFunc("GET /api/state", s.api)
	s.mapAPI(mux)
	static, _ := fs.Sub(staticFS, "static")
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServerFS(static)))
	return s.guard(mux)
}

// guard refuses anything but a read outside the map editor's API, admits the editor's
// own requests only from its own page, and keeps every page's scripts and styles to
// its own origin.
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		read := r.Method == http.MethodGet || r.Method == http.MethodHead
		if !read && !strings.HasPrefix(r.URL.Path, "/map/api/") {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "read only: every change is made at the shell with the tool's own command", http.StatusMethodNotAllowed)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/map/api/") {
			if err := apiGuard(r, s.hosts); err != nil {
				sendError(w, http.StatusForbidden, err.Error())
				return
			}
		}
		h := w.Header()
		csp := "default-src 'self'; frame-ancestors 'none'"
		if strings.HasPrefix(r.URL.Path, "/map/") {
			// The graph library injects one stylesheet for its container; scripts stay our own.
			csp += "; style-src 'self' 'unsafe-inline'"
		}
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

// page is what every template gets: the reading, which tab is open, and that tab's own data.
type page struct {
	State
	Tab     string
	Title   string
	Now     time.Time
	Refresh int
	Project string
	Data    any
}

func (s *Server) render(w http.ResponseWriter, name, tab, title string, st State, data any) {
	s.renderStatus(w, http.StatusOK, name, tab, title, st, data)
}

func (s *Server) renderStatus(w http.ResponseWriter, code int, name, tab, title string, st State, data any) {
	p := page{
		State:   st,
		Tab:     tab,
		Title:   title,
		Now:     s.opts.Now(),
		Refresh: max(1, int(s.opts.Interval/time.Second)),
		Project: filepath.Base(ui.New(s.opts).WithSnapshot(st.Snap).Project()),
		Data:    data,
	}
	var buf strings.Builder
	if err := s.tmpl[name].ExecuteTemplate(&buf, "layout", p); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(code)
	_, _ = w.Write([]byte(buf.String()))
}

func (s *Server) notFound(w http.ResponseWriter, r *http.Request, tab, what string) {
	s.renderStatus(w, http.StatusNotFound, "missing", tab, "not found", s.snapshot(), what)
}

// taskList is the tasks tab: every task, or the working set with ?active=1, in the chosen order.
type taskList struct {
	Rows   []tracker.Task
	Total  int
	Active bool
	Sort   string
}

func (s *Server) tasks(w http.ResponseWriter, r *http.Request) {
	st := s.snapshot()
	d := taskList{Active: r.URL.Query().Get("active") == "1", Sort: r.URL.Query().Get("sort")}
	if st.Snap.Tracker != nil {
		d.Total = len(st.Snap.Tracker.Tasks)
		for _, t := range st.Snap.Tracker.Tasks {
			if d.Active && t.Valid() && !tracker.WorkingSet[t.Status] {
				continue
			}
			d.Rows = append(d.Rows, t)
		}
	}
	switch d.Sort {
	case "age":
		sort.SliceStable(d.Rows, func(i, j int) bool { return d.Rows[i].ModifiedAt > d.Rows[j].ModifiedAt })
	case "slug":
		sort.SliceStable(d.Rows, func(i, j int) bool { return d.Rows[i].Slug < d.Rows[j].Slug })
	case "territory":
		sort.SliceStable(d.Rows, func(i, j int) bool {
			a, b := strings.Join(d.Rows[i].Territories, ","), strings.Join(d.Rows[j].Territories, ",")
			if (a == "") != (b == "") {
				return a != ""
			}
			return a < b
		})
	default:
		d.Sort = "pick-up"
	}
	s.render(w, "tasks", "tasks", "tasks", st, d)
}

func (s *Server) task(w http.ResponseWriter, r *http.Request) {
	st := s.snapshot()
	slug := r.PathValue("slug")
	var t *tracker.Task
	if st.Snap.Tracker != nil {
		t = st.Snap.Tracker.BySlug(slug)
	}
	if t == nil {
		s.notFound(w, r, "tasks", "no task "+slug+" in the tracker")
		return
	}
	s.render(w, "task", "tasks", t.Slug, st, t)
}

// flowPage is one flow with where its waits stand and its timeline.
type flowPage struct {
	Flow     flows.Flow
	Stuck    *flows.Stuck
	Timeline flows.Timeline
	TraceErr string
}

func (s *Server) flowList(w http.ResponseWriter, r *http.Request) {
	st := s.snapshot()
	s.render(w, "flows", "flows", "flows", st, nil)
}

func (s *Server) flow(w http.ResponseWriter, r *http.Request) {
	st := s.snapshot()
	id := r.PathValue("id")
	// Only an id flow listed is asked about, so nothing from the URL reaches a command line unchecked.
	f, ok := flows.Index(st.Flows.Flows)[id]
	if !ok {
		s.notFound(w, r, "flows", "no flow "+id+" in flow's last answer")
		return
	}
	p := flowPage{Flow: f}
	for i := range st.Flows.Stuck {
		if st.Flows.Stuck[i].Flow.ID == id {
			p.Stuck = &st.Flows.Stuck[i]
		}
	}
	tl, err := s.trace(st.Snap.MapPath, id)
	if err != nil {
		p.TraceErr = err.Error()
	}
	p.Timeline = tl
	s.render(w, "flow", "flows", f.ID, st, p)
}

func (s *Server) podList(w http.ResponseWriter, r *http.Request) {
	s.render(w, "pod", "pod", "pod", s.snapshot(), nil)
}

func (s *Server) workspace(w http.ResponseWriter, r *http.Request) {
	st := s.snapshot()
	id := r.PathValue("id")
	for i := range st.Pod.Workspaces {
		if st.Pod.Workspaces[i].ID == id {
			s.render(w, "workspace", "pod", "workspace "+id, st, &st.Pod.Workspaces[i])
			return
		}
	}
	s.notFound(w, r, "pod", "no workspace "+id+" in pod's last answer")
}

func (s *Server) reactorList(w http.ResponseWriter, r *http.Request) {
	s.render(w, "reactor", "reactor", "reactor", s.snapshot(), nil)
}

func (s *Server) event(w http.ResponseWriter, r *http.Request) {
	st := s.snapshot()
	id := r.PathValue("id")
	for i := range st.Reactor.Events {
		if st.Reactor.Events[i].ID == id {
			s.render(w, "event", "reactor", "event "+id, st, &st.Reactor.Events[i])
			return
		}
	}
	s.notFound(w, r, "reactor", "no event "+id+" in the last hour")
}

// api is what --json prints, from the last reading rather than a fresh one.
func (s *Server) api(w http.ResponseWriter, r *http.Request) {
	st := s.snapshot()
	var counts map[string]int
	if st.Snap.Tracker != nil {
		counts = st.Snap.Tracker.Counts()
	}
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
	}{st.Snap.Tracker, st.Snap.MapPath, st.Snap.Owners.Owners, st.Snap.Owners.Repos, st.Snap.Owners.Note, counts, st.Flows, st.Pod, st.Reactor, st.Red(), st.Snap.At}
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(out)
}

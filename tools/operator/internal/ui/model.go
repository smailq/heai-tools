// Package ui is the screen: an htop-shaped view over the tracker, the flows and
// the sessions, each pane refreshed on its own clock, holding nothing but the
// last thing it read.
package ui

import (
	"sort"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/smailq/heai-tools/tools/operator/internal/actions"
	"github.com/smailq/heai-tools/tools/operator/internal/discover"
	"github.com/smailq/heai-tools/tools/operator/internal/flows"
	"github.com/smailq/heai-tools/tools/operator/internal/owners"
	"github.com/smailq/heai-tools/tools/operator/internal/tracker"
	"github.com/smailq/heai-tools/tools/operator/internal/workspaces"
)

// Options is everything the screen is told once.
type Options struct {
	TasksDir string
	// MapOverride is --map, HEAI_MAP or HEAI_DIR's map, already resolved; "" means "the tracker's config, else the convention".
	MapOverride string
	// Project is HEAI_DIR or --dir, already resolved; "" means the map's directory, else the tracker's parent.
	Project string
	Cwd     string
	// Interval is the tracker's clock; +/- move it.
	Interval time.Duration
	// SlowInterval is the clock for the panes that ask a sibling CLI, flows and sessions.
	SlowInterval time.Duration
	// Plain disables colour and attributes, for --once and for golden tests.
	Plain bool
	// NoSplit keeps the list alone however wide the screen; --once uses it, since a batch listing wants rows, not one task's body.
	NoSplit bool
	Now     func() time.Time
}

// Snapshot is one reading of the tracker's files, with the owners the map gives.
type Snapshot struct {
	Tracker *tracker.Tracker
	Err     error
	MapPath string
	Owners  owners.Result
	At      time.Time
}

// Sessions is the sessions pane's reading: the session flows, and the container's workspaces.
type Sessions struct {
	Flows []flows.Flow `json:"flows"`
	// Note says why Flows is empty or old: no session flows, flow not on PATH, not configured here, or the failure.
	Note       string            `json:"note,omitempty"`
	Failed     bool              `json:"failed,omitempty"`
	Workspaces workspaces.Result `json:"workspaces"`
	At         time.Time         `json:"at"`
}

// Load takes a snapshot of the tracker. Owners are re-asked of architect only
// when the map's mtime moved since prev, since validation is not free and the
// map rarely changes.
func Load(opts Options, prev Snapshot) Snapshot {
	now := time.Now
	if opts.Now != nil {
		now = opts.Now
	}
	s := Snapshot{At: now()}
	t, err := tracker.Load(opts.TasksDir)
	if err != nil {
		s.Err = err
		s.Owners = prev.Owners
		s.MapPath = prev.MapPath
		if s.MapPath == "" {
			s.MapPath = discover.Map(opts.MapOverride, discover.Env{}, "", opts.Cwd)
		}
		return s
	}
	s.Tracker = t
	s.MapPath = discover.Map(opts.MapOverride, discover.Env{}, t.MapPath, opts.Cwd)
	s.Owners = prev.Owners
	if s.MapPath != prev.MapPath || mapMoved(s.MapPath, prev.Owners.MapModTime) {
		s.Owners = owners.Resolve(s.MapPath)
	}
	return s
}

// LoadFlows asks flow for everything open and everything stuck.
func LoadFlows(mapPath string, now time.Time) flows.Result { return flows.Poll(mapPath, now) }

// LoadSessions asks flow for the session flows and pod for the workspaces.
func LoadSessions(mapPath string, now time.Time) Sessions {
	s := Sessions{At: now}
	switch ok, why := flows.Configured(mapPath); {
	case !flows.Installed():
		s.Note = "flow not on PATH"
	case !ok:
		s.Note = why
	default:
		list, err := flows.List(mapPath, "session")
		switch {
		case err != nil:
			s.Note, s.Failed = err.Error(), true
		case len(list) == 0:
			s.Note = "no session flows"
		default:
			s.Flows = list
		}
	}
	s.Workspaces = workspaces.Poll(now)
	return s
}

func mapMoved(path string, seen time.Time) bool {
	if path == "" {
		return false
	}
	return modTime(path) != seen
}

// sort modes for the tasks pane, cycled by S.
const (
	sortPickup = iota
	sortAge
	sortSlug
	sortTerritory
	sortCount
)

var sortNames = []string{"pick-up", "age", "slug", "territory"}

// pane is which of the three has the table; the other two are one line each.
type pane int

const (
	paneTasks pane = iota
	paneFlows
	paneSessions
	paneCount
)

var paneNames = []string{"tasks", "flows", "sessions"}

// Model is the Bubble Tea model.
type Model struct {
	opts     Options
	snap     Snapshot
	flows    flows.Result
	sessions Sessions
	width    int
	height   int

	pane   pane
	cursor int
	offset int
	sortBy int
	filter string
	typing bool
	// active narrows the task list to the working set; the default shows every status.
	active bool
	help   bool
	// loading is the tracker's read in flight; slowPending counts the sibling polls in flight.
	loading     bool
	slowPending int
	slowStarted bool

	// focus says which pane the movement keys drive when the screen is split.
	focus int
	// panelOff hides the task pane; p toggles it, and the list takes the whole width.
	panelOff bool

	// detail is a task opened full width; detailOff scrolls its body, the split pane's, and a trace.
	detail    *tracker.Task
	detailOff int
	// trace is a flow's timeline opened full width, from `flow trace <id>`.
	trace *traceView

	// edit is the status and priority editor open on one task, or nil.
	edit *editor
	// pending is a command shown on the bar, waiting for y.
	pending *pending
	// notice is the last action's command and outcome, shown on the bar until the next key.
	notice    string
	noticeRed bool
}

// traceView is `flow trace <id>` as flow printed it, or why it could not.
type traceView struct {
	id      string
	text    string
	err     string
	loading bool
}

// pending is one command the bar shows before y runs it.
type pending struct {
	command string
	run     func() actions.Result
}

// editor holds the two rows of pills: which row has focus, and the chosen index in each.
type editor struct {
	slug     string
	row      int // 0 status, 1 priority
	status   int // index into tracker.Statuses
	priority int // index into priorityChoices
	orig     [2]int
}

// priorityChoices is the priority vocabulary with "not triaged" first, shown as "-".
var priorityChoices = append([]string{""}, tracker.Priorities...)

func (e *editor) changed() bool { return e.status != e.orig[0] || e.priority != e.orig[1] }

// change is what Enter would ask tasks to set: only the fields that moved.
func (e *editor) change() actions.Change {
	var c actions.Change
	if e.status != e.orig[0] {
		s := tracker.Statuses[e.status]
		c.Status = &s
	}
	if e.priority != e.orig[1] {
		p := priorityChoices[e.priority]
		c.Priority = &p
	}
	return c
}

type actionMsg actions.Result

const (
	focusLeft = iota
	focusRight
)

// New builds the model; the first snapshot is taken by Init.
func New(opts Options) Model {
	if opts.Interval <= 0 {
		opts.Interval = 2 * time.Second
	}
	if opts.SlowInterval <= 0 {
		opts.SlowInterval = 5 * time.Second
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return Model{opts: opts, width: 80, height: 24}
}

// WithSnapshot seeds the model with a tracker reading, for --once and for tests.
func (m Model) WithSnapshot(s Snapshot) Model { m.snap = s; return m }

// WithFlows seeds the flows pane, for --once and for tests.
func (m Model) WithFlows(r flows.Result) Model { m.flows = r; return m }

// WithSessions seeds the sessions pane, for --once and for tests.
func (m Model) WithSessions(s Sessions) Model { m.sessions = s; return m }

// WithSize sets the terminal size, for --once and for tests.
func (m Model) WithSize(w, h int) Model { m.width, m.height = w, h; return m }

// WithActive narrows the list to the working set, for --once --active.
func (m Model) WithActive() Model { m.active = true; return m }

// Flows is the flows pane's last answer, for --json.
func (m Model) Flows() flows.Result { return m.flows }

// Sessions is the sessions pane's last answer, for --json.
func (m Model) Sessions() Sessions { return m.sessions }

// RowCount is how many rows the tasks table would show, so --once can size itself to fit them all.
func (m Model) RowCount() int { return len(m.rows()) }

// Red reports whether anything on the screen is red: an invalid task, a blocker
// that will never clear, or a stuck flow whose wait stands at a dead end.
func (m Model) Red() bool {
	return (m.snap.Tracker != nil && m.snap.Tracker.Red()) || m.flows.Red()
}

type tickMsg time.Time
type slowTickMsg time.Time
type loadedMsg Snapshot
type flowsMsg flows.Result
type sessionsMsg Sessions
type traceMsg struct {
	id   string
	text string
	err  string
}

func (m Model) tick() tea.Cmd {
	return tea.Tick(m.opts.Interval, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func (m Model) slowTick() tea.Cmd {
	return tea.Tick(m.opts.SlowInterval, func(t time.Time) tea.Msg { return slowTickMsg(t) })
}

func (m Model) load() tea.Cmd {
	opts, prev := m.opts, m.snap
	return func() tea.Msg { return loadedMsg(Load(opts, prev)) }
}

// loadSlow polls flow and pod, two commands that come back on their own.
func (m *Model) loadSlow() tea.Cmd {
	mapPath, now := m.snap.MapPath, m.opts.Now
	m.slowPending = 2
	m.slowStarted = true
	return tea.Batch(
		func() tea.Msg { return flowsMsg(LoadFlows(mapPath, now())) },
		func() tea.Msg { return sessionsMsg(LoadSessions(mapPath, now())) },
	)
}

func (m Model) loadTrace(id string) tea.Cmd {
	mapPath := m.snap.MapPath
	return func() tea.Msg {
		text, err := flows.Trace(mapPath, id)
		msg := traceMsg{id: id, text: text}
		if err != nil {
			msg.err = err.Error()
		}
		return msg
	}
}

// project is the directory the scripts run in and reactor reads.
func (m Model) project() string {
	if m.opts.Project != "" {
		return m.opts.Project
	}
	return discover.Project(discover.Env{}, m.snap.MapPath, m.opts.TasksDir, m.opts.Cwd)
}

// Init takes the first snapshot and starts both clocks; the sibling polls start once the map is known.
func (m Model) Init() tea.Cmd {
	m.loading = true
	return tea.Batch(m.load(), m.tick(), m.slowTick())
}

// Update is the event loop.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		if !m.split() {
			m.focus = focusLeft
		}
		m.clamp()
		return m, nil
	case tickMsg:
		if m.loading {
			return m, m.tick()
		}
		m.loading = true
		return m, tea.Batch(m.load(), m.tick())
	case slowTickMsg:
		if m.slowPending > 0 || !m.slowStarted {
			return m, m.slowTick()
		}
		return m, tea.Batch(m.loadSlow(), m.slowTick())
	case loadedMsg:
		m.snap = Snapshot(msg)
		m.loading = false
		if m.detail != nil && m.snap.Tracker != nil {
			// Keep the open task current, or close it if it went away.
			m.detail = m.snap.Tracker.BySlug(m.detail.Slug)
		}
		m.clamp()
		if !m.slowStarted {
			return m, m.loadSlow()
		}
		return m, nil
	case flowsMsg:
		m.slowPending--
		r := flows.Result(msg)
		if r.Failed && (len(m.flows.Flows) > 0 || len(m.flows.Stuck) > 0) {
			// Keep the last answer, and say it is old.
			m.flows.Note, m.flows.Failed = r.Note, true
		} else {
			m.flows = r
		}
		m.clamp()
		return m, nil
	case sessionsMsg:
		m.slowPending--
		s := Sessions(msg)
		if s.Failed && len(m.sessions.Flows) > 0 {
			s.Flows, s.At = m.sessions.Flows, m.sessions.At
		}
		if s.Workspaces.Failed && len(m.sessions.Workspaces.Workspaces) > 0 {
			s.Workspaces.Workspaces, s.Workspaces.At = m.sessions.Workspaces.Workspaces, m.sessions.Workspaces.At
		}
		m.sessions = s
		m.clamp()
		return m, nil
	case traceMsg:
		if m.trace != nil && m.trace.id == msg.id {
			m.trace.text, m.trace.err, m.trace.loading = msg.text, msg.err, false
		}
		return m, nil
	case actionMsg:
		r := actions.Result(msg)
		m.notice = noticeLine(r.Command, r.Summary, m.width-1)
		m.noticeRed = !r.OK()
		return m, m.reload()
	case tea.KeyPressMsg:
		return m.key(msg)
	}
	return m, nil
}

// reload reads everything again, now: the tracker, and the sibling tools once the map is known.
func (m *Model) reload() tea.Cmd {
	var cmds []tea.Cmd
	if !m.loading {
		m.loading = true
		cmds = append(cmds, m.load())
	}
	if m.slowPending == 0 && m.slowStarted {
		cmds = append(cmds, m.loadSlow())
	}
	if m.trace != nil {
		m.trace.loading = true
		cmds = append(cmds, m.loadTrace(m.trace.id))
	}
	return tea.Batch(cmds...)
}

func (m Model) key(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	k := msg.String()
	if k == "ctrl+c" {
		return m, tea.Quit
	}
	m.notice, m.noticeRed = "", false
	if m.pending != nil {
		p := m.pending
		m.pending = nil
		if k == "y" {
			return m, func() tea.Msg { return actionMsg(p.run()) }
		}
		return m, nil
	}
	if m.edit != nil {
		return m.editKey(k)
	}
	if m.typing {
		switch k {
		case "esc":
			m.typing, m.filter = false, ""
		case "enter":
			m.typing = false
		case "backspace":
			if r := []rune(m.filter); len(r) > 0 {
				m.filter = string(r[:len(r)-1])
			}
		default:
			if msg.Text != "" {
				m.filter += msg.Text
			}
		}
		m.cursor, m.offset = 0, 0
		return m, nil
	}
	if m.help {
		switch k {
		case "q":
			return m, tea.Quit
		default:
			m.help = false
		}
		return m, nil
	}
	if m.trace != nil {
		switch k {
		case "q":
			return m, tea.Quit
		case "esc", "enter", "left", "h":
			m.trace, m.detailOff = nil, 0
		case "r":
			if !m.trace.loading {
				m.trace.loading = true
				return m, m.loadTrace(m.trace.id)
			}
		case "s":
			return m, m.reactorTick()
		default:
			m.scrollKey(k)
		}
		return m, nil
	}
	if m.detail != nil {
		switch k {
		case "q":
			return m, tea.Quit
		case "e":
			return m.openEditor(), nil
		case "a":
			return m.offerStart(), nil
		case "s":
			return m, m.reactorTick()
		case "esc", "enter", "left", "h":
			m.detail, m.detailOff = nil, 0
		default:
			m.scrollKey(k)
		}
		return m, nil
	}
	if m.split() && m.focus == focusRight {
		switch k {
		case "esc", "left", "h":
			m.focus = focusLeft
			return m, nil
		case "up", "k", "down", "j", "pgup", "pgdown", "home", "g":
			m.scrollKey(k)
			return m, nil
		}
	}
	switch k {
	case "q":
		return m, tea.Quit
	case "?":
		m.help = true
	case "1", "2", "3":
		m.switchPane(pane(k[0] - '1'))
	case "e":
		return m.openEditor(), nil
	case "a":
		return m.offerStart(), nil
	case "c":
		return m.offerCancel(), nil
	case "s":
		return m, m.reactorTick()
	case "p":
		if m.pane == paneTasks {
			m.panelOff = !m.panelOff
			if !m.split() {
				m.focus = focusLeft
			}
		}
	case "tab":
		if m.split() {
			if m.focus == focusLeft {
				m.focus = focusRight
			} else {
				m.focus = focusLeft
			}
		}
	case "esc":
		m.filter = ""
		m.cursor, m.offset, m.detailOff = 0, 0, 0
	case "up", "k":
		m.cursor--
		m.detailOff = 0
	case "down", "j":
		m.cursor++
		m.detailOff = 0
	case "pgup":
		m.cursor -= m.bodyHeight()
		m.detailOff = 0
	case "pgdown":
		m.cursor += m.bodyHeight()
		m.detailOff = 0
	case "home", "g":
		m.cursor = 0
		m.detailOff = 0
	case "end", "G":
		m.cursor = m.rowCount() - 1
		m.detailOff = 0
	case "enter", "right", "l":
		return m.open()
	case "b":
		if m.pane == paneTasks {
			m.active = !m.active
			m.cursor, m.offset, m.detailOff = 0, 0, 0
		}
	case "S":
		if m.pane == paneTasks {
			m.sortBy = (m.sortBy + 1) % sortCount
			m.cursor, m.offset, m.detailOff = 0, 0, 0
		}
	case "/":
		m.typing = true
	case "+":
		m.opts.Interval = min(60*time.Second, m.opts.Interval+time.Second)
	case "-":
		m.opts.Interval = max(time.Second, m.opts.Interval-time.Second)
	case "r":
		return m, m.reload()
	}
	m.clamp()
	return m, nil
}

// scrollKey moves a body: a task's, the split pane's, or a trace's.
func (m *Model) scrollKey(k string) {
	switch k {
	case "up", "k":
		m.detailOff = max(0, m.detailOff-1)
	case "down", "j":
		m.detailOff++
	case "pgup":
		m.detailOff = max(0, m.detailOff-m.bodyHeight())
	case "pgdown":
		m.detailOff += m.bodyHeight()
	case "home", "g":
		m.detailOff = 0
	}
}

func (m *Model) switchPane(p pane) {
	if p < 0 || p >= paneCount || p == m.pane {
		return
	}
	m.pane = p
	m.cursor, m.offset, m.detailOff = 0, 0, 0
	m.filter, m.typing = "", false
	m.focus = focusLeft
}

// open is Enter: a task full width, or a flow's trace.
func (m Model) open() (tea.Model, tea.Cmd) {
	switch m.pane {
	case paneTasks:
		if rows := m.rows(); len(rows) > 0 {
			t := rows[m.cursor]
			m.detail, m.detailOff = &t, 0
		}
	case paneFlows:
		if rows := m.stuckRows(); len(rows) > 0 {
			return m.openTrace(rows[m.cursor].Flow.ID)
		}
	case paneSessions:
		if rows := m.sessionRows(); len(rows) > 0 {
			return m.openTrace(rows[m.cursor].ID)
		}
	}
	return m, nil
}

func (m Model) openTrace(id string) (tea.Model, tea.Cmd) {
	m.trace = &traceView{id: id, loading: true}
	m.detailOff = 0
	return m, m.loadTrace(id)
}

// selected is the task the keys act on: the one opened full width, else the one under the cursor in the tasks pane.
func (m Model) selected() *tracker.Task {
	if m.detail != nil {
		return m.detail
	}
	if m.pane != paneTasks {
		return nil
	}
	if rows := m.rows(); len(rows) > 0 && m.cursor < len(rows) {
		t := rows[m.cursor]
		return &t
	}
	return nil
}

// selectedSession is the session under the cursor in the sessions pane.
func (m Model) selectedSession() *flows.Flow {
	if m.pane != paneSessions {
		return nil
	}
	if rows := m.sessionRows(); len(rows) > 0 && m.cursor < len(rows) {
		f := rows[m.cursor]
		return &f
	}
	return nil
}

func (m Model) openEditor() Model {
	t := m.selected()
	if t == nil {
		return m
	}
	e := &editor{slug: t.Slug}
	e.status = indexOf(tracker.Statuses, t.Status)
	if e.status < 0 {
		e.status = indexOf(tracker.Statuses, "todo")
	}
	e.priority = max(0, indexOf(priorityChoices, t.Priority))
	e.orig = [2]int{e.status, e.priority}
	m.edit = e
	return m
}

// offerStart is a: `flow start session` for the task under the cursor, linked to
// the actor its territories route to and the map's repository, shown on the
// bar until y. A task that routes nowhere, or to two actors, is a human's to
// start, and the bar says so instead.
func (m Model) offerStart() Model {
	t := m.selected()
	if t == nil {
		return m
	}
	say := func(s string) Model { m.notice = "a: " + s; return m }
	if !t.Valid() {
		return say(t.Slug + " is not a valid task file; fix it first")
	}
	if len(t.Territories) == 0 {
		return say(t.Slug + " has no territory, so no actor to start")
	}
	if m.snap.Owners.Owners == nil {
		return say("no owners to route by (" + orDash(m.snap.Owners.Note) + ")")
	}
	actor := m.snap.Owners.Owners.RoutesTo(t.Territories)
	if strings.Contains(actor, "?") {
		return say(t.Slug + " names a territory the map does not declare")
	}
	if strings.Contains(actor, ",") {
		return say(t.Slug + " routes to " + actor + "; a task routed to two actors is left for a human")
	}
	if len(m.snap.Owners.Repos) == 0 {
		return say("the map declares no repository to link (or architect check could not read it)")
	}
	repo := m.snap.Owners.Repos[0]
	project, mapPath, slug := m.project(), m.snap.MapPath, t.Slug
	m.pending = &pending{
		command: "flow " + strings.Join(actions.StartSessionCommand(mapPath, slug, actor, repo), " "),
		run:     func() actions.Result { return actions.StartSession(project, mapPath, slug, actor, repo) },
	}
	return m
}

// offerCancel is c: the project's own cancel script on the session under the cursor, shown until y.
func (m Model) offerCancel() Model {
	f := m.selectedSession()
	if f == nil {
		return m
	}
	if f.Terminal {
		m.notice = "c: " + f.ID + " is " + f.State + " already"
		return m
	}
	project := m.project()
	if !actions.HasCancelScript(project) {
		m.notice = "c: no cancel script (" + project + "/" + actions.CancelScript + ")"
		return m
	}
	id := f.ID
	m.pending = &pending{
		command: actions.CancelScript + " " + id,
		run:     func() actions.Result { return actions.CancelSession(project, id) },
	}
	return m
}

// reactorTick is s: one tick of the daemon, run at once, its outcome on the bar.
func (m Model) reactorTick() tea.Cmd {
	project := m.project()
	return func() tea.Msg { return actionMsg(actions.ReactorTick(project)) }
}

func indexOf(list []string, v string) int {
	for i, x := range list {
		if x == v {
			return i
		}
	}
	return -1
}

// apply runs tasks for the editor's change, off the event loop.
func (m Model) apply() tea.Cmd {
	dir, slug, c := m.opts.TasksDir, m.edit.slug, m.edit.change()
	return func() tea.Msg { return actionMsg(actions.SetTask(dir, slug, c)) }
}

// rows is what the tasks table shows: every task unless b narrows it to the active ones, then the filter, in the chosen order.
func (m Model) rows() []tracker.Task {
	if m.snap.Tracker == nil {
		return nil
	}
	var out []tracker.Task
	needle := strings.ToLower(m.filter)
	for _, t := range m.snap.Tracker.Tasks {
		if m.active && t.Valid() && !tracker.WorkingSet[t.Status] {
			continue
		}
		if needle != "" && !matches(t, needle) {
			continue
		}
		out = append(out, t)
	}
	switch m.sortBy {
	case sortAge:
		sort.SliceStable(out, func(i, j int) bool { return out[i].ModifiedAt > out[j].ModifiedAt })
	case sortSlug:
		sort.SliceStable(out, func(i, j int) bool { return out[i].Slug < out[j].Slug })
	case sortTerritory:
		sort.SliceStable(out, func(i, j int) bool {
			a, b := strings.Join(out[i].Territories, ","), strings.Join(out[j].Territories, ",")
			if (a == "") != (b == "") {
				return a != ""
			}
			return a < b
		})
	}
	return out
}

// stuckRows is what the flows table shows: the stuck report, filtered.
func (m Model) stuckRows() []flows.Stuck {
	needle := strings.ToLower(m.filter)
	if needle == "" {
		return m.flows.Stuck
	}
	var out []flows.Stuck
	for _, s := range m.flows.Stuck {
		hay := strings.ToLower(flowText(s.Flow) + " " + m.stuckWaits(s))
		if strings.Contains(hay, needle) {
			out = append(out, s)
		}
	}
	return out
}

func (m Model) stuckWaits(s flows.Stuck) string {
	byID := flows.Index(m.flows.Flows)
	stands, _ := s.Stands(byID)
	return s.WaitsOn(byID) + " " + stands
}

// sessionRows is what the sessions table shows: the session flows as flow lists them, filtered.
func (m Model) sessionRows() []flows.Flow {
	needle := strings.ToLower(m.filter)
	if needle == "" {
		return m.sessions.Flows
	}
	var out []flows.Flow
	for _, f := range m.sessions.Flows {
		if strings.Contains(strings.ToLower(flowText(f)), needle) {
			out = append(out, f)
		}
	}
	return out
}

func flowText(f flows.Flow) string {
	parts := []string{f.ID, f.Definition, f.State}
	for n, v := range f.Links {
		parts = append(parts, n+"="+v)
	}
	return strings.Join(parts, " ")
}

// rowCount is how many rows the current pane's table has.
func (m Model) rowCount() int {
	switch m.pane {
	case paneFlows:
		return len(m.stuckRows())
	case paneSessions:
		return len(m.sessionRows())
	}
	return len(m.rows())
}

func matches(t tracker.Task, needle string) bool {
	hay := strings.ToLower(strings.Join(append([]string{t.Slug, t.Title, t.Status, t.Priority}, t.Territories...), " "))
	return strings.Contains(hay, needle)
}

func (m *Model) clamp() {
	n := m.rowCount()
	if m.cursor > n-1 {
		m.cursor = n - 1
	}
	if m.cursor < 0 {
		m.cursor = 0
	}
	h := m.bodyHeight()
	if h < 1 {
		h = 1
	}
	if m.cursor < m.offset {
		m.offset = m.cursor
	}
	if m.cursor >= m.offset+h {
		m.offset = m.cursor - h + 1
	}
	if m.offset < 0 {
		m.offset = 0
	}
}

// regionHeight is the height the pane with the table gets: the screen less the
// header, the key bar, the other two panes' lines, and the editor.
func (m Model) regionHeight() int {
	h := m.height - 2 - int(paneCount-1)
	if m.edit != nil {
		h -= 3
	}
	return max(1, h)
}

// bodyHeight is how many table rows fit in the current pane: its region less
// the title, the column header, the filter line, and what sits under the rows -
// the open-flows summary, or the workspaces.
func (m Model) bodyHeight() int {
	h := m.regionHeight() - 2
	if m.typing || m.filter != "" {
		h--
	}
	switch m.pane {
	case paneFlows:
		h -= m.summaryHeight()
	case paneSessions:
		h -= m.workspacesHeight()
	}
	return h
}

// summaryHeight is the rule and one line per definition with open flows, or one line saying none.
func (m Model) summaryHeight() int {
	n := 0
	for _, d := range flows.Count(m.flows.Flows) {
		if d.Open > 0 {
			n++
		}
	}
	return 1 + max(1, n)
}

// workspacesHeight is the rule and the workspaces, capped at a third of the region so the sessions keep their rows.
func (m Model) workspacesHeight() int {
	return 1 + m.workspacesShown()
}

func (m Model) workspacesShown() int {
	n := len(m.sessions.Workspaces.Workspaces)
	if n == 0 {
		return 1
	}
	return min(n, max(1, m.regionHeight()/3))
}

// editKey drives the editor: ← → along a row, ↑ ↓ between rows, Enter applies, Esc cancels.
func (m Model) editKey(k string) (tea.Model, tea.Cmd) {
	e := m.edit
	rowLen := []int{len(tracker.Statuses), len(priorityChoices)}
	cur := []*int{&e.status, &e.priority}[e.row]
	switch k {
	case "q":
		return m, tea.Quit
	case "esc":
		m.edit = nil
	case "up", "k", "down", "j", "tab":
		e.row = 1 - e.row
	case "left", "h":
		*cur = (*cur + rowLen[e.row] - 1) % rowLen[e.row]
	case "right", "l":
		*cur = (*cur + 1) % rowLen[e.row]
	case "home", "g":
		*cur = 0
	case "end", "G":
		*cur = rowLen[e.row] - 1
	case "enter":
		if !e.changed() {
			m.edit = nil
			return m, nil
		}
		cmd := m.apply()
		m.edit = nil
		return m, cmd
	default:
		// A digit picks directly: 1-7 for status, 1-5 for priority.
		if len(k) == 1 && k[0] >= '1' && int(k[0]-'1') < rowLen[e.row] {
			*cur = int(k[0] - '1')
		}
	}
	return m, nil
}

// noticeLine is "command  →  outcome", with the command cut from the middle when the
// line is too long: the outcome is what the person is waiting to read.
func noticeLine(command, outcome string, width int) string {
	return fitLine(command, "  →  ", outcome, width)
}

// fitLine joins a command and what follows it, cutting the command from the
// middle when the line is too long, since its ends are what identify it.
func fitLine(command, sep, outcome string, width int) string {
	if len([]rune(command))+len([]rune(sep))+len([]rune(outcome)) <= width {
		return command + sep + outcome
	}
	room := width - len([]rune(sep)) - len([]rune(outcome))
	if room < 16 {
		return command + sep + outcome // nothing sensible to cut; the screen truncates the tail
	}
	r := []rune(command)
	head := (room - 1) / 2
	return string(r[:head]) + "…" + string(r[len(r)-(room-1-head):]) + sep + outcome
}

// Package ui is the screen: an htop-shaped view over the tracker, the flows,
// the container and the reactor, each pane refreshed on its own clock, holding
// nothing but the last thing it read.
package ui

import (
	"sort"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/smailq/heai-tools/tools/operator/internal/discover"
	"github.com/smailq/heai-tools/tools/operator/internal/flows"
	"github.com/smailq/heai-tools/tools/operator/internal/owners"
	"github.com/smailq/heai-tools/tools/operator/internal/pod"
	"github.com/smailq/heai-tools/tools/operator/internal/reactor"
	"github.com/smailq/heai-tools/tools/operator/internal/tracker"
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
	// SlowInterval is the clock for the panes that ask a sibling CLI: flows, pod and reactor.
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

// LoadPod asks pod for the container's status and, when it is up, its workspaces.
func LoadPod(project string, now time.Time) pod.Result { return pod.Poll(project, now) }

// LoadReactor asks reactor for its sources and rules and the last hour's events.
func LoadReactor(project string, now time.Time) reactor.Result { return reactor.Poll(project, now) }

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

// pane is which of the four has the table; the other three are one line each.
type pane int

const (
	paneTasks pane = iota
	paneFlows
	panePod
	paneReactor
	paneCount
)

var paneNames = []string{"tasks", "flows", "pod", "reactor"}

// Model is the Bubble Tea model.
type Model struct {
	opts    Options
	snap    Snapshot
	flows   flows.Result
	pod     pod.Result
	reactor reactor.Result
	width   int
	height  int

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
	// panelOff hides the detail pane beside the tasks and flows lists; p toggles it, and the list takes the whole width.
	panelOff bool

	// detail is a task opened full width; detailOff scrolls its body, the split pane's, and a trace.
	detail    *tracker.Task
	detailOff int
	// wsDetail is a workspace opened full width; evDetail an event with the actions it caused.
	wsDetail *pod.Workspace
	evDetail *reactor.Event
	// trace is a flow's timeline opened full width, from `flow trace <id>`.
	trace *traceView
	// panelTrace is the same timeline for the flow under the cursor, shown in the flow
	// pane beside the list; traceStale marks it for a reread on the next poll.
	panelTrace *traceView
	traceStale bool
}

// traceView is one flow's timeline: `flow trace <id>` as flow printed it for the whole
// screen, or the lines `--json` gives for the flow pane, or why neither could be read.
type traceView struct {
	id      string
	text    string
	lines   []flows.TraceLine
	err     string
	loading bool
}

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

// WithPod seeds the pod pane, for --once and for tests.
func (m Model) WithPod(r pod.Result) Model { m.pod = r; return m }

// WithReactor seeds the reactor pane, for --once and for tests.
func (m Model) WithReactor(r reactor.Result) Model { m.reactor = r; return m }

// WithSize sets the terminal size, for --once and for tests.
func (m Model) WithSize(w, h int) Model { m.width, m.height = w, h; return m }

// WithActive narrows the list to the working set, for --once --active.
func (m Model) WithActive() Model { m.active = true; return m }

// Flows is the flows pane's last answer, for --json.
func (m Model) Flows() flows.Result { return m.flows }

// Project is the project directory pod and reactor are asked about, for --once and --json.
func (m Model) Project() string { return m.project() }

// OnceHeight is tall enough for every task row: the header, the pane title, the
// column header, the rows, the other panes' lines, and the key bar.
func (m Model) OnceHeight() int { return len(m.rows()) + 4 + int(paneCount-1) }

// Red reports whether anything on the screen is red: an invalid task, a blocker
// that will never clear, a stuck flow whose wait stands at a dead end, or a
// reactor rule that ran and failed in the last hour.
func (m Model) Red() bool {
	return (m.snap.Tracker != nil && m.snap.Tracker.Red()) || m.flows.Red() || m.reactor.Red()
}

type tickMsg time.Time
type slowTickMsg time.Time
type loadedMsg Snapshot
type flowsMsg flows.Result
type podMsg pod.Result
type reactorMsg reactor.Result
type traceMsg struct {
	id    string
	text  string
	lines []flows.TraceLine
	// panel says the answer is the flow pane's, read as JSON, not the whole screen's text.
	panel bool
	err   string
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

// loadSlow polls flow, pod and reactor, three commands that come back on their own.
func (m *Model) loadSlow() tea.Cmd {
	mapPath, project, now := m.snap.MapPath, m.project(), m.opts.Now
	m.slowPending = 3
	m.slowStarted = true
	return tea.Batch(
		func() tea.Msg { return flowsMsg(LoadFlows(mapPath, now())) },
		func() tea.Msg { return podMsg(LoadPod(project, now())) },
		func() tea.Msg { return reactorMsg(LoadReactor(project, now())) },
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

// loadPanelLines reads the same timeline as JSON, for the pane beside the list, which
// shows the moves themselves rather than flow's printed line.
func (m Model) loadPanelLines(id string) tea.Cmd {
	mapPath := m.snap.MapPath
	return func() tea.Msg {
		t, err := flows.TraceJSON(mapPath, id)
		msg := traceMsg{id: id, lines: t.Lines, panel: true}
		if err != nil {
			msg.err = err.Error()
		}
		return msg
	}
}

// project is the project directory pod and reactor are asked about.
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

// Update is the event loop; the flow pane's trace is kept in step after every message.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	next, cmd := m.update(msg)
	mm := next.(Model)
	if c := mm.syncPanelTrace(); c != nil {
		return mm, tea.Batch(cmd, c)
	}
	return mm, cmd
}

// syncPanelTrace asks flow for the trace of the flow under the cursor when the flow
// pane shows another one, or when a poll has since moved the flows on.
func (m *Model) syncPanelTrace() tea.Cmd {
	if m.pane != paneFlows || !m.split() || m.trace != nil {
		return nil
	}
	rows := m.flowRows()
	if len(rows) == 0 || m.cursor >= len(rows) {
		m.panelTrace, m.traceStale = nil, false
		return nil
	}
	id := rows[m.cursor].ID
	switch {
	case m.panelTrace == nil || m.panelTrace.id != id:
		m.panelTrace = &traceView{id: id, loading: true}
	case m.traceStale && !m.panelTrace.loading:
		m.panelTrace.loading = true
	default:
		return nil
	}
	m.traceStale = false
	return m.loadPanelLines(id)
}

func (m Model) update(msg tea.Msg) (tea.Model, tea.Cmd) {
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
		m.traceStale = true
		m.clamp()
		return m, nil
	case podMsg:
		m.slowPending--
		r := pod.Result(msg)
		if r.Failed && m.pod.Status != nil {
			// Keep the last answer, and say it is old.
			m.pod.Note, m.pod.Failed = r.Note, true
		} else {
			m.pod = r
		}
		if m.wsDetail != nil {
			// Keep the open workspace current, or close it if it went away.
			m.wsDetail = m.workspaceByID(m.wsDetail.ID)
		}
		m.clamp()
		return m, nil
	case reactorMsg:
		m.slowPending--
		r := reactor.Result(msg)
		if r.Failed && m.reactor.Status != nil {
			m.reactor.Note, m.reactor.Failed = r.Note, true
		} else {
			m.reactor = r
		}
		if m.evDetail != nil {
			// Keep the open event current; one that aged out of the hour stays as it was read.
			if e := m.eventByID(m.evDetail.ID); e != nil {
				m.evDetail = e
			}
		}
		m.clamp()
		return m, nil
	case traceMsg:
		if !msg.panel && m.trace != nil && m.trace.id == msg.id {
			m.trace.text, m.trace.err, m.trace.loading = msg.text, msg.err, false
		}
		if msg.panel && m.panelTrace != nil && m.panelTrace.id == msg.id {
			m.panelTrace.lines, m.panelTrace.err, m.panelTrace.loading = msg.lines, msg.err, false
		}
		return m, nil
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
	m.traceStale = true
	return tea.Batch(cmds...)
}

func (m Model) key(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	k := msg.String()
	if k == "ctrl+c" {
		return m, tea.Quit
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
		default:
			m.scrollKey(k)
		}
		return m, nil
	}
	if m.inDetail() {
		switch k {
		case "q":
			return m, tea.Quit
		case "esc", "enter", "left", "h":
			m.closeDetail()
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
	case "1", "2", "3", "4":
		m.switchPane(pane(k[0] - '1'))
	case "p":
		if m.pane == paneTasks || m.pane == paneFlows {
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
	case "right", "l":
		// The pane beside the list comes first - it holds the task, or the flow with
		// its trace - and only from there does the whole screen open.
		if m.split() && m.focus == focusLeft {
			m.focus = focusRight
			return m, nil
		}
		return m.open()
	case "enter":
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

// inDetail reports whether something is open full width: a task, a workspace or an event.
func (m Model) inDetail() bool { return m.detail != nil || m.wsDetail != nil || m.evDetail != nil }

func (m *Model) closeDetail() {
	m.detail, m.wsDetail, m.evDetail, m.detailOff = nil, nil, nil, 0
}

// scrollKey moves a body: a task's, the split pane's, a workspace's, an event's, or a trace's.
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

// open is Enter: a task full width, a flow's trace, a workspace, or an event with its actions.
func (m Model) open() (tea.Model, tea.Cmd) {
	switch m.pane {
	case paneTasks:
		if rows := m.rows(); len(rows) > 0 {
			t := rows[m.cursor]
			m.detail, m.detailOff = &t, 0
		}
	case panePod:
		if rows := m.podRows(); len(rows) > 0 {
			w := rows[m.cursor]
			m.wsDetail, m.detailOff = &w, 0
		}
	case paneReactor:
		if rows := m.eventRows(); len(rows) > 0 {
			e := rows[m.cursor]
			m.evDetail, m.detailOff = &e, 0
		}
	case paneFlows:
		if rows := m.flowRows(); len(rows) > 0 {
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

// flowRows is what the flows table shows: every flow as flow lists them, filtered.
func (m Model) flowRows() []flows.Flow {
	list := m.flows.Flows
	if needle := strings.ToLower(m.filter); needle != "" {
		var keep []flows.Flow
		for _, f := range list {
			if strings.Contains(strings.ToLower(flowText(f)), needle) {
				keep = append(keep, f)
			}
		}
		list = keep
	}
	return list
}

// podRows is what the pod table shows: the workspaces as pod lists them, filtered.
func (m Model) podRows() []pod.Workspace {
	needle := strings.ToLower(m.filter)
	if needle == "" {
		return m.pod.Workspaces
	}
	var out []pod.Workspace
	for _, w := range m.pod.Workspaces {
		hay := strings.ToLower(strings.Join([]string{w.ID, w.Label, w.Repo, w.Branch, w.Actor, w.Status, w.AgentText()}, " "))
		if strings.Contains(hay, needle) {
			out = append(out, w)
		}
	}
	return out
}

func (m Model) workspaceByID(id string) *pod.Workspace {
	for i := range m.pod.Workspaces {
		if m.pod.Workspaces[i].ID == id {
			return &m.pod.Workspaces[i]
		}
	}
	return nil
}

// eventRows is what the reactor table shows: the last hour's events, newest first, filtered by their text and their actions'.
func (m Model) eventRows() []reactor.Event {
	needle := strings.ToLower(m.filter)
	if needle == "" {
		return m.reactor.Events
	}
	var out []reactor.Event
	for _, e := range m.reactor.Events {
		parts := []string{e.ID, e.Source, e.Kind, e.Key}
		for _, a := range e.Actions {
			parts = append(parts, a.Rule, a.Result())
		}
		if strings.Contains(strings.ToLower(strings.Join(parts, " ")), needle) {
			out = append(out, e)
		}
	}
	return out
}

func (m Model) eventByID(id string) *reactor.Event {
	for i := range m.reactor.Events {
		if m.reactor.Events[i].ID == id {
			return &m.reactor.Events[i]
		}
	}
	return nil
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
		return len(m.flowRows())
	case panePod:
		return len(m.podRows())
	case paneReactor:
		return len(m.eventRows())
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
// header, the key bar, and the other four panes' lines.
func (m Model) regionHeight() int {
	return max(1, m.height-2-int(paneCount-1))
}

// bodyHeight is how many table rows fit in the current pane: its region less
// the title, the column header, the filter line, and what sits around the rows -
// the reactor's sources and rules above.
func (m Model) bodyHeight() int {
	h := m.regionHeight() - 2
	if m.typing || m.filter != "" {
		h--
	}
	switch m.pane {
	case paneReactor:
		// The sources' header and rows, the rules' caption, header and rows, and the events' caption.
		h -= m.sourcesHeight() + m.rulesHeight() + 1
	}
	return h
}

// sourcesHeight is the column header and the sources shown.
func (m Model) sourcesHeight() int { return 1 + m.sourcesShown() }

// rulesHeight is the caption, the column header and the rules shown.
func (m Model) rulesHeight() int { return 2 + m.rulesShown() }

func (m Model) sourcesShown() int { s, _ := m.reactorBlocks(); return s }
func (m Model) rulesShown() int   { _, r := m.reactorBlocks(); return r }

// reactorBlocks is how many sources and rules the pane shows: every one when
// the region allows, else what is left after the six fixed lines and a few
// rows for the events, split between them with the rules yielding first.
func (m Model) reactorBlocks() (sources, rules int) {
	st := m.reactor.Status
	if st == nil {
		return 0, 0
	}
	room := m.regionHeight() - 6 - min(3, max(1, len(m.reactor.Events)))
	if m.typing || m.filter != "" {
		room--
	}
	rules = min(max(1, len(st.Rules)), max(1, room/2))
	sources = min(max(1, len(st.Sources)), max(1, room-rules))
	return sources, rules
}

// stuckOf is flow's stuck entry for an id, or nil when flow does not call it stuck.
func (m Model) stuckOf(id string) *flows.Stuck {
	for i := range m.flows.Stuck {
		if m.flows.Stuck[i].Flow.ID == id {
			return &m.flows.Stuck[i]
		}
	}
	return nil
}

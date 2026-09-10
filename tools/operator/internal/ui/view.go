package ui

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/smailq/heai-tools/tools/operator/internal/discover"
	"github.com/smailq/heai-tools/tools/operator/internal/flows"
	"github.com/smailq/heai-tools/tools/operator/internal/tracker"
	"github.com/smailq/heai-tools/tools/operator/internal/workspaces"
)

// View renders the screen in the alternate buffer.
func (m Model) View() tea.View {
	v := tea.NewView(m.Render())
	v.AltScreen = true
	v.WindowTitle = "operator"
	return v
}

// Render draws the whole screen at the model's size; --once prints this to stdout.
func (m Model) Render() string {
	// Before the first WindowSizeMsg the size is unknown; render something sane rather than nothing.
	if m.width < 20 {
		m.width = 20
	}
	if m.height < 3 {
		m.height = 3
	}
	st := newStyles(m.opts.Plain)
	lines := []string{m.header(st)}
	switch {
	case m.help:
		lines = append(lines, m.helpLines(st)...)
	case m.trace != nil:
		lines = append(lines, m.traceLines(st)...)
	case m.detail != nil:
		lines = append(lines, m.detailLines(st, m.detail, m.width, m.detailOff, m.fullHeight())...)
	default:
		// The three panes in a fixed order: the selected one is a table sized to its region, the others one line each.
		for p := paneTasks; p < paneCount; p++ {
			if p == m.pane {
				lines = append(lines, m.region(st, p)...)
			} else {
				lines = append(lines, m.paneLine(st, p))
			}
		}
	}
	// Pad to the height so the key bar sits on the last line, with the editor just above it.
	body := m.height - 1
	if m.edit != nil {
		body -= 3
	}
	for len(lines) < body {
		lines = append(lines, "")
	}
	if len(lines) > body {
		lines = lines[:body]
	}
	if m.edit != nil {
		lines = append(lines, m.editorLines(st)...)
	}
	switch {
	case m.pending != nil:
		lines = append(lines, " "+fitLine(m.pending.command, "   ", "y run · any other key cancels", m.width-1))
	case m.notice != "":
		n := " " + m.notice
		if m.noticeRed {
			n = st.red.Render(n)
		}
		lines = append(lines, n)
	default:
		lines = append(lines, m.keyBar(st))
	}
	for i, l := range lines {
		lines[i] = fit(l, m.width)
	}
	return strings.Join(lines, "\n")
}

// fullHeight is what a view that takes the whole screen may use: the height less the header, the bar, and the editor.
func (m Model) fullHeight() int {
	h := m.height - 2
	if m.edit != nil {
		h -= 3
	}
	return h
}

// region is the selected pane's table, padded or cut to exactly its region.
func (m Model) region(st styles, p pane) []string {
	var lines []string
	switch p {
	case paneTasks:
		if m.split() {
			lines = m.splitLines(st)
		} else {
			lines = m.tableLines(st, m.width)
		}
	case paneFlows:
		lines = m.flowsTable(st)
	case paneSessions:
		lines = m.sessionsTable(st)
	}
	h := m.regionHeight()
	for len(lines) < h {
		lines = append(lines, "")
	}
	if len(lines) > h {
		lines = lines[:h]
	}
	return lines
}

// ---- header -----------------------------------------------------------------

func (m Model) header(st styles) string {
	name := filepath.Base(discover.Root(m.opts.TasksDir))
	if m.opts.Project != "" {
		name = filepath.Base(m.opts.Project)
	}
	parts := []string{st.title.Render(" operator"), st.faint.Render(name)}
	if t := m.snap.Tracker; t != nil {
		c := t.Counts()
		parts = append(parts, fmt.Sprintf("tasks %d:", len(t.Tasks)))
		for _, s := range []string{"in-progress", "in-review", "blocked", "todo"} {
			label := map[string]string{"in-progress": "prog", "in-review": "review", "blocked": "blocked", "todo": "todo"}[s]
			n := fmt.Sprintf("%s %d", label, c[s])
			if c[s] > 0 {
				n = st.status(s).Render(n)
			} else {
				n = st.faint.Render(n)
			}
			parts = append(parts, n)
		}
	}
	if len(m.flows.Flows) > 0 {
		open := 0
		for _, d := range flows.Count(m.flows.Flows) {
			open += d.Open
		}
		meter := fmt.Sprintf("flows %d", open)
		if n := len(m.flows.Stuck); n > 0 {
			warn := fmt.Sprintf("⚠%d", n)
			if m.flows.Red() {
				warn = st.red.Render(warn)
			} else {
				warn = st.yellow.Render(warn)
			}
			meter += " " + warn
		}
		parts = append(parts, meter)
	}
	if len(m.sessions.Flows) > 0 {
		open := 0
		for _, f := range m.sessions.Flows {
			if !f.Terminal {
				open++
			}
		}
		parts = append(parts, fmt.Sprintf("sessions %d", open))
	}
	right := fmt.Sprintf("%s  %s", m.opts.Interval.Truncate(time.Second), m.opts.Now().Format("15:04:05"))
	if m.loading || m.slowPending > 0 {
		right = "· " + right
	}
	return spread(strings.Join(parts, "  "), right, m.width)
}

// ---- the one-line forms -----------------------------------------------------

// paneLine is a pane while another has the table: its name, its counts, and on the right the age of its data.
func (m Model) paneLine(st styles, p pane) string {
	var text, right string
	switch p {
	case paneTasks:
		text, right = m.tasksSummary(st)
	case paneFlows:
		text, right = m.flowsSummary(st), m.flowsAge(st)
	case paneSessions:
		text, right = m.sessionsSummary(st), m.sessionsAge(st)
	}
	left := " " + st.title.Render(pad(paneNames[p], 9)) + text
	// The age on the right is the honest part of the line; the counts yield to it.
	if room := m.width - lipgloss.Width(right) - 2; lipgloss.Width(left) > room {
		left = fit(left, max(12, room))
	}
	return spread(left, right, m.width)
}

func (m Model) tasksSummary(st styles) (string, string) {
	t := m.snap.Tracker
	if t == nil {
		if m.snap.Err != nil {
			return st.red.Render(m.snap.Err.Error()), ""
		}
		return st.faint.Render("loading…"), ""
	}
	c := t.Counts()
	var parts []string
	for _, s := range tracker.Statuses {
		n := fmt.Sprintf("%s %d", s, c[s])
		if c[s] > 0 {
			parts = append(parts, st.status(s).Render(n))
		} else {
			parts = append(parts, st.faint.Render(n))
		}
	}
	return fmt.Sprintf("%d   ", len(t.Tasks)) + strings.Join(parts, " · "), "items/ changed " + ago(t.Changed, m.opts.Now())
}

// flowsSummary is the stuck count first, then each definition's flows by state.
func (m Model) flowsSummary(st styles) string {
	if len(m.flows.Flows) == 0 {
		if m.flows.Note != "" {
			return st.faint.Render(m.flows.Note)
		}
		if m.flows.At.IsZero() {
			return st.faint.Render("asking…")
		}
		return st.faint.Render("no flows")
	}
	var parts []string
	if n := len(m.flows.Stuck); n > 0 {
		warn := fmt.Sprintf("⚠ %d stuck > 1h", n)
		if m.flows.Red() {
			warn = st.red.Render(warn)
		} else {
			warn = st.yellow.Render(warn)
		}
		parts = append(parts, warn)
	} else {
		parts = append(parts, st.faint.Render("nothing stuck"))
	}
	for _, d := range flows.Count(m.flows.Flows) {
		var states []string
		for _, s := range d.States {
			states = append(states, fmt.Sprintf("%s %d", s.State, s.Count))
		}
		parts = append(parts, fmt.Sprintf("%s %d (%s)", d.Definition, d.Total, strings.Join(states, " · ")))
	}
	return strings.Join(parts, "   ")
}

func (m Model) flowsAge(st styles) string {
	if m.flows.At.IsZero() || (len(m.flows.Flows) == 0 && m.flows.Note != "" && !m.flows.Failed) {
		return "" // never asked, or nothing to be old
	}
	age := "flow " + ago(m.flows.At, m.opts.Now())
	if m.flows.Failed {
		return st.red.Render("⚠ "+m.flows.Note) + " · as of " + m.flows.At.Format("15:04:05")
	}
	return age
}

// sessionsSummary is the sessions by state, then the workspaces by agent state.
func (m Model) sessionsSummary(st styles) string {
	var parts []string
	if len(m.sessions.Flows) == 0 {
		if m.sessions.Note != "" {
			parts = append(parts, st.faint.Render(m.sessions.Note))
		} else if m.sessions.At.IsZero() {
			parts = append(parts, st.faint.Render("asking…"))
		}
	} else {
		counts := map[string]int{}
		var order []string
		open := 0
		for _, f := range m.sessions.Flows {
			if counts[f.State] == 0 {
				order = append(order, f.State)
			}
			counts[f.State]++
			if !f.Terminal {
				open++
			}
		}
		var states []string
		for _, s := range order {
			states = append(states, st.flowState(s).Render(fmt.Sprintf("%s %d", s, counts[s])))
		}
		parts = append(parts, fmt.Sprintf("%d open of %d   %s", open, len(m.sessions.Flows), strings.Join(states, " · ")))
	}
	ws := m.sessions.Workspaces
	switch {
	case len(ws.Workspaces) > 0:
		var states []string
		for _, c := range workspaces.CountByState(ws.Workspaces) {
			states = append(states, st.flowState(c.State).Render(fmt.Sprintf("%s %d", c.State, c.Count)))
		}
		parts = append(parts, fmt.Sprintf("workspaces %d (%s)", len(ws.Workspaces), strings.Join(states, " · ")))
	case ws.Note != "":
		parts = append(parts, st.faint.Render("workspaces: "+ws.Note))
	case !ws.At.IsZero():
		parts = append(parts, st.faint.Render("no workspaces"))
	}
	return strings.Join(parts, "   ")
}

func (m Model) sessionsAge(st styles) string {
	if m.sessions.At.IsZero() || (len(m.sessions.Flows) == 0 && len(m.sessions.Workspaces.Workspaces) == 0 && !m.sessions.Failed && !m.sessions.Workspaces.Failed) {
		return "" // never asked, or nothing to be old
	}
	if m.sessions.Failed {
		return st.red.Render("⚠ "+m.sessions.Note) + " · as of " + m.sessions.At.Format("15:04:05")
	}
	if m.sessions.Workspaces.Failed {
		return st.red.Render("⚠ "+m.sessions.Workspaces.Note) + " · as of " + m.sessions.Workspaces.At.Format("15:04:05")
	}
	return "flow " + ago(m.sessions.At, m.opts.Now())
}

// ---- split ------------------------------------------------------------------

// splitAt is the width from which the task under the cursor is shown beside the list.
const splitAt = 100

// split reports whether the list and the task share the screen.
func (m Model) split() bool {
	return m.pane == paneTasks && !m.opts.NoSplit && !m.panelOff && m.width >= splitAt
}

// leftWidth is the list's share when split: a little over half, never starving the task of 40 columns.
func (m Model) leftWidth() int {
	return min(max(60, m.width*55/100), m.width-41)
}

// splitLines lays the list and the task side by side, a faint bar between them.
func (m Model) splitLines(st styles) []string {
	left := m.leftWidth()
	right := m.width - left - 1
	l := m.tableLines(st, left)
	var r []string
	if rows := m.rows(); len(rows) > 0 && m.cursor < len(rows) {
		r = m.detailLines(st, &rows[m.cursor], right, m.detailOff, m.regionHeight())
	} else {
		r = []string{paneTitle(st, "task", "", "", right), st.faint.Render(" (no task selected)")}
	}
	n := max(len(l), len(r), m.regionHeight())
	out := make([]string, 0, n)
	bar := st.faint.Render("│")
	if m.focus == focusRight {
		bar = st.title.Render("┃")
	}
	for i := 0; i < n; i++ {
		var a, b string
		if i < len(l) {
			a = l[i]
		}
		if i < len(r) {
			b = r[i]
		}
		out = append(out, padStyled(a, left)+bar+fit(b, right))
	}
	return out
}

// ---- tables -----------------------------------------------------------------

type column struct {
	name  string
	width int
	// dropBelow is the terminal width under which the column is dropped; 0 never drops.
	dropBelow int
}

// layout keeps the columns the width allows, gives the flexible one what the
// fixed ones leave, between lo and hi, and hands the rest to a trailing column
// named rest when at least minRest cells remain.
func layout(cols []column, width, flex, lo, hi, reserve, minRest int, rest string) []column {
	var kept []column
	used := 1 // leading space
	for _, c := range cols {
		if c.dropBelow > 0 && width < c.dropBelow {
			continue
		}
		kept = append(kept, c)
		used += c.width + 2
	}
	for i := range kept {
		if i == flex || (flex < 0 && kept[i].width == 0) {
			kept[i].width = max(lo, min(hi, width-used-reserve))
			used += kept[i].width
		}
	}
	if left := width - used; left >= minRest {
		kept = append(kept, column{rest, left, 0})
	}
	return kept
}

func (m Model) columns(width int) []column {
	cols := []column{
		{"status", 11, 0},
		{"pri", 6, 60},
		{"slug", 0, 0}, // flexible
		{"territory", 14, 80},
		{"routes to", 16, 95},
		{"age", 5, 110},
	}
	// The slug takes what the fixed columns leave, keeping room for a blocker note beside it.
	return layout(cols, width, -1, 20, 44, 26, 12, "")
}

func columnHeader(st styles, cols []column) string {
	var head []string
	for _, c := range cols {
		head = append(head, pad(c.name, c.width))
	}
	return st.faint.Render(" " + strings.Join(head, "  "))
}

func (m Model) filterLine() []string {
	if !m.typing && m.filter == "" {
		return nil
	}
	cursor := ""
	if m.typing {
		cursor = "▏"
	}
	return []string{" /" + m.filter + cursor}
}

func (m Model) tableLines(st styles, width int) []string {
	t := m.snap.Tracker
	if t == nil {
		msg := "loading…"
		if m.snap.Err != nil {
			msg = st.red.Render(m.snap.Err.Error())
		}
		return []string{paneTitle(st, "tasks", "", "", width), " " + msg}
	}
	rows := m.rows()
	set := "all"
	if m.active {
		set = "active"
	}
	if m.filter != "" {
		set += fmt.Sprintf(" · filter %q", m.filter)
	}
	left := fmt.Sprintf("%s %d of %d", set, len(rows), len(t.Tasks))
	if m.sortBy != sortPickup {
		left += " · by " + sortNames[m.sortBy]
	}
	right := "items/ changed " + ago(t.Changed, m.opts.Now())
	if m.snap.Owners.Note != "" {
		right = m.snap.Owners.Note + " · " + right
	}
	if t.ConfigErr != "" {
		right = st.red.Render(t.ConfigErr) + " · " + right
	}
	cols := m.columns(width)
	lines := []string{paneTitle(st, "tasks", left, right, width), columnHeader(st, cols)}
	h := m.bodyHeight()
	end := min(len(rows), m.offset+h)
	for i := m.offset; i < end; i++ {
		lines = append(lines, m.row(st, cols, rows[i], i == m.cursor, width))
	}
	if len(rows) == 0 {
		lines = append(lines, st.faint.Render(" (nothing to show)"))
	}
	return append(lines, m.filterLine()...)
}

func (m Model) row(st styles, cols []column, t tracker.Task, selected bool, width int) string {
	tr := m.snap.Tracker
	territory := strings.Join(t.Territories, ",")
	routes := m.snap.Owners.Owners.RoutesTo(t.Territories)
	if len(t.Territories) == 0 {
		routes = "(untriaged)"
	}
	note, noteRed := "", false
	if !t.Valid() {
		note, noteRed = "invalid: "+t.Problems[0], true
	} else if t.Status == "blocked" {
		switch state := tr.BlockerState(t); state {
		case "":
			note = "← (no blocker named)"
		case "missing":
			note, noteRed = "← "+t.Blocker+" (blocker missing)", true
		case "canceled":
			note, noteRed = "← "+t.Blocker+" (blocker canceled)", true
		case "done":
			note = "← " + t.Blocker + " (blocker done)"
		default:
			note = "← " + t.Blocker
		}
	}
	pri := t.Priority
	if pri == "" {
		pri = "-"
	}
	values := map[string]string{
		"status": t.Status, "pri": pri, "slug": t.Slug, "territory": orDash(territory),
		"routes to": orDash(routes), "age": ageDays(t.ModifiedAt, m.opts.Now()), "": note,
	}
	var cells []string
	for _, c := range cols {
		cell := pad(values[c.name], c.width)
		if !selected {
			switch {
			case !t.Valid():
				cell = st.red.Render(cell)
			case c.name == "status":
				cell = st.status(t.Status).Render(cell)
			case c.name == "pri":
				cell = st.priority(t.Priority).Render(cell)
			case c.name == "" && noteRed:
				cell = st.red.Render(cell)
			case c.name == "" && note != "":
				cell = st.yellow.Render(cell)
			case c.name == "routes to" && routes == "(untriaged)":
				cell = st.faint.Render(cell)
			}
		}
		cells = append(cells, cell)
	}
	return m.finishRow(st, " "+strings.Join(cells, "  "), selected, width)
}

// finishRow reverses the selected row, dimmer when the movement keys drive another pane.
func (m Model) finishRow(st styles, line string, selected bool, width int) string {
	if !selected {
		return line
	}
	sel := st.selected
	if m.split() && m.focus == focusRight {
		sel = st.faint.Reverse(true)
	}
	return sel.Render(pad(line, width))
}

// ---- flows ------------------------------------------------------------------

func (m Model) flowColumns(width int) []column {
	cols := []column{
		{"definition", 10, 0},
		{"state", 10, 0},
		{"id", 0, 0}, // flexible
		{"idle", 5, 70},
		{"waits on", 28, 90},
	}
	// The id takes what is left up to its full length; what remains is "stands".
	return layout(cols, width, -1, 16, 30, 10, 8, "stands")
}

// flowsTable is the stuck report as flow prints it, then every open flow by definition.
func (m Model) flowsTable(st styles) []string {
	width := m.width
	if len(m.flows.Flows) == 0 && len(m.flows.Stuck) == 0 {
		msg := m.flows.Note
		if msg == "" {
			msg = "asking flow…"
			if !m.flows.At.IsZero() {
				msg = "no flows"
			}
		}
		return []string{paneTitle(st, "flows", "", m.flowsAge(st), width), " " + st.faint.Render(msg)}
	}
	rows := m.stuckRows()
	open := 0
	for _, d := range flows.Count(m.flows.Flows) {
		open += d.Open
	}
	left := fmt.Sprintf("%d stuck older than 1h · %d open", len(m.flows.Stuck), open)
	if m.filter != "" {
		left = fmt.Sprintf("%d of %d stuck · filter %q · %d open", len(rows), len(m.flows.Stuck), m.filter, open)
	}
	cols := m.flowColumns(width)
	lines := []string{paneTitle(st, "flows", left, m.flowsAge(st), width), columnHeader(st, cols)}
	byID := flows.Index(m.flows.Flows)
	h := m.bodyHeight()
	end := min(len(rows), m.offset+h)
	for i := m.offset; i < end; i++ {
		lines = append(lines, m.stuckRow(st, cols, rows[i], byID, i == m.cursor, width))
	}
	if len(rows) == 0 {
		lines = append(lines, st.faint.Render(" nothing stuck for 1h or longer"))
	}
	lines = append(lines, m.filterLine()...)
	lines = append(lines, paneRule(st, " ── all open, by definition ", "", width))
	n := 0
	for _, d := range flows.Count(m.flows.Flows) {
		if d.Open == 0 {
			continue
		}
		n++
		var states []string
		for _, s := range d.States {
			if !s.Terminal {
				states = append(states, st.flowState(s.State).Render(fmt.Sprintf("%-10s %d", s.State, s.Count)))
			}
		}
		lines = append(lines, " "+pad(d.Definition, 12)+strings.Join(states, "   "))
	}
	if n == 0 {
		lines = append(lines, st.faint.Render(" (none open)"))
	}
	return lines
}

func (m Model) stuckRow(st styles, cols []column, s flows.Stuck, byID map[string]flows.Flow, selected bool, width int) string {
	stands, red := s.Stands(byID)
	values := map[string]string{
		"definition": s.Flow.Definition, "state": s.Flow.State, "id": s.Flow.ID,
		"idle": short(s.Idle()), "waits on": orDash(s.WaitsOn(byID)), "stands": orDash(stands),
	}
	var cells []string
	for _, c := range cols {
		cell := pad(values[c.name], c.width)
		if !selected {
			switch {
			case red:
				cell = st.red.Render(cell)
			case c.name == "state":
				cell = st.flowState(s.Flow.State).Render(cell)
			}
		}
		cells = append(cells, cell)
	}
	return m.finishRow(st, " "+strings.Join(cells, "  "), selected, width)
}

// ---- sessions ---------------------------------------------------------------

func (m Model) sessionColumns(width int) []column {
	cols := []column{
		{"id", 28, 0},
		{"actor", 14, 70},
		{"task", 0, 0}, // flexible
		{"state", 9, 0},
		{"age", 5, 100},
	}
	// The task takes what is left up to 30; what remains is the branch.
	return layout(cols, width, -1, 14, 30, 12, 10, "branch")
}

// sessionsTable is the session flows, and under them the container's workspaces.
func (m Model) sessionsTable(st styles) []string {
	width := m.width
	rows := m.sessionRows()
	var lines []string
	if len(m.sessions.Flows) == 0 {
		msg := m.sessions.Note
		if msg == "" {
			msg = "asking flow…"
		}
		lines = []string{paneTitle(st, "sessions", "", m.sessionsAge(st), width), " " + st.faint.Render(msg)}
		for len(lines) < m.regionHeight()-m.workspacesHeight() {
			lines = append(lines, "")
		}
	} else {
		open := 0
		for _, f := range m.sessions.Flows {
			if !f.Terminal {
				open++
			}
		}
		left := fmt.Sprintf("%d open of %d", open, len(m.sessions.Flows))
		if m.filter != "" {
			left = fmt.Sprintf("%d of %d · filter %q", len(rows), len(m.sessions.Flows), m.filter)
		}
		cols := m.sessionColumns(width)
		lines = []string{paneTitle(st, "sessions", left, m.sessionsAge(st), width), columnHeader(st, cols)}
		h := m.bodyHeight()
		end := min(len(rows), m.offset+h)
		for i := m.offset; i < end; i++ {
			lines = append(lines, m.sessionRow(st, cols, rows[i], i == m.cursor, width))
		}
		if len(rows) == 0 {
			lines = append(lines, st.faint.Render(" (nothing to show)"))
		}
		lines = append(lines, m.filterLine()...)
		for len(lines) < m.regionHeight()-m.workspacesHeight() {
			lines = append(lines, "")
		}
	}
	return append(lines, m.workspaceLines(st, width)...)
}

func (m Model) sessionRow(st styles, cols []column, f flows.Flow, selected bool, width int) string {
	values := map[string]string{
		"id": f.ID, "actor": orDash(f.Link("actor")), "task": orDash(f.Link("task")), "state": f.State,
		"age": short(m.opts.Now().Sub(f.SinceTime())), "branch": f.Link("branch"),
	}
	var cells []string
	for _, c := range cols {
		cell := pad(values[c.name], c.width)
		if !selected {
			switch {
			case f.Terminal:
				cell = st.faint.Render(cell)
			case c.name == "state":
				cell = st.flowState(f.State).Render(cell)
			}
		}
		cells = append(cells, cell)
	}
	return m.finishRow(st, " "+strings.Join(cells, "  "), selected, width)
}

// workspaceLines is the rule and the workspaces pod lists, or one line saying why there are none.
func (m Model) workspaceLines(st styles, width int) []string {
	ws := m.sessions.Workspaces
	shown := m.workspacesShown()
	caption := fmt.Sprintf(" ── workspaces %d · pod list ", len(ws.Workspaces))
	right := ""
	if len(ws.Workspaces) > shown {
		right = fmt.Sprintf("%d more", len(ws.Workspaces)-shown)
	}
	lines := []string{paneRule(st, caption, right, width)}
	if len(ws.Workspaces) == 0 {
		msg := ws.Note
		if msg == "" {
			msg = "no workspaces"
			if ws.At.IsZero() {
				msg = "asking…"
			}
		}
		return append(lines, " "+st.faint.Render(msg))
	}
	agentW := 22
	for _, w := range ws.Workspaces[:shown] {
		agent := strings.TrimSpace(w.Agent.Kind + " " + w.Agent.Name)
		state := st.flowState(w.Agent.State).Render(pad(orDash(w.Agent.State), 8))
		line := " " + pad(w.ID, 5) + "  " + pad(w.Label, 30) + "  " + pad(orDash(agent), agentW) + "  " + state
		if rest := width - lipgloss.Width(line) - 2; rest >= 10 {
			line += "  " + st.faint.Render(truncate(w.Branch, rest))
		}
		lines = append(lines, line)
	}
	return lines
}

// ---- detail -----------------------------------------------------------------

// detailLines is one task in full: its frontmatter as a table, then its body, within avail lines.
func (m Model) detailLines(st styles, t *tracker.Task, width, off, avail int) []string {
	tr := m.snap.Tracker
	title := fmt.Sprintf("%s · %s", t.Status, t.Slug)
	lines := []string{paneTitle(st, "task", title, "modified "+t.ModifiedAt, width)}
	kv := func(k, v string) string { return " " + st.faint.Render(pad(k, 12)) + v }
	for i, l := range wrap(t.Title, width-14) {
		if i == 0 {
			lines = append(lines, kv("title", l))
		} else {
			lines = append(lines, kv("", l))
		}
	}
	lines = append(lines, kv("status", st.status(t.Status).Render(t.Status)))
	lines = append(lines, kv("priority", orDash(t.Priority)))
	territory := orDash(strings.Join(t.Territories, ","))
	if routes := m.snap.Owners.Owners.RoutesTo(t.Territories); routes != "" {
		territory += st.faint.Render("  → " + routes)
	}
	lines = append(lines, kv("territory", territory))
	lines = append(lines, kv("created", t.CreatedAt), kv("modified", t.ModifiedAt))
	if t.Blocker != "" {
		state := tr.BlockerState(*t)
		b := t.Blocker + "  (" + state + ")"
		if state == "canceled" || state == "missing" {
			b = st.red.Render(b)
		}
		lines = append(lines, kv("blocked by", b))
	}
	if !t.Valid() {
		lines = append(lines, kv("problems", st.red.Render(strings.Join(t.Problems, "; "))))
	}
	lines = append(lines, kv("file", truncate(filepath.Join(tr.Dir, "items", t.Slug+".md"), width-14)))
	body := wrap(t.Body, width-2)
	off = min(off, max(0, len(body)-1))
	shown := body[off:]
	// Bound the body to what fits, so the pane can say what it left out.
	room := avail - len(lines) - 1
	more := ""
	if room > 0 && len(shown) > room {
		more = fmt.Sprintf(" · %d more", len(shown)-room)
		shown = shown[:room]
	}
	position := ""
	if off > 0 || more != "" {
		position = fmt.Sprintf("lines %d-%d of %d", off+1, off+len(shown), len(body))
	}
	lines = append(lines, paneRule(st, " ── body ", position+more, width))
	for _, l := range shown {
		lines = append(lines, " "+l)
	}
	return lines
}

// traceLines is `flow trace <id>` as flow printed it, scrolled by the movement keys.
func (m Model) traceLines(st styles) []string {
	tv := m.trace
	right := "flow trace " + tv.id
	if tv.loading {
		right = "· " + right
	}
	lines := []string{paneTitle(st, "trace", tv.id, right, m.width)}
	if tv.err != "" {
		return append(lines, " "+st.red.Render(tv.err))
	}
	if tv.text == "" {
		if tv.loading {
			return append(lines, " "+st.faint.Render("asking flow…"))
		}
		return append(lines, " "+st.faint.Render("(nothing to trace)"))
	}
	body := strings.Split(tv.text, "\n")
	off := min(m.detailOff, max(0, len(body)-1))
	shown := body[off:]
	room := m.fullHeight() - 1
	if room > 0 && len(shown) > room {
		shown = shown[:room]
	}
	if off > 0 || len(shown) < len(body) {
		lines[0] = paneTitle(st, "trace", tv.id, fmt.Sprintf("lines %d-%d of %d · %s", off+1, off+len(shown), len(body), right), m.width)
	}
	for _, l := range shown {
		lines = append(lines, " "+truncate(l, m.width-1))
	}
	return lines
}

// paneRule is a faint rule with a caption on the right, used under the properties.
func paneRule(st styles, caption, right string, width int) string {
	tail := ""
	if right != "" {
		tail = " " + right + " "
	}
	dashes := max(0, width-lipgloss.Width(caption)-lipgloss.Width(tail))
	return st.faint.Render(caption + strings.Repeat("─", dashes) + tail)
}

// ---- editor -----------------------------------------------------------------

// editorLines is the two rows of pills; the focused row's choice is reversed, the other's bracketed.
func (m Model) editorLines(st styles) []string {
	e := m.edit
	summary := ""
	if c := e.change(); c.Status != nil || c.Priority != nil {
		var parts []string
		if c.Status != nil {
			parts = append(parts, "status "+tracker.Statuses[e.orig[0]]+" → "+*c.Status)
		}
		if c.Priority != nil {
			parts = append(parts, "priority "+orDash(priorityChoices[e.orig[1]])+" → "+orDash(*c.Priority))
		}
		summary = strings.Join(parts, " · ")
	}
	lines := []string{paneTitle(st, "edit", e.slug+"  "+summary, "⏎ apply through tasks set · esc cancel", m.width)}
	pills := func(row int, choices []string, chosen int) string {
		var out []string
		for i, c := range choices {
			label := orDash(c)
			switch {
			case i == chosen && e.row == row:
				label = st.key.Render(" " + label + " ")
			case i == chosen:
				label = st.title.Render("[" + label + "]")
			default:
				label = " " + label + " "
			}
			out = append(out, label)
		}
		return strings.Join(out, " ")
	}
	name := func(row int, label string) string {
		if e.row == row {
			return st.title.Render(pad(label, 10))
		}
		return st.faint.Render(pad(label, 10))
	}
	lines = append(lines, " "+name(0, "status")+pills(0, tracker.Statuses, e.status))
	lines = append(lines, " "+name(1, "priority")+pills(1, priorityChoices, e.priority))
	return lines
}

// ---- help -------------------------------------------------------------------

func (m Model) helpLines(st styles) []string {
	lines := []string{paneTitle(st, "help", "", "", m.width)}
	keys := [][2]string{
		{"1 2 3", "the pane with the table: tasks, flows, sessions"},
		{"↑ ↓  j k", "move"}, {"pgup pgdn  g G", "page, first, last"},
		{"enter", "open: the task full width, or the flow's trace (flow trace <id>)"},
		{"p", "show or hide the task pane"}, {"tab", "focus the task pane, to scroll it"},
		{"e", "edit the task's status and priority (tasks set)"},
		{"a", "start a session on the task (flow start session, linked to task, actor and repo), after y"},
		{"c", "cancel the session (scripts/session/cancel.sh <id>), after y"},
		{"s", "one tick of the daemon (reactor tick)"},
		{"esc", "back, or clear the filter"}, {"b", "every status ↔ the active ones (in-progress, in-review, blocked, todo)"},
		{"S", "sort tasks: pick-up, age, slug, territory"}, {"/", "filter the pane as you type"},
		{"+ -", "the tracker's refresh interval"}, {"r", "reload now"}, {"?", "this help"}, {"q", "quit"},
	}
	for _, k := range keys {
		lines = append(lines, " "+st.title.Render(pad(k[0], 16))+k[1])
	}
	lines = append(lines, "", st.faint.Render(" where the numbers come from"))
	lines = append(lines, " "+pad("tracker", 16)+m.opts.TasksDir)
	lines = append(lines, " "+pad("map", 16)+orDash(m.snap.MapPath))
	lines = append(lines, " "+pad("project", 16)+m.project())
	owners := "architect territories --json · architect check --format json, when the map's mtime moves"
	if m.snap.Owners.Note != "" {
		owners += "  (" + m.snap.Owners.Note + ")"
	}
	lines = append(lines, " "+pad("routes to", 16)+owners)
	lines = append(lines, " "+pad("blocker", 16)+"the first `Blocked by [slug](slug.md)` in the body, and that task's status")
	flowsFrom := fmt.Sprintf("flow list --json · flow stuck --json, every %s", m.opts.SlowInterval)
	if m.flows.Note != "" {
		flowsFrom += "  (" + m.flows.Note + ")"
	}
	lines = append(lines, " "+pad("flows", 16)+flowsFrom)
	sessionsFrom := fmt.Sprintf("flow list session --json · pod list --json, every %s", m.opts.SlowInterval)
	if m.sessions.Workspaces.Note != "" {
		sessionsFrom += "  (" + m.sessions.Workspaces.Note + ")"
	}
	lines = append(lines, " "+pad("sessions", 16)+sessionsFrom)
	lines = append(lines, " "+pad("interval", 16)+m.opts.Interval.String()+" for the tracker")
	return lines
}

// ---- key bar ----------------------------------------------------------------

func (m Model) keyBar(st styles) string {
	var keys [][2]string
	scope := "active"
	if m.active {
		scope = "all"
	}
	common := [][2]string{{"1-3", "pane"}, {"s", "tick"}, {"/", "filter"}, {"+/-", "interval"}, {"r", "reload"}, {"?", "help"}, {"q", "quit"}}
	switch {
	case m.typing:
		keys = [][2]string{{"type", "to filter"}, {"enter", "keep"}, {"esc", "clear"}}
	case m.help:
		keys = [][2]string{{"any key", "back"}, {"q", "quit"}}
	case m.edit != nil:
		keys = [][2]string{{"←→", "choose"}, {"↑↓", "row"}, {"1-7", "pick"}, {"⏎", "apply"}, {"esc", "cancel"}}
	case m.trace != nil:
		keys = [][2]string{{"↑↓", "scroll"}, {"r", "reload"}, {"esc", "back"}, {"q", "quit"}}
	case m.detail != nil:
		keys = [][2]string{{"↑↓", "scroll"}, {"e", "edit"}, {"a", "start"}, {"esc", "back"}, {"q", "quit"}}
	case m.pane == paneFlows:
		keys = append([][2]string{{"↑↓", "move"}, {"⏎", "trace"}}, common...)
	case m.pane == paneSessions:
		keys = append([][2]string{{"↑↓", "move"}, {"⏎", "trace"}, {"c", "cancel"}}, common...)
	case m.split() && m.focus == focusRight:
		keys = [][2]string{{"↑↓", "scroll"}, {"⇥", "list"}, {"⏎", "expand"}, {"e", "edit"}, {"a", "start"}, {"p", "hide"}, {"esc", "list"}, {"?", "help"}, {"q", "quit"}}
	case m.split():
		keys = append([][2]string{{"↑↓", "move"}, {"⇥", "task"}, {"⏎", "expand"}, {"e", "edit"}, {"a", "start"}, {"p", "hide"}, {"b", scope}, {"S", "sort"}}, common...)
	case m.width >= splitAt && !m.opts.NoSplit:
		keys = append([][2]string{{"↑↓", "move"}, {"⏎", "open"}, {"e", "edit"}, {"a", "start"}, {"p", "task pane"}, {"b", scope}, {"S", "sort"}}, common...)
	default:
		keys = append([][2]string{{"↑↓", "move"}, {"⏎", "open"}, {"e", "edit"}, {"a", "start"}, {"b", scope}, {"S", "sort"}}, common...)
	}
	render := func(keys [][2]string) string {
		var parts []string
		for _, k := range keys {
			parts = append(parts, st.key.Render(k[0])+" "+k[1])
		}
		return " " + strings.Join(parts, "  ")
	}
	// On a narrow terminal the least-used keys leave the bar first; help and quit stay.
	for _, drop := range []string{"r", "+/-", "s", "1-3", "S", "b", "/", "p", "⇥", "a", "c", "e", "⏎"} {
		if lipgloss.Width(render(keys)) <= m.width {
			break
		}
		keys = without(keys, drop)
	}
	return render(keys)
}

func without(keys [][2]string, key string) [][2]string {
	var out [][2]string
	for _, k := range keys {
		if k[0] != key {
			out = append(out, k)
		}
	}
	return out
}

// ---- styles -----------------------------------------------------------------

type styles struct {
	plain                                    bool
	title, faint, red, yellow, key, selected lipgloss.Style
}

func newStyles(plain bool) styles {
	s := styles{plain: plain}
	if plain {
		return s
	}
	s.title = lipgloss.NewStyle().Bold(true)
	s.faint = lipgloss.NewStyle().Faint(true)
	s.red = lipgloss.NewStyle().Foreground(lipgloss.Red)
	s.yellow = lipgloss.NewStyle().Foreground(lipgloss.Yellow)
	s.key = lipgloss.NewStyle().Reverse(true)
	s.selected = lipgloss.NewStyle().Reverse(true)
	return s
}

func (s styles) status(status string) lipgloss.Style {
	if s.plain {
		return lipgloss.NewStyle()
	}
	switch status {
	case "in-progress":
		return lipgloss.NewStyle().Foreground(lipgloss.Green)
	case "in-review":
		return lipgloss.NewStyle().Foreground(lipgloss.Cyan)
	case "blocked":
		return lipgloss.NewStyle().Foreground(lipgloss.Yellow)
	case "todo":
		return lipgloss.NewStyle().Bold(true)
	case "backlog", "done", "canceled":
		return lipgloss.NewStyle().Faint(true)
	}
	return lipgloss.NewStyle()
}

// flowState colours a flow's state, or an agent's, by what it means: moving
// green, waiting yellow, gone wrong red, over dim, ready to move bold.
func (s styles) flowState(state string) lipgloss.Style {
	if s.plain {
		return lipgloss.NewStyle()
	}
	switch state {
	case "running", "busy", "in-progress":
		return lipgloss.NewStyle().Foreground(lipgloss.Green)
	case "blocked", "waiting", "proposed", "in-review", "exited":
		return lipgloss.NewStyle().Foreground(lipgloss.Yellow)
	case "failed", "lost", "violation", "refused":
		return lipgloss.NewStyle().Foreground(lipgloss.Red)
	case "queued", "resumable", "todo":
		return lipgloss.NewStyle().Bold(true)
	case "clean", "done", "canceled", "landed", "withdrawn", "idle", "-":
		return lipgloss.NewStyle().Faint(true)
	}
	return lipgloss.NewStyle()
}

func (s styles) priority(p string) lipgloss.Style {
	if s.plain {
		return lipgloss.NewStyle()
	}
	switch p {
	case "urgent":
		return lipgloss.NewStyle().Foreground(lipgloss.Red).Bold(true)
	case "high":
		return lipgloss.NewStyle().Foreground(lipgloss.Yellow)
	case "low", "":
		return lipgloss.NewStyle().Faint(true)
	}
	return lipgloss.NewStyle()
}

// ---- text helpers -----------------------------------------------------------

func paneTitle(st styles, name, left, right string, width int) string {
	head := " " + st.title.Render(name) + " ── " + left + " "
	if left == "" {
		head = " " + st.title.Render(name) + " "
	}
	tail := ""
	if right != "" {
		// The right side yields before the name and the count do: keep at least four dashes.
		room := width - lipgloss.Width(head) - 5
		if room < 8 {
			tail = ""
		} else {
			tail = " " + truncate(right, room)
		}
	}
	dashes := width - lipgloss.Width(head) - lipgloss.Width(tail)
	if dashes < 0 {
		dashes = 0
	}
	return head + st.faint.Render(strings.Repeat("─", dashes)) + tail
}

// spread puts left at the left and right at the right of a line of the given width.
func spread(left, right string, width int) string {
	gap := width - lipgloss.Width(left) - lipgloss.Width(right) - 1
	if gap < 1 {
		gap = 1
	}
	return left + strings.Repeat(" ", gap) + right
}

// pad truncates or right-pads a plain string to exactly width cells.
func pad(s string, width int, fill ...rune) string {
	f := ' '
	if len(fill) > 0 {
		f = fill[0]
	}
	w := lipgloss.Width(s)
	if w > width {
		return truncate(s, width)
	}
	return s + strings.Repeat(string(f), width-w)
}

// padStyled right-pads a line that may carry styles to exactly width cells, or cuts it.
func padStyled(s string, width int) string {
	w := lipgloss.Width(s)
	if w > width {
		return fit(s, width)
	}
	return s + strings.Repeat(" ", width-w)
}

func truncate(s string, width int) string {
	if width <= 0 {
		return ""
	}
	if lipgloss.Width(s) <= width {
		return s
	}
	r := []rune(s)
	for len(r) > 0 && lipgloss.Width(string(r))+1 > width {
		r = r[:len(r)-1]
	}
	return string(r) + "…"
}

// fit truncates a possibly styled line to the width; it only ever cuts plain lines,
// since styled ones are built to width, but a resize between frames can catch one.
func fit(line string, width int) string {
	if lipgloss.Width(line) <= width {
		return line
	}
	return lipgloss.NewStyle().MaxWidth(width).Render(line)
}

func wrap(s string, width int) []string {
	if width < 10 {
		width = 10
	}
	var out []string
	for _, para := range strings.Split(s, "\n") {
		if strings.TrimSpace(para) == "" {
			out = append(out, "")
			continue
		}
		out = append(out, strings.Split(lipgloss.Wrap(para, width, ""), "\n")...)
	}
	return out
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func ago(t, now time.Time) string {
	if t.IsZero() {
		return "-"
	}
	return short(now.Sub(t)) + " ago"
}

// short is a duration in one unit: 42s, 6m, 2h, 3d.
func short(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}

// ageDays reads a YYYY-MM-DD and says how many days ago it was.
func ageDays(date string, now time.Time) string {
	d, err := time.ParseInLocation("2006-01-02", date, now.Location())
	if err != nil {
		return "-"
	}
	y, mo, da := now.Date()
	today := time.Date(y, mo, da, 0, 0, 0, 0, now.Location())
	days := int(today.Sub(d).Hours() / 24)
	if days <= 0 {
		return "today"
	}
	return fmt.Sprintf("%dd", days)
}

func modTime(path string) time.Time {
	st, err := os.Stat(path)
	if err != nil {
		return time.Time{}
	}
	return st.ModTime()
}

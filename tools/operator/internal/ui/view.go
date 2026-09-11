package ui

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/smailq/heai-tools/tools/operator/internal/discover"
	"github.com/smailq/heai-tools/tools/operator/internal/flows"
	"github.com/smailq/heai-tools/tools/operator/internal/pod"
	"github.com/smailq/heai-tools/tools/operator/internal/reactor"
	"github.com/smailq/heai-tools/tools/operator/internal/tracker"
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
	case m.wsDetail != nil:
		lines = append(lines, m.workspaceLines(st, m.wsDetail)...)
	case m.evDetail != nil:
		lines = append(lines, m.eventLines(st, m.evDetail)...)
	default:
		// The five panes in a fixed order: the selected one is a table sized to its region, the others one line each.
		for p := paneTasks; p < paneCount; p++ {
			if p == m.pane {
				lines = append(lines, m.region(st, p)...)
			} else {
				lines = append(lines, m.paneLine(st, p))
			}
		}
	}
	// Pad to the height so the key bar sits on the last line.
	body := m.height - 1
	for len(lines) < body {
		lines = append(lines, "")
	}
	if len(lines) > body {
		lines = lines[:body]
	}
	if m.choosing {
		lines = append(lines, m.chooserLine(st))
	} else {
		lines = append(lines, m.keyBar(st))
	}
	for i, l := range lines {
		lines[i] = fit(l, m.width)
	}
	return strings.Join(lines, "\n")
}

// fullHeight is what a view that takes the whole screen may use: the height less the header and the bar.
func (m Model) fullHeight() int { return m.height - 2 }

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
	case panePod:
		lines = m.podTable(st)
	case paneReactor:
		lines = m.reactorTable(st)
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
	if p := m.pod.Status; p != nil {
		if p.Up() {
			parts = append(parts, fmt.Sprintf("pod ●%d", linkedCount(m.pod.Workspaces)))
		} else {
			parts = append(parts, "pod "+st.yellow.Render("○"))
		}
	}
	if r := m.reactor.Status; r != nil {
		meter := fmt.Sprintf("reactor %d/1h", r.Events.LastHour)
		if n := len(m.reactor.FailedActions()); n > 0 {
			meter += " " + st.red.Render(fmt.Sprintf("✗%d", n))
		} else if n := r.Problems(); n > 0 {
			meter += " " + st.yellow.Render(fmt.Sprintf("⚠%d", n))
		}
		parts = append(parts, meter)
	}
	right := fmt.Sprintf("%s  %s", m.opts.Interval.Truncate(time.Second), m.opts.Now().Format("15:04:05"))
	if m.loading || m.slowPending > 0 {
		right = "· " + right
	}
	// The clock is the honest part of the line: the meters leave from the right before it is cut.
	for len(parts) > 2 && lipgloss.Width(strings.Join(parts, "  "))+lipgloss.Width(right)+2 > m.width {
		parts = parts[:len(parts)-1]
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
	case panePod:
		text, right = m.podSummary(st), m.podAge(st)
	case paneReactor:
		text, right = m.reactorSummary(st), m.reactorAge(st)
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

// podSummary is the container's word, then the linked workspaces by their agent's state.
func (m Model) podSummary(st styles) string {
	p := m.pod
	if p.Status == nil {
		if p.Note != "" {
			return st.faint.Render(p.Note)
		}
		return st.faint.Render("asking…")
	}
	if !p.Status.Up() {
		return st.yellow.Render("○ " + p.Status.Summary())
	}
	parts := []string{"● " + p.Status.Summary()}
	if n := linkedCount(p.Workspaces); n > 0 {
		var states []string
		for _, c := range pod.CountByStatus(p.Workspaces) {
			states = append(states, st.flowState(c.State).Render(fmt.Sprintf("%s %d", c.State, c.Count)))
		}
		parts = append(parts, fmt.Sprintf("workspaces %d (%s)", n, strings.Join(states, " · ")))
	} else {
		parts = append(parts, st.faint.Render("no workspaces"))
	}
	return strings.Join(parts, "   ")
}

func (m Model) podAge(st styles) string {
	if m.pod.At.IsZero() || (m.pod.Status == nil && !m.pod.Failed) {
		return ""
	}
	if m.pod.Failed {
		return st.red.Render("⚠ "+m.pod.Note) + " · as of " + m.pod.At.Format("15:04:05")
	}
	return "pod " + ago(m.pod.At, m.opts.Now())
}

// reactorSummary is a dot per source, then the hour's events, the rules, and what failed.
func (m Model) reactorSummary(st styles) string {
	r := m.reactor
	if r.Status == nil {
		if r.Note != "" {
			return st.faint.Render(r.Note)
		}
		return st.faint.Render("asking…")
	}
	var dots []string
	for _, src := range r.Status.Sources {
		if src.Problem() != "" {
			dots = append(dots, st.yellow.Render("○ "+src.Name))
		} else {
			dots = append(dots, "● "+src.Name)
		}
	}
	if len(dots) == 0 {
		dots = append(dots, st.faint.Render("no sources"))
	}
	tail := []string{fmt.Sprintf("%d events/1h", r.Status.Events.LastHour), fmt.Sprintf("%d rules", len(r.Status.Rules))}
	if n := len(r.FailedActions()); n > 0 {
		tail = append(tail, st.red.Render(fmt.Sprintf("%d failed", n)))
	}
	return strings.Join(dots, "  ") + "   " + strings.Join(tail, " · ")
}

func (m Model) reactorAge(st styles) string {
	if m.reactor.At.IsZero() || (m.reactor.Status == nil && !m.reactor.Failed) {
		return ""
	}
	if m.reactor.Failed {
		return st.red.Render("⚠ "+m.reactor.Note) + " · as of " + m.reactor.At.Format("15:04:05")
	}
	return "reactor " + ago(m.reactor.At, m.opts.Now())
}

// linkedCount is how many workspaces are worktrees, leaving out the clone Herdr opens as one.
func linkedCount(list []pod.Workspace) int {
	n := 0
	for _, w := range list {
		if w.Linked {
			n++
		}
	}
	return n
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
	var lines []string
	if m.flowDef != "" {
		lines = m.definitionLines(st, width)
	} else {
		lines = m.stuckLines(st, width)
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

// stuckLines is the default flows table: the stuck report as flow prints it.
func (m Model) stuckLines(st styles, width int) []string {
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
	return lines
}

// definitionLines is the flows table under a chosen definition: every flow of it, with a column per link it carries.
func (m Model) definitionLines(st styles, width int) []string {
	rows := m.defRows()
	all := m.flows.OfDefinition(m.flowDef)
	open := 0
	for _, f := range all {
		if !f.Terminal {
			open++
		}
	}
	left := fmt.Sprintf("%s · %d open of %d", m.flowDef, open, len(all))
	if m.filter != "" {
		left = fmt.Sprintf("%s · %d of %d · filter %q", m.flowDef, len(rows), len(all), m.filter)
	}
	lines := []string{paneTitle(st, "flows", left, m.flowsAge(st), width)}
	if len(all) == 0 {
		msg := "no flows of definition " + m.flowDef
		for _, d := range m.flows.Definitions {
			if d.Name == m.flowDef && d.Problem != nil {
				msg = "definition " + m.flowDef + " does not read: " + *d.Problem
				return append(lines, " "+st.red.Render(msg))
			}
		}
		return append(lines, " "+st.faint.Render(msg))
	}
	cols := m.definitionColumns(width, all)
	lines = append(lines, columnHeader(st, cols))
	h := m.bodyHeight()
	end := min(len(rows), m.offset+h)
	for i := m.offset; i < end; i++ {
		lines = append(lines, m.definitionRow(st, cols, rows[i], i == m.cursor, width))
	}
	if len(rows) == 0 {
		lines = append(lines, st.faint.Render(" (nothing to show)"))
	}
	return lines
}

// linkOrder puts the links every process names first; the rest follow by name.
var linkOrder = []string{"task", "actor", "repo", "branch"}

// linkNames is every link name the flows carry, in linkOrder then alphabetical.
func linkNames(list []flows.Flow) []string {
	seen := map[string]bool{}
	for _, f := range list {
		for n := range f.Links {
			seen[n] = true
		}
	}
	var out []string
	for _, n := range linkOrder {
		if seen[n] {
			out = append(out, n)
			delete(seen, n)
		}
	}
	rest := make([]string, 0, len(seen))
	for n := range seen {
		rest = append(rest, n)
	}
	sort.Strings(rest)
	return append(out, rest...)
}

// definitionColumns is id, state and age, then one column per link, each as wide as its
// widest value up to 30, the last taking what is left; link columns leave from the right
// when the terminal is too narrow for them.
func (m Model) definitionColumns(width int, list []flows.Flow) []column {
	cols := []column{{"id", 28, 0}, {"state", 10, 0}, {"age", 5, 0}}
	used := 1
	for _, c := range cols {
		used += c.width + 2
	}
	names := linkNames(list)
	for i, n := range names {
		need := len([]rune(n))
		for _, f := range list {
			need = max(need, lipgloss.Width(f.Links[n]))
		}
		need = min(need, 30)
		left := width - used
		if left < 8 {
			break
		}
		if i == len(names)-1 || need > left {
			need = left
		}
		cols = append(cols, column{n, need, 0})
		used += need + 2
	}
	return cols
}

func (m Model) definitionRow(st styles, cols []column, f flows.Flow, selected bool, width int) string {
	var cells []string
	for _, c := range cols {
		var v string
		switch c.name {
		case "id":
			v = f.ID
		case "state":
			v = f.State
		case "age":
			v = short(m.opts.Now().Sub(f.SinceTime()))
		default:
			v = orDash(f.Links[c.name])
		}
		cell := pad(v, c.width)
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

// chooserLine is what d puts in place of the key bar: the stuck report and every definition, the cursor's choice reversed.
func (m Model) chooserLine(st styles) string {
	var pills []string
	for i, c := range m.flowChoices() {
		label := c
		if c == "" {
			label = "stuck"
		}
		switch {
		case i == m.choice:
			label = st.key.Render(" " + label + " ")
		case c == m.flowDef:
			label = st.title.Render("[" + label + "]")
		default:
			label = " " + label + " "
		}
		pills = append(pills, label)
	}
	return spread(" "+st.title.Render("definition")+"  "+strings.Join(pills, " "), "←→ choose · 1-9 pick · ⏎ show · esc back", m.width)
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

// ---- pod --------------------------------------------------------------------

func (m Model) podColumns(width int) []column {
	cols := []column{
		{"id", 4, 0},
		{"actor", 14, 70},
		{"repo", 8, 90},
		{"branch", 0, 0}, // flexible
		{"agent", 12, 100},
		{"state", 8, 0},
	}
	// The branch takes what is left up to 40; what remains is the label.
	return layout(cols, width, -1, 16, 40, 12, 10, "label")
}

// podTable is the container's status on the title and every workspace pod lists under it.
func (m Model) podTable(st styles) []string {
	width := m.width
	p := m.pod
	if p.Status == nil {
		msg := p.Note
		if msg == "" {
			msg = "asking pod…"
		}
		return []string{paneTitle(st, "pod", "", m.podAge(st), width), " " + st.faint.Render(msg)}
	}
	if !p.Status.Up() {
		return []string{
			paneTitle(st, "pod", st.yellow.Render("○ "+p.Status.Summary()), m.podAge(st), width),
			" " + st.faint.Render("nothing to list while the container is down · heai-pod status"),
		}
	}
	rows := m.podRows()
	left := p.Status.Summary() + fmt.Sprintf(" · %d workspaces", linkedCount(p.Workspaces))
	var states []string
	for _, c := range p.Status.AgentCounts() {
		states = append(states, st.flowState(c.State).Render(fmt.Sprintf("%s %d", c.State, c.Count)))
	}
	if len(states) > 0 {
		left += " · agents " + strings.Join(states, " · ")
	}
	if m.filter != "" {
		left = fmt.Sprintf("%d of %d · filter %q", len(rows), len(p.Workspaces), m.filter)
	}
	cols := m.podColumns(width)
	lines := []string{paneTitle(st, "pod", left, m.podAge(st), width), columnHeader(st, cols)}
	h := m.bodyHeight()
	end := min(len(rows), m.offset+h)
	for i := m.offset; i < end; i++ {
		lines = append(lines, m.podRow(st, cols, rows[i], i == m.cursor, width))
	}
	if len(rows) == 0 {
		lines = append(lines, st.faint.Render(" (no workspaces)"))
	}
	return append(lines, m.filterLine()...)
}

func (m Model) podRow(st styles, cols []column, w pod.Workspace, selected bool, width int) string {
	label := w.Label
	if !w.Linked {
		label += "  (the clone)"
	}
	values := map[string]string{
		"id": w.ID, "actor": orDash(w.Actor), "repo": orDash(w.Repo), "branch": orDash(w.Branch),
		"agent": orDash(w.AgentText()), "state": orDash(w.Status), "label": label,
	}
	var cells []string
	for _, c := range cols {
		cell := pad(values[c.name], c.width)
		if !selected {
			switch {
			case !w.Linked:
				cell = st.faint.Render(cell)
			case c.name == "state":
				cell = st.flowState(w.Status).Render(cell)
			}
		}
		cells = append(cells, cell)
	}
	return m.finishRow(st, " "+strings.Join(cells, "  "), selected, width)
}

// workspaceLines is one workspace in full: what pod knows about it, its agents and its panes.
func (m Model) workspaceLines(st styles, w *pod.Workspace) []string {
	width := m.width
	title := w.ID + " · " + w.Label
	right := "heai-pod list"
	if !w.Linked {
		right = "the clone · " + right
	}
	lines := []string{paneTitle(st, "workspace", title, right, width)}
	kv := func(k, v string) string { return " " + st.faint.Render(pad(k, 12)) + v }
	lines = append(lines, kv("status", st.flowState(w.Status).Render(orDash(w.Status))))
	lines = append(lines, kv("actor", orDash(w.Actor)), kv("repo", orDash(w.Repo)), kv("branch", orDash(w.Branch)))
	lines = append(lines, kv("path", truncate(orDash(w.Path), width-14)))
	if len(w.Tokens) > 0 {
		names := make([]string, 0, len(w.Tokens))
		for n := range w.Tokens {
			names = append(names, n)
		}
		sort.Strings(names)
		var parts []string
		for _, n := range names {
			parts = append(parts, n+"="+w.Tokens[n])
		}
		lines = append(lines, kv("tokens", truncate(strings.Join(parts, " "), width-14)))
	}
	lines = append(lines, paneRule(st, fmt.Sprintf(" ── agents %d ", len(w.Agents)), "", width))
	if len(w.Agents) == 0 {
		lines = append(lines, " "+st.faint.Render("(none started)"))
	}
	for _, a := range w.Agents {
		lines = append(lines, " "+pad(orDash(a.Kind), 10)+pad(orDash(a.Name), 16)+pad(a.Pane, 8)+st.flowState(a.State).Render(a.State))
	}
	lines = append(lines, paneRule(st, fmt.Sprintf(" ── panes %d ", len(w.Panes)), "", width))
	for _, p := range w.Panes {
		agent := orDash(p.Agent)
		lines = append(lines, " "+pad(p.ID, 8)+pad(agent, 10)+pad(st.flowState(p.State).Render(p.State), 10)+st.faint.Render(truncate(p.Cwd, width-30)))
	}
	return m.scrolled(lines, 1, m.detailOff, m.fullHeight())
}

// ---- reactor ----------------------------------------------------------------

func (m Model) sourceColumns(width int) []column {
	cols := []column{
		{"source", 12, 0},
		{"type", 8, 0},
		{"cadence", 16, 80},
		{"last", 5, 0},
		{"/1h", 3, 70},
	}
	return layout(cols, width, -1, 0, 0, 0, 10, "cursor")
}

func (m Model) ruleColumns(width int) []column {
	cols := []column{
		{"rule", 16, 0},
		{"on", 0, 0}, // flexible
		{"run", 20, 90},
		{"last", 5, 0},
	}
	return layout(cols, width, -1, 16, 40, 12, 8, "result")
}

func (m Model) eventColumns(width int) []column {
	cols := []column{
		{"at", 5, 0},
		{"source", 10, 0},
		{"kind", 16, 0},
		{"key", 0, 0}, // flexible
	}
	// The key takes what is left up to 36; what remains is each rule's result.
	return layout(cols, width, -1, 12, 36, 12, 12, "rule → result")
}

// reactorTable is the sources, then the rules, then the last hour's events, newest first.
func (m Model) reactorTable(st styles) []string {
	width := m.width
	r := m.reactor
	if r.Status == nil {
		msg := r.Note
		if msg == "" {
			msg = "asking reactor…"
		}
		return []string{paneTitle(st, "reactor", "", m.reactorAge(st), width), " " + st.faint.Render(msg)}
	}
	rows := m.eventRows()
	left := fmt.Sprintf("%d sources", len(r.Status.Sources))
	if n := r.Status.Problems(); n > 0 {
		left += " " + st.yellow.Render(fmt.Sprintf("⚠ %d", n))
	}
	left += fmt.Sprintf(" · %d rules · %d events in the last hour", len(r.Status.Rules), r.Status.Events.LastHour)
	if n := len(r.FailedActions()); n > 0 {
		left += " · " + st.red.Render(fmt.Sprintf("%d failed", n))
	}
	lines := []string{paneTitle(st, "reactor", left, m.reactorAge(st), width)}

	// Sources: a dot, then the tool's own description of where each stands.
	scols := m.sourceColumns(width)
	lines = append(lines, columnHeader(st, scols))
	shown := m.sourcesShown()
	for i, src := range r.Status.Sources {
		if i >= shown {
			break
		}
		lines = append(lines, m.sourceRow(st, scols, src, width))
	}
	if len(r.Status.Sources) == 0 {
		lines = append(lines, st.faint.Render(" (no sources)"))
	} else if n := len(r.Status.Sources) - shown; n > 0 {
		lines[len(lines)-1] = st.faint.Render(fmt.Sprintf(" … and %d more sources", n+1))
	}

	// Rules: what each listens for, and how its last run went.
	rcols := m.ruleColumns(width)
	caption := fmt.Sprintf(" ── rules %d ", len(r.Status.Rules))
	lines = append(lines, paneRule(st, caption, "", width), columnHeader(st, rcols))
	shown = m.rulesShown()
	for i, rule := range r.Status.Rules {
		if i >= shown {
			break
		}
		lines = append(lines, m.ruleRow(st, rcols, rule, width))
	}
	if len(r.Status.Rules) == 0 {
		lines = append(lines, st.faint.Render(" (no rules)"))
	} else if n := len(r.Status.Rules) - shown; n > 0 {
		lines[len(lines)-1] = st.faint.Render(fmt.Sprintf(" … and %d more rules", n+1))
	}

	// Events: the body the cursor moves over.
	caption = " ── events, newest first · heai-reactor events --since 1h "
	if m.filter != "" {
		caption = fmt.Sprintf(" ── events %d of %d · filter %q ", len(rows), len(r.Events), m.filter)
	}
	ecols := m.eventColumns(width)
	lines = append(lines, paneRule(st, caption, "", width), columnHeader(st, ecols))
	h := m.bodyHeight()
	end := min(len(rows), m.offset+max(0, h))
	for i := m.offset; i < end; i++ {
		lines = append(lines, m.eventRow(st, ecols, rows[i], i == m.cursor, width))
	}
	if len(rows) == 0 {
		lines = append(lines, st.faint.Render(" (no events in the last hour)"))
	}
	return append(lines, m.filterLine()...)
}

func (m Model) sourceRow(st styles, cols []column, src reactor.Source, width int) string {
	dot, problem := "●", src.Problem()
	if problem != "" {
		dot = "○"
	}
	last := "-"
	if t := src.LastEventTime(); !t.IsZero() {
		last = clock(t, m.opts.Now())
	}
	cursor := src.Cursor
	if problem != "" {
		cursor = "⚠ " + problem
	}
	values := map[string]string{
		"source": dot + " " + src.Name, "type": src.Type, "cadence": src.Cadence(), "last": last,
		"/1h": fmt.Sprintf("%d", src.LastHour), "cursor": cursor,
	}
	var cells []string
	for _, c := range cols {
		cell := pad(values[c.name], c.width)
		switch {
		case problem != "" && (c.name == "source" || c.name == "cursor"):
			cell = st.yellow.Render(cell)
		case c.name == "cursor":
			cell = st.faint.Render(cell)
		}
		cells = append(cells, cell)
	}
	return " " + strings.Join(cells, "  ")
}

func (m Model) ruleRow(st styles, cols []column, rule reactor.Rule, width int) string {
	last, result, red := "-", "", false
	switch a := rule.LastAction; {
	case a != nil:
		last, result, red = clock(a.AtTime(), m.opts.Now()), a.Result(), a.Failed()
	case rule.Limit != nil:
		result = "limit " + rule.Limit.String()
	default:
		result = "never fired"
	}
	if rule.Pending != nil {
		result += " · debouncing until " + clock(reactorTime(rule.Pending.Until), m.opts.Now())
	}
	values := map[string]string{"rule": rule.Name, "on": rule.On, "run": rule.Run, "last": last, "result": result}
	var cells []string
	for _, c := range cols {
		cell := pad(values[c.name], c.width)
		switch {
		case red && (c.name == "rule" || c.name == "result"):
			cell = st.red.Render(cell)
		case c.name == "result" && rule.LastAction == nil:
			cell = st.faint.Render(cell)
		case c.name == "run":
			cell = st.faint.Render(cell)
		}
		cells = append(cells, cell)
	}
	return " " + strings.Join(cells, "  ")
}

func (m Model) eventRow(st styles, cols []column, e reactor.Event, selected bool, width int) string {
	var results []string
	red := false
	for _, a := range e.Actions {
		results = append(results, a.Rule+" → "+a.Result())
		if a.Failed() {
			red = true
		}
	}
	values := map[string]string{
		"at": clock(e.AtTime(), m.opts.Now()), "source": e.Source, "kind": e.Kind, "key": e.Key,
		"rule → result": orDash(strings.Join(results, ", ")),
	}
	var cells []string
	for _, c := range cols {
		cell := pad(values[c.name], c.width)
		if !selected {
			switch {
			case red && c.name == "rule → result":
				cell = st.red.Render(cell)
			case c.name == "rule → result" && len(results) == 0:
				cell = st.faint.Render(cell)
			}
		}
		cells = append(cells, cell)
	}
	return m.finishRow(st, " "+strings.Join(cells, "  "), selected, width)
}

// eventLines is one event in full: its fields, its payload, and every action a rule took on it.
func (m Model) eventLines(st styles, e *reactor.Event) []string {
	width := m.width
	lines := []string{paneTitle(st, "event", e.ID, e.Source+" · "+e.Kind, width)}
	kv := func(k, v string) string { return " " + st.faint.Render(pad(k, 12)) + v }
	lines = append(lines, kv("source", e.Source), kv("kind", e.Kind), kv("key", truncate(e.Key, width-14)), kv("at", e.At))
	lines = append(lines, paneRule(st, " ── payload ", "", width))
	raw, err := json.MarshalIndent(e.Payload, "", "  ")
	if err != nil || len(e.Payload) == 0 {
		lines = append(lines, " "+st.faint.Render("{}"))
	} else {
		for _, l := range strings.Split(string(raw), "\n") {
			lines = append(lines, " "+truncate(l, width-1))
		}
	}
	acts := e.Actions
	lines = append(lines, paneRule(st, fmt.Sprintf(" ── actions %d ", len(acts)), "", width))
	if len(acts) == 0 {
		lines = append(lines, " "+st.faint.Render("(no rule acted on it)"))
	}
	for _, a := range acts {
		result := a.Result()
		if a.Failed() {
			result = st.red.Render(result)
		}
		lines = append(lines, " "+st.title.Render(pad(a.Rule, 20))+pad(clock(a.AtTime(), m.opts.Now()), 7)+result)
		if c := a.Command(); c != "" {
			lines = append(lines, kv("  run", truncate(c, width-14)))
		}
		if l := a.Log(); l != "" {
			lines = append(lines, kv("  log", st.faint.Render(truncate(l, width-14))))
		}
		if len(a.Collapsed) > 0 {
			lines = append(lines, kv("  collapsed", fmt.Sprintf("%d more events into this run", len(a.Collapsed))))
		}
	}
	return m.scrolled(lines, 1, m.detailOff, m.fullHeight())
}

// scrolled keeps the first `head` lines and shows a window of the rest from off, within avail lines,
// saying on the title what is showing when not everything is.
func (m Model) scrolled(lines []string, head, off, avail int) []string {
	body := lines[head:]
	off = min(off, max(0, len(body)-1))
	shown := body[off:]
	room := avail - head
	if room > 0 && len(shown) > room {
		shown = shown[:room]
	}
	out := append([]string{}, lines[:head]...)
	if off > 0 || len(shown) < len(body) {
		out[0] = fit(out[0], m.width-22) + fmt.Sprintf(" lines %d-%d of %d", off+1, off+len(shown), len(body))
	}
	return append(out, shown...)
}

// clock is a time of day in the screen's zone.
func clock(t, now time.Time) string {
	if t.IsZero() {
		return "-"
	}
	return t.In(now.Location()).Format("15:04")
}

func reactorTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}
	}
	return t
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

// ---- help -------------------------------------------------------------------

func (m Model) helpLines(st styles) []string {
	lines := []string{paneTitle(st, "help", "", "", m.width)}
	keys := [][2]string{
		{"1 2 3 4", "the pane with the table: tasks, flows, pod, reactor"},
		{"↑ ↓  j k", "move"}, {"pgup pgdn  g G", "page, first, last"},
		{"enter", "open: the task, the workspace or the event full width, or the flow's trace (flow trace <id>)"},
		{"p", "show or hide the task pane"}, {"tab", "focus the task pane, to scroll it"},
		{"d", "in flows: choose what the table lists - the stuck report, or one definition's flows"},
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
	flowsFrom := fmt.Sprintf("flow definitions --json · flow list --json · flow stuck --json, every %s", m.opts.SlowInterval)
	if m.flows.Note != "" {
		flowsFrom += "  (" + m.flows.Note + ")"
	}
	lines = append(lines, " "+pad("flows", 16)+flowsFrom)
	podFrom := fmt.Sprintf("pod status --json · pod list --json when it is up, every %s", m.opts.SlowInterval)
	if m.pod.Note != "" {
		podFrom += "  (" + m.pod.Note + ")"
	}
	lines = append(lines, " "+pad("pod", 16)+podFrom)
	reactorFrom := fmt.Sprintf("reactor status --json · reactor events --since 1h --json, every %s", m.opts.SlowInterval)
	if m.reactor.Note != "" {
		reactorFrom += "  (" + m.reactor.Note + ")"
	}
	lines = append(lines, " "+pad("reactor", 16)+reactorFrom)
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
	common := [][2]string{{"1-4", "pane"}, {"/", "filter"}, {"+/-", "interval"}, {"r", "reload"}, {"?", "help"}, {"q", "quit"}}
	switch {
	case m.typing:
		keys = [][2]string{{"type", "to filter"}, {"enter", "keep"}, {"esc", "clear"}}
	case m.help:
		keys = [][2]string{{"any key", "back"}, {"q", "quit"}}
	case m.trace != nil:
		keys = [][2]string{{"↑↓", "scroll"}, {"r", "reload"}, {"esc", "back"}, {"q", "quit"}}
	case m.inDetail():
		keys = [][2]string{{"↑↓", "scroll"}, {"esc", "back"}, {"q", "quit"}}
	case m.pane == panePod, m.pane == paneReactor:
		keys = append([][2]string{{"↑↓", "move"}, {"⏎", "open"}}, common...)
	case m.pane == paneFlows:
		keys = append([][2]string{{"↑↓", "move"}, {"⏎", "trace"}, {"d", "definition"}}, common...)
	case m.split() && m.focus == focusRight:
		keys = [][2]string{{"↑↓", "scroll"}, {"⇥", "list"}, {"⏎", "expand"}, {"p", "hide"}, {"esc", "list"}, {"?", "help"}, {"q", "quit"}}
	case m.split():
		keys = append([][2]string{{"↑↓", "move"}, {"⇥", "task"}, {"⏎", "expand"}, {"p", "hide"}, {"b", scope}, {"S", "sort"}}, common...)
	case m.width >= splitAt && !m.opts.NoSplit:
		keys = append([][2]string{{"↑↓", "move"}, {"⏎", "open"}, {"p", "task pane"}, {"b", scope}, {"S", "sort"}}, common...)
	default:
		keys = append([][2]string{{"↑↓", "move"}, {"⏎", "open"}, {"b", scope}, {"S", "sort"}}, common...)
	}
	render := func(keys [][2]string) string {
		var parts []string
		for _, k := range keys {
			parts = append(parts, st.key.Render(k[0])+" "+k[1])
		}
		return " " + strings.Join(parts, "  ")
	}
	// On a narrow terminal the least-used keys leave the bar first; help and quit stay.
	for _, drop := range []string{"r", "+/-", "1-4", "S", "b", "/", "p", "⇥", "d", "⏎"} {
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
	case "running", "busy", "working", "in-progress":
		return lipgloss.NewStyle().Foreground(lipgloss.Green)
	case "blocked", "waiting", "proposed", "in-review", "exited":
		return lipgloss.NewStyle().Foreground(lipgloss.Yellow)
	case "failed", "lost", "violation", "refused":
		return lipgloss.NewStyle().Foreground(lipgloss.Red)
	case "queued", "resumable", "todo":
		return lipgloss.NewStyle().Bold(true)
	case "clean", "done", "canceled", "landed", "withdrawn", "idle", "unknown", "-":
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

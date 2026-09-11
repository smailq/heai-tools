package ui

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/smailq/heai-tools/tools/operator/internal/flows"
	"github.com/smailq/heai-tools/tools/operator/internal/owners"
	"github.com/smailq/heai-tools/tools/operator/internal/pod"
	"github.com/smailq/heai-tools/tools/operator/internal/reactor"
	"github.com/smailq/heai-tools/tools/operator/internal/tracker"
)

var update = flag.Bool("update", false, "rewrite the golden files")

// A fixed clock, the minute the flow fixtures were recorded against, so ages and the header's time are stable.
var now = time.Date(2026, 9, 9, 13, 41, 0, 0, time.UTC)

func readFixture(t *testing.T, parts ...string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(append([]string{"..", "..", "testdata"}, parts...)...))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func fixture(t *testing.T) Model {
	t.Helper()
	dir := filepath.Join("..", "tracker", "testdata", "tracker")
	tr, err := tracker.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	tr.Changed = now.Add(-3 * time.Minute)
	snap := Snapshot{
		Tracker: tr,
		MapPath: "/repo/architecture.yaml",
		Owners: owners.Result{Owners: owners.Owners{
			"core": "core-reviewer", "desktop": "desktop-owner", "ui": "ui-owner", "mail": "mail-owner",
			"api": "api-owner", "website": "website-owner", "ontology": "ontology-owner",
		}, Repos: []string{"app", "docs"}},
		At: now,
	}
	list, err := flows.ParseList(readFixture(t, "flow", "list.json"))
	if err != nil {
		t.Fatal(err)
	}
	stuck, err := flows.ParseStuck(readFixture(t, "flow", "stuck.json"))
	if err != nil {
		t.Fatal(err)
	}
	defs, err := flows.ParseDefinitions(readFixture(t, "flow", "definitions.json"))
	if err != nil {
		t.Fatal(err)
	}
	podStatus, err := pod.ParseStatus(readFixture(t, "pod", "status.json"))
	if err != nil {
		t.Fatal(err)
	}
	ws, err := pod.ParseList(readFixture(t, "pod", "list.json"))
	if err != nil {
		t.Fatal(err)
	}
	reactorStatus, err := reactor.ParseStatus(readFixture(t, "reactor", "status.json"))
	if err != nil {
		t.Fatal(err)
	}
	events, err := reactor.ParseEvents(readFixture(t, "reactor", "events.json"))
	if err != nil {
		t.Fatal(err)
	}
	opts := Options{TasksDir: filepath.Join("/repo", "tasks"), Interval: 2 * time.Second, Plain: true, Now: func() time.Time { return now }}
	m := New(opts).WithSnapshot(snap)
	m = m.WithFlows(flows.Result{Definitions: defs, Flows: list, Stuck: stuck, At: now.Add(-4 * time.Second)})
	m = m.WithPod(pod.Result{Status: podStatus, Workspaces: ws, At: now.Add(-4 * time.Second)})
	m = m.WithReactor(reactor.Result{Status: reactorStatus, Events: events, At: now.Add(-5 * time.Second)})
	m.slowStarted = true
	return m
}

func golden(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", "golden", name+".txt")
	if *update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run with -update to create it)", err)
	}
	if string(want) != got {
		t.Errorf("%s differs from golden\n--- got ---\n%s\n--- want ---\n%s", name, got, want)
	}
}

func press(m Model, keys ...string) Model {
	for _, k := range keys {
		var msg tea.KeyPressMsg
		switch k {
		case "enter":
			msg = tea.KeyPressMsg{Code: tea.KeyEnter}
		case "esc":
			msg = tea.KeyPressMsg{Code: tea.KeyEscape}
		case "up":
			msg = tea.KeyPressMsg{Code: tea.KeyUp}
		case "down":
			msg = tea.KeyPressMsg{Code: tea.KeyDown}
		case "backspace":
			msg = tea.KeyPressMsg{Code: tea.KeyBackspace}
		case "tab":
			msg = tea.KeyPressMsg{Code: tea.KeyTab}
		case "left":
			msg = tea.KeyPressMsg{Code: tea.KeyLeft}
		case "right":
			msg = tea.KeyPressMsg{Code: tea.KeyRight}
		case "pgup":
			msg = tea.KeyPressMsg{Code: tea.KeyPgUp}
		case "pgdown":
			msg = tea.KeyPressMsg{Code: tea.KeyPgDown}
		default:
			r := []rune(k)
			msg = tea.KeyPressMsg{Code: r[0], Text: k}
		}
		next, _ := m.Update(msg)
		m = next.(Model)
	}
	return m
}

// withTrace answers the flow pane's trace request with the recorded timeline.
func withTrace(t *testing.T, m Model, id string) Model {
	t.Helper()
	if id == "" && m.panelTrace != nil {
		id = m.panelTrace.id
	}
	tl, err := flows.ParseTrace(readFixture(t, "flow", "trace.json"))
	if err != nil {
		t.Fatal(err)
	}
	next, _ := m.Update(traceMsg{id: id, lines: tl.Lines, panel: true})
	return next.(Model)
}

func pressCmd(m Model, k string) (Model, tea.Cmd) {
	next, cmd := m.Update(tea.KeyPressMsg{Code: []rune(k)[0], Text: k})
	return next.(Model), cmd
}

// ---- the tasks pane ---------------------------------------------------------

func TestGoldenSplit140(t *testing.T) {
	m := fixture(t).WithSize(140, 20)
	m = press(m, "down", "down") // document-tabs on the right
	golden(t, "split-140x20", m.Render())
}

func TestGoldenSplitFocusRight(t *testing.T) {
	m := fixture(t).WithSize(120, 18)
	m = press(m, "down", "down", "tab", "down", "down")
	if m.focus != focusRight || m.detailOff != 2 {
		t.Fatalf("focus %d off %d", m.focus, m.detailOff)
	}
	golden(t, "split-focus-right-120x18", m.Render())
}

func TestGoldenList96(t *testing.T) {
	m := fixture(t).WithSize(96, 18) // just under the split threshold: the list alone
	golden(t, "list-96x18", m.Render())
}

func TestNoSplitKeepsTheListAlone(t *testing.T) {
	m := fixture(t).WithSize(140, 16)
	m.opts.NoSplit = true
	if m.split() || strings.Contains(m.Render(), "│") {
		t.Error("NoSplit should render the list alone")
	}
}

func TestPTogglesTheTaskPane(t *testing.T) {
	m := fixture(t).WithSize(140, 18)
	if !m.split() {
		t.Fatal("wide screens split by default")
	}
	m = press(m, "tab", "p")
	if m.split() || m.focus != focusLeft || strings.Contains(m.Render(), "│") {
		t.Error("p should hide the pane and return focus to the list")
	}
	if !strings.Contains(m.Render(), "routes to") {
		t.Error("the list should get its columns back when the pane is hidden")
	}
	if !press(m, "p").split() {
		t.Error("p again should show the pane")
	}
	golden(t, "panel-hidden-140x18", m.Render())
}

func TestTabIsInertWhenNotSplit(t *testing.T) {
	m := press(fixture(t).WithSize(80, 20), "tab")
	if m.focus != focusLeft {
		t.Error("tab should do nothing below the split width")
	}
	m = press(fixture(t).WithSize(120, 20), "tab", "esc")
	if m.focus != focusLeft {
		t.Error("esc should return focus to the list")
	}
}

func TestMovingTheCursorResetsTheBodyScroll(t *testing.T) {
	m := press(fixture(t).WithSize(120, 20), "tab", "down", "down", "tab", "down")
	if m.detailOff != 0 {
		t.Errorf("offset should reset when the task changes: %d", m.detailOff)
	}
}

func TestGoldenAll80(t *testing.T) {
	m := fixture(t).WithSize(80, 22)
	golden(t, "all-80x22", m.Render())
}

func TestGoldenActive120(t *testing.T) {
	m := press(fixture(t).WithSize(120, 18), "p", "b")
	golden(t, "active-120x18", m.Render())
}

func TestGoldenDetail(t *testing.T) {
	m := fixture(t).WithSize(100, 18)
	m = press(m, "down", "down", "enter") // the third row: document-tabs, blocked
	if m.detail == nil || m.detail.Slug != "document-tabs" {
		t.Fatalf("detail: %+v", m.detail)
	}
	golden(t, "detail-100x18", m.Render())
}

func TestGoldenHelp(t *testing.T) {
	m := fixture(t).WithSize(110, 34)
	golden(t, "help-110x34", press(m, "?").Render())
}

func TestEveryLineFitsTheWidth(t *testing.T) {
	for _, p := range []string{"1", "2", "3", "4"} {
		for _, w := range []int{50, 60, 80, 95, 99, 100, 110, 120, 160, 200} {
			m := press(fixture(t).WithSize(w, 20), p, "down")
			for i, line := range strings.Split(m.Render(), "\n") {
				if n := len([]rune(line)); n > w {
					t.Errorf("pane %s width %d: line %d is %d wide: %q", p, w, i, n, line)
				}
			}
		}
	}
}

func TestFilterNarrowsAndEscClears(t *testing.T) {
	m := fixture(t).WithSize(120, 20)
	m = press(m, "/", "b", "l", "o", "c", "k", "enter")
	if n := len(m.rows()); n != 3 {
		t.Errorf("filter blocked: %d rows", n)
	}
	m = press(m, "esc")
	if m.filter != "" || len(m.rows()) != 11 {
		t.Errorf("esc should clear: %q %d", m.filter, len(m.rows()))
	}
}

func TestEveryStatusByDefaultAndBNarrowsToActive(t *testing.T) {
	m := fixture(t).WithSize(120, 20)
	if n := len(m.rows()); n != 11 {
		t.Errorf("default shows every task: %d", n)
	}
	if n := len(press(m, "b").rows()); n != 8 {
		t.Errorf("active: %d (7 open + 1 invalid)", n)
	}
	if n := len(press(m, "b", "b").rows()); n != 11 {
		t.Errorf("b again shows every task: %d", n)
	}
}

func TestSortCyclesAndCursorClamps(t *testing.T) {
	m := fixture(t).WithSize(120, 20)
	m = press(m, "S")
	if m.rows()[0].ModifiedAt < m.rows()[1].ModifiedAt {
		t.Error("age sort should put the newest first")
	}
	m = press(m, "S")
	if m.rows()[0].Slug != "add-place-entity" {
		t.Errorf("slug sort: %s", m.rows()[0].Slug)
	}
	m = press(m, "up", "up")
	if m.cursor != 0 {
		t.Errorf("cursor below zero: %d", m.cursor)
	}
	for i := 0; i < 50; i++ {
		m = press(m, "down")
	}
	if m.cursor != len(m.rows())-1 {
		t.Errorf("cursor past the end: %d", m.cursor)
	}
}

func TestIntervalKeysStayInRange(t *testing.T) {
	m := fixture(t)
	m = press(m, "-", "-", "-")
	if m.opts.Interval != time.Second {
		t.Errorf("floor: %s", m.opts.Interval)
	}
	for i := 0; i < 100; i++ {
		m = press(m, "+")
	}
	if m.opts.Interval != 60*time.Second {
		t.Errorf("ceiling: %s", m.opts.Interval)
	}
}

func TestQuitKeys(t *testing.T) {
	m := fixture(t)
	for _, k := range []string{"q"} {
		_, cmd := m.Update(tea.KeyPressMsg{Code: rune(k[0]), Text: k})
		if cmd == nil || cmd() != (tea.QuitMsg{}) {
			t.Errorf("%s should quit", k)
		}
	}
	_, cmd := m.Update(tea.KeyPressMsg{Code: 'c', Mod: tea.ModCtrl})
	if cmd == nil || cmd() != (tea.QuitMsg{}) {
		t.Error("ctrl+c should quit")
	}
}

func TestLoadedKeepsTheOpenTaskCurrent(t *testing.T) {
	m := fixture(t).WithSize(120, 20)
	m = press(m, "enter")
	if m.detail == nil {
		t.Fatal("no detail")
	}
	slug := m.detail.Slug
	fresh := m.snap
	next, _ := m.Update(loadedMsg(fresh))
	m = next.(Model)
	if m.detail == nil || m.detail.Slug != slug {
		t.Error("detail should survive a reload of the same tracker")
	}
	empty := Snapshot{Tracker: &tracker.Tracker{}, At: now}
	next, _ = m.Update(loadedMsg(empty))
	if next.(Model).detail != nil {
		t.Error("detail should close when its task is gone")
	}
}

func TestRenderBeforeTheFirstWindowSize(t *testing.T) {
	m := fixture(t).WithSize(0, 0)
	if out := m.Render(); !strings.Contains(out, "operator") {
		t.Errorf("unexpected render at zero size:\n%s", out)
	}
}

func TestNoTrackerShowsTheError(t *testing.T) {
	m := New(Options{TasksDir: "/nowhere/tasks", Plain: true, Now: func() time.Time { return now }}).
		WithSnapshot(Snapshot{Err: os.ErrNotExist}).WithSize(80, 8)
	if out := m.Render(); !strings.Contains(out, "file does not exist") {
		t.Errorf("error not shown:\n%s", out)
	}
}

// ---- the flows pane ---------------------------------------------------------

func TestPaneKeysSwitchTheTableAndResetTheCursor(t *testing.T) {
	m := press(fixture(t).WithSize(120, 20), "down", "down", "2")
	if m.pane != paneFlows || m.cursor != 0 {
		t.Errorf("2 selects flows at the top: pane %d cursor %d", m.pane, m.cursor)
	}
	if !m.split() {
		t.Error("the flows pane splits too")
	}
	if n := m.rowCount(); n != len(m.flows.Flows) {
		t.Errorf("the flows table has every flow: %d", n)
	}
	m = press(m, "3")
	if m.split() {
		t.Error("only the tasks and flows panes split")
	}
	if m.pane != panePod || m.rowCount() != 4 {
		t.Errorf("3 selects pod: pane %d rows %d", m.pane, m.rowCount())
	}
	if m = press(m, "1"); m.pane != paneTasks {
		t.Error("1 selects tasks")
	}
}

func TestGoldenFlows120(t *testing.T) {
	m := withTrace(t, press(fixture(t).WithSize(120, 20), "2", "down", "down"), "")
	golden(t, "flows-120x20", m.Render())
}

func TestGoldenFlows80(t *testing.T) {
	m := press(fixture(t).WithSize(80, 18), "2")
	golden(t, "flows-80x18", m.Render())
}

func TestADeadWaitIsStillRedOnTheLine(t *testing.T) {
	m := press(fixture(t).WithSize(120, 20), "2")
	m.opts.Plain = false
	if !strings.Contains(m.Render(), "stuck older than 1h") {
		t.Error("the line should carry the stuck count")
	}
	// Plain rendering carries no colour; the model says which rows are red.
	if !m.flows.Red() || !m.Red() {
		t.Error("a wait standing at canceled is red")
	}
}

func TestEnterOnAFlowOpensItsTrace(t *testing.T) {
	m := press(fixture(t).WithSize(100, 18), "2", "down", "down")
	next, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	if cmd == nil || m.trace == nil || !m.trace.loading || m.trace.id != m.flowRows()[2].ID {
		t.Fatalf("enter should ask for the trace: %+v", m.trace)
	}
	text := strings.TrimRight(string(readFixture(t, "flow", "trace.txt")), "\n")
	next, _ = m.Update(traceMsg{id: m.trace.id, text: text})
	m = next.(Model)
	if m.trace.loading || !strings.Contains(m.Render(), "queued → running") {
		t.Errorf("the trace should show as flow printed it:\n%s", m.Render())
	}
	golden(t, "trace-100x18", m.Render())
	if m = press(m, "esc"); m.trace != nil {
		t.Error("esc closes the trace")
	}
}

func TestFlowsAbsentIsOneDimLine(t *testing.T) {
	m := fixture(t).WithSize(120, 20).WithFlows(flows.Result{Note: "heai-flow not on PATH", At: now})
	out := m.Render()
	if !strings.Contains(out, "flows    heai-flow not on PATH") {
		t.Errorf("the line should say why:\n%s", out)
	}
	m = press(m, "2")
	if !strings.Contains(m.Render(), "heai-flow not on PATH") || m.rowCount() != 0 {
		t.Error("the table form says the same")
	}
}

func TestAFailedPollKeepsTheLastAnswerAndSaysSo(t *testing.T) {
	m := fixture(t).WithSize(120, 20)
	m.slowPending = 1
	next, _ := m.Update(flowsMsg(flows.Result{Note: "flow: timed out after 10s", Failed: true, At: now}))
	m = next.(Model)
	if len(m.flows.Stuck) != 4 || !m.flows.Failed {
		t.Errorf("the last answer stays, marked stale: %+v", m.flows.Note)
	}
	if out := m.Render(); !strings.Contains(out, "timed out") || !strings.Contains(out, "as of 13:40:56") {
		t.Errorf("the line should carry the failure and the age:\n%s", out)
	}
}

// ---- every definition in one table ------------------------------------------

func TestTheFlowsTableListsEveryDefinition(t *testing.T) {
	m := press(fixture(t).WithSize(120, 20), "2", "p", "down") // p hides the flow pane, so the table has the width

	if m.rowCount() != len(m.flows.Flows) {
		t.Fatalf("every flow, all definitions: %d of %d", m.rowCount(), len(m.flows.Flows))
	}
	out := m.Render()
	// The columns are flow's own record; a link name is the project's word, and stays in the pane.
	for _, want := range []string{"definition", "state", "age", "started", "duration", "waits", "landing", "request", "session"} {
		if !strings.Contains(out, want) {
			t.Errorf("the table should carry %q:\n%s", want, out)
		}
	}
	head := strings.Split(out, "\n")[3] // the column header
	for _, gone := range []string{"actor", "branch", "repo", "task", "id", "seq", "touched"} {
		if strings.Contains(head, gone) {
			t.Errorf("a link name should not be a column: %q in %q", gone, head)
		}
	}
}

func TestDNoLongerChoosesADefinition(t *testing.T) {
	m := press(fixture(t).WithSize(120, 20), "2", "d")
	if m.rowCount() != len(m.flows.Flows) {
		t.Errorf("d does nothing: %d rows", m.rowCount())
	}
	if strings.Contains(m.Render(), "definition  stuck") {
		t.Error("no chooser on the bar")
	}
}

func TestTheFlowPaneShowsTheFlowUnderTheCursor(t *testing.T) {
	m := press(fixture(t).WithSize(120, 20), "2", "down") // the request a session waits on
	if !m.split() {
		t.Fatal("the flows pane splits at 120 columns")
	}
	if m.panelTrace == nil || m.panelTrace.id != m.flowRows()[1].ID || !m.panelTrace.loading {
		t.Fatalf("the pane asks for the selected flow's trace: %+v", m.panelTrace)
	}
	out := m.Render()
	for _, want := range []string{"flow ── request · todo", "help-requested-by-web-ui", "stuck", "── links", "── trace", "asking flow…"} {
		if !strings.Contains(out, want) {
			t.Errorf("the panel should carry %q:\n%s", want, out)
		}
	}
	m = withTrace(t, m, m.panelTrace.id)
	out = m.Render()
	if m.panelTrace.loading || !strings.Contains(out, "→ queued") || !strings.Contains(out, "exitCode=0") {
		t.Errorf("the pane shows each move by its seq, state change and result:\n%s", out)
	}
	if !strings.Contains(out, "verdict=clean") || strings.Contains(out, "2026-09-09 11:37:00") {
		t.Errorf("the pane shows the result, not flow's printed line:\n%s", out)
	}
	golden(t, "flows-split-120x20", m.Render())
	m = press(m, "down") // the blocked session below it, which waits on it
	out = m.Render()
	if !strings.Contains(out, "waits on") || !strings.Contains(out, "(todo)") {
		t.Errorf("a waiting flow says what it waits on and where that stands:\n%s", out)
	}
	if m.panelTrace.id != m.flowRows()[2].ID || !m.panelTrace.loading {
		t.Error("moving the cursor asks for that flow's trace")
	}
	m = press(m, "end") // the session still waiting on the request that was canceled
	if !strings.Contains(m.Render(), "(canceled)") {
		t.Errorf("a dead wait says so:\n%s", m.Render())
	}
}

func TestRightFocusesTheTaskPaneThenOpensTheTask(t *testing.T) {
	m := press(fixture(t).WithSize(140, 20), "down", "down")
	if !m.split() || m.focus != focusLeft {
		t.Fatal("the list has the keys to start with")
	}
	m = press(m, "l")
	if m.focus != focusRight || m.detail != nil {
		t.Fatalf("l moves to the task pane rather than opening it: focus %d detail %+v", m.focus, m.detail)
	}
	m = press(m, "l")
	if m.detail == nil || m.detail.Slug != m.rows()[2].Slug {
		t.Fatalf("l from the pane opens the task full width: %+v", m.detail)
	}
	m = press(m, "esc", "p", "l")
	if m.detail == nil {
		t.Error("with the pane hidden l opens the task at once")
	}
}

func TestRightFocusesTheFlowPaneThenOpensTheTrace(t *testing.T) {
	m := press(fixture(t).WithSize(120, 20), "2", "down")
	if m.focus != focusLeft {
		t.Fatal("the list has the keys to start with")
	}
	m = press(m, "l")
	if m.focus != focusRight || m.trace != nil {
		t.Fatalf("l focuses the flow pane rather than opening the trace: focus %d trace %+v", m.focus, m.trace)
	}
	next, cmd := m.Update(tea.KeyPressMsg{Code: 'l', Text: "l"})
	m = next.(Model)
	if cmd == nil || m.trace == nil || m.trace.id != m.flowRows()[1].ID {
		t.Fatalf("l from the pane opens the trace full width: %+v", m.trace)
	}
	if m = press(m, "esc"); m.trace != nil {
		t.Error("esc closes the trace")
	}
	// With the pane hidden there is nothing to focus, so l opens the trace at once.
	m = press(m, "esc", "p", "l")
	if m.trace == nil {
		t.Error("l opens the trace when the list has the screen")
	}
}

func TestTheFlowPanesTraceScrollsAndIsReread(t *testing.T) {
	m := withTrace(t, press(fixture(t).WithSize(120, 20), "2"), "")
	first := m.Render()
	m = press(m, "tab", "down", "down")
	if m.focus != focusRight || m.detailOff != 2 {
		t.Fatalf("tab focuses the pane and the movement keys scroll the trace: %d %d", m.focus, m.detailOff)
	}
	if m.Render() == first {
		t.Error("the trace should have scrolled")
	}
	// A later flow poll marks the trace for a reread, and the next message asks for it.
	next, _ := m.Update(flowsMsg(m.flows))
	m = next.(Model)
	if !m.panelTrace.loading {
		t.Error("a poll rereads the trace beside the list")
	}
}

func TestPHidesTheFlowPaneAndTabFocusesIt(t *testing.T) {
	m := press(fixture(t).WithSize(120, 20), "2", "p")
	if m.split() || !strings.Contains(m.Render(), "p flow pane") {
		t.Error("p hides the flow pane and the bar offers it back")
	}
	m = press(m, "p", "tab")
	if !m.split() || m.focus != focusRight {
		t.Error("p shows it again and tab focuses it")
	}
	if m = press(m, "esc"); m.focus != focusLeft {
		t.Error("esc goes back to the list")
	}
}

// ---- the pod pane -----------------------------------------------------------

func TestGoldenPod120(t *testing.T) {
	m := press(fixture(t).WithSize(120, 20), "3", "down")
	if m.pane != panePod || m.rowCount() != 4 || m.cursor != 1 {
		t.Fatalf("pane %d rows %d cursor %d", m.pane, m.rowCount(), m.cursor)
	}
	golden(t, "pod-120x20", m.Render())
}

func TestGoldenPod80(t *testing.T) {
	golden(t, "pod-80x18", press(fixture(t).WithSize(80, 18), "3").Render())
}

func TestEnterOnAWorkspaceOpensIt(t *testing.T) {
	m := press(fixture(t).WithSize(100, 20), "3", "down", "enter")
	if m.wsDetail == nil || m.wsDetail.ID != "w3" {
		t.Fatalf("detail: %+v", m.wsDetail)
	}
	out := m.Render()
	for _, want := range []string{"workspace ── w3 · desktop-owner/add-place-entity", "agent/desktop-owner/add-place-entity", "w3:p2", "/worktrees/app/agent-desktop-owner-add-place-entity"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q:\n%s", want, out)
		}
	}
	golden(t, "workspace-100x20", out)
	if m = press(m, "esc"); m.wsDetail != nil {
		t.Error("esc closes it")
	}
}

func TestPodDownIsOneAmberLine(t *testing.T) {
	st, err := pod.ParseStatus(readFixture(t, "pod", "status-stopped.json"))
	if err != nil {
		t.Fatal(err)
	}
	m := fixture(t).WithSize(120, 20).WithPod(pod.Result{Status: st, At: now})
	if out := m.Render(); !strings.Contains(out, "pod      ○ heai-workshop stopped") || !strings.Contains(out, "pod ○") {
		t.Errorf("the line and the header meter should say it is down:\n%s", out)
	}
	m = press(m, "3")
	if out := m.Render(); !strings.Contains(out, "○ heai-workshop stopped") || m.rowCount() != 0 {
		t.Errorf("the table form says the same:\n%s", out)
	}
	m = fixture(t).WithSize(120, 20).WithPod(pod.Result{Note: "not configured here (no pod.yaml or pod/ in the project)", At: now})
	if out := m.Render(); !strings.Contains(out, "pod      not configured here") {
		t.Errorf("unconfigured:\n%s", out)
	}
}

func TestPodKeepsTheLastAnswerWhenAPollFails(t *testing.T) {
	m := fixture(t).WithSize(120, 20)
	m.slowPending = 1
	next, _ := m.Update(podMsg(pod.Result{Note: "pod: timed out after 10s", Failed: true, At: now}))
	m = next.(Model)
	if len(m.pod.Workspaces) != 4 || !m.pod.Failed || !strings.Contains(m.Render(), "⚠ pod: timed out") {
		t.Errorf("the last answer stays, marked stale:\n%s", m.Render())
	}
}

// ---- the reactor pane -------------------------------------------------------

func TestGoldenReactor120(t *testing.T) {
	m := press(fixture(t).WithSize(120, 24), "4")
	if m.pane != paneReactor || m.rowCount() != 3 {
		t.Fatalf("pane %d rows %d", m.pane, m.rowCount())
	}
	golden(t, "reactor-120x24", m.Render())
}

func TestGoldenReactor80(t *testing.T) {
	golden(t, "reactor-80x20", press(fixture(t).WithSize(80, 20), "4").Render())
}

func TestReactorLineAndMeterCarryTheProblemsAndTheFailure(t *testing.T) {
	out := fixture(t).WithSize(140, 20).Render()
	if !strings.Contains(out, "reactor  ● clock  ● tasks_cli  ● drops  ○ github  ○ health   3 events/1h · 4 rules · 1 failed") {
		t.Errorf("the line:\n%s", out)
	}
	if !strings.Contains(out, "reactor 3/1h ✗1") {
		t.Errorf("the meter:\n%s", out)
	}
	m := fixture(t)
	if !m.reactor.Red() || !m.Red() {
		t.Error("a rule that ran and failed in the last hour is red")
	}
}

func TestEnterOnAnEventOpensItWithItsActions(t *testing.T) {
	m := press(fixture(t).WithSize(100, 24), "4", "enter") // the newest: the dropped fact that failed its rule
	if m.evDetail == nil || m.evDetail.Source != "drops" {
		t.Fatalf("detail: %+v", m.evDetail)
	}
	out := m.Render()
	for _, want := range []string{"event ── " + m.evDetail.ID, `"flow": "20260906-024801-session-77f0"`, "session-exited", "exited 3", "/repo/reactor/actions/" + m.evDetail.ID + ".session-exited.log"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q:\n%s", want, out)
		}
	}
	golden(t, "event-100x24", out)
	if m = press(m, "esc"); m.evDetail != nil {
		t.Error("esc closes it")
	}
}

func TestReactorFilterMatchesTheRuleToo(t *testing.T) {
	m := press(fixture(t).WithSize(120, 24), "4", "/", "s", "w", "e", "e", "p", "enter")
	if n := m.rowCount(); n != 1 || m.eventRows()[0].Source != "clock" {
		t.Errorf("filter by rule: %d rows", n)
	}
}

func TestReactorAbsentIsOneDimLine(t *testing.T) {
	m := fixture(t).WithSize(120, 20).WithReactor(reactor.Result{Note: "heai-reactor not on PATH", At: now})
	if out := m.Render(); !strings.Contains(out, "reactor  heai-reactor not on PATH") || strings.Contains(out, "reactor 3/1h") {
		t.Errorf("the line should say why and the header should carry no meter:\n%s", out)
	}
	if m = press(m, "4"); m.rowCount() != 0 || !strings.Contains(m.Render(), "heai-reactor not on PATH") {
		t.Error("the table form says the same")
	}
}

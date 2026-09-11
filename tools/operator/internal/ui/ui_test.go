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
	if m.split() {
		t.Error("only the tasks pane splits")
	}
	if n := m.rowCount(); n != 4 {
		t.Errorf("the flows table has the stuck report's rows: %d", n)
	}
	m = press(m, "3")
	if m.pane != panePod || m.rowCount() != 4 {
		t.Errorf("3 selects pod: pane %d rows %d", m.pane, m.rowCount())
	}
	if m = press(m, "1"); m.pane != paneTasks {
		t.Error("1 selects tasks")
	}
}

func TestGoldenFlows120(t *testing.T) {
	m := press(fixture(t).WithSize(120, 20), "2", "down", "down")
	golden(t, "flows-120x20", m.Render())
}

func TestGoldenFlows80(t *testing.T) {
	m := press(fixture(t).WithSize(80, 18), "2")
	golden(t, "flows-80x18", m.Render())
}

func TestAStuckFlowWhoseWaitIsDeadIsRed(t *testing.T) {
	m := press(fixture(t).WithSize(120, 20), "2")
	m.opts.Plain = false
	out := m.Render()
	if !strings.Contains(out, "canceled") {
		t.Fatal("the canceled request should show under stands")
	}
	// Plain rendering carries no colour; the model says which rows are red.
	if !m.flows.Red() || !m.Red() {
		t.Error("a wait standing at canceled is red")
	}
}

func TestEnterOnAStuckFlowOpensItsTrace(t *testing.T) {
	m := press(fixture(t).WithSize(100, 18), "2", "down", "down")
	next, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	if cmd == nil || m.trace == nil || !m.trace.loading || m.trace.id != "20260903-101010-session-1f2e" {
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

// ---- the flows pane under a definition --------------------------------------

func TestDOpensTheDefinitionChooserAndEnterShowsThatDefinition(t *testing.T) {
	m := press(fixture(t).WithSize(120, 20), "2", "d")
	if !m.choosing || m.choice != 0 {
		t.Fatalf("d should open the chooser on the stuck report: %+v", m.choosing)
	}
	if got := strings.Join(m.flowChoices(), ","); got != ",landing,request,session" {
		t.Errorf("choices are the stuck report then every definition by name: %q", got)
	}
	golden(t, "flows-choose-120x20", m.Render())
	m = press(m, "right", "right", "right", "enter")
	if m.choosing || m.flowDef != "session" || m.pane != paneFlows {
		t.Fatalf("enter shows the chosen definition: choosing %v def %q", m.choosing, m.flowDef)
	}
	if m.rowCount() != 4 {
		t.Errorf("the session flows: %d rows", m.rowCount())
	}
	m = press(m, "down")
	golden(t, "flows-session-120x20", m.Render())
	golden(t, "flows-session-80x18", m.WithSize(80, 18).Render())
	if !strings.Contains(m.Render(), "actor") || !strings.Contains(m.Render(), "branch") {
		t.Error("the columns are the definition's links")
	}
}

func TestChooserDigitsPickAndEscKeepsWhatWasShown(t *testing.T) {
	m := press(fixture(t).WithSize(120, 20), "2", "d", "2")
	if m.choosing || m.flowDef != "landing" || m.rowCount() != 1 {
		t.Errorf("2 picks the first definition: %q %d", m.flowDef, m.rowCount())
	}
	m = press(m, "d", "left", "esc")
	if m.choosing || m.flowDef != "landing" {
		t.Error("esc keeps the definition that was showing")
	}
	m = press(m, "d", "1")
	if m.flowDef != "" || m.rowCount() != 4 {
		t.Errorf("1 is the stuck report again: %q %d", m.flowDef, m.rowCount())
	}
	if m = press(m, "1", "d"); m.choosing {
		t.Error("d does nothing outside the flows pane")
	}
}

func TestEnterUnderADefinitionOpensThatFlowsTrace(t *testing.T) {
	m := press(fixture(t).WithSize(100, 18), "2", "d", "4", "down")
	next, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	if cmd == nil || m.trace == nil || m.trace.id != m.flows.OfDefinition("session")[1].ID {
		t.Fatalf("enter should ask for the second session's trace: %+v", m.trace)
	}
}

func TestADefinitionWithNoFlowsSaysSo(t *testing.T) {
	m := fixture(t).WithSize(120, 20)
	m.flows.Definitions = append(m.flows.Definitions, flows.Definition{Name: "release"})
	m = press(m, "2", "d", "3") // the stuck report, landing, then release by name
	if m.flowDef != "release" || m.rowCount() != 0 || !strings.Contains(m.Render(), "no flows of definition release") {
		t.Errorf("%q\n%s", m.flowDef, m.Render())
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

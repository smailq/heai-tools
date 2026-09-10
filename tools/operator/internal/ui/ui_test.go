package ui

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/smailq/heai-tools/tools/operator/internal/actions"
	"github.com/smailq/heai-tools/tools/operator/internal/flows"
	"github.com/smailq/heai-tools/tools/operator/internal/owners"
	"github.com/smailq/heai-tools/tools/operator/internal/tracker"
	"github.com/smailq/heai-tools/tools/operator/internal/workspaces"
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
	sessions, err := flows.ParseList(readFixture(t, "flow", "list-session.json"))
	if err != nil {
		t.Fatal(err)
	}
	ws, err := workspaces.Parse(readFixture(t, "pod", "list.json"))
	if err != nil {
		t.Fatal(err)
	}
	opts := Options{TasksDir: filepath.Join("/repo", "tasks"), Interval: 2 * time.Second, Plain: true, Now: func() time.Time { return now }}
	m := New(opts).WithSnapshot(snap)
	m = m.WithFlows(flows.Result{Flows: list, Stuck: stuck, At: now.Add(-4 * time.Second)})
	m = m.WithSessions(Sessions{Flows: sessions, Workspaces: workspaces.Result{Workspaces: ws, At: now.Add(-4 * time.Second)}, At: now.Add(-4 * time.Second)})
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

// pressCmd presses one key and returns the command it produced.
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

func TestEditorOpensOnTheSelectedTask(t *testing.T) {
	m := press(fixture(t).WithSize(120, 20), "down", "down", "e") // document-tabs: blocked, high
	if m.edit == nil || m.edit.slug != "document-tabs" {
		t.Fatalf("editor: %+v", m.edit)
	}
	if tracker.Statuses[m.edit.status] != "blocked" || priorityChoices[m.edit.priority] != "high" {
		t.Errorf("editor starts at the task's values: %d %d", m.edit.status, m.edit.priority)
	}
	golden(t, "editor-120x20", m.Render())
}

func TestEditorKeysMoveAndCancel(t *testing.T) {
	m := press(fixture(t).WithSize(120, 18), "e") // add-place-entity: in-progress, high
	m = press(m, "right", "right", "down", "left")
	if tracker.Statuses[m.edit.status] != "blocked" || priorityChoices[m.edit.priority] != "urgent" {
		t.Errorf("moves: %s %s", tracker.Statuses[m.edit.status], priorityChoices[m.edit.priority])
	}
	m = press(m, "1")
	if priorityChoices[m.edit.priority] != "" {
		t.Errorf("digit picks: %q", priorityChoices[m.edit.priority])
	}
	if m = press(m, "esc"); m.edit != nil {
		t.Error("esc cancels")
	}
}

func TestEnterWithoutAChangeJustCloses(t *testing.T) {
	m := press(fixture(t).WithSize(120, 18), "e")
	next, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if cmd != nil || next.(Model).edit != nil {
		t.Error("nothing changed, so nothing should run")
	}
}

func TestEnterWithAChangeRunsTaskManagerAndTheOutcomeShows(t *testing.T) {
	m := press(fixture(t).WithSize(120, 18), "e", "right") // in-progress → in-review
	if c := m.edit.change(); c.Status == nil || *c.Status != "in-review" || c.Priority != nil {
		t.Fatalf("change: %+v", c)
	}
	next, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	if cmd == nil || m.edit != nil {
		t.Fatal("a change should return the command and close the editor")
	}
	// Feed the outcome as the command would, without running tasks here.
	r := actions.Result{Command: "tasks set add-place-entity --status=in-review --dir /repo/tasks", ExitCode: 1, Summary: "refused"}
	next, _ = m.Update(actionMsg(r))
	m = next.(Model)
	if !m.noticeRed || !strings.Contains(m.Render(), "tasks set add-place-entity --status=in-review") {
		t.Errorf("notice:\n%s", m.Render())
	}
	if m = press(m, "down"); m.notice != "" {
		t.Error("the next key clears the notice")
	}
}

func TestNoticeKeepsTheOutcomeWhenTheCommandIsLong(t *testing.T) {
	long := "tasks set some-task --status=blocked --dir /a/very/long/path/that/goes/on/and/on/tasks"
	n := noticeLine(long, "Updated items/some-task.md: status", 80)
	if len([]rune(n)) > 80 || !strings.HasSuffix(n, "Updated items/some-task.md: status") || !strings.Contains(n, "…") {
		t.Errorf("%q", n)
	}
	if n := noticeLine("short", "ok", 80); n != "short  →  ok" {
		t.Errorf("%q", n)
	}
}

func TestClearingPriorityIsAnEmptyValue(t *testing.T) {
	m := press(fixture(t).WithSize(120, 18), "e", "down", "1")
	if c := m.edit.change(); c.Priority == nil || *c.Priority != "" {
		t.Errorf("change: %+v", c)
	}
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
	for _, p := range []string{"1", "2", "3"} {
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
	if m.pane != paneSessions || m.rowCount() != 4 {
		t.Errorf("3 selects sessions: pane %d rows %d", m.pane, m.rowCount())
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
	m := fixture(t).WithSize(120, 20).WithFlows(flows.Result{Note: "flow not on PATH", At: now})
	out := m.Render()
	if !strings.Contains(out, "flows    flow not on PATH") {
		t.Errorf("the line should say why:\n%s", out)
	}
	m = press(m, "2")
	if !strings.Contains(m.Render(), "flow not on PATH") || m.rowCount() != 0 {
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
	m.slowPending = 1
	next, _ = m.Update(sessionsMsg(Sessions{Note: "flow: timed out after 10s", Failed: true, At: now}))
	if n := len(next.(Model).sessions.Flows); n != 4 {
		t.Errorf("sessions keep their last answer too: %d", n)
	}
}

// ---- the sessions pane ------------------------------------------------------

func TestGoldenSessions120(t *testing.T) {
	m := press(fixture(t).WithSize(120, 20), "3", "down")
	golden(t, "sessions-120x20", m.Render())
}

func TestGoldenSessions80(t *testing.T) {
	m := press(fixture(t).WithSize(80, 18), "3")
	golden(t, "sessions-80x18", m.Render())
}

func TestNoSessionFlowsIsADimLine(t *testing.T) {
	m := fixture(t).WithSize(120, 20).WithSessions(Sessions{Note: "no session flows", Workspaces: workspaces.Result{Note: "pod not on PATH", At: now}, At: now})
	out := m.Render()
	if !strings.Contains(out, "sessions no session flows   workspaces: pod not on PATH") {
		t.Errorf("the line should say both:\n%s", out)
	}
	m = press(m, "3")
	if out := m.Render(); !strings.Contains(out, "no session flows") || !strings.Contains(out, "pod not on PATH") {
		t.Errorf("the table form says the same:\n%s", out)
	}
}

func TestCOffersTheProjectsCancelScriptOrSaysThereIsNone(t *testing.T) {
	m := press(fixture(t).WithSize(120, 20), "3")
	m.opts.Project = t.TempDir()
	m = press(m, "c")
	if m.pending != nil || !strings.Contains(m.notice, "no cancel script") {
		t.Errorf("no script: %q %+v", m.notice, m.pending)
	}
	if err := os.MkdirAll(filepath.Join(m.opts.Project, "scripts", "session"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(m.opts.Project, actions.CancelScript), []byte("#!/bin/sh\necho canceled $1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	m = press(m, "c")
	if m.pending == nil || m.pending.command != "scripts/session/cancel.sh 20260906-031244-session-9a1c" {
		t.Fatalf("pending: %+v", m.pending)
	}
	if !strings.Contains(m.Render(), "scripts/session/cancel.sh 20260906-031244-session-9a1c   y run") {
		t.Errorf("the bar shows the command before y:\n%s", m.Render())
	}
	if m = press(m, "n"); m.pending != nil {
		t.Error("any other key cancels")
	}
	m, cmd := pressCmd(press(m, "c"), "y")
	if cmd == nil || m.pending != nil {
		t.Fatal("y runs it")
	}
	if r, ok := cmd().(actionMsg); !ok || !actions.Result(r).OK() || actions.Result(r).Summary != "canceled 20260906-031244-session-9a1c" {
		t.Errorf("outcome: %+v", cmd())
	}
	// A session already over is not offered.
	m = press(fixture(t).WithSize(120, 20), "3", "down", "down", "c") // the clean one
	if m.pending != nil || !strings.Contains(m.notice, "is clean already") {
		t.Errorf("terminal: %q", m.notice)
	}
}

// ---- a, s ----------------------------------------------------------------------

func TestAOffersFlowStartSessionForATaskWithOneOwner(t *testing.T) {
	m := press(fixture(t).WithSize(120, 18), "p") // do-the-thing: api → api-owner
	for i := 0; i < 5; i++ {
		m = press(m, "down")
	}
	if m.selected().Slug != "do-the-thing" {
		t.Fatalf("cursor on %s", m.selected().Slug)
	}
	m = press(m, "a")
	want := "flow start session --link task=do-the-thing --link actor=api-owner --link repo=app --map /repo/architecture.yaml"
	if m.pending == nil || m.pending.command != want {
		t.Fatalf("pending: %+v", m.pending)
	}
	golden(t, "pending-120x18", m.Render())
	if m = press(m, "esc"); m.pending != nil {
		t.Error("esc cancels")
	}
}

func TestASaysWhyWhenATaskCannotBeStarted(t *testing.T) {
	m := press(fixture(t).WithSize(120, 20), "a") // add-place-entity: core,desktop → two actors
	if m.pending != nil || !strings.Contains(m.notice, "routes to core-reviewer,desktop-owner") {
		t.Errorf("two actors: %q", m.notice)
	}
	m = press(fixture(t).WithSize(120, 20), "b", "down", "down", "down", "down", "down", "down", "down", "a") // broken: invalid
	if m.pending != nil || !strings.Contains(m.notice, "not a valid task file") {
		t.Errorf("invalid: %q (on %s)", m.notice, m.selected().Slug)
	}
	m = fixture(t).WithSize(120, 20)
	m.snap.Owners.Repos = nil
	for i := 0; i < 5; i++ {
		m = press(m, "down")
	}
	if m = press(m, "a"); m.pending != nil || !strings.Contains(m.notice, "no repository") {
		t.Errorf("no repository: %q", m.notice)
	}
	if m = press(fixture(t).WithSize(120, 20), "2", "a"); m.pending != nil || m.notice != "" {
		t.Error("a does nothing outside the tasks pane")
	}
}

func TestSRunsReactorTickAndShowsTheOutcome(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	m, cmd := pressCmd(fixture(t).WithSize(120, 20), "s")
	if cmd == nil {
		t.Fatal("s should run reactor tick")
	}
	next, _ := m.Update(cmd())
	m = next.(Model)
	if !m.noticeRed || !strings.Contains(m.Render(), "reactor tick  →  reactor not on PATH") {
		t.Errorf("notice:\n%s", m.Render())
	}
}

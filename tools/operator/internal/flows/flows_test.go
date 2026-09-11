package flows

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// testdata/flow/ at the tool's root is recorded flow output: the format contract this package reads.
func fixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "flow", name))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestParseRecordedList(t *testing.T) {
	list, err := ParseList(fixture(t, "list.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 7 {
		t.Fatalf("flows: %d", len(list))
	}
	byID := Index(list)
	c := byID["20260906-031244-session-9a1c"]
	if c.Definition != "session" || c.State != "running" || c.Terminal || c.Link("actor") != "desktop-owner" || c.Link("branch") != "agent/desktop-owner/add-place-entity" {
		t.Errorf("running session: %+v", c)
	}
	if c.TouchedAt == nil || *c.TouchedAt != "2026-09-09T13:37:00.000Z" || c.ExpiresAt == nil {
		t.Errorf("touch and lease: %+v", c)
	}
	if got := c.SinceTime(); got != time.Date(2026, 9, 9, 13, 35, 0, 0, time.UTC) {
		t.Errorf("since: %s", got)
	}
	d := byID["20260905-235010-session-e4a2"]
	if !d.Terminal || d.State != "clean" || d.Parent != nil {
		t.Errorf("clean session: %+v", d)
	}
	l := byID["20260906-000200-landing-04e8"]
	if l.Parent == nil || *l.Parent != d.ID || l.About() != "lane core" {
		t.Errorf("landing: %+v", l)
	}
	r := byID["20260906-030500-request-9a01"]
	if r.About() != "task help-requested-by-web-ui" {
		t.Errorf("about: %q", r.About())
	}
	if (Flow{Links: map[string]string{"z": "1", "a": "2"}}).About() != "a 2" {
		t.Error("about falls back to the first link by name")
	}
}

// testdata/flow/definitions.json is `heai-flow definitions --json` recorded from sample_project, its path rewritten to /repo.
func TestParseDefinitionsAndTheNamesAResultKnows(t *testing.T) {
	defs, err := ParseDefinitions(fixture(t, "definitions.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(defs) != 3 || defs[0].Name != "landing" || defs[0].Problem != nil || len(defs[2].States) != 11 {
		t.Errorf("definitions: %+v", defs)
	}
	r := Result{Definitions: defs, Flows: []Flow{{ID: "x", Definition: "zebra"}, {ID: "y", Definition: "session"}}}
	if names := r.DefinitionNames(); strings.Join(names, ",") != "landing,request,session,zebra" {
		t.Errorf("names: %v", names)
	}
	if of := r.OfDefinition("session"); len(of) != 1 || of[0].ID != "y" {
		t.Errorf("of session: %+v", of)
	}
	if _, err := ParseDefinitions([]byte(`{}`)); err == nil {
		t.Error("expected an error")
	}
}

func TestListSessionIsTheSameShape(t *testing.T) {
	list, err := ParseList(fixture(t, "list-session.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 4 {
		t.Errorf("sessions: %d", len(list))
	}
	for _, f := range list {
		if f.Definition != "session" {
			t.Errorf("not a session: %s", f.ID)
		}
	}
	empty, err := ParseList(fixture(t, "list-empty.json"))
	if err != nil || len(empty) != 0 {
		t.Errorf("empty list: %v %v", empty, err)
	}
}

func TestParseRecordedStuckAndWhereEachStands(t *testing.T) {
	stuck, err := ParseStuck(fixture(t, "stuck.json"))
	if err != nil {
		t.Fatal(err)
	}
	list, _ := ParseList(fixture(t, "list.json"))
	byID := Index(list)
	if len(stuck) != 4 {
		t.Fatalf("stuck: %d", len(stuck))
	}
	var blockedOnTodo, blockedOnCanceled *Stuck
	for i := range stuck {
		switch stuck[i].Flow.ID {
		case "20260906-024801-session-77f0":
			blockedOnTodo = &stuck[i]
		case "20260903-101010-session-1f2e":
			blockedOnCanceled = &stuck[i]
		}
	}
	if blockedOnTodo == nil || blockedOnCanceled == nil {
		t.Fatal("both blocked sessions should be stuck")
	}
	if got := blockedOnTodo.Idle().Truncate(time.Minute); got != 2*time.Hour {
		t.Errorf("idle: %s", got)
	}
	if w := blockedOnTodo.WaitsOn(byID); w != "task help-requested-by-web-ui" {
		t.Errorf("waits on: %q", w)
	}
	if s, red := blockedOnTodo.Stands(byID); s != "todo" || red {
		t.Errorf("todo is not red: %q %v", s, red)
	}
	if s, red := blockedOnCanceled.Stands(byID); s != "canceled" || !red {
		t.Errorf("canceled is terminal and not done, so red: %q %v", s, red)
	}
	missing := Stuck{Waits: []Wait{{ID: "gone"}}}
	if s, red := missing.Stands(byID); s != "missing" || !red {
		t.Errorf("a missing flow is red: %q %v", s, red)
	}
	done := "done"
	fine := Stuck{Waits: []Wait{{ID: "x", State: &done}}}
	if _, red := fine.Stands(map[string]Flow{"x": {ID: "x", State: "done", Terminal: true}}); red {
		t.Error("done is the terminal state a guard wants")
	}
	r := Result{Flows: list, Stuck: stuck}
	if !r.Red() {
		t.Error("the result is red while one wait stands at canceled")
	}
}

func TestCountGroupsByDefinitionOpenStatesFirst(t *testing.T) {
	list, _ := ParseList(fixture(t, "list.json"))
	counts := Count(list)
	if len(counts) != 3 || counts[0].Definition != "landing" || counts[1].Definition != "request" || counts[2].Definition != "session" {
		t.Fatalf("definitions in name order: %+v", counts)
	}
	s := counts[2]
	if s.Total != 4 || s.Open != 3 {
		t.Errorf("sessions: %+v", s)
	}
	if s.States[0].State != "blocked" || s.States[0].Count != 2 || s.States[1].State != "running" || s.States[2].State != "clean" || !s.States[2].Terminal {
		t.Errorf("open states first, most first, terminal last: %+v", s.States)
	}
}

func TestConfiguredLooksBesideTheMapWithoutCreatingAnything(t *testing.T) {
	t.Setenv("HEAI_FLOW_STATE", "")
	dir := t.TempDir()
	mapPath := filepath.Join(dir, "architecture.yaml")
	if ok, why := Configured(mapPath); ok || why == "" {
		t.Errorf("nothing beside the map: %v %q", ok, why)
	}
	if ok, _ := Configured(""); ok {
		t.Error("no map, not configured")
	}
	if err := os.WriteFile(filepath.Join(dir, "flow.yaml"), []byte("definitions: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if ok, _ := Configured(mapPath); !ok {
		t.Error("flow.yaml beside the map is enough")
	}
	if _, err := os.Stat(filepath.Join(dir, "flow")); err == nil {
		t.Error("asking must not create flow/")
	}
	t.Setenv("HEAI_FLOW_STATE", "/elsewhere")
	if ok, _ := Configured(""); !ok {
		t.Error("HEAI_FLOW_STATE says where flow is")
	}
}

func TestPollWithoutFlowIsANoteNotAnError(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	r := Poll("/nowhere/architecture.yaml", time.Now())
	if r.Note != "heai-flow not on PATH" || r.Failed || len(r.Flows) != 0 {
		t.Errorf("%+v", r)
	}
}

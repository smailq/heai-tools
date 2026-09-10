package workspaces

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// testdata/pod/list.json at the tool's root is the design's `list --json` shape, pinned until the tool records its own.
func TestParsePinnedList(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "pod", "list.json"))
	if err != nil {
		t.Fatal(err)
	}
	list, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 {
		t.Fatalf("workspaces: %d", len(list))
	}
	w := list[0]
	if w.ID != "w3" || w.Label != "desktop-owner/add-place-entity" || w.Repo != "app" || w.Branch != "agent/desktop-owner/add-place-entity" {
		t.Errorf("workspace: %+v", w)
	}
	if w.Agent.Kind != "claude" || w.Agent.Name != "desktop-owner" || w.Agent.State != "running" {
		t.Errorf("agent: %+v", w.Agent)
	}
	counts := CountByState(list)
	if len(counts) != 3 || counts[0].State != "blocked" || counts[1].State != "idle" || counts[2].State != "running" {
		t.Errorf("counts by state, in name order: %+v", counts)
	}
	if _, err := Parse([]byte(`{"not":"an array"}`)); err == nil {
		t.Error("expected an error")
	}
}

func TestPollWithoutTheToolIsANote(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	r := Poll(time.Now())
	if r.Note != "pod not on PATH" || r.Failed {
		t.Errorf("%+v", r)
	}
}

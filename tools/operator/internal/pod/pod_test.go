package pod

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func read(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "pod", name))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// testdata/pod/ is `heai-pod status --json` and `heai-pod list --json` recorded through the tool against its fake runtime.
func TestParseRecordedStatusAndList(t *testing.T) {
	st, err := ParseStatus(read(t, "status.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !st.Up() || st.Summary() != "heai-workshop running · herdr 0.9.0" || *st.Workspaces != 4 {
		t.Errorf("status: %+v %q", st, st.Summary())
	}
	if c := st.AgentCounts(); len(c) != 3 || c[0].State != "blocked" || c[1].State != "idle" || c[2].State != "working" {
		t.Errorf("agents by state, ties by name: %+v", c)
	}
	list, err := ParseList(read(t, "list.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 4 || list[0].Linked || list[0].Label != "app" || list[0].Branch != "main" {
		t.Errorf("the clone comes first, unlinked: %+v", list[0])
	}
	w := list[1]
	if w.ID != "w3" || w.Actor != "desktop-owner" || w.Repo != "app" || w.Branch != "agent/desktop-owner/add-place-entity" || w.Status != "working" {
		t.Errorf("workspace: %+v", w)
	}
	if w.AgentText() != "claude w3" || len(w.Panes) != 2 || w.Panes[1].State != "working" {
		t.Errorf("agent and panes: %q %+v", w.AgentText(), w.Panes)
	}
	if c := CountByStatus(list); len(c) != 3 || c[0].Count != 1 {
		t.Errorf("linked workspaces by status: %+v", c)
	}
	if _, err := ParseList([]byte(`{"not":"an array"}`)); err == nil {
		t.Error("expected an error")
	}
}

func TestAStoppedContainerIsAnAnswer(t *testing.T) {
	st, err := ParseStatus(read(t, "status-stopped.json"))
	if err != nil {
		t.Fatal(err)
	}
	if st.Up() || st.Summary() != "heai-workshop stopped" || st.Herdr != nil || st.Workspaces != nil {
		t.Errorf("%+v %q", st, st.Summary())
	}
	var none *Status
	if none.Up() || none.Summary() != "no container" {
		t.Error("a nil status is no container")
	}
}

func TestConfiguredLooksForPodYamlOrState(t *testing.T) {
	t.Setenv("HEAI_POD_STATE", "")
	dir := t.TempDir()
	if ok, why := Configured(dir); ok || why == "" {
		t.Error("an empty project is not configured")
	}
	if err := os.WriteFile(filepath.Join(dir, "pod.yaml"), []byte("name: x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if ok, _ := Configured(dir); !ok {
		t.Error("pod.yaml configures it")
	}
	t.Setenv("HEAI_POD_STATE", "/elsewhere")
	if ok, _ := Configured(""); !ok {
		t.Error("HEAI_POD_STATE configures it")
	}
}

func TestPollWithoutTheToolIsANote(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	r := Poll(t.TempDir(), time.Now())
	if r.Note != "heai-pod not on PATH" || r.Failed {
		t.Errorf("%+v", r)
	}
}

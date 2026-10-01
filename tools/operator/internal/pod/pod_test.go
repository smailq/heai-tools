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
	if !st.Up() || st.Summary() != "heai-workshop running" || st.QueueText() != "1 running · 1 queued · 3 done" {
		t.Errorf("status: %+v %q %q", st, st.Summary(), st.QueueText())
	}
	if c := st.DoneCounts(); len(c) != 3 || c[0].State != "canceled" || c[1].State != "failed" || c[2].State != "ok" {
		t.Errorf("done by status, ties by name: %+v", c)
	}
	list, err := ParseList(read(t, "list.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 5 || list[0].Name != "web-ui-document-tabs" || list[0].Place != "queued" || list[0].State() != "queued" || list[0].Started() != "" {
		t.Errorf("queued first: %+v", list[0])
	}
	running := list[1]
	if running.Name != "desktop-owner-add-place-entity" || running.State() != "running" || running.Worker() != "w1" || running.Started() != "2026-09-25T10:00:00.000Z" || running.Exit() != "" {
		t.Errorf("running: %+v", running)
	}
	if list[2].State() != "ok" || list[2].Exit() != "0" || list[2].Path != "/repo/pod/work_queue/.done/api-owner-cache-the-index" {
		t.Errorf("ok, with the host path rewritten: %+v", list[2])
	}
	failed := list[3]
	if failed.Name != "core-reviewer-merge-two-entities" || failed.State() != "failed" || failed.Exit() != "3" || failed.Duration() != "1m31s" || failed.Worker() != "w1" {
		t.Errorf("failed: %+v", failed)
	}
	if list[4].State() != "canceled" || list[4].Exit() != "-1" || list[4].Result.Signal != "TERMINATED" || list[4].Duration() != "4.2s" {
		t.Errorf("canceled: %+v", list[4])
	}
	if c := CountByState(list); len(c) != 5 || c[0].Count != 1 || c[0].State != "canceled" {
		t.Errorf("jobs by state: %+v", c)
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
	if st.Up() || st.Summary() != "heai-workshop stopped" || st.Queue.Queued != 1 {
		t.Errorf("%+v %q", st, st.Summary())
	}
	var none *Status
	if none.Up() || none.Summary() != "no container" || none.QueueText() != "" {
		t.Error("a nil status is no container")
	}
}

func TestJobText(t *testing.T) {
	if got := (Job{Place: "done"}).State(); got != "no result" {
		t.Errorf("a done directory without a result: %q", got)
	}
	for d, want := range map[time.Duration]string{1234 * time.Millisecond: "1.2s", 91234 * time.Millisecond: "1m31s", 3723 * time.Second: "1h2m"} {
		if got := FormatDuration(d); got != want {
			t.Errorf("%s: %q, want %q", d, got, want)
		}
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "stdout"), []byte("a\nb\nc\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := Tail(filepath.Join(dir, "stdout"), 2); got != "b\nc" {
		t.Errorf("tail: %q", got)
	}
	if got := Tail(filepath.Join(dir, "missing"), 2); got != "" {
		t.Errorf("missing: %q", got)
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

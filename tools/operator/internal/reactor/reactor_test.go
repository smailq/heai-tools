package reactor

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

var root = filepath.Join("..", "..", "testdata", "reactor")

func read(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(root, name))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// testdata/reactor/ is `heai-reactor status --json` and `heai-reactor events --since 1h --json`, recorded by
// testdata/record.sh from one emit, one dropped fact and two ticks against a five-source configuration,
// with the project's path rewritten to /repo. Times are whatever the recording's clock said.
func TestParseRecordedStatus(t *testing.T) {
	st, err := ParseStatus(read(t, "status.json"))
	if err != nil {
		t.Fatal(err)
	}
	if st.State != "/repo/reactor" || len(st.Sources) != 5 || len(st.Rules) != 4 || st.Events.LastHour != 3 {
		t.Fatalf("status: %+v", st)
	}
	clock, cli, hook, poll := st.Sources[0], st.Sources[1], st.Sources[3], st.Sources[4]
	if clock.Cadence() != "every 10s" || cli.Cadence() != "from emit" || hook.Cadence() != "listens /hook/github" {
		t.Errorf("cadence: %q %q %q", clock.Cadence(), cli.Cadence(), hook.Cadence())
	}
	if clock.Problem() != "" || hook.Problem() != "env:GITHUB_HOOK_SECRET is not set" || poll.Problem() != "fetch failed" {
		t.Errorf("problems: %q %q", hook.Problem(), poll.Problem())
	}
	if st.Problems() != 2 || clock.LastEventTime().IsZero() || !hook.LastEventTime().IsZero() {
		t.Errorf("problems %d, last events %v %v", st.Problems(), clock.LastEventTime(), hook.LastEventTime())
	}
	sweep, exited, merged := st.Rules[0], st.Rules[2], st.Rules[3]
	if sweep.LastAction == nil || sweep.LastAction.Result() != "ok" || sweep.LastAction.Command() != "scripts/sweep.sh" {
		t.Errorf("sweep: %+v", sweep.LastAction)
	}
	if exited.LastAction == nil || !exited.LastAction.Failed() || exited.LastAction.Result() != "exited 3" {
		t.Errorf("session-exited: %+v", exited.LastAction)
	}
	if merged.LastAction != nil || merged.Limit == nil || merged.Limit.String() != "10/hour" {
		t.Errorf("pr-merged: %+v", merged)
	}
}

func TestParseRecordedEventsNewestFirstAndTheirActions(t *testing.T) {
	events, err := ParseEvents(read(t, "events.json"))
	if err != nil {
		t.Fatal(err)
	}
	// The fact was dropped and the emit made in the same second, after the clock's slot; ties fall to the higher id.
	if len(events) != 3 || events[0].Source != "drops" || events[1].Source != "tasks_cli" || events[2].Source != "clock" {
		t.Fatalf("order: %+v", events)
	}
	if !events[0].AtTime().After(events[2].AtTime()) {
		t.Error("newest first")
	}
	if events[0].Payload["flow"] != "20260906-024801-session-77f0" {
		t.Errorf("payload: %+v", events[0].Payload)
	}
	for _, e := range events {
		if len(e.Actions) != 1 || e.Actions[0].Event != e.ID {
			t.Errorf("each event carries its one action: %s %+v", e.ID, e.Actions)
		}
	}
	if a := events[0].Actions[0]; a.Rule != "session-exited" || !a.Failed() || a.Result() != "exited 3" || a.Command() != "exit 3" || a.Log() == "" {
		t.Errorf("the failed run: %+v", a)
	}
	r := Result{Events: events}
	if f := r.FailedActions(); len(f) != 1 || f[0].Event != events[0].ID || !r.Red() {
		t.Errorf("failed: %+v", f)
	}
	if _, err := ParseEvents([]byte(`{}`)); err == nil {
		t.Error("expected an error")
	}
}

func TestActionResults(t *testing.T) {
	limited := Action{Outcome: map[string]interface{}{"limited": true}}
	if !limited.Limited() || limited.Failed() || limited.Result() != "limited" {
		t.Errorf("%+v", limited)
	}
	if (Action{}).Result() != "failed" {
		t.Error("no error, not ok, not limited: failed")
	}
	if Short(500*time.Millisecond) != "500ms" || Short(300000*time.Millisecond) != "5m" || (Limit{3, 86400000}).String() != "3/day" {
		t.Error("durations and limits")
	}
}

func TestConfiguredLooksForTheConfigurationOrState(t *testing.T) {
	t.Setenv("HEAI_REACTOR_STATE", "")
	dir := t.TempDir()
	if ok, why := Configured(dir); ok || why == "" {
		t.Error("an empty project is not configured")
	}
	if err := os.MkdirAll(filepath.Join(dir, ".heai"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".heai", "reactor.yaml"), []byte("rules: []\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if ok, _ := Configured(dir); !ok {
		t.Error(".heai/reactor.yaml configures it")
	}
	t.Setenv("HEAI_REACTOR_STATE", "/elsewhere")
	if ok, _ := Configured(""); !ok {
		t.Error("HEAI_REACTOR_STATE configures it")
	}
}

func TestPollWithoutTheToolIsANote(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	r := Poll(t.TempDir(), time.Now())
	if r.Note != "heai-reactor not on PATH" || r.Failed {
		t.Errorf("%+v", r)
	}
}

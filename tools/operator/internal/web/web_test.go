package web

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smailq/heai-tools/tools/operator/internal/flows"
	"github.com/smailq/heai-tools/tools/operator/internal/owners"
	"github.com/smailq/heai-tools/tools/operator/internal/pod"
	"github.com/smailq/heai-tools/tools/operator/internal/reactor"
	"github.com/smailq/heai-tools/tools/operator/internal/tracker"
	"github.com/smailq/heai-tools/tools/operator/internal/ui"
)

// The minute the flow fixtures were recorded against, as the ui tests use.
var now = time.Date(2026, 9, 9, 13, 41, 0, 0, time.UTC)

func readFixture(t *testing.T, parts ...string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(append([]string{"..", "..", "testdata"}, parts...)...))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// must fails a fixture that does not parse; a panic is enough, since it names the fixture's error.
func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

// fixture is a server seeded with the recorded outputs, never asking a tool.
func fixture(t *testing.T) *httptest.Server {
	t.Helper()
	tr := must(tracker.Load(filepath.Join("..", "tracker", "testdata", "tracker")))
	st := State{
		Snap: ui.Snapshot{
			Tracker: tr,
			MapPath: "/repo/architecture.yaml",
			Owners:  owners.Result{Owners: owners.Owners{"core": "core-reviewer", "desktop": "desktop-owner", "ui": "ui-owner"}},
			At:      now,
		},
		Flows: flows.Result{
			Definitions: must(flows.ParseDefinitions(readFixture(t, "flow", "definitions.json"))),
			Flows:       must(flows.ParseList(readFixture(t, "flow", "list.json"))),
			Stuck:       must(flows.ParseStuck(readFixture(t, "flow", "stuck.json"))),
			At:          now,
		},
		Pod: pod.Result{
			Status:     must(pod.ParseStatus(readFixture(t, "pod", "status.json"))),
			Workspaces: must(pod.ParseList(readFixture(t, "pod", "list.json"))),
			At:         now,
		},
		Reactor: reactor.Result{
			Status: must(reactor.ParseStatus(readFixture(t, "reactor", "status.json"))),
			Events: must(reactor.ParseEvents(readFixture(t, "reactor", "events.json"))),
			At:     now,
		},
	}
	s := New(ui.Options{TasksDir: "/repo/tasks", Project: "/repo", Now: func() time.Time { return now }})
	s.trace = func(_, _ string) (flows.Timeline, error) {
		return flows.ParseTrace(readFixture(t, "flow", "trace.json"))
	}
	s.Seed(st)
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return srv
}

func get(t *testing.T, srv *httptest.Server, path string) (int, string) {
	t.Helper()
	resp, err := http.Get(srv.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

func TestEachPaneIsATab(t *testing.T) {
	srv := fixture(t)
	for _, c := range []struct {
		path string
		want []string
	}{
		{"/tasks", []string{`class="tab on"><b>tasks`, "add-place-entity", "desktop-owner", "help-requested-by-web-ui"}},
		{"/tasks?active=1&sort=slug", []string{"── active", `class="on">slug`}},
		{"/flows", []string{`class="tab on"><b>flows`, "20260906-024801-session-77f0", "stuck", "definitions"}},
		{"/pod", []string{`class="tab on"><b>pod`, "heai-workshop", "(the clone)", "agent/desktop-owner/add-place-entity"}},
		{"/reactor", []string{`class="tab on"><b>reactor`, "sources", "rules", "events"}},
	} {
		code, body := get(t, srv, c.path)
		if code != http.StatusOK {
			t.Fatalf("%s: status %d\n%s", c.path, code, body)
		}
		for _, w := range c.want {
			if !strings.Contains(body, w) {
				t.Errorf("%s: missing %q", c.path, w)
			}
		}
		// Every page carries all four tabs.
		for _, tab := range []string{`href="/tasks"`, `href="/flows"`, `href="/pod"`, `href="/reactor"`} {
			if !strings.Contains(body, tab) {
				t.Errorf("%s: missing tab %s", c.path, tab)
			}
		}
	}
}

func TestRowPages(t *testing.T) {
	srv := fixture(t)
	for _, c := range []struct{ path, want string }{
		{"/tasks/document-tabs", "help-requested-by-web-ui"},
		{"/flows/20260906-024801-session-77f0", "trace"},
		{"/pod/w3", "agent-desktop-owner-add-place-entity"},
		{"/reactor/20260911-030505-73776c", "payload"},
	} {
		code, body := get(t, srv, c.path)
		if code != http.StatusOK || !strings.Contains(body, c.want) {
			t.Errorf("%s: status %d, want %q in the page", c.path, code, c.want)
		}
	}
	for _, p := range []string{"/tasks/nope", "/flows/--help", "/pod/w9", "/reactor/nope"} {
		if code, _ := get(t, srv, p); code != http.StatusNotFound {
			t.Errorf("%s: status %d, want 404", p, code)
		}
	}
}

func TestRootGoesToTasks(t *testing.T) {
	srv := fixture(t)
	c := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := c.Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound || resp.Header.Get("Location") != "/tasks" {
		t.Fatalf("got %d %q", resp.StatusCode, resp.Header.Get("Location"))
	}
}

func TestReadOnly(t *testing.T) {
	srv := fixture(t)
	for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		req, _ := http.NewRequest(m, srv.URL+"/tasks", strings.NewReader("x"))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusMethodNotAllowed {
			t.Errorf("%s: status %d, want 405", m, resp.StatusCode)
		}
	}
}

func TestAPIState(t *testing.T) {
	srv := fixture(t)
	code, body := get(t, srv, "/api/state")
	if code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	var out struct {
		Tracker struct{ Tasks []any } `json:"tracker"`
		Flows   struct{ Flows []any } `json:"flows"`
		Red     bool                  `json:"red"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Tracker.Tasks) == 0 || len(out.Flows.Flows) == 0 {
		t.Fatalf("empty state: %s", body[:min(200, len(body))])
	}
	// The tracker fixture carries a broken file, so the reading is red.
	if !out.Red {
		t.Error("want red")
	}
}

func TestStatic(t *testing.T) {
	srv := fixture(t)
	for _, p := range []string{"/static/operator.css", "/static/operator.js"} {
		if code, _ := get(t, srv, p); code != http.StatusOK {
			t.Errorf("%s: status %d", p, code)
		}
	}
}

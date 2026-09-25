package web

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smailq/heai-tools/tools/operator/internal/ui"
)

// The map as architect parses it, recorded from testdata/architecture.yaml by
// `heai-architect check testdata/architecture.yaml --format json` (its "map").
func fixtureMap(t *testing.T) (yamlText, jsonText []byte) {
	t.Helper()
	y, err := os.ReadFile(filepath.Join("testdata", "architecture.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	j, err := os.ReadFile(filepath.Join("testdata", "architecture.json"))
	if err != nil {
		t.Fatal(err)
	}
	return y, j
}

// An unchanged map written over its own file is the file, byte for byte: comments,
// blank lines, quoting, literal blocks and both list styles all survive.
func TestSerializeUnchangedIsTheFile(t *testing.T) {
	y, j := fixtureMap(t)
	got, err := jsonToYAML(j, y)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(y) {
		t.Fatalf("round trip changed the file:\n%s", lineDiff(string(y), string(got)))
	}
}

// An edit changes the lines it is about and no others.
func TestSerializeEditTouchesOnlyItsLines(t *testing.T) {
	y, j := fixtureMap(t)
	var m map[string]any
	if err := json.Unmarshal(j, &m); err != nil {
		t.Fatal(err)
	}
	// Re-encode through an ordered edit: swap one value in the raw JSON text.
	edited := bytes.Replace(j, []byte(`"owner": "api-owner"`), []byte(`"owner": "core-owner"`), 1)
	got, err := jsonToYAML(edited, y)
	if err != nil {
		t.Fatal(err)
	}
	a, b := strings.Split(string(y), "\n"), strings.Split(string(got), "\n")
	if len(a) != len(b) {
		t.Fatalf("line count changed %d → %d:\n%s", len(a), len(b), lineDiff(string(y), string(got)))
	}
	var changed []string
	for i := range a {
		if a[i] != b[i] {
			changed = append(changed, b[i])
		}
	}
	if len(changed) != 1 || strings.TrimSpace(changed[0]) != "owner: core-owner" {
		t.Fatalf("want one changed line, got %q", changed)
	}
}

// Without a base - a new map - keys keep the document's order and multiline strings are blocks.
func TestSerializeWithoutBase(t *testing.T) {
	got, err := jsonToYAML([]byte(`{"version":1,"actors":{"b":{"type":"human"},"a":{"type":"llm-agent","context":"one\ntwo\n"}},"territories":{"t":{"scope":[{"repository":"app","globs":["src/**"]}]}}}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	want := "version: 1\nactors:\n  b:\n    type: human\n  a:\n    type: llm-agent\n    context: |\n      one\n      two\nterritories:\n  t:\n    scope:\n      - repository: app\n        globs: [src/**]\n"
	if string(got) != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func lineDiff(a, b string) string {
	al, bl := strings.Split(a, "\n"), strings.Split(b, "\n")
	var out []string
	for i := 0; i < max(len(al), len(bl)); i++ {
		var x, y string
		if i < len(al) {
			x = al[i]
		}
		if i < len(bl) {
			y = bl[i]
		}
		if x != y {
			out = append(out, "- "+x, "+ "+y)
		}
	}
	return strings.Join(out, "\n")
}

// editor is a server whose map is a copy of the fixture in a temporary directory.
func editor(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	y, _ := fixtureMap(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "architecture.yaml")
	if err := os.WriteFile(path, y, 0o640); err != nil {
		t.Fatal(err)
	}
	s := New(ui.Options{TasksDir: filepath.Join(dir, "tasks"), Now: func() time.Time { return now }})
	s.Seed(State{Snap: ui.Snapshot{MapPath: path}})
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return srv, path
}

func send(t *testing.T, method, url string, body any, header map[string]string) (int, map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequest(method, url, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestEditorPageAndFile(t *testing.T) {
	srv, path := editor(t)
	for _, p := range []string{"/map/", "/map/app.js", "/map/style.css", "/map/vendor/cytoscape.min.js", "/map/vendor/cytoscape-fcose.js"} {
		if code, _ := get(t, srv, p); code != http.StatusOK {
			t.Errorf("%s: status %d", p, code)
		}
	}
	code, out := send(t, http.MethodGet, srv.URL+"/map/api/file", nil, nil)
	if code != http.StatusOK || out["path"] != path || out["exists"] != true || out["version"] == "" {
		t.Fatalf("file: %d %v", code, out)
	}
	// The dashboard tabs link to the editor.
	if _, body := get(t, srv, "/tasks"); !strings.Contains(body, `href="/map/"`) {
		t.Error("the tab bar has no map tab")
	}
}

func TestEditorGuards(t *testing.T) {
	srv, _ := editor(t)
	// A rebound DNS name reaching this server is refused, even for a read.
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/map/api/file", nil)
	req.Host = "evil.example"
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("foreign host: %d, want 403", resp.StatusCode)
	}
	// A cross-site page is refused.
	if code, _ := send(t, http.MethodPut, srv.URL+"/map/api/file", map[string]string{"yaml": "x"}, map[string]string{"Origin": "http://evil.example"}); code != http.StatusForbidden {
		t.Errorf("cross origin: %d, want 403", code)
	}
	// A form post is refused.
	req, _ = http.NewRequest(http.MethodPut, srv.URL+"/map/api/file", strings.NewReader("yaml=x"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("form post: %d, want 403", resp.StatusCode)
	}
	// Everything outside the editor's API stays read only.
	if code, _ := send(t, http.MethodPost, srv.URL+"/map/", map[string]string{}, nil); code != http.StatusMethodNotAllowed {
		t.Errorf("POST /map/: %d, want 405", code)
	}
}

// The endpoints that ask architect run only where it is on PATH, as it is in the sample project.
func needArchitect(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("heai-architect"); err != nil {
		t.Skip("heai-architect not on PATH")
	}
}

func TestEditorSave(t *testing.T) {
	needArchitect(t)
	srv, path := editor(t)
	_, file := send(t, http.MethodGet, srv.URL+"/map/api/file", nil, nil)
	base := file["version"].(string)
	orig, _ := os.ReadFile(path)
	edited := strings.Replace(string(orig), "owner: api-owner", "owner: core-owner", 1)

	// Invalid text is not written.
	code, out := send(t, http.MethodPut, srv.URL+"/map/api/file", map[string]any{"yaml": "version: 1\nactors: 3\n", "base": base}, nil)
	if code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid: %d %v", code, out)
	}
	// A save over the version loaded is written, keeping the file's mode.
	code, out = send(t, http.MethodPut, srv.URL+"/map/api/file", map[string]any{"yaml": edited, "base": base}, nil)
	if code != http.StatusOK || out["version"] == base {
		t.Fatalf("save: %d %v", code, out)
	}
	if got, _ := os.ReadFile(path); string(got) != edited {
		t.Fatal("the file is not what was saved")
	}
	if st, _ := os.Stat(path); st.Mode().Perm() != 0o640 {
		t.Errorf("mode %v, want 0640", st.Mode().Perm())
	}
	// A second save from the old version is a conflict, unless forced.
	code, _ = send(t, http.MethodPut, srv.URL+"/map/api/file", map[string]any{"yaml": string(orig), "base": base}, nil)
	if code != http.StatusConflict {
		t.Fatalf("stale save: %d, want 409", code)
	}
	code, _ = send(t, http.MethodPut, srv.URL+"/map/api/file", map[string]any{"yaml": string(orig), "base": base, "force": true}, nil)
	if got, _ := os.ReadFile(path); code != http.StatusOK || string(got) != string(orig) {
		t.Fatalf("forced save: %d", code)
	}
}

func TestEditorValidate(t *testing.T) {
	needArchitect(t)
	srv, _ := editor(t)
	_, j := fixtureMap(t)
	code, out := send(t, http.MethodPost, srv.URL+"/map/api/validate", map[string]json.RawMessage{"map": j}, nil)
	if code != http.StatusOK || out["valid"] != true || out["map"] == nil {
		t.Fatalf("validate map: %d %v", code, out)
	}
	code, out = send(t, http.MethodPost, srv.URL+"/map/api/validate", map[string]string{"yaml": "version: 1\nterritories: {x: {owner: nobody}}\n"}, nil)
	if code != http.StatusOK || out["valid"] != false || len(out["errors"].([]any)) == 0 {
		t.Fatalf("validate invalid: %d %v", code, out)
	}
}

// A project with no map yet gets one: a save over "nothing" creates the file.
func TestEditorCreatesTheMap(t *testing.T) {
	needArchitect(t)
	srv, path := editor(t)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	_, file := send(t, http.MethodGet, srv.URL+"/map/api/file", nil, nil)
	if file["exists"] != false {
		t.Fatalf("file: %v", file)
	}
	y, _ := fixtureMap(t)
	code, out := send(t, http.MethodPut, srv.URL+"/map/api/file", map[string]any{"yaml": string(y), "base": ""}, nil)
	if code != http.StatusOK || out["exists"] != true {
		t.Fatalf("create: %d %v", code, out)
	}
	if got, _ := os.ReadFile(path); string(got) != string(y) {
		t.Fatal("the created file is not what was saved")
	}
}

// The page's own base, not the file on disk, is where a save's comments come from.
func TestSerializeUsesThePagesBase(t *testing.T) {
	srv, path := editor(t)
	y, j := fixtureMap(t)
	if err := os.WriteFile(path, append(y, []byte("# edited elsewhere\n")...), 0o644); err != nil {
		t.Fatal(err)
	}
	code, out := send(t, http.MethodPost, srv.URL+"/map/api/serialize", map[string]any{"map": json.RawMessage(j), "base": string(y)}, nil)
	if code != http.StatusOK || out["yaml"] != string(y) {
		t.Fatalf("serialize: %d\n%v", code, out["yaml"])
	}
}

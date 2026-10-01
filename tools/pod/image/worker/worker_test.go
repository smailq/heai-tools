package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The run.sh every test job carries unless it says otherwise: prints, sleeps
// for `sleep` seconds when that file is present, and exits with `exit` when
// that file is present.
const script = `#!/bin/sh
echo "out $JOB in $JOB_DIR"
echo "err $JOB" >&2
[ -f sleep ] && sleep "$(cat sleep)"
[ -f exit ] && exit "$(cat exit)"
exit 0
`

type world struct {
	t     *testing.T
	queue string
	cfg   Config
}

func newWorld(t *testing.T) *world {
	t.Helper()
	dir := t.TempDir()
	queue := filepath.Join(dir, "work_queue")
	return &world{t: t, queue: queue, cfg: Config{Queue: queue, Name: "me", Workers: 1, Poll: 20 * time.Millisecond}}
}

// job drops a job directory the way a producer does: under a dotted name, then
// renamed; it carries the test run.sh unless `files` names its own, or `norun`.
func (w *world) job(name string, files map[string]string) {
	w.t.Helper()
	tmp := filepath.Join(w.queue, ".tmp-"+name)
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		w.t.Fatal(err)
	}
	if _, has := files[runFile]; !has {
		if _, skip := files["norun"]; !skip {
			if err := os.WriteFile(filepath.Join(tmp, runFile), []byte(script), 0o644); err != nil {
				w.t.Fatal(err)
			}
		}
	}
	for f, body := range files {
		if f == "norun" {
			continue
		}
		if err := os.WriteFile(filepath.Join(tmp, f), []byte(body), 0o644); err != nil {
			w.t.Fatal(err)
		}
	}
	if err := os.Rename(tmp, filepath.Join(w.queue, name)); err != nil {
		w.t.Fatal(err)
	}
}

func (w *world) start(ctx context.Context) <-chan error {
	errc := make(chan error, 1)
	go func() { errc <- Run(ctx, w.cfg) }()
	return errc
}

func (w *world) result(name string) Result {
	w.t.Helper()
	b, err := os.ReadFile(filepath.Join(w.queue, doneDir, name, resultFile))
	if err != nil {
		w.t.Fatal(err)
	}
	var r Result
	if err := json.Unmarshal(b, &r); err != nil {
		w.t.Fatal(err)
	}
	return r
}

func (w *world) exists(rel string) bool {
	_, err := os.Stat(filepath.Join(w.queue, rel))
	return err == nil
}

func (w *world) waitDone(name string, timeout time.Duration) Result {
	w.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if w.exists(filepath.Join(doneDir, name, resultFile)) {
			return w.result(name)
		}
		time.Sleep(10 * time.Millisecond)
	}
	w.t.Fatalf("%s did not finish within %s", name, timeout)
	return Result{}
}

func (w *world) waitFor(rel string, timeout time.Duration) {
	w.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if w.exists(rel) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	w.t.Fatalf("%s did not appear within %s", rel, timeout)
}

func TestOkAndFailedInNameOrder(t *testing.T) {
	w := newWorld(t)
	w.job("b-second", map[string]string{"exit": "3"})
	w.job("a-first", nil)
	w.job(".tmp-half-written", nil)
	if err := os.MkdirAll(w.queue, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(w.queue, "note.txt"), []byte("not a job\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errc := w.start(ctx)

	a := w.waitDone("a-first", 5*time.Second)
	b := w.waitDone("b-second", 5*time.Second)
	if a.Status != "ok" || a.Exit != 0 || a.Worker != "me" || a.Job != "a-first" {
		t.Errorf("a-first: %+v", a)
	}
	if b.Status != "failed" || b.Exit != 3 {
		t.Errorf("b-second: %+v", b)
	}
	if _, err := time.Parse(time.RFC3339, a.Started); err != nil {
		t.Errorf("started %q: %v", a.Started, err)
	}
	if _, err := time.Parse(time.RFC3339, a.Finished); err != nil {
		t.Errorf("finished %q: %v", a.Finished, err)
	}
	if !(a.Finished < b.Finished) {
		t.Errorf("a-first should finish before b-second: %s vs %s", a.Finished, b.Finished)
	}
	out, _ := os.ReadFile(filepath.Join(w.queue, doneDir, "a-first", logDir, "stdout"))
	if !strings.HasPrefix(string(out), "out a-first in "+filepath.Join(w.queue, runningDir, "a-first")) {
		t.Errorf("stdout: %q", out)
	}
	errOut, _ := os.ReadFile(filepath.Join(w.queue, doneDir, "a-first", logDir, "stderr"))
	if string(errOut) != "err a-first\n" {
		t.Errorf("stderr: %q", errOut)
	}
	if w.exists(filepath.Join(doneDir, "a-first", claimFile)) {
		t.Error("claim.json should be gone once done")
	}
	if !w.exists(".tmp-half-written") || !w.exists("note.txt") {
		t.Error("a dotted directory and a plain file are not jobs and stay where they are")
	}
	if w.exists(filepath.Join(doneDir, ".tmp-half-written")) {
		t.Error("a dotted directory was taken")
	}
	cancel()
	if err := <-errc; err != nil {
		t.Fatal(err)
	}
}

func TestTimeoutFromJobJSON(t *testing.T) {
	w := newWorld(t)
	w.job("slow", map[string]string{"sleep": "10", jobFile: `{"timeout": "150ms"}`})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w.start(ctx)
	r := w.waitDone("slow", 5*time.Second)
	if r.Status != "timeout" || r.Exit != -1 || r.Signal != "TERMINATED" {
		t.Errorf("%+v", r)
	}
	if r.DurationMS > 3000 {
		t.Errorf("SIGTERM should have ended it quickly, took %dms", r.DurationMS)
	}
}

func TestDefaultTimeout(t *testing.T) {
	w := newWorld(t)
	w.cfg.Timeout = 150 * time.Millisecond
	w.job("slow", map[string]string{"sleep": "10"})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w.start(ctx)
	if r := w.waitDone("slow", 5*time.Second); r.Status != "timeout" {
		t.Errorf("%+v", r)
	}
}

func TestBadJobJSON(t *testing.T) {
	w := newWorld(t)
	w.job("bad", map[string]string{jobFile: `{"timeout": "soon"}`})
	w.job("worse", map[string]string{jobFile: `{`})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w.start(ctx)
	bad := w.waitDone("bad", 5*time.Second)
	if bad.Status != "failed" || bad.Exit != -1 || !strings.Contains(bad.Error, `timeout "soon"`) {
		t.Errorf("%+v", bad)
	}
	if worse := w.waitDone("worse", 5*time.Second); worse.Status != "failed" || worse.Error == "" {
		t.Errorf("%+v", worse)
	}
	if w.exists(filepath.Join(doneDir, "bad", logDir)) {
		t.Error("a job refused before it ran has no log")
	}
}

func TestCancelFile(t *testing.T) {
	w := newWorld(t)
	w.job("long", map[string]string{"sleep": "10"})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w.start(ctx)
	w.waitFor(filepath.Join(runningDir, "long", claimFile), 5*time.Second)
	b, _ := os.ReadFile(filepath.Join(w.queue, runningDir, "long", claimFile))
	var c Claim
	if json.Unmarshal(b, &c) != nil || c.Worker != "me" || c.Started == "" {
		t.Errorf("claim: %s", b)
	}
	if err := os.WriteFile(filepath.Join(w.queue, runningDir, "long", cancelFile), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	r := w.waitDone("long", 5*time.Second)
	if r.Status != "canceled" || r.Exit != -1 {
		t.Errorf("%+v", r)
	}
	if w.exists(filepath.Join(doneDir, "long", cancelFile)) {
		t.Error("the cancel file is removed with the claim")
	}
}

func TestShutdownCancelsRunningJobs(t *testing.T) {
	w := newWorld(t)
	w.job("long", map[string]string{"sleep": "10"})
	ctx, cancel := context.WithCancel(context.Background())
	errc := w.start(ctx)
	w.waitFor(filepath.Join(runningDir, "long", claimFile), 5*time.Second)
	cancel()
	select {
	case err := <-errc:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after ctx was canceled")
	}
	if r := w.result("long"); r.Status != "canceled" {
		t.Errorf("%+v", r)
	}
}

func TestRecoverOwnLeftovers(t *testing.T) {
	w := newWorld(t)
	mine := filepath.Join(w.queue, runningDir, "mine")
	theirs := filepath.Join(w.queue, runningDir, "theirs")
	orphan := filepath.Join(w.queue, runningDir, "orphan")
	for _, d := range []string{mine, theirs, orphan} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	os.WriteFile(filepath.Join(mine, claimFile), []byte(`{"worker":"me","started":"2026-09-25T10:00:00Z"}`), 0o644)
	os.WriteFile(filepath.Join(theirs, claimFile), []byte(`{"worker":"other","started":"2026-09-25T10:00:00Z"}`), 0o644)
	ctx, cancel := context.WithCancel(context.Background())
	w.start(ctx)
	r := w.waitDone("mine", 5*time.Second)
	if r.Status != "crashed" || r.Started != "2026-09-25T10:00:00.000Z" || r.Exit != -1 {
		t.Errorf("%+v", r)
	}
	if o := w.waitDone("orphan", 5*time.Second); o.Status != "crashed" {
		t.Errorf("%+v", o)
	}
	time.Sleep(100 * time.Millisecond)
	if !w.exists(filepath.Join(runningDir, "theirs", claimFile)) {
		t.Error("another worker's job was touched")
	}
	cancel()
}

func TestWorkersRunSideBySide(t *testing.T) {
	w := newWorld(t)
	w.cfg.Workers = 3
	for _, n := range []string{"x", "y", "z"} {
		w.job(n, map[string]string{"sleep": "1"})
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w.start(ctx)
	begin := time.Now()
	for _, n := range []string{"x", "y", "z"} {
		if r := w.waitDone(n, 5*time.Second); r.Status != "ok" {
			t.Errorf("%s: %+v", n, r)
		}
	}
	if took := time.Since(begin); took > 2500*time.Millisecond {
		t.Errorf("three one-second jobs on three workers took %s", took)
	}
}

func TestAJobWithoutRunShIsRefused(t *testing.T) {
	w := newWorld(t)
	w.job("j", map[string]string{"norun": "", "prompt.md": "do it\n"})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w.start(ctx)
	r := w.waitDone("j", 5*time.Second)
	if r.Status != "failed" || r.Exit != -1 || r.Error != "no run.sh in the job" {
		t.Errorf("%+v", r)
	}
	if w.exists(filepath.Join(doneDir, "j", logDir)) {
		t.Error("a job refused before it ran has no log")
	}
}

func TestRunShNeedNotBeExecutable(t *testing.T) {
	w := newWorld(t)
	w.job("plain", map[string]string{runFile: "echo ran > out.txt\n"})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w.start(ctx)
	if r := w.waitDone("plain", 5*time.Second); r.Status != "ok" {
		t.Errorf("%+v", r)
	}
	if b, _ := os.ReadFile(filepath.Join(w.queue, doneDir, "plain", "out.txt")); string(b) != "ran\n" {
		t.Errorf("run.sh runs with the job as its cwd: %q", b)
	}
}

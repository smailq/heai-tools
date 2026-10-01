// The protocol, from the worker's side. A job is a directory at the top of the
// queue whose name does not start with a dot; claiming it is one rename into
// .running/, running it is `sh run.sh` in it, finishing it is a result.json
// written by write-and-rename and one rename into .done/. Nothing inside the
// job is read except job.json, and only its timeout.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	runningDir = ".running"
	doneDir    = ".done"
	claimFile  = "claim.json"
	resultFile = "result.json"
	cancelFile = "cancel"
	jobFile    = "job.json"
	runFile    = "run.sh"
	logDir     = "log"
	// how long a job gets between SIGTERM and SIGKILL when it is stopped
	grace = 5 * time.Second
)

type Config struct {
	Queue   string
	Name    string
	Workers int
	Poll    time.Duration
	// The timeout for a job whose job.json names none; 0 is no limit.
	Timeout time.Duration
	Log     *log.Logger
}

// Claim sits in .running/<job>/ while the job runs.
type Claim struct {
	Worker  string `json:"worker"`
	Started string `json:"started"`
}

// Result is .done/<job>/result.json.
type Result struct {
	Job    string `json:"job"`
	Status string `json:"status"`
	// The script's exit code; -1 when it died of a signal or never ran.
	Exit       int    `json:"exit"`
	Signal     string `json:"signal,omitempty"`
	Error      string `json:"error,omitempty"`
	Started    string `json:"started"`
	Finished   string `json:"finished"`
	DurationMS int64  `json:"duration_ms"`
	Worker     string `json:"worker"`
}

type jobSpec struct {
	Timeout string `json:"timeout"`
}

const stamp = "2006-01-02T15:04:05.000Z07:00" // RFC 3339 with milliseconds; time.RFC3339 parses it

// Run watches the queue until ctx is done, then stops every running job as
// canceled and returns.
func Run(ctx context.Context, cfg Config) error {
	if cfg.Workers < 1 {
		cfg.Workers = 1
	}
	if cfg.Poll <= 0 {
		cfg.Poll = 2 * time.Second
	}
	if cfg.Log == nil {
		cfg.Log = log.New(io.Discard, "", 0)
	}
	for _, d := range []string{cfg.Queue, filepath.Join(cfg.Queue, runningDir), filepath.Join(cfg.Queue, doneDir)} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	if err := recoverLeftovers(cfg); err != nil {
		return err
	}
	slots := make(chan struct{}, cfg.Workers)
	var wg sync.WaitGroup
	for {
		for len(slots) < cap(slots) {
			name, ok := claim(cfg)
			if !ok {
				break
			}
			slots <- struct{}{}
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer func() { <-slots }()
				runJob(ctx, cfg, name)
			}()
		}
		select {
		case <-ctx.Done():
			wg.Wait()
			return nil
		case <-time.After(cfg.Poll):
		}
	}
}

// recoverLeftovers finishes, as crashed, whatever this worker left under
// .running/ when it last died. Another worker's claims are left alone; a
// claimless entry has no owner and is taken as this worker's.
func recoverLeftovers(cfg Config) error {
	entries, err := os.ReadDir(filepath.Join(cfg.Queue, runningDir))
	if err != nil {
		return err
	}
	for _, e := range entries {
		dir := filepath.Join(cfg.Queue, runningDir, e.Name())
		if !isDir(dir) {
			continue
		}
		var c Claim
		if b, err := os.ReadFile(filepath.Join(dir, claimFile)); err == nil {
			if json.Unmarshal(b, &c) == nil && c.Worker != "" && c.Worker != cfg.Name {
				continue
			}
		}
		started := time.Now()
		if t, err := time.Parse(time.RFC3339, c.Started); err == nil {
			started = t
		} else if fi, err := os.Stat(dir); err == nil {
			started = fi.ModTime()
		}
		finish(cfg, e.Name(), Result{Job: e.Name(), Status: "crashed", Exit: -1, Worker: cfg.Name, Started: started.UTC().Format(stamp)}, started)
	}
	return nil
}

func isDir(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.IsDir()
}

// claim takes the first job in name order that a rename into .running/ wins.
func claim(cfg Config) (string, bool) {
	entries, err := os.ReadDir(cfg.Queue)
	if err != nil {
		cfg.Log.Printf("read %s: %v", cfg.Queue, err)
		return "", false
	}
	var names []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") || !isDir(filepath.Join(cfg.Queue, e.Name())) {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)
	for _, n := range names {
		if err := os.Rename(filepath.Join(cfg.Queue, n), filepath.Join(cfg.Queue, runningDir, n)); err == nil {
			return n, true
		}
	}
	return "", false
}

// jobTimeout is job.json's timeout, 0 when the file or the key is absent.
func jobTimeout(dir string) (time.Duration, error) {
	b, err := os.ReadFile(filepath.Join(dir, jobFile))
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	var spec jobSpec
	if err := json.Unmarshal(b, &spec); err != nil {
		return 0, fmt.Errorf("%s: %v", jobFile, err)
	}
	if spec.Timeout == "" {
		return 0, nil
	}
	d, err := time.ParseDuration(spec.Timeout)
	if err != nil || d < 0 {
		return 0, fmt.Errorf("%s: timeout %q is not a duration like 2h", jobFile, spec.Timeout)
	}
	return d, nil
}

func runJob(ctx context.Context, cfg Config, name string) {
	dir := filepath.Join(cfg.Queue, runningDir, name)
	started := time.Now()
	res := Result{Job: name, Worker: cfg.Name, Started: started.UTC().Format(stamp)}
	if err := writeJSON(filepath.Join(dir, claimFile), Claim{Worker: cfg.Name, Started: res.Started}); err != nil {
		cfg.Log.Printf("%s: claim: %v", name, err)
	}
	cfg.Log.Printf("%s: claimed", name)

	timeout := cfg.Timeout
	if t, err := jobTimeout(dir); err != nil {
		res.Status, res.Exit, res.Error = "failed", -1, err.Error()
		finish(cfg, name, res, started)
		return
	} else if t > 0 {
		timeout = t
	}

	if _, err := os.Stat(filepath.Join(dir, runFile)); err != nil {
		res.Status, res.Exit, res.Error = "failed", -1, "no "+runFile+" in the job"
		finish(cfg, name, res, started)
		return
	}
	if err := os.MkdirAll(filepath.Join(dir, logDir), 0o755); err != nil {
		res.Status, res.Exit, res.Error = "failed", -1, err.Error()
		finish(cfg, name, res, started)
		return
	}
	stdout, err := os.Create(filepath.Join(dir, logDir, "stdout"))
	if err != nil {
		res.Status, res.Exit, res.Error = "failed", -1, err.Error()
		finish(cfg, name, res, started)
		return
	}
	defer stdout.Close()
	stderr, err := os.Create(filepath.Join(dir, logDir, "stderr"))
	if err != nil {
		res.Status, res.Exit, res.Error = "failed", -1, err.Error()
		finish(cfg, name, res, started)
		return
	}
	defer stderr.Close()

	cmd := exec.Command("sh", runFile)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "JOB="+name, "JOB_DIR="+dir)
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		res.Status, res.Exit, res.Error = "failed", -1, err.Error()
		finish(cfg, name, res, started)
		return
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var timer <-chan time.Time
	if timeout > 0 {
		timer = time.After(timeout)
	}
	ticker := time.NewTicker(cfg.Poll)
	defer ticker.Stop()
	var waitErr error
	stopped := false
	for !stopped {
		select {
		case waitErr = <-done:
			stopped = true
			res.Status = "ok"
		case <-timer:
			res.Status = "timeout"
			waitErr = terminate(cmd, done)
			stopped = true
		case <-ticker.C:
			if _, err := os.Stat(filepath.Join(dir, cancelFile)); err == nil {
				res.Status = "canceled"
				waitErr = terminate(cmd, done)
				stopped = true
			}
		case <-ctx.Done():
			res.Status = "canceled"
			waitErr = terminate(cmd, done)
			stopped = true
		}
	}
	res.Exit, res.Signal = exitOf(waitErr)
	if res.Status == "ok" && res.Exit != 0 {
		res.Status = "failed"
	}
	finish(cfg, name, res, started)
}

// terminate stops the script's whole process group: SIGTERM, then SIGKILL
// after the grace period, and returns what Wait said.
func terminate(cmd *exec.Cmd, done <-chan error) error {
	pgid := -cmd.Process.Pid
	_ = syscall.Kill(pgid, syscall.SIGTERM)
	select {
	case err := <-done:
		return err
	case <-time.After(grace):
	}
	_ = syscall.Kill(pgid, syscall.SIGKILL)
	return <-done
}

func exitOf(err error) (int, string) {
	if err == nil {
		return 0, ""
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			return -1, strings.ToUpper(ws.Signal().String())
		}
		return ee.ExitCode(), ""
	}
	return -1, ""
}

// finish writes the result and moves the job under .done/. The result is
// complete before the rename, so the directory never appears without it.
func finish(cfg Config, name string, res Result, started time.Time) {
	now := time.Now()
	res.Finished = now.UTC().Format(stamp)
	res.DurationMS = now.Sub(started).Milliseconds()
	dir := filepath.Join(cfg.Queue, runningDir, name)
	_ = os.Remove(filepath.Join(dir, claimFile))
	_ = os.Remove(filepath.Join(dir, cancelFile))
	if err := writeJSON(filepath.Join(dir, resultFile), res); err != nil {
		cfg.Log.Printf("%s: result: %v", name, err)
		return
	}
	if err := os.Rename(dir, filepath.Join(cfg.Queue, doneDir, name)); err != nil {
		cfg.Log.Printf("%s: move to %s: %v", name, doneDir, err)
		return
	}
	if res.Error != "" {
		cfg.Log.Printf("%s: %s (%s) in %s", name, res.Status, res.Error, now.Sub(started).Round(time.Millisecond))
	} else {
		cfg.Log.Printf("%s: %s, exit %d, in %s", name, res.Status, res.Exit, now.Sub(started).Round(time.Millisecond))
	}
}

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

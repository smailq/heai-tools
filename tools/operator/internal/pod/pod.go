// Package pod asks pod what the container and its queue are doing:
// `heai-pod status --json` for the container and the queue's counts, then
// `heai-pod list --json` for every job - queued, running and done. The list
// is files on the host, so it is asked whether or not the container is up.
// The shapes read here are the tool's own, recorded under testdata/pod/ at
// the root of this tool, and the pane dims when the command is absent,
// unconfigured, or fails.
package pod

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Container is the runtime's word on the container.
type Container struct {
	Name    string `json:"name"`
	State   string `json:"state"`
	Running bool   `json:"running"`
	Image   string `json:"image"`
}

// Counts is the queue as `status` counted it from the host's side.
type Counts struct {
	Queued   int            `json:"queued"`
	Running  int            `json:"running"`
	Done     int            `json:"done"`
	ByStatus map[string]int `json:"byStatus"`
}

// Status is `heai-pod status --json`: the container is null when it does not exist.
type Status struct {
	Container *Container `json:"container"`
	Queue     Counts     `json:"queue"`
}

// Up reports whether the container is running.
func (s *Status) Up() bool {
	return s != nil && s.Container != nil && s.Container.Running
}

// Summary is the one phrase for the container: "heai-workshop running", "heai-workshop stopped", "no container".
func (s *Status) Summary() string {
	if s == nil || s.Container == nil {
		return "no container"
	}
	return s.Container.Name + " " + s.Container.State
}

// QueueText is the queue in one phrase: "1 running · 2 queued · 3 done".
func (s *Status) QueueText() string {
	if s == nil {
		return ""
	}
	q := s.Queue
	return fmt.Sprintf("%d running · %d queued · %d done", q.Running, q.Queued, q.Done)
}

// DoneCounts is the finished jobs by status, most first then by name, as `status` counted them.
func (s *Status) DoneCounts() []StateCount {
	if s == nil {
		return nil
	}
	return sortCounts(s.Queue.ByStatus)
}

// Claim is .running/<job>/claim.json, the worker's.
type Claim struct {
	Worker  string `json:"worker"`
	Started string `json:"started"`
}

// Result is .done/<job>/result.json, the worker's.
type JobResult struct {
	Job        string `json:"job"`
	Status     string `json:"status"`
	Exit       int    `json:"exit"`
	Signal     string `json:"signal,omitempty"`
	Error      string `json:"error,omitempty"`
	Started    string `json:"started"`
	Finished   string `json:"finished"`
	DurationMS int64  `json:"duration_ms"`
	Worker     string `json:"worker"`
}

// Job is one entry of `heai-pod list --json`: queued, running with its claim, or done with its result.
type Job struct {
	Name  string `json:"name"`
	Place string `json:"place"`
	// Path is the job's directory on the host.
	Path   string     `json:"path"`
	Claim  *Claim     `json:"claim,omitempty"`
	Result *JobResult `json:"result,omitempty"`
}

// State is what the state column shows: the result's status once done, else the place.
func (j Job) State() string {
	if j.Place == "done" {
		if j.Result == nil {
			return "no result"
		}
		return j.Result.Status
	}
	return j.Place
}

// Worker is who has or had the job, or "".
func (j Job) Worker() string {
	switch {
	case j.Result != nil:
		return j.Result.Worker
	case j.Claim != nil:
		return j.Claim.Worker
	}
	return ""
}

// Started is when the job was claimed, or "".
func (j Job) Started() string {
	switch {
	case j.Result != nil:
		return j.Result.Started
	case j.Claim != nil:
		return j.Claim.Started
	}
	return ""
}

// Exit is the result's exit code as text, or "".
func (j Job) Exit() string {
	if j.Result == nil {
		return ""
	}
	return fmt.Sprintf("%d", j.Result.Exit)
}

// Duration is how long the job ran, "1m31s" or "4.2s", or "".
func (j Job) Duration() string {
	if j.Result == nil {
		return ""
	}
	return FormatDuration(time.Duration(j.Result.DurationMS) * time.Millisecond)
}

// FormatDuration is pod's own shape: seconds with one decimal under a minute, then 1m31s, then 1h2m.
func FormatDuration(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%.1fs", d.Seconds())
	}
	s := int(d.Round(time.Second).Seconds())
	if s < 3600 {
		return fmt.Sprintf("%dm%ds", s/60, s%60)
	}
	return fmt.Sprintf("%dh%dm", s/3600, (s%3600)/60)
}

// StateCount is one state's count.
type StateCount struct {
	State string
	Count int
}

// CountByState counts the jobs by what their state column shows.
func CountByState(list []Job) []StateCount {
	counts := map[string]int{}
	for _, j := range list {
		counts[j.State()]++
	}
	return sortCounts(counts)
}

func sortCounts(counts map[string]int) []StateCount {
	var out []StateCount
	for s, n := range counts {
		out = append(out, StateCount{s, n})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].State < out[j].State
	})
	return out
}

// Tail is the last n lines of a file under the job's directory, "" when it is missing or empty.
func Tail(path string, n int) string {
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) == 0 {
		return ""
	}
	lines := strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// Result is one poll of pod.
type Result struct {
	Status *Status `json:"status"`
	Jobs   []Job   `json:"jobs"`
	// Note says why there is nothing, or why it is old: not on PATH, not configured here, or the command's last line.
	Note   string    `json:"note,omitempty"`
	Failed bool      `json:"failed,omitempty"`
	At     time.Time `json:"at"`
}

// Timeout bounds one call.
var Timeout = 10 * time.Second

// Installed reports whether pod is on PATH.
func Installed() bool {
	_, err := exec.LookPath("heai-pod")
	return err == nil
}

// Configured reports whether pod has anything in this project - pod.yaml, a
// pod/ state directory, or HEAI_POD_STATE pointing elsewhere - and says why
// not. It is asked before polling because `heai-pod status` creates pod/ when
// it is absent, and a screen must not leave a state directory behind.
func Configured(project string) (bool, string) {
	if os.Getenv("HEAI_POD_STATE") != "" {
		return true, ""
	}
	if project == "" {
		return false, "no project directory, so nowhere to look for pod.yaml"
	}
	for _, name := range []string{"pod.yaml", "pod"} {
		if _, err := os.Stat(filepath.Join(project, name)); err == nil {
			return true, ""
		}
	}
	return false, "not configured here (no pod.yaml or pod/ in the project)"
}

// Poll runs `heai-pod status --json`, then `heai-pod list --json`.
func Poll(project string, now time.Time) Result {
	r := Result{At: now}
	if !Installed() {
		r.Note = "heai-pod not on PATH"
		return r
	}
	if ok, why := Configured(project); !ok {
		r.Note = why
		return r
	}
	out, err := run(project, true, "status", "--json")
	if err != nil {
		r.Note, r.Failed = err.Error(), true
		return r
	}
	st, err := ParseStatus(out)
	if err != nil {
		r.Note, r.Failed = "pod: "+err.Error(), true
		return r
	}
	r.Status = st
	out, err = run(project, false, "list", "--json")
	if err != nil {
		r.Note, r.Failed = err.Error(), true
		return r
	}
	list, err := ParseList(out)
	if err != nil {
		r.Note, r.Failed = "pod: "+err.Error(), true
		return r
	}
	r.Jobs = list
	return r
}

// ParseStatus reads the object `heai-pod status --json` prints.
func ParseStatus(raw []byte) (*Status, error) {
	var s Status
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("unexpected status output: %v", err)
	}
	return &s, nil
}

// ParseList reads the array `heai-pod list --json` prints.
func ParseList(raw []byte) ([]Job, error) {
	var list []Job
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("unexpected list output: %v", err)
	}
	return list, nil
}

// run executes heai-pod in the project directory. `status` exits 1 with its
// JSON on stdout when the container is down, which is an answer, not a
// failure: exit1OK keeps that stdout.
func run(project string, exit1OK bool, args ...string) ([]byte, error) {
	bin, err := exec.LookPath("heai-pod")
	if err != nil {
		return nil, errors.New("heai-pod not on PATH")
	}
	if project != "" {
		args = append(args, "--dir", project)
	}
	ctx, cancel := context.WithTimeout(context.Background(), Timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, args...).Output()
	if err != nil {
		var ee *exec.ExitError
		if exit1OK && errors.As(err, &ee) && ee.ExitCode() == 1 && len(out) > 0 {
			return out, nil
		}
		msg := err.Error()
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			lines := strings.Split(strings.TrimSpace(string(ee.Stderr)), "\n")
			msg = lines[len(lines)-1]
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			msg = fmt.Sprintf("timed out after %s", Timeout)
		}
		return nil, errors.New("pod: " + strings.TrimPrefix(msg, "pod: "))
	}
	return out, nil
}

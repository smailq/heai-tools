// Package pod asks pod what the container is doing: `heai-pod status --json`
// for the container and the Herdr server in it, and when both run,
// `heai-pod list --json` for every workspace and the agent in it. The shapes
// read here are the tool's own, recorded under testdata/pod/ at the root of
// this tool, and the pane dims when the command is absent, unconfigured, or fails.
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

// Herdr is the server's word on itself.
type Herdr struct {
	Running bool   `json:"running"`
	Version string `json:"version"`
}

// Status is `heai-pod status --json`: null fields stay nil when what they describe is not running.
type Status struct {
	Container  *Container     `json:"container"`
	Herdr      *Herdr         `json:"herdr"`
	Workspaces *int           `json:"workspaces"`
	Agents     map[string]int `json:"agents"`
}

// Up reports whether both the container and Herdr are running, which is when `list` can be asked.
func (s *Status) Up() bool {
	return s != nil && s.Container != nil && s.Container.Running && s.Herdr != nil && s.Herdr.Running
}

// Summary is the one phrase for the container: "heai-workshop running · herdr 0.9.0", "heai-workshop stopped", "no container".
func (s *Status) Summary() string {
	if s == nil || s.Container == nil {
		return "no container"
	}
	out := s.Container.Name + " " + s.Container.State
	switch {
	case !s.Container.Running:
	case s.Herdr == nil || !s.Herdr.Running:
		out += " · herdr not running"
	case s.Herdr.Version != "":
		out += " · herdr " + s.Herdr.Version
	default:
		out += " · herdr running"
	}
	return out
}

// AgentCounts is the agents by state, most first then by name, as `status` counted them.
func (s *Status) AgentCounts() []StateCount {
	if s == nil {
		return nil
	}
	return sortCounts(s.Agents)
}

// Agent is one agent Herdr runs in a workspace.
type Agent struct {
	Name  string `json:"name"`
	Kind  string `json:"kind"`
	Pane  string `json:"pane"`
	State string `json:"state"`
}

// Pane is one pane of a workspace.
type Pane struct {
	ID    string `json:"id"`
	Agent string `json:"agent"`
	State string `json:"state"`
	Cwd   string `json:"cwd"`
}

// Workspace is one entry of `heai-pod list --json`.
type Workspace struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Repo   string `json:"repo"`
	Branch string `json:"branch"`
	Actor  string `json:"actor"`
	Path   string `json:"path"`
	// Linked is false for the clone itself, which Herdr opens as a workspace when the first worktree is created.
	Linked bool `json:"linked"`
	// Status is the rolled-up agent status Herdr keeps per workspace.
	Status string            `json:"status"`
	Tokens map[string]string `json:"tokens"`
	Agents []Agent           `json:"agents"`
	Panes  []Pane            `json:"panes"`
}

// AgentText names what runs in the workspace: "claude w3", or two agents' names, or "".
func (w Workspace) AgentText() string {
	var parts []string
	for _, a := range w.Agents {
		parts = append(parts, strings.TrimSpace(a.Kind+" "+a.Name))
	}
	return strings.Join(parts, ", ")
}

// StateCount is one state's count.
type StateCount struct {
	State string
	Count int
}

// CountByStatus counts the linked workspaces by their rolled-up status.
func CountByStatus(list []Workspace) []StateCount {
	counts := map[string]int{}
	for _, w := range list {
		if !w.Linked {
			continue
		}
		counts[w.Status]++
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

// Result is one poll of pod.
type Result struct {
	Status     *Status     `json:"status"`
	Workspaces []Workspace `json:"workspaces"`
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

// Poll runs `heai-pod status --json`, then `heai-pod list --json` when the container and Herdr are up.
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
	if !st.Up() {
		return r
	}
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
	r.Workspaces = list
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
func ParseList(raw []byte) ([]Workspace, error) {
	var list []Workspace
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("unexpected list output: %v", err)
	}
	return list, nil
}

// run executes heai-pod in the project directory. `status` exits 1 with its
// JSON on stdout when the container or Herdr is down, which is an answer,
// not a failure: exit1OK keeps that stdout.
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

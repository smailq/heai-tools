// Package workspaces asks pod what is running in the container:
// `pod list --json`, one entry per workspace with the agent in it.
// The tool is being built beside this one; the shape read here is its design's,
// pinned by testdata/pod/list.json at the root of this tool, and
// the pane dims when the command is absent or fails.
package workspaces

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"sort"
	"strings"
	"time"
)

// Agent is what runs in a workspace's root pane.
type Agent struct {
	Kind  string `json:"kind"`
	Name  string `json:"name"`
	State string `json:"state"`
}

// Workspace is one worktree in the container and the agent in it.
type Workspace struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Repo   string `json:"repo"`
	Branch string `json:"branch"`
	Agent  Agent  `json:"agent"`
}

// Result is one poll of pod.
type Result struct {
	Workspaces []Workspace `json:"workspaces"`
	// Note says why the list is empty or old: not on PATH, or the command's last line.
	Note   string    `json:"note,omitempty"`
	Failed bool      `json:"failed,omitempty"`
	At     time.Time `json:"at"`
}

// Timeout bounds one call.
var Timeout = 10 * time.Second

// Installed reports whether pod is on PATH.
func Installed() bool {
	_, err := exec.LookPath("pod")
	return err == nil
}

// Poll runs `pod list --json`.
func Poll(now time.Time) Result {
	r := Result{At: now}
	bin, err := exec.LookPath("pod")
	if err != nil {
		r.Note = "pod not on PATH"
		return r
	}
	ctx, cancel := context.WithTimeout(context.Background(), Timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "list", "--json").Output()
	if err != nil {
		msg := err.Error()
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			lines := strings.Split(strings.TrimSpace(string(ee.Stderr)), "\n")
			msg = lines[len(lines)-1]
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			msg = fmt.Sprintf("timed out after %s", Timeout)
		}
		r.Note, r.Failed = "pod: "+msg, true
		return r
	}
	list, err := Parse(out)
	if err != nil {
		r.Note, r.Failed = "pod: "+err.Error(), true
		return r
	}
	r.Workspaces = list
	return r
}

// Parse reads the array `pod list --json` prints.
func Parse(raw []byte) ([]Workspace, error) {
	var list []Workspace
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("unexpected list output: %v", err)
	}
	return list, nil
}

// CountByState counts workspaces by their agent's state, "-" for none, states in name order.
func CountByState(list []Workspace) []struct {
	State string
	Count int
} {
	counts := map[string]int{}
	for _, w := range list {
		s := w.Agent.State
		if s == "" {
			s = "-"
		}
		counts[s]++
	}
	var out []struct {
		State string
		Count int
	}
	for _, s := range sortedKeys(counts) {
		out = append(out, struct {
			State string
			Count int
		}{s, counts[s]})
	}
	return out
}

func sortedKeys(m map[string]int) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

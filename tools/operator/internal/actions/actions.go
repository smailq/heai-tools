// Package actions is the one place this tool changes anything, and it never
// does so itself: every action is a sibling tool's CLI or the project's own
// script, run verbatim, with its exit code and its last word brought back to
// the screen.
package actions

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Timeout bounds one command.
var Timeout = 15 * time.Second

// Result is what one command came back with.
type Result struct {
	// Command is the exact command line, for the bar and for the record.
	Command string
	// ExitCode is the tool's own: 0 done, 1 refused, 2 could not; -1 when it never ran.
	ExitCode int
	// Summary is the line worth showing: the tool's first stdout line on success, its last stderr line otherwise.
	Summary string
}

// OK reports whether the tool did what was asked.
func (r Result) OK() bool { return r.ExitCode == 0 }

// Change is what SetTask should change; a nil field is left alone, an empty string clears it.
type Change struct {
	Status   *string
	Priority *string
}

// SetTask runs `tasks set <slug> [--status=..] [--priority=..] --dir <tracker>`.
// The `--flag=value` form is used so an empty value reaches the tool as "clear this".
func SetTask(tasksDir, slug string, c Change) Result {
	args := []string{"set", slug}
	if c.Status != nil {
		args = append(args, "--status="+*c.Status)
	}
	if c.Priority != nil {
		args = append(args, "--priority="+*c.Priority)
	}
	args = append(args, "--dir", tasksDir)
	return run("tasks", args, "")
}

// StartSessionCommand is the command `a` shows before it runs: `flow start session`
// linked to the task, the actor it routes to, and the map's repository.
func StartSessionCommand(mapPath, slug, actor, repo string) []string {
	args := []string{"start", "session", "--link", "task=" + slug, "--link", "actor=" + actor, "--link", "repo=" + repo}
	if mapPath != "" {
		args = append(args, "--map", mapPath)
	}
	return args
}

// StartSession runs StartSessionCommand in the project directory.
func StartSession(project, mapPath, slug, actor, repo string) Result {
	return run("flow", StartSessionCommand(mapPath, slug, actor, repo), project)
}

// CancelScript is the project's own cancel script, relative to the project directory.
const CancelScript = "scripts/session/cancel.sh"

// HasCancelScript reports whether the project has a cancel script to run.
func HasCancelScript(project string) bool {
	st, err := os.Stat(filepath.Join(project, CancelScript))
	return err == nil && !st.IsDir()
}

// CancelSession runs `scripts/session/cancel.sh <id>` in the project directory.
// The script is the project's; this tool knows only its path.
func CancelSession(project, id string) Result {
	r := run(filepath.Join(project, CancelScript), []string{id}, project)
	r.Command = CancelScript + " " + id
	return r
}

// ReactorTick runs `reactor tick` in the project directory: one tick of the daemon, on demand.
func ReactorTick(project string) Result {
	return run("reactor", []string{"tick"}, project)
}

func run(name string, args []string, dir string) Result {
	r := Result{Command: name + " " + strings.Join(args, " "), ExitCode: -1}
	bin, err := exec.LookPath(name)
	if err != nil {
		if strings.ContainsRune(name, filepath.Separator) {
			r.Summary = filepath.Base(name) + " not found or not executable"
		} else {
			r.Summary = name + " not on PATH"
		}
		return r
	}
	ctx, cancel := context.WithTimeout(context.Background(), Timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err = cmd.Run()
	switch {
	case err == nil:
		r.ExitCode = 0
		r.Summary = firstLine(stdout.String())
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		r.Summary = fmt.Sprintf("timed out after %s", Timeout)
	default:
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			r.ExitCode = ee.ExitCode()
		}
		r.Summary = lastLine(stderr.String())
		if r.Summary == "" {
			r.Summary = lastLine(stdout.String())
		}
		if r.Summary == "" {
			r.Summary = err.Error()
		}
	}
	return r
}

func firstLine(s string) string {
	for _, l := range strings.Split(s, "\n") {
		if t := strings.TrimSpace(l); t != "" {
			return t
		}
	}
	return ""
}

func lastLine(s string) string {
	lines := strings.Split(s, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if t := strings.TrimSpace(lines[i]); t != "" {
			return t
		}
	}
	return ""
}

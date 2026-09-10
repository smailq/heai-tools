package actions

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fake puts a `tasks` on PATH that prints its arguments and exits as told.
func fake(t *testing.T, script string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell fake")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "tasks")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestSetTaskComposesTheCommandVerbatim(t *testing.T) {
	fake(t, `echo "Updated items/$2.md: status, priority"; echo "Wrote INDEX.md"; echo "args: $*" >&2`)
	todo, none := "todo", ""
	r := SetTask("/repo/tasks", "document-tabs", Change{Status: &todo, Priority: &none})
	if r.Command != "tasks set document-tabs --status=todo --priority= --dir /repo/tasks" {
		t.Errorf("command: %q", r.Command)
	}
	if !r.OK() || r.Summary != "Updated items/document-tabs.md: status, priority" {
		t.Errorf("result: %+v", r)
	}
}

func TestSetTaskLeavesUnnamedFieldsAlone(t *testing.T) {
	fake(t, `echo ok`)
	high := "high"
	r := SetTask("t", "x", Change{Priority: &high})
	if strings.Contains(r.Command, "--status") || !strings.Contains(r.Command, "--priority=high") {
		t.Errorf("command: %q", r.Command)
	}
}

func TestRefusalBringsBackTheReasonAndTheCode(t *testing.T) {
	fake(t, `echo "Invalid task files:" >&2; echo "items/x.md:" >&2; echo '  - status "shipping" not in [...]' >&2; exit 1`)
	s := "shipping"
	r := SetTask("t", "x", Change{Status: &s})
	if r.OK() || r.ExitCode != 1 {
		t.Errorf("exit: %+v", r)
	}
	if !strings.HasPrefix(r.Summary, `- status "shipping"`) {
		t.Errorf("summary: %q", r.Summary)
	}
}

func TestMissingToolIsAResultNotAPanic(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	s := "todo"
	r := SetTask("t", "x", Change{Status: &s})
	if r.OK() || r.ExitCode != -1 || r.Summary != "tasks not on PATH" {
		t.Errorf("%+v", r)
	}
}

func TestStartSessionIsFlowStartVerbatim(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "flow"), []byte("#!/bin/sh\necho 20260909-140000-session-ab12; pwd >&2\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	project := t.TempDir()
	r := StartSession(project, "/p/architecture.yaml", "document-tabs", "ui-owner", "app")
	if r.Command != "flow start session --link task=document-tabs --link actor=ui-owner --link repo=app --map /p/architecture.yaml" {
		t.Errorf("command: %q", r.Command)
	}
	if !r.OK() || r.Summary != "20260909-140000-session-ab12" {
		t.Errorf("result: %+v", r)
	}
}

func TestCancelSessionIsTheProjectsScriptOrNothing(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script")
	}
	project := t.TempDir()
	if HasCancelScript(project) {
		t.Error("no script yet")
	}
	if err := os.MkdirAll(filepath.Join(project, "scripts", "session"), 0o755); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(project, CancelScript)
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho \"canceled $1 in $(basename \"$PWD\")\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !HasCancelScript(project) {
		t.Fatal("the script is there")
	}
	r := CancelSession(project, "20260906-024801-session-77f0")
	if r.Command != "scripts/session/cancel.sh 20260906-024801-session-77f0" {
		t.Errorf("command: %q", r.Command)
	}
	if !r.OK() || r.Summary != "canceled 20260906-024801-session-77f0 in "+filepath.Base(project) {
		t.Errorf("runs in the project directory: %+v", r)
	}
}

func TestReactorTickReportsAnAbsentReactor(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	r := ReactorTick(t.TempDir())
	if r.Command != "reactor tick" || r.OK() || r.Summary != "reactor not on PATH" {
		t.Errorf("%+v", r)
	}
}

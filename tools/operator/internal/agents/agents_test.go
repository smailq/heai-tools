package agents

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var now = time.Date(2026, 9, 9, 13, 41, 0, 0, time.UTC)

// The shape of the real files under .heai/agents/.
const fixtureAgent = `---
name: cli
kind: worker
description: A command-line tool in TypeScript on Node.
---

You are given a task in one territory.

The command is the interface.
`

func TestParseValidAgent(t *testing.T) {
	a := Parse("cli", fixtureAgent)
	if !a.Valid() {
		t.Fatalf("problems: %v", a.Problems)
	}
	if a.Name != "cli" || a.Kind != "worker" || a.Description != "A command-line tool in TypeScript on Node." {
		t.Errorf("fields: %+v", a)
	}
	if !strings.HasPrefix(a.Body, "You are given") || !strings.HasSuffix(a.Body, "the interface.") {
		t.Errorf("body: %q", a.Body)
	}
}

func TestNameMustBeTheFileName(t *testing.T) {
	a := Parse("tui", fixtureAgent)
	if a.Valid() || !strings.Contains(a.Problems[0], `name "cli" is not the file name "tui"`) {
		t.Errorf("got %v", a.Problems)
	}
	if a.Name != "tui" {
		t.Errorf("the agent is listed under its file name: %q", a.Name)
	}
}

func TestEveryProblemReportedInOnePass(t *testing.T) {
	a := Parse("x", "---\nname: x\ncolour: blue\n---\n")
	for _, w := range []string{"unknown frontmatter key: colour", "missing frontmatter key: kind", "missing frontmatter key: description", "prompt must not be empty"} {
		found := false
		for _, p := range a.Problems {
			if strings.Contains(p, w) {
				found = true
			}
		}
		if !found {
			t.Errorf("missing problem %q in %v", w, a.Problems)
		}
	}
}

func TestDescriptionMayContainColons(t *testing.T) {
	raw := strings.Replace(fixtureAgent, "description: A command-line tool in TypeScript on Node.", "description: The judge: decides.", 1)
	if got := Parse("cli", raw).Description; got != "The judge: decides." {
		t.Errorf("got %q", got)
	}
}

func TestMissingFrontmatterIsAProblemNotAPanic(t *testing.T) {
	a := Parse("p", "just prose")
	if a.Valid() || !strings.Contains(a.Problems[0], "opening") || a.Body != "just prose" {
		t.Errorf("got %v %q", a.Problems, a.Body)
	}
}

func TestLoadFixtureDirectory(t *testing.T) {
	r := Load("testdata", now)
	if r.Note != "" || r.Failed {
		t.Fatalf("note %q failed %v", r.Note, r.Failed)
	}
	var names []string
	for _, a := range r.Agents {
		names = append(names, a.Name)
	}
	if got := strings.Join(names, " "); got != "broken cli judge tui" {
		t.Errorf("by name, README.md and notes.txt skipped, broken.md kept: %q", got)
	}
	if r.Agents[1].File != filepath.Join("testdata", "agents", "cli.md") {
		t.Errorf("file: %q", r.Agents[1].File)
	}
	if r.Agents[2].Kind != "gate" || r.Agents[3].Kind != "worker" {
		t.Errorf("kinds: %s %s", r.Agents[2].Kind, r.Agents[3].Kind)
	}
	if r.Agents[0].Valid() || r.Broken() != 1 || !r.Red() {
		t.Errorf("broken.md is listed with its problem: %+v", r.Agents[0])
	}
	if c := CountByKind(r.Agents); len(c) != 2 || c[0] != (KindCount{"worker", 2}) || c[1] != (KindCount{"gate", 1}) {
		t.Errorf("counts: %+v", c)
	}
	if r.Changed.IsZero() {
		t.Error("Changed should be the newest mtime")
	}
	if r.ByName("judge") == nil || r.ByName("README") != nil {
		t.Error("ByName")
	}
}

func TestNoDirectoryIsNotConfigured(t *testing.T) {
	r := Load(t.TempDir(), now)
	if r.Failed || len(r.Agents) != 0 || !strings.Contains(r.Note, "no agents/ in the project") {
		t.Errorf("got %+v", r)
	}
	if r := Load("", now); !strings.Contains(r.Note, "no project directory") {
		t.Errorf("got %+v", r)
	}
}

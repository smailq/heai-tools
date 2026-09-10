package tracker

import (
	"path/filepath"
	"strings"
	"testing"
)

// The same task tasks's own model test parses, so the two readers agree on the contract.
const fixtureTask = `---
title: Do the thing
status: todo
priority: high
territory: api
created_at: 2026-08-20
modified_at: 2026-08-25
---

Some body.
`

func TestParseValidTask(t *testing.T) {
	task := Parse("t", fixtureTask)
	if !task.Valid() {
		t.Fatalf("problems: %v", task.Problems)
	}
	if task.Title != "Do the thing" || task.Status != "todo" || task.Priority != "high" {
		t.Errorf("fields: %+v", task)
	}
	if len(task.Territories) != 1 || task.Territories[0] != "api" {
		t.Errorf("territories: %v", task.Territories)
	}
	if task.CreatedAt != "2026-08-20" || task.ModifiedAt != "2026-08-25" || task.Body != "Some body." {
		t.Errorf("dates/body: %+v", task)
	}
}

func TestEmptyOptionalFieldIsUnsetNotInvalid(t *testing.T) {
	raw := strings.Replace(strings.Replace(fixtureTask, "priority: high", "priority:", 1), "territory: api", "territory:", 1)
	task := Parse("t", raw)
	if !task.Valid() {
		t.Fatalf("problems: %v", task.Problems)
	}
	if task.Priority != "" || len(task.Territories) != 0 {
		t.Errorf("expected unset, got %q %v", task.Priority, task.Territories)
	}
}

func TestEveryProblemReportedInOnePass(t *testing.T) {
	task := Parse("t", "---\ntitle:\nstatus: shipping\npriority: soon\n---\n")
	want := []string{
		"missing frontmatter key: territory",
		"missing frontmatter key: created_at",
		"title must not be empty",
		"body must not be empty",
		`"shipping"`,
		`"soon"`,
	}
	for _, w := range want {
		found := false
		for _, p := range task.Problems {
			if strings.Contains(p, w) {
				found = true
			}
		}
		if !found {
			t.Errorf("missing problem %q in %v", w, task.Problems)
		}
	}
}

func TestTerritoryListIsSortedAndUnique(t *testing.T) {
	raw := strings.Replace(fixtureTask, "territory: api", "territory: web, api,web", 1)
	task := Parse("t", raw)
	if got := strings.Join(task.Territories, ","); got != "api,web" {
		t.Errorf("got %q", got)
	}
}

func TestTitleMayContainColons(t *testing.T) {
	raw := strings.Replace(fixtureTask, "title: Do the thing", "title: Receipts rollup: totals", 1)
	if got := Parse("t", raw).Title; got != "Receipts rollup: totals" {
		t.Errorf("got %q", got)
	}
}

func TestBlockerFromBody(t *testing.T) {
	raw := strings.Replace(fixtureTask, "Some body.", "Tabs.\n\nBlocked by [help-me](help-me.md), requested by `web-ui` in run `2026`.", 1)
	if got := Parse("t", raw).Blocker; got != "help-me" {
		t.Errorf("got %q", got)
	}
	if got := Parse("t", fixtureTask).Blocker; got != "" {
		t.Errorf("expected no blocker, got %q", got)
	}
}

func TestMissingFrontmatterIsAProblemNotAPanic(t *testing.T) {
	task := Parse("t", "just prose")
	if task.Valid() || !strings.Contains(task.Problems[0], "opening") {
		t.Errorf("got %v", task.Problems)
	}
}

func TestLoadFixtureTracker(t *testing.T) {
	tr, err := Load(filepath.Join("testdata", "tracker"))
	if err != nil {
		t.Fatal(err)
	}
	if len(tr.Tasks) != 11 {
		t.Errorf("expected 11 tasks (notes.txt skipped, broken.md kept), got %d", len(tr.Tasks))
	}
	if !strings.HasSuffix(tr.MapPath, filepath.Join("testdata", "architecture.yaml")) {
		t.Errorf("config map not resolved against the tracker: %q", tr.MapPath)
	}
	c := tr.Counts()
	if c["in-progress"] != 1 || c["blocked"] != 3 || c["todo"] != 2 || c["backlog"] != 1 || c["done"] != 1 || c["canceled"] != 1 {
		t.Errorf("counts: %v", c)
	}
	if tr.Changed.IsZero() {
		t.Error("Changed should be the newest mtime")
	}
}

func TestPickupOrder(t *testing.T) {
	tr, err := Load(filepath.Join("testdata", "tracker"))
	if err != nil {
		t.Fatal(err)
	}
	var slugs []string
	for _, task := range tr.Tasks {
		slugs = append(slugs, task.Slug)
	}
	want := "add-place-entity inline-images-from-eml document-tabs merge-two-entities multiple-workspaces do-the-thing help-requested-by-web-ui receipts-rollup-view old-and-done ontology-entity-identity broken"
	if got := strings.Join(slugs, " "); got != want {
		t.Errorf("order\n got %s\nwant %s", got, want)
	}
}

func TestBlockerStateAndRed(t *testing.T) {
	tr, err := Load(filepath.Join("testdata", "tracker"))
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{
		"document-tabs":       "todo",     // blocker present and open
		"multiple-workspaces": "canceled", // blocker canceled: will never unblock
		"merge-two-entities":  "missing",  // blocker never filed
		"do-the-thing":        "",         // not blocked
	}
	for slug, want := range cases {
		if got := tr.BlockerState(*tr.BySlug(slug)); got != want {
			t.Errorf("%s: got %q want %q", slug, got, want)
		}
	}
	if !tr.Red() {
		t.Error("fixture has an invalid file and dead blockers; Red should be true")
	}
	clean := &Tracker{Tasks: []Task{Parse("a", fixtureTask)}}
	if clean.Red() {
		t.Error("a valid todo is not red")
	}
}

func TestLoadRefusesANonTracker(t *testing.T) {
	if _, err := Load(t.TempDir()); err == nil {
		t.Error("expected ErrNotTracker")
	}
}

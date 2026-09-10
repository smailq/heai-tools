package owners

import (
	"os"
	"path/filepath"
	"testing"
)

// testdata/territories.json is recorded `architect territories --json` output: the format contract.
func TestParseRecordedTerritories(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "territories.json"))
	if err != nil {
		t.Fatal(err)
	}
	o, err := ParseTerritories(raw)
	if err != nil {
		t.Fatal(err)
	}
	if o["core"] != "core-reviewer" || o["desktop"] != "desktop-owner" || o["platform"] != "smailq" {
		t.Errorf("owners: %v", o)
	}
}

func TestParseRejectsUnexpectedShape(t *testing.T) {
	if _, err := ParseTerritories([]byte(`{"not":"an array"}`)); err == nil {
		t.Error("expected an error")
	}
}

func TestRoutesTo(t *testing.T) {
	o := Owners{"core": "core-reviewer", "desktop": "desktop-owner", "ui": "desktop-owner"}
	cases := []struct {
		in   []string
		want string
	}{
		{nil, ""},
		{[]string{"core"}, "core-reviewer"},
		{[]string{"core", "desktop"}, "core-reviewer,desktop-owner"},
		{[]string{"desktop", "ui"}, "desktop-owner"}, // same owner twice, named once
		{[]string{"nowhere"}, "?"},                   // a territory the map does not declare
	}
	for _, c := range cases {
		if got := o.RoutesTo(c.in); got != c.want {
			t.Errorf("%v: got %q want %q", c.in, got, c.want)
		}
	}
	var none Owners
	if got := none.RoutesTo([]string{"core"}); got != "" {
		t.Errorf("nil owners: %q", got)
	}
}

func TestResolveWithoutAMap(t *testing.T) {
	if r := Resolve(""); r.Note != "no map configured" {
		t.Errorf("got %q", r.Note)
	}
	if r := Resolve(filepath.Join(t.TempDir(), "architecture.yaml")); r.Note != "map not found: architecture.yaml" {
		t.Errorf("got %q", r.Note)
	}
}

// testdata/check.json is recorded `architect check --format json` output: the repositories come from its `map`, in order.
func TestParseRecordedRepositories(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "check.json"))
	if err != nil {
		t.Fatal(err)
	}
	repos, err := ParseRepositories(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(repos) != 2 || repos[0] != "app" || repos[1] != "docs" {
		t.Errorf("repositories, in the map's order: %v", repos)
	}
	// An invalid map has no `map`, so no repositories and no error.
	if repos, err := ParseRepositories([]byte(`{"valid":false,"errors":["x"]}`)); err != nil || repos != nil {
		t.Errorf("invalid map: %v %v", repos, err)
	}
}

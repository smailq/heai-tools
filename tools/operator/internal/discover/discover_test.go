package discover

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTasksPrecedence(t *testing.T) {
	cwd := t.TempDir()
	if err := os.MkdirAll(filepath.Join(cwd, ".heai", "tasks"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := Tasks("", Env{}, cwd); got != filepath.Join(cwd, ".heai", "tasks") {
		t.Errorf("convention: %q", got)
	}
	if got := Tasks("", Env{HEAI_TASKS: "elsewhere"}, cwd); got != filepath.Join(cwd, "elsewhere") {
		t.Errorf("env: %q", got)
	}
	if got := Tasks("here", Env{HEAI_TASKS: "elsewhere"}, cwd); got != filepath.Join(cwd, "here") {
		t.Errorf("flag wins: %q", got)
	}
	bare := t.TempDir()
	if got := Tasks("", Env{}, bare); got != filepath.Join(bare, "tasks") {
		t.Errorf("legacy default: %q", got)
	}
}

func TestMapPrecedence(t *testing.T) {
	cwd := t.TempDir()
	if got := Map("", Env{}, "", cwd); got != "" {
		t.Errorf("nothing exists: %q", got)
	}
	if err := os.WriteFile(filepath.Join(cwd, "architecture.yaml"), []byte("version: 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := Map("", Env{}, "", cwd); got != filepath.Join(cwd, "architecture.yaml") {
		t.Errorf("legacy default: %q", got)
	}
	if got := Map("", Env{}, "/tracker/../architecture.yaml", cwd); got != "/architecture.yaml" {
		t.Errorf("tracker config beats the default: %q", got)
	}
	if got := Map("", Env{HEAI_MAP: "/env.yaml"}, "/cfg.yaml", cwd); got != "/env.yaml" {
		t.Errorf("env beats config: %q", got)
	}
	if got := Map("/flag.yaml", Env{HEAI_MAP: "/env.yaml"}, "/cfg.yaml", cwd); got != "/flag.yaml" {
		t.Errorf("flag beats env: %q", got)
	}
}

// HEAI_DIR sits after the specific flags and variables and before every convention.
func TestHeaiDirPrecedence(t *testing.T) {
	cwd := t.TempDir()
	if err := os.MkdirAll(filepath.Join(cwd, ".heai", "tasks"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cwd, ".heai", "architecture.yaml"), []byte("version: 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	dir := Env{HEAI_DIR: "/proj"}
	if got := Tasks("", dir, cwd); got != "/proj/tasks" {
		t.Errorf("HEAI_DIR beats the .heai/ convention: %q", got)
	}
	if got := Tasks("", Env{HEAI_DIR: "proj"}, cwd); got != filepath.Join(cwd, "proj", "tasks") {
		t.Errorf("a relative HEAI_DIR is from the working directory: %q", got)
	}
	if got := Tasks("", Env{HEAI_DIR: "/proj", HEAI_TASKS: "/t"}, cwd); got != "/t" {
		t.Errorf("HEAI_TASKS beats HEAI_DIR: %q", got)
	}
	if got := Tasks("/flag", Env{HEAI_DIR: "/proj", HEAI_TASKS: "/t"}, cwd); got != "/flag" {
		t.Errorf("the flag beats both: %q", got)
	}
	if got := Map("", dir, "/cfg.yaml", cwd); got != "/proj/architecture.yaml" {
		t.Errorf("HEAI_DIR beats the tracker's config and the convention, and needs no file to exist: %q", got)
	}
	if got := Map("", Env{HEAI_DIR: "/proj", HEAI_MAP: "/m.yaml"}, "", cwd); got != "/m.yaml" {
		t.Errorf("HEAI_MAP beats HEAI_DIR: %q", got)
	}
	if got := Map("/f.yaml", Env{HEAI_DIR: "/proj", HEAI_MAP: "/m.yaml"}, "", cwd); got != "/f.yaml" {
		t.Errorf("the flag beats both: %q", got)
	}
}

func TestProject(t *testing.T) {
	if got := Project(Env{HEAI_DIR: "/proj"}, "/elsewhere/architecture.yaml", "/x/tasks", "/cwd"); got != "/proj" {
		t.Errorf("HEAI_DIR: %q", got)
	}
	if got := Project(Env{}, "/repo/.heai/architecture.yaml", "/repo/.heai/tasks", "/cwd"); got != "/repo/.heai" {
		t.Errorf("the map's directory, even under .heai/: %q", got)
	}
	if got := Project(Env{}, "", "/repo/tasks", "/cwd"); got != "/repo" {
		t.Errorf("no map: the tracker's parent: %q", got)
	}
}

func TestRoot(t *testing.T) {
	if got := Root("/repo/.heai/tasks"); got != "/repo" {
		t.Errorf("convention: %q", got)
	}
	if got := Root("/repo/tasks"); got != "/repo" {
		t.Errorf("legacy: %q", got)
	}
}

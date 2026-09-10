// Package discover finds the project directory, the tracker and the map the way
// the other tools do: a flag first, then the environment, then HEAI_DIR, then
// the .heai/ convention, then the legacy default in the working directory.
package discover

import (
	"os"
	"path/filepath"
)

// Env is the subset of the environment discovery reads.
type Env struct {
	HEAI_TASKS string
	HEAI_MAP   string
	// HEAI_DIR is the project directory: the map at its root, the tracker under tasks/, flow's state under flow/.
	HEAI_DIR string
}

// EnvFromOS reads Env from the process environment.
func EnvFromOS() Env {
	return Env{HEAI_TASKS: os.Getenv("HEAI_TASKS"), HEAI_MAP: os.Getenv("HEAI_MAP"), HEAI_DIR: os.Getenv("HEAI_DIR")}
}

// Tasks resolves the tracker directory: --tasks, HEAI_TASKS, $HEAI_DIR/tasks, .heai/tasks if it exists, else tasks.
func Tasks(flag string, env Env, cwd string) string {
	switch {
	case flag != "":
		return abs(cwd, flag)
	case env.HEAI_TASKS != "":
		return abs(cwd, env.HEAI_TASKS)
	case env.HEAI_DIR != "":
		return filepath.Join(abs(cwd, env.HEAI_DIR), "tasks")
	}
	return firstExisting(cwd, []string{".heai/tasks"}, "tasks")
}

// Map resolves the architecture map: --map, HEAI_MAP, $HEAI_DIR/architecture.yaml,
// the tracker's own tasks.yaml (passed as configured, already resolved),
// .heai/architecture.yaml if it exists, else architecture.yaml. It returns ""
// only when nothing at all exists, so a missing map is a fact the pane shows
// rather than an error; under HEAI_DIR the map is where the directory says,
// whether or not it exists yet.
func Map(flag string, env Env, configured string, cwd string) string {
	switch {
	case flag != "":
		return abs(cwd, flag)
	case env.HEAI_MAP != "":
		return abs(cwd, env.HEAI_MAP)
	case env.HEAI_DIR != "":
		return filepath.Join(abs(cwd, env.HEAI_DIR), "architecture.yaml")
	case configured != "":
		return abs(cwd, configured)
	}
	for _, c := range []string{".heai/architecture.yaml", "architecture.yaml"} {
		p := filepath.Join(cwd, c)
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// Project is the directory the scripts run in and reactor reads: HEAI_DIR when
// set, else the directory holding the map, else the tracker's parent. Under the
// .heai/ convention it is the .heai/ directory itself, since that is the
// project directory placed inside a repository.
func Project(env Env, mapPath, tasksDir, cwd string) string {
	switch {
	case env.HEAI_DIR != "":
		return abs(cwd, env.HEAI_DIR)
	case mapPath != "":
		return filepath.Dir(mapPath)
	}
	return filepath.Dir(tasksDir)
}

// Root names the directory the tracker belongs to: its parent, or the parent of
// .heai/ when it sits under the convention. The header shows its base name.
func Root(tasksDir string) string {
	parent := filepath.Dir(tasksDir)
	if filepath.Base(parent) == ".heai" {
		return filepath.Dir(parent)
	}
	return parent
}

func abs(cwd, p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Join(cwd, p)
}

func firstExisting(cwd string, candidates []string, fallback string) string {
	for _, c := range candidates {
		p := filepath.Join(cwd, c)
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return filepath.Join(cwd, fallback)
}

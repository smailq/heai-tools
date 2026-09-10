// Package tracker reads a tasks tracker directory under the format
// contract its README states: one markdown file per task under items/, six
// frontmatter keys in a fixed set, a status and priority vocabulary, and an
// optional tasks.yaml naming the architecture map.
//
// This is a second reader of that format, written on purpose (root README,
// principle 1) and pinned by the same fixture tasks's own tests use.
package tracker

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Statuses in pick-up order, exactly tasks's TASK_STATUSES.
var Statuses = []string{"in-progress", "in-review", "blocked", "todo", "backlog", "done", "canceled"}

// Priorities most urgent first, exactly tasks's PRIORITIES; empty is "not yet triaged".
var Priorities = []string{"urgent", "high", "medium", "low"}

// Keys is the exact frontmatter key set, in the order tasks writes it.
var Keys = []string{"title", "status", "priority", "territory", "created_at", "modified_at"}

// WorkingSet is what the pane shows by default: everything but the backlog and the closed.
var WorkingSet = map[string]bool{"in-progress": true, "in-review": true, "blocked": true, "todo": true}

// Task is one file under items/.
type Task struct {
	Slug        string   `json:"slug"`
	Title       string   `json:"title"`
	Status      string   `json:"status"`
	Priority    string   `json:"priority"`
	Territories []string `json:"territories"`
	CreatedAt   string   `json:"created_at"`
	ModifiedAt  string   `json:"modified_at"`
	Body        string   `json:"body"`
	// Blocker is the slug of the first "Blocked by [slug](slug.md)" link in the body, or "".
	Blocker string `json:"blocker,omitempty"`
	// Problems is what the format contract found wrong with the file; a task with problems is still listed, marked.
	Problems []string  `json:"problems,omitempty"`
	ModTime  time.Time `json:"-"`
}

// Valid reports whether the file met the contract.
func (t Task) Valid() bool { return len(t.Problems) == 0 }

// Tracker is a loaded tracker directory.
type Tracker struct {
	Dir string `json:"dir"`
	// MapPath is tasks.yaml's `map`, resolved against Dir, or "" when it has none.
	MapPath string `json:"map,omitempty"`
	// ConfigErr is a tasks.yaml that exists and cannot be read; the tracker still loads.
	ConfigErr string `json:"configError,omitempty"`
	Tasks     []Task `json:"tasks"`
	// Changed is the newest mtime under items/, or the directory's own.
	Changed time.Time `json:"changed"`
}

// ErrNotTracker is returned by Load when the directory has no items/.
var ErrNotTracker = errors.New("not a tracker directory (no items/)")

// Load reads every task file under dir/items and the optional tasks.yaml.
func Load(dir string) (*Tracker, error) {
	items := filepath.Join(dir, "items")
	st, err := os.Stat(items)
	if err != nil || !st.IsDir() {
		return nil, fmt.Errorf("%s: %w", dir, ErrNotTracker)
	}
	t := &Tracker{Dir: dir, Changed: st.ModTime()}
	t.readConfig()

	entries, err := os.ReadDir(items)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		path := filepath.Join(items, e.Name())
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		task := Parse(strings.TrimSuffix(e.Name(), ".md"), string(raw))
		if info, err := e.Info(); err == nil {
			task.ModTime = info.ModTime()
			if info.ModTime().After(t.Changed) {
				t.Changed = info.ModTime()
			}
		}
		t.Tasks = append(t.Tasks, task)
	}
	SortPickup(t.Tasks)
	return t, nil
}

func (t *Tracker) readConfig() {
	path := filepath.Join(t.Dir, "tasks.yaml")
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return
	}
	if err != nil {
		t.ConfigErr = err.Error()
		return
	}
	var cfg struct {
		Map string `yaml:"map"`
	}
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		t.ConfigErr = fmt.Sprintf("tasks.yaml: %v", err)
		return
	}
	if cfg.Map != "" {
		if filepath.IsAbs(cfg.Map) {
			t.MapPath = cfg.Map
		} else {
			t.MapPath = filepath.Join(t.Dir, cfg.Map)
		}
	}
}

// Counts returns how many tasks sit in each status, keyed by status.
func (t *Tracker) Counts() map[string]int {
	c := map[string]int{}
	for _, task := range t.Tasks {
		c[task.Status]++
	}
	return c
}

// BySlug finds a task, or nil.
func (t *Tracker) BySlug(slug string) *Task {
	for i := range t.Tasks {
		if t.Tasks[i].Slug == slug {
			return &t.Tasks[i]
		}
	}
	return nil
}

// BlockerState says where a blocked task's blocker stands: "" when it has none named,
// "missing" when the slug is not in the tracker, otherwise the blocker's status.
func (t *Tracker) BlockerState(task Task) string {
	if task.Blocker == "" {
		return ""
	}
	b := t.BySlug(task.Blocker)
	if b == nil {
		return "missing"
	}
	return b.Status
}

// Red reports whether anything shown would be red: an invalid file, or a blocked
// task whose blocker is canceled or missing and so will never unblock on its own.
func (t *Tracker) Red() bool {
	for _, task := range t.Tasks {
		if !task.Valid() {
			return true
		}
		if task.Status == "blocked" {
			switch t.BlockerState(task) {
			case "missing", "canceled":
				return true
			}
		}
	}
	return false
}

var blockedBy = regexp.MustCompile(`Blocked by \[([^\]]+)\]\(`)

// Parse reads one task file. It mirrors tasks's parseTask: every problem
// is reported in one pass, and an empty optional field is unset, not invalid.
func Parse(slug, raw string) Task {
	t := Task{Slug: slug}
	raw = strings.ReplaceAll(raw, "\r\n", "\n")
	if !strings.HasPrefix(raw, "---\n") {
		t.Problems = append(t.Problems, "missing frontmatter opening '---'")
		t.Body = strings.TrimSpace(raw)
		return t
	}
	end := strings.Index(raw[4:], "\n---\n")
	if end < 0 {
		// A file whose frontmatter closes at the very end has no body.
		if strings.HasSuffix(raw, "\n---") {
			end = len(raw) - 4 - 4
		} else {
			t.Problems = append(t.Problems, "missing frontmatter closing '---'")
			return t
		}
	}
	block := raw[4 : 4+end]
	rest := ""
	if 4+end+5 <= len(raw) {
		rest = raw[4+end+5:]
	}
	fields := map[string]string{}
	for _, line := range strings.Split(block, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		i := strings.Index(line, ":")
		if i <= 0 {
			t.Problems = append(t.Problems, fmt.Sprintf("bad frontmatter line: %q", line))
			continue
		}
		key := strings.TrimSpace(line[:i])
		val := strings.TrimSpace(line[i+1:])
		if !contains(Keys, key) {
			t.Problems = append(t.Problems, "unknown frontmatter key: "+key)
			continue
		}
		if _, dup := fields[key]; dup {
			t.Problems = append(t.Problems, "duplicate frontmatter key: "+key)
			continue
		}
		fields[key] = val
	}
	for _, key := range Keys {
		if _, ok := fields[key]; !ok {
			t.Problems = append(t.Problems, "missing frontmatter key: "+key)
		}
	}
	t.Title = fields["title"]
	t.Status = fields["status"]
	t.Priority = fields["priority"]
	t.CreatedAt = fields["created_at"]
	t.ModifiedAt = fields["modified_at"]
	if fields["territory"] != "" {
		for _, part := range strings.Split(fields["territory"], ",") {
			if p := strings.TrimSpace(part); p != "" {
				t.Territories = append(t.Territories, p)
			}
		}
		sort.Strings(t.Territories)
		t.Territories = uniq(t.Territories)
	}
	if t.Title == "" {
		t.Problems = append(t.Problems, "title must not be empty")
	}
	if _, ok := fields["status"]; ok && !contains(Statuses, t.Status) {
		t.Problems = append(t.Problems, fmt.Sprintf("status %q not in [%s]", t.Status, strings.Join(Statuses, " ")))
	}
	if t.Priority != "" && !contains(Priorities, t.Priority) {
		t.Problems = append(t.Problems, fmt.Sprintf("priority %q not in [%s] (or empty)", t.Priority, strings.Join(Priorities, " ")))
	}
	t.Body = strings.TrimSpace(rest)
	if t.Body == "" {
		t.Problems = append(t.Problems, "body must not be empty")
	}
	if m := blockedBy.FindStringSubmatch(t.Body); m != nil {
		t.Blocker = m[1]
	}
	return t
}

// SortPickup orders tasks the way INDEX.md does: status section, then triaged
// priority (unset last), then slug, so the order is deterministic.
func SortPickup(tasks []Task) {
	sort.SliceStable(tasks, func(i, j int) bool {
		a, b := tasks[i], tasks[j]
		if sa, sb := index(Statuses, a.Status), index(Statuses, b.Status); sa != sb {
			return sa < sb
		}
		if pa, pb := priorityRank(a.Priority), priorityRank(b.Priority); pa != pb {
			return pa < pb
		}
		return a.Slug < b.Slug
	})
}

func priorityRank(p string) int {
	if p == "" {
		return len(Priorities)
	}
	return index(Priorities, p)
}

// index returns the position of v in list, or len(list) when absent, so unknown values sort last.
func index(list []string, v string) int {
	for i, x := range list {
		if x == v {
			return i
		}
	}
	return len(list)
}

func contains(list []string, v string) bool { return index(list, v) < len(list) }

func uniq(s []string) []string {
	out := s[:0]
	for i, v := range s {
		if i == 0 || v != s[i-1] {
			out = append(out, v)
		}
	}
	return out
}

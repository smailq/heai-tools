// Package agents reads a project's agents/ directory under the contract its
// README states: one file per agent, `<name>.md`, opening with a frontmatter
// block between two `---` lines that holds exactly name, kind and description,
// the prompt being everything after it. README.md is not an agent; dotfiles
// and files that are not .md are ignored.
//
// Like the tracker this is read from files, not asked of a CLI, and a file
// that misses the contract is listed with its problems rather than dropped.
package agents

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Keys is the exact frontmatter key set, in the order the README states it.
var Keys = []string{"name", "kind", "description"}

// Kinds is what kind is today; it is shown as read, so a new kind is a count, not a problem.
var Kinds = []string{"worker", "gate"}

// Agent is one file under agents/.
type Agent struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Description string `json:"description"`
	// File is the path of the file read.
	File string `json:"file"`
	// Body is the prompt: everything after the closing ---.
	Body string `json:"-"`
	// Problems is what the contract found wrong with the file; an agent with problems is still listed, marked.
	Problems []string `json:"problems,omitempty"`
}

// Valid reports whether the file met the contract.
func (a Agent) Valid() bool { return len(a.Problems) == 0 }

// Result is one reading of the directory.
type Result struct {
	// Dir is the agents/ directory read.
	Dir    string  `json:"dir,omitempty"`
	Agents []Agent `json:"agents"`
	// Note says why there is nothing: not configured here, or the directory could not be read.
	Note string `json:"note,omitempty"`
	// Failed marks a directory that exists and could not be read.
	Failed bool `json:"failed,omitempty"`
	// Changed is the newest mtime among the files, or the directory's own.
	Changed time.Time `json:"changed,omitempty"`
	At      time.Time `json:"at"`
}

// Configured reports whether the project has an agents/ directory, and says why not.
func Configured(project string) (bool, string) {
	if project == "" {
		return false, "no project directory, so nowhere to look for agents/"
	}
	st, err := os.Stat(filepath.Join(project, "agents"))
	if err != nil || !st.IsDir() {
		return false, "not configured here (no agents/ in the project)"
	}
	return true, ""
}

// Load reads every agent file under <project>/agents, sorted by name.
func Load(project string, now time.Time) Result {
	r := Result{At: now}
	if ok, why := Configured(project); !ok {
		r.Note = why
		return r
	}
	r.Dir = filepath.Join(project, "agents")
	st, err := os.Stat(r.Dir)
	if err != nil {
		r.Note, r.Failed = err.Error(), true
		return r
	}
	r.Changed = st.ModTime()
	entries, err := os.ReadDir(r.Dir)
	if err != nil {
		r.Note, r.Failed = err.Error(), true
		return r
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || strings.HasPrefix(name, ".") || !strings.HasSuffix(name, ".md") || name == "README.md" {
			continue
		}
		path := filepath.Join(r.Dir, name)
		raw, err := os.ReadFile(path)
		if err != nil {
			r.Note, r.Failed = err.Error(), true
			return r
		}
		a := Parse(strings.TrimSuffix(name, ".md"), string(raw))
		a.File = path
		if info, err := e.Info(); err == nil && info.ModTime().After(r.Changed) {
			r.Changed = info.ModTime()
		}
		r.Agents = append(r.Agents, a)
	}
	sort.SliceStable(r.Agents, func(i, j int) bool { return r.Agents[i].Name < r.Agents[j].Name })
	return r
}

// Parse reads one agent file named by its file name without .md. Every problem
// is reported in one pass; the agent carries what could be read.
func Parse(name, raw string) Agent {
	a := Agent{Name: name}
	raw = strings.ReplaceAll(raw, "\r\n", "\n")
	if !strings.HasPrefix(raw, "---\n") {
		a.Problems = append(a.Problems, "missing frontmatter opening '---'")
		a.Body = strings.TrimSpace(raw)
		return a
	}
	end := strings.Index(raw[4:], "\n---\n")
	if end < 0 {
		// A file whose frontmatter closes at the very end has no prompt.
		if strings.HasSuffix(raw, "\n---") {
			end = len(raw) - 4 - 4
		} else {
			a.Problems = append(a.Problems, "missing frontmatter closing '---'")
			return a
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
			a.Problems = append(a.Problems, fmt.Sprintf("bad frontmatter line: %q", line))
			continue
		}
		key := strings.TrimSpace(line[:i])
		val := strings.TrimSpace(line[i+1:])
		if !contains(Keys, key) {
			a.Problems = append(a.Problems, "unknown frontmatter key: "+key)
			continue
		}
		if _, dup := fields[key]; dup {
			a.Problems = append(a.Problems, "duplicate frontmatter key: "+key)
			continue
		}
		fields[key] = val
	}
	for _, key := range Keys {
		if _, ok := fields[key]; !ok {
			a.Problems = append(a.Problems, "missing frontmatter key: "+key)
		}
	}
	if n, ok := fields["name"]; ok && n != name {
		a.Problems = append(a.Problems, fmt.Sprintf("name %q is not the file name %q", n, name))
	}
	a.Kind = fields["kind"]
	a.Description = fields["description"]
	if _, ok := fields["kind"]; ok && a.Kind == "" {
		a.Problems = append(a.Problems, "kind must not be empty")
	}
	if _, ok := fields["description"]; ok && a.Description == "" {
		a.Problems = append(a.Problems, "description must not be empty")
	}
	a.Body = strings.TrimSpace(rest)
	if a.Body == "" {
		a.Problems = append(a.Problems, "prompt must not be empty")
	}
	return a
}

// ByName finds an agent, or nil.
func (r *Result) ByName(name string) *Agent {
	for i := range r.Agents {
		if r.Agents[i].Name == name {
			return &r.Agents[i]
		}
	}
	return nil
}

// Broken is how many files miss the contract.
func (r Result) Broken() int {
	n := 0
	for _, a := range r.Agents {
		if !a.Valid() {
			n++
		}
	}
	return n
}

// Red reports whether anything shown would be red: a file that misses the contract.
func (r Result) Red() bool { return r.Broken() > 0 }

// KindCount is one kind's count.
type KindCount struct {
	Kind  string
	Count int
}

// CountByKind counts the valid agents by kind: the known kinds first in their
// order, then any other kind by name, so the line reads the same every time.
func CountByKind(list []Agent) []KindCount {
	counts := map[string]int{}
	for _, a := range list {
		if a.Valid() {
			counts[a.Kind]++
		}
	}
	var out []KindCount
	for _, k := range Kinds {
		if n := counts[k]; n > 0 {
			out = append(out, KindCount{k, n})
			delete(counts, k)
		}
	}
	var rest []string
	for k := range counts {
		rest = append(rest, k)
	}
	sort.Strings(rest)
	for _, k := range rest {
		out = append(out, KindCount{k, counts[k]})
	}
	return out
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

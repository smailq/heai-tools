// Package flows asks flow, the referee, what is open and what is stuck, and
// never reads its journals: `flow list --json`, `flow stuck --json` and `flow
// trace` are the whole contract, recorded under testdata/flow/ at the root of
// this tool.
package flows

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Flow is one record as `flow list --json` prints it: the regenerated snapshot.
type Flow struct {
	ID         string            `json:"id"`
	Definition string            `json:"definition"`
	State      string            `json:"state"`
	Terminal   bool              `json:"terminal"`
	Since      string            `json:"since"`
	StartedAt  string            `json:"startedAt"`
	Seq        int               `json:"seq"`
	Links      map[string]string `json:"links"`
	WaitsOn    []string          `json:"waitsOn"`
	TouchedAt  *string           `json:"touchedAt"`
	ExpiresAt  *string           `json:"expiresAt"`
}

// SinceTime is when the current state was entered; zero if unreadable.
func (f Flow) SinceTime() time.Time {
	t, err := time.Parse(time.RFC3339Nano, f.Since)
	if err != nil {
		return time.Time{}
	}
	return t
}

// Link is one link's value, "" when absent.
func (f Flow) Link(name string) string { return f.Links[name] }

// About names what the flow is about, for a row that has one column for it:
// the task link, else the lane, else the first link by name, else nothing.
func (f Flow) About() string {
	for _, n := range []string{"task", "lane"} {
		if v := f.Links[n]; v != "" {
			return n + " " + v
		}
	}
	names := make([]string, 0, len(f.Links))
	for n := range f.Links {
		names = append(names, n)
	}
	sort.Strings(names)
	if len(names) > 0 {
		return names[0] + " " + f.Links[names[0]]
	}
	return ""
}

// Wait is one flow a stuck flow waits on, and its state; nil when the flow is missing.
type Wait struct {
	ID    string  `json:"id"`
	State *string `json:"state"`
}

// Stuck is one entry of `flow stuck --json`.
type Stuck struct {
	Flow   Flow   `json:"flow"`
	IdleMs int64  `json:"idleMs"`
	Waits  []Wait `json:"waits"`
}

// Idle is how long nothing has moved or touched the flow, as flow measured it.
func (s Stuck) Idle() time.Duration { return time.Duration(s.IdleMs) * time.Millisecond }

// Stands says where the flow's waits stand - each waited flow's state, joined -
// and whether that is red: a waited flow that is missing, or that flow calls
// terminal, will never move again, so a flow still waiting on it is stuck for
// good. No state name is read here: terminal is flow's own answer.
func (s Stuck) Stands(byID map[string]Flow) (string, bool) {
	if len(s.Waits) == 0 {
		return "", false
	}
	var parts []string
	red := false
	for _, w := range s.Waits {
		switch {
		case w.State == nil:
			parts = append(parts, "missing")
			red = true
		default:
			parts = append(parts, *w.State)
			if f, ok := byID[w.ID]; ok && f.Terminal {
				red = true
			}
		}
	}
	return strings.Join(parts, ", "), red
}

// WaitsOn describes what the flow waits on, one item per waited flow: what that flow is about, else its id.
func (s Stuck) WaitsOn(byID map[string]Flow) string {
	var parts []string
	for _, w := range s.Waits {
		if f, ok := byID[w.ID]; ok {
			if about := f.About(); about != "" {
				parts = append(parts, about)
				continue
			}
		}
		parts = append(parts, w.ID)
	}
	return strings.Join(parts, ", ")
}

// Index maps flows by id.
func Index(flows []Flow) map[string]Flow {
	m := make(map[string]Flow, len(flows))
	for _, f := range flows {
		m[f.ID] = f
	}
	return m
}

// StateCount is one state's count within a definition.
type StateCount struct {
	State    string
	Count    int
	Terminal bool
}

// DefinitionCount is one definition's flows by state: open states first, most first, then the terminal ones.
type DefinitionCount struct {
	Definition string
	Total      int
	Open       int
	States     []StateCount
}

// Count groups flows by definition, definitions in name order.
func Count(flows []Flow) []DefinitionCount {
	byDef := map[string]map[string]*StateCount{}
	for _, f := range flows {
		if byDef[f.Definition] == nil {
			byDef[f.Definition] = map[string]*StateCount{}
		}
		sc := byDef[f.Definition][f.State]
		if sc == nil {
			sc = &StateCount{State: f.State, Terminal: f.Terminal}
			byDef[f.Definition][f.State] = sc
		}
		sc.Count++
	}
	var out []DefinitionCount
	for def, states := range byDef {
		d := DefinitionCount{Definition: def}
		for _, sc := range states {
			d.States = append(d.States, *sc)
			d.Total += sc.Count
			if !sc.Terminal {
				d.Open += sc.Count
			}
		}
		sort.Slice(d.States, func(i, j int) bool {
			a, b := d.States[i], d.States[j]
			if a.Terminal != b.Terminal {
				return !a.Terminal
			}
			if a.Count != b.Count {
				return a.Count > b.Count
			}
			return a.State < b.State
		})
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Definition < out[j].Definition })
	return out
}

// Definition is one entry of `flow definitions --json`: a file under flows/, by the name it declares.
type Definition struct {
	Name    string   `json:"name"`
	Path    string   `json:"path"`
	Problem *string  `json:"problem"`
	States  []string `json:"states"`
}

// Result is one poll of flow: the definitions, everything open or closed, and what is stuck.
type Result struct {
	Definitions []Definition `json:"definitions"`
	Flows       []Flow       `json:"flows"`
	Stuck       []Stuck      `json:"stuck"`
	// Note says why the lists are empty or old: flow not on PATH, not configured beside this map, or the command's last line.
	Note string `json:"note,omitempty"`
	// Failed is true when flow could not answer; the screen keeps its last answer and says so.
	Failed bool      `json:"failed,omitempty"`
	At     time.Time `json:"at"`
}

// DefinitionNames is every definition the project declares or has flows of, in name order.
func (r Result) DefinitionNames() []string {
	seen := map[string]bool{}
	for _, d := range r.Definitions {
		seen[d.Name] = true
	}
	for _, f := range r.Flows {
		seen[f.Definition] = true
	}
	names := make([]string, 0, len(seen))
	for n := range seen {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// OfDefinition is the flows of one definition, in the order flow lists them.
func (r Result) OfDefinition(name string) []Flow {
	var out []Flow
	for _, f := range r.Flows {
		if f.Definition == name {
			out = append(out, f)
		}
	}
	return out
}

// Red reports whether anything in the result is red: a stuck flow whose wait stands at missing or terminal-but-not-done.
func (r Result) Red() bool {
	byID := Index(r.Flows)
	for _, s := range r.Stuck {
		if _, red := s.Stands(byID); red {
			return true
		}
	}
	return false
}

// Timeout bounds one flow call.
var Timeout = 10 * time.Second

// Installed reports whether flow is on PATH.
func Installed() bool {
	_, err := exec.LookPath("heai-flow")
	return err == nil
}

// Configured reports whether flow has anything beside this map - flow.yaml, a
// flow/ directory, or HEAI_FLOW_STATE pointing elsewhere - and says why not.
// It is asked before polling because `flow list` creates flow/ when it is
// absent, and a screen must not leave a state directory behind.
func Configured(mapPath string) (bool, string) {
	if os.Getenv("HEAI_FLOW_STATE") != "" {
		return true, ""
	}
	if mapPath == "" {
		return false, "no map, so nowhere to look for flow/"
	}
	dir := filepath.Dir(mapPath)
	for _, name := range []string{"flow.yaml", "flow"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			return true, ""
		}
	}
	return false, "not configured here (no flow.yaml or flow/ beside the map)"
}

// Poll runs `flow definitions --json`, `flow list --json` and `flow stuck --json` in the map's directory, the project.
func Poll(mapPath string, now time.Time) Result {
	r := Result{At: now}
	if !Installed() {
		r.Note = "heai-flow not on PATH"
		return r
	}
	if ok, why := Configured(mapPath); !ok {
		r.Note = why
		return r
	}
	defs, err := DefinitionList(mapPath)
	if err != nil {
		r.Note, r.Failed = err.Error(), true
		return r
	}
	flows, err := List(mapPath, "")
	if err != nil {
		r.Note, r.Failed = err.Error(), true
		return r
	}
	stuck, err := StuckList(mapPath)
	if err != nil {
		r.Note, r.Failed = err.Error(), true
		return r
	}
	r.Definitions, r.Flows, r.Stuck = defs, flows, stuck
	return r
}

// DefinitionList runs `flow definitions --json`.
func DefinitionList(mapPath string) ([]Definition, error) {
	out, err := run(mapPath, "definitions", "--json")
	if err != nil {
		return nil, err
	}
	return ParseDefinitions(out)
}

// ParseDefinitions reads the array `flow definitions --json` prints.
func ParseDefinitions(raw []byte) ([]Definition, error) {
	var list []Definition
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("unexpected definitions output: %v", err)
	}
	return list, nil
}

// List runs `flow list [<definition>] --json`.
func List(mapPath, definition string) ([]Flow, error) {
	args := []string{"list"}
	if definition != "" {
		args = append(args, definition)
	}
	out, err := run(mapPath, append(args, "--json")...)
	if err != nil {
		return nil, err
	}
	return ParseList(out)
}

// StuckList runs `flow stuck --json`, with flow's own default of one hour.
func StuckList(mapPath string) ([]Stuck, error) {
	out, err := run(mapPath, "stuck", "--json")
	if err != nil {
		return nil, err
	}
	return ParseStuck(out)
}

// TraceLine is one journal line of a timeline as `flow trace <id> --json` prints it:
// which flow moved, the move itself, who made it and what came out of it.
type TraceLine struct {
	ID         string         `json:"id"`
	Definition string         `json:"definition"`
	Seq        int            `json:"seq"`
	At         string         `json:"at"`
	Event      string         `json:"event"`
	From       *string        `json:"from"`
	To         string         `json:"to"`
	By         string         `json:"by"`
	Data       map[string]any `json:"data"`
	Note       string         `json:"note"`
}

// Move is the state change the line made: "→ queued" at the start, "from → to" for a
// transition, and the event's own name for a line that moved nothing.
func (l TraceLine) Move() string {
	switch {
	case l.From == nil:
		return "→ " + l.To
	case *l.From != l.To:
		return *l.From + " → " + l.To
	}
	return l.Event
}

// Result is what came of the line: its note, else its data as flow recorded it, by name.
// The keys that only restate a link are left out; they are the flow pane's own lines.
func (l TraceLine) Result() string {
	if l.Note != "" {
		return l.Note
	}
	names := make([]string, 0, len(l.Data))
	for n := range l.Data {
		switch n {
		case "links", "waitsOn":
			continue
		}
		names = append(names, n)
	}
	sort.Strings(names)
	var parts []string
	for _, n := range names {
		parts = append(parts, fmt.Sprintf("%s=%v", n, l.Data[n]))
	}
	return strings.Join(parts, " ")
}

// Timeline is what `flow trace <id> --json` prints: every flow the walk reached, and
// their journal lines in time order.
type Timeline struct {
	Flows []Flow      `json:"flows"`
	Lines []TraceLine `json:"lines"`
}

// TraceJSON runs `flow trace <id> --json` and returns the timeline it prints.
func TraceJSON(mapPath, id string) (Timeline, error) {
	out, err := run(mapPath, "trace", id, "--json")
	if err != nil {
		return Timeline{}, err
	}
	return ParseTrace(out)
}

// ParseTrace reads the object `flow trace --json` prints.
func ParseTrace(raw []byte) (Timeline, error) {
	var t Timeline
	if err := json.Unmarshal(raw, &t); err != nil {
		return Timeline{}, fmt.Errorf("unexpected trace output: %v", err)
	}
	return t, nil
}

// Trace runs `flow trace <id>` and returns the timeline as flow prints it.
func Trace(mapPath, id string) (string, error) {
	out, err := run(mapPath, "trace", id)
	if err != nil {
		return "", err
	}
	return strings.TrimRight(string(out), "\n"), nil
}

// ParseList reads the array `flow list --json` prints.
func ParseList(raw []byte) ([]Flow, error) {
	var list []Flow
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("unexpected list output: %v", err)
	}
	return list, nil
}

// ParseStuck reads the array `flow stuck --json` prints.
func ParseStuck(raw []byte) ([]Stuck, error) {
	var list []Stuck
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("unexpected stuck output: %v", err)
	}
	return list, nil
}

// run executes heai-flow with `--dir` set to the map's directory, which is the
// project directory flow looks in for flow.yaml, flows/ and flow/.
func run(mapPath string, args ...string) ([]byte, error) {
	bin, err := exec.LookPath("heai-flow")
	if err != nil {
		return nil, errors.New("heai-flow not on PATH")
	}
	if mapPath != "" {
		args = append(args, "--dir", filepath.Dir(mapPath))
	}
	ctx, cancel := context.WithTimeout(context.Background(), Timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, args...).Output()
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
		return nil, errors.New("flow: " + strings.TrimPrefix(msg, "flow: "))
	}
	return out, nil
}

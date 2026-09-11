// Package reactor asks reactor what it has seen and done: `heai-reactor status
// --json` for the sources, their cursors and each rule's last action, and
// `heai-reactor events --since 1h --json` for the last hour's events, each
// carrying the actions rules took on it. Both are recorded under
// testdata/reactor/ at the root of this tool by testdata/record.sh.
package reactor

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

// Source is one source as `status --json` describes it.
type Source struct {
	Name string `json:"name"`
	Type string `json:"type"`
	// EveryMs is the poll interval, nil for a source that listens or takes emits.
	EveryMs *int64  `json:"every"`
	Listens *string `json:"listens"`
	Emits   bool    `json:"emits"`
	// Cursor is the source's own one-line description of where it stands.
	Cursor    string  `json:"cursor"`
	LastEvent *string `json:"lastEvent"`
	LastHour  int     `json:"lastHour"`
}

// Cadence says how the source gets its events: "every 10s", "listens /hook/github", "from emit", or "idle".
func (s Source) Cadence() string {
	switch {
	case s.EveryMs != nil:
		return "every " + Short(time.Duration(*s.EveryMs)*time.Millisecond)
	case s.Listens != nil:
		return "listens " + *s.Listens
	case s.Emits:
		return "from emit"
	}
	return "idle"
}

// Problem is what the cursor reports after "PROBLEM", or "" when it reports none:
// a poll that failed, a secret that does not resolve, a directory that cannot be read.
func (s Source) Problem() string {
	if i := strings.Index(s.Cursor, "PROBLEM "); i >= 0 {
		return s.Cursor[i+len("PROBLEM "):]
	}
	return ""
}

// LastEventTime is when the source last produced, zero when never.
func (s Source) LastEventTime() time.Time {
	if s.LastEvent == nil {
		return time.Time{}
	}
	return parseTime(*s.LastEvent)
}

// Action is one action record: what a rule did with one event.
type Action struct {
	Event   string                 `json:"event"`
	Rule    string                 `json:"rule"`
	Action  string                 `json:"action"`
	At      string                 `json:"at"`
	OK      bool                   `json:"ok"`
	Outcome map[string]interface{} `json:"outcome"`
	Error   *string                `json:"error"`
	// Collapsed lists the events a debounce folded into this one.
	Collapsed []string `json:"collapsed,omitempty"`
}

// Limited reports whether the record says the rule's limit held the event back rather than ran it.
func (a Action) Limited() bool {
	v, ok := a.Outcome["limited"].(bool)
	return ok && v
}

// Command is what ran, when the record says.
func (a Action) Command() string {
	s, _ := a.Outcome["command"].(string)
	return s
}

// Log is the path of the run's output, when the record says.
func (a Action) Log() string {
	s, _ := a.Outcome["log"].(string)
	return s
}

// Result is one word on the outcome: "ok", "limited", or the error - "exited 3", "timed out after 30000ms".
func (a Action) Result() string {
	switch {
	case a.OK:
		return "ok"
	case a.Limited():
		return "limited"
	case a.Error != nil && *a.Error != "":
		return *a.Error
	}
	return "failed"
}

// Failed reports whether the rule ran and went wrong; a limited event is held, not failed.
func (a Action) Failed() bool { return !a.OK && !a.Limited() }

// AtTime is when the action happened.
func (a Action) AtTime() time.Time { return parseTime(a.At) }

// Limit is a rule's rate limit as `status` prints it.
type Limit struct {
	Count    int   `json:"count"`
	WindowMs int64 `json:"windowMs"`
}

// String is the limit as the configuration wrote it: "10/hour".
func (l Limit) String() string {
	w := time.Duration(l.WindowMs) * time.Millisecond
	unit := Short(w)
	switch w {
	case time.Minute:
		unit = "minute"
	case time.Hour:
		unit = "hour"
	case 24 * time.Hour:
		unit = "day"
	case 7 * 24 * time.Hour:
		unit = "week"
	}
	return fmt.Sprintf("%d/%s", l.Count, unit)
}

// Pending is a debounce waiting to fire.
type Pending struct {
	Event  string   `json:"event"`
	Key    string   `json:"key"`
	Since  string   `json:"since"`
	Until  string   `json:"until"`
	Events []string `json:"events"`
}

// Window is a limit's current window.
type Window struct {
	Start string `json:"start"`
	Count int    `json:"count"`
	Noted bool   `json:"noted"`
}

// Rule is one rule as `status --json` describes it.
type Rule struct {
	Name       string   `json:"name"`
	On         string   `json:"on"`
	Run        string   `json:"run"`
	DebounceMs *int64   `json:"debounce"`
	Limit      *Limit   `json:"limit"`
	Repeat     bool     `json:"repeat"`
	LastAction *Action  `json:"lastAction"`
	Pending    *Pending `json:"pending"`
	Window     *Window  `json:"window"`
}

// Status is `heai-reactor status --json`.
type Status struct {
	State   string   `json:"state"`
	Config  *string  `json:"config"`
	Sources []Source `json:"sources"`
	Rules   []Rule   `json:"rules"`
	Events  struct {
		LastHour int `json:"lastHour"`
		LastDay  int `json:"lastDay"`
	} `json:"events"`
}

// Problems counts the sources whose cursor reports a problem.
func (s *Status) Problems() int {
	if s == nil {
		return 0
	}
	n := 0
	for _, src := range s.Sources {
		if src.Problem() != "" {
			n++
		}
	}
	return n
}

// Event is one line of the log, with what every rule did with it.
type Event struct {
	ID      string                 `json:"id"`
	Source  string                 `json:"source"`
	Kind    string                 `json:"kind"`
	Key     string                 `json:"key"`
	At      string                 `json:"at"`
	Payload map[string]interface{} `json:"payload"`
	// Actions is every action record for the event, oldest first, as `events --json` carries them.
	Actions []Action `json:"actions"`
}

// AtTime is when the event happened.
func (e Event) AtTime() time.Time { return parseTime(e.At) }

// Result is one poll of reactor.
type Result struct {
	Status *Status `json:"status"`
	// Events is the last hour, newest first.
	Events []Event `json:"events"`
	// Note says why there is nothing, or why it is old: not on PATH, not configured here, or the command's last line.
	Note   string    `json:"note,omitempty"`
	Failed bool      `json:"failed,omitempty"`
	At     time.Time `json:"at"`
}

// Failed lists the actions in the window that went wrong, newest first.
func (r Result) FailedActions() []Action {
	var out []Action
	for _, e := range r.Events {
		for _, a := range e.Actions {
			if a.Failed() {
				out = append(out, a)
			}
		}
	}
	return out
}

// Red reports whether a rule ran and failed on an event in the last hour: the one thing here a person must look at.
func (r Result) Red() bool { return len(r.FailedActions()) > 0 }

// Timeout bounds one call.
var Timeout = 10 * time.Second

// Since is the window `events` is asked for.
const Since = "1h"

// Installed reports whether reactor is on PATH.
func Installed() bool {
	_, err := exec.LookPath("heai-reactor")
	return err == nil
}

// Configured reports whether reactor has anything in this project - reactor.yaml
// or .heai/reactor.yaml, a reactor/ state directory, or HEAI_REACTOR_STATE
// pointing elsewhere - and says why not. It is asked before polling because
// `heai-reactor status` creates reactor/ when it is absent, and a screen must
// not leave a state directory behind.
func Configured(project string) (bool, string) {
	if os.Getenv("HEAI_REACTOR_STATE") != "" {
		return true, ""
	}
	if project == "" {
		return false, "no project directory, so nowhere to look for reactor.yaml"
	}
	for _, name := range []string{"reactor.yaml", "reactor", filepath.Join(".heai", "reactor.yaml"), filepath.Join(".heai", "reactor")} {
		if _, err := os.Stat(filepath.Join(project, name)); err == nil {
			return true, ""
		}
	}
	return false, "not configured here (no reactor.yaml or reactor/ in the project)"
}

// Poll runs `heai-reactor status --json` and `heai-reactor events --since 1h --json`.
func Poll(project string, now time.Time) Result {
	r := Result{At: now}
	if !Installed() {
		r.Note = "heai-reactor not on PATH"
		return r
	}
	if ok, why := Configured(project); !ok {
		r.Note = why
		return r
	}
	out, err := run(project, "status", "--json")
	if err != nil {
		r.Note, r.Failed = err.Error(), true
		return r
	}
	st, err := ParseStatus(out)
	if err != nil {
		r.Note, r.Failed = "reactor: "+err.Error(), true
		return r
	}
	out, err = run(project, "events", "--since", Since, "--json")
	if err != nil {
		r.Note, r.Failed = err.Error(), true
		return r
	}
	events, err := ParseEvents(out)
	if err != nil {
		r.Note, r.Failed = "reactor: "+err.Error(), true
		return r
	}
	r.Status, r.Events = st, events
	return r
}

// ParseStatus reads the object `status --json` prints.
func ParseStatus(raw []byte) (*Status, error) {
	var s Status
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("unexpected status output: %v", err)
	}
	return &s, nil
}

// ParseEvents reads the array `events --json` prints - oldest first, as the log is - and orders it newest first.
func ParseEvents(raw []byte) ([]Event, error) {
	var list []Event
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("unexpected events output: %v", err)
	}
	sort.SliceStable(list, func(i, j int) bool {
		a, b := list[i].AtTime(), list[j].AtTime()
		if !a.Equal(b) {
			return a.After(b)
		}
		return list[i].ID > list[j].ID
	})
	return list, nil
}

func run(project string, args ...string) ([]byte, error) {
	bin, err := exec.LookPath("heai-reactor")
	if err != nil {
		return nil, errors.New("heai-reactor not on PATH")
	}
	if project != "" {
		args = append(args, "--dir", project)
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
		return nil, errors.New("reactor: " + strings.TrimPrefix(msg, "reactor: "))
	}
	return out, nil
}

func parseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}
	}
	return t
}

// Short is a duration in one unit: 500ms, 10s, 5m, 2h, 3d.
func Short(d time.Duration) string {
	switch {
	case d < time.Second:
		return fmt.Sprintf("%dms", d.Milliseconds())
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}

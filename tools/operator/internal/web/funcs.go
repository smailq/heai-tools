package web

import (
	"encoding/json"
	"fmt"
	"html/template"
	"path/filepath"
	"strings"
	"time"

	"github.com/smailq/heai-tools/tools/operator/internal/flows"
	"github.com/smailq/heai-tools/tools/operator/internal/pod"
	"github.com/smailq/heai-tools/tools/operator/internal/reactor"
	"github.com/smailq/heai-tools/tools/operator/internal/tracker"
)

// pages is every template that renders a whole page; each is parsed with the layout.
var pages = []string{"tasks", "task", "flows", "flow", "machines", "pod", "workspace", "reactor", "event", "missing"}

func parseTemplates(s *Server) map[string]*template.Template {
	funcs := template.FuncMap{
		"short":   short,
		"ago":     func(t time.Time) string { return ago(t, s.opts.Now()) },
		"since":   func(ts string) string { return since(ts, s.opts.Now()) },
		"clock":   func(ts string) string { return clock(ts, s.opts.Now()) },
		"days":    func(date string) string { return ageDays(date, s.opts.Now()) },
		"join":    strings.Join,
		"orDash":  orDash,
		"pretty":  pretty,
		"base":    filepath.Base,
		"shortID": shortID,
		"duration": func(f flows.Flow) string {
			return flowDuration(f)
		},
		"inState": func(f flows.Flow) string { return short(s.opts.Now().Sub(f.SinceTime())) },
		"routes": func(st State, t tracker.Task) string {
			if len(t.Territories) == 0 {
				return "(untriaged)"
			}
			return orDash(st.Snap.Owners.Owners.RoutesTo(t.Territories))
		},
		"owner": func(st State, territory string) string {
			if o, ok := st.Snap.Owners.Owners[territory]; ok {
				return o
			}
			return "?"
		},
		"blocker": func(st State, t tracker.Task) string {
			if st.Snap.Tracker == nil {
				return ""
			}
			return st.Snap.Tracker.BlockerState(t)
		},
		"deadBlocker": func(state string) bool { return state == "missing" || state == "canceled" },
		"counts":      counts,
		"open":        func(list []flows.Flow) int { return openCount(list) },
		"stands": func(st State, sk flows.Stuck) string {
			v, _ := sk.Stands(flows.Index(st.Flows.Flows))
			return v
		},
		"standsRed": func(st State, sk flows.Stuck) bool {
			_, red := sk.Stands(flows.Index(st.Flows.Flows))
			return red
		},
		"stuckOf": func(st State, id string) *flows.Stuck {
			for i := range st.Flows.Stuck {
				if st.Flows.Stuck[i].Flow.ID == id {
					return &st.Flows.Stuck[i]
				}
			}
			return nil
		},
		"flowByID": func(st State, id string) *flows.Flow {
			if f, ok := flows.Index(st.Flows.Flows)[id]; ok {
				return &f
			}
			return nil
		},
		"strp": func(p *string) string {
			if p == nil {
				return ""
			}
			return *p
		},
		"linked":   linkedCount,
		"byStatus": pod.CountByStatus,
		"failedN":  func(r reactor.Result) int { return len(r.FailedActions()) },
		"eventsOf": func(st State, rule string) int {
			n := 0
			for _, e := range st.Reactor.Events {
				for _, a := range e.Actions {
					if a.Rule == rule {
						n++
					}
				}
			}
			return n
		},
		"ruleResult": ruleResult,
		"sorts":      func() []string { return []string{"pick-up", "age", "slug", "territory"} },
		"lower":      strings.ToLower,
	}
	out := map[string]*template.Template{}
	for _, name := range pages {
		out[name] = template.Must(template.New(name).Funcs(funcs).ParseFS(templateFS, "templates/layout.html", "templates/"+name+".html"))
	}
	return out
}

// statusCount is one tracker status and how many tasks sit in it.
type statusCount struct {
	Status string
	Count  int
}

// counts is the tracker's statuses in pick-up order, the empty ones left out.
func counts(t *tracker.Tracker) []statusCount {
	if t == nil {
		return nil
	}
	c := t.Counts()
	var out []statusCount
	for _, s := range tracker.Statuses {
		if c[s] > 0 {
			out = append(out, statusCount{s, c[s]})
		}
	}
	return out
}

func openCount(list []flows.Flow) int {
	n := 0
	for _, f := range list {
		if !f.Terminal {
			n++
		}
	}
	return n
}

func linkedCount(list []pod.Workspace) int {
	n := 0
	for _, w := range list {
		if w.Linked {
			n++
		}
	}
	return n
}

// ruleResult is a rule's last run in one word, as the terminal's rules block says it.
func ruleResult(r reactor.Rule) string {
	switch {
	case r.LastAction != nil:
		return r.LastAction.Result()
	case r.Limit != nil:
		return "limit " + r.Limit.String()
	}
	return "never fired"
}

// short is a duration in one unit: 42s, 6m, 2h, 3d.
func short(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}

func ago(t, now time.Time) string {
	if t.IsZero() {
		return "-"
	}
	return short(now.Sub(t)) + " ago"
}

// since is how long ago a flow or reactor timestamp was, "-" when it does not read.
func since(ts string, now time.Time) string {
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return "-"
	}
	return short(now.Sub(t))
}

// clock is a timestamp as the time of day when it is today, else the date.
func clock(ts string, now time.Time) string {
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return "-"
	}
	t = t.In(now.Location())
	if y, m, d := t.Date(); y == now.Year() && m == now.Month() && d == now.Day() {
		return t.Format("15:04:05")
	}
	return t.Format("2006-01-02 15:04")
}

// ageDays reads a YYYY-MM-DD and says how many days ago it was.
func ageDays(date string, now time.Time) string {
	d, err := time.ParseInLocation("2006-01-02", date, now.Location())
	if err != nil {
		return "-"
	}
	y, mo, da := now.Date()
	today := time.Date(y, mo, da, 0, 0, 0, 0, now.Location())
	days := int(today.Sub(d).Hours() / 24)
	if days <= 0 {
		return "today"
	}
	return fmt.Sprintf("%dd", days)
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func pretty(v any) string {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(raw)
}

// shortID is the last segment of a flow id, as the terminal's table shows it.
func shortID(id string) string {
	if i := strings.LastIndex(id, "-"); i >= 0 && i < len(id)-1 {
		return id[i+1:]
	}
	return id
}

// flowDuration is how long a flow that has ended took, start to its last move; "-" while it can still move.
func flowDuration(f flows.Flow) string {
	if !f.Terminal {
		return "-"
	}
	start, err := time.Parse(time.RFC3339Nano, f.StartedAt)
	if err != nil {
		return "-"
	}
	end := f.SinceTime()
	if end.IsZero() || end.Before(start) {
		return "-"
	}
	return short(end.Sub(start))
}

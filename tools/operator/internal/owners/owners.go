// Package owners answers "which actor does this territory route to" and "which
// repositories does the map govern" by asking architect, the map's own tool, and
// never by reading the map itself. It is optional: without architect on PATH or
// without a map, the pane shows territories and no owner, and says why.
package owners

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Owners maps territory name to owning actor.
type Owners map[string]string

// Result is one attempt to resolve owners and repositories.
type Result struct {
	Owners Owners `json:"owners,omitempty"`
	// Repos is every repository the map declares, in the map's order; `a` links the first.
	Repos []string `json:"repositories,omitempty"`
	// Note says why Owners is empty or partial: architect missing, no map, or the command's last line.
	Note string `json:"note,omitempty"`
	// MapModTime is the map's mtime at the time of the call, so a caller can re-ask only when it moves.
	MapModTime time.Time `json:"-"`
}

// Timeout bounds one architect call.
var Timeout = 10 * time.Second

// Resolve runs `architect territories --json --map <path>` for the owners and
// `architect check --format json --map <path>` for the repositories.
func Resolve(mapPath string) Result {
	if mapPath == "" {
		return Result{Note: "no map configured"}
	}
	st, err := os.Stat(mapPath)
	if err != nil {
		return Result{Note: "map not found: " + filepath.Base(mapPath)}
	}
	r := Result{MapModTime: st.ModTime()}
	bin, err := exec.LookPath("architect")
	if err != nil {
		r.Note = "architect not on PATH"
		return r
	}
	out, err := architect(bin, "territories", "--json", "--map", mapPath)
	if err != nil {
		r.Note = "architect: " + err.Error()
		return r
	}
	owners, err := ParseTerritories(out)
	if err != nil {
		r.Note = "architect: " + err.Error()
		return r
	}
	r.Owners = owners
	// The repositories ride on the validator's own output; a failure here costs `a` its repo link and nothing else.
	if out, err := architect(bin, "check", "--format", "json", "--map", mapPath); err == nil {
		r.Repos, _ = ParseRepositories(out)
	}
	return r
}

func architect(bin string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), Timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, args...).Output()
	if err != nil {
		var ee *exec.ExitError
		msg := err.Error()
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			lines := strings.Split(strings.TrimSpace(string(ee.Stderr)), "\n")
			msg = lines[len(lines)-1]
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			msg = fmt.Sprintf("architect timed out after %s", Timeout)
		}
		return nil, errors.New(msg)
	}
	return out, nil
}

// ParseTerritories reads the array `architect territories --json` prints; only name and owner are used.
func ParseTerritories(raw []byte) (Owners, error) {
	var list []struct {
		Name  string `json:"name"`
		Owner string `json:"owner"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("unexpected territories output: %v", err)
	}
	o := Owners{}
	for _, t := range list {
		o[t.Name] = t.Owner
	}
	return o, nil
}

// ParseRepositories reads the keys of `map.repositories` from `architect check
// --format json`, in the order the map declares them. `map` is present only
// when the map has no errors, so an invalid map yields none.
func ParseRepositories(raw []byte) ([]string, error) {
	var doc struct {
		Map json.RawMessage `json:"map"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("unexpected check output: %v", err)
	}
	if len(doc.Map) == 0 {
		return nil, nil
	}
	var m struct {
		Repositories json.RawMessage `json:"repositories"`
	}
	if err := json.Unmarshal(doc.Map, &m); err != nil {
		return nil, fmt.Errorf("unexpected check output: %v", err)
	}
	if len(m.Repositories) == 0 {
		return nil, nil
	}
	// Walk the object's tokens so the keys come back in the map's order, which a Go map would lose.
	dec := json.NewDecoder(bytes.NewReader(m.Repositories))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return nil, fmt.Errorf("unexpected repositories shape")
	}
	var names []string
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return nil, err
		}
		names = append(names, fmt.Sprint(key))
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return nil, err
		}
	}
	return names, nil
}

// RoutesTo names the actors a task's territories route to: unique, in territory
// order, "?" for a territory the map does not declare, and "" for no territories.
func (o Owners) RoutesTo(territories []string) string {
	if len(territories) == 0 {
		return ""
	}
	if o == nil {
		return ""
	}
	seen := map[string]bool{}
	var out []string
	for _, t := range territories {
		owner, ok := o[t]
		if !ok {
			owner = "?"
		}
		if !seen[owner] {
			seen[owner] = true
			out = append(out, owner)
		}
	}
	return strings.Join(out, ",")
}

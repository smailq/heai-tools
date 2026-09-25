package web

// The map editor: the architecture map drawn as a system, edited one field at a
// time with live validation through architect, and saved back to the map file
// this server resolved. It is the one page here that writes, and it writes one
// file: the map, on an explicit Save, only when architect calls the new text
// valid and only when the file on disk is still the version the page loaded.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// ArchitectTimeout bounds one architect call made for the editor.
var ArchitectTimeout = 15 * time.Second

// bodyLimit caps what a page may post: a map, or the repositories of one.
const bodyLimit = 5 << 20

// mapAPI routes the editor's endpoints; the page uses relative URLs, so it
// finds them under /map/api/ wherever it was loaded from.
func (s *Server) mapAPI(mux *http.ServeMux) {
	mux.HandleFunc("GET /map", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/map/", http.StatusMovedPermanently)
	})
	mux.HandleFunc("GET /map/api/file", s.mapFile)
	mux.HandleFunc("PUT /map/api/file", s.mapSave)
	mux.HandleFunc("POST /map/api/validate", s.mapValidate)
	mux.HandleFunc("POST /map/api/serialize", s.mapSerialize)
	mux.HandleFunc("POST /map/api/tree", s.mapTree)
	mux.HandleFunc("POST /map/api/tasks", s.mapTasks)
	mux.HandleFunc("GET /map/api/template", s.mapTemplate)
	assets, _ := fs.Sub(mapFS, "map")
	mux.Handle("GET /map/", http.StripPrefix("/map/", http.FileServerFS(assets)))
}

// mapPath is the map this server edits: the one the tracker and the other panes read.
func (s *Server) mapPath() string { return s.snapshot().Snap.MapPath }

func sendJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func sendError(w http.ResponseWriter, code int, msg string) {
	sendJSON(w, code, map[string]string{"error": msg})
}

// version names one content of the map file, so a save can say which one it replaces.
func version(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// fileState is what GET /map/api/file answers: the map's text and version, or that it does not exist yet.
type fileState struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Exists  bool   `json:"exists"`
	YAML    string `json:"yaml"`
	Version string `json:"version"`
}

func readMapFile(path string) (fileState, error) {
	st := fileState{Path: path, Name: filepath.Base(path)}
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	st.Exists, st.YAML, st.Version = true, string(raw), version(raw)
	return st, nil
}

func (s *Server) mapFile(w http.ResponseWriter, r *http.Request) {
	path := s.mapPath()
	if path == "" {
		sendError(w, http.StatusNotFound, "no map configured: start with --map <path> or --dir <project>")
		return
	}
	st, err := readMapFile(path)
	if err != nil {
		sendError(w, http.StatusInternalServerError, err.Error())
		return
	}
	sendJSON(w, http.StatusOK, st)
}

// mapSave writes the map: valid text only, and only over the version the page loaded
// unless the page says to overwrite. The write is a rename, so a reader never sees half a map.
func (s *Server) mapSave(w http.ResponseWriter, r *http.Request) {
	path := s.mapPath()
	if path == "" {
		sendError(w, http.StatusNotFound, "no map configured: start with --map <path> or --dir <project>")
		return
	}
	var body struct {
		YAML  string `json:"yaml"`
		Base  string `json:"base"`
		Force bool   `json:"force"`
	}
	if err := decodeBody(r, &body); err != nil {
		sendError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(body.YAML) == "" {
		sendError(w, http.StatusBadRequest, "refusing to save an empty map")
		return
	}
	v, err := architectCheck(r.Context(), []byte(body.YAML))
	if err != nil {
		sendError(w, http.StatusServiceUnavailable, "cannot validate, so not saving: "+err.Error())
		return
	}
	if !v.Valid {
		sendJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "the map does not validate; not saved", "validation": v})
		return
	}

	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	cur, err := readMapFile(path)
	if err != nil {
		sendError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !body.Force && cur.Version != body.Base {
		sendJSON(w, http.StatusConflict, map[string]any{"error": "the file changed on disk since this page loaded it", "file": cur})
		return
	}
	if err := writeAtomic(path, []byte(body.YAML)); err != nil {
		sendError(w, http.StatusInternalServerError, err.Error())
		return
	}
	saved, _ := readMapFile(path)
	sendJSON(w, http.StatusOK, saved)
}

// writeAtomic replaces path with data through a temporary file beside it, keeping the old file's mode.
func writeAtomic(path string, data []byte) error {
	mode := fs.FileMode(0o644)
	if st, err := os.Stat(path); err == nil {
		mode = st.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// validation is `heai-architect check --format json` without its path: what the page expects of /api/validate.
type validation struct {
	Valid    bool            `json:"valid"`
	Errors   []string        `json:"errors"`
	Warnings []string        `json:"warnings"`
	Map      json.RawMessage `json:"map,omitempty"`
}

// architectCheck validates a map's text with architect, the reference validator, through
// a temporary file: `check` takes a path, and the text being edited is not the map on disk.
func architectCheck(ctx context.Context, text []byte) (validation, error) {
	var v validation
	bin, err := exec.LookPath("heai-architect")
	if err != nil {
		return v, errors.New("heai-architect not on PATH")
	}
	f, err := os.CreateTemp("", "heai-operator-map-*.yaml")
	if err != nil {
		return v, err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(text); err != nil {
		f.Close()
		return v, err
	}
	f.Close()
	ctx, cancel := context.WithTimeout(ctx, ArchitectTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "check", f.Name(), "--format", "json").Output()
	// check exits 1 for an invalid map and still prints its answer; anything else without JSON is a failure.
	if jerr := json.Unmarshal(out, &v); jerr != nil {
		if err == nil {
			err = jerr
		}
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			lines := strings.Split(strings.TrimSpace(string(ee.Stderr)), "\n")
			err = errors.New(lines[len(lines)-1])
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			err = fmt.Errorf("architect timed out after %s", ArchitectTimeout)
		}
		return v, err
	}
	if v.Errors == nil {
		v.Errors = []string{}
	}
	if v.Warnings == nil {
		v.Warnings = []string{}
	}
	return v, nil
}

// mapValidate is {"yaml": "..."} or {"map": {...}} → architect's verdict. A map that
// cannot be validated at all is answered as invalid, with why, so the page says it.
func (s *Server) mapValidate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		YAML *string         `json:"yaml"`
		Map  json.RawMessage `json:"map"`
	}
	if err := decodeBody(r, &body); err != nil {
		sendError(w, http.StatusBadRequest, err.Error())
		return
	}
	var text []byte
	switch {
	case body.YAML != nil:
		text = []byte(*body.YAML)
	case len(body.Map) > 0:
		y, err := jsonToYAML(body.Map, nil)
		if err != nil {
			sendError(w, http.StatusBadRequest, err.Error())
			return
		}
		text = y
	default:
		sendError(w, http.StatusBadRequest, `body must be {"yaml": "..."} or {"map": {...}}`)
		return
	}
	v, err := architectCheck(r.Context(), text)
	if err != nil {
		sendJSON(w, http.StatusOK, validation{Errors: []string{"cannot validate: " + err.Error()}, Warnings: []string{}})
		return
	}
	sendJSON(w, http.StatusOK, v)
}

func (s *Server) mapSerialize(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Map json.RawMessage `json:"map"`
		// Base is the text the page loaded; its comments and layout carry over to what is written.
		// Without one, the file on disk is the base.
		Base *string `json:"base"`
	}
	if err := decodeBody(r, &body); err != nil || len(body.Map) == 0 || body.Map[0] != '{' {
		sendError(w, http.StatusBadRequest, `body must be {"map": {...}, "base"?: "..."}`)
		return
	}
	var base []byte
	if body.Base != nil {
		base = []byte(*body.Base)
	} else if p := s.mapPath(); p != "" {
		base, _ = os.ReadFile(p)
	}
	y, err := jsonToYAML(body.Map, base)
	if err != nil {
		sendError(w, http.StatusBadRequest, err.Error())
		return
	}
	sendJSON(w, http.StatusOK, map[string]string{"yaml": string(y)})
}

func (s *Server) mapTemplate(w http.ResponseWriter, r *http.Request) {
	bin, err := exec.LookPath("heai-architect")
	if err != nil {
		sendError(w, http.StatusServiceUnavailable, "heai-architect not on PATH")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ArchitectTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "template").Output()
	if err != nil {
		sendError(w, http.StatusServiceUnavailable, "architect template: "+err.Error())
		return
	}
	sendJSON(w, http.StatusOK, map[string]string{"yaml": string(out)})
}

// jsonToYAML writes a JSON document as YAML, keeping the order of every object's keys -
// the order the map's author gave actors, repositories and territories - and writing
// multiline strings as literal blocks, as a person would. With a base, the YAML the map
// was loaded from, every part of the base that the document leaves as it was keeps its
// comments, its quoting and its blank lines, so a save changes only what was edited.
func jsonToYAML(raw, base []byte) ([]byte, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	node, err := jsonNode(dec)
	if err != nil {
		return nil, fmt.Errorf("map: %v", err)
	}
	doc := &yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{node}}
	var old yaml.Node
	if len(base) > 0 && yaml.Unmarshal(base, &old) == nil && old.Kind == yaml.DocumentNode && len(old.Content) == 1 {
		markBlankLines(&old, strings.Split(string(base), "\n"))
		old.Content[0] = merge(old.Content[0], node)
		doc = &old
	}
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(doc); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return realignComments(unmarkBlankLines(buf.Bytes()), base), nil
}

// realignComments puts back the spacing a line had before its trailing comment, which
// the encoder collapses to one space, on every line that is otherwise as it was.
func realignComments(out, base []byte) []byte {
	if len(base) == 0 {
		return out
	}
	orig := map[string]string{}
	for _, l := range strings.Split(string(base), "\n") {
		if strings.Contains(l, "#") {
			orig[collapseComment(l)] = l
		}
	}
	lines := strings.Split(string(out), "\n")
	for i, l := range lines {
		if strings.Contains(l, " #") {
			if o, ok := orig[collapseComment(l)]; ok {
				lines[i] = o
			}
		}
	}
	return []byte(strings.Join(lines, "\n"))
}

var commentGap = regexp.MustCompile(`\s+#`)

func collapseComment(l string) string { return commentGap.ReplaceAllString(l, " #") }

// blankMarker stands in, as a head comment, for a blank line the encoder would drop.
const blankMarker = "#heai-operator:blank-line"

// markBlankLines gives every mapping key that followed a blank line in the source a
// marker comment, since the encoder keeps comments and drops blank lines.
func markBlankLines(n *yaml.Node, lines []string) {
	if n.Kind == yaml.MappingNode {
		for i := 0; i+1 < len(n.Content); i += 2 {
			k := n.Content[i]
			// The line above the key, or above its head comment.
			above := k.Line - strings.Count(k.HeadComment, "\n") - 3
			if k.HeadComment == "" {
				above = k.Line - 2
			}
			if above >= 0 && above < len(lines) && strings.TrimSpace(lines[above]) == "" && k.Line > 1 {
				if k.HeadComment == "" {
					k.HeadComment = blankMarker
				} else {
					k.HeadComment = blankMarker + "\n" + k.HeadComment
				}
			}
		}
	}
	for _, c := range n.Content {
		markBlankLines(c, lines)
	}
}

func unmarkBlankLines(out []byte) []byte {
	lines := strings.Split(string(out), "\n")
	for i, l := range lines {
		if strings.TrimSpace(l) == blankMarker {
			lines[i] = ""
		}
	}
	return []byte(strings.Join(lines, "\n"))
}

// merge is next as the document to write, built from old wherever next leaves old's
// value as it was: a mapping keeps old's key nodes, with their comments, in next's
// order; a list merges item by item; a scalar that did not change keeps its style.
func merge(old, next *yaml.Node) *yaml.Node {
	if old == nil || old.Kind != next.Kind {
		return next
	}
	switch next.Kind {
	case yaml.MappingNode:
		keys := map[string][2]*yaml.Node{}
		for i := 0; i+1 < len(old.Content); i += 2 {
			keys[old.Content[i].Value] = [2]*yaml.Node{old.Content[i], old.Content[i+1]}
		}
		out := *old
		out.Content = nil
		for i := 0; i+1 < len(next.Content); i += 2 {
			k, v := next.Content[i], next.Content[i+1]
			if kv, ok := keys[k.Value]; ok {
				k, v = kv[0], merge(kv[1], v)
			}
			out.Content = append(out.Content, k, v)
		}
		return &out
	case yaml.SequenceNode:
		out := *old
		out.Content = nil
		for i, v := range next.Content {
			if i < len(old.Content) {
				v = merge(old.Content[i], v)
			}
			out.Content = append(out.Content, v)
		}
		if len(out.Content) == 0 {
			// An empty list reads as [] whatever style the full one had.
			out.Style = yaml.FlowStyle
		}
		return &out
	case yaml.ScalarNode:
		if old.Value == next.Value && old.ShortTag() == next.ShortTag() {
			return old
		}
		out := *next
		out.HeadComment, out.LineComment, out.FootComment = old.HeadComment, old.LineComment, old.FootComment
		return &out
	}
	return next
}

func jsonNode(dec *json.Decoder) (*yaml.Node, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			n := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
			for dec.More() {
				k, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, ok := k.(string)
				if !ok {
					return nil, fmt.Errorf("object key %v is not a string", k)
				}
				v, err := jsonNode(dec)
				if err != nil {
					return nil, err
				}
				n.Content = append(n.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, v)
			}
			_, err := dec.Token()
			return n, err
		case '[':
			n := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
			for dec.More() {
				v, err := jsonNode(dec)
				if err != nil {
					return nil, err
				}
				n.Content = append(n.Content, v)
			}
			// A short list of scalars reads best inline, as the maps write globs and dependsOn.
			if len(n.Content) > 0 && len(n.Content) <= 8 && allScalars(n.Content) {
				n.Style = yaml.FlowStyle
			}
			_, err := dec.Token()
			return n, err
		}
	case string:
		n := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: t}
		if strings.Contains(t, "\n") {
			n.Style = yaml.LiteralStyle
		}
		return n, nil
	case json.Number:
		tag := "!!int"
		if strings.ContainsAny(t.String(), ".eE") {
			tag = "!!float"
		}
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: tag, Value: t.String()}, nil
	case bool:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: fmt.Sprint(t)}, nil
	case nil:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!null", Value: "null"}, nil
	}
	return nil, fmt.Errorf("unexpected token %v", tok)
}

func allScalars(nodes []*yaml.Node) bool {
	for _, n := range nodes {
		if n.Kind != yaml.ScalarNode || n.Style == yaml.LiteralStyle {
			return false
		}
	}
	return true
}

// ── The file tree, from each repository's declared localPath ──
// A git checkout is listed by `git ls-files`, so ignored files stay out; anything
// else is walked. A relative localPath resolves against the map's directory, the
// file it is written in.

const fileLimit = 20000

var skipDirs = map[string]bool{".git": true, "node_modules": true}

type treeRepo struct {
	Name      string   `json:"name"`
	LocalPath *string  `json:"localPath"`
	Root      *string  `json:"root"`
	Files     []string `json:"files"`
	Truncated bool     `json:"truncated"`
	Error     string   `json:"error,omitempty"`
}

func (s *Server) mapTree(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Repositories map[string]struct {
			LocalPath any `json:"localPath"`
		} `json:"repositories"`
	}
	if err := decodeBody(r, &body); err != nil || body.Repositories == nil {
		sendError(w, http.StatusBadRequest, `body must be {"repositories": {...}}`)
		return
	}
	base := s.opts.Cwd
	if p := s.mapPath(); p != "" {
		base = filepath.Dir(p)
	}
	names := make([]string, 0, len(body.Repositories))
	for n := range body.Repositories {
		names = append(names, n)
	}
	sort.Strings(names)
	repos := []treeRepo{}
	for _, name := range names {
		t := treeRepo{Name: name, Files: []string{}}
		declared, _ := body.Repositories[name].LocalPath.(string)
		if declared == "" {
			repos = append(repos, t)
			continue
		}
		root := expandHome(declared)
		if !filepath.IsAbs(root) {
			root = filepath.Join(base, root)
		}
		t.LocalPath, t.Root = &declared, &root
		if st, err := os.Stat(root); err != nil || !st.IsDir() {
			t.Error = "no such directory on this machine"
			repos = append(repos, t)
			continue
		}
		files := gitFiles(r.Context(), root)
		if files == nil {
			files = walkFiles(root)
		}
		sort.Strings(files)
		t.Files, t.Truncated = files, len(files) >= fileLimit
		repos = append(repos, t)
	}
	sendJSON(w, http.StatusOK, map[string]any{"repos": repos})
}

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, p[1:])
		}
	}
	return p
}

func gitFiles(ctx context.Context, root string) []string {
	if _, err := os.Stat(filepath.Join(root, ".git")); err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, ArchitectTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", root, "ls-files", "-z").Output()
	if err != nil {
		return nil
	}
	var files []string
	for _, f := range strings.Split(string(out), "\x00") {
		if f != "" {
			files = append(files, f)
		}
		if len(files) >= fileLimit {
			break
		}
	}
	return files
}

func walkFiles(root string) []string {
	files := []string{}
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			// An unreadable directory is skipped rather than failing the whole tree.
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if len(files) >= fileLimit {
			return fs.SkipAll
		}
		if d.IsDir() {
			if path != root && skipDirs[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		if d.Type().IsRegular() {
			rel, _ := filepath.Rel(root, path)
			files = append(files, filepath.ToSlash(rel))
		}
		return nil
	})
	return files
}

// mapTasks is the tracker this server already reads, in the shape the editor's
// Actors tab lists: one row per valid task, territory as the tracker writes it.
func (s *Server) mapTasks(w http.ResponseWriter, r *http.Request) {
	// The body names repositories, which the original server searched for trackers;
	// here the tracker is the one operator was pointed at, so the body is only drained.
	_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, bodyLimit))
	type row struct {
		Slug       string `json:"slug"`
		Title      string `json:"title"`
		Status     string `json:"status"`
		Priority   string `json:"priority"`
		Territory  string `json:"territory"`
		CreatedAt  string `json:"created_at"`
		ModifiedAt string `json:"modified_at"`
		Body       string `json:"body"`
	}
	rows := []row{}
	if t := s.snapshot().Snap.Tracker; t != nil {
		for _, task := range t.Tasks {
			if !task.Valid() {
				continue
			}
			body := task.Body
			if len(body) > 4000 {
				body = body[:4000]
			}
			rows = append(rows, row{task.Slug, task.Title, task.Status, task.Priority, strings.Join(task.Territories, ","), task.CreatedAt, task.ModifiedAt, body})
		}
	}
	sendJSON(w, http.StatusOK, map[string]any{"tasks": rows, "truncated": false})
}

func decodeBody(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, bodyLimit))
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("body: %v", err)
	}
	return nil
}

// apiGuard admits a request to the editor's API only from this server's own page.
// Every one must arrive under a Host that names this machine - an address, localhost,
// or a name given to --serve-host - so a page on a DNS name rebound to this machine
// cannot read the map or list directories through a visitor's browser. A request that
// changes something must also carry a JSON body, which a cross-site form cannot send
// without a preflight this server never answers, and an Origin, when the browser sends
// one, that is this host.
func apiGuard(r *http.Request, allowedHosts map[string]bool) error {
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.ToLower(strings.Trim(host, "[]"))
	if net.ParseIP(host) == nil && host != "localhost" && !allowedHosts[host] {
		return fmt.Errorf("host %q is not this machine's address; name it with --serve-host to edit the map through it", host)
	}
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return nil
	}
	if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		return errors.New("content type must be application/json")
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		if !strings.EqualFold(strings.TrimPrefix(strings.TrimPrefix(origin, "http://"), "https://"), r.Host) {
			return errors.New("cross-origin request refused")
		}
	}
	return nil
}

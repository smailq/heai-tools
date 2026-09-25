package web

// A flow definition drawn as the state machine it is: states as boxes, transitions
// as arrows labelled with the event that takes them and what the event must carry.
// The drawing is laid out here, in layers, and sent as SVG, so the page needs no
// script to show it and it reads the same in light and dark.
//
// The layout is the layered one every state-machine drawing tool uses, cut down to
// what a definition of a dozen states needs:
//
//  1. Walk the machine from its initial state; a transition back to a state still on
//     the walk closes a cycle and is drawn upward, so every other arrow points down.
//  2. Rank each state by its longest path from the initial one.
//  3. Put a layer between every two ranks for the transitions' labels, and give a
//     transition that spans several ranks a waypoint in every layer it crosses, so
//     labels and long arrows take room like states do and nothing is drawn over a box.
//  4. Order each layer to keep arrows short and uncrossed (barycentres, swept down and
//     up), then place each box under the mean of its neighbours without overlapping.

import (
	"fmt"
	"html"
	"html/template"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/smailq/heai-tools/tools/operator/internal/flows"
)

// Machine is one definition to draw, and what to mark on it.
type Machine struct {
	Def flows.Definition
	// Counts is how many flows stand in each state: the open ones, and for a terminal state every flow that ended there.
	Counts map[string]int
	// Current is the state one flow stands in; Taken the moves it made and Visited the states it passed through.
	Current string
	Taken   map[[2]string]bool
	Visited map[string]bool
	// Href is where a state links, or "" for no link.
	Href func(state string) string
}

// sizes, in pixels, for a 12px monospace face: the page's own.
const (
	charW      = 7.2
	smallCharW = 6.6
	lineH      = 14.0
	nodeH      = 34.0
	nodePadX   = 14.0
	gapX       = 26.0
	gapY       = 14.0
	dummyW     = 8.0
	margin     = 20.0
)

type item struct {
	state string   // a state's name, or "" for a waypoint
	label []string // the lines of the label this waypoint carries, if any
	w, h  float64
	x, y  float64
	layer int
	order float64
	loop  []string
}

// chain is one arrow: a transition, or several between the same two states, through its waypoints.
type chain struct {
	from, to string
	items    []*item // source, waypoints, target, all downward
	reversed bool    // drawn from the last item to the first
	label    []string
	taken    bool
}

// RenderMachine lays the definition out and returns it as an inline SVG.
func RenderMachine(m Machine) template.HTML {
	d := m.Def
	if len(d.States) == 0 {
		return ""
	}
	known := map[string]bool{}
	for _, s := range d.States {
		known[s] = true
	}

	// Transitions from three or more states to one, on the same event and conditions,
	// are one rule - "cancel from anywhere" - and are drawn as faint unlabelled arrows,
	// with the rule written once, on the state they reach.
	type group struct {
		t     flows.Transition
		froms []string
	}
	var groups []*group
	byRule := map[string]*group{}
	for _, t := range d.Transitions {
		if !known[t.From] || !known[t.To] {
			continue
		}
		key := t.To + "\x00" + strings.Join(transitionLabel(t), "\x00")
		g := byRule[key]
		if g == nil {
			g = &group{t: t}
			byRule[key] = g
			groups = append(groups, g)
		}
		g.froms = append(g.froms, t.From)
	}
	notes := map[string][]string{}
	type edge struct {
		from, to string
		label    []string
		wide     bool
	}
	var edges []*edge
	pair := map[[2]string]*edge{}
	for _, g := range groups {
		if len(g.froms) >= 3 && g.t.From != g.t.To {
			// Written on the state it reaches, and not drawn: five arrows saying one thing hide the rest.
			// They still rank the state, below every state they come from.
			notes[g.t.To] = append(notes[g.t.To], "← "+strings.Join(transitionLabel(g.t), " ")+", from any of")
			notes[g.t.To] = append(notes[g.t.To], wrapWords(g.froms, 34)...)
			for _, f := range g.froms {
				edges = append(edges, &edge{from: f, to: g.t.To, wide: true})
			}
			continue
		}
		for _, f := range g.froms {
			k := [2]string{f, g.t.To}
			if e := pair[k]; e != nil {
				e.label = append(e.label, transitionLabel(g.t)...)
				continue
			}
			e := &edge{from: f, to: g.t.To, label: transitionLabel(g.t)}
			pair[k] = e
			edges = append(edges, e)
		}
	}

	// 1. The walk: discovery order, and which transitions close a cycle.
	out := map[string][]*edge{}
	for _, e := range edges {
		out[e.from] = append(out[e.from], e)
	}
	order := map[string]int{}
	onStack := map[string]bool{}
	back := map[*edge]bool{}
	var walk func(s string)
	walk = func(s string) {
		order[s] = len(order)
		onStack[s] = true
		for _, e := range out[s] {
			switch {
			case e.to == s:
			case onStack[e.to]:
				back[e] = true
			case !hasKey(order, e.to):
				walk(e.to)
			}
		}
		onStack[s] = false
	}
	if known[d.Initial] {
		walk(d.Initial)
	}
	for _, s := range d.States {
		if !hasKey(order, s) {
			walk(s)
		}
	}

	// 2. Ranks: the longest path from the initial state over the downward arrows.
	rank := map[string]int{}
	down := func(e *edge) (string, string) {
		if back[e] {
			return e.to, e.from
		}
		return e.from, e.to
	}
	for changed, n := true, 0; changed && n <= len(d.States); n++ {
		changed = false
		for _, e := range edges {
			if e.from == e.to {
				continue
			}
			u, v := down(e)
			if rank[v] < rank[u]+1 {
				rank[v] = rank[u] + 1
				changed = true
			}
		}
	}

	// The states, as items on the even layers.
	items := map[string]*item{}
	var layers [][]*item
	put := func(it *item) {
		for len(layers) <= it.layer {
			layers = append(layers, nil)
		}
		it.order = float64(len(layers[it.layer]))
		layers[it.layer] = append(layers[it.layer], it)
	}
	states := append([]string(nil), d.States...)
	sort.SliceStable(states, func(i, j int) bool { return order[states[i]] < order[states[j]] })
	for _, s := range states {
		it := &item{state: s, layer: 2 * rank[s]}
		it.w = float64(len([]rune(s)))*charW + 2*nodePadX
		lines := 0
		if h, ok := m.Def.Hooks[s]; ok && h.Run != "" {
			it.w = max(it.w, float64(len([]rune(hookName(h.Run))))*smallCharW+2*nodePadX)
			lines++
		}
		for _, n := range notes[s] {
			it.w = max(it.w, float64(len([]rune(n)))*smallCharW+2*nodePadX)
			lines++
		}
		if m.Counts[s] > 0 {
			it.w += 26
		}
		it.h = nodeH + float64(lines)*lineH
		items[s] = it
		put(it)
	}

	// 3. The arrows: a waypoint in every layer between their ends, the first carrying the label.
	var chains []*chain
	for _, e := range edges {
		if e.wide {
			continue
		}
		c := &chain{from: e.from, to: e.to, label: e.label, taken: m.Taken[[2]string{e.from, e.to}]}
		if e.from == e.to {
			// A transition that stays: a loop on the box's right, its label beside it.
			it := items[e.from]
			it.loop = e.label
			w := 30.0
			for _, l := range e.label {
				w = max(w, float64(len([]rune(l)))*smallCharW+30)
			}
			it.w += w
			chains = append(chains, c)
			continue
		}
		u, v := down(e)
		c.reversed = back[e]
		c.items = append(c.items, items[u])
		for l := items[u].layer + 1; l < items[v].layer; l++ {
			wp := &item{layer: l, w: dummyW}
			if l == items[u].layer+1 && len(c.label) > 0 {
				wp.label = c.label
				for _, s := range c.label {
					wp.w = max(wp.w, float64(len([]rune(s)))*smallCharW+14)
				}
				wp.h = float64(len(c.label)) * lineH
			}
			put(wp)
			c.items = append(c.items, wp)
		}
		c.items = append(c.items, items[v])
		chains = append(chains, c)
	}

	// Neighbours across adjacent layers, from the chains' consecutive items.
	up := map[*item][]*item{}
	dn := map[*item][]*item{}
	for _, c := range chains {
		for i := 0; i+1 < len(c.items); i++ {
			a, b := c.items[i], c.items[i+1]
			dn[a] = append(dn[a], b)
			up[b] = append(up[b], a)
		}
	}

	// 4. Order: barycentres, swept down and up.
	bary := func(it *item, ns []*item) (float64, bool) {
		if len(ns) == 0 {
			return 0, false
		}
		sum := 0.0
		for _, n := range ns {
			sum += n.order
		}
		return sum / float64(len(ns)), true
	}
	sortLayer := func(l []*item, nb map[*item][]*item) {
		key := map[*item]float64{}
		for _, it := range l {
			if b, ok := bary(it, nb[it]); ok {
				key[it] = b
			} else {
				key[it] = it.order
			}
		}
		sort.SliceStable(l, func(i, j int) bool { return key[l[i]] < key[l[j]] })
		for i, it := range l {
			it.order = float64(i)
		}
	}
	for pass := 0; pass < 8; pass++ {
		if pass%2 == 0 {
			for i := 1; i < len(layers); i++ {
				sortLayer(layers[i], up)
			}
		} else {
			for i := len(layers) - 2; i >= 0; i-- {
				sortLayer(layers[i], dn)
			}
		}
	}

	// Place: pack each layer, then pull each item toward its neighbours' mean, keeping order and gaps.
	pack := func(l []*item, want []float64) {
		for i, it := range l {
			it.x = want[i]
			if i > 0 {
				prev := l[i-1]
				gap := gapX
				if prev.state == "" && it.state == "" && prev.label == nil && it.label == nil {
					// Two arrows passing through a layer need only clear each other.
					gap = 10
				}
				it.x = max(it.x, prev.x+(prev.w+it.w)/2+gap)
			}
		}
		shift := 0.0
		for i, it := range l {
			shift += want[i] - it.x
		}
		shift /= float64(len(l))
		for _, it := range l {
			it.x += shift
		}
	}
	for _, l := range layers {
		want := make([]float64, len(l))
		pack(l, want)
	}
	for pass := 0; pass < 12; pass++ {
		for li := range layers {
			i := li
			if pass%2 == 1 {
				i = len(layers) - 1 - li
			}
			l := layers[i]
			want := make([]float64, len(l))
			for j, it := range l {
				ns := append(append([]*item(nil), up[it]...), dn[it]...)
				if len(ns) == 0 {
					want[j] = it.x
					continue
				}
				sum := 0.0
				for _, n := range ns {
					sum += n.x
				}
				want[j] = sum / float64(len(ns))
			}
			pack(l, want)
		}
	}

	// Heights: each layer as tall as its tallest item.
	y := margin + 18
	minX, maxX := 1e9, -1e9
	for _, l := range layers {
		h := 0.0
		for _, it := range l {
			h = max(h, it.h)
		}
		if len(l) == 0 {
			h = 0
		}
		for _, it := range l {
			it.y = y + h/2
			minX = min(minX, it.x-it.w/2)
			maxX = max(maxX, it.x+it.w/2)
		}
		y += h + gapY
	}
	width := maxX - minX + 2*margin
	height := y + margin
	dx := margin - minX

	var b strings.Builder
	fmt.Fprintf(&b, `<svg class="machine" viewBox="0 0 %.0f %.0f" width="%.0f" height="%.0f" role="img" aria-label="%s">`,
		width, height, width, height, esc("state machine "+d.Name))
	b.WriteString(`<defs>`)
	for _, k := range []string{"arrow", "arrow-taken"} {
		fmt.Fprintf(&b, `<marker id="m-%s" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="%s" d="M0,0 L10,5 L0,10 z"/></marker>`, k, k)
	}
	b.WriteString(`</defs>`)

	// The initial state's entry: a dot and a short arrow onto its box.
	if it := items[d.Initial]; it != nil {
		cx, top := it.x+dx, it.y-it.h/2
		fmt.Fprintf(&b, `<circle class="entry" cx="%.1f" cy="%.1f" r="5"/><path class="edge" d="M%.1f,%.1f L%.1f,%.1f" marker-end="url(#m-arrow)"/>`,
			cx, top-18, cx, top-13, cx, top-1)
	}

	// Ports: where each arrow meets a box, spread along its bottom and top edges in the order of what they lead to.
	type port struct {
		c   *chain
		end bool
	}
	bottom := map[*item][]port{}
	topPorts := map[*item][]port{}
	for _, c := range chains {
		if len(c.items) < 2 {
			continue
		}
		bottom[c.items[0]] = append(bottom[c.items[0]], port{c, false})
		topPorts[c.items[len(c.items)-1]] = append(topPorts[c.items[len(c.items)-1]], port{c, true})
	}
	portX := map[*chain][2]float64{}
	spread := func(it *item, ps []port, idx int, near func(port) *item) {
		sort.SliceStable(ps, func(i, j int) bool { return near(ps[i]).x < near(ps[j]).x })
		boxW := it.w
		if it.loop != nil {
			boxW = it.w - loopWidth(it.loop)
		}
		left := it.x - boxW/2
		for i, p := range ps {
			xs := portX[p.c]
			xs[idx] = left + boxW*float64(i+1)/float64(len(ps)+1)
			portX[p.c] = xs
		}
	}
	for it, ps := range bottom {
		spread(it, ps, 0, func(p port) *item { return p.c.items[1] })
	}
	for it, ps := range topPorts {
		spread(it, ps, 1, func(p port) *item { return p.c.items[len(p.c.items)-2] })
	}

	// Arrows first, under the boxes; the taken ones last, over the rest.
	sort.SliceStable(chains, func(i, j int) bool { return !chains[i].taken && chains[j].taken })
	for _, c := range chains {
		if len(c.items) < 2 {
			continue
		}
		cls, marker := "edge", "arrow"
		if c.taken {
			cls, marker = "edge taken", "arrow-taken"
		}
		type pt struct{ x, y float64 }
		var pts []pt
		first, last := c.items[0], c.items[len(c.items)-1]
		xs := portX[c]
		pts = append(pts, pt{xs[0] + dx, first.y + first.h/2})
		for _, wp := range c.items[1 : len(c.items)-1] {
			if wp.label != nil {
				// The arrow runs straight down the label's left edge, the text beside it.
				x := wp.x - wp.w/2 + 4 + dx
				pts = append(pts, pt{x, wp.y - wp.h/2 - 2}, pt{x, wp.y + wp.h/2 + 2})
				continue
			}
			pts = append(pts, pt{wp.x + dx, wp.y})
		}
		pts = append(pts, pt{xs[1] + dx, last.y - last.h/2})
		var p strings.Builder
		fmt.Fprintf(&p, "M%.1f,%.1f", pts[0].x, pts[0].y)
		for i := 1; i < len(pts); i++ {
			a, z := pts[i-1], pts[i]
			if a.x == z.x {
				fmt.Fprintf(&p, " L%.1f,%.1f", z.x, z.y)
				continue
			}
			my := (z.y - a.y) / 2
			fmt.Fprintf(&p, " C%.1f,%.1f %.1f,%.1f %.1f,%.1f", a.x, a.y+my, z.x, z.y-my, z.x, z.y)
		}
		end := "marker-end"
		if c.reversed {
			end = "marker-start"
		}
		title := c.from + " → " + c.to
		if len(c.label) > 0 {
			title += ": " + strings.Join(c.label, "; ")
		}
		fmt.Fprintf(&b, `<g class="%s"><title>%s</title><path d="%s" %s="url(#m-%s)"/>`, cls, esc(title), p.String(), end, marker)
		for _, wp := range c.items[1 : len(c.items)-1] {
			if wp.label == nil {
				continue
			}
			tx := wp.x - wp.w/2 + 10 + dx
			ty := wp.y - wp.h/2 + lineH - 3
			for i, l := range wp.label {
				lc := "label"
				if !strings.HasPrefix(l, "  ") {
					lc = "label on"
				}
				fmt.Fprintf(&b, `<text class="%s" x="%.1f" y="%.1f">%s</text>`, lc, tx, ty+float64(i)*lineH, esc(strings.TrimSpace(l)))
			}
		}
		b.WriteString(`</g>`)
	}

	// The states.
	for _, s := range states {
		it := items[s]
		boxW := it.w
		if it.loop != nil {
			boxW -= loopWidth(it.loop)
		}
		x, y := it.x-it.w/2+dx, it.y-it.h/2
		cls := []string{"state"}
		if d.IsTerminal(s) {
			cls = append(cls, "terminal")
		}
		if s == d.Initial {
			cls = append(cls, "initial")
		}
		if m.Visited[s] {
			cls = append(cls, "visited")
		}
		if s == m.Current {
			cls = append(cls, "current")
		}
		if m.Counts[s] > 0 {
			cls = append(cls, "occupied")
		}
		href := ""
		if m.Href != nil {
			href = m.Href(s)
		}
		if href != "" {
			fmt.Fprintf(&b, `<a href="%s">`, esc(href))
		}
		fmt.Fprintf(&b, `<g class="%s"><title>%s</title>`, strings.Join(cls, " "), esc(stateTitle(d, s, m.Counts[s])))
		fmt.Fprintf(&b, `<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="8"/>`, x, y, boxW, it.h)
		if d.IsTerminal(s) {
			fmt.Fprintf(&b, `<rect class="inner" x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="6"/>`, x+3, y+3, boxW-6, it.h-6)
		}
		base := y + nodeH/2 + 4
		fmt.Fprintf(&b, `<text class="name" x="%.1f" y="%.1f">%s</text>`, x+nodePadX, base, esc(s))
		line := 1
		if h, ok := d.Hooks[s]; ok && h.Run != "" {
			fmt.Fprintf(&b, `<text class="sub" x="%.1f" y="%.1f">%s</text>`, x+nodePadX, base+float64(line)*lineH, esc(hookName(h.Run)))
			line++
		}
		for _, n := range notes[s] {
			fmt.Fprintf(&b, `<text class="sub" x="%.1f" y="%.1f">%s</text>`, x+nodePadX, base+float64(line)*lineH, esc(n))
			line++
		}
		if n := m.Counts[s]; n > 0 {
			fmt.Fprintf(&b, `<g class="count"><rect x="%.1f" y="%.1f" width="22" height="18" rx="9"/><text x="%.1f" y="%.1f">%d</text></g>`,
				x+boxW-28, y+nodeH/2-9, x+boxW-17, y+nodeH/2+4, n)
		}
		if it.loop != nil {
			lx := x + boxW
			fmt.Fprintf(&b, `<path class="edge" d="M%.1f,%.1f C%.1f,%.1f %.1f,%.1f %.1f,%.1f" marker-end="url(#m-arrow)"/>`,
				lx, y+8, lx+26, y-4, lx+26, y+it.h+4, lx, y+it.h-8)
			for i, l := range it.loop {
				fmt.Fprintf(&b, `<text class="label" x="%.1f" y="%.1f">%s</text>`, lx+30, y+lineH+float64(i)*lineH, esc(strings.TrimSpace(l)))
			}
		}
		b.WriteString(`</g>`)
		if href != "" {
			b.WriteString(`</a>`)
		}
	}
	b.WriteString(`</svg>`)
	return template.HTML(b.String())
}

// transitionLabel is what takes a transition, one line each: the event, then what its
// data must say, how long the state may last, what the waited flows must reach, and who
// may make the move. Lines after the first are indented, which is how they are drawn.
func transitionLabel(t flows.Transition) []string {
	lines := []string{t.On}
	if len(t.When) > 0 {
		keys := make([]string, 0, len(t.When))
		for k := range t.When {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var parts []string
		for _, k := range keys {
			parts = append(parts, fmt.Sprintf("%s=%v", k, t.When[k]))
		}
		lines = append(lines, "  when "+strings.Join(parts, " "))
	}
	if t.After != nil {
		lines = append(lines, "  after "+duration(time.Duration(*t.After)*time.Millisecond))
	}
	if t.Requires != nil && len(t.Requires.WaitsOn.All) > 0 {
		lines = append(lines, "  waits on: all "+strings.Join(t.Requires.WaitsOn.All, "|"))
	}
	if len(t.By) > 0 {
		lines = append(lines, "  by "+strings.Join(t.By, ", "))
	}
	return lines
}

// duration is a definition's own spelling of an interval: 12h, 10m, 90s.
func duration(d time.Duration) string {
	switch {
	case d%(24*time.Hour) == 0:
		return fmt.Sprintf("%dd", d/(24*time.Hour))
	case d%time.Hour == 0:
		return fmt.Sprintf("%dh", d/time.Hour)
	case d%time.Minute == 0:
		return fmt.Sprintf("%dm", d/time.Minute)
	case d%time.Second == 0:
		return fmt.Sprintf("%ds", d/time.Second)
	}
	return d.String()
}

// hookName is the script a state runs, by its file name and arguments: "▸ start.sh".
func hookName(run string) string {
	f := strings.Fields(run)
	if len(f) == 0 {
		return ""
	}
	f[0] = path.Base(f[0])
	return "▸ " + strings.Join(f, " ")
}

func stateTitle(d flows.Definition, s string, n int) string {
	var parts []string
	parts = append(parts, s)
	switch {
	case s == d.Initial:
		parts = append(parts, "initial")
	case d.IsTerminal(s):
		parts = append(parts, "terminal")
	}
	if h, ok := d.Hooks[s]; ok {
		parts = append(parts, "on entry runs "+h.Run)
	}
	if n > 0 {
		parts = append(parts, fmt.Sprintf("%d flow(s) here", n))
	}
	return strings.Join(parts, " · ")
}

func loopWidth(label []string) float64 {
	w := 30.0
	for _, l := range label {
		w = max(w, float64(len([]rune(l)))*smallCharW+30)
	}
	return w
}

// wrapWords joins words into lines of at most width characters, indented as a label's continuation.
func wrapWords(words []string, width int) []string {
	var lines []string
	cur := ""
	for _, w := range words {
		if cur != "" && len(cur)+1+len(w) > width {
			lines = append(lines, "  "+cur)
			cur = ""
		}
		if cur != "" {
			cur += " "
		}
		cur += w
	}
	if cur != "" {
		lines = append(lines, "  "+cur)
	}
	return lines
}

func hasKey(m map[string]int, k string) bool { _, ok := m[k]; return ok }

func esc(s string) string { return html.EscapeString(s) }

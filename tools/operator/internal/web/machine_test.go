package web

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/smailq/heai-tools/tools/operator/internal/flows"
)

func definitions(t *testing.T) map[string]flows.Definition {
	t.Helper()
	defs := must(flows.ParseDefinitions(readFixture(t, "flow", "definitions.json")))
	out := map[string]flows.Definition{}
	for _, d := range defs {
		out[d.Name] = d
	}
	return out
}

var stateBox = regexp.MustCompile(`<g class="state[^"]*"><title>([^<]*)</title><rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"`)

type box struct {
	name       string
	x, y, w, h float64
}

func boxes(t *testing.T, svg string) []box {
	t.Helper()
	var out []box
	for _, m := range stateBox.FindAllStringSubmatch(svg, -1) {
		f := func(s string) float64 { v, _ := strconv.ParseFloat(s, 64); return v }
		out = append(out, box{strings.Split(m[1], " · ")[0], f(m[2]), f(m[3]), f(m[4]), f(m[5])})
	}
	return out
}

// Every definition draws every state once, in a box no other box overlaps, the same way each time.
func TestMachineLayout(t *testing.T) {
	for name, d := range definitions(t) {
		svg := string(RenderMachine(Machine{Def: d}))
		if again := string(RenderMachine(Machine{Def: d})); again != svg {
			t.Errorf("%s: two renderings differ", name)
		}
		bs := boxes(t, svg)
		if len(bs) != len(d.States) {
			t.Fatalf("%s: %d boxes for %d states", name, len(bs), len(d.States))
		}
		for i, a := range bs {
			for _, b := range bs[i+1:] {
				if a.x < b.x+b.w && b.x < a.x+a.w && a.y < b.y+b.h && b.y < a.y+a.h {
					t.Errorf("%s: %s and %s overlap", name, a.name, b.name)
				}
			}
		}
		// The initial state sits above every state it can reach first.
		var initY float64
		for _, b := range bs {
			if b.name == d.Initial {
				initY = b.y
			}
		}
		for _, tr := range d.Transitions {
			if tr.From == d.Initial {
				for _, b := range bs {
					if b.name == tr.To && b.y <= initY {
						t.Errorf("%s: %s is not below the initial %s", name, tr.To, d.Initial)
					}
				}
			}
		}
		if got := strings.Count(svg, `class="inner"`); got != len(d.Terminal) {
			t.Errorf("%s: %d terminal borders for %d terminal states", name, got, len(d.Terminal))
		}
	}
}

// The session: each event is written, the clock and the guards on their arrows, and the
// cancel-from-anywhere rule once, on canceled, instead of five arrows.
func TestMachineLabels(t *testing.T) {
	d := definitions(t)["session"]
	svg := string(RenderMachine(Machine{Def: d, Counts: map[string]int{"blocked": 2}}))
	for _, want := range []string{">started<", ">answered<", ">after 12h<", ">when exitCode=0<", ">when requested=true<", ">waits on: all done<", "▸ finish.sh", "← canceled, from any of", `class="state occupied"`, `<text x=`} {
		if !strings.Contains(svg, want) {
			t.Errorf("missing %q", want)
		}
	}
	if n := strings.Count(svg, ">canceled<"); n != 1 {
		t.Errorf("canceled written %d times, want once: as the state's own name", n)
	}
	// A cycle is drawn upward: its arrow ends at the start of its path.
	if !strings.Contains(svg, `marker-start="url(#m-arrow)"`) {
		t.Error("no arrow closes a cycle")
	}
}

// What the definition names is text, never markup.
func TestMachineEscapes(t *testing.T) {
	svg := string(RenderMachine(Machine{Def: flows.Definition{
		Name: "x", States: []string{"a", "<b>"}, Initial: "a", Terminal: []string{"<b>"},
		Transitions: []flows.Transition{{From: "a", To: "<b>", On: `"><script>alert(1)</script>`}},
	}}))
	if strings.Contains(svg, "<script>") || strings.Contains(svg, "<b>") {
		t.Fatalf("unescaped:\n%s", svg)
	}
}

func TestMachinesTab(t *testing.T) {
	srv := fixture(t)
	code, body := get(t, srv, "/machines")
	if code != http.StatusOK || !strings.Contains(body, `<svg class="machine"`) || !strings.Contains(body, `class="tab on"><b>machines`) {
		t.Fatalf("/machines: %d", code)
	}
	// The definition with the most open flows opens first.
	if !strings.Contains(body, `href="/machines/session" class="on"`) {
		t.Error("session is not the one shown first")
	}
	_, body = get(t, srv, "/machines/session?state=blocked")
	if !strings.Contains(body, "20260906-024801-session-77f0") || strings.Contains(body, "20260906-031244-session-9a1c") {
		t.Error("?state=blocked does not narrow the flows to blocked")
	}
	if code, _ := get(t, srv, "/machines/nope"); code != http.StatusNotFound {
		t.Errorf("/machines/nope: %d, want 404", code)
	}
	// A flow's page draws its definition with the moves the trace recorded.
	_, body = get(t, srv, "/flows/20260906-024801-session-77f0")
	if !strings.Contains(body, `class="edge taken"`) || !strings.Contains(body, `current`) {
		t.Error("the flow page does not mark the way the flow came")
	}
}

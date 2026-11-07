package hvr

import (
	"strings"
	"testing"
)

func TestBuiltinSymbolsAllLoad(t *testing.T) {
	lib := BuiltinSymbols()
	for _, e := range lib.Errors {
		t.Error(e)
	}

	// Every id the rest of hoverdeck can hand the canvas must exist, or that
	// block silently degrades to the fallback glyph.
	want := map[string]bool{"analog": true, "digital": true, "structural": true, "filter": true, "vsource": true}
	for _, p := range Primitives() {
		want[p.Icon] = true
	}
	for _, ic := range moduleIcons {
		want[ic] = true
	}
	for _, f := range stdlibFamilyIcons {
		want[f.icon] = true
	}
	for id := range want {
		if lib.Get(id) == nil {
			t.Errorf("no built-in symbol %q", id)
		}
	}

	// Primitives are pin-anchored symbols, never header-only glyphs.
	for _, p := range Primitives() {
		if s := lib.Get(p.Icon); s != nil && s.IconOnly() {
			t.Errorf("primitive %s uses %q, which has no pins", p.Name, p.Icon)
		}
	}
}

// Every built-in primitive must fit its own symbol, port for port, or it
// would draw as a box.
func TestPrimitivesFitTheirSymbols(t *testing.T) {
	lib := BuiltinSymbols()
	for _, p := range Primitives() {
		pins := make([]Pin, len(p.Ports))
		for i, n := range p.Ports {
			pins[i] = Pin{Index: i, Name: n}
		}
		if FitSymbol(lib.Get(p.Icon), pins) == nil {
			t.Errorf("%s %v does not fit symbol %q", p.Name, p.Ports, p.Icon)
		}
	}
}

func pinsNamed(names ...string) []Pin {
	out := make([]Pin, len(names))
	for i, n := range names {
		out[i] = Pin{Index: i, Name: n}
	}
	return out
}

// The port lists below are the standard library's, verbatim.
func TestFitSymbolAgainstStdlibPorts(t *testing.T) {
	lib := BuiltinSymbols()
	cases := []struct {
		symbol string
		ports  []string
		want   []string // symbol pin each port lands on; nil = must not fit
	}{
		{"npn", []string{"base", "collector", "emitter"}, []string{"base", "collector", "emitter"}},
		{"pnp", []string{"base", "collector", "emitter"}, []string{"base", "collector", "emitter"}},
		{"nmos", []string{"gate", "drain", "source"}, []string{"gate", "drain", "source"}},
		{"nmos4", []string{"gate", "drain", "source", "bulk"}, []string{"gate", "drain", "source", "bulk"}},
		{"pmos4", []string{"gate", "drain", "source", "bulk"}, []string{"gate", "drain", "source", "bulk"}},
		{"diode", []string{"anode", "cathode"}, []string{"anode", "cathode"}},
		{"opamp", []string{"minus", "plus", "out"}, []string{"minus", "plus", "out"}},
		{"motor", []string{"va", "vb", "vc"}, []string{"va", "vb", "vc"}},

		// LED colours prefix their ports, and add the optical output.
		{"led", []string{"led_anode", "led_cathode", "light_out"}, []string{"anode", "cathode", "light_out"}},
		// The optical pin is optional: a plain two-terminal LED fits too.
		{"led", []string{"anode", "cathode"}, []string{"anode", "cathode"}},

		// Aliases, in a user's own module.
		{"npn", []string{"b", "c", "e"}, []string{"base", "collector", "emitter"}},
		{"opamp", []string{"inn", "inp", "vout", "vcc", "vee"}, []string{"minus", "plus", "out", "vpos", "vneg"}},

		// The 3-terminal symbol has no bulk pin, so a 4-terminal device is a box.
		{"nmos", []string{"gate", "drain", "source", "bulk"}, nil},
		// A required pin left over: a diode symbol on a 1-port block.
		{"diode", []string{"anode"}, nil},
		// A port nothing matches.
		{"npn", []string{"base", "collector", "sink"}, nil},
		// An unresolved module's positional names.
		{"npn", []string{"p1", "p2", "p3"}, nil},
		// Header glyphs never fit.
		{"structural", []string{"a"}, nil},
	}
	for _, c := range cases {
		sym := lib.Get(c.symbol)
		got := FitSymbol(sym, pinsNamed(c.ports...))
		if c.want == nil {
			if got != nil {
				t.Errorf("%s %v: fit %v, want no fit", c.symbol, c.ports, got)
			}
			continue
		}
		if got == nil {
			t.Errorf("%s %v: no fit", c.symbol, c.ports)
			continue
		}
		for i, j := range got {
			if sym.Pins[j].Name != c.want[i] {
				t.Errorf("%s: port %q -> pin %q, want %q", c.symbol, c.ports[i], sym.Pins[j].Name, c.want[i])
			}
		}
	}
}

// An exact name must win over an alias claimed earlier in port order: "c" is
// an alias of collector, but a block that also has a port literally called
// "collector" should get that one.
func TestFitSymbolPrefersExactNames(t *testing.T) {
	sym := BuiltinSymbols().Get("npn")
	got := FitSymbol(sym, pinsNamed("base", "emitter", "collector"))
	if got == nil {
		t.Fatal("no fit")
	}
	for i, want := range []string{"base", "emitter", "collector"} {
		if sym.Pins[got[i]].Name != want {
			t.Errorf("port %d -> %q, want %q", i, sym.Pins[got[i]].Name, want)
		}
	}
}

func TestFitSymbolsUsesTheFinalIcon(t *testing.T) {
	sh := &Sheet{Blocks: []Block{
		{ID: "q1", Icon: "npn", Pins: pinsNamed("base", "collector", "emitter")},
		{ID: "x1", Icon: "structural", Pins: pinsNamed("a", "b")},
		{ID: "x2", Icon: "no-such-symbol", Pins: pinsNamed("a", "b")},
	}}
	FitSymbols(sh, BuiltinSymbols())
	if sh.Blocks[0].SymPins == nil {
		t.Error("q1 should fit npn")
	}
	if sh.Blocks[1].SymPins != nil || sh.Blocks[2].SymPins != nil {
		t.Error("header glyphs and unknown symbols must leave SymPins nil")
	}
}

const symHead = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-16 -32 32 64">`

func TestParseSymbolSanitises(t *testing.T) {
	src := symHead + `
	  <title>preview</title>
	  <style>.fill{fill:red}</style>
	  <sodipodi:namedview xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" pagecolor="#fff"/>
	  <path id="p1" d="M0 -32  V-20" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" inkscape:label="lead"/>
	  <g><rect x="-8" y="-20" width="16" height="40" class="bold"/></g>
	  <circle data-pin="a" data-dir="up" cx="0" cy="-32" r="2"/>
	</svg>`
	sym, err := ParseSymbol("t", []byte(src))
	if err != nil {
		t.Fatal(err)
	}
	var all strings.Builder
	for _, p := range sym.Parts {
		all.WriteString(p.Markup)
	}
	got := all.String()
	if got != `<path d="M0 -32 V-20"/><g><rect x="-8" y="-20" width="16" height="40" class="bold"/></g>` {
		t.Errorf("markup = %s", got)
	}
	if len(sym.Pins) != 1 || sym.Pins[0].Name != "a" || sym.Pins[0].Dir != "up" || sym.Pins[0].Y != -32 {
		t.Errorf("pins = %+v", sym.Pins)
	}
}

// Anything that could run code, load something, or escape the drawing must
// make the symbol fail to load — never pass through.
func TestParseSymbolRejects(t *testing.T) {
	pin := `<circle data-pin="a" data-dir="up" cx="0" cy="-32" r="2"/>`
	cases := map[string]string{
		"script":        `<script>alert(1)</script>`,
		"foreignObject": `<foreignObject><div/></foreignObject>`,
		"image":         `<image href="x.png"/>`,
		"use":           `<use href="#a"/>`,
		"text":          `<text>R1</text>`,
		"anchor":        `<a href="javascript:alert(1)"><path d="M0 0"/></a>`,
		"handler":       `<path d="M0 0" onload="alert(1)"/>`,
		"style attr":    `<path d="M0 0" style="fill:url(javascript:1)"/>`,
		"transform":     `<path d="M0 0" transform="rotate(45)"/>`,
		"fill attr":     `<path d="M0 0" fill="red"/>`,
		"bad path":      `<path d="M0 0 url(x)"/>`,
		"bad class":     `<path d="M0 0" class="evil"/>`,
		"units":         `<rect x="1em" y="0" width="1" height="1"/>`,
		"pin off grid":  `<circle data-pin="b" data-dir="up" cx="3" cy="-32" r="2"/>`,
		"pin bad dir":   `<circle data-pin="b" data-dir="north" cx="0" cy="32" r="2"/>`,
		"pin on path":   `<path data-pin="b" d="M0 0"/>`,
		"pin outside":   `<circle data-pin="b" data-dir="up" cx="0" cy="-64" r="2"/>`,
		"pin twice":     `<circle data-pin="A" data-dir="down" cx="0" cy="32" r="2"/>`,
		"if-pin nested": `<g><path d="M0 0" data-if-pin="a"/></g>`,
		"if-pin absent": `<path d="M0 0" data-if-pin="zz"/>`,
	}
	for name, body := range cases {
		src := symHead + `<path d="M0 -32 V0"/>` + pin + body + `</svg>`
		if _, err := ParseSymbol("t", []byte(src)); err == nil {
			t.Errorf("%s: accepted", name)
		} else {
			t.Logf("%s: %v", name, err)
		}
	}

	whole := map[string]string{
		"doctype":    `<!DOCTYPE svg [<!ENTITY x "y">]>` + symHead + `<path d="M0 0"/></svg>`,
		"no viewBox": `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>`,
		"not svg":    `<html><path d="M0 0"/></html>`,
		"empty":      symHead + `</svg>`,
		"huge":       symHead + strings.Repeat(`<path d="M0 0"/>`, symbolMaxElements+1) + `</svg>`,
		"deep":       symHead + strings.Repeat("<g>", symbolMaxDepth+1) + `<path d="M0 0"/>` + strings.Repeat("</g>", symbolMaxDepth+1) + `</svg>`,
	}
	for name, src := range whole {
		if _, err := ParseSymbol("t", []byte(src)); err == nil {
			t.Errorf("%s: accepted", name)
		} else {
			t.Logf("%s: %v", name, err)
		}
	}

	if _, err := ParseSymbol("../etc", []byte(symHead+`<path d="M0 0"/></svg>`)); err == nil {
		t.Error("a symbol id with a path in it was accepted")
	}
}

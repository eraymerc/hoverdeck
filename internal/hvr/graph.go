package hvr

import (
	"fmt"
	"sort"
	"strings"

	"hover/compiler/ast"
)

// Arg is one argument as it literally appears in the source, with the span
// that would have to be replaced to change it.
type Arg struct {
	Text string `json:"text"`
	Span Span   `json:"span"`
}

// Pin is one physical port of a block, bound to a net.
type Pin struct {
	Index int    `json:"index"`
	Name  string `json:"name"`
	Net   string `json:"net"`
	Span  Span   `json:"span"`

	// Ref marks a pin whose bracket text is a dotted reference to another
	// element's branch (e.g. CCCS/CCVS's "sense" port naming the voltage
	// source it senses current through) rather than a net. Net still holds
	// the raw text for display, but no Net/NetPin is built for it — a dotted
	// element path only resolves in scope and has no wire geometry.
	Ref bool `json:"ref"`
}

// DefRef points at where a block's module type is declared.
type DefRef struct {
	Name   string `json:"name"`
	File   string `json:"file"`
	Span   Span   `json:"span"`
	Domain string `json:"domain"`
	Doc    string `json:"doc"`
	Found  bool   `json:"found"`
}

// Block is one instantiation on a sheet — a sub-module or a primitive.
type Block struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Kind     string `json:"kind"`     // "instance" | "primitive"
	TypeName string `json:"typeName"` // as written, e.g. "NPN.NPN"
	BareType string `json:"bareType"`
	Domain   string `json:"domain"`
	Icon     string `json:"icon"`
	Ready    bool   `json:"ready"`

	Params []Arg `json:"params"`
	Logic  []Arg `json:"logic"`
	Pins   []Pin `json:"pins"`

	// LogicPorts mirrors the declared `(...)` ports of the instantiated
	// module, positionally aligned with Logic, so the canvas can draw a
	// signal link with the correct direction.
	LogicPorts []LogicPort `json:"logicPorts"`

	Def *DefRef `json:"def"`

	Stmt       Span `json:"stmt"`
	StaticSpan Span `json:"staticSpan"`
	LogicSpan  Span `json:"logicSpan"`
	PhysSpan   Span `json:"physSpan"`
	Line       int  `json:"line"`

	Navigable bool `json:"navigable"`

	X float64 `json:"x"`
	Y float64 `json:"y"`

	// Orientation, restored from the sidecar. Presentation only.
	Rot   int  `json:"rot"`
	FlipX bool `json:"flipX"`
	FlipY bool `json:"flipY"`

	// SymPins maps each entry of Pins to a pin of the symbol named by Icon,
	// as an index into that symbol's pin list. Nil when the symbol does not
	// fit this block's ports, and the canvas draws a box instead. Set by
	// FitSymbols, after the sidecar's icon override is known.
	SymPins []int `json:"symPins"`
}

// NetPin is one endpoint of a net.
type NetPin struct {
	BlockID string `json:"blockId"`
	PinIndex int   `json:"pinIndex"`
	PinName string `json:"pinName"`
}

// Net is an electrical node: a wire name and everything attached to it.
type Net struct {
	Name       string   `json:"name"`
	IsGround   bool     `json:"isGround"`
	Declared   bool     `json:"declared"`
	DeclLine   int      `json:"declLine"`
	IsBoundary bool     `json:"isBoundary"`
	Pins       []NetPin `json:"pins"`

	// Appearance and routing, restored from the sidecar. Wires is the
	// hand-edited drawing; nil means the canvas routes the net itself.
	Color string    `json:"color,omitempty"`
	Wires []WireSeg `json:"wires"`
}

// Signal is a non-wire declaration inside the module: a logic value or,
// when IsState is set, a value that persists across timesteps.
//
// Signals are placed on the canvas like blocks are, so they carry a saved
// position too.
type Signal struct {
	Name    string  `json:"name"`
	Type    string  `json:"type"`
	IsState bool    `json:"isState"`
	Init    string  `json:"init"`
	Line    int     `json:"line"`
	Span    Span    `json:"span"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`

	// Wires is the hand-edited drawing of this signal's links to the blocks
	// that use it, or nil while they are routed automatically — the same
	// model as Net.Wires.
	Wires []WireSeg `json:"wires"`
}

// Sheet is one module rendered as a diagram.
type Sheet struct {
	Module     string      `json:"module"`
	Qualified  string      `json:"qualified"`
	Domain     string      `json:"domain"`
	File       string      `json:"file"`
	Span       Span        `json:"span"`
	BodySpan   Span        `json:"bodySpan"`
	Blocks     []Block     `json:"blocks"`
	Nets       []Net       `json:"nets"`
	Signals    []Signal    `json:"signals"`
	PhysPorts  []string    `json:"physPorts"`
	LogicPorts []LogicPort `json:"logicPorts"`
	Errors     []string    `json:"errors"`
}

// BuildSheet projects one module declaration into a diagram model.
func (p *Project) BuildSheet(qualified string) (*Sheet, error) {
	def, ok := p.Module(qualified)
	if !ok {
		return nil, fmt.Errorf("module %q not found", qualified)
	}
	f := p.Files[def.File]
	if f == nil {
		return nil, fmt.Errorf("source for module %q not loaded", qualified)
	}
	src := f.Src

	// Every slice is initialised empty rather than left nil. A nil Go slice
	// marshals to JSON `null`, not `[]`, so a module with (say) no signals
	// would hand the UI `signals: null` and break iteration over it. Emitting
	// empty collections keeps the wire format honest to the declared types.
	sh := &Sheet{
		Module:     def.Name,
		Qualified:  def.QualifiedAs,
		Domain:     def.Domain,
		File:       def.File,
		Span:       def.Span,
		PhysPorts:  emptyIfNil(def.PhysPorts),
		LogicPorts: def.LogicPorts,
		Blocks:     []Block{},
		Nets:       []Net{},
		Signals:    []Signal{},
		Errors:     []string{},
	}
	if sh.LogicPorts == nil {
		sh.LogicPorts = []LogicPort{}
	}
	if blk, ok := src.matchBraceBlock(def.Span.Start); ok {
		sh.BodySpan = blk
	}

	boundary := map[string]bool{}
	for _, pn := range def.PhysPorts {
		boundary[pn] = true
	}

	nets := map[string]*Net{}
	touch := func(name string) *Net {
		if n, ok := nets[name]; ok {
			return n
		}
		n := &Net{
			Name:       name,
			IsGround:   name == "gnd",
			IsBoundary: boundary[name],
			Pins:       []NetPin{},
		}
		nets[name] = n
		return n
	}
	for _, pn := range def.PhysPorts {
		touch(pn)
	}

	counters := map[string]int{}
	if def.decl == nil || def.decl.Body == nil {
		return sh, nil
	}

	for _, st := range def.decl.Body.Body {
		switch n := st.(type) {

		case *ast.ModuleInstStatement:
			start := src.Offset(n.Token.Line, n.Token.Column)
			g := src.scanInvocation(start)

			bare := n.ModuleName
			if i := strings.IndexByte(bare, '.'); i >= 0 {
				bare = bare[i+1:]
			}

			b := Block{
				ID:         n.InstanceName,
				Label:      n.InstanceName,
				Kind:       "instance",
				TypeName:   n.ModuleName,
				BareType:   bare,
				Ready:      true,
				Stmt:       g.Stmt,
				StaticSpan: g.Static,
				LogicSpan:  g.Logic,
				PhysSpan:   g.Phys,
				Line:       n.Token.Line,
			}

			if d, ok := p.Module(n.ModuleName); ok {
				b.Domain = d.Domain
				b.Def = &DefRef{Name: d.Name, File: d.File, Span: d.Span, Domain: d.Domain, Doc: d.Doc, Found: true}
				b.Navigable = d.Domain != DomainDigital && hasChildren(d)
				b.Pins = bindPins(src, g.PhysArgs, d.PhysPorts, -1)
				b.LogicPorts = d.LogicPorts
			} else {
				b.Domain = DomainStructural
				b.Def = &DefRef{Name: n.ModuleName, Found: false}
				sh.Errors = append(sh.Errors, fmt.Sprintf(
					"line %d: module %q is not visible here — is its import missing?", n.Token.Line, n.ModuleName))
				b.Pins = bindPins(src, g.PhysArgs, nil, -1)
			}
			// b.Def.File is empty when the definition was not found, which is
			// exactly the "path says nothing" case IconFor handles.
			b.Icon = IconFor(bare, b.Domain, b.Def.File)
			b.Params = g.StaticArgs
			b.Logic = g.LogicArgs

			for _, pin := range b.Pins {
				if pin.Net == "" {
					continue
				}
				net := touch(pin.Net)
				net.Pins = append(net.Pins, NetPin{BlockID: b.ID, PinIndex: pin.Index, PinName: pin.Name})
			}
			normaliseBlock(&b)
			sh.Blocks = append(sh.Blocks, b)

		case *ast.PhysicalPrimitiveStatement:
			start := src.Offset(n.Token.Line, n.Token.Column)
			g := src.scanInvocation(start)

			// A user-given instance name (`R rsense<1m>() [...]`) becomes the
			// block's ID directly — it's also what a CCCS/CCVS elsewhere would
			// name in its sense port, so it has to match the source exactly
			// rather than being re-numbered. Only unnamed primitives consume
			// the positional counter, matching the elaborator's own rule that
			// PrimType_<n> synthesis only applies to the unnamed form.
			id := n.Name
			if id == "" {
				counters[n.PrimType]++
				id = fmt.Sprintf("%s%d", PrimLabelPrefix(n.PrimType), counters[n.PrimType])
			}

			pd, known := Primitive(n.PrimType)
			b := Block{
				ID:         id,
				Label:      id,
				Kind:       "primitive",
				TypeName:   n.PrimType,
				BareType:   n.PrimType,
				Domain:     "primitive",
				Icon:       pd.Icon,
				Ready:      pd.Ready,
				Params:     g.StaticArgs,
				Logic:      g.LogicArgs,
				Stmt:       g.Stmt,
				StaticSpan: g.Static,
				LogicSpan:  g.Logic,
				PhysSpan:   g.Phys,
				Line:       n.Token.Line,
			}
			if !known {
				b.Icon = "analog"
				b.Ready = true
			}

			// CCCS/CCVS's last port names the element it senses current
			// through, SPICE-style — a dotted path, not a net, so it must
			// not be wired up like the rest of PhysArgs.
			refIdx := -1
			if n.IsCurrentControlled() {
				for i, pn := range pd.Ports {
					if pn == "sense" {
						refIdx = i
						break
					}
				}
			}
			b.Pins = bindPins(src, g.PhysArgs, pd.Ports, refIdx)

			for _, pin := range b.Pins {
				if pin.Net == "" || pin.Ref {
					continue
				}
				net := touch(pin.Net)
				net.Pins = append(net.Pins, NetPin{BlockID: b.ID, PinIndex: pin.Index, PinName: pin.Name})
			}
			normaliseBlock(&b)
			sh.Blocks = append(sh.Blocks, b)

		case *ast.LocalDeclStatement:
			start := src.Offset(n.Token.Line, n.Token.Column)
			end := src.findSemicolon(start)
			sp := src.span(start, end)

			for _, d := range n.Decls {
				if n.Type.IsWire() {
					net := touch(d.Name)
					net.Declared = true
					net.DeclLine = n.Token.Line
					continue
				}
				sig := Signal{
					Name:    d.Name,
					Type:    n.Type.String(),
					IsState: n.IsState,
					Line:    n.Token.Line,
					Span:    sp,
				}
				if d.Value != nil {
					sig.Init = d.Value.String()
				}
				sh.Signals = append(sh.Signals, sig)
			}
		}
	}

	for _, n := range nets {
		sh.Nets = append(sh.Nets, *n)
	}
	sort.Slice(sh.Nets, func(i, j int) bool { return sh.Nets[i].Name < sh.Nets[j].Name })
	return sh, nil
}

// normaliseBlock replaces nil slices with empty ones, so the JSON the UI
// receives always matches the declared shape (see the note in BuildSheet).
func normaliseBlock(b *Block) {
	if b.Params == nil {
		b.Params = []Arg{}
	}
	if b.Logic == nil {
		b.Logic = []Arg{}
	}
	if b.Pins == nil {
		b.Pins = []Pin{}
	}
	if b.LogicPorts == nil {
		b.LogicPorts = []LogicPort{}
	}
}

func emptyIfNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// hasChildren reports whether a module body contains anything worth drilling
// into — a sub-instance or a primitive. A leaf device model (pure equations
// plus a current_source stamp) still counts, since seeing its internals is
// exactly the point.
func hasChildren(d *ModuleDef) bool {
	if d.decl == nil || d.decl.Body == nil {
		return false
	}
	for _, st := range d.decl.Body.Body {
		switch st.(type) {
		case *ast.ModuleInstStatement, *ast.PhysicalPrimitiveStatement:
			return true
		}
	}
	return false
}

// bindPins pairs positional physical arguments with the port names declared
// by the module (or the primitive's conventional pin names). Extra arguments
// beyond the declared ports are still surfaced, positionally named, so an
// arity mismatch is visible on the canvas rather than silently dropped.
func bindPins(src *Source, args []Arg, portNames []string, refIndex int) []Pin {
	pins := make([]Pin, 0, len(args))
	for i, a := range args {
		name := fmt.Sprintf("p%d", i+1)
		if i < len(portNames) {
			name = portNames[i]
		}
		pins = append(pins, Pin{
			Index: i,
			Name:  name,
			Net:   strings.TrimSpace(a.Text),
			Span:  a.Span,
			Ref:   i == refIndex,
		})
	}
	return pins
}

// invocation is the set of spans making up a `Name<...>(...)[...];` statement.
type invocation struct {
	Stmt   Span
	Static Span
	Logic  Span
	Phys   Span

	StaticArgs []Arg
	LogicArgs  []Arg
	PhysArgs   []Arg
}

// scanInvocation recovers the exact bracket groups of an instantiation or
// primitive statement beginning at `start`.
//
// Groups are matched in whatever order they appear and any of them may be
// absent, so `R<1k>()[a,b];`, `voltage_source<>(sig)[n,gnd];` and a bare
// `Foo()[a];` all scan correctly. Only the header (`module q1 = NPN.NPN`)
// precedes the first group, and it contains no brackets, so scanning forward
// for the first delimiter is unambiguous.
func (s *Source) scanInvocation(start int) invocation {
	inv := invocation{}
	i := start

	for {
		j := s.skipTrivia(i)
		if j >= len(s.Text) {
			break
		}
		c := s.Text[j]
		switch c {
		case '<':
			outer, inner, ok := s.matchGroup(j, '<', '>')
			if !ok {
				i = j + 1
				continue
			}
			inv.Static = outer
			inv.StaticArgs = argsOf(s, inner)
			i = outer.End
		case '(':
			outer, inner, ok := s.matchGroup(j, '(', ')')
			if !ok {
				i = j + 1
				continue
			}
			inv.Logic = outer
			inv.LogicArgs = argsOf(s, inner)
			i = outer.End
		case '[':
			outer, inner, ok := s.matchGroup(j, '[', ']')
			if !ok {
				i = j + 1
				continue
			}
			inv.Phys = outer
			inv.PhysArgs = argsOf(s, inner)
			i = outer.End
		case ';':
			inv.Stmt = s.span(start, j+1)
			return inv
		default:
			// Still inside the statement header (identifiers, '=', '.').
			i = j + 1
		}
	}

	inv.Stmt = s.span(start, s.findSemicolon(start))
	return inv
}

func argsOf(s *Source, inner Span) []Arg {
	spans := s.splitArgs(inner)
	out := make([]Arg, 0, len(spans))
	for _, sp := range spans {
		t := strings.TrimSpace(s.TextOf(sp))
		if t == "" {
			continue
		}
		out = append(out, Arg{Text: t, Span: sp})
	}
	return out
}

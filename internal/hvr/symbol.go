package hvr

import (
	"embed"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"path"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
)

// Schematic symbols.
//
// A symbol is a plain SVG file whose pins are marked in the drawing itself,
// so the canvas can attach wires to the ends of the leads instead of to the
// edges of a box. The format is written down in symbols/README.md; this file
// is its only reader.
//
// Every symbol goes through ParseSymbol, including the built-in ones. That
// matters because symbols are meant to ship inside packages eventually, and a
// package is someone else's code: the SVG is parsed against a whitelist and
// RE-SERIALISED from the parsed values, so nothing a symbol file contains can
// reach the page except shapes and the handful of attributes listed below. The
// webview this renders in can call back into the Go side, so "it is only a
// picture" is not a safe assumption.

// SymbolGrid is the step every pin must sit on. Blocks are dragged on the same
// 8px grid, so a pin on it lands on it in world space too, at any rotation.
const SymbolGrid = 8

// Limits on one symbol file. Generous for any real schematic symbol, small
// enough that a hostile one cannot make the page do much work.
const (
	symbolMaxBytes    = 64 << 10
	symbolMaxElements = 400
	symbolMaxDepth    = 8
)

// SymbolPin is one connection point: where a wire attaches, and which way it
// leaves.
type SymbolPin struct {
	Name     string   `json:"name"`
	Aliases  []string `json:"aliases"`
	X        float64  `json:"x"`
	Y        float64  `json:"y"`
	Dir      string   `json:"dir"` // left | right | up | down
	Optional bool     `json:"optional"`
}

// SymbolPart is one top-level drawing element, already sanitised. IfPin, when
// set, names a pin the part is only drawn for — the supply leads of an op-amp
// whose model has no supply ports, for instance.
type SymbolPart struct {
	Markup string `json:"markup"`
	IfPin  string `json:"ifPin,omitempty"`
}

// Symbol is one parsed symbol, ready for the canvas.
type Symbol struct {
	ID      string       `json:"id"`
	Title   string       `json:"title"`
	ViewBox [4]float64   `json:"viewBox"` // minX, minY, width, height
	Parts   []SymbolPart `json:"parts"`
	Pins    []SymbolPin  `json:"pins"`
}

// IconOnly reports whether the symbol has no pins, which makes it a header
// glyph for a box rather than something wires can attach to.
func (s *Symbol) IconOnly() bool { return len(s.Pins) == 0 }

var (
	pathDataRe  = regexp.MustCompile(`^[MmZzLlHhVvCcSsQqTtAa0-9eE.,+\-\s]*$`)
	pointsRe    = regexp.MustCompile(`^[0-9eE.,+\-\s]*$`)
	pinNameRe   = regexp.MustCompile(`^[A-Za-z0-9_+\-]{1,32}$`)
	symbolIDRe  = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,47}$`)
	classTokens = map[string]bool{"fill": true, "bold": true, "dash": true}
)

// shapeAttrs lists, per drawable element, the geometry attributes it may
// carry and how each is checked. `class` and `data-if-pin` are handled for
// every element separately.
var shapeAttrs = map[string][]string{
	"g":        {},
	"path":     {"d"},
	"line":     {"x1", "y1", "x2", "y2"},
	"polyline": {"points"},
	"polygon":  {"points"},
	"rect":     {"x", "y", "width", "height", "rx", "ry"},
	"circle":   {"cx", "cy", "r"},
	"ellipse":  {"cx", "cy", "rx", "ry"},
}

// Elements that never draw anything. Editors write them (Inkscape's
// namedview, a <title>, a preview <style>), so they are skipped with their
// whole subtree rather than rejected. None of them is ever emitted.
var skippedElements = map[string]bool{
	"title": true, "desc": true, "metadata": true, "style": true, "defs": true,
}

// Root attributes that only matter when the file is opened on its own — a
// stroke so it is visible in a viewer, a size. Accepted and ignored: the
// canvas styles symbols itself.
var ignoredRootAttrs = map[string]bool{
	"xmlns": true, "version": true, "width": true, "height": true,
	"fill": true, "stroke": true, "stroke-width": true,
	"stroke-linecap": true, "stroke-linejoin": true,
}

const svgNS = "http://www.w3.org/2000/svg"

// ParseSymbol reads one symbol file. id is the symbol's name — the file name
// without .svg.
func ParseSymbol(id string, src []byte) (*Symbol, error) {
	if !symbolIDRe.MatchString(id) {
		return nil, fmt.Errorf("symbol name %q: use lower-case letters, digits, - and _", id)
	}
	if len(src) > symbolMaxBytes {
		return nil, fmt.Errorf("%s: %d bytes is over the %d-byte limit for a symbol", id, len(src), symbolMaxBytes)
	}
	p := &symbolParser{sym: &Symbol{ID: id, Title: id, Parts: []SymbolPart{}, Pins: []SymbolPin{}}}
	if err := p.parse(src); err != nil {
		return nil, fmt.Errorf("%s: %w", id, err)
	}
	if err := p.validate(); err != nil {
		return nil, fmt.Errorf("%s: %w", id, err)
	}
	return p.sym, nil
}

type symbolParser struct {
	dec      *xml.Decoder
	sym      *Symbol
	elements int
}

func (p *symbolParser) parse(src []byte) error {
	p.dec = xml.NewDecoder(strings.NewReader(string(src)))
	// A DOCTYPE could declare entities; the decoder does not expand external
	// ones, and Strict mode rejects undeclared ones, which is what we want.
	p.dec.Strict = true

	sawRoot := false
	for {
		tok, err := p.dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("not well-formed XML: %w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if sawRoot {
				return errors.New("more than one root element")
			}
			sawRoot = true
			if t.Name.Local != "svg" || (t.Name.Space != "" && t.Name.Space != svgNS) {
				return fmt.Errorf("root element is <%s>, expected <svg>", t.Name.Local)
			}
			if err := p.root(t); err != nil {
				return err
			}
		case xml.Directive:
			return errors.New("<!DOCTYPE> and other directives are not allowed")
		case xml.ProcInst, xml.Comment, xml.CharData:
			// The <?xml?> declaration, comments, whitespace.
		}
	}
	if !sawRoot {
		return errors.New("no <svg> element")
	}
	return nil
}

func (p *symbolParser) root(t xml.StartElement) error {
	haveViewBox := false
	for _, a := range t.Attr {
		if a.Name.Space != "" {
			continue // xmlns:inkscape, sodipodi:docname, …
		}
		switch name := a.Name.Local; {
		case name == "viewBox":
			vb, err := parseNumbers(a.Value, 4)
			if err != nil {
				return fmt.Errorf("viewBox: %w", err)
			}
			if vb[2] <= 0 || vb[3] <= 0 {
				return errors.New("viewBox width and height must be positive")
			}
			copy(p.sym.ViewBox[:], vb)
			haveViewBox = true
		case name == "data-title":
			p.sym.Title = strings.TrimSpace(a.Value)
		case name == "id", ignoredRootAttrs[name]:
		default:
			return fmt.Errorf("attribute %q is not allowed on <svg>", name)
		}
	}
	if !haveViewBox {
		return errors.New("<svg> needs a viewBox — it is the symbol's coordinate system")
	}

	for {
		tok, err := p.dec.Token()
		if err != nil {
			return fmt.Errorf("not well-formed XML: %w", err)
		}
		switch c := tok.(type) {
		case xml.StartElement:
			markup, ifPin, err := p.element(c, 1)
			if err != nil {
				return err
			}
			if markup != "" {
				p.sym.Parts = append(p.sym.Parts, SymbolPart{Markup: markup, IfPin: ifPin})
			}
		case xml.EndElement:
			return nil
		}
	}
}

// element sanitises one element and its children and returns the markup to
// emit — empty for a pin marker or a skipped element — plus its data-if-pin.
func (p *symbolParser) element(t xml.StartElement, depth int) (string, string, error) {
	if depth > symbolMaxDepth {
		return "", "", fmt.Errorf("elements nested more than %d deep", symbolMaxDepth)
	}
	p.elements++
	if p.elements > symbolMaxElements {
		return "", "", fmt.Errorf("more than %d elements", symbolMaxElements)
	}

	name := t.Name.Local
	if t.Name.Space != "" && t.Name.Space != svgNS {
		// Editor metadata in its own namespace (sodipodi:namedview).
		return "", "", p.dec.Skip()
	}
	if skippedElements[name] {
		return "", "", p.dec.Skip()
	}
	allowed, ok := shapeAttrs[name]
	if !ok {
		return "", "", fmt.Errorf("<%s> is not allowed in a symbol — only g, path, line, polyline, polygon, rect, circle and ellipse", name)
	}

	if pin, isPin, err := pinMarker(t); err != nil {
		return "", "", err
	} else if isPin {
		p.sym.Pins = append(p.sym.Pins, pin)
		return "", "", p.dec.Skip()
	}

	var b strings.Builder
	b.WriteString("<")
	b.WriteString(name)
	ifPin := ""
	for _, a := range t.Attr {
		an := a.Name.Local
		if a.Name.Space != "" || an == "id" {
			continue // inkscape:label, xml:space, ids
		}
		switch {
		case an == "class":
			cls, err := classList(a.Value)
			if err != nil {
				return "", "", fmt.Errorf("<%s>: %w", name, err)
			}
			if cls != "" {
				fmt.Fprintf(&b, ` class="%s"`, cls)
			}
		case an == "data-if-pin":
			if depth != 1 {
				return "", "", fmt.Errorf("<%s>: data-if-pin only works on a top-level element", name)
			}
			ifPin = strings.TrimSpace(a.Value)
		case slices.Contains(allowed, an):
			v, err := geometryValue(an, a.Value)
			if err != nil {
				return "", "", fmt.Errorf("<%s %s>: %w", name, an, err)
			}
			fmt.Fprintf(&b, ` %s="%s"`, an, v)
		default:
			return "", "", fmt.Errorf("attribute %q is not allowed on <%s> — symbols are styled by class (fill, bold, dash), and transforms are not supported", an, name)
		}
	}

	// Children, for <g>. A shape with children is accepted (some editors
	// nest a <title>) but only a group emits them.
	var kids strings.Builder
	for {
		tok, err := p.dec.Token()
		if err != nil {
			return "", "", fmt.Errorf("not well-formed XML: %w", err)
		}
		if c, ok := tok.(xml.StartElement); ok {
			m, _, err := p.element(c, depth+1)
			if err != nil {
				return "", "", err
			}
			if name == "g" {
				kids.WriteString(m)
			}
			continue
		}
		if _, ok := tok.(xml.EndElement); ok {
			break
		}
	}
	if name == "g" {
		if kids.Len() == 0 {
			return "", "", nil
		}
		b.WriteString(">")
		b.WriteString(kids.String())
		b.WriteString("</g>")
	} else {
		b.WriteString("/>")
	}
	return b.String(), ifPin, nil
}

// pinMarker reads a <circle data-pin=…>. Only circles can be pin markers, so
// the marker is visible as a dot when the file is opened in an editor.
func pinMarker(t xml.StartElement) (SymbolPin, bool, error) {
	var pin SymbolPin
	var hasPin, hasX, hasY bool
	for _, a := range t.Attr {
		if a.Name.Space != "" {
			continue
		}
		switch a.Name.Local {
		case "data-pin":
			hasPin = true
			pin.Name = strings.TrimSpace(a.Value)
		case "data-dir":
			pin.Dir = strings.TrimSpace(a.Value)
		case "data-alias":
			pin.Aliases = strings.Fields(a.Value)
		case "data-optional":
			pin.Optional = a.Value != "false"
		case "cx":
			v, err := parseNumber(a.Value)
			if err != nil {
				return pin, true, fmt.Errorf("pin cx: %w", err)
			}
			pin.X, hasX = v, true
		case "cy":
			v, err := parseNumber(a.Value)
			if err != nil {
				return pin, true, fmt.Errorf("pin cy: %w", err)
			}
			pin.Y, hasY = v, true
		}
	}
	if !hasPin {
		return pin, false, nil
	}
	if t.Name.Local != "circle" {
		return pin, true, fmt.Errorf("data-pin %q is on a <%s>; pin markers must be circles", pin.Name, t.Name.Local)
	}
	if !pinNameRe.MatchString(pin.Name) {
		return pin, true, fmt.Errorf("pin name %q: use letters, digits, _, + and -", pin.Name)
	}
	if !hasX || !hasY {
		return pin, true, fmt.Errorf("pin %q needs cx and cy", pin.Name)
	}
	switch pin.Dir {
	case "left", "right", "up", "down":
	default:
		return pin, true, fmt.Errorf("pin %q: data-dir must be left, right, up or down (the way the wire leaves), not %q", pin.Name, pin.Dir)
	}
	for _, al := range pin.Aliases {
		if !pinNameRe.MatchString(al) {
			return pin, true, fmt.Errorf("pin %q: alias %q: use letters, digits, _, + and -", pin.Name, al)
		}
	}
	if pin.Aliases == nil {
		pin.Aliases = []string{}
	}
	return pin, true, nil
}

func (p *symbolParser) validate() error {
	s := p.sym
	seen := map[string]bool{}
	for _, pin := range s.Pins {
		key := strings.ToLower(pin.Name)
		if seen[key] {
			return fmt.Errorf("pin %q is declared twice", pin.Name)
		}
		seen[key] = true
		if math.Mod(pin.X, SymbolGrid) != 0 || math.Mod(pin.Y, SymbolGrid) != 0 {
			return fmt.Errorf("pin %q at (%g, %g) is off the %dpx grid — wires would never line up with it",
				pin.Name, pin.X, pin.Y, SymbolGrid)
		}
		vb := s.ViewBox
		if pin.X < vb[0] || pin.X > vb[0]+vb[2] || pin.Y < vb[1] || pin.Y > vb[1]+vb[3] {
			return fmt.Errorf("pin %q at (%g, %g) is outside the viewBox", pin.Name, pin.X, pin.Y)
		}
	}
	for _, part := range s.Parts {
		if part.IfPin != "" && !seen[strings.ToLower(part.IfPin)] {
			return fmt.Errorf("data-if-pin %q names no pin of this symbol", part.IfPin)
		}
	}
	if len(s.Parts) == 0 {
		return errors.New("draws nothing")
	}
	return nil
}

func classList(v string) (string, error) {
	var out []string
	for c := range strings.FieldsSeq(v) {
		if !classTokens[c] {
			return "", fmt.Errorf("class %q is not one of fill, bold, dash", c)
		}
		out = append(out, c)
	}
	return strings.Join(out, " "), nil
}

// geometryValue checks one geometry attribute and returns it normalised. The
// returned text contains only digits, signs, separators and path commands, so
// it needs no escaping.
func geometryValue(attr, v string) (string, error) {
	switch attr {
	case "d":
		if !pathDataRe.MatchString(v) {
			return "", errors.New("path data may only hold commands and numbers")
		}
		return strings.Join(strings.Fields(v), " "), nil
	case "points":
		if !pointsRe.MatchString(v) {
			return "", errors.New("points may only hold numbers")
		}
		return strings.Join(strings.Fields(v), " "), nil
	default:
		n, err := parseNumber(v)
		if err != nil {
			return "", err
		}
		return strconv.FormatFloat(n, 'f', -1, 64), nil
	}
}

func parseNumber(v string) (float64, error) {
	n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return 0, fmt.Errorf("%q is not a plain number (units are not supported)", v)
	}
	return n, nil
}

func parseNumbers(v string, n int) ([]float64, error) {
	fs := strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' || r == '\n' })
	if len(fs) != n {
		return nil, fmt.Errorf("expected %d numbers, got %q", n, v)
	}
	out := make([]float64, n)
	for i, f := range fs {
		x, err := parseNumber(f)
		if err != nil {
			return nil, err
		}
		out[i] = x
	}
	return out, nil
}

// ── Fitting a symbol to a block ─────────────────────────────────────────────

// FitSymbol decides which symbol pin each of a block's ports attaches to.
// It returns, for every block pin in order, an index into sym.Pins — or nil
// when the symbol cannot draw this block, in which case the canvas falls back
// to a box with the symbol as its header icon.
//
// A symbol fits only when the mapping is complete in both directions: every
// port finds a pin, and every pin that is not optional is used. A partial fit
// would silently drop a connection from the drawing, which is worse than a
// box.
//
// Names are matched in three passes, each only over what the earlier ones left
// unclaimed: the pin's own name, then a port ending in "_<name>" (the LED
// colours call their ports led_anode/led_cathode), then the pin's aliases.
// Case is ignored throughout.
func FitSymbol(sym *Symbol, pins []Pin) []int {
	if sym == nil || sym.IconOnly() || len(pins) == 0 || len(pins) > len(sym.Pins) {
		return nil
	}
	fit := make([]int, len(pins))
	for i := range fit {
		fit[i] = -1
	}
	used := make([]bool, len(sym.Pins))

	passes := []func(port string, sp SymbolPin) bool{
		func(port string, sp SymbolPin) bool { return port == strings.ToLower(sp.Name) },
		func(port string, sp SymbolPin) bool { return strings.HasSuffix(port, "_"+strings.ToLower(sp.Name)) },
		func(port string, sp SymbolPin) bool {
			for _, al := range sp.Aliases {
				if port == strings.ToLower(al) {
					return true
				}
			}
			return false
		},
	}
	for _, match := range passes {
		for i, bp := range pins {
			if fit[i] >= 0 {
				continue
			}
			port := strings.ToLower(bp.Name)
			for j, sp := range sym.Pins {
				if !used[j] && match(port, sp) {
					fit[i], used[j] = j, true
					break
				}
			}
		}
	}

	for _, j := range fit {
		if j < 0 {
			return nil
		}
	}
	for j, sp := range sym.Pins {
		if !used[j] && !sp.Optional {
			return nil
		}
	}
	return fit
}

// FitSymbols resolves every block on a sheet against its final icon — so it
// runs after the sidecar's icon overrides have been applied.
func FitSymbols(sh *Sheet, lib *SymbolLib) {
	for i := range sh.Blocks {
		b := &sh.Blocks[i]
		b.SymPins = FitSymbol(lib.Get(b.Icon), b.Pins)
	}
}

// ── Library ─────────────────────────────────────────────────────────────────

// SymbolLib is a set of symbols by name.
type SymbolLib struct {
	byID map[string]*Symbol
	// Errors holds one message per symbol file that failed to load. Those
	// symbols are simply absent; blocks that wanted them draw as boxes.
	Errors []string
}

// Get returns the named symbol, or nil.
func (l *SymbolLib) Get(id string) *Symbol {
	if l == nil {
		return nil
	}
	return l.byID[id]
}

// All returns every symbol, ordered by name.
func (l *SymbolLib) All() []*Symbol {
	out := make([]*Symbol, 0, len(l.byID))
	for _, s := range l.byID {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

//go:embed symbols/*.svg
var builtinSymbolFS embed.FS

var builtinSymbols *SymbolLib

// BuiltinSymbols returns the symbols compiled into hoverdeck: the primitives
// and the standard-library devices. Parsed once.
func BuiltinSymbols() *SymbolLib {
	if builtinSymbols == nil {
		builtinSymbols = loadSymbolFS(builtinSymbolFS, "symbols")
	}
	return builtinSymbols
}

func loadSymbolFS(fsys embed.FS, dir string) *SymbolLib {
	lib := &SymbolLib{byID: map[string]*Symbol{}}
	entries, err := fsys.ReadDir(dir)
	if err != nil {
		lib.Errors = append(lib.Errors, err.Error())
		return lib
	}
	for _, e := range entries {
		if e.IsDir() || path.Ext(e.Name()) != ".svg" {
			continue
		}
		src, err := fsys.ReadFile(path.Join(dir, e.Name()))
		if err != nil {
			lib.Errors = append(lib.Errors, err.Error())
			continue
		}
		sym, err := ParseSymbol(strings.TrimSuffix(e.Name(), ".svg"), src)
		if err != nil {
			lib.Errors = append(lib.Errors, err.Error())
			continue
		}
		lib.byID[sym.ID] = sym
	}
	return lib
}

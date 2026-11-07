package hvr

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"hover/compiler/loader"
)

// PrimitiveDef describes one built-in physical primitive: what its static
// parameter means and what its physical ports are called, so the canvas can
// label pins instead of showing bare positional indices.
type PrimitiveDef struct {
	Name      string   `json:"name"`
	Icon      string   `json:"icon"`
	Ports     []string `json:"ports"`
	Param     string   `json:"param"`
	Unit      string   `json:"unit"`
	Desc      string   `json:"desc"`
	Driveable bool     `json:"driveable"` // accepts a logic signal in ()
	Ready     bool     `json:"ready"`
}

// primitives mirrors the Physical Primitives table in the language manual.
var primitives = map[string]PrimitiveDef{
	"R":              {Name: "R", Icon: "resistor", Ports: []string{"n+", "n-"}, Param: "resistance", Unit: "Ω", Desc: "Resistor", Ready: true},
	"L":              {Name: "L", Icon: "inductor", Ports: []string{"n+", "n-"}, Param: "inductance", Unit: "H", Desc: "Inductor", Ready: true},
	"C":              {Name: "C", Icon: "capacitor", Ports: []string{"n+", "n-"}, Param: "capacitance", Unit: "F", Desc: "Capacitor", Ready: true},
	"voltage_source": {Name: "voltage_source", Icon: "vsource", Ports: []string{"n+", "n-"}, Param: "dc_value", Unit: "V", Desc: "Ideal voltage source", Driveable: true, Ready: true},
	"current_source": {Name: "current_source", Icon: "isource", Ports: []string{"n+", "n-"}, Param: "dc_value", Unit: "A", Desc: "Ideal current source", Driveable: true, Ready: true},
	"VCCS":           {Name: "VCCS", Icon: "vccs", Ports: []string{"n+", "n-", "nc+", "nc-"}, Param: "gm", Unit: "S", Desc: "Voltage-controlled current source", Ready: true},
	"VCVS":           {Name: "VCVS", Icon: "vcvs", Ports: []string{"n+", "n-", "nc+", "nc-"}, Param: "k", Unit: "", Desc: "Voltage-controlled voltage source", Ready: true},
	"CCCS":           {Name: "CCCS", Icon: "cccs", Ports: []string{"n+", "n-", "sense"}, Param: "beta", Unit: "", Desc: "Current-controlled current source", Ready: true},
	"CCVS":           {Name: "CCVS", Icon: "ccvs", Ports: []string{"n+", "n-", "sense"}, Param: "r", Unit: "Ω", Desc: "Current-controlled voltage source", Ready: true},
}

// IsPrimitive reports whether name is a built-in physical primitive.
// Mirrors compiler/parser.isPhysicalPrimitive.
func IsPrimitive(name string) bool {
	_, ok := primitives[name]
	return ok
}

// Primitive returns the definition for a built-in primitive.
func Primitive(name string) (PrimitiveDef, bool) {
	d, ok := primitives[name]
	return d, ok
}

// Primitives returns every built-in primitive, ordered for the palette.
func Primitives() []PrimitiveDef {
	order := []string{"R", "L", "C", "voltage_source", "current_source", "VCVS", "VCCS", "CCVS", "CCCS"}
	out := make([]PrimitiveDef, 0, len(order))
	for _, n := range order {
		out = append(out, primitives[n])
	}
	return out
}

// moduleIcons maps well-known standard-library module names to their
// conventional schematic symbol. Anything unrecognised falls back to a
// domain-shaped generic block, so user modules still render sensibly.
var moduleIcons = map[string]string{
	"NPN":   "npn",
	"PNP":   "pnp",
	"NMOS":  "nmos",
	"NMOS4": "nmos4",
	"PMOS":  "pmos",
	"PMOS4": "pmos4",
	"Diode": "diode",
	"LED":   "led",
	"OpAmp": "opamp",
	"PMSM":  "motor",
}

// stdlibFamilyIcons maps a standard-library DIRECTORY to the symbol every
// module declared inside it should wear.
//
// The part cards under `parts/` are named after the real device — Q2N2222,
// D1N4007, MIRF9540N — and nothing in those names says which symbol to draw:
// Q2N2222 is an NPN and Q2N2907 a PNP, and only the directory they sit in
// tells them apart. So the family is read from the path, which is the same
// thing the library itself uses to organise them.
//
// Longest-first: `parts/mosfet/nmos` has to win over any shorter prefix that
// might later be added above it.
var stdlibFamilyIcons = []struct{ dir, icon string }{
	{"parts/bjt/npn", "npn"},
	{"parts/bjt/pnp", "pnp"},
	{"parts/mosfet/nmos", "nmos"},
	{"parts/mosfet/pmos", "pmos"},
	{"optoelectronics/leds", "led"},
	{"parts/diode", "diode"},
	{"electromechanical", "motor"},
	{"analog/opamp", "opamp"},
}

// familyIcon returns the symbol implied by the directory a definition was
// declared in, or "" when the path says nothing.
func familyIcon(file string) string {
	if file == "" {
		return ""
	}
	dir := filepath.ToSlash(filepath.Dir(file))
	for _, f := range stdlibFamilyIcons {
		if dir == f.dir || strings.HasSuffix(dir, "/"+f.dir) {
			return f.icon
		}
	}
	return ""
}

// IconFor picks the symbol for a module instance. bare is the unqualified
// module name; domain is its declared domain; file is the path of the file
// that declares it, which may be empty when the definition was not found.
func IconFor(bare, domain, file string) string {
	if ic, ok := moduleIcons[bare]; ok {
		return ic
	}
	// A part card wears its family's symbol. The device models themselves are
	// named above; their part cards are not, and cannot be — nothing in
	// "Q2N2222" or "MIRF9540N" says which symbol it wants.
	if ic := familyIcon(file); ic != "" {
		return ic
	}
	switch {
	case strings.Contains(strings.ToLower(bare), "opamp"):
		return "opamp"
	case strings.Contains(strings.ToLower(bare), "source"):
		return "vsource"
	case strings.Contains(strings.ToLower(bare), "filter"):
		return "filter"
	case strings.Contains(strings.ToLower(bare), "motor"):
		return "motor"
	}
	switch domain {
	case DomainAnalog:
		return "analog"
	case DomainDigital:
		return "digital"
	default:
		return "structural"
	}
}

// CatalogEntry is one palette item: a module the user can drop onto a sheet.
type CatalogEntry struct {
	Kind   string `json:"kind"` // "primitive" | "module"
	Name   string `json:"name"`
	Icon   string `json:"icon"`
	Domain string `json:"domain"`
	Desc   string `json:"desc"`
	Group  string `json:"group"`

	// ImportPath is the DIRECTORY to import, as written inside the angle
	// brackets — "semiconductors", "math", "stdlib/semiconductors/bjt". Empty
	// when nothing needs importing.
	ImportPath string `json:"importPath"`

	// Qualifier is the name that import binds, and therefore the prefix an
	// instantiation writes: `semiconductors.Diode<...>`. Whole-directory
	// imports are always qualified in 0.8, so this is never empty when
	// ImportPath is set.
	Qualifier string `json:"qualifier"`

	// SuggestAlias pre-fills the `as` box. Empty means "the default binding
	// is fine", which it is for every well-named directory.
	SuggestAlias string `json:"suggestAlias"`

	Package      string        `json:"package"`
	PhysPorts    []string      `json:"physPorts"`
	StaticParams []StaticParam `json:"staticParams"`
	LogicPorts   []LogicPort   `json:"logicPorts"`
	File         string        `json:"file"`
	Snippet      string        `json:"snippet"`
}

// ScanPackages returns a palette entry for every module declared by every
// installed package, pre-populated with the import path, the qualifier that
// import binds, and default arguments — so dropping one produces a line that
// compiles as written.
//
// Grouped by DIRECTORY rather than by file, because a directory is the import
// unit: `import <semiconductors>` brings in everything the palette shows under
// "semiconductors", regardless of which file inside it declared what.
func ScanPackages(pkgs *Packages) []CatalogEntry {
	var out []CatalogEntry
	if pkgs == nil {
		return out
	}

	// One directory can be reachable through more than one root — the stdlib
	// tree binds both `stdlib` and `math`, and `<math>` is the spelling to
	// offer. Scanning by directory and asking which package owns it (longest
	// root wins) picks the more specific name and visits nothing twice.
	seen := map[string]bool{}
	for _, root := range pkgs.Roots {
		_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil || !d.IsDir() || strings.HasPrefix(d.Name(), ".") {
				return nil
			}
			dir := filepath.Clean(path)
			if seen[dir] {
				return nil
			}
			seen[dir] = true
			out = append(out, scanDir(pkgs, dir)...)
			return nil
		})
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].Group != out[j].Group {
			return out[i].Group < out[j].Group
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// scanDir builds the palette entries for the .hvr files directly inside one
// package directory.
func scanDir(pkgs *Packages, dir string) []CatalogEntry {
	files, err := loader.HvrFilesIn(dir)
	if err != nil || len(files) == 0 {
		return nil
	}

	pkg := pkgs.PackageOf(dir)
	if pkg == "" {
		return nil
	}
	importPath := pkg
	if rel, relErr := filepath.Rel(pkgs.Roots[pkg], dir); relErr == nil && rel != "." {
		importPath = pkg + "/" + filepath.ToSlash(rel)
	}
	qualifier := loader.QualifierFor(importPath, "")

	// A directory whose default binding is not a legal identifier needs an
	// explicit `as`, so the palette offers one rather than letting the
	// inserted line fail to lex at its first use.
	suggest := ""
	if !isIdent(qualifier) {
		suggest = sanitizeIdent(qualifier)
	}

	var out []CatalogEntry
	for _, path := range files {
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			continue
		}
		f := ParseSource(path, string(raw))
		if f.Program == nil {
			continue
		}
		proj := &Project{Files: map[string]*File{path: f}, modules: map[string]*ModuleDef{}}
		for _, def := range proj.modulesIn(f) {
			out = append(out, CatalogEntry{
				Kind:         "module",
				Name:         def.Name,
				Icon:         IconFor(def.Name, def.Domain, path),
				Domain:       def.Domain,
				Desc:         def.Doc,
				Group:        importPath,
				ImportPath:   importPath,
				Qualifier:    qualifier,
				SuggestAlias: suggest,
				Package:      pkg,
				PhysPorts:    def.PhysPorts,
				StaticParams: def.StaticParams,
				LogicPorts:   def.LogicPorts,
				File:         path,
			})
		}
	}
	return out
}

func isIdent(s string) bool { return identRe.MatchString(s) }

// sanitizeIdent turns a directory name that cannot be an identifier into one
// that can, as a starting suggestion the user can overwrite.
func sanitizeIdent(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c == '_':
			b.WriteByte(c)
		case c >= '0' && c <= '9' && b.Len() > 0:
			b.WriteByte(c)
		}
	}
	if b.Len() == 0 {
		return "lib"
	}
	return b.String()
}

// primLabelPrefix maps a primitive to its conventional SPICE reference-designator
// letter, so blocks read as R1/C2/V1 the way they would on a schematic.
var primLabelPrefix = map[string]string{
	"R": "R", "L": "L", "C": "C",
	"voltage_source": "V", "current_source": "I",
	"VCVS": "E", "VCCS": "G", "CCVS": "H", "CCCS": "F",
}

// PrimLabelPrefix returns the designator letter for a primitive type.
func PrimLabelPrefix(prim string) string {
	if p, ok := primLabelPrefix[prim]; ok {
		return p
	}
	return prim
}

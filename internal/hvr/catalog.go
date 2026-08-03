package hvr

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
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
	"Diode": "diode",
	"LED":   "led",
	"PMSM":  "motor",
}

// IconFor picks the symbol for a module instance. bare is the unqualified
// module name; domain is its declared domain.
func IconFor(bare, domain string) string {
	if ic, ok := moduleIcons[bare]; ok {
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
	Kind         string        `json:"kind"` // "primitive" | "module"
	Name         string        `json:"name"`
	Icon         string        `json:"icon"`
	Domain       string        `json:"domain"`
	Desc         string        `json:"desc"`
	Group        string        `json:"group"`
	ImportPath   string        `json:"importPath"` // for `import <...>`, "" if none needed
	SuggestAlias string        `json:"suggestAlias"`
	PhysPorts    []string      `json:"physPorts"`
	StaticParams []StaticParam `json:"staticParams"`
	LogicPorts   []LogicPort   `json:"logicPorts"`
	File         string        `json:"file"`
	Snippet      string        `json:"snippet"`
}

// ScanStdlib walks the standard library and returns a palette entry for every
// module it declares, pre-populated with its import path and default
// arguments so dropping one produces a line that compiles as-is.
func ScanStdlib(root string) []CatalogEntry {
	var out []CatalogEntry
	if root == "" {
		return out
	}
	if st, err := os.Stat(root); err != nil || !st.IsDir() {
		return out
	}

	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".hvr") {
			return nil
		}
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		f := ParseSource(path, string(raw))
		if f.Program == nil {
			return nil
		}

		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			rel = filepath.Base(path)
		}
		importPath := filepath.ToSlash(rel)
		group := filepath.ToSlash(filepath.Dir(rel))
		if group == "." {
			group = "standard library"
		}

		proj := &Project{Files: map[string]*File{path: f}, modules: map[string]*ModuleDef{}}
		for _, def := range proj.modulesIn(f) {
			e := CatalogEntry{
				Kind:         "module",
				Name:         def.Name,
				Icon:         IconFor(def.Name, def.Domain),
				Domain:       def.Domain,
				Desc:         def.Doc,
				Group:        group,
				ImportPath:   importPath,
				SuggestAlias: def.Name,
				PhysPorts:    def.PhysPorts,
				StaticParams: def.StaticParams,
				LogicPorts:   def.LogicPorts,
				File:         path,
			}
			out = append(out, e)
		}
		return nil
	})

	sort.Slice(out, func(i, j int) bool {
		if out[i].Group != out[j].Group {
			return out[i].Group < out[j].Group
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// FindStdlib locates a standard_library directory, trying the explicit hint
// first, then locations relative to the running binary and the working
// directory. Returns "" when none is found; `import <...>` then simply fails
// to resolve and the UI reports it rather than silently showing an empty tree.
func FindStdlib(hint string) string {
	var cands []string
	if hint != "" {
		// The nested path is tried first: a hint pointing at a hover checkout
		// should find <checkout>/standard_library, not the checkout itself.
		cands = append(cands, filepath.Join(hint, "standard_library"), hint)
	}
	if exe, err := os.Executable(); err == nil {
		if real, e := filepath.EvalSymlinks(exe); e == nil {
			exe = real
		}
		dir := filepath.Dir(exe)
		cands = append(cands,
			filepath.Join(dir, "standard_library"),
			filepath.Join(dir, "..", "hover-lang", "standard_library"),
		)
	}
	if wd, err := os.Getwd(); err == nil {
		cands = append(cands,
			filepath.Join(wd, "standard_library"),
			filepath.Join(wd, "..", "hover-lang", "standard_library"),
		)
	}
	for _, c := range cands {
		c = filepath.Clean(c)
		if st, err := os.Stat(c); err == nil && st.IsDir() && containsHVR(c) {
			return c
		}
	}
	return ""
}

// containsHVR reports whether dir holds at least one .hvr file at any depth,
// so a directory that merely exists is not mistaken for a standard library.
func containsHVR(dir string) bool {
	found := false
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() && strings.HasSuffix(strings.ToLower(d.Name()), ".hvr") {
			found = true
			return filepath.SkipAll
		}
		return nil
	})
	return found
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

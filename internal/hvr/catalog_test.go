package hvr

import (
	"os"
	"path/filepath"
	"testing"
)

// testSymbolLib is the symbol set hoverdeck builds for a project whose
// standard library is testdata/stdlib — a copy of the real stdlib's symbols/
// folders, laid out the same way.
func testSymbolLib(t *testing.T) (*SymbolLib, string) {
	t.Helper()
	root, err := filepath.Abs("testdata/stdlib")
	if err != nil {
		t.Fatal(err)
	}
	lib := NewSymbolLib(&Packages{Roots: bundledRoots(root)}, "")
	for _, e := range lib.Errors {
		t.Error(e)
	}
	return lib, root
}

// A library module wears the symbol its own directory ships: by name, or the
// folder's default — which is how part cards, named after real devices, get
// their family's symbol (Q2N2222 is an NPN and Q2N2907 a PNP, and their names
// say nothing about which).
func TestSymbolForComesFromTheLibrary(t *testing.T) {
	lib, std := testSymbolLib(t)
	in := func(rel string) string { return filepath.Join(std, rel) }
	cases := []struct {
		name, domain, file, want string
	}{
		{"NMOS", DomainAnalog, in("semiconductors/mosfet/nmos.hvr"), "semiconductors/mosfet/nmos"},
		// The four-terminal core brings the bulk out, so it needs the symbol
		// with a fourth pin rather than the one that ties bulk to source.
		{"NMOS4", DomainAnalog, in("semiconductors/mosfet/nmos.hvr"), "semiconductors/mosfet/nmos4"},
		{"PMOS", DomainAnalog, in("semiconductors/mosfet/pmos.hvr"), "semiconductors/mosfet/pmos"},
		{"NPN", DomainAnalog, in("semiconductors/bjt/npn.hvr"), "semiconductors/bjt/npn"},
		{"Diode", DomainAnalog, in("semiconductors/diode.hvr"), "semiconductors/diode"},
		{"M2N7000", DomainAnalog, in("parts/mosfet/nmos/2N7000.hvr"), "parts/mosfet/nmos/default"},
		{"MIRF9540N", DomainAnalog, in("parts/mosfet/pmos/IRF9540N.hvr"), "parts/mosfet/pmos/default"},
		{"Q2N2222", DomainAnalog, in("parts/bjt/npn/2N2222.hvr"), "parts/bjt/npn/default"},
		{"Q2N2907", DomainAnalog, in("parts/bjt/pnp/2N2907.hvr"), "parts/bjt/pnp/default"},
		{"D1N4007", DomainAnalog, in("parts/diode/1N4007.hvr"), "parts/diode/default"},
		{"LED", DomainAnalog, in("optoelectronics/leds/led.hvr"), "optoelectronics/leds/default"},
		{"LED_RED", DomainAnalog, in("optoelectronics/leds/led_colors.hvr"), "optoelectronics/leds/default"},
		{"OpAmp", DomainAnalog, in("analog/opamp/opamp.hvr"), "analog/opamp/default"},
		{"PMSM", DomainAnalog, in("electromechanical/pmsm.hvr"), "electromechanical/default"},
		{"Phototransistor", DomainAnalog, in("optoelectronics/phototransistor/phototransistor.hvr"), "optoelectronics/phototransistor/default"},
		{"UPC817", DomainAnalog, in("parts/optocoupler/PC817.hvr"), "parts/optocoupler/default"},

		// A directory that ships no symbols falls back to the generic shapes.
		{"Widget", DomainAnalog, "/home/me/proj/widget.hvr", "analog"},
		{"Widget", DomainDigital, "/home/me/proj/widget.hvr", "digital"},
		{"DCMotor", DomainStructural, "/home/me/proj/motor.hvr", "motor"},

		// A definition that was never found carries no path at all.
		{"Q2N2222", DomainStructural, "", "structural"},
	}
	for _, c := range cases {
		if got := lib.For(c.name, c.domain, c.file); got != c.want {
			t.Errorf("For(%q, %q, %q) = %q, want %q", c.name, c.domain, c.file, got, c.want)
		}
		if lib.Get(lib.For(c.name, c.domain, c.file)) == nil {
			t.Errorf("For(%q) names a symbol the library does not have", c.name)
		}
	}

	// Without a library the fallback still answers.
	var none *SymbolLib
	if got := none.For("NPN", DomainAnalog, in("semiconductors/bjt/npn.hvr")); got != "analog" {
		t.Errorf("nil lib: got %q, want analog", got)
	}
}

// Symbols beside the project's own sources load on demand, with ids relative
// to the project root.
func TestSymbolForLoadsProjectFolders(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "blocks")
	if err := mkdirWrite(filepath.Join(dir, "symbols", "widget.svg"),
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-16 -16 32 32"><path d="M-16 0 H16"/>`+
			`<circle data-pin="a" data-dir="left" cx="-16" cy="0" r="2"/>`+
			`<circle data-pin="b" data-dir="right" cx="16" cy="0" r="2"/></svg>`); err != nil {
		t.Fatal(err)
	}
	lib := NewSymbolLib(&Packages{Roots: map[string]string{}}, root)
	got := lib.For("Widget", DomainAnalog, filepath.Join(dir, "widget.hvr"))
	if got != "./blocks/widget" {
		t.Fatalf("got %q, want ./blocks/widget", got)
	}
	if lib.Get(got) == nil {
		t.Fatal("symbol not in the library")
	}
}

func mkdirWrite(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o644)
}

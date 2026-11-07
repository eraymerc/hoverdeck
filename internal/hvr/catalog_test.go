package hvr

import "testing"

// The part cards under stdlib's parts/ tree are named after the real device,
// so the symbol can only come from the directory: Q2N2222 is an NPN and
// Q2N2907 a PNP, and their names say nothing about which.
func TestIconForReadsThePartFamilyFromTheDirectory(t *testing.T) {
	cases := []struct {
		name, domain, file, want string
	}{
		{"NMOS", DomainAnalog, "/pkg/stdlib/semiconductors/mosfet/nmos.hvr", "nmos"},
		// The four-terminal core brings the bulk out, so it needs the symbol
		// with a fourth pin rather than the one that ties bulk to source.
		{"NMOS4", DomainAnalog, "/pkg/stdlib/semiconductors/mosfet/nmos.hvr", "nmos4"},
		{"PMOS", DomainAnalog, "/pkg/stdlib/semiconductors/mosfet/pmos.hvr", "pmos"},
		{"M2N7000", DomainAnalog, "/pkg/stdlib/parts/mosfet/nmos/2N7000.hvr", "nmos"},
		{"MIRF9540N", DomainAnalog, "/pkg/stdlib/parts/mosfet/pmos/IRF9540N.hvr", "pmos"},
		{"Q2N2222", DomainAnalog, "/pkg/stdlib/parts/bjt/npn/2N2222.hvr", "npn"},
		{"Q2N2907", DomainAnalog, "/pkg/stdlib/parts/bjt/pnp/2N2907.hvr", "pnp"},
		{"D1N4007", DomainAnalog, "/pkg/stdlib/parts/diode/1N4007.hvr", "diode"},
		{"LED_RED", DomainAnalog, "/pkg/stdlib/optoelectronics/leds/led_colors.hvr", "led"},
		{"OpAmp", DomainAnalog, "/pkg/stdlib/analog/opamp/opamp.hvr", "opamp"},

		// A user module in a directory the table says nothing about still
		// falls back to its domain shape.
		{"Widget", DomainAnalog, "/home/me/proj/widget.hvr", "analog"},
		{"Widget", DomainDigital, "/home/me/proj/widget.hvr", "digital"},

		// A definition that was never found carries no path at all.
		{"Q2N2222", DomainStructural, "", "structural"},
	}

	for _, c := range cases {
		if got := IconFor(c.name, c.domain, c.file); got != c.want {
			t.Errorf("IconFor(%q, %q, %q) = %q, want %q", c.name, c.domain, c.file, got, c.want)
		}
	}
}

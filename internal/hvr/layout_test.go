package hvr

import (
	"math"
	"os"
	"strings"
	"testing"
)

const layoutSrc = `module main<>() [] {
    wire n;
    state double integral = 0;
    double ctrl = 0;
    voltage_source<>(ctrl)[n, gnd];
    R<1k>()[n, gnd];
}
`

func TestBlocksAndChipsGetAutoPlacedWithoutOverlap(t *testing.T) {
	entry := writeTemp(t, map[string]string{"main.hvr": layoutSrc})
	p, _ := LoadProject(entry, nil)
	sh, err := p.BuildSheet("main")
	if err != nil {
		t.Fatal(err)
	}
	l := LoadLayout(entry)
	l.Apply(sh)

	seen := map[[2]float64]bool{}
	for _, b := range sh.Blocks {
		key := [2]float64{b.X, b.Y}
		if seen[key] {
			t.Errorf("two blocks auto-placed at the same point %v", key)
		}
		seen[key] = true
	}

	if len(sh.Signals) != 2 {
		t.Fatalf("want 2 signals, got %d", len(sh.Signals))
	}
	chipSeen := map[[2]float64]bool{}
	for _, s := range sh.Signals {
		key := [2]float64{s.X, s.Y}
		if chipSeen[key] {
			t.Errorf("signal chips overlap at %v", key)
		}
		chipSeen[key] = true
	}
}

func TestSignalChipPositionPersists(t *testing.T) {
	entry := writeTemp(t, map[string]string{"main.hvr": layoutSrc})
	p, _ := LoadProject(entry, nil)
	sh, _ := p.BuildSheet("main")

	l := LoadLayout(entry)
	l.SetChipPos("main", "integral", 640, 320)
	l.SetBlockPos("main", "R1", 200, 448)
	if err := l.Save(entry); err != nil {
		t.Fatal(err)
	}

	// A fresh load must see the saved positions.
	l2 := LoadLayout(entry)
	l2.Apply(sh)

	var got *Signal
	for i := range sh.Signals {
		if sh.Signals[i].Name == "integral" {
			got = &sh.Signals[i]
		}
	}
	if got == nil {
		t.Fatal("signal integral missing")
	}
	if got.X != 640 || got.Y != 320 {
		t.Errorf("chip position not restored: got (%v,%v), want (640,320)", got.X, got.Y)
	}

	for _, b := range sh.Blocks {
		if b.ID == "R1" && (b.X != 200 || b.Y != 448) {
			t.Errorf("block position not restored: got (%v,%v), want (200,448)", b.X, b.Y)
		}
	}

	// An unplaced chip must still get a lane position rather than (0,0),
	// which would stack it on top of whatever sits at the origin.
	for i := range sh.Signals {
		s := sh.Signals[i]
		if s.Name != "integral" && s.X == 0 && s.Y == 0 {
			t.Errorf("unplaced chip %q was not auto-placed", s.Name)
		}
	}
}

func TestBlockTransformPersistsAndNormalises(t *testing.T) {
	entry := writeTemp(t, map[string]string{"main.hvr": layoutSrc})
	p, _ := LoadProject(entry, nil)
	sh, _ := p.BuildSheet("main")

	l := LoadLayout(entry)
	l.SetBlockTransform("main", "R1", 90, true, false)
	if err := l.Save(entry); err != nil {
		t.Fatal(err)
	}

	l2 := LoadLayout(entry)
	l2.Apply(sh)
	var found bool
	for _, b := range sh.Blocks {
		if b.ID != "R1" {
			continue
		}
		found = true
		if b.Rot != 90 || !b.FlipX || b.FlipY {
			t.Errorf("transform not restored: rot=%d flipX=%v flipY=%v", b.Rot, b.FlipX, b.FlipY)
		}
	}
	if !found {
		t.Fatal("block R1 missing from the sheet")
	}

	// Angles are snapped to the four right angles and wrapped into range;
	// anything else would leave pins where the router cannot reach them.
	for _, c := range []struct{ in, want int }{
		{450, 90}, {-90, 270}, {360, 0}, {137, 90}, {720, 0},
	} {
		l2.SetBlockTransform("main", "R1", c.in, false, false)
		got := l2.Sheet("main").Blocks["R1"].Rot
		if got != c.want {
			t.Errorf("rot %d normalised to %d, want %d", c.in, got, c.want)
		}
	}
}

func netNamed(sh *Sheet, name string) *Net {
	for i := range sh.Nets {
		if sh.Nets[i].Name == name {
			return &sh.Nets[i]
		}
	}
	return nil
}

func TestNetWiresPersistAndApply(t *testing.T) {
	entry := writeTemp(t, map[string]string{"main.hvr": layoutSrc})
	p, _ := LoadProject(entry, nil)
	sh, _ := p.BuildSheet("main")

	wires := []WireSeg{{0, 0, 64, 0}, {64, 0, 64, 48}}
	l := LoadLayout(entry)
	if err := l.SetNetWires("main", "n", wires); err != nil {
		t.Fatal(err)
	}
	if err := l.Save(entry); err != nil {
		t.Fatal(err)
	}

	LoadLayout(entry).Apply(sh)
	n := netNamed(sh, "n")
	if n == nil {
		t.Fatal("net n missing from the sheet")
	}
	if len(n.Wires) != 2 || n.Wires[0] != wires[0] || n.Wires[1] != wires[1] {
		t.Errorf("wires: got %v, want %v", n.Wires, wires)
	}
	for _, other := range sh.Nets {
		if other.Name != "n" && other.Wires != nil {
			t.Errorf("net %q picked up wires it never had: %v", other.Name, other.Wires)
		}
	}
}

// An empty drawing is "route this net automatically", and ClearNetWires is
// just that.
func TestEmptyWiresReturnNetToAutomatic(t *testing.T) {
	l := &Layout{Sheets: map[string]*SheetLayout{}}
	if err := l.SetNetWires("main", "n", []WireSeg{{0, 0, 16, 0}}); err != nil {
		t.Fatal(err)
	}
	if err := l.SetNetWires("main", "n", nil); err != nil {
		t.Fatal(err)
	}
	if w := l.Sheet("main").Nets["n"].Wires; w != nil {
		t.Errorf("wires should be gone, got %v", w)
	}
}

func TestNetWiresRejectWhatTheCanvasNeverDraws(t *testing.T) {
	l := &Layout{Sheets: map[string]*SheetLayout{}}
	bad := map[string][]WireSeg{
		"diagonal":   {{0, 0, 16, 16}},
		"NaN":        {{math.NaN(), 0, 16, 0}},
		"infinite":   {{0, 0, math.Inf(1), 0}},
		"over limit": make([]WireSeg, maxWireSegs+1),
	}
	for name, w := range bad {
		if err := l.SetNetWires("main", "n", w); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// A rejected drawing must not have replaced a good one.
	good := []WireSeg{{0, 0, 16, 0}}
	_ = l.SetNetWires("main", "n", good)
	_ = l.SetNetWires("main", "n", bad["diagonal"])
	if w := l.Sheet("main").Nets["n"].Wires; len(w) != 1 || w[0] != good[0] {
		t.Errorf("a rejected drawing replaced the saved one: %v", w)
	}
}

// Logic-signal links are saved and restored like nets, but under their own
// key: a wire and a signal never share a drawing.
func TestSignalWiresPersistApartFromNets(t *testing.T) {
	entry := writeTemp(t, map[string]string{"main.hvr": layoutSrc})
	p, _ := LoadProject(entry, nil)
	sh, _ := p.BuildSheet("main")

	link := []WireSeg{{80, 40, 80, 64}, {80, 64, 160, 64}}
	l := LoadLayout(entry)
	if err := l.SetSignalWires("main", "ctrl", link); err != nil {
		t.Fatal(err)
	}
	if err := l.Save(entry); err != nil {
		t.Fatal(err)
	}
	LoadLayout(entry).Apply(sh)

	var ctrl *Signal
	for i := range sh.Signals {
		if sh.Signals[i].Name == "ctrl" {
			ctrl = &sh.Signals[i]
		}
	}
	if ctrl == nil {
		t.Fatal("signal ctrl missing from the sheet")
	}
	if len(ctrl.Wires) != 2 || ctrl.Wires[1] != link[1] {
		t.Errorf("signal wires: got %v, want %v", ctrl.Wires, link)
	}
	for _, n := range sh.Nets {
		if n.Wires != nil {
			t.Errorf("net %q picked up the signal's drawing", n.Name)
		}
	}

	if err := l.SetSignalWires("main", "ctrl", []WireSeg{{0, 0, 8, 8}}); err == nil {
		t.Error("a diagonal link segment was accepted")
	}
	if err := l.SetSignalWires("main", "ctrl", nil); err != nil {
		t.Fatal(err)
	}
	if _, ok := l.Sheet("main").Links["ctrl"]; ok {
		t.Error("clearing a signal's drawing should drop its entry")
	}
}

// Version-1 sidecars stored trunk/leg offsets. They are not converted: the
// nets come back automatic, and saving writes version 2 without them.
func TestVersion1RoutingIsDroppedNotConverted(t *testing.T) {
	entry := writeTemp(t, map[string]string{"main.hvr": layoutSrc})
	old := `{"version": 1, "sheets": {"main": {"blocks": {}, "nets": {
		"n": {"color": "#f00", "trunkX": 512, "trunkDY": -48, "legs": {"V1:0": 40}}}}}}`
	if err := os.WriteFile(LayoutPath(entry), []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}
	p, _ := LoadProject(entry, nil)
	sh, _ := p.BuildSheet("main")

	l := LoadLayout(entry)
	l.Apply(sh)
	n := netNamed(sh, "n")
	if n.Wires != nil {
		t.Errorf("version-1 routing turned into wires: %v", n.Wires)
	}
	if n.Color != "#f00" {
		t.Error("the net's colour should survive")
	}

	if err := l.Save(entry); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(LayoutPath(entry))
	for _, gone := range []string{"trunkX", "trunkDY", "legs"} {
		if strings.Contains(string(raw), gone) {
			t.Errorf("%q still in the saved sidecar", gone)
		}
	}
	if !strings.Contains(string(raw), `"version": 2`) {
		t.Error("the saved sidecar should say version 2")
	}
}

// ccSourcesSrc mirrors tests/circuits/cc_sources.hvr in hover-main: a named
// primitive (vsense) sensed by a CCCS and a CCVS elsewhere in the module.
const ccSourcesSrc = `module main<>()[] {
    wire vin, mid, vout, vmirror;

    voltage_source<5>() [vin, gnd];
    R<1k>()   [vin, mid];

    module probe = Ammeter<>() [mid, gnd];

    CCCS<2>()  [gnd, vout, probe.vsense];
    R<500>()   [vout, gnd];

    CCVS<1k>() [vmirror, gnd, probe.vsense];
    R<10k>()   [vmirror, gnd];
}

analog module Ammeter<>() [wire p, wire n] {
    voltage_source vsense<0>() [p, n];
    double milliamps = I(vsense) * 1000.0;
}
`

func TestNamedPrimitiveUsesSourceNameAsBlockID(t *testing.T) {
	entry := writeTemp(t, map[string]string{"main.hvr": ccSourcesSrc})
	p, _ := LoadProject(entry, nil)
	sh, err := p.BuildSheet("Ammeter")
	if err != nil {
		t.Fatal(err)
	}
	var got *Block
	for i := range sh.Blocks {
		if sh.Blocks[i].ID == "vsense" {
			got = &sh.Blocks[i]
		}
	}
	if got == nil {
		t.Fatal("named primitive vsense should keep its source name as its block ID, not a synthesized V1")
	}
}

func TestCCCSAndCCVSSenseIsARefNotANet(t *testing.T) {
	entry := writeTemp(t, map[string]string{"main.hvr": ccSourcesSrc})
	p, _ := LoadProject(entry, nil)
	sh, err := p.BuildSheet("main")
	if err != nil {
		t.Fatal(err)
	}

	for _, b := range sh.Blocks {
		if b.TypeName != "CCCS" && b.TypeName != "CCVS" {
			continue
		}
		if b.Ready == false {
			t.Errorf("%s: catalog still marks this primitive not-ready", b.TypeName)
		}
		var sense *Pin
		for i := range b.Pins {
			if b.Pins[i].Name == "sense" {
				sense = &b.Pins[i]
			}
		}
		if sense == nil {
			t.Fatalf("%s: no sense pin found", b.TypeName)
		}
		if !sense.Ref {
			t.Errorf("%s: sense pin should be marked Ref, since it names an element rather than a net", b.TypeName)
		}
		if sense.Net != "probe.vsense" {
			t.Errorf("%s: sense pin text: got %q, want %q", b.TypeName, sense.Net, "probe.vsense")
		}
	}

	// The dotted reference must never leak into the net list as a bogus net.
	for _, n := range sh.Nets {
		if n.Name == "probe.vsense" {
			t.Error("a CCCS/CCVS sense reference should not create a net")
		}
	}
}

func TestCorruptSidecarIsIgnored(t *testing.T) {
	entry := writeTemp(t, map[string]string{"main.hvr": layoutSrc})
	if err := WriteFile(LayoutPath(entry), "{ this is not json"); err != nil {
		t.Fatal(err)
	}
	l := LoadLayout(entry)
	if l == nil || l.Sheets == nil {
		t.Fatal("a corrupt sidecar must degrade to an empty layout, not a nil one")
	}
	p, _ := LoadProject(entry, nil)
	sh, err := p.BuildSheet("main")
	if err != nil {
		t.Fatal(err)
	}
	l.Apply(sh) // must not panic
}

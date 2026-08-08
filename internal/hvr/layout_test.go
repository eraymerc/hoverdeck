package hvr

import "testing"

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

func TestNetTrunkStoresBothAxes(t *testing.T) {
	entry := writeTemp(t, map[string]string{"main.hvr": layoutSrc})
	p, _ := LoadProject(entry, nil)
	sh, _ := p.BuildSheet("main")

	l := LoadLayout(entry)
	l.SetNetTrunk("main", "n", 512, -48)
	if err := l.Save(entry); err != nil {
		t.Fatal(err)
	}

	l2 := LoadLayout(entry)
	l2.Apply(sh)
	for _, n := range sh.Nets {
		if n.Name != "n" {
			continue
		}
		if !n.HasTrunk {
			t.Error("trunk should be marked as hand-placed")
		}
		if n.TrunkX != 512 {
			t.Errorf("trunkX: got %v, want 512", n.TrunkX)
		}
		if n.TrunkDY != -48 {
			t.Errorf("trunkDY: got %v, want -48", n.TrunkDY)
		}
	}

	// A trunk pinned at x = 0 must still count as set, which is why the
	// stored fields are pointers rather than plain floats.
	l2.SetNetTrunk("main", "n", 0, 0)
	nl := l2.Sheet("main").Nets["n"]
	if nl.TrunkX == nil || *nl.TrunkX != 0 {
		t.Error("a trunk at x=0 must be distinguishable from unset")
	}

	// Clearing returns the net to automatic routing on both axes.
	l2.ClearNetTrunk("main", "n")
	nl = l2.Sheet("main").Nets["n"]
	if nl.TrunkX != nil || nl.TrunkDY != nil {
		t.Error("clearing should drop both axes")
	}
}

func TestLegDYMovesOneLegIndependently(t *testing.T) {
	entry := writeTemp(t, map[string]string{"main.hvr": layoutSrc})
	p, _ := LoadProject(entry, nil)
	sh, _ := p.BuildSheet("main")

	// Net "n" has two legs: the voltage source's n+ pin (V1:0) and R's n+
	// pin (R1:0). Moving one must not move the other — that independence
	// is the entire point of LegDY existing separately from TrunkDY.
	l := LoadLayout(entry)
	l.SetLegDY("main", "n", "V1:0", 40)
	if err := l.Save(entry); err != nil {
		t.Fatal(err)
	}

	l2 := LoadLayout(entry)
	l2.Apply(sh)

	var got *Net
	for i := range sh.Nets {
		if sh.Nets[i].Name == "n" {
			got = &sh.Nets[i]
		}
	}
	if got == nil {
		t.Fatal("net n missing from the sheet")
	}
	if got.LegDY["V1:0"] != 40 {
		t.Errorf("V1:0 offset: got %v, want 40", got.LegDY["V1:0"])
	}
	if got.LegDY["R1:0"] != 0 {
		t.Errorf("R1:0 should be untouched, got %v", got.LegDY["R1:0"])
	}

	// Setting the net's bulk TrunkDY must not disturb the per-leg offset
	// already recorded for V1:0 — the two are independent, additive knobs.
	l2.SetNetTrunk("main", "n", got.TrunkX, 10)
	l2.Apply(sh)
	for i := range sh.Nets {
		if sh.Nets[i].Name != "n" {
			continue
		}
		if sh.Nets[i].TrunkDY != 10 {
			t.Errorf("bulk TrunkDY: got %v, want 10", sh.Nets[i].TrunkDY)
		}
		if sh.Nets[i].LegDY["V1:0"] != 40 {
			t.Errorf("per-leg offset should survive a bulk trunk move, got %v", sh.Nets[i].LegDY["V1:0"])
		}
	}
}

func TestLegDYNeverSerialisesAsNull(t *testing.T) {
	entry := writeTemp(t, map[string]string{"main.hvr": layoutSrc})
	p, _ := LoadProject(entry, nil)
	sh, err := p.BuildSheet("main")
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range sh.Nets {
		if n.LegDY == nil {
			t.Errorf("net %q: LegDY is nil, which marshals to JSON null and breaks the frontend", n.Name)
		}
	}
}

func TestClearNetTrunkAlsoClearsLegOffsets(t *testing.T) {
	entry := writeTemp(t, map[string]string{"main.hvr": layoutSrc})
	p, _ := LoadProject(entry, nil)
	sh, _ := p.BuildSheet("main")

	l := LoadLayout(entry)
	l.SetNetTrunk("main", "n", 400, 20)
	l.SetLegDY("main", "n", "V1:0", 40)
	l.ClearNetTrunk("main", "n")
	l.Apply(sh)

	for _, n := range sh.Nets {
		if n.Name != "n" {
			continue
		}
		if n.HasTrunk {
			t.Error("clearing should drop the hand-placed trunk")
		}
		if len(n.LegDY) != 0 {
			t.Errorf("clearing should drop per-leg offsets too, got %v", n.LegDY)
		}
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

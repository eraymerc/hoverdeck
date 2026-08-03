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
	p, _ := LoadProject(entry, "")
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
	p, _ := LoadProject(entry, "")
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
	p, _ := LoadProject(entry, "")
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
	p, _ := LoadProject(entry, "")
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

func TestCorruptSidecarIsIgnored(t *testing.T) {
	entry := writeTemp(t, map[string]string{"main.hvr": layoutSrc})
	if err := WriteFile(LayoutPath(entry), "{ this is not json"); err != nil {
		t.Fatal(err)
	}
	l := LoadLayout(entry)
	if l == nil || l.Sheets == nil {
		t.Fatal("a corrupt sidecar must degrade to an empty layout, not a nil one")
	}
	p, _ := LoadProject(entry, "")
	sh, err := p.BuildSheet("main")
	if err != nil {
		t.Fatal(err)
	}
	l.Apply(sh) // must not panic
}

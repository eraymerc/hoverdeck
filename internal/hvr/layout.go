package hvr

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// Layout is the sidecar document: everything hoverdeck knows that the .hvr
// itself does not need to. Keeping it out of the source is deliberate — the
// .hvr the compiler reads stays byte-identical to the one the user wrote.
type Layout struct {
	Version int                    `json:"version"`
	Sheets  map[string]*SheetLayout `json:"sheets"`
}

// SheetLayout holds per-module presentation state.
type SheetLayout struct {
	Blocks map[string]*BlockLayout `json:"blocks"`
	Nets   map[string]*NetLayout   `json:"nets"`
	// Chips holds positions for signal / state-variable chips, which the
	// user can arrange on the canvas just like blocks.
	Chips map[string]*BlockLayout `json:"chips,omitempty"`
}

// BlockLayout is one block's saved position and appearance.
type BlockLayout struct {
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Icon string  `json:"icon,omitempty"`
	Note string  `json:"note,omitempty"`

	// Orientation. Rot is 0, 90, 180 or 270 degrees clockwise and decides
	// which sides the pins leave from; FlipX swaps the two pin groups and
	// FlipY reverses their order, the same two mirrors a schematic editor
	// offers. None of this changes the netlist — only how it is drawn.
	Rot   int  `json:"rot,omitempty"`
	FlipX bool `json:"flipX,omitempty"`
	FlipY bool `json:"flipY,omitempty"`
}

// NetLayout is one net's saved appearance and routing.
type NetLayout struct {
	Color  string `json:"color,omitempty"`
	Hidden bool   `json:"hidden,omitempty"`

	// TrunkX pins the net's vertical routing channel to an x position.
	// A pointer so that "not set" is distinguishable from "set to 0" —
	// x = 0 is a perfectly reasonable place for a wire to run.
	TrunkX *float64 `json:"trunkX,omitempty"`

	// TrunkDY shifts where the horizontal runs meet the trunk, relative to
	// the pins they come from. Together with TrunkX this lets a wire be
	// dragged in both axes: X moves the vertical channel, Y lifts the
	// horizontal legs clear of whatever they were crossing.
	TrunkDY *float64 `json:"trunkDY,omitempty"`
}

// LayoutPath returns the sidecar path for an entry file:
// `main.hvr` -> `main.hoverdeck.json`.
func LayoutPath(entry string) string {
	dir := filepath.Dir(entry)
	base := filepath.Base(entry)
	base = strings.TrimSuffix(base, filepath.Ext(base))
	return filepath.Join(dir, base+".hoverdeck.json")
}

// LoadLayout reads the sidecar, returning an empty layout when absent. A
// corrupt sidecar is also treated as empty rather than fatal: losing saved
// positions must never stop the user from opening their circuit.
func LoadLayout(entry string) *Layout {
	l := &Layout{Version: 1, Sheets: map[string]*SheetLayout{}}
	raw, err := os.ReadFile(LayoutPath(entry))
	if err != nil {
		return l
	}
	var parsed Layout
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return l
	}
	if parsed.Sheets == nil {
		parsed.Sheets = map[string]*SheetLayout{}
	}
	if parsed.Version == 0 {
		parsed.Version = 1
	}
	return &parsed
}

// Save writes the sidecar next to the entry file.
func (l *Layout) Save(entry string) error {
	if l.Version == 0 {
		l.Version = 1
	}
	raw, err := json.MarshalIndent(l, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(LayoutPath(entry), append(raw, '\n'), 0o644)
}

// Sheet returns (creating if needed) the layout record for one module.
func (l *Layout) Sheet(module string) *SheetLayout {
	if l.Sheets == nil {
		l.Sheets = map[string]*SheetLayout{}
	}
	s, ok := l.Sheets[module]
	if !ok {
		s = &SheetLayout{Blocks: map[string]*BlockLayout{}, Nets: map[string]*NetLayout{}}
		l.Sheets[module] = s
	}
	if s.Blocks == nil {
		s.Blocks = map[string]*BlockLayout{}
	}
	if s.Nets == nil {
		s.Nets = map[string]*NetLayout{}
	}
	if s.Chips == nil {
		s.Chips = map[string]*BlockLayout{}
	}
	return s
}

// Apply overlays saved positions and icon overrides onto a freshly built
// sheet, then auto-places any block that has no saved position yet.
func (l *Layout) Apply(sh *Sheet) {
	sl := l.Sheet(sh.Qualified)

	var unplaced []int
	for i := range sh.Blocks {
		b := &sh.Blocks[i]
		if bl, ok := sl.Blocks[b.ID]; ok {
			b.X, b.Y = bl.X, bl.Y
			b.Rot, b.FlipX, b.FlipY = bl.Rot, bl.FlipX, bl.FlipY
			if bl.Icon != "" {
				b.Icon = bl.Icon
			}
		} else {
			unplaced = append(unplaced, i)
		}
	}
	autoPlace(sh, unplaced)
	l.applyChips(sh, sl)

	for i := range sh.Nets {
		n := &sh.Nets[i]
		if nl, ok := sl.Nets[n.Name]; ok {
			n.Color = nl.Color
			if nl.TrunkX != nil {
				n.TrunkX = *nl.TrunkX
				n.HasTrunk = true
			}
			if nl.TrunkDY != nil {
				n.TrunkDY = *nl.TrunkDY
			}
		}
	}
}

// SetNetTrunk pins a net's routing channel in both axes.
func (l *Layout) SetNetTrunk(module, net string, x, dy float64) {
	s := l.Sheet(module)
	n, ok := s.Nets[net]
	if !ok {
		n = &NetLayout{}
		s.Nets[net] = n
	}
	vx, vy := x, dy
	n.TrunkX = &vx
	n.TrunkDY = &vy
}

// SetBlockTransform records a block's orientation.
func (l *Layout) SetBlockTransform(module, blockID string, rot int, flipX, flipY bool) {
	// Normalise to the four right angles; anything else would leave pins at
	// positions the router cannot connect to cleanly.
	rot = ((rot % 360) + 360) % 360
	rot = (rot / 90) * 90

	s := l.Sheet(module)
	b, ok := s.Blocks[blockID]
	if !ok {
		b = &BlockLayout{}
		s.Blocks[blockID] = b
	}
	b.Rot, b.FlipX, b.FlipY = rot, flipX, flipY
}

// ClearNetTrunk returns a net to automatic routing.
func (l *Layout) ClearNetTrunk(module, net string) {
	s := l.Sheet(module)
	if n, ok := s.Nets[net]; ok {
		n.TrunkX = nil
		n.TrunkDY = nil
	}
}

// applyChips restores saved signal-chip positions and lays out any that have
// never been placed in a lane above the blocks.
func (l *Layout) applyChips(sh *Sheet, sl *SheetLayout) {
	laneY := 80.0 // sensible default when the module has no blocks at all
	for i := range sh.Blocks {
		if i == 0 || sh.Blocks[i].Y < laneY {
			laneY = sh.Blocks[i].Y
		}
	}
	laneY -= 58
	x := 80.0

	for i := range sh.Signals {
		s := &sh.Signals[i]
		if cl, ok := sl.Chips[s.Name]; ok {
			s.X, s.Y = cl.X, cl.Y
			continue
		}
		s.X, s.Y = x, laneY
		x += chipWidth(s.Name) + 10
	}
}

// chipWidth mirrors the width the canvas gives a chip, so auto-placed chips
// in the lane do not overlap.
func chipWidth(name string) float64 {
	w := float64(len(name))*7 + 44
	if w < 64 {
		w = 64
	}
	return w
}

// SetChipPos records a signal chip's position.
func (l *Layout) SetChipPos(module, name string, x, y float64) {
	s := l.Sheet(module)
	c, ok := s.Chips[name]
	if !ok {
		c = &BlockLayout{}
		s.Chips[name] = c
	}
	c.X, c.Y = x, y
}

// autoPlace lays out blocks that have never been positioned. It is a simple
// column-major grid rather than a force-directed solver: positions are saved
// on first drag, so this only has to be a reasonable starting point that
// never overlaps, not a finished schematic.
func autoPlace(sh *Sheet, idx []int) {
	const (
		colW   = 260
		rowH   = 150
		originX = 80
		originY = 80
		perCol = 5
	)
	// Start below whatever is already placed so new blocks do not land on top
	// of an arranged diagram.
	startRow := 0
	occupied := map[[2]int]bool{}
	for i := range sh.Blocks {
		b := sh.Blocks[i]
		if b.X == 0 && b.Y == 0 {
			continue
		}
		occupied[[2]int{int(b.X) / colW, int(b.Y) / rowH}] = true
	}

	n := 0
	for _, i := range idx {
		for {
			col := (startRow + n) / perCol
			row := (startRow + n) % perCol
			cell := [2]int{col, row}
			if !occupied[cell] {
				occupied[cell] = true
				sh.Blocks[i].X = float64(originX + col*colW)
				sh.Blocks[i].Y = float64(originY + row*rowH)
				n++
				break
			}
			n++
		}
	}
}

// SetBlockPos records a block's position.
func (l *Layout) SetBlockPos(module, blockID string, x, y float64) {
	s := l.Sheet(module)
	b, ok := s.Blocks[blockID]
	if !ok {
		b = &BlockLayout{}
		s.Blocks[blockID] = b
	}
	b.X, b.Y = x, y
}

// SetBlockIcon records an icon override for a block.
func (l *Layout) SetBlockIcon(module, blockID, icon string) {
	s := l.Sheet(module)
	b, ok := s.Blocks[blockID]
	if !ok {
		b = &BlockLayout{}
		s.Blocks[blockID] = b
	}
	b.Icon = icon
}

// SetNetColor records a highlight colour for a net.
func (l *Layout) SetNetColor(module, net, color string) {
	s := l.Sheet(module)
	n, ok := s.Nets[net]
	if !ok {
		n = &NetLayout{}
		s.Nets[net] = n
	}
	n.Color = color
}

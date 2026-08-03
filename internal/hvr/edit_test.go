package hvr

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeTemp lays out a throwaway project and returns the entry path.
func writeTemp(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		full := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return filepath.Join(dir, "main.hvr")
}

const basicMain = `.tran(0, 10m, 1u);

module main<>() []
{
    wire a, b;

    voltage_source<5>()[a, gnd];
    R<1k>()[a, b];
    C<100n>()[b, gnd];
}
`

func TestSheetNetsAndPins(t *testing.T) {
	entry := writeTemp(t, map[string]string{"main.hvr": basicMain})
	p, err := LoadProject(entry, "")
	if err != nil {
		t.Fatal(err)
	}
	sh, err := p.BuildSheet("main")
	if err != nil {
		t.Fatal(err)
	}

	if len(sh.Blocks) != 3 {
		t.Fatalf("want 3 blocks, got %d", len(sh.Blocks))
	}
	want := []string{"V1", "R1", "C1"}
	for i, w := range want {
		if sh.Blocks[i].ID != w {
			t.Errorf("block %d: want id %s, got %s", i, w, sh.Blocks[i].ID)
		}
	}

	// Every pin span must slice back to exactly the net name it reports.
	src := p.Files[sh.File].Src
	for _, b := range sh.Blocks {
		for _, pin := range b.Pins {
			if got := src.TextOf(pin.Span); got != pin.Net {
				t.Errorf("%s.%s: span text %q != net %q", b.ID, pin.Name, got, pin.Net)
			}
		}
	}

	byName := map[string]Net{}
	for _, n := range sh.Nets {
		byName[n.Name] = n
	}
	if got := len(byName["a"].Pins); got != 2 {
		t.Errorf("net a: want 2 pins, got %d", got)
	}
	if got := len(byName["gnd"].Pins); got != 2 {
		t.Errorf("net gnd: want 2 pins, got %d", got)
	}
	if !byName["gnd"].IsGround {
		t.Error("gnd should be flagged as ground")
	}
	if !byName["a"].Declared {
		t.Error("net a should be marked declared")
	}
}

func TestParamSpansPreserveExactText(t *testing.T) {
	// Negative and expression parameters must round-trip verbatim. The
	// compiler's Expression.String() would render these as "(-15)" and
	// "(1 / B)", which is exactly what span extraction has to avoid.
	src := `module main<>() [] {
    wire n;
    voltage_source<-15>()[n, gnd];
    R<1/B>()[n, gnd];
    C<2p>()[n, gnd];
}
`
	entry := writeTemp(t, map[string]string{"main.hvr": src})
	p, _ := LoadProject(entry, "")
	sh, err := p.BuildSheet("main")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"-15", "1/B", "2p"}
	for i, w := range want {
		if len(sh.Blocks[i].Params) != 1 {
			t.Fatalf("block %d: want 1 param, got %v", i, sh.Blocks[i].Params)
		}
		if got := sh.Blocks[i].Params[0].Text; got != w {
			t.Errorf("block %d: want param %q, got %q", i, w, got)
		}
	}
}

func TestCommentsInsidePortListDoNotBreakScanning(t *testing.T) {
	src := `module main<>() [] {
    wire a, b;
    R<1k>()[a, /* mid */ b]; // trailing
    C<1u>()[a /* x */, b];
}
`
	entry := writeTemp(t, map[string]string{"main.hvr": src})
	p, _ := LoadProject(entry, "")
	sh, err := p.BuildSheet("main")
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range sh.Blocks {
		if len(b.Pins) != 2 {
			t.Fatalf("%s: want 2 pins, got %d (%v)", b.ID, len(b.Pins), b.Pins)
		}
		if b.Pins[0].Net != "a" || b.Pins[1].Net != "b" {
			t.Errorf("%s: want [a b], got [%s %s]", b.ID, b.Pins[0].Net, b.Pins[1].Net)
		}
	}
}

func TestInsertPrimitiveKeepsFileIntact(t *testing.T) {
	entry := writeTemp(t, map[string]string{"main.hvr": basicMain})
	p, _ := LoadProject(entry, "")

	if _, err := p.InsertBlock(InsertRequest{
		Module:   "main",
		Kind:     "primitive",
		TypeName: "L",
		Static:   "10u",
		Ports:    []string{"b", "gnd"},
	}); err != nil {
		t.Fatal(err)
	}

	out := readFile(t, entry)
	if !strings.Contains(out, "L<10u>()[b, gnd];") {
		t.Errorf("inserted statement missing:\n%s", out)
	}
	// Everything that was already there must survive verbatim.
	for _, keep := range []string{".tran(0, 10m, 1u);", "wire a, b;", "R<1k>()[a, b];", "C<100n>()[b, gnd];"} {
		if !strings.Contains(out, keep) {
			t.Errorf("insertion destroyed %q:\n%s", keep, out)
		}
	}
	// It must land inside the module, before the closing brace.
	if strings.Index(out, "L<10u>") > strings.LastIndex(out, "}") {
		t.Errorf("statement inserted outside the module body:\n%s", out)
	}

	// And the result must still parse with the real compiler front end.
	p2, err := LoadProject(entry, "")
	if err != nil {
		t.Fatal(err)
	}
	if errs := p2.AllErrors(); len(errs) != 0 {
		t.Errorf("inserted code does not parse: %v", errs)
	}
	sh, _ := p2.BuildSheet("main")
	if len(sh.Blocks) != 4 {
		t.Errorf("want 4 blocks after insert, got %d", len(sh.Blocks))
	}
}

func TestInsertModuleAddsImportOnce(t *testing.T) {
	dir := t.TempDir()
	std := filepath.Join(dir, "std")
	if err := os.MkdirAll(filepath.Join(std, "semis"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(std, "semis", "diode.hvr"), []byte(
		"analog module Diode<double Is>() [wire anode, wire cathode] {\n    current_source<>(Is)[anode, cathode];\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	entry := filepath.Join(dir, "main.hvr")
	if err := os.WriteFile(entry, []byte(basicMain), 0o644); err != nil {
		t.Fatal(err)
	}

	req := InsertRequest{
		Module:     "main",
		Kind:       "module",
		TypeName:   "Diode",
		Alias:      "Diode",
		ImportPath: "semis/diode.hvr",
		Static:     "1p",
		Ports:      []string{"a", "b"},
	}

	p, _ := LoadProject(entry, std)
	res, err := p.InsertBlock(req)
	if err != nil {
		t.Fatal(err)
	}
	if !res.ImportAdded {
		t.Error("expected an import to be added")
	}

	out := readFile(t, entry)
	if !strings.Contains(out, "import <semis/diode.hvr> as Diode;") {
		t.Errorf("import missing:\n%s", out)
	}
	if !strings.Contains(out, "module diode = Diode.Diode<1p>()[a, b];") {
		t.Errorf("instantiation missing or malformed:\n%s", out)
	}

	// A second insert must reuse the existing import and pick a fresh name.
	p2, err := LoadProject(entry, std)
	if err != nil {
		t.Fatal(err)
	}
	res2, err := p2.InsertBlock(req)
	if err != nil {
		t.Fatal(err)
	}
	if res2.ImportAdded {
		t.Error("import should not be added twice")
	}
	out2 := readFile(t, entry)
	if strings.Count(out2, "import <semis/diode.hvr>") != 1 {
		t.Errorf("import duplicated:\n%s", out2)
	}
	if res2.InstanceName == res.InstanceName {
		t.Errorf("instance name collision: both %q", res2.InstanceName)
	}

	p3, err := LoadProject(entry, std)
	if err != nil {
		t.Fatal(err)
	}
	if errs := p3.AllErrors(); len(errs) != 0 {
		t.Errorf("result does not parse: %v", errs)
	}
	sh, _ := p3.BuildSheet("main")
	for _, b := range sh.Blocks {
		if b.Kind == "instance" && !b.Def.Found {
			t.Errorf("inserted instance %s did not resolve to its definition", b.ID)
		}
	}
}

func TestRenameNetUpdatesUsesAndDeclaration(t *testing.T) {
	entry := writeTemp(t, map[string]string{"main.hvr": basicMain})
	p, _ := LoadProject(entry, "")

	n, err := p.RenameNet("main", "b", "out_node")
	if err != nil {
		t.Fatal(err)
	}
	// R.n-, C.n+, and the wire declaration.
	if n != 3 {
		t.Errorf("want 3 replacements, got %d", n)
	}

	out := readFile(t, entry)
	if !strings.Contains(out, "wire a, out_node;") {
		t.Errorf("declaration not renamed:\n%s", out)
	}
	if !strings.Contains(out, "R<1k>()[a, out_node];") || !strings.Contains(out, "C<100n>()[out_node, gnd];") {
		t.Errorf("uses not renamed:\n%s", out)
	}
	if strings.Contains(out, "[a, b]") {
		t.Errorf("stale net name remains:\n%s", out)
	}

	p2, _ := LoadProject(entry, "")
	if errs := p2.AllErrors(); len(errs) != 0 {
		t.Errorf("renamed source does not parse: %v", errs)
	}
}

func TestRenameNetRejectsBadInput(t *testing.T) {
	entry := writeTemp(t, map[string]string{"main.hvr": basicMain})
	p, _ := LoadProject(entry, "")

	if _, err := p.RenameNet("main", "b", "9bad"); err == nil {
		t.Error("expected rejection of an identifier starting with a digit")
	}
	if _, err := p.RenameNet("main", "b", "while"); err == nil {
		t.Error("expected rejection of a reserved keyword")
	}
	if _, err := p.RenameNet("main", "b", "a"); err == nil {
		t.Error("expected rejection of a name that collides with an existing net")
	}
	if _, err := p.RenameNet("main", "gnd", "ground"); err == nil {
		t.Error("expected refusal to rename gnd")
	}
	if got := readFile(t, entry); got != basicMain {
		t.Errorf("a rejected rename must not modify the file:\n%s", got)
	}
}

func TestSetPortNetReplacesOnlyThatPort(t *testing.T) {
	entry := writeTemp(t, map[string]string{"main.hvr": basicMain})
	p, _ := LoadProject(entry, "")
	sh, _ := p.BuildSheet("main")

	var target Pin
	for _, b := range sh.Blocks {
		if b.ID == "R1" {
			target = b.Pins[1] // the "b" end
		}
	}
	if err := ReplaceSpan(sh.File, target.Span, "mid"); err != nil {
		t.Fatal(err)
	}
	out := readFile(t, entry)
	if !strings.Contains(out, "R<1k>()[a, mid];") {
		t.Errorf("port not repointed:\n%s", out)
	}
	if !strings.Contains(out, "C<100n>()[b, gnd];") {
		t.Errorf("a sibling statement was modified:\n%s", out)
	}
}

func TestDeleteBlockRemovesWholeLine(t *testing.T) {
	entry := writeTemp(t, map[string]string{"main.hvr": basicMain})
	p, _ := LoadProject(entry, "")
	sh, _ := p.BuildSheet("main")

	var stmt Span
	for _, b := range sh.Blocks {
		if b.ID == "R1" {
			stmt = b.Stmt
		}
	}
	if err := DeleteStatement(sh.File, stmt); err != nil {
		t.Fatal(err)
	}
	out := readFile(t, entry)
	if strings.Contains(out, "R<1k>") {
		t.Errorf("statement not removed:\n%s", out)
	}
	if strings.Contains(out, "\n\n\n") {
		t.Errorf("deletion left a blank hole:\n%s", out)
	}
	p2, _ := LoadProject(entry, "")
	if errs := p2.AllErrors(); len(errs) != 0 {
		t.Errorf("source does not parse after delete: %v", errs)
	}
}

func TestStaleSpanIsRejected(t *testing.T) {
	entry := writeTemp(t, map[string]string{"main.hvr": basicMain})
	err := ReplaceSpan(entry, Span{Start: 10, End: 999999}, "x")
	if err == nil {
		t.Fatal("expected an out-of-range span to be refused")
	}
	if !strings.Contains(err.Error(), "reload") {
		t.Errorf("error should tell the user to reload, got: %v", err)
	}
}

func TestAliasedAndBareImportResolution(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "parts.hvr"), []byte(
		"analog module Widget<double k>() [wire p, wire n] {\n    R<k>()[p, n];\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	entry := filepath.Join(dir, "main.hvr")

	// Bare import: reachable as "Widget".
	if err := os.WriteFile(entry, []byte(
		"import \"./parts.hvr\";\nmodule main<>() [] {\n    wire a;\n    module w = Widget<1k>()[a, gnd];\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	p, _ := LoadProject(entry, "")
	if _, ok := p.Module("Widget"); !ok {
		t.Error("bare import should expose Widget unqualified")
	}
	sh, _ := p.BuildSheet("main")
	if !sh.Blocks[0].Def.Found {
		t.Error("bare-imported instance did not resolve")
	}

	// Aliased import: reachable only as "P.Widget".
	if err := os.WriteFile(entry, []byte(
		"import \"./parts.hvr\" as P;\nmodule main<>() [] {\n    wire a;\n    module w = P.Widget<1k>()[a, gnd];\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	p2, _ := LoadProject(entry, "")
	if _, ok := p2.Module("P.Widget"); !ok {
		t.Error("aliased import should expose P.Widget")
	}
	if _, ok := p2.Module("Widget"); ok {
		t.Error("aliased import must NOT expose the bare name")
	}
	sh2, _ := p2.BuildSheet("main")
	if !sh2.Blocks[0].Def.Found {
		t.Error("aliased instance did not resolve")
	}
}

func TestStateVariablesAreReported(t *testing.T) {
	src := `digital module Ctl<>(input double meas, output double ctrl) []
{
    state double integral = 0;
    state double prev = 0;
    double error = 3.0 - meas;
    ctrl = 0.5 * error + 100.0 * integral;
}

module main<>() [] {
    wire n;
    double c = 0;
    double m = V(n);
    module k = Ctl<>(m, c)[];
    voltage_source<>(c)[n, gnd];
}
`
	entry := writeTemp(t, map[string]string{"main.hvr": src})
	p, _ := LoadProject(entry, "")

	sh, err := p.BuildSheet("Ctl")
	if err != nil {
		t.Fatal(err)
	}
	states := 0
	for _, s := range sh.Signals {
		if s.IsState {
			states++
		}
	}
	if states != 2 {
		t.Errorf("want 2 state variables, got %d (%v)", states, sh.Signals)
	}

	// The structural sheet reports its own plain signals.
	msh, _ := p.BuildSheet("main")
	if len(msh.Signals) != 2 {
		t.Errorf("want 2 signals in main, got %v", msh.Signals)
	}
	for _, s := range msh.Signals {
		if s.IsState {
			t.Errorf("main has no state variables, got %v", s)
		}
	}
}

func TestDrivenSourceLogicArgCaptured(t *testing.T) {
	src := `module main<>() [] {
    wire n;
    double sig = 0;
    voltage_source<>(sig)[n, gnd];
}
`
	entry := writeTemp(t, map[string]string{"main.hvr": src})
	p, _ := LoadProject(entry, "")
	sh, _ := p.BuildSheet("main")

	b := sh.Blocks[0]
	if len(b.Logic) != 1 || b.Logic[0].Text != "sig" {
		t.Errorf("driven source control signal not captured: %v", b.Logic)
	}
	if len(b.Params) != 0 {
		t.Errorf("driven source should have no static value, got %v", b.Params)
	}
}

func TestSheetCollectionsAreNeverNilInJSON(t *testing.T) {
	// A nil Go slice marshals to `null`, not `[]`. A module with no signals
	// used to send `signals: null`, which the canvas then tried to iterate —
	// "null is not an object". Every collection must serialise as an array.
	src := `module main<>() []
{
    wire in, out;
    voltage_source<5>()[in, gnd];
    R<1k>()[in, out];
}
`
	entry := writeTemp(t, map[string]string{"main.hvr": src})
	p, _ := LoadProject(entry, "")
	sh, err := p.BuildSheet("main")
	if err != nil {
		t.Fatal(err)
	}
	if len(sh.Signals) != 0 {
		t.Fatalf("this fixture is meant to have no signals, got %v", sh.Signals)
	}

	raw, err := json.Marshal(sh)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}

	for _, key := range []string{"blocks", "nets", "signals", "physPorts", "logicPorts", "errors"} {
		v, present := decoded[key]
		if !present {
			t.Errorf("%q missing from the JSON entirely", key)
			continue
		}
		if v == nil {
			t.Errorf("%q serialised as null; it must be an empty array", key)
		}
	}

	// The same rule applies inside each block.
	blocks, _ := decoded["blocks"].([]any)
	if len(blocks) == 0 {
		t.Fatal("expected blocks in the fixture")
	}
	for i, b := range blocks {
		bm := b.(map[string]any)
		for _, key := range []string{"params", "logic", "pins", "logicPorts"} {
			if v, present := bm[key]; !present || v == nil {
				t.Errorf("block %d: %q serialised as null", i, key)
			}
		}
	}

	// And inside each net.
	nets, _ := decoded["nets"].([]any)
	for i, n := range nets {
		nm := n.(map[string]any)
		if v, present := nm["pins"]; !present || v == nil {
			t.Errorf("net %d: pins serialised as null", i)
		}
	}
}

func TestEmptyModuleProducesUsableSheet(t *testing.T) {
	// The degenerate case: a module with nothing in it at all.
	entry := writeTemp(t, map[string]string{"main.hvr": "module main<>() [] {\n}\n"})
	p, _ := LoadProject(entry, "")
	sh, err := p.BuildSheet("main")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(sh)
	var decoded map[string]any
	_ = json.Unmarshal(raw, &decoded)
	for _, key := range []string{"blocks", "nets", "signals", "errors"} {
		if decoded[key] == nil {
			t.Errorf("%q is null for an empty module", key)
		}
	}
}

func readFile(t *testing.T, p string) string {
	t.Helper()
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

# hoverdeck

A visual netlist browser and editor for the [Hover](https://github.com/eraymerc/hover-lang)
mixed-systems co-simulation language.

hoverdeck shows you **what is connected to where**. It reads your `.hvr` files with the
real compiler front end, draws each module's blocks, wires and state variables, and lets
you edit the code from the same window.

Tracks **hover 0.8**: imports name directories, packages resolve through `hover.lock`
and `~/.hover`, and the standard library is installed by `hover --setup` rather than
found on disk.

It is not a schematic capture tool that generates code behind your back. **The `.hvr`
files stay the source of truth**: hoverdeck parses them to build the picture, and every
change it makes is a narrow, surgical edit to the exact bytes involved. Comments,
formatting and everything else you wrote survive untouched.

## What it shows

| | |
|---|---|
| **Solid lines** | electrical nets — the wires in a `[...]` port list |
| **Dashed amber lines** | logic signals — values passed through a `(...)` logic port, with an arrow showing direction from the port's `input`/`output` declaration |
| **Amber chips** | `state` variables and plain signals declared in the module |
| **Ground symbols** | every `gnd` pin, drawn locally rather than routed — the way a real schematic does it |
| **Block accent colour** | the module's domain: blue structural, green analog, purple digital, grey primitive |
| **↧ badge** | the block can be opened as its own sheet |

Primitives and standard-library devices are drawn as real schematic symbols in the
Elektuur style of the late '70s–'80s, with wires attached to the ends of their leads —
resistor, capacitor, inductor, voltage and current sources, the SPICE diamond for
controlled sources, BJTs for `NPN`/`PNP`, MOSFETs for `NMOS`/`PMOS` (body arrow tied
to the source) and `NMOS4`/`PMOS4` (bulk brought out), a diode/LED, an op-amp
triangle, and a motor circle for `PMSM`. A module with no matching symbol is drawn as
a box. Primitives are labelled with SPICE reference designators (`R1`, `C2`, `V1`, …).

Symbols are plain SVG files in `internal/hvr/symbols/`, with pins marked in the
drawing; the format, and how a module's ports find a symbol's pins, is written down in
[`internal/hvr/symbols/README.md`](internal/hvr/symbols/README.md).

The **part cards** under `parts/` — `Q2N2222`, `D1N4007`, `M2N7000`, `MIRF9540N` and
the rest — get their family's symbol from the directory they are declared in, since
nothing in the name of a real device says whether it is an NPN or a PNP.

## What you can do

- **Open** → one button asks whether you want a single file or a folder.
  *File* loads one `.hvr` as the circuit. *Folder* browses a project tree the way an
  editor opens a workspace; a folder containing a single `main.hvr` loads it
  automatically, and otherwise double-clicking any `.hvr` makes it the circuit
  (single click just opens it for editing, and a `.csv` opens in the plotter).
- **New file / new folder** → from the Files tab. A name with no extension gets
  `.hvr`, and new `.hvr` files start from a small skeleton that already parses
  (`main.hvr` gets a top-level circuit, anything else gets a component module).
- **Click a block** → inspector shows its parameters, logic ports and physical ports;
  the code pane loads its defining source.
- **Edit model code** → the definition opens in the editor with its module highlighted.
  `Ctrl+S` saves and re-parses.
- **Edit `main.hvr`** → toolbar button, or pick any file from the Files tab.
- **Double-click a block** → drill into it as a sheet if it has children; otherwise jump
  to its source.
- **Edit a value in place** → change a parameter, a port's net, or a driven source's
  control signal in the inspector; it rewrites just that span.
- **Drag from the palette** → inserts a correct instantiation into the current module,
  adding the `import <...>` line if the type isn't visible yet, and qualifying the type
  with whatever name that import binds.
- **Rename a net** → updates every use in the module plus its `wire` declaration.
- **Arrange the diagram** → drag blocks, signal chips and wires; positions are saved.
- **Rotate and mirror blocks** → from the inspector, or with `R` (rotate 90°),
  `H` (mirror) and `V` (reverse pin order) while a block is selected. Rotating moves
  the pins onto the top and bottom edges; the label stays upright so it remains
  readable. This is presentation only — the netlist never changes.
- **Find in code** → `Ctrl+F`, with `Ctrl+H` or the ⇄ button for replace. `Enter` /
  `Shift+Enter` and `F3` step through matches, `Aa` toggles case sensitivity, `Esc`
  closes. Searching resumes from the caret rather than the top of the file.
- **Resize any pane** → drag the dividers between the palette, canvas and code panes,
  and the divider above the output console. Sizes persist per machine.
- **Run** → compiles and simulates with your own `hover` binary, streaming its output
  into the console. `Ctrl+R`, or the ▶ button. Unsaved edits are written first, since
  the compiler reads from disk.

Wires are routed automatically, but every multi-pin net has a **trunk you can drag in
both axes**: horizontally to slide the vertical channel the net runs down, vertically
to lift its horizontal legs clear of whatever they were crossing. A hand-placed route
is remembered; the Inspector's net view resets it back to automatic.

Invalid identifiers, reserved keywords and colliding net names are rejected before
anything is written, so the GUI cannot produce a file that fails to lex.

## Running a simulation

hoverdeck does not bundle a compiler — it drives the `hover` binary you already have.
It auto-detects one by looking for a directory containing both a `hover` executable and
a `runtime/` directory, searching up from hoverdeck and across sibling checkouts. If
that finds the wrong one, set it explicitly in **Settings** (⚙).

Settings live in `$XDG_CONFIG_HOME/hoverdeck/config.json` and hold two things:

| | |
|---|---|
| **hover binary** | the compiler to invoke |
| **working directory** | where it runs — leave blank to use the project folder |

Leave the working directory blank. Until hover 0.8 it had to be the root of your hover
checkout, because the CLI resolved `./runtime` and `./toolchain/zig` from wherever it was
run; 0.8 anchors both to the compiler executable's own directory, so a run happens in your
project and `sim.cpp`, `sim` and `simulation_output.csv` land beside the circuit that
produced them.

A fresh hover install needs `hover --setup` once — it builds the C++ runtime and downloads
the standard library. Settings says so when either is missing, and has a button to run it;
output streams into the console like any other run.

Output streams into the console panel as it arrives, coloured by the CLI's own
`[Stage]` prefixes, and **Stop** kills the whole process tree — the compiler, Zig, and
the simulation binary it spawned.

## Waveform viewer

The **📈 Plot** button opens the viewer, and a successful run opens it
automatically on the results it just produced. Double-clicking a `.csv` in the file
tree plots it too.

Nothing is drawn until you ask for it: a run with fifty saved nodes opens to an empty
grid with the signal list on the right, rather than fifty overlapping traces. Tick the
signals you want, and assign any of them to a second Y axis.

Features carried over from the previous HTML viewer: X-axis selection (so a transient
becomes an X-Y parametric plot), maths channels with saved macros, moving-average /
windowed-sinc FIR / zero-phase Butterworth filters, time-bounded measurements, FFT with
selectable window and length, THD, and CSV export. Wheel zooms, drag pans, double-click
fits, and the crosshair reads out every visible trace.

### Why this one is fast

The numeric work happens in Go and the canvas only ever receives what it can draw.
Measured on a 68 MB, 1,000,000-row, 4-column run:

| | |
|---|---|
| Load (once, on open) | ~680 ms |
| **Redraw on pan/zoom** | **~7 ms** |
| FFT, 32768-point | ~5 ms |
| THD | ~6 ms |
| Maths expression over 1M rows | ~29 ms |
| Zero-phase Butterworth over 1M rows | ~12 ms |

Three specific changes account for it:

- **A radix-2 FFT instead of a direct DFT.** The old viewer evaluated the transform sum
  literally, which is O(N·K) — a 32768-point spectrum is roughly 537 million
  trigonometric evaluations. The FFT is O(N log N).
- **Min/max decimation before drawing.** The screen has ~1200 usable pixels, so Go
  reduces each trace to two points per pixel column: the minimum and maximum of the
  samples falling in it. That keeps narrow spikes that point-sampling would drop, while
  the browser strokes ~2400 points instead of a million.
- **Parsing in Go.** A streaming numeric parser rather than a general CSV reader in
  JavaScript.

Export always writes full-resolution samples — decimation exists to make drawing fast,
not to discard data.

## Layout storage

Block positions, chip positions and symbol overrides live in a sidecar file next to
your entry file:

```
main.hvr             <- untouched; byte-identical to what the compiler reads
main.hoverdeck.json  <- positions, icons
```

Nothing hoverdeck stores can break a build. Deleting the sidecar just means the next
open auto-arranges the diagram.

## Building

**Linux and Windows only.** macOS is deliberately unsupported, matching the hover-lang
project policy on Apple's cross-compilation and open-source restrictions;
`platform_darwin.go` fails the build with an explanation if you try.

Requirements: Go 1.25+, Node 18+, [Wails v2](https://wails.io), and GTK3 + WebKit2GTK
on Linux.

hoverdeck compiles the Hover compiler in directly, via a `replace` directive:

```
replace hover => ../hover-main
```

so a checkout of the hover compiler must sit beside this directory. Changes to the compiler's
AST are picked up on the next build with no re-pinning.

```sh
git clone https://github.com/eraymerc/hover-lang.git hover-main   # sibling of hoverdeck/
cd hoverdeck
make build          # -> build/bin/hoverdeck
make dev            # live-reloading development window
make check          # go vet + tsc --noEmit + tests
make build-windows  # cross-compile for Windows
```

On distributions that ship **webkit2gtk-4.1** rather than 4.0 (Arch, recent Fedora,
Ubuntu 24.04+), Wails needs a build tag. The Makefile detects this and adds
`-tags webkit2_41` automatically; if you invoke `wails` directly, pass it yourself:

```sh
wails build -tags webkit2_41
```

## Packages

Since hover 0.8 an import names a **directory**, and the first segment of an angle import
is a **package name**:

```hover
import <math>;                       // math.sin(x)
import <semiconductors> as devices;  // devices.Diode<...>
from <math> import sin;              // sin(x)
import "./parts";                    // parts.Widget<...>
```

A whole-directory import is always qualified — nothing it brings in lands in the flat
namespace — and the binding defaults to the last path segment. Only `from … import …`
puts names in scope bare. hoverdeck's palette writes both forms correctly, and the
insert dialog shows which qualifier the statement will use.

The standard library is an ordinary installed package, so there is nothing to point
hoverdeck at. It reads the same lockfiles the compiler does:

- inside a project — that project's `hover.lock`, plus the machine's standard library
- outside one — everything installed machine-wide in `~/.hover`

The status bar shows how many package roots resolved; click it for the package window,
which lists them and runs `hover hpm install / list / update / verify` in the project
folder. Anything installed from a terminal shows up on the next re-read.

One thing to know when opening a 0.7 file: `import <math/math.hvr>` is no longer valid,
and hoverdeck reports it as `write <math> instead of <math/math.hvr>` rather than as an
unresolved path, so the fix is mechanical.

## Layout

```
app.go                  bound API surface (open, sheets, edits, catalog)
workspace.go            folder tree, create file/folder
config.go               settings + hover install detection
run.go                  drives the hover compiler, streams its output
run_unix.go/_windows.go process-tree termination per platform
main.go                 Wails window setup
platform_darwin.go      compile-time platform guard
internal/hvr/
  packages.go           the import table: lockfiles, ~/.hover, bundled fallback
  project.go            load + parse a file and its imports; module namespace
  source.go             byte-exact span recovery from the source text
  graph.go              module -> blocks, nets, signals
  edit.go               surgical source edits (insert, rename, delete, replace)
  catalog.go            primitives, icons, installed-package scan
  layout.go             sidecar persistence
cmd/probe/              CLI that dumps a parsed sheet; handy for debugging
frontend/src/
  canvas.ts             SVG diagram: routing, drag, zoom
  editor.ts             Hover syntax highlighting + editing
  icons.ts              schematic symbols
  main.ts               shell, inspector, palette, modals
```

The frontend has **no runtime dependencies** — the canvas, the editor and the
highlighter are all hand-written, and the production bundle is about 50 kB.

## Why spans, not AST printing

The compiler's `Expression.String()` is a normalising pretty-printer: it renders `-15`
as `(-15)` and `1/B` as `(1 / B)`, and the AST carries no comments at all. Regenerating
a `.hvr` from the AST would silently reformat the whole file.

So hoverdeck never does that. It takes the line/column the parser records for each
statement, re-scans the source to recover the exact byte ranges of the `<...>`, `(...)`
and `[...]` groups, and edits only those ranges. Tests cover the round trip: after every
mutation the result is re-parsed with the real compiler front end and checked.

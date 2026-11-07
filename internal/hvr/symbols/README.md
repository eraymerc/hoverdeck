# Schematic symbol format

One symbol per file, `<name>.svg`; the file name is the symbol's id — the value
`IconFor`, the primitive table and the sidecar's icon override refer to. Names
are lower-case letters, digits, `-` and `_`.

The drawings here follow the Elektuur style of the late 1970s–80s, taken from
the CC0 [kicad-elektuur-symbols](https://gitlab.com/mgyger/kicad-addons/)
library: open rectangle resistors, solid plates and triangles, transistors in
an envelope circle.

## Coordinates

- The `viewBox` is the symbol's coordinate system and is **required**. Units
  are canvas pixels at zoom 1.
- The origin `(0, 0)` is the block's position on the sheet and the point it
  rotates about. Put it on the grid, normally in the middle of the symbol.
- One schematic grid step (100 mil / 2.54 mm in KiCad terms) is **16 px**.
  Pins must sit on multiples of **8 px**, and in practice on multiples of 16.
  Blocks are dragged on the same grid, so pins stay on it at any rotation and
  wires between them line up.
- No `transform` attributes, anywhere. Pin positions are read straight from
  `cx`/`cy`, so a transform would move the drawing away from its pins.

## Drawing

Allowed elements: `g`, `path`, `line`, `polyline`, `polygon`, `rect`,
`circle`, `ellipse`. Geometry attributes only, as plain numbers (no units).

Styling is by class, never by `fill`/`stroke`/`style` attributes, so the
canvas can theme and highlight symbols:

| class  | meaning                                                        |
|--------|----------------------------------------------------------------|
| *none* | a 1.6 px line, the weight of a wire                            |
| `bold` | double weight — bodies, envelopes                              |
| `fill` | filled solid in the line colour — plates, triangles, arrowheads |
| `dash` | dashed — a reference rather than a connection                  |

`data-if-pin="<pin>"` on a top-level element draws it only when that
(optional) pin is connected — the supply leads of an op-amp, for example.

Skipped silently: `<title>`, `<desc>`, `<metadata>`, `<style>`, `<defs>`,
comments, editor attributes in their own namespace (`inkscape:*`,
`sodipodi:*`) and `id`. A `<style>` block is useful for previewing the file on
its own; the canvas never sees it. Anything else — `<script>`, `<text>`,
`<image>`, `<use>`, `<foreignObject>`, event handlers, links — makes the
symbol fail to load.

## Pins

A pin is a `<circle>` carrying `data-pin`, placed at the **end of its lead**,
where the wire attaches:

```svg
<circle data-pin="collector" data-alias="c" data-dir="up" cx="16" cy="-32" r="2"/>
```

| attribute       | meaning                                                         |
|-----------------|-----------------------------------------------------------------|
| `data-pin`      | the port name it binds to                                       |
| `data-dir`      | the way the wire **leaves**: `left`, `right`, `up` or `down`    |
| `data-alias`    | other port names that bind here, space separated                |
| `data-optional` | the symbol still fits a block that has no such port             |

The marker itself is never drawn; it is a dot so the pin is visible in an
editor. Draw the lead as an ordinary line up to it.

### How ports find pins

`FitSymbol` matches a block's ports to the symbol's pins, ignoring case, in
three passes: exact name, then a port ending in `_<pin>` (`led_anode` finds
`anode`), then aliases. The symbol is used only if every port finds a pin and
every non-optional pin is used; otherwise the block is drawn as a box with the
symbol as its header icon. A symbol with no pins at all is only ever such a
header icon.

## Checking a symbol

`go test ./internal/hvr -run Symbol` parses every built-in symbol. Opening the
file in a browser shows the drawing with its pins as red dots.

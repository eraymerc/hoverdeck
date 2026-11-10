/**
 * Schematic symbols.
 *
 * The drawings live in internal/hvr/symbols/*.svg, Elektuur style, and reach
 * the page through the catalog already sanitised: the Go side parses each file
 * against a whitelist and re-serialises it, so the markup here is only ever
 * shapes with numeric geometry and one of three classes. See the README there
 * for the format.
 *
 * A symbol is used two ways:
 *   - on the canvas, at full size, with wires attached to its pins
 *     (canvas.ts), when it fits the block's ports;
 *   - as a small glyph — the palette, the inspector, the header of a block
 *     drawn as a box — through iconSvg below.
 */

import type { SymbolDef } from './types';

let SYMBOLS = new Map<string, SymbolDef>();

/** Installs the symbol set the backend sent with the catalog. */
export function setSymbols(list: SymbolDef[] | null | undefined) {
  if (!list || list.length === 0) return; // keep what we had rather than blank every icon
  SYMBOLS = new Map(list.map((s) => [s.id, s]));
}

export function symbolOf(id: string): SymbolDef | undefined {
  return SYMBOLS.get(id);
}

/**
 * Every symbol id, for the picker: pin-anchored symbols first, then the
 * header-only glyphs, each group by name.
 */
export function iconIds(): string[] {
  const anchored = (s: SymbolDef) => (s.pins?.length ?? 0) > 0;
  return [...SYMBOLS.values()]
    .sort((a, b) => Number(anchored(b)) - Number(anchored(a)) || a.id.localeCompare(b.id))
    .map((s) => s.id);
}

/**
 * The drawing of a symbol in its own coordinates. Parts tied to an optional
 * pin are drawn only when that pin is in `connected`; pass null to leave all
 * of them out, which is what a small glyph wants.
 */
export function symbolBody(sym: SymbolDef, connected: Set<string> | null): string {
  return (sym.parts ?? [])
    // ifPin may list several names: the part is drawn when any is connected.
    .filter((p) => !p.ifPin || p.ifPin.split(/\s+/).some((name) => connected?.has(name) ?? false))
    .map((p) => p.markup)
    .join('');
}

/** Before the catalog arrives, and for an id nothing defines. */
const FALLBACK =
  `<rect x="6" y="5" width="36" height="18"/>` +
  `<path d="M6 11 H0 M6 17 H0 M42 11 H48 M42 17 H48"/>`;

const ICON_W = 48;
const ICON_H = 28;
/** Line weight a glyph should have on screen, whatever it was scaled by. */
const ICON_STROKE = 1.5;

/**
 * Renders a symbol as a small <svg> glyph, 48x28 by default.
 *
 * A tall symbol — the passives and sources stand upright on the canvas, as in
 * the reference library — is turned on its side here so a row of palette
 * entries reads left to right. That turn is presentation only; the canvas
 * draws the symbol as it is.
 */
export function iconSvg(id: string, cls = ''): string {
  const sym = SYMBOLS.get(id) ?? SYMBOLS.get('structural');
  if (!sym) {
    return `<svg class="sym ${cls}" viewBox="0 0 ${ICON_W} ${ICON_H}" width="${ICON_W}" height="${ICON_H}" ` +
      `style="--sw:${ICON_STROKE}">${FALLBACK}</svg>`;
  }

  let [x, y, w, h] = sym.viewBox;
  let body = symbolBody(sym, null);
  if (h > w * 1.25) {
    // rotate(-90) sends (x, y) to (y, -x): the top pin ends up on the left.
    body = `<g transform="rotate(-90)">${body}</g>`;
    [x, y, w, h] = [y, -(x + w), h, w];
  }

  // The stroke scales with the viewBox, so undo that to keep lines legible.
  const scale = Math.min(ICON_W / w, ICON_H / h);
  const sw = +(ICON_STROKE / scale).toFixed(3);
  return `<svg class="sym ${cls}" viewBox="${x} ${y} ${w} ${h}" width="${ICON_W}" height="${ICON_H}" ` +
    `style="--sw:${sw}"><title>${esc(sym.title)}</title>${body}</svg>`;
}

/**
 * The ground symbol drawn at every pin on net `gnd`: the Elektuur bar — a
 * short stem into a solid plate.
 *
 * Ground is rendered as a local terminal at each pin rather than as a routed
 * net. In a circuit of any size gnd touches most blocks, so routing it would
 * bury the diagram in lines that carry no information — real schematics use
 * the same convention for the same reason.
 */
export function groundSymbol(
  x: number,
  y: number,
  dir: 'left' | 'right' | 'up' | 'down',
): string {
  // Drawn once pointing right, then turned to face the way the pin leaves.
  const angle = { right: 0, down: 90, left: 180, up: 270 }[dir];
  const shape =
    `<path d="M0 0 H13.6"/>` +
    `<rect class="gnd-bar" x="13.6" y="-12" width="4.8" height="24"/>`;
  return `<g class="gnd-sym" transform="translate(${x} ${y}) rotate(${angle})">${shape}</g>`;
}

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

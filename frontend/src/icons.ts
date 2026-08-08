/**
 * Schematic symbols, drawn as stroke-based SVG in a 48x28 box.
 *
 * These are deliberately conventional: a Hover user reading the canvas should
 * recognise a resistor or a BJT from the same shape they'd see in any
 * schematic, rather than having to learn a hoverdeck-specific glyph.
 */

const W = 48;
const H = 28;
const CY = H / 2;

/** Leads running to the left and right edges, stopping at x1/x2. */
function leads(x1: number, x2: number): string {
  return `<path d="M0 ${CY} H${x1} M${x2} ${CY} H${W}"/>`;
}

const SYMBOLS: Record<string, string> = {
  // ── Passives ──────────────────────────────────────────────────────────────
  resistor:
    leads(10, 38) +
    `<path d="M10 ${CY} l3 -7 l5 14 l5 -14 l5 14 l5 -14 l3 7"/>`,

  capacitor:
    leads(21, 27) +
    `<path d="M21 4 V24 M27 4 V24"/>`,

  inductor:
    leads(8, 40) +
    `<path d="M8 ${CY} a4 4 0 0 1 8 0 a4 4 0 0 1 8 0 a4 4 0 0 1 8 0 a4 4 0 0 1 8 0"/>`,

  // ── Sources ───────────────────────────────────────────────────────────────
  vsource:
    leads(12, 36) +
    `<circle cx="24" cy="${CY}" r="12"/>` +
    `<path d="M18 10 h6 M21 7 v6 M18 19 h6"/>`,

  isource:
    leads(12, 36) +
    `<circle cx="24" cy="${CY}" r="12"/>` +
    `<path d="M24 21 V7 M20 11 l4 -4 l4 4"/>`,

  // Controlled sources use the diamond outline, as in SPICE documentation.
  vcvs:
    leads(12, 36) +
    `<path d="M24 2 L36 ${CY} L24 26 L12 ${CY} Z"/>` +
    `<path d="M19 10 h5 M21.5 7.5 v5 M19 19 h5"/>`,

  vccs:
    leads(12, 36) +
    `<path d="M24 2 L36 ${CY} L24 26 L12 ${CY} Z"/>` +
    `<path d="M24 21 V8 M20.5 11.5 l3.5 -3.5 l3.5 3.5"/>`,

  ccvs:
    leads(12, 36) +
    `<path d="M24 2 L36 ${CY} L24 26 L12 ${CY} Z"/>` +
    `<path d="M19 10 h5 M21.5 7.5 v5 M19 19 h5"/>` +
    `<path d="M14 24 l6 -6" stroke-dasharray="2 2"/>`,

  cccs:
    leads(12, 36) +
    `<path d="M24 2 L36 ${CY} L24 26 L12 ${CY} Z"/>` +
    `<path d="M24 21 V8 M20.5 11.5 l3.5 -3.5 l3.5 3.5"/>` +
    `<path d="M14 24 l6 -6" stroke-dasharray="2 2"/>`,

  // ── Semiconductors ────────────────────────────────────────────────────────
  diode:
    leads(16, 32) +
    `<path d="M16 6 V22 L32 ${CY} Z" class="fillable"/>` +
    `<path d="M32 6 V22"/>`,

  led:
    leads(16, 32) +
    `<path d="M16 6 V22 L32 ${CY} Z" class="fillable"/>` +
    `<path d="M32 6 V22"/>` +
    `<path d="M34 10 l6 -6 M37 4 h3 v3" />` +
    `<path d="M38 16 l6 -6 M41 10 h3 v3" />`,

  // NPN: emitter arrow points away from the base.
  npn:
    `<path d="M0 ${CY} H14"/>` +
    `<path d="M14 4 V24"/>` +
    `<path d="M14 10 L30 4 M14 18 L30 24"/>` +
    `<path d="M30 4 V0 M30 24 V28"/>` +
    `<path d="M24 20.5 l6 3.5 l-2.5 -5.5" class="fillable"/>`,

  // PNP: emitter arrow points toward the base.
  pnp:
    `<path d="M0 ${CY} H14"/>` +
    `<path d="M14 4 V24"/>` +
    `<path d="M14 10 L30 4 M14 18 L30 24"/>` +
    `<path d="M30 4 V0 M30 24 V28"/>` +
    `<path d="M14 18 l6.5 0.5 l-4 4" class="fillable"/>`,

  // ── Composite blocks ──────────────────────────────────────────────────────
  motor:
    leads(12, 36) +
    `<circle cx="24" cy="${CY}" r="12"/>` +
    `<path d="M18 19 V9 l6 10 l6 -10 v10"/>`,

  opamp:
    `<path d="M0 8 H12 M0 20 H12 M36 ${CY} H48"/>` +
    `<path d="M12 2 L36 ${CY} L12 26 Z"/>` +
    `<path d="M15 8 h4 M17 6 v4"/>` +
    `<path d="M15 20 h4"/>`,

  filter:
    `<path d="M0 ${CY} H8 M40 ${CY} H48"/>` +
    `<rect x="8" y="6" width="32" height="16"/>` +
    `<path d="M12 20 C20 20 20 10 28 10 L36 10"/>`,

  // ── Domain fallbacks ──────────────────────────────────────────────────────
  analog:
    `<path d="M0 ${CY} H8 M40 ${CY} H48"/>` +
    `<rect x="8" y="5" width="32" height="18"/>` +
    `<path d="M13 ${CY} c4 -8 8 8 12 0 c4 -8 8 8 10 0"/>`,

  digital:
    `<path d="M0 ${CY} H8 M40 ${CY} H48"/>` +
    `<rect x="8" y="5" width="32" height="18"/>` +
    `<path d="M13 19 v-5 h6 v-5 h6 v10 h6 v-5"/>`,

  structural:
    `<rect x="6" y="5" width="36" height="18"/>` +
    `<path d="M6 11 H0 M6 17 H0 M42 11 H48 M42 17 H48"/>`,
};

/** Every icon id available for the picker. */
export const ICON_IDS = Object.keys(SYMBOLS);

/**
 * Renders one symbol as an <svg> element sized to fit a block header.
 */
export function iconSvg(id: string, cls = ''): string {
  const body = SYMBOLS[id] ?? SYMBOLS.structural;
  return `<svg class="sym ${cls}" viewBox="0 0 ${W} ${H}" width="48" height="28"
     fill="none" stroke="currentColor" stroke-width="1.8"
     stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

/**
 * The ground symbol drawn at every net named `gnd`.
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
  // The symbol is drawn once pointing right, then rotated to face the pin's
  // direction, so all four orientations stay identical in shape.
  const angle = { right: 0, down: 90, left: 180, up: 270 }[dir];
  const bars =
    `<path d="M0 0 H14"/>` +
    `<path d="M14 -6 V6"/>` +
    `<path d="M18 -3.5 V3.5"/>` +
    `<path d="M22 -1.5 V1.5"/>`;
  return `<g class="gnd-sym" transform="translate(${x} ${y}) rotate(${angle})">${bars}</g>`;
}

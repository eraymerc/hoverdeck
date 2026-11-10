/**
 * Where a symbol's logic ports go — the points its logic-signal links attach
 * to — in three layers:
 *
 *  1. Places the symbol file names for them (`data-logic`): a source's
 *     control input on its circle, a motor's measured outputs on its rail.
 *     Matched by port name, then in order.
 *  2. Otherwise the symbol's free sides — the ones no pin leaves from —
 *     inputs preferring left, then top, bottom, right; outputs right, then
 *     bottom, top, left. Each side takes as many as fit a grid pitch apart.
 *  3. When that runs out, a port rail: the row on the first suitable side
 *     simply carries on past the end of the symbol, along a short line that
 *     shows the ports still belong to it.
 *
 * Everything is in the symbol's own coordinates, so the ports turn and mirror
 * with the symbol the same way its pins do. Pure — no DOM — and tested in
 * ports.test.ts.
 */

/** The way a link leaves a port — the same as a pin's direction in wires.ts. */
export type Dir = 'left' | 'right' | 'up' | 'down';

/** One logic argument that carries a signal, and so needs a place. */
export interface LogicArg {
  /** Its index among the block's logic arguments. */
  arg: number;
  /** The declared port name, or '' where there is none (primitives). */
  name: string;
  flow: 'in' | 'out';
}

/** A place the symbol file gives for a logic port. */
export interface LogicSlot {
  name: string;
  aliases: string[] | null;
  flow: 'in' | 'out';
  x: number;
  y: number;
  dir: Dir;
}

export interface PortPlace {
  arg: number;
  x: number;
  y: number;
  /** The way the link leaves the port. */
  dir: Dir;
}

export interface Placement {
  ports: PortPlace[];
  /** Lines to draw for port rails, [x1, y1, x2, y2]. */
  rails: [number, number, number, number][];
  /** Names of the symbol's own logic places in use, for data-if-pin. */
  slots: string[];
}

/** Distance between neighbouring ports on a side. */
export const PORT_PITCH = 16;
/** How far a rail stands off a side that pins already use. */
export const RAIL_OFFSET = 16;

const SIDES: Dir[] = ['left', 'right', 'up', 'down'];
const PREFER: Record<'in' | 'out', Dir[]> = {
  in: ['left', 'up', 'down', 'right'],
  out: ['right', 'down', 'up', 'left'],
};

const snap8 = (v: number) => Math.round(v / 8) * 8;

/** A side of the viewBox: the line it lies on, and its extent along it. */
function side(vb: [number, number, number, number], d: Dir) {
  const [x, y, w, h] = vb;
  switch (d) {
    case 'left': return { horizontal: false, at: x, from: y, to: y + h };
    case 'right': return { horizontal: false, at: x + w, from: y, to: y + h };
    case 'up': return { horizontal: true, at: y, from: x, to: x + w };
    default: return { horizontal: true, at: y + h, from: x, to: x + w };
  }
}

/** How many ports fit along a side, a pitch apart and half a pitch in from each end. */
function capacity(vb: [number, number, number, number], d: Dir): number {
  const s = side(vb, d);
  const len = s.to - s.from - PORT_PITCH;
  return len < 0 ? 0 : Math.floor(len / PORT_PITCH) + 1;
}

/** n positions along a side, centred on it, a pitch apart, on the 8px grid. */
function row(vb: [number, number, number, number], d: Dir, n: number): number[] {
  const s = side(vb, d);
  const mid = (s.from + s.to) / 2;
  return Array.from({ length: n }, (_, i) => snap8(mid + (i - (n - 1) / 2) * PORT_PITCH));
}

export function placeOnSymbol(
  viewBox: [number, number, number, number],
  pinDirs: Dir[],
  slots: LogicSlot[],
  args: LogicArg[],
): Placement {
  const out: Placement = { ports: [], rails: [], slots: [] };
  const used = new Set<number>();
  const placed = new Set<number>();

  // 1. The symbol's own places: by name, by suffix ("led_omega" finds
  // "omega"), by alias — then whatever is left, in order, by flow.
  const take = (a: LogicArg, j: number) => {
    const sl = slots[j];
    used.add(j);
    placed.add(a.arg);
    out.ports.push({ arg: a.arg, x: sl.x, y: sl.y, dir: sl.dir });
    if (sl.name) out.slots.push(sl.name);
  };
  const passes: ((port: string, sl: LogicSlot) => boolean)[] = [
    (p, sl) => !!sl.name && p === sl.name.toLowerCase(),
    (p, sl) => !!sl.name && p.endsWith('_' + sl.name.toLowerCase()),
    (p, sl) => (sl.aliases ?? []).some((al) => p === al.toLowerCase()),
  ];
  for (const match of passes) {
    for (const a of args) {
      if (placed.has(a.arg) || !a.name) continue;
      const j = slots.findIndex((sl, k) => !used.has(k) && sl.flow === a.flow && match(a.name.toLowerCase(), sl));
      if (j >= 0) take(a, j);
    }
  }
  for (const a of args) {
    if (placed.has(a.arg)) continue;
    const j = slots.findIndex((sl, k) => !used.has(k) && sl.flow === a.flow);
    if (j >= 0) take(a, j);
  }

  // 2. Free sides: no pin leaves from them, and the symbol put none of its
  // own logic places there.
  const busy = new Set<Dir>([...pinDirs, ...[...used].map((j) => slots[j].dir)]);
  const free = SIDES.filter((d) => !busy.has(d));
  const onSide = new Map<Dir, LogicArg[]>();
  const overflow: LogicArg[] = [];
  for (const a of args) {
    if (placed.has(a.arg)) continue;
    const d = PREFER[a.flow].find((s) => free.includes(s) && (onSide.get(s)?.length ?? 0) < capacity(viewBox, s));
    if (d) onSide.set(d, [...(onSide.get(d) ?? []), a]);
    else overflow.push(a);
  }

  // 3. The rail: what did not fit joins the row on the first free side its
  // flow prefers, and that row runs on past the symbol. With no free side
  // at all, the row stands off the preferred one, clear of its pins.
  let railSide: Dir | null = null;
  let offset = 0;
  if (overflow.length) {
    const flow = overflow[0].flow;
    railSide = PREFER[flow].find((s) => free.includes(s)) ?? PREFER[flow][0];
    offset = free.includes(railSide) ? 0 : RAIL_OFFSET;
    onSide.set(railSide, [...(onSide.get(railSide) ?? []), ...overflow]);
  }

  for (const [d, list] of onSide) {
    // Keep each side in port order, so links do not cross on the way in.
    list.sort((p, q) => p.arg - q.arg);
    const s = side(viewBox, d);
    const out1 = d === 'left' || d === 'up' ? -1 : 1;
    const line = s.at + (d === railSide ? offset * out1 : 0);
    const pos = row(viewBox, d, list.length);
    list.forEach((a, i) => {
      const [x, y] = s.horizontal ? [pos[i], line] : [line, pos[i]];
      out.ports.push({ arg: a.arg, x, y, dir: d });
    });
    if (d === railSide) {
      const lo = Math.min(...pos), hi = Math.max(...pos);
      // The rail spans the row; standing off, a stem joins it to the symbol.
      out.rails.push(s.horizontal ? [lo, line, hi, line] : [line, lo, line, hi]);
      if (offset) {
        const mid = snap8((s.from + s.to) / 2);
        out.rails.push(s.horizontal ? [mid, s.at, mid, line] : [s.at, mid, line, mid]);
      }
    }
  }
  out.ports.sort((p, q) => p.arg - q.arg);
  return out;
}

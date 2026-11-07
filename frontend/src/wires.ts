/**
 * Wire geometry for the schematic canvas.
 *
 * A net is drawn as a set of horizontal and vertical segments that together
 * connect its pins. Until someone edits it the set is computed (autoRoute);
 * the first edit freezes the whole net and the set is saved in the sidecar
 * from then on (Layout.Wires on the Go side, which only validates and
 * stores it).
 *
 * Dragging a block or a signal chip stretches the edited wires on it, the way
 * a schematic editor does (dragEnd): the segment at the pin moves with it and
 * the wire beyond stretches to meet it, keeping its shape.
 *
 * A frozen drawing is also checked against the pins every time it is drawn
 * (reconcile): ends that no longer reach a pin are pruned back to the rest of
 * the wire, and pins that are not on it — a port added in the source, a block
 * rotated — get a fresh branch to the nearest segment.
 *
 * Editing is three operations: move a segment perpendicular to itself, move
 * a corner, and split or merge at a point. Each keeps the drawing connected.
 *
 * Everything here is pure — segments in, segments out, no DOM — so that it can
 * be tested on its own (wires.test.ts, `npm test`). Runtime imports are kept
 * to none so the tests run under plain `node --test`.
 */

/** One straight piece: x1, y1, x2, y2. Always horizontal or vertical. */
export type Seg = [number, number, number, number];
export type Pt = [number, number];
export type Dir = 'left' | 'right' | 'up' | 'down';

/** A pin as the router sees it. */
export interface Terminal {
  x: number;
  y: number;
  /** The way a wire leaves the pin. */
  dir: Dir;
  /** The block the pin is on; running away from it is never an obstacle. */
  blockId: string;
  /** That block's bounding box, to route around it rather than over it. */
  box: { x: number; y: number; w: number; h: number } | null;
}

/** Whether a vertical run at x from y1 to y2 avoids every block but `own`. */
export type ColumnClear = (x: number, y1: number, y2: number, own: string) => boolean;

/** Length of the straight lead-out from a pin before a wire may turn. */
export const STUB = 16;
/** Wires snap to this when edited; the symbol pin pitch is a multiple. */
export const SNAP = 8;

export function snap(v: number): number {
  return Math.round(v / SNAP) * SNAP;
}

export function stubVec(dir: Dir): Pt {
  switch (dir) {
    case 'left': return [-1, 0];
    case 'right': return [1, 0];
    case 'up': return [0, -1];
    default: return [0, 1];
  }
}

export function stubEnd(t: Terminal): Pt {
  const [vx, vy] = stubVec(t.dir);
  return [t.x + vx * STUB, t.y + vy * STUB];
}

const vertical = (d: Dir) => d === 'up' || d === 'down';
const ptKey = (x: number, y: number) => `${x},${y}`;
const isH = (s: Seg) => s[1] === s[3];
const len = (s: Seg) => Math.abs(s[2] - s[0]) + Math.abs(s[3] - s[1]);
const ends = (s: Seg): [Pt, Pt] => [[s[0], s[1]], [s[2], s[3]]];
const samePt = (a: Pt, b: Pt) => a[0] === b[0] && a[1] === b[1];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The segment with its smaller end first. */
function canon(s: Seg): Seg {
  const [x1, y1, x2, y2] = s;
  return x1 < x2 || (x1 === x2 && y1 <= y2) ? [x1, y1, x2, y2] : [x2, y2, x1, y1];
}

// ── Normal form ──────────────────────────────────────────────────────────────

/**
 * The canonical form every operation returns: no zero-length or diagonal
 * segments, overlapping runs on one line merged, and every segment split
 * wherever another one ends on it (a T) or a `keep` point — a pin — lies on
 * it. After this, wires only ever meet at segment ends, which is what makes
 * junctions and dragging simple. Segments that merely touch end to end on one
 * line stay separate: that is how a split point made by double-clicking
 * survives until it is used. Sorted, so equal drawings compare equal.
 */
export function normalize(segs: Seg[], keep: Pt[] = []): Seg[] {
  const rows = new Map<number, [number, number][]>(); // y -> x intervals
  const cols = new Map<number, [number, number][]>(); // x -> y intervals
  const add = (m: Map<number, [number, number][]>, k: number, iv: [number, number]) => {
    const l = m.get(k);
    if (l) l.push(iv); else m.set(k, [iv]);
  };
  for (const raw of segs) {
    const s = canon(raw);
    if (s[0] === s[2] && s[1] === s[3]) continue;
    if (s[1] === s[3]) add(rows, s[1], [s[0], s[2]]);
    else if (s[0] === s[2]) add(cols, s[0], [s[1], s[3]]);
  }

  // Merge runs that share length; runs that only touch stay apart.
  const merge = (ivs: [number, number][]) => {
    const v = [...ivs].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const out: [number, number][] = [];
    for (const iv of v) {
      const last = out[out.length - 1];
      if (last && iv[0] < last[1]) last[1] = Math.max(last[1], iv[1]);
      else if (last && iv[0] === last[0] && iv[1] === last[1]) continue;
      else out.push([iv[0], iv[1]]);
    }
    return out;
  };

  // A horizontal run is cut where a vertical one ends on it (a T) and at
  // pins, and vice versa. Not at the ends of runs it was merged with on the
  // same line: those points join nothing, and would only leave a bend handle
  // on a straight wire.
  const rowCuts: Pt[] = [...keep];
  const colCuts: Pt[] = [...keep];
  cols.forEach((ivs, x) => ivs.forEach(([a, b]) => rowCuts.push([x, a], [x, b])));
  rows.forEach((ivs, y) => ivs.forEach(([a, b]) => colCuts.push([a, y], [b, y])));

  const out: Seg[] = [];
  rows.forEach((ivs, y) => {
    for (const [a, b] of merge(ivs)) {
      const xs = [...new Set(rowCuts.filter(([px, py]) => py === y && px > a && px < b).map((p) => p[0]))].sort((p, q) => p - q);
      let from = a;
      for (const x of [...xs, b]) { out.push([from, y, x, y]); from = x; }
    }
  });
  cols.forEach((ivs, x) => {
    for (const [a, b] of merge(ivs)) {
      const ys = [...new Set(colCuts.filter(([px, py]) => px === x && py > a && py < b).map((p) => p[1]))].sort((p, q) => p - q);
      let from = a;
      for (const y of [...ys, b]) { out.push([x, from, x, y]); from = y; }
    }
  });
  return out.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2] || p[3] - q[3]);
}

/**
 * Joins runs that meet end to end on one line at a point nothing else needs —
 * no other wire, no pin. The router builds every leg from a stub and a
 * continuation, and without this each join would be a "bend" handle in the
 * middle of a straight wire. Not applied to a drawing someone has edited:
 * there, such a point is a split they made on purpose.
 */
export function simplify(segs: Seg[], keep: Pt[] = []): Seg[] {
  const keepKeys = new Set(keep.map(([x, y]) => ptKey(x, y)));
  let cur = normalize(segs, keep);
  for (;;) {
    const inc = incidence(cur);
    let joined = false;
    for (const [k, idx] of inc) {
      if (idx.length !== 2 || keepKeys.has(k)) continue;
      const [a, b] = idx;
      if (isH(cur[a]) !== isH(cur[b])) continue;
      const [x, y] = k.split(',').map(Number);
      const far = (q: Seg): Pt => (q[0] === x && q[1] === y ? [q[2], q[3]] : [q[0], q[1]]);
      const fa = far(cur[a]), fb = far(cur[b]);
      cur = normalize([...cur.filter((_, j) => j !== a && j !== b), [fa[0], fa[1], fb[0], fb[1]]], keep);
      joined = true;
      break;
    }
    if (!joined) return cur;
  }
}

/** Segment indices by the point they end at. */
function incidence(segs: Seg[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  segs.forEach((s, i) => {
    for (const [x, y] of ends(s)) {
      const k = ptKey(x, y);
      const l = m.get(k);
      if (l) l.push(i); else m.set(k, [i]);
    }
  });
  return m;
}

export function sameDrawing(a: Seg[], b: Seg[]): boolean {
  const na = normalize(a), nb = normalize(b);
  return na.length === nb.length && na.every((s, i) => s.every((v, j) => v === nb[i][j]));
}

/**
 * Where to draw junction dots: every point three or more wires meet at,
 * counting a pin as one of them.
 */
export function junctions(segs: Seg[], pins: Pt[]): Pt[] {
  const pinKeys = new Set(pins.map(([x, y]) => ptKey(x, y)));
  const out: Pt[] = [];
  incidence(segs).forEach((idx, k) => {
    if (idx.length + (pinKeys.has(k) ? 1 : 0) >= 3) {
      const [x, y] = k.split(',').map(Number);
      out.push([x, y]);
    }
  });
  return out;
}

/** Points where exactly two segments meet and no pin is: the draggable bends. */
export function bends(segs: Seg[], pins: Pt[]): Pt[] {
  const pinKeys = new Set(pins.map(([x, y]) => ptKey(x, y)));
  const out: Pt[] = [];
  incidence(segs).forEach((idx, k) => {
    if (idx.length === 2 && !pinKeys.has(k)) {
      const [x, y] = k.split(',').map(Number);
      out.push([x, y]);
    }
  });
  return out;
}

/**
 * Where the net's label goes: the top-most, then left-most, point of the
 * wire itself — a bend or junction rather than a pin, since a pin's
 * neighbourhood already holds the symbol's own reference and value.
 */
export function labelAnchor(segs: Seg[], pins: Pt[] = []): Pt | null {
  const pinKeys = new Set(pins.map(([x, y]) => ptKey(x, y)));
  let best: Pt | null = null, bestIsPin = true;
  for (const s of segs) {
    for (const p of ends(s)) {
      const isPin = pinKeys.has(ptKey(p[0], p[1]));
      const better = !best || (bestIsPin && !isPin) ||
        (isPin === bestIsPin && (p[1] < best[1] || (p[1] === best[1] && p[0] < best[0])));
      if (better) { best = p; bestIsPin = isPin; }
    }
  }
  return best;
}

// ── Automatic routing ────────────────────────────────────────────────────────

/**
 * The x an automatic channel goes at: the median of the stub ends, which
 * minimises the total length of the horizontal runs to it. With an odd count
 * that is one pin's own column, so pins already lined up on it connect with
 * no horizontal run at all. With two pins it is the midpoint.
 */
export function channelX(xs: number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return snap(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2);
}

/**
 * Joint heights for the legs that may run on — vertical pins — or undefined
 * for "turn at the end of the stub". A downward pin may run on down, an
 * upward one on up, and both stop as soon as they reach the others:
 *
 *  - When some legs are fixed (side pins), a vertical leg extends to the
 *    nearer edge of their span, if that span lies ahead of it.
 *  - When all are vertical, they meet on one line if one exists — the lowest
 *    downward stub when any pin points down, else the highest upward one — so
 *    resistors hanging off a node share a single bus instead of a channel
 *    with a separate jog per resistor. If a downward pin sits below an upward
 *    one there is no such line, and nothing changes.
 */
export function meetingYs(stubs: { y: number; dir: Dir }[], flexible: boolean[], fixedYs: number[]): (number | undefined)[] {
  const out: (number | undefined)[] = stubs.map(() => undefined);
  if (fixedYs.length) {
    const top = Math.min(...fixedYs), bottom = Math.max(...fixedYs);
    stubs.forEach((s, i) => {
      if (!flexible[i]) return;
      if (s.dir === 'down' && s.y < top) out[i] = top;
      if (s.dir === 'up' && s.y > bottom) out[i] = bottom;
    });
    return out;
  }
  const downs = stubs.filter((s, i) => flexible[i] && s.dir === 'down').map((s) => s.y);
  const ups = stubs.filter((s, i) => flexible[i] && s.dir === 'up').map((s) => s.y);
  const lo = downs.length ? Math.max(...downs) : -Infinity;
  const hi = ups.length ? Math.min(...ups) : Infinity;
  if (lo > hi) return out;
  const line = downs.length ? lo : hi;
  stubs.forEach((_, i) => { if (flexible[i]) out[i] = line; });
  return out;
}

/**
 * The automatic drawing of a net: one vertical channel, and from each pin a
 * leg out along its stub and across to it. A side pin whose channel lies
 * behind it goes around its block rather than back over it; a vertical pin
 * runs on to meet the others when its column is clear (see meetingYs).
 */
export function autoRoute(terms: Terminal[], clear: ColumnClear): Seg[] {
  if (terms.length === 0) return [];
  const pins = terms.map((t) => [t.x, t.y] as Pt);
  if (terms.length === 1) {
    const [ex, ey] = stubEnd(terms[0]);
    return simplify([[terms[0].x, terms[0].y, ex, ey]], pins);
  }

  const stubs = terms.map((t) => { const [x, y] = stubEnd(t); return { t, x, y }; });
  const flexible = stubs.map((s) => vertical(s.t.dir));
  const fixedYs = stubs.filter((_, i) => !flexible[i]).map((s) => s.t.y);
  const meet = meetingYs(stubs.map((s) => ({ y: s.y, dir: s.t.dir })), flexible, fixedYs)
    .map((y, i) => (y !== undefined && clear(stubs[i].x, stubs[i].y, y, stubs[i].t.blockId) ? y : undefined));

  // The legs and the channel, for a channel at x. Built twice when the
  // first choice runs through a block: whether a side pin goes straight or
  // around its block depends on which side of it the channel is.
  const build = (trunkX: number) => {
    const segs: Seg[] = [];
    const joins: number[] = [];
    stubs.forEach((s, i) => {
      const t = s.t;
      if (!vertical(t.dir)) {
        const doublesBack = (t.dir === 'right' && trunkX < s.x) || (t.dir === 'left' && trunkX > s.x);
        if (!doublesBack) {
          segs.push([t.x, t.y, trunkX, t.y]);
          joins.push(t.y);
          return;
        }
        const b = t.box;
        const above = b ? t.y < b.y + b.h / 2 : true;
        const dy = snap(b ? (above ? b.y - 14 : b.y + b.h + 14) : t.y - 14);
        segs.push([t.x, t.y, s.x, t.y], [s.x, t.y, s.x, dy], [s.x, dy, trunkX, dy]);
        joins.push(dy);
        return;
      }
      const jy = meet[i] ?? s.y;
      segs.push([t.x, t.y, s.x, s.y], [s.x, s.y, s.x, jy], [s.x, jy, trunkX, jy]);
      joins.push(jy);
    });
    const top = Math.min(...joins), bottom = Math.max(...joins);
    segs.push([trunkX, top, trunkX, bottom]);
    return { segs, top, bottom };
  };

  const first = channelX(stubs.map((s) => s.x));
  let route = build(first);
  const moved = clearChannel(first, route.top, route.bottom, clear);
  if (moved !== first) route = build(moved);
  return simplify(route.segs, pins);
}

/**
 * The channel's x, moved off any block it would run through: the nearest
 * column, a grid step at a time either side, that is clear from top to
 * bottom. Unchanged when it is already clear, has no length, or no clear
 * column is near enough to be worth the detour.
 */
function clearChannel(x: number, top: number, bottom: number, clear: ColumnClear): number {
  if (top === bottom || clear(x, top, bottom, '')) return x;
  for (let k = 1; k <= 24; k++) {
    for (const c of [x + k * STUB, x - k * STUB]) {
      if (clear(c, top, bottom, '')) return c;
    }
  }
  return x;
}

// ── Reconciling a frozen drawing with the pins ───────────────────────────────

/**
 * A frozen drawing brought up to date with where the pins are now: ends that
 * reach no pin are pruned back to the rest of the wire, and every pin not on
 * the wire gets a new branch to the nearest segment. When that cannot give one
 * connected drawing, the net is routed automatically instead.
 */
export function reconcile(segs: Seg[], terms: Terminal[], clear: ColumnClear): Seg[] {
  const pins = terms.map((t) => [t.x, t.y] as Pt);
  const pinKeys = new Set(pins.map(([x, y]) => ptKey(x, y)));
  let cur = normalize(segs, pins);

  // Prune: a segment with a free end that is not a pin is a branch to
  // something that is no longer there. Repeat until none is left.
  for (;;) {
    const inc = incidence(cur);
    const dead = new Set<number>();
    cur.forEach((s, i) => {
      for (const [x, y] of ends(s)) {
        const k = ptKey(x, y);
        if (inc.get(k)!.length === 1 && !pinKeys.has(k)) dead.add(i);
      }
    });
    if (dead.size === 0) break;
    cur = cur.filter((_, i) => !dead.has(i));
  }
  if (cur.length === 0) return autoRoute(terms, clear);

  // Attach: a pin that is no segment's end gets a branch.
  for (const t of terms) {
    if (incidence(cur).has(ptKey(t.x, t.y))) continue;
    cur = normalize([...cur, ...simplify(branchTo(t, cur), pins)], pins);
  }
  return connected(cur, pins) ? cur : autoRoute(terms, clear);
}

/**
 * A branch from a pin to the nearest point of a drawing: out along the stub,
 * then one turn. A vertical pin goes vertical first, a side pin across, so the
 * branch leaves the pin the way the symbol meant it to.
 */
function branchTo(t: Terminal, segs: Seg[]): Seg[] {
  const [sx, sy] = stubEnd(t);
  let best: { q: Pt; d: number } | null = null;
  for (const raw of segs) {
    const s = canon(raw);
    const q: Pt = isH(s) ? [clamp(sx, s[0], s[2]), s[1]] : [s[0], clamp(sy, s[1], s[3])];
    const d = Math.abs(sx - q[0]) + Math.abs(sy - q[1]);
    if (!best || d < best.d) best = { q, d };
  }
  const [qx, qy] = best!.q;
  const out: Seg[] = [[t.x, t.y, sx, sy]];
  if (vertical(t.dir)) out.push([sx, sy, sx, qy], [sx, qy, qx, qy]);
  else out.push([sx, sy, qx, sy], [qx, sy, qx, qy]);
  return out;
}

/** Whether all the segments, and every pin, are one piece. */
export function connected(segs: Seg[], pins: Pt[]): boolean {
  if (segs.length === 0) return pins.length <= 1;
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  const node = (k: string) => { if (!parent.has(k)) parent.set(k, k); return k; };
  for (const s of segs) {
    const a = find(node(ptKey(s[0], s[1]))), b = find(node(ptKey(s[2], s[3])));
    if (a !== b) parent.set(a, b);
  }
  const roots = new Set([...parent.keys()].map(find));
  if (roots.size !== 1) return false;
  return pins.every(([x, y]) => parent.has(ptKey(x, y)));
}

// ── Editing ──────────────────────────────────────────────────────────────────

/**
 * An end of a moved segment, at (px, py) before the move, has moved by
 * (dx, dy). What it was attached to has to follow:
 *
 *  - a pin, or a wire carrying straight on in the same line, cannot move —
 *    a short connector bridges the old point to the new one;
 *  - wires at right angles to it stretch to the new point.
 */
function followEnd(out: Seg[], moved: Set<number>, px: number, py: number, dx: number, dy: number, fixed: Pt[], movedWasH: boolean) {
  if (dx === 0 && dy === 0) return;
  const at = (s: Seg) => ends(s).some((p) => p[0] === px && p[1] === py);
  const nbrs = out.map((_, j) => j).filter((j) => !moved.has(j) && at(out[j]));
  const pinned = fixed.some(([x, y]) => x === px && y === py);
  const straightOn = nbrs.some((j) => isH(out[j]) === movedWasH && len(out[j]) > 0);
  if (pinned || straightOn) {
    out.push([px, py, px + dx, py + dy]);
    return;
  }
  for (const j of nbrs) {
    const s = out[j];
    out[j] = s[0] === px && s[1] === py
      ? [px + dx, py + dy, s[2], s[3]]
      : [s[0], s[1], px + dx, py + dy];
  }
}

/**
 * Moves segment i perpendicular to itself by d.
 *
 * Where the segment leaves a pin, its first STUB of length stays put as the
 * pin's lead-out and only the rest moves, so the new bend forms clear of the
 * symbol rather than right on the end of its lead.
 */
export function moveSegment(segs: Seg[], i: number, d: number, fixed: Pt[]): Seg[] {
  if (!segs[i] || d === 0) return segs;
  let s = segs[i];
  const lead: Seg[] = [];
  for (const end of [0, 1]) {
    const [p, q] = end === 0 ? [[s[0], s[1]], [s[2], s[3]]] : [[s[2], s[3]], [s[0], s[1]]];
    if (!fixed.some((f) => samePt(f, p as Pt)) || len(s) <= STUB) continue;
    const ux = Math.sign(q[0] - p[0]), uy = Math.sign(q[1] - p[1]);
    const cut: Pt = [p[0] + ux * STUB, p[1] + uy * STUB];
    lead.push([p[0], p[1], cut[0], cut[1]]);
    s = end === 0 ? [cut[0], cut[1], s[2], s[3]] : [s[0], s[1], cut[0], cut[1]];
  }
  if (lead.length) {
    segs = [...segs.slice(0, i), s, ...segs.slice(i + 1), ...lead];
  }
  const h = isH(s);
  const [dx, dy] = h ? [0, d] : [d, 0];
  const out = segs.map((x) => [...x] as Seg);
  out[i] = [s[0] + dx, s[1] + dy, s[2] + dx, s[3] + dy];
  const moved = new Set([i]);
  followEnd(out, moved, s[0], s[1], dx, dy, fixed, h);
  followEnd(out, moved, s[2], s[3], dx, dy, fixed, h);
  return normalize(out, fixed);
}

/**
 * A pin at `from` has moved to `to` — its block was dragged — and the wire
 * follows the way a schematic editor's does: it stretches, keeping its
 * shape. The segment leaving the pin moves with it across its own
 * direction, so the bend at its far end slides along and the wire beyond it
 * stretches to meet it; along its own direction it simply gets longer or
 * shorter. Nothing else moves. Where the far end cannot follow — it is a pin
 * itself, or the wire carries straight on through it — a short connector
 * makes up the difference.
 *
 * Null when `from` is not where exactly one segment ends — the wire was not
 * attached there — and the caller falls back to reconcile.
 */
export function dragEnd(segs: Seg[], from: Pt, to: Pt, fixed: Pt[]): Seg[] | null {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  if (dx === 0 && dy === 0) return segs;
  const inc = incidence(segs).get(ptKey(from[0], from[1])) ?? [];
  if (inc.length !== 1) return null;
  const i = inc[0];
  const s = segs[i];
  const h = isH(s);
  const far: Pt = s[0] === from[0] && s[1] === from[1] ? [s[2], s[3]] : [s[0], s[1]];

  // Across: the whole segment shifts, its far end with it.
  const [ax, ay] = h ? [0, dy] : [dx, 0];
  const out = segs.map((x) => [...x] as Seg);
  const nf: Pt = [far[0] + ax, far[1] + ay];
  out[i] = [to[0], to[1], nf[0], nf[1]];
  followEnd(out, new Set([i]), far[0], far[1], ax, ay, fixed, h);
  return normalize(out, [...fixed, to]);
}

/**
 * Moves a bend — a point where one horizontal and one vertical segment meet
 * and nothing else — by (dx, dy). Anything else at that point (a pin, a
 * junction, a straight split point) does not move this way.
 */
export function moveCorner(segs: Seg[], pt: Pt, dx: number, dy: number, fixed: Pt[]): Seg[] {
  if ((dx === 0 && dy === 0) || fixed.some((p) => samePt(p, pt))) return segs;
  const inc = incidence(segs).get(ptKey(pt[0], pt[1])) ?? [];
  if (inc.length !== 2 || isH(segs[inc[0]]) === isH(segs[inc[1]])) return segs;
  const hi = isH(segs[inc[0]]) ? inc[0] : inc[1];
  const vi = hi === inc[0] ? inc[1] : inc[0];
  const far = (s: Seg): Pt => (s[0] === pt[0] && s[1] === pt[1] ? [s[2], s[3]] : [s[0], s[1]]);
  const hf = far(segs[hi]), vf = far(segs[vi]);
  const np: Pt = [pt[0] + dx, pt[1] + dy];

  const out = segs.map((x) => [...x] as Seg);
  out[hi] = [hf[0], hf[1] + dy, np[0], np[1]];
  out[vi] = [vf[0] + dx, vf[1], np[0], np[1]];
  const moved = new Set([hi, vi]);
  followEnd(out, moved, hf[0], hf[1], 0, dy, fixed, true);
  followEnd(out, moved, vf[0], vf[1], dx, 0, fixed, false);
  return normalize(out, fixed);
}

/**
 * Splits segment i at the grid point nearest (x, y), leaving a point that can
 * be bent: drag either half and a step forms there. Nothing happens if that
 * point would be an end of the segment.
 */
export function splitAt(segs: Seg[], i: number, x: number, y: number, fixed: Pt[]): Seg[] {
  const s = segs[i] && canon(segs[i]);
  if (!s) return segs;
  const p: Pt = isH(s) ? [snap(x), s[1]] : [s[0], snap(y)];
  const inside = isH(s) ? p[0] > s[0] && p[0] < s[2] : p[1] > s[1] && p[1] < s[3];
  if (!inside) return segs;
  const out = segs.filter((_, j) => j !== i);
  out.push([s[0], s[1], p[0], p[1]], [p[0], p[1], s[2], s[3]]);
  return normalize(out, fixed);
}

/**
 * Removes the point where two segments meet. A straight split point just
 * goes. A bend is flattened by taking out its shorter side: the longer side
 * moves over by the shorter's length, which leaves the shorter with none.
 */
export function removePoint(segs: Seg[], pt: Pt, fixed: Pt[]): Seg[] {
  if (fixed.some((p) => samePt(p, pt))) return segs;
  const inc = incidence(segs).get(ptKey(pt[0], pt[1])) ?? [];
  if (inc.length !== 2) return segs;
  const [a, b] = inc;
  const far = (s: Seg): Pt => (s[0] === pt[0] && s[1] === pt[1] ? [s[2], s[3]] : [s[0], s[1]]);

  if (isH(segs[a]) === isH(segs[b])) {
    const fa = far(segs[a]), fb = far(segs[b]);
    const out = segs.filter((_, j) => j !== a && j !== b);
    out.push([fa[0], fa[1], fb[0], fb[1]]);
    return normalize(out, fixed);
  }
  const [short, long] = len(segs[a]) <= len(segs[b]) ? [a, b] : [b, a];
  const fs = far(segs[short]);
  const d = isH(segs[long]) ? fs[1] - pt[1] : fs[0] - pt[0];
  return moveSegment(segs, long, d, fixed);
}

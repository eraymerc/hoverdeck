/**
 * The schematic canvas.
 *
 * Renders one Hover module as blocks + nets. Two link kinds are drawn, which
 * is the whole point of the view:
 *
 *   solid  — electrical nets, i.e. the wires in a `[...]` port list
 *   dashed — logic signals, i.e. values passed through a `(...)` logic port
 *
 * Ground is drawn as a local terminal at each pin instead of a routed net,
 * the way a real schematic does it: gnd touches nearly every block, so
 * routing it would bury the diagram in lines carrying no information.
 *
 * A block is drawn one of two ways. When its symbol fits its ports (the
 * backend decides, see hvr.FitSymbol) it is the schematic symbol itself, with
 * wires meeting the ends of its leads. Otherwise it is a box with the pins
 * spread along two edges and the symbol as a small header glyph — every user
 * module without a symbol of its own looks like that.
 */

import { iconSvg, groundSymbol, symbolOf, symbolBody } from './icons';
import type { SafeSheet as Sheet, SafeBlock as Block, Signal, SymbolDef } from './types';

const BLOCK_W = 152;
const BLOCK_MIN_H = 76;
const PIN_SPACING = 20;
// One symbol grid step — the pin pitch of every symbol in
// internal/hvr/symbols. The background dots are drawn at it, so pins land on
// visible dots, and a stub this long from a pin on the grid ends on it.
const GRID = 16;
const PIN_STUB = GRID;
const HEADER_H = 44;

export interface CanvasHandlers {
  onSelectBlock(id: string | null): void;
  onSelectNet(name: string | null): void;
  onSelectSignal(name: string | null): void;
  onOpenBlock(block: Block): void;
  onMoveBlock(id: string, x: number, y: number): void;
  onMoveSignal(name: string, x: number, y: number): void;
  onMoveNetTrunk(net: string, x: number, dy: number): void;
  onMoveLeg(net: string, legKey: string, dy: number): void;
  onDropCatalog(payload: string, x: number, y: number): void;
}

interface Geom {
  block: Block;
  /** Bounding box in world space — the box, or the symbol as oriented. */
  x: number;
  y: number;
  w: number;
  h: number;
  pins: PinGeom[];
  /** The symbol this block is drawn as, or null for a box. */
  sym: SymbolDef | null;
}

type Dir = PinGeom['dir'];

interface PinGeom {
  index: number;
  name: string;
  net: string;
  x: number;
  y: number;
  dir: 'left' | 'right' | 'up' | 'down';
  /** Which block this pin belongs to — pairs with `index` to form legKey. */
  blockId: string;
  /** True for a dotted element reference (CCCS/CCVS's "sense" pin) — no wire. */
  ref: boolean;
}

/** "blockID:pinIndex" — must match hvr.LegKey on the Go side exactly. */
function legKeyOf(p: PinGeom): string {
  return `${p.blockId}:${p.index}`;
}

/** Unit vector a pin's stub leaves along. */
function stubVec(dir: Dir): [number, number] {
  switch (dir) {
    case 'left': return [-1, 0];
    case 'right': return [1, 0];
    case 'up': return [0, -1];
    default: return [0, 1];
  }
}

function vecDir(x: number, y: number): Dir {
  if (x < 0) return 'left';
  if (x > 0) return 'right';
  return y < 0 ? 'up' : 'down';
}

/**
 * A block's orientation as a map from symbol coordinates to offsets from the
 * block's position: mirror first, in the symbol's own axes, then rotate —
 * the same order as the SVG transform it also returns, so the pins computed
 * here land exactly on the leads drawn there. Rotations are quarter turns, so
 * the matrix is integer and a pin on the grid stays on it.
 */
function orientation(b: Block) {
  const q = Math.round((((b.rot % 360) + 360) % 360) / 90) % 4;
  const c = [1, 0, -1, 0][q];
  const s = [0, 1, 0, -1][q];
  const sx = b.flipX ? -1 : 1;
  const sy = b.flipY ? -1 : 1;
  const apply = (x: number, y: number): [number, number] => {
    const fx = sx * x, fy = sy * y;
    return [c * fx - s * fy + 0, s * fx + c * fy + 0]; // + 0 folds -0 away
  };
  return {
    apply,
    dir: (d: Dir): Dir => vecDir(...apply(...stubVec(d))),
    transform: `rotate(${q * 90}) scale(${sx} ${sy})`,
  };
}

export class Canvas {
  private svg!: SVGSVGElement;
  private root!: SVGGElement;
  private sheet: Sheet | null = null;

  private tx = 0;
  private ty = 0;
  private scale = 1;

  private geoms = new Map<string, Geom>();
  private chipGeoms = new Map<string, { x: number; y: number; w: number; h: number; sig: Signal }>();

  selectedBlock: string | null = null;
  selectedNet: string | null = null;
  selectedSignal: string | null = null;
  private hotNet: string | null = null;

  constructor(private host: HTMLElement, private h: CanvasHandlers) {
    this.build();
  }

  private build() {
    this.host.innerHTML = `
      <div class="canvas-wrap">
        <svg class="canvas">
          <defs>
            <pattern id="grid" width="${GRID}" height="${GRID}" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" fill="var(--canvas-grid)"/>
            </pattern>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4"
                    markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0 1 L7 4 L0 7 z" fill="var(--signal)"/>
            </marker>
          </defs>
          <rect class="grid-bg" width="100%" height="100%" fill="url(#grid)"/>
          <g class="root"></g>
        </svg>
        <div class="legend">
          <span><i class="solid"></i>wire (electrical net)</span>
          <span><i class="dashed"></i>signal (logic port)</span>
        </div>
        <div class="zoom-ctl">
          <button data-zoom="out">−</button>
          <button data-zoom="fit">Fit</button>
          <button data-zoom="in">+</button>
        </div>
      </div>`;

    this.svg = this.host.querySelector('svg.canvas') as SVGSVGElement;
    this.root = this.host.querySelector('g.root') as SVGGElement;

    this.host.querySelectorAll('[data-zoom]').forEach((b) =>
      b.addEventListener('click', () => {
        const k = (b as HTMLElement).dataset.zoom;
        if (k === 'in') this.zoomBy(1.2);
        else if (k === 'out') this.zoomBy(1 / 1.2);
        else this.fit();
      }),
    );

    this.attachPanZoom();
    this.attachDrop();
  }

  // ── View transform ────────────────────────────────────────────────────

  private applyTransform() {
    this.root.setAttribute('transform', `translate(${this.tx} ${this.ty}) scale(${this.scale})`);
    // Keep the dot grid locked to world space so panning feels physical.
    const bg = this.svg.querySelector('.grid-bg') as SVGRectElement;
    bg?.setAttribute('transform', `translate(${this.tx % (GRID * this.scale)} ${this.ty % (GRID * this.scale)})`);
    const pat = this.svg.querySelector('#grid') as SVGPatternElement;
    pat?.setAttribute('width', String(GRID * this.scale));
    pat?.setAttribute('height', String(GRID * this.scale));
  }

  private zoomBy(f: number) {
    const r = this.svg.getBoundingClientRect();
    this.zoomAt(r.width / 2, r.height / 2, f);
  }

  private zoomAt(px: number, py: number, f: number) {
    const next = Math.min(3, Math.max(0.2, this.scale * f));
    const k = next / this.scale;
    this.tx = px - (px - this.tx) * k;
    this.ty = py - (py - this.ty) * k;
    this.scale = next;
    this.applyTransform();
  }

  /** Frames the whole diagram in the viewport. */
  fit() {
    if (!this.sheet || this.geoms.size === 0) {
      this.tx = 0;
      this.ty = 0;
      this.scale = 1;
      this.applyTransform();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const consider = (x: number, y: number, w: number, h: number) => {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
    };
    this.geoms.forEach((g) => consider(g.x - 40, g.y, g.w + 80, g.h));
    this.chipGeoms.forEach((c) => consider(c.x, c.y, c.w, c.h));

    const r = this.svg.getBoundingClientRect();
    const pad = 50;
    const sx = (r.width - pad * 2) / Math.max(1, maxX - minX);
    const sy = (r.height - pad * 2) / Math.max(1, maxY - minY);
    this.scale = Math.min(1.15, Math.max(0.2, Math.min(sx, sy)));
    this.tx = pad - minX * this.scale + (r.width - pad * 2 - (maxX - minX) * this.scale) / 2;
    this.ty = pad - minY * this.scale + (r.height - pad * 2 - (maxY - minY) * this.scale) / 2;
    this.applyTransform();
  }

  private toWorld(clientX: number, clientY: number) {
    const r = this.svg.getBoundingClientRect();
    return {
      x: (clientX - r.left - this.tx) / this.scale,
      y: (clientY - r.top - this.ty) / this.scale,
    };
  }

  // ── Interaction ───────────────────────────────────────────────────────

  private attachPanZoom() {
    this.svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.svg.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    let panning = false;
    let startX = 0, startY = 0, ox = 0, oy = 0;

    this.svg.addEventListener('pointerdown', (e) => {
      const target = e.target as Element;
      if (target.closest('.block') || target.closest('.chip') ||
          target.closest('[data-trunk]') || target.closest('[data-trunk-y]')) return;

      // Clicking empty canvas clears the selection.
      if (!target.closest('.net-label') && !target.closest('.pin-hit')) {
        this.select(null, null, null);
      }
      panning = true;
      startX = e.clientX; startY = e.clientY;
      ox = this.tx; oy = this.ty;
      this.svg.classList.add('panning');
      this.svg.setPointerCapture(e.pointerId);
    });

    this.svg.addEventListener('pointermove', (e) => {
      if (!panning) return;
      this.tx = ox + (e.clientX - startX);
      this.ty = oy + (e.clientY - startY);
      this.applyTransform();
    });

    const end = (e: PointerEvent) => {
      if (!panning) return;
      panning = false;
      this.svg.classList.remove('panning');
      try { this.svg.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    this.svg.addEventListener('pointerup', end);
    this.svg.addEventListener('pointercancel', end);
  }

  private attachDrop() {
    const wrap = this.host.querySelector('.canvas-wrap') as HTMLElement;

    wrap.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!wrap.querySelector('.drop-hint')) {
        const d = document.createElement('div');
        d.className = 'drop-hint';
        d.textContent = 'Drop to add to this module';
        wrap.appendChild(d);
      }
    });
    wrap.addEventListener('dragleave', (e) => {
      if (e.target === wrap) wrap.querySelector('.drop-hint')?.remove();
    });
    wrap.addEventListener('drop', (e) => {
      e.preventDefault();
      wrap.querySelector('.drop-hint')?.remove();
      const payload = e.dataTransfer?.getData('application/x-hoverdeck');
      if (!payload) return;
      const p = this.toWorld(e.clientX, e.clientY);
      this.h.onDropCatalog(payload, p.x, p.y);
    });
  }

  // ── Public state ──────────────────────────────────────────────────────

  select(block: string | null, net: string | null, signal: string | null) {
    this.selectedBlock = block;
    this.selectedNet = net;
    this.selectedSignal = signal;
    this.h.onSelectBlock(block);
    this.h.onSelectNet(net);
    this.h.onSelectSignal(signal);
    this.paintSelection();
  }

  /** Re-applies selection/highlight classes without rebuilding the DOM. */
  private paintSelection() {
    this.root.querySelectorAll('.block').forEach((el) =>
      el.classList.toggle('sel', (el as SVGElement).dataset.id === this.selectedBlock));
    this.root.querySelectorAll('.chip').forEach((el) =>
      el.classList.toggle('sel', (el as SVGElement).dataset.name === this.selectedSignal));

    const hot = this.hotNet ?? this.selectedNet;
    this.root.querySelectorAll('[data-net]').forEach((el) => {
      const on = (el as SVGElement).dataset.net === hot;
      el.classList.toggle('hot', on);
    });
    this.root.querySelectorAll('[data-sig]').forEach((el) => {
      const on = (el as SVGElement).dataset.sig === this.selectedSignal;
      el.classList.toggle('hot', on);
    });
  }

  private setHotNet(n: string | null) {
    this.hotNet = n;
    this.paintSelection();
  }

  // ── Layout ────────────────────────────────────────────────────────────

  private layout(sheet: Sheet) {
    this.geoms.clear();
    this.chipGeoms.clear();

    for (const b of sheet.blocks) {
      this.geoms.set(b.id, this.symbolGeom(b) ?? this.boxGeom(b));
    }

    // Signal chips carry their own saved position, exactly like blocks; the
    // backend seeds unplaced ones into a lane above the diagram.
    for (const s of sheet.signals) {
      const w = Math.max(64, s.name.length * 7 + 44);
      this.chipGeoms.set(s.name, { x: s.x, y: s.y, w, h: 26, sig: s });
    }
  }

  /**
   * Geometry for a block drawn as its symbol: the block's position is the
   * symbol's origin, and each pin sits where the symbol file put it, turned
   * with the block. Null when the block has no fitting symbol.
   */
  private symbolGeom(b: Block): Geom | null {
    const sym = b.symPins ? symbolOf(b.icon) : undefined;
    const spins = sym?.pins ?? [];
    if (!sym || !b.symPins || b.symPins.length !== b.pins.length ||
        b.symPins.some((j) => !spins[j])) {
      return null;
    }
    const o = orientation(b);

    const [vx, vy, vw, vh] = sym.viewBox;
    const corners = [o.apply(vx, vy), o.apply(vx + vw, vy), o.apply(vx, vy + vh), o.apply(vx + vw, vy + vh)];
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    const minX = Math.min(...xs), minY = Math.min(...ys);

    const g: Geom = {
      block: b, sym, pins: [],
      x: b.x + minX, y: b.y + minY,
      w: Math.max(...xs) - minX, h: Math.max(...ys) - minY,
    };
    b.pins.forEach((p, i) => {
      const sp = spins[b.symPins![i]];
      const [dx, dy] = o.apply(sp.x, sp.y);
      g.pins.push({
        index: p.index, name: p.name, net: p.net,
        x: b.x + dx, y: b.y + dy, dir: o.dir(sp.dir),
        blockId: b.id, ref: p.ref,
      });
    });
    return g;
  }

  /** Geometry for a block drawn as a box: pins split across two edges. */
  private boxGeom(b: Block): Geom {
    const n = b.pins.length;

    // Ports split half to one side, half to the other. For a 3-pin BJT that
    // puts base on the first side with collector/emitter opposite, and for a
    // 5-pin op-amp the two inputs on one side and rails + output on the
    // other, which is how both are conventionally drawn.
    let aCount = Math.floor(n / 2);
    let bCount = n - aCount;
    const rows = Math.max(aCount, bCount, 1);

    // A 90/270 rotation puts the pins on the top and bottom edges, so the
    // box grows sideways instead of downwards.
    const rot = ((b.rot % 360) + 360) % 360;
    const vertical = rot === 90 || rot === 270;

    const w = vertical ? Math.max(BLOCK_W, rows * PIN_SPACING + 60) : BLOCK_W;
    const h = vertical ? BLOCK_MIN_H : Math.max(BLOCK_MIN_H, HEADER_H + rows * PIN_SPACING + 12);

    const g: Geom = { block: b, x: b.x, y: b.y, w, h, pins: [], sym: null };

    // Which physical edge each group lands on, before mirroring.
    let sideA: PinGeom['dir'], sideB: PinGeom['dir'];
    switch (rot) {
      case 90:  sideA = 'up';    sideB = 'down';  break;
      case 180: sideA = 'right'; sideB = 'left';  break;
      case 270: sideA = 'down';  sideB = 'up';    break;
      default:  sideA = 'left';  sideB = 'right'; break;
    }
    if (b.flipX) {
      [sideA, sideB] = [sideB, sideA];
      [aCount, bCount] = [bCount, aCount];
    }

    b.pins.forEach((p, i) => {
      const inA = i < aCount;
      const dir = inA ? sideA : sideB;
      const count = inA ? aCount : bCount;
      let slot = inA ? i : i - aCount;
      if (b.flipY) slot = count - 1 - slot; // mirror the order along the edge

      const span = (count - 1) * PIN_SPACING;
      let x: number, y: number;

      if (dir === 'left' || dir === 'right') {
        y = g.y + HEADER_H + (h - HEADER_H - 12 - span) / 2 + slot * PIN_SPACING;
        x = dir === 'left' ? g.x : g.x + g.w;
      } else {
        x = g.x + (w - span) / 2 + slot * PIN_SPACING;
        y = dir === 'up' ? g.y : g.y + g.h;
      }
      g.pins.push({ index: p.index, name: p.name, net: p.net, x, y, dir, blockId: b.id, ref: p.ref });
    });

    return g;
  }

  // ── Render ────────────────────────────────────────────────────────────

  render(sheet: Sheet | null, refit = false) {
    this.sheet = sheet;
    if (!sheet) {
      this.root.innerHTML = '';
      return;
    }
    this.layout(sheet);

    const parts: string[] = [];

    parts.push(this.renderNets(sheet));
    parts.push(this.renderSignalLinks(sheet));
    parts.push(this.renderChips(sheet));
    parts.push(this.renderBlocks(sheet));

    this.root.innerHTML = parts.join('');
    this.wireEvents();
    this.paintSelection();
    if (refit) this.fit();
  }

  /** Collects every pin position bound to each net. */
  private pinsOfNet(net: string): PinGeom[] {
    const out: PinGeom[] = [];
    this.geoms.forEach((g) => g.pins.forEach((p) => { if (p.net === net) out.push(p); }));
    return out;
  }

  private renderNets(sheet: Sheet): string {
    const out: string[] = [];

    for (const net of sheet.nets) {
      const pins = this.pinsOfNet(net.name);
      if (pins.length === 0) continue;

      // Ground: a local terminal per pin, never a routed net.
      if (net.isGround) {
        for (const p of pins) {
          out.push(`<g data-net="gnd">${groundSymbol(p.x, p.y, p.dir)}</g>`);
        }
        continue;
      }

      // A net with a single pin still gets a stub + label so an unconnected
      // or boundary-only node is visible rather than silently absent.
      if (pins.length === 1) {
        const p = pins[0];
        const [vx, vy] = stubVec(p.dir);
        const ex = p.x + vx * PIN_STUB;
        const ey = p.y + vy * PIN_STUB;
        out.push(`<path class="wire" data-net="${esc(net.name)}" d="M${p.x} ${p.y} L${ex} ${ey}"/>`);
        out.push(this.netLabel(net.name, ex + (vx < 0 ? -4 : 4), ey - 6, vx < 0 ? 'end' : 'start'));
        continue;
      }

      // Routing channel: pinned by the user if they have dragged this wire,
      // otherwise the mean of the pins' stub ends. dy lifts the horizontal
      // legs off whatever they were crossing.
      const stubEnds = pins.map((p) => {
        const [vx, vy] = stubVec(p.dir);
        return { x: p.x + vx * PIN_STUB, y: p.y + vy * PIN_STUB, dir: p.dir, pin: p };
      });
      const auto = Math.round(stubEnds.reduce((a, s) => a + s.x, 0) / stubEnds.length);
      const trunkX = net.hasTrunk ? net.trunkX : auto;
      const dy = net.trunkDY || 0;

      // First pass: work out each leg's path without emitting anything yet.
      // The trunk's own vertical extent depends on every leg's join point,
      // so its path can't be built until all of them are known.
      //
      // Each leg's own offset is dy (the net's bulk shift) PLUS its own
      // legDY entry — the two are independent, additive knobs: dragging the
      // trunk moves every leg together, dragging one leg nudges only that
      // leg on top of wherever the trunk already put it. Without a per-leg
      // term here, every leg would be forced to share the exact same
      // vertical offset, and dragging any one of them would inevitably drag
      // all the others along with it — no way to move just one connection.
      const legPaths: { d: string; legKey: string; pinned: boolean }[] = [];
      const joinYs: number[] = [];
      for (const s of stubEnds) {
        const p = s.pin;
        const legKey = legKeyOf(p);
        const legDy = net.legDY[legKey] || 0;
        const totalDy = dy + legDy;
        const pinned = legDy !== 0;

        const horizontal = s.dir === 'left' || s.dir === 'right';
        const jointY = s.y + totalDy;

        // With no manual offset a side pin runs straight across, unless the
        // channel sits behind it — in which case route around the block
        // rather than drawing back over it.
        const doublesBack = horizontal && totalDy === 0 &&
          ((s.dir === 'right' && trunkX < s.x) || (s.dir === 'left' && trunkX > s.x));

        if (horizontal && totalDy === 0 && !doublesBack) {
          legPaths.push({ d: `M${p.x} ${p.y} H${trunkX}`, legKey, pinned });
          joinYs.push(p.y);
          continue;
        }
        if (doublesBack) {
          const g = this.geomOfPin(p);
          const above = g ? p.y < g.y + g.h / 2 : true;
          const detourY = g ? (above ? g.y - 14 : g.y + g.h + 14) : p.y - 14;
          legPaths.push({ d: `M${p.x} ${p.y} H${s.x} V${detourY} H${trunkX}`, legKey, pinned });
          joinYs.push(detourY);
          continue;
        }

        // General case: out along the stub, vertically to the joint, then
        // across to the channel. Always orthogonal for any pin direction.
        legPaths.push({ d: `M${p.x} ${p.y} L${s.x} ${s.y} V${jointY} H${trunkX}`, legKey, pinned });
        joinYs.push(jointY);
      }

      const minY = Math.min(...joinYs);
      const maxY = Math.max(...joinYs);

      // Trunk is drawn — and its grab handle wired — before any leg, so
      // every leg (painted after, later in the DOM) sits on top of it for
      // hit-testing. This matters whenever a leg runs parallel to and
      // coincides with the trunk, which happens whenever a pin's stub
      // already lines up with trunkX (any straight-through vertical pin,
      // for instance): without this ordering the trunk's invisible grip
      // would sit on top along that entire shared run, not just at a
      // corner, and grabbing anywhere on what looks like "just that wire"
      // would always drag the whole net's trunk instead.
      if (maxY > minY) {
        out.push(
          `<path class="trunk-grip" data-trunk="${esc(net.name)}" d="M${trunkX} ${minY} V${maxY}"/>` +
          `<path class="wire trunk${net.hasTrunk ? ' pinned' : ''}" data-net="${esc(net.name)}" ` +
          `data-trunk="${esc(net.name)}" d="M${trunkX} ${minY} V${maxY}"/>`,
        );
      }
      for (const leg of legPaths) {
        out.push(
          `<path class="trunk-grip-y" data-trunk-y="${esc(net.name)}" data-leg="${esc(leg.legKey)}" d="${leg.d}"/>` +
          `<path class="wire${leg.pinned ? ' pinned' : ''}" data-net="${esc(net.name)}" ` +
          `data-trunk-y="${esc(net.name)}" data-leg="${esc(leg.legKey)}" d="${leg.d}"/>`,
        );
      }
      // Junction dots wherever three or more segments meet.
      if (pins.length > 2) {
        for (const y of joinYs) {
          if (y > minY && y < maxY) {
            out.push(`<circle class="junction" data-net="${esc(net.name)}" cx="${trunkX}" cy="${y}" r="3"/>`);
          }
        }
      }
      out.push(this.netLabel(net.name, trunkX + 5, minY - 5, 'start'));
    }
    return out.join('');
  }

  /** The x position automatic routing would choose for a net. */
  private autoTrunkX(name: string): number {
    const pins = this.pinsOfNet(name);
    if (!pins.length) return 0;
    // Must match the channel renderNets computes, or a trunk jumps sideways
    // the moment it is grabbed: an up/down pin's stub ends at its own x.
    const stubs = pins.map((p) => p.x + stubVec(p.dir)[0] * PIN_STUB);
    return Math.round(stubs.reduce((a, b) => a + b, 0) / stubs.length);
  }

  private geomOfPin(p: PinGeom): Geom | undefined {
    let found: Geom | undefined;
    this.geoms.forEach((g) => {
      if (g.pins.includes(p)) found = g;
    });
    return found;
  }

  private netLabel(name: string, x: number, y: number, anchor: string): string {
    return `<text class="net-label" data-net="${esc(name)}" data-netlabel="${esc(name)}" ` +
           `x="${x}" y="${y}" text-anchor="${anchor}">${esc(name)}</text>`;
  }

  /**
   * Dashed links from a signal chip to every block that reads or writes it
   * through a logic port. Direction comes from the module's declared
   * input/output, so the arrow shows which way the value actually flows.
   */
  private renderSignalLinks(sheet: Sheet): string {
    const out: string[] = [];
    for (const b of sheet.blocks) {
      const g = this.geoms.get(b.id);
      if (!g) continue;
      b.logic.forEach((arg, i) => {
        const chip = this.chipGeoms.get(arg.text.trim());
        if (!chip) return;

        const dirOut = isOutput(b, i);
        const cx = chip.x + chip.w / 2;
        const cy = chip.y + chip.h;
        const bx = g.x + g.w / 2;
        const by = g.y;
        const midY = (cy + by) / 2;
        const d = `M${cx} ${cy} V${midY} H${bx} V${by}`;
        const marker = dirOut ? '' : ' marker-end="url(#arrow)"';
        out.push(
          `<path class="slink" data-sig="${esc(arg.text.trim())}" data-block="${esc(b.id)}" d="${d}"${marker}/>`,
        );
      });
    }
    return out.join('');
  }

  private renderChips(sheet: Sheet): string {
    const out: string[] = [];
    for (const s of sheet.signals) {
      const c = this.chipGeoms.get(s.name);
      if (!c) continue;
      const cls = `chip${s.isState ? ' state' : ''}`;
      out.push(
        `<g class="${cls}" data-name="${esc(s.name)}" data-sig="${esc(s.name)}">` +
        `<rect class="chip-box" x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="13"/>` +
        `<text class="chip-text" x="${c.x + 11}" y="${c.y + 17}">${esc(s.name)}</text>` +
        `<text class="chip-kind" x="${c.x + c.w - 9}" y="${c.y + 17}" text-anchor="end">` +
        `${s.isState ? 'state' : esc(shortType(s.type))}</text>` +
        `</g>`,
      );
    }
    return out.join('');
  }

  private renderBlocks(sheet: Sheet): string {
    const out: string[] = [];
    for (const b of sheet.blocks) {
      const g = this.geoms.get(b.id);
      if (!g) continue;
      if (g.sym) {
        out.push(this.renderSymbolBlock(b, g, g.sym));
        continue;
      }

      const accent = domainColor(b.domain);
      const params = b.params.map((p) => p.text).join(', ');
      const showParams = params.length > 0 ? trunc(params, 22) : '';

      const pinMarkup = g.pins.map((p) => {
        // Labels sit just inside the block, pointing away from the edge the
        // pin is on, so they stay readable at any rotation.
        let tx = p.x, ty = p.y + 3, anchor = 'start';
        switch (p.dir) {
          case 'left':  tx = p.x + 7; anchor = 'start'; break;
          case 'right': tx = p.x - 7; anchor = 'end';   break;
          case 'up':    ty = p.y + 12; anchor = 'middle'; break;
          case 'down':  ty = p.y - 6;  anchor = 'middle'; break;
        }
        // A ref pin (CCCS/CCVS's "sense") names another element rather than
        // a net — no wire is ever drawn for it, so it gets its own dot style
        // plus a tooltip revealing what it points at instead of a data-net
        // hookup that would only ever miss.
        if (p.ref) {
          return (
            `<g>` +
            `<circle class="pin-dot pin-ref" cx="${p.x}" cy="${p.y}" r="3.5"><title>senses ${esc(p.net)}</title></circle>` +
            `<text class="pin-name" x="${tx}" y="${ty}" text-anchor="${anchor}">${esc(p.name)}</text>` +
            `</g>`
          );
        }
        return (
          `<g data-net="${esc(p.net)}">` +
          `<circle class="pin-dot" data-net="${esc(p.net)}" cx="${p.x}" cy="${p.y}" r="3.5"/>` +
          `<text class="pin-name" data-net="${esc(p.net)}" x="${tx}" y="${ty}" ` +
          `text-anchor="${anchor}">${esc(p.name)}</text>` +
          `<rect class="pin-hit" data-pin="${p.index}" data-block="${esc(b.id)}" data-net="${esc(p.net)}" ` +
          `x="${p.x - 9}" y="${p.y - 9}" width="18" height="18"/>` +
          `</g>`
        );
      }).join('');

      const unresolved = b.kind === 'instance' && b.def && !b.def.found;
      const boxStroke = unresolved ? ' style="stroke:var(--color-red)"' : '';

      out.push(
        `<g class="block" data-id="${esc(b.id)}" transform="translate(0 0)">` +
        `<rect class="block-box" x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="8"${boxStroke}/>` +
        `<rect class="block-accent" x="${g.x}" y="${g.y}" width="3.5" height="${g.h}" rx="2" fill="${accent}"/>` +
        `<g transform="translate(${g.x + 10} ${g.y + 8})" class="icon-slot">` +
        `<g transform="${symbolTransform(b)}">${iconSvg(b.icon)}</g></g>` +
        `<text class="block-label" x="${g.x + 64}" y="${g.y + 20}">${esc(trunc(b.label, 11))}</text>` +
        `<text class="block-type" x="${g.x + 64}" y="${g.y + 33}">${esc(trunc(b.typeName, 14))}</text>` +
        (showParams
          ? `<text class="block-param" x="${g.x + g.w / 2}" y="${g.y + g.h - 6}" text-anchor="middle">${esc(showParams)}</text>`
          : '') +
        (b.navigable
          ? `<circle class="state-badge" cx="${g.x + g.w - 11}" cy="${g.y + 11}" r="6"/>` +
            `<text class="state-badge-text" x="${g.x + g.w - 11}" y="${g.y + 14}" text-anchor="middle">↧</text>`
          : '') +
        pinMarkup +
        `</g>`,
      );
    }
    return out.join('');
  }

  /**
   * A block drawn as its schematic symbol. The drawing is rotated and
   * mirrored with the block; its labels are not, and go on whichever side of
   * it no wire leaves from, so they never sit on a lead.
   */
  private renderSymbolBlock(b: Block, g: Geom, sym: SymbolDef): string {
    const o = orientation(b);
    const connected = new Set((b.symPins ?? []).map((j) => sym.pins![j].name));
    const pad = 4;

    const pinMarkup = g.pins.map((p) => {
      if (p.ref) {
        return `<circle class="pin-dot pin-ref" cx="${p.x}" cy="${p.y}" r="3"><title>${esc(p.name)} senses ${esc(p.net)}</title></circle>`;
      }
      return (
        `<g data-net="${esc(p.net)}">` +
        `<circle class="pin-dot sym-pin" data-net="${esc(p.net)}" cx="${p.x}" cy="${p.y}" r="2.6"/>` +
        `<rect class="pin-hit" data-pin="${p.index}" data-block="${esc(b.id)}" data-net="${esc(p.net)}" ` +
        `x="${p.x - 7}" y="${p.y - 7}" width="14" height="14"><title>${esc(p.name)} — ${esc(p.net)}</title></rect>` +
        `</g>`
      );
    }).join('');

    return (
      `<g class="block sym-block" data-id="${esc(b.id)}" transform="translate(0 0)">` +
      `<rect class="sym-hit" x="${g.x - pad}" y="${g.y - pad}" width="${g.w + pad * 2}" height="${g.h + pad * 2}"/>` +
      `<g class="sym-draw" transform="translate(${b.x} ${b.y}) ${o.transform}">` +
      `<g class="sym">${symbolBody(sym, connected)}</g></g>` +
      this.symbolLabels(b, g) +
      (b.navigable
        ? `<circle class="state-badge" cx="${g.x + g.w}" cy="${g.y}" r="6"/>` +
          `<text class="state-badge-text" x="${g.x + g.w}" y="${g.y + 3}" text-anchor="middle">↧</text>`
        : '') +
      pinMarkup +
      `</g>`
    );
  }

  /** Reference, type and value beside a symbol, like a schematic's fields. */
  private symbolLabels(b: Block, g: Geom): string {
    const lines: { text: string; cls: string }[] = [{ text: trunc(b.label, 14), cls: 'block-label' }];
    const params = b.params.map((p) => p.text).join(', ');
    if (b.kind === 'instance') lines.push({ text: trunc(b.typeName, 16), cls: 'block-type' });
    if (params) lines.push({ text: trunc(params, 22), cls: 'block-param' });

    const used = new Set(g.pins.map((p) => p.dir));
    const side = (['right', 'left', 'down', 'up'] as Dir[]).find((d) => !used.has(d)) ?? 'down';
    const LINE = 12;
    const cx = g.x + g.w / 2, cy = g.y + g.h / 2;
    let x: number, y0: number, anchor: string;
    switch (side) {
      case 'right': x = g.x + g.w + 6; anchor = 'start'; y0 = cy - ((lines.length - 1) * LINE) / 2 + 4; break;
      case 'left': x = g.x - 6; anchor = 'end'; y0 = cy - ((lines.length - 1) * LINE) / 2 + 4; break;
      case 'up': x = cx; anchor = 'middle'; y0 = g.y - 6 - (lines.length - 1) * LINE; break;
      default: x = cx; anchor = 'middle'; y0 = g.y + g.h + 14; break;
    }
    return lines.map((l, i) =>
      `<text class="${l.cls} sym-label" x="${x}" y="${y0 + i * LINE}" text-anchor="${anchor}">${esc(l.text)}</text>`,
    ).join('');
  }

  // ── Events on rendered nodes ──────────────────────────────────────────

  private wireEvents() {
    // Wire re-routing: drag a net's trunk sideways to pull it clear of
    // whatever it overlaps. The listeners live on window rather than on the
    // path, because each move re-renders the diagram and would otherwise
    // destroy the element holding the pointer capture mid-drag.
    this.root.querySelectorAll('[data-trunk]').forEach((el) => {
      el.addEventListener('pointerdown', (ev) => {
        const e = ev as PointerEvent;
        e.stopPropagation();
        e.preventDefault();
        const name = (el as SVGElement).dataset.trunk!;
        const net = this.sheet?.nets.find((n) => n.name === name);
        if (!net) return;

        const startX = e.clientX;
        const startY = e.clientY;
        const originX = net.hasTrunk ? net.trunkX : this.autoTrunkX(name);
        const originDY = net.trunkDY || 0;
        let moved = false;

        // Both axes: horizontal movement slides the vertical channel, vertical
        // movement lifts the horizontal legs that feed into it.
        const move = (me: PointerEvent) => {
          const dx = (me.clientX - startX) / this.scale;
          const dy = (me.clientY - startY) / this.scale;
          if (!moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
          moved = true;
          net.trunkX = Math.round((originX + dx) / 8) * 8;
          net.trunkDY = Math.round((originDY + dy) / 8) * 8;
          net.hasTrunk = true;
          this.render(this.sheet);
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          if (moved) this.h.onMoveNetTrunk(name, net.trunkX, net.trunkDY);
          else this.select(null, name, null);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    });

    // Horizontal leg re-routing: drag a leg vertically to lift it clear of
    // whatever it crosses. A leg's horizontal position is pinned to the pin
    // it comes from, so only Y dragging means anything here — hence a
    // separate handler with an ns-resize cursor rather than reusing the
    // trunk's 2-axis one.
    //
    // This adjusts the LEG's own offset (net.legDY[legKey]), not the net's
    // shared trunkDY — that is what keeps dragging one leg from dragging
    // every other leg of the same net along with it. Dragging the trunk
    // itself (the other handler, above) still moves every leg together, as
    // a deliberate bulk shift; this one is the independent, single-leg move.
    this.root.querySelectorAll('[data-trunk-y]').forEach((el) => {
      el.addEventListener('pointerdown', (ev) => {
        const e = ev as PointerEvent;
        e.stopPropagation();
        e.preventDefault();
        const name = (el as SVGElement).dataset.trunkY!;
        const legKey = (el as SVGElement).dataset.leg!;
        const net = this.sheet?.nets.find((n) => n.name === name);
        if (!net) return;

        const startY = e.clientY;
        const originDY = net.legDY[legKey] || 0;
        let moved = false;

        const move = (me: PointerEvent) => {
          const dy = (me.clientY - startY) / this.scale;
          if (!moved && Math.abs(dy) < 2) return;
          moved = true;
          net.legDY = { ...net.legDY, [legKey]: Math.round((originDY + dy) / 8) * 8 };
          this.render(this.sheet);
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          if (moved) this.h.onMoveLeg(name, legKey, net.legDY[legKey]);
          else this.select(null, name, null);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    });

    // Net hover/selection.
    this.root.querySelectorAll('[data-net]').forEach((el) => {
      el.addEventListener('mouseenter', () => this.setHotNet((el as SVGElement).dataset.net!));
      el.addEventListener('mouseleave', () => this.setHotNet(null));
    });
    this.root.querySelectorAll('[data-netlabel]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.select(null, (el as SVGElement).dataset.netlabel!, null);
      });
    });
    this.root.querySelectorAll('.pin-hit').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.select(null, (el as SVGElement).dataset.net!, null);
      });
    });

    // Signal chips drag exactly like blocks, so state variables can be
    // arranged next to whatever they drive.
    this.root.querySelectorAll('.chip').forEach((el) => {
      const name = (el as SVGElement).dataset.name!;
      const c = this.chipGeoms.get(name);
      if (!c) return;

      let dragging = false, moved = false;
      let sx = 0, sy = 0, ox = 0, oy = 0;

      el.addEventListener('pointerdown', (ev) => {
        const e = ev as PointerEvent;
        e.stopPropagation();
        dragging = true; moved = false;
        sx = e.clientX; sy = e.clientY;
        ox = c.x; oy = c.y;
        (el as SVGGElement).setPointerCapture(e.pointerId);
      });

      el.addEventListener('pointermove', (ev) => {
        if (!dragging) return;
        const e = ev as PointerEvent;
        const dx = (e.clientX - sx) / this.scale;
        const dy = (e.clientY - sy) / this.scale;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
        if (!moved) return;
        (el as SVGGElement).setAttribute('transform', `translate(${dx} ${dy})`);
      });

      const finish = (ev: Event) => {
        if (!dragging) return;
        const e = ev as PointerEvent;
        dragging = false;
        try { (el as SVGGElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }

        if (!moved) {
          this.select(null, null, name);
          return;
        }
        const nx = Math.round((ox + (e.clientX - sx) / this.scale) / 8) * 8;
        const ny = Math.round((oy + (e.clientY - sy) / this.scale) / 8) * 8;
        c.x = nx; c.y = ny;
        c.sig.x = nx; c.sig.y = ny;
        (el as SVGGElement).setAttribute('transform', 'translate(0 0)');
        this.h.onMoveSignal(name, nx, ny);
        this.render(this.sheet);
      };
      el.addEventListener('pointerup', finish);
      el.addEventListener('pointercancel', finish);
    });

    // Blocks: click selects, double-click opens, drag moves.
    this.root.querySelectorAll('.block').forEach((el) => {
      const id = (el as SVGElement).dataset.id!;
      const g = this.geoms.get(id);
      if (!g) return;

      let moved = false;
      let dragging = false;
      let sx = 0, sy = 0, ox = 0, oy = 0;

      el.addEventListener('pointerdown', (ev) => {
        const e = ev as PointerEvent;
        if ((e.target as Element).closest('.pin-hit')) return;
        e.stopPropagation();
        dragging = true;
        moved = false;
        sx = e.clientX; sy = e.clientY;
        ox = g.x; oy = g.y;
        (el as SVGGElement).setPointerCapture(e.pointerId);
      });

      el.addEventListener('pointermove', (ev) => {
        if (!dragging) return;
        const e = ev as PointerEvent;
        const dx = (e.clientX - sx) / this.scale;
        const dy = (e.clientY - sy) / this.scale;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
        if (!moved) return;
        // Move only this group during the drag; nets are re-routed on drop.
        (el as SVGGElement).setAttribute('transform', `translate(${dx} ${dy})`);
      });

      const finish = (ev: Event) => {
        if (!dragging) return;
        const e = ev as PointerEvent;
        dragging = false;
        try { (el as SVGGElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }

        if (!moved) {
          this.select(id, null, null);
          return;
        }
        const dx = (e.clientX - sx) / this.scale;
        const dy = (e.clientY - sy) / this.scale;
        const nx = Math.round((ox + dx) / 8) * 8;
        const ny = Math.round((oy + dy) / 8) * 8;
        g.block.x = nx;
        g.block.y = ny;
        (el as SVGGElement).setAttribute('transform', 'translate(0 0)');
        this.h.onMoveBlock(id, nx, ny);
        this.render(this.sheet);
      };
      el.addEventListener('pointerup', finish);
      el.addEventListener('pointercancel', finish);

      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.h.onOpenBlock(g.block);
      });
    });
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

/**
 * SVG transform that rotates and mirrors a block's symbol about its own
 * centre. The icon is 48x28, and the label beside it is deliberately left
 * upright — rotating text with the symbol would only make it hard to read.
 */
function symbolTransform(b: Block): string {
  const rot = ((b.rot % 360) + 360) % 360;
  if (!rot && !b.flipX && !b.flipY) return '';
  const cx = 24, cy = 14;
  const sx = b.flipX ? -1 : 1;
  const sy = b.flipY ? -1 : 1;
  return `translate(${cx} ${cy}) rotate(${rot}) scale(${sx} ${sy}) translate(${-cx} ${-cy})`;
}

/**
 * Logic ports are positional: argument i of the call binds to logic port i of
 * the declaration, which the backend passes through on the block.
 */
function isOutput(b: Block, argIndex: number): boolean {
  const port = b.logicPorts?.[argIndex];
  return port?.direction === 'output';
}

function domainColor(d: string): string {
  switch (d) {
    case 'analog': return 'var(--analog)';
    case 'digital': return 'var(--digital)';
    case 'primitive': return 'var(--primitive)';
    default: return 'var(--structural)';
  }
}

function shortType(t: string): string {
  return t.replace('unsigned int', 'uint');
}

function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

export function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

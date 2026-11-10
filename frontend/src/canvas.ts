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
import { placeOnSymbol, PORT_PITCH, type LogicArg } from './ports';
import {
  autoRoute, reconcile, junctions, bends, labelAnchor, sameDrawing, snap, stubVec,
  moveSegment, moveCorner, separateAt, removePoint, dragEnd, rewirePin,
  type Seg, type Pt, type Terminal,
} from './wires';
import type { SafeSheet as Sheet, SafeBlock as Block, SafeNet as Net, Signal, SymbolDef } from './types';

const SVG_NS = 'http://www.w3.org/2000/svg';

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
  /** A net's edited drawing to save, or null to return it to automatic routing. */
  onSetNetWires(net: string, wires: Seg[] | null): void;
  /** The same, for a logic signal's links. */
  onSetSignalWires(signal: string, wires: Seg[] | null): void;
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
  /** Where each logic argument that carries a signal attaches. */
  logic: LogicGeom[];
  /** Port rails to draw, world coordinates. */
  rails: Seg[];
  /** The symbol's own logic places in use — for its data-if-pin parts. */
  slots: string[];
}

/** One logic port's attachment point. */
interface LogicGeom {
  /** Index among the block's logic arguments. */
  arg: number;
  signal: string;
  /** The declared port name, '' where there is none. */
  name: string;
  flow: 'in' | 'out';
  x: number;
  y: number;
  /** The way the link leaves the port. */
  dir: Dir;
}

type Dir = PinGeom['dir'];

/** Where a signal's links leave its chip: the middle of its bottom edge. */
function chipAnchor(c: { x: number; y: number; w: number; h: number }): Pt {
  return [Math.round(c.x + c.w / 2), c.y + c.h];
}

/** What a wire belongs to: an electrical net, or a logic signal's links. */
type WireKind = 'net' | 'sig';
const wireKey = (kind: WireKind, name: string) => `${kind}:${name}`;

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
  /** Each wire's segments as last drawn, by wireKey — what an edit starts from. */
  private drawn = new Map<string, Seg[]>();
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
          target.closest('[data-seg]') || target.closest('[data-pt]') || target.closest('.wire-menu')) return;

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
  /**
   * Re-applies selection/highlight classes. Scoped to one freshly redrawn
   * group during a drag, where walking the whole diagram on every pointer
   * move would cost more than the redraw itself.
   */
  private paintSelection(scope: ParentNode = this.root) {
    scope.querySelectorAll('.block').forEach((el) =>
      el.classList.toggle('sel', (el as SVGElement).dataset.id === this.selectedBlock));
    scope.querySelectorAll('.chip').forEach((el) =>
      el.classList.toggle('sel', (el as SVGElement).dataset.name === this.selectedSignal));

    const hot = this.hotNet ?? this.selectedNet;
    scope.querySelectorAll('[data-net]').forEach((el) => {
      const on = (el as SVGElement).dataset.net === hot;
      el.classList.toggle('hot', on);
    });
    scope.querySelectorAll('[data-sig]').forEach((el) => {
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
      block: b, sym, pins: [], logic: [], rails: [], slots: [],
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

    // Logic ports: placed in the symbol's own coordinates (the symbol's
    // places, then free sides, then a rail — see ports.ts) and turned with
    // it, like the pins.
    const args = this.logicArgs(b);
    if (args.length) {
      const pinDirs = b.symPins.map((j) => spins[j].dir);
      const place = placeOnSymbol(sym.viewBox, pinDirs, sym.logic ?? [], args);
      for (const pp of place.ports) {
        const a = args.find((x) => x.arg === pp.arg)!;
        const [dx, dy] = o.apply(pp.x, pp.y);
        g.logic.push({ arg: a.arg, signal: a.signal, name: a.name, flow: a.flow, x: b.x + dx, y: b.y + dy, dir: o.dir(pp.dir) });
      }
      for (const [x1, y1, x2, y2] of place.rails) {
        const [ax, ay] = o.apply(x1, y1), [bx, by] = o.apply(x2, y2);
        g.rails.push([b.x + ax, b.y + ay, b.x + bx, b.y + by]);
      }
      g.slots = place.slots;
    }
    return g;
  }

  /** The block's logic arguments that carry a signal, and so need a port. */
  private logicArgs(b: Block): (LogicArg & { signal: string })[] {
    const signals = new Set((this.sheet?.signals ?? []).map((s) => s.name));
    const out: (LogicArg & { signal: string })[] = [];
    b.logic.forEach((a, i) => {
      const signal = a.text.trim();
      if (!signals.has(signal)) return;
      out.push({ arg: i, signal, name: b.logicPorts[i]?.name ?? '', flow: isOutput(b, i) ? 'out' : 'in' });
    });
    return out;
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

    let w = vertical ? Math.max(BLOCK_W, rows * PIN_SPACING + 60) : BLOCK_W;
    let h = vertical ? BLOCK_MIN_H : Math.max(BLOCK_MIN_H, HEADER_H + rows * PIN_SPACING + 12);

    // Logic ports: inputs on the top edge and outputs on the bottom, each a
    // pitch apart — turned with the block like everything else. The box grows
    // to hold the longer row.
    const args = this.logicArgs(b);
    const o = orientation(b);
    const inSide = o.dir('up'), outSide = o.dir('down');
    const nIn = args.filter((a) => a.flow === 'in').length;
    const nOut = args.length - nIn;
    const need = Math.max(nIn, nOut) * PORT_PITCH + 32;
    if (inSide === 'up' || inSide === 'down') w = Math.max(w, need);
    else h = Math.max(h, need);

    const g: Geom = { block: b, x: b.x, y: b.y, w, h, pins: [], sym: null, logic: [], rails: [], slots: [] };
    for (const flow of ['in', 'out'] as const) {
      const list = args.filter((a) => a.flow === flow);
      const d = flow === 'in' ? inSide : outSide;
      list.forEach((a, i) => {
        const off = Math.round((i - (list.length - 1) / 2) * PORT_PITCH);
        const [x, y] = d === 'up' || d === 'down'
          ? [Math.round(g.x + w / 2) + off, d === 'up' ? g.y : g.y + h]
          : [d === 'left' ? g.x : g.x + w, Math.round(g.y + h / 2) + off];
        g.logic.push({ arg: a.arg, signal: a.signal, name: a.name, flow, x, y, dir: d });
      });
    }

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
    this.lite = false; // a full render is always a full drawing
    this.sheet = sheet;
    if (!sheet) {
      this.root.innerHTML = '';
      return;
    }
    this.layout(sheet);

    const parts: string[] = [];

    // Nets and signal links each get a layer of their own, so a drag can
    // redraw just the wiring it affects instead of the whole diagram.
    parts.push(`<g class="layer-nets">${this.renderNets(sheet)}</g>`);
    parts.push(`<g class="layer-slinks">${this.renderSignalLinks(sheet)}</g>`);
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
    return sheet.nets.map((net) => this.netGroup(net)).join('');
  }

  /** One net's wiring in its own group, so a drag can redraw just that net. */
  private netGroup(net: Net): string {
    return `<g class="netg" data-netg="${esc(net.name)}">${this.renderNet(net)}</g>`;
  }

  private renderNet(net: Net): string {
    const out: string[] = [];
    const pins = this.pinsOfNet(net.name);
    if (pins.length === 0) return '';

    // Ground: a local terminal per pin, never a routed net.
    if (net.isGround) {
      for (const p of pins) {
        out.push(`<g data-net="gnd">${groundSymbol(p.x, p.y, p.dir)}</g>`);
      }
      return out.join('');
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
      return out.join('');
    }

    // Everything else is drawn from segments: the saved drawing if the net
    // has been edited — brought up to date with where its pins are now — or
    // the automatic route. They are kept for the interactions, which edit
    // exactly what is on screen.
    const segs = this.segmentsOf(net, pins);
    this.drawn.set(wireKey('net', net.name), segs);
    const pinPts = pins.map((p) => [p.x, p.y] as Pt);
    out.push(this.wireMarkup('net', net.name, segs, pinPts));
    const at = labelAnchor(segs, pinPts);
    if (at) out.push(this.netLabel(net.name, at[0] + 5, at[1] - 5, 'start'));
    return out.join('');
  }

  /**
   * The drawing of a wire — a net, or a signal's links — with everything
   * needed to edit it. Grips go over every wire: each is the wide, invisible
   * stroke a drag actually lands on, and shows a halo on hover so it is clear
   * which segment will move. Bends get a handle; junctions a dot.
   */
  private wireMarkup(kind: WireKind, name: string, segs: Seg[], pins: Pt[]): string {
    const out: string[] = [];
    const n = esc(name);
    const own = kind === 'net' ? `data-net="${n}"` : `data-sig="${n}"`;
    const what = kind === 'net' ? n : `${n} (signal)`;
    for (const s of segs) {
      out.push(`<path class="${kind === 'net' ? 'wire' : 'slink'}" ${own} d="M${s[0]} ${s[1]} L${s[2]} ${s[3]}"/>`);
    }
    if (this.lite) {
      for (const [x, y] of junctions(segs, pins)) {
        out.push(`<circle class="junction${kind === 'sig' ? ' sig-junction' : ''}" ${own} cx="${x}" cy="${y}" r="3"/>`);
      }
      return out.join('');
    }
    segs.forEach((s, i) => {
      out.push(
        `<path class="seg-grip ${s[1] === s[3] ? 'h' : 'v'} ${kind}" ${own} data-wk="${kind}" data-wn="${n}" ` +
        `data-seg="${i}" d="M${s[0]} ${s[1]} L${s[2]} ${s[3]}"><title>${what}: drag to move this segment ` +
        `· double-click to separate it here · right-click for more</title></path>`,
      );
    });
    for (const [x, y] of bends(segs, pins)) {
      out.push(
        `<rect class="bend-grip ${kind}" ${own} data-wk="${kind}" data-wn="${n}" data-pt="${x},${y}" ` +
        `x="${x - 5}" y="${y - 5}" width="10" height="10"><title>${what}: drag to move this bend ` +
        `· double-click to take it out</title></rect>`,
      );
    }
    for (const [x, y] of junctions(segs, pins)) {
      out.push(`<circle class="junction${kind === 'sig' ? ' sig-junction' : ''}" ${own} cx="${x}" cy="${y}" r="3"/>`);
    }
    return out.join('');
  }

  /**
   * The segments a net is drawn with: its saved drawing reconciled with the
   * pins as they are now, or the automatic route if it was never edited.
   */
  private segmentsOf(net: Net, pins: PinGeom[]): Seg[] {
    const terms: Terminal[] = pins.map((p) => {
      const g = this.geoms.get(p.blockId);
      return { x: p.x, y: p.y, dir: p.dir, blockId: p.blockId, box: g ? { x: g.x, y: g.y, w: g.w, h: g.h } : null };
    });
    const clear = (x: number, y1: number, y2: number, own: string) => this.columnClear(x, y1, y2, own);
    return net.wires ? reconcile(net.wires, terms, clear) : autoRoute(terms, clear);
  }

  /**
   * Redraws only the named nets, or signals' links. Every pointer move of a
   * drag lands here, so it replaces just those groups and wires their
   * listeners, rather than rebuilding the diagram and every listener in it.
   */
  private redrawWires(kind: WireKind, names: Iterable<string>) {
    const sheet = this.sheet;
    const layer = this.root.querySelector(kind === 'net' ? '.layer-nets' : '.layer-slinks');
    if (!sheet || !layer) return;
    const want = new Set(names);
    for (const el of Array.from(layer.children) as SVGGElement[]) {
      const name = kind === 'net' ? el.dataset.netg : el.dataset.sigg;
      if (name === undefined || !want.has(name)) continue;
      let markup: string | null = null;
      if (kind === 'net') {
        const net = sheet.nets.find((x) => x.name === name);
        if (net) markup = this.netGroup(net);
      } else {
        const sig = sheet.signals.find((x) => x.name === name);
        if (sig) markup = this.sigGroup(sig);
      }
      if (markup === null) continue;
      const tmp = document.createElementNS(SVG_NS, 'g');
      tmp.innerHTML = markup;
      const fresh = tmp.firstElementChild;
      if (!fresh) continue;
      el.replaceWith(fresh);
      if (!this.lite) this.wireNetEvents(fresh);
      this.paintSelection(fresh);
    }
  }

  private redrawNets(names: Iterable<string>) {
    this.redrawWires('net', names);
  }

  /** The signals a block reads or writes through its logic ports. */
  private signalsOf(b: Block): string[] {
    return b.logic.map((a) => a.text.trim()).filter((n) => this.chipGeoms.has(n));
  }

  /**
   * Edited wires attached to whatever is being dragged: each one's drawing
   * when the drag began, and its ends there, with how to find where each end
   * is now. Every step of the drag stretches them from that starting point
   * (see dragEnd), so they keep their shape instead of being re-routed.
   */
  private rubber: { kind: WireKind; name: string; base: Seg[]; ends: { from: Pt; now: () => Pt | null }[] }[] = [];

  /**
   * True while something is being dragged. Wires redrawn then are drawn bare
   * — no grips, bend handles, tooltips or listeners — since none of that can
   * be used mid-drag, and building it for every wire on every grid step was
   * most of a step's cost. The drop draws them in full again.
   */
  private lite = false;

  /** The edited nets and signal links on a block, ready to stretch as it moves. */
  private grabBlockWires(b: Block) {
    this.rubber = [];
    const g = this.geoms.get(b.id);
    if (!g) return;
    const nets = new Map<string, number[]>();
    for (const p of g.pins) if (!p.ref) nets.set(p.net, [...(nets.get(p.net) ?? []), p.index]);
    for (const [net, idx] of nets) {
      this.grab('net', net, idx.map((i) => {
        const p0 = g.pins.find((p) => p.index === i)!;
        return {
          from: [p0.x, p0.y] as Pt,
          now: () => {
            const p = this.geoms.get(b.id)?.pins.find((q) => q.index === i);
            return p ? [p.x, p.y] : null;
          },
        };
      }));
    }
    for (const sig of new Set(g.logic.map((l) => l.signal))) {
      this.grab('sig', sig, g.logic.filter((l) => l.signal === sig).map((l) => ({
        from: [l.x, l.y] as Pt,
        now: () => {
          const nl = this.geoms.get(b.id)?.logic.find((q) => q.arg === l.arg);
          return nl ? [nl.x, nl.y] : null;
        },
      })));
    }
  }

  /** A chip's edited links, ready to stretch as it moves. */
  private grabChipWires(name: string) {
    this.rubber = [];
    const c = this.chipGeoms.get(name);
    if (!c) return;
    this.grab('sig', name, [{ from: chipAnchor(c), now: () => { const n = this.chipGeoms.get(name); return n ? chipAnchor(n) : null; } }]);
  }

  private grab(kind: WireKind, name: string, ends: { from: Pt; now: () => Pt | null }[]) {
    const o = this.owner(kind, name);
    const base = this.drawn.get(wireKey(kind, name));
    if (o?.wires && base) this.rubber.push({ kind, name, base, ends });
  }

  /**
   * Stretches every grabbed wire to where its ends are now. A wire that does
   * not end where expected keeps its saved drawing, and drawing it reconciles
   * it the old way — its branch re-routed.
   */
  private stretchGrabbed() {
    for (const r of this.rubber) {
      const fixed = this.fixedPoints(r.kind, r.name);
      let segs: Seg[] | null = r.base;
      for (const end of r.ends) {
        const to = end.now();
        if (segs && to) segs = dragEnd(segs, end.from, to, fixed);
      }
      const o = this.owner(r.kind, r.name);
      if (o) o.wires = segs ?? r.base;
    }
  }

  /**
   * Rotates or mirrors a block. Its edited wires are not re-routed: each one
   * keeps its drawing and gets new bends out to the port where it now is,
   * leaving it the way the turned symbol does (see rewirePin). Saves those
   * wires; the caller saves the transform itself.
   */
  transformBlock(id: string, rot: number, flipX: boolean, flipY: boolean) {
    const b = this.sheet?.blocks.find((x) => x.id === id);
    const before = this.geoms.get(id);
    if (!b || !before) return;
    const oldPins = before.pins.map((p) => ({ ...p }));
    const oldLogic = before.logic.map((l) => ({ ...l }));

    b.rot = rot;
    b.flipX = flipX;
    b.flipY = flipY;
    const g = this.symbolGeom(b) ?? this.boxGeom(b);
    this.geoms.set(id, g);
    const box = { x: g.x, y: g.y, w: g.w, h: g.h };

    const changed: [WireKind, string][] = [];
    const nets = new Set(oldPins.filter((p) => !p.ref).map((p) => p.net));
    for (const net of nets) {
      const o = this.owner('net', net);
      let segs = this.drawn.get(wireKey('net', net));
      if (!o?.wires || !segs) continue;
      const fixed = this.fixedPoints('net', net);
      for (const p of oldPins.filter((q) => q.net === net && !q.ref)) {
        const np = g.pins.find((q) => q.index === p.index);
        if (!np) continue;
        segs = rewirePin(segs, [p.x, p.y], p.dir, [np.x, np.y], np.dir, fixed, box) ?? segs;
      }
      o.wires = segs;
      changed.push(['net', net]);
    }
    for (const sig of new Set(oldLogic.map((l) => l.signal))) {
      const o = this.owner('sig', sig);
      let segs = this.drawn.get(wireKey('sig', sig));
      if (!o?.wires || !segs) continue;
      const fixed = this.fixedPoints('sig', sig);
      for (const l of oldLogic.filter((q) => q.signal === sig)) {
        const nl = g.logic.find((q) => q.arg === l.arg);
        if (!nl) continue;
        segs = rewirePin(segs, [l.x, l.y], l.dir, [nl.x, nl.y], nl.dir, fixed, box) ?? segs;
      }
      o.wires = segs;
      changed.push(['sig', sig]);
    }

    this.render(this.sheet);
    for (const [kind, name] of changed) this.saveWires(kind, name);
  }

  /** After a drop: saves the wires that were stretched, and lets go of them. */
  private releaseGrabbed() {
    for (const r of this.rubber) this.saveWires(r.kind, r.name);
    this.rubber = [];
  }

  /**
   * While a block is being dragged: puts it at (x, y) in the model and
   * redraws the wires attached to it — nets and signal links — so they
   * follow the block instead of waiting for the drop.
   */
  private previewBlockAt(b: Block, x: number, y: number) {
    b.x = x;
    b.y = y;
    const g = this.symbolGeom(b) ?? this.boxGeom(b);
    this.geoms.set(b.id, g);
    this.stretchGrabbed();
    this.redrawNets(g.pins.filter((p) => !p.ref).map((p) => p.net));
    this.redrawWires('sig', this.signalsOf(b));
  }

  /**
   * Whether a vertical wire at x between y1 and y2 stays clear of every
   * block but `own` — the one the wire leaves from, which it runs away from.
   */
  private columnClear(x: number, y1: number, y2: number, own: string): boolean {
    const top = Math.min(y1, y2), bottom = Math.max(y1, y2);
    for (const g of this.geoms.values()) {
      if (g.block.id === own) continue;
      if (x > g.x - 2 && x < g.x + g.w + 2 && bottom > g.y && top < g.y + g.h) return false;
    }
    return true;
  }

  private netLabel(name: string, x: number, y: number, anchor: string): string {
    return `<text class="net-label" data-net="${esc(name)}" data-netlabel="${esc(name)}" ` +
           `x="${x}" y="${y}" text-anchor="${anchor}">${esc(name)}</text>`;
  }

  private renderSignalLinks(sheet: Sheet): string {
    return sheet.signals.map((s) => this.sigGroup(s)).join('');
  }

  /** One signal's links in their own group, so a drag can redraw just them. */
  private sigGroup(sig: Signal): string {
    return `<g class="sigg" data-sigg="${esc(sig.name)}">${this.renderSignal(sig)}</g>`;
  }

  /**
   * Where a signal's links end: the bottom of its chip, and the top of every
   * block that reads or writes it through a logic port. `reads` are the ends
   * at blocks that take the value in — they get an arrowhead, so the drawing
   * shows which way the value flows (direction comes from the module's
   * declared input/output).
   */
  private signalTerminals(name: string): { terms: Terminal[]; reads: { x: number; y: number; dir: Dir }[] } {
    const c = this.chipGeoms.get(name);
    if (!c || !this.sheet) return { terms: [], reads: [] };
    const [chx, chy] = chipAnchor(c);
    const terms: Terminal[] = [{ x: chx, y: chy, dir: 'down', blockId: '', box: null }];
    const reads: { x: number; y: number; dir: Dir }[] = [];
    for (const g of this.geoms.values()) {
      for (const l of g.logic) {
        if (l.signal !== name) continue;
        terms.push({ x: l.x, y: l.y, dir: l.dir, blockId: g.block.id, box: { x: g.x, y: g.y, w: g.w, h: g.h } });
        if (l.flow === 'in') reads.push({ x: l.x, y: l.y, dir: l.dir });
      }
    }
    return { terms, reads };
  }

  /**
   * A signal's links, drawn and edited exactly like a net: routed
   * automatically until edited, then saved, with only a moved block's branch
   * ever re-routed.
   */
  private renderSignal(sig: Signal): string {
    const key = wireKey('sig', sig.name);
    const { terms, reads } = this.signalTerminals(sig.name);
    if (terms.length < 2) {
      this.drawn.delete(key);
      return '';
    }
    const clear = (x: number, y1: number, y2: number, own: string) => this.columnClear(x, y1, y2, own);
    const segs = sig.wires ? reconcile(sig.wires, terms, clear) : autoRoute(terms, clear);
    this.drawn.set(key, segs);
    const n = esc(sig.name);
    const arrows = reads.map(({ x, y, dir }) => {
      // Tip on the port, base a little out along the way the link leaves.
      const [ux, uy] = stubVec(dir);
      const bx = x + ux * 7, by = y + uy * 7;
      return `<polygon class="slink-arrow" data-sig="${n}" ` +
        `points="${bx - uy * 4},${by + ux * 4} ${bx + uy * 4},${by - ux * 4} ${x},${y}"/>`;
    });
    return this.wireMarkup('sig', sig.name, segs, terms.map((t) => [t.x, t.y] as Pt)) + arrows.join('');
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
        this.logicMarkup(g) +
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
    const connected = new Set([...(b.symPins ?? []).map((j) => sym.pins![j].name), ...g.slots]);
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
      this.logicMarkup(g) +
      `</g>`
    );
  }

  /**
   * A block's logic ports: any rail they sit on, and an invisible target on
   * each that names the port and its signal on hover. The link itself shows
   * where the port is; names stay off the drawing, where at a 16px pitch
   * they would only collide.
   */
  private logicMarkup(g: Geom): string {
    const out: string[] = [];
    for (const r of g.rails) {
      out.push(`<path class="logic-rail" d="M${r[0]} ${r[1]} L${r[2]} ${r[3]}"/>`);
    }
    for (const l of g.logic) {
      const port = l.name || (l.flow === 'in' ? 'input' : 'output');
      out.push(
        `<circle class="logic-hit" data-sig="${esc(l.signal)}" cx="${l.x}" cy="${l.y}" r="6">` +
        `<title>${esc(port)} ${l.flow === 'in' ? '←' : '→'} ${esc(l.signal)}</title></circle>`,
      );
    }
    return out.join('');
  }

  /** Reference, type and value beside a symbol, like a schematic's fields. */
  private symbolLabels(b: Block, g: Geom): string {
    const lines: { text: string; cls: string }[] = [{ text: trunc(b.label, 14), cls: 'block-label' }];
    const params = b.params.map((p) => p.text).join(', ');
    if (b.kind === 'instance') lines.push({ text: trunc(b.typeName, 16), cls: 'block-type' });
    if (params) lines.push({ text: trunc(params, 22), cls: 'block-param' });

    const used = new Set([...g.pins.map((p) => p.dir), ...g.logic.map((l) => l.dir)]);
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

  /**
   * Two clicks on the same handle within a short interval. Detected by hand
   * rather than with `dblclick`: the handles' pointerdown calls
   * preventDefault, which is allowed to suppress the compatibility mouse
   * events a native dblclick is built from.
   */
  private lastTap = { key: '', t: 0 };
  private isDoubleTap(key: string): boolean {
    const now = performance.now();
    const dbl = this.lastTap.key === key && now - this.lastTap.t < 400;
    this.lastTap = dbl ? { key: '', t: 0 } : { key, t: now };
    return dbl;
  }

  /** The net or signal a wire belongs to — whatever holds its `wires`. */
  private owner(kind: WireKind, name: string): Net | Signal | undefined {
    return kind === 'net'
      ? this.sheet?.nets.find((x) => x.name === name)
      : this.sheet?.signals.find((x) => x.name === name);
  }

  /** The points no edit of this wire may move: a net's pins, a signal's ends. */
  private fixedPoints(kind: WireKind, name: string): Pt[] {
    return kind === 'net'
      ? this.pinsOfNet(name).map((p) => [p.x, p.y] as Pt)
      : this.signalTerminals(name).terms.map((t) => [t.x, t.y] as Pt);
  }

  private selectWire(kind: WireKind, name: string) {
    if (kind === 'net') this.select(null, name, null);
    else this.select(null, null, name);
  }

  /** Saves a wire's drawing as it now is — or, when null, its return to automatic. */
  private saveWires(kind: WireKind, name: string) {
    const o = this.owner(kind, name);
    if (!o) return;
    if (kind === 'net') this.h.onSetNetWires(name, o.wires);
    else this.h.onSetSignalWires(name, o.wires);
  }

  /**
   * After something moved: an edited wire whose branch to it was re-routed
   * when it was drawn is saved as drawn, so the sidecar holds what is on
   * screen rather than re-deriving it every time.
   */
  private saveIfReconciled(kind: WireKind, name: string) {
    const o = this.owner(kind, name);
    const drawn = this.drawn.get(wireKey(kind, name));
    if (o?.wires && drawn && !sameDrawing(o.wires, drawn)) {
      o.wires = drawn;
      this.saveWires(kind, name);
    }
  }

  private saveReconciled(b: Block) {
    for (const p of b.pins) if (!p.ref) this.saveIfReconciled('net', p.net);
    for (const s of this.signalsOf(b)) this.saveIfReconciled('sig', s);
  }

  private closeMenu: (() => void) | null = null;

  /** Right-click on a wire: select what it belongs to, or return it to automatic routing. */
  private openWireMenu(kind: WireKind, name: string, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.closeMenu?.();
    const o = this.owner(kind, name);
    const wrap = this.host.querySelector('.canvas-wrap') as HTMLElement | null;
    if (!o || !wrap) return;

    const r = wrap.getBoundingClientRect();
    const m = document.createElement('div');
    m.className = 'wire-menu';
    m.style.left = `${e.clientX - r.left}px`;
    m.style.top = `${e.clientY - r.top}px`;
    m.innerHTML =
      `<div class="wire-menu-title">${esc(name)}${kind === 'sig' ? ' (signal)' : ''}` +
      `${o.wires ? ' · edited' : ' · automatic'}</div>` +
      `<button data-act="select">Select ${kind === 'net' ? 'net' : 'signal'}</button>` +
      `<button data-act="auto"${o.wires ? '' : ' disabled'}>Reset to automatic routing</button>`;
    wrap.appendChild(m);

    const close = () => {
      m.remove();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', onKey, true);
      this.closeMenu = null;
    };
    const outside = (ev: Event) => { if (!m.contains(ev.target as Node)) close(); };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
    this.closeMenu = close;

    m.querySelector('[data-act="select"]')!.addEventListener('click', () => {
      close();
      this.selectWire(kind, name);
    });
    m.querySelector('[data-act="auto"]')!.addEventListener('click', () => {
      close();
      o.wires = null;
      this.redrawWires(kind, [name]);
      this.saveWires(kind, name);
    });
  }

  /**
   * Listeners for wiring: segment and bend edits, net hover, net labels. Scoped
   * so that a single redrawn net group can be wired on its own.
   */
  private wireNetEvents(scope: Element) {
    // Segments: drag to move one perpendicular to itself — a horizontal one
    // up or down, a vertical one sideways — with the wires around it
    // stretching to follow, and anything brought into line merging with it.
    // Double-click to separate it there into a step: the part to the left
    // (or above) is pushed aside, ready to be dragged into shape — or back
    // into line, where it merges again. Every edit starts from exactly what is on
    // screen and freezes the whole wire: from then on its drawing is saved,
    // and only a moved block's own branch is ever re-routed. Nets and
    // signal links work the same way.
    //
    // The listeners live on window rather than on the grip, because each
    // move redraws the wire and replaces the element.
    scope.querySelectorAll('[data-seg]').forEach((el) => {
      const kind = (el as SVGElement).dataset.wk as WireKind;
      const name = (el as SVGElement).dataset.wn!;
      const idx = Number((el as SVGElement).dataset.seg);
      el.addEventListener('pointerdown', (ev) => {
        const e = ev as PointerEvent;
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        const o = this.owner(kind, name);
        const base = this.drawn.get(wireKey(kind, name));
        if (!o || !base?.[idx]) return;
        const fixed = this.fixedPoints(kind, name);
        const horizontal = base[idx][1] === base[idx][3];
        const startX = e.clientX, startY = e.clientY;
        let moved = false;
        let last = 0;

        const move = (me: PointerEvent) => {
          const dx = (me.clientX - startX) / this.scale;
          const dy = (me.clientY - startY) / this.scale;
          if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
          moved = true;
          this.lite = true;
          // Pointer events come far faster than the grid steps; redraw only
          // when the snapped position actually changes.
          const d = snap(horizontal ? dy : dx);
          if (d === last) return;
          last = d;
          o.wires = moveSegment(base, idx, d, fixed);
          this.redrawWires(kind, [name]);
        };
        const up = (ue: PointerEvent) => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          if (moved) {
            this.lite = false;
            this.redrawWires(kind, [name]);
            this.saveWires(kind, name);
          } else if (this.isDoubleTap(`seg:${kind}:${name}:${idx}`)) {
            const p = this.toWorld(ue.clientX, ue.clientY);
            o.wires = separateAt(base, idx, p.x, p.y, fixed);
            this.redrawWires(kind, [name]);
            this.saveWires(kind, name);
          } else {
            this.selectWire(kind, name);
          }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      });
      el.addEventListener('contextmenu', (ev) => this.openWireMenu(kind, name, ev as MouseEvent));
    });

    // Bends: drag to move one in both directions; double-click to take it
    // out, flattening its shorter side.
    scope.querySelectorAll('[data-pt]').forEach((el) => {
      const kind = (el as SVGElement).dataset.wk as WireKind;
      const name = (el as SVGElement).dataset.wn!;
      const pt = (el as SVGElement).dataset.pt!.split(',').map(Number) as Pt;
      el.addEventListener('pointerdown', (ev) => {
        const e = ev as PointerEvent;
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        const o = this.owner(kind, name);
        const base = this.drawn.get(wireKey(kind, name));
        if (!o || !base) return;
        const fixed = this.fixedPoints(kind, name);
        const startX = e.clientX, startY = e.clientY;
        let moved = false;
        let last = '0,0';

        const move = (me: PointerEvent) => {
          const dx = (me.clientX - startX) / this.scale;
          const dy = (me.clientY - startY) / this.scale;
          if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
          moved = true;
          this.lite = true;
          const sx = snap(dx), sy = snap(dy);
          if (`${sx},${sy}` === last) return;
          last = `${sx},${sy}`;
          o.wires = moveCorner(base, pt, sx, sy, fixed);
          this.redrawWires(kind, [name]);
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          if (moved) {
            this.lite = false;
            this.redrawWires(kind, [name]);
            this.saveWires(kind, name);
          } else if (this.isDoubleTap(`bend:${kind}:${name}:${pt}`)) {
            o.wires = removePoint(base, pt, fixed);
            this.redrawWires(kind, [name]);
            this.saveWires(kind, name);
          } else {
            this.selectWire(kind, name);
          }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      });
      el.addEventListener('contextmenu', (ev) => this.openWireMenu(kind, name, ev as MouseEvent));
    });

    // Net hover/selection.
    scope.querySelectorAll('[data-net]').forEach((el) => {
      el.addEventListener('mouseenter', () => this.setHotNet((el as SVGElement).dataset.net!));
      el.addEventListener('mouseleave', () => this.setHotNet(null));
    });
    scope.querySelectorAll('[data-netlabel]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.select(null, (el as SVGElement).dataset.netlabel!, null);
      });
    });
  }

  private wireEvents() {
    this.wireNetEvents(this.root);

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
        this.grabChipWires(name);
        (el as SVGGElement).setPointerCapture(e.pointerId);
      });

      el.addEventListener('pointermove', (ev) => {
        if (!dragging) return;
        const e = ev as PointerEvent;
        const dx = (e.clientX - sx) / this.scale;
        const dy = (e.clientY - sy) / this.scale;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
        if (!moved) return;
        const nx = snap(ox + dx), ny = snap(oy + dy);
        if (nx === c.x && ny === c.y) return;
        (el as SVGGElement).setAttribute('transform', `translate(${nx - ox} ${ny - oy})`);
        // The dashed links to this chip follow it, stretching if edited.
        this.lite = true;
        c.x = nx; c.y = ny;
        this.stretchGrabbed();
        this.redrawWires('sig', [name]);
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
        const nx = snap(ox + (e.clientX - sx) / this.scale);
        const ny = snap(oy + (e.clientY - sy) / this.scale);
        c.x = nx; c.y = ny;
        c.sig.x = nx; c.sig.y = ny;
        this.stretchGrabbed();
        this.lite = false;
        (el as SVGGElement).setAttribute('transform', 'translate(0 0)');
        this.h.onMoveSignal(name, nx, ny);
        this.render(this.sheet);
        this.releaseGrabbed();
        this.saveIfReconciled('sig', name);
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
        // The block's saved position — NOT the geometry's bounding box. For a
        // box the two coincide, but a symbol's position is its origin, inside
        // the drawing, and starting from the box corner dropped every symbol
        // up and left of where it was let go.
        ox = g.block.x; oy = g.block.y;
        this.grabBlockWires(g.block);
        (el as SVGGElement).setPointerCapture(e.pointerId);
      });

      el.addEventListener('pointermove', (ev) => {
        if (!dragging) return;
        const e = ev as PointerEvent;
        const dx = (e.clientX - sx) / this.scale;
        const dy = (e.clientY - sy) / this.scale;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
        if (!moved) return;
        // The preview sits on the same grid the drop snaps to, so the block
        // lands exactly where it was shown. The block's own markup is only
        // translated; the wires attached to it are redrawn to follow it,
        // once per grid step rather than once per pointer event.
        const nx = snap(ox + dx), ny = snap(oy + dy);
        if (nx === g.block.x && ny === g.block.y) return;
        (el as SVGGElement).setAttribute('transform', `translate(${nx - ox} ${ny - oy})`);
        this.lite = true;
        this.previewBlockAt(g.block, nx, ny);
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
        const nx = snap(ox + dx);
        const ny = snap(oy + dy);
        this.previewBlockAt(g.block, nx, ny); // final stretch, at exactly the drop position
        this.lite = false;
        (el as SVGGElement).setAttribute('transform', 'translate(0 0)');
        this.h.onMoveBlock(id, nx, ny);
        this.render(this.sheet);
        this.releaseGrabbed();
        this.saveReconciled(g.block);
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

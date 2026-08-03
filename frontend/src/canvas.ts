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
 */

import { iconSvg, groundSymbol } from './icons';
import type { SafeSheet as Sheet, SafeBlock as Block, Signal } from './types';

const BLOCK_W = 152;
const BLOCK_MIN_H = 76;
const PIN_SPACING = 20;
const PIN_STUB = 18;
const HEADER_H = 44;

export interface CanvasHandlers {
  onSelectBlock(id: string | null): void;
  onSelectNet(name: string | null): void;
  onSelectSignal(name: string | null): void;
  onOpenBlock(block: Block): void;
  onMoveBlock(id: string, x: number, y: number): void;
  onMoveSignal(name: string, x: number, y: number): void;
  onMoveNetTrunk(net: string, x: number, dy: number): void;
  onDropCatalog(payload: string, x: number, y: number): void;
}

interface Geom {
  block: Block;
  x: number;
  y: number;
  w: number;
  h: number;
  pins: PinGeom[];
}

interface PinGeom {
  index: number;
  name: string;
  net: string;
  x: number;
  y: number;
  dir: 'left' | 'right' | 'up' | 'down';
}

/** Unit vector a pin's stub leaves along. */
function stubVec(dir: PinGeom['dir']): [number, number] {
  switch (dir) {
    case 'left': return [-1, 0];
    case 'right': return [1, 0];
    case 'up': return [0, -1];
    default: return [0, 1];
  }
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
            <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" fill="#1a2030"/>
            </pattern>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4"
                    markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0 1 L7 4 L0 7 z" fill="var(--state)"/>
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
    bg?.setAttribute('transform', `translate(${this.tx % (24 * this.scale)} ${this.ty % (24 * this.scale)})`);
    const pat = this.svg.querySelector('#grid') as SVGPatternElement;
    pat?.setAttribute('width', String(24 * this.scale));
    pat?.setAttribute('height', String(24 * this.scale));
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
      if (target.closest('.block') || target.closest('.chip') || target.closest('[data-trunk]')) return;

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

      const g: Geom = { block: b, x: b.x, y: b.y, w, h, pins: [] };

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
        g.pins.push({ index: p.index, name: p.name, net: p.net, x, y, dir });
      });

      this.geoms.set(b.id, g);
    }

    // Signal chips carry their own saved position, exactly like blocks; the
    // backend seeds unplaced ones into a lane above the diagram.
    for (const s of sheet.signals) {
      const w = Math.max(64, s.name.length * 7 + 44);
      this.chipGeoms.set(s.name, { x: s.x, y: s.y, w, h: 26, sig: s });
    }
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

      const joinYs: number[] = [];
      for (const s of stubEnds) {
        const p = s.pin;
        const horizontal = s.dir === 'left' || s.dir === 'right';
        const jointY = s.y + dy;

        // With no manual offset a side pin runs straight across, unless the
        // channel sits behind it — in which case route around the block
        // rather than drawing back over it.
        const doublesBack = horizontal && dy === 0 &&
          ((s.dir === 'right' && trunkX < s.x) || (s.dir === 'left' && trunkX > s.x));

        if (horizontal && dy === 0 && !doublesBack) {
          out.push(`<path class="wire" data-net="${esc(net.name)}" d="M${p.x} ${p.y} H${trunkX}"/>`);
          joinYs.push(p.y);
          continue;
        }
        if (doublesBack) {
          const g = this.geomOfPin(p);
          const above = g ? p.y < g.y + g.h / 2 : true;
          const detourY = g ? (above ? g.y - 14 : g.y + g.h + 14) : p.y - 14;
          out.push(
            `<path class="wire" data-net="${esc(net.name)}" ` +
            `d="M${p.x} ${p.y} H${s.x} V${detourY} H${trunkX}"/>`,
          );
          joinYs.push(detourY);
          continue;
        }

        // General case: out along the stub, vertically to the joint, then
        // across to the channel. Always orthogonal for any pin direction.
        out.push(
          `<path class="wire" data-net="${esc(net.name)}" ` +
          `d="M${p.x} ${p.y} L${s.x} ${s.y} V${jointY} H${trunkX}"/>`,
        );
        joinYs.push(jointY);
      }

      const minY = Math.min(...joinYs);
      const maxY = Math.max(...joinYs);
      if (maxY > minY) {
        // The trunk is the grab handle for re-routing the net. A transparent
        // wide stroke sits under it so it can be grabbed without precision.
        out.push(
          `<path class="trunk-grip" data-trunk="${esc(net.name)}" d="M${trunkX} ${minY} V${maxY}"/>` +
          `<path class="wire trunk${net.hasTrunk ? ' pinned' : ''}" data-net="${esc(net.name)}" ` +
          `data-trunk="${esc(net.name)}" d="M${trunkX} ${minY} V${maxY}"/>`,
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
    const stubs = pins.map((p) => p.x + (p.dir === 'left' ? -PIN_STUB : PIN_STUB));
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
      const boxStroke = unresolved ? ' style="stroke:var(--danger)"' : '';

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

/**
 * Waveform viewer.
 *
 * Drawing is plain canvas 2D over data the Go side has already decimated to
 * the plot's pixel width, so the cost of a frame does not depend on how many
 * samples the run produced. Nothing is plotted until the user picks a signal:
 * a run with fifty saved nodes should open to an empty grid, not fifty
 * overlapping traces.
 */

import * as API from '../wailsjs/go/main/App';
import { esc } from './canvas';
import type { PlotInfo, Trace, Spectrum, Measurement, THDResult } from './types';

/**
 * Reads a design token. Canvas 2D cannot resolve `var()`, so anything drawn
 * into the bitmap has to look the value up — going through the tokens rather
 * than hardcoding hex keeps the plot and the DOM in step.
 */
const css = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Trace colours.
 *
 * The design system's four colours plus green do the work, in domain order:
 * yellow is the discrete/logic side, blue the continuous/plant side, red the
 * seam. Past the fifth trace there is nothing left in the brand, so the tail
 * is tints of the same five — flagged as an extension, like `--color-green`.
 * A run with fifty saved nodes is meant to be read a few signals at a time.
 */
const PALETTE = [
  '#ffd21e', // yellow — logic
  '#5b86ff', // blue-bright, lightened to read on navy ink — physics
  '#e8202a', // red — the seam
  '#f2ead2', // cream
  '#3fbf7f', // green, lightened for on-navy
  '#ffe98a', // yellow tint
  '#a9c0ff', // blue tint
  '#9aa3c4', // on-inverse muted
];

interface SignalState {
  on: boolean;
  axis: 'y1' | 'y2';
  color: string;
}

type Mode = 'time' | 'fft';

export class Plotter {
  private host: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private menu!: HTMLElement;

  info: PlotInfo | null = null;
  private sig = new Map<string, SignalState>();
  private traces: Trace[] = [];
  private spectrum: Spectrum | null = null;
  private mode: Mode = 'time';

  // View window in data coordinates.
  private x0 = 0;
  private x1 = 0;
  private y1Lo = -1; private y1Hi = 1;
  private y2Lo = -1; private y2Hi = 1;
  private autoY = true;

  private cursor: { x: number; y: number } | null = null;
  private pendingFetch = 0;

  constructor(host: HTMLElement, private onClose: () => void, private log: (s: string) => void) {
    this.host = host;
    this.build();
  }

  // ── Structure ─────────────────────────────────────────────────────────

  private build() {
    this.host.innerHTML = `
      <div class="plot-shell">
        <div class="plot-bar">
          <span class="hv-label" style="color:var(--color-yellow)">Scope</span>
          <span class="plot-file" id="pl-file">no results loaded</span>
          <span class="grow"></span>
          <button id="pl-open" class="inverse">Open CSV</button>
          <button id="pl-fit" class="inverse">Fit</button>
          <button id="pl-export" class="inverse">Export</button>
          <button id="pl-close" class="inverse">Close</button>
        </div>
        <div class="plot-body">
          <div class="plot-canvas-wrap">
            <canvas id="pl-canvas"></canvas>
            <div class="plot-empty" id="pl-empty">
              <div>
                <h3>Nothing plotted yet</h3>
                <p>Pick signals from the list on the right.</p>
              </div>
            </div>
            <div class="plot-readout" id="pl-readout"></div>
          </div>
          <div class="plot-menu" id="pl-menu"></div>
        </div>
      </div>`;

    this.canvas = this.host.querySelector('#pl-canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.menu = this.host.querySelector('#pl-menu') as HTMLElement;

    this.host.querySelector('#pl-close')!.addEventListener('click', () => this.onClose());
    this.host.querySelector('#pl-fit')!.addEventListener('click', () => this.fit());
    this.host.querySelector('#pl-open')!.addEventListener('click', () => this.pick());
    this.host.querySelector('#pl-export')!.addEventListener('click', () => this.exportData());

    this.attachInteraction();
    window.addEventListener('resize', () => this.resize());
    this.renderMenu();
  }

  // ── Loading ───────────────────────────────────────────────────────────

  async pick() {
    try {
      const info = (await API.PickPlot()) as unknown as PlotInfo;
      if (info?.open) this.adopt(info);
    } catch (e) { this.err(e); }
  }

  async open(path: string) {
    try {
      const info = (await API.OpenPlot(path)) as unknown as PlotInfo;
      this.adopt(info);
    } catch (e) { this.err(e); }
  }

  /** Takes a freshly loaded dataset, keeping any selection that still exists. */
  private adopt(info: PlotInfo) {
    const previous = new Map(this.sig);
    this.info = info;
    this.sig.clear();

    (info.signals ?? []).forEach((name, i) => {
      const old = previous.get(name);
      this.sig.set(name, old ?? {
        on: false, // nothing is plotted until asked for
        axis: 'y1',
        color: PALETTE[i % PALETTE.length],
      });
    });

    this.mode = 'time';
    this.spectrum = null;
    this.x0 = info.tMin;
    this.x1 = info.tMax;
    this.autoY = true;

    (this.host.querySelector('#pl-file') as HTMLElement).textContent =
      `${info.name} · ${info.rows.toLocaleString()} rows · ${(info.signals ?? []).length} signals`;

    this.log(`Loaded ${info.name}: ${info.rows.toLocaleString()} rows, ` +
             `${(info.signals ?? []).length} signals, Fs ≈ ${fmtEng(info.fs)}Hz`);

    this.renderMenu();
    this.resize();
    this.refresh();
  }

  private selected(): string[] {
    return [...this.sig.entries()].filter(([, s]) => s.on).map(([n]) => n);
  }

  // ── Data fetch ────────────────────────────────────────────────────────

  /**
   * Asks Go for traces covering the current window at the current pixel
   * width. Requests are sequenced so a slow reply cannot overwrite a newer
   * one during a fast pan.
   */
  async refresh() {
    if (!this.info?.open) { this.draw(); return; }
    if (this.mode === 'fft') { this.draw(); return; }

    const names = this.selected();
    if (names.length === 0) { this.traces = []; this.draw(); return; }

    const token = ++this.pendingFetch;
    const buckets = Math.max(64, Math.floor(this.plotW()));
    try {
      const t = (await API.PlotSeries(names, this.x0, this.x1, buckets)) as unknown as Trace[];
      if (token !== this.pendingFetch) return; // superseded
      this.traces = t ?? [];
      if (this.autoY) this.autoScale();
      this.draw();
    } catch (e) { this.err(e); }
  }

  private autoScale() {
    const pick = (axis: 'y1' | 'y2') => {
      let lo = Infinity, hi = -Infinity;
      for (const tr of this.traces) {
        if (this.sig.get(tr.name)?.axis !== axis) continue;
        lo = Math.min(lo, tr.min);
        hi = Math.max(hi, tr.max);
      }
      if (!isFinite(lo) || !isFinite(hi)) return [-1, 1] as const;
      if (lo === hi) { lo -= 1; hi += 1; }
      const pad = (hi - lo) * 0.08;
      return [lo - pad, hi + pad] as const;
    };
    [this.y1Lo, this.y1Hi] = pick('y1');
    [this.y2Lo, this.y2Hi] = pick('y2');
  }

  fit() {
    if (!this.info) return;
    if (this.mode === 'fft' && this.spectrum) {
      this.draw();
      return;
    }
    this.x0 = this.info.tMin;
    this.x1 = this.info.tMax;
    this.autoY = true;
    this.refresh();
  }

  // ── Geometry ──────────────────────────────────────────────────────────

  private pad = { l: 70, r: 62, t: 16, b: 40 };
  private plotW() { return Math.max(10, this.canvas.clientWidth - this.pad.l - this.pad.r); }
  private plotH() { return Math.max(10, this.canvas.clientHeight - this.pad.t - this.pad.b); }

  resize() {
    const wrap = this.canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (w === 0 || h === 0) return;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  private sx(v: number): number {
    const [a, b] = this.mode === 'fft' ? this.fftRange() : [this.x0, this.x1];
    return this.pad.l + ((v - a) / (b - a || 1)) * this.plotW();
  }
  private sy(v: number, axis: 'y1' | 'y2'): number {
    const lo = axis === 'y2' ? this.y2Lo : this.y1Lo;
    const hi = axis === 'y2' ? this.y2Hi : this.y1Hi;
    return this.pad.t + (1 - (v - lo) / (hi - lo || 1)) * this.plotH();
  }
  private invX(px: number): number {
    const [a, b] = this.mode === 'fft' ? this.fftRange() : [this.x0, this.x1];
    return a + ((px - this.pad.l) / this.plotW()) * (b - a);
  }

  private fftRange(): [number, number] {
    const f = this.spectrum?.freqs ?? [];
    return f.length ? [f[0], f[f.length - 1]] : [0, 1];
  }

  // ── Drawing ───────────────────────────────────────────────────────────

  private draw() {
    const c = this.ctx;
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    c.clearRect(0, 0, W, H);

    const hasData = this.mode === 'fft' ? !!this.spectrum : this.traces.length > 0;
    (this.host.querySelector('#pl-empty') as HTMLElement).style.display =
      hasData ? 'none' : 'flex';

    this.drawGrid();
    if (!hasData) return;

    if (this.mode === 'fft') this.drawSpectrum();
    else this.drawTraces();

    this.drawCursor();
  }

  private drawGrid() {
    const c = this.ctx;
    const L = this.pad.l, T = this.pad.t;
    const W = this.plotW(), H = this.plotH();

    c.save();
    c.fillStyle = css('--surface-inverse');
    c.fillRect(L, T, W, H);

    // Hairlines inside the panel, the 2px keyline around it — the same rule
    // the DOM panels follow.
    c.strokeStyle = css('--canvas-hair');
    c.lineWidth = 1;
    c.font = '10px "Space Mono", ui-monospace, monospace';
    c.fillStyle = css('--text-on-inverse-muted');

    const [xa, xb] = this.mode === 'fft' ? this.fftRange() : [this.x0, this.x1];
    for (const v of ticks(xa, xb, 8)) {
      const x = Math.round(this.sx(v)) + 0.5;
      if (x < L || x > L + W) continue;
      c.beginPath(); c.moveTo(x, T); c.lineTo(x, T + H); c.stroke();
      c.textAlign = 'center';
      c.fillText(fmtEng(v), x, T + H + 15);
    }

    for (const v of ticks(this.y1Lo, this.y1Hi, 6)) {
      const y = Math.round(this.sy(v, 'y1')) + 0.5;
      if (y < T || y > T + H) continue;
      c.beginPath(); c.moveTo(L, y); c.lineTo(L + W, y); c.stroke();
      c.textAlign = 'right';
      c.fillText(fmtEng(v), L - 8, y + 3);
    }

    // The second axis only appears when something is assigned to it.
    if (this.hasY2()) {
      c.fillStyle = css('--color-yellow');
      for (const v of ticks(this.y2Lo, this.y2Hi, 6)) {
        const y = Math.round(this.sy(v, 'y2')) + 0.5;
        if (y < T || y > T + H) continue;
        c.textAlign = 'left';
        c.fillText(fmtEng(v), L + W + 8, y + 3);
      }
    }

    c.strokeStyle = css('--color-cream');
    c.lineWidth = 2;
    c.strokeRect(L + 1, T + 1, W - 2, H - 2);

    // The axis title is an uppercase mono label, like every other label.
    c.fillStyle = css('--color-cream');
    c.font = 'bold 10px "Space Mono", ui-monospace, monospace';
    c.textAlign = 'center';
    const xTitle = this.mode === 'fft' ? 'frequency · Hz' : (this.info?.xKey ?? 'x');
    c.fillText(xTitle.toUpperCase(), L + W / 2, T + H + 32);
    c.restore();
  }

  private hasY2(): boolean {
    for (const [name, s] of this.sig) {
      if (s.on && s.axis === 'y2' && (this.traces.some((t) => t.name === name))) return true;
    }
    return false;
  }

  private drawTraces() {
    const c = this.ctx;
    c.save();
    c.beginPath();
    c.rect(this.pad.l, this.pad.t, this.plotW(), this.plotH());
    c.clip();
    c.lineWidth = 1.4;
    c.lineJoin = 'round';

    for (const tr of this.traces) {
      const st = this.sig.get(tr.name);
      if (!st?.on) continue;
      c.strokeStyle = st.color;
      c.beginPath();
      for (let i = 0; i < tr.x.length; i++) {
        const x = this.sx(tr.x[i]);
        const y = this.sy(tr.y[i], st.axis);
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
    }
    c.restore();
  }

  private drawSpectrum() {
    const sp = this.spectrum!;
    const c = this.ctx;
    c.save();
    c.beginPath();
    c.rect(this.pad.l, this.pad.t, this.plotW(), this.plotH());
    c.clip();
    c.strokeStyle = css('--domain-physics');
    c.lineWidth = 1.6;
    c.beginPath();
    for (let i = 0; i < sp.freqs.length; i++) {
      const x = this.sx(sp.freqs[i]);
      const y = this.sy(sp.mags[i], 'y1');
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
    c.restore();
  }

  private drawCursor() {
    if (!this.cursor) return;
    const c = this.ctx;
    const L = this.pad.l, T = this.pad.t, W = this.plotW(), H = this.plotH();
    if (this.cursor.x < L || this.cursor.x > L + W) return;

    c.save();
    c.strokeStyle = css('--color-yellow');
    c.lineWidth = 1;
    c.setLineDash([3, 3]);
    c.beginPath();
    c.moveTo(this.cursor.x, T);
    c.lineTo(this.cursor.x, T + H);
    c.stroke();
    c.restore();

    // Report the value of each visible trace at the cursor.
    const xv = this.invX(this.cursor.x);
    const rows: string[] = [`<b>${this.mode === 'fft' ? 'f' : 'x'} = ${fmtEng(xv)}</b>`];
    const src = this.mode === 'fft'
      ? (this.spectrum ? [{ name: 'magnitude', x: this.spectrum.freqs, y: this.spectrum.mags }] : [])
      : this.traces;

    for (const tr of src as { name: string; x: number[]; y: number[] }[]) {
      const st = this.sig.get(tr.name);
      if (this.mode === 'time' && !st?.on) continue;
      const i = nearestIndex(tr.x, xv);
      if (i < 0) continue;
      const col = this.mode === 'fft' ? PALETTE[1] : (st?.color ?? PALETTE[3]);
      // A square keyed swatch, matching the domain swatches in the rails.
      rows.push(
        `<span style="display:inline-block;width:9px;height:9px;background:${col};` +
        `border:1px solid #000;vertical-align:middle"></span> ` +
        `${esc(tr.name)} = ${fmtEng(tr.y[i])}`);
    }
    const ro = this.host.querySelector('#pl-readout') as HTMLElement;
    ro.innerHTML = rows.join('<br>');
    ro.style.display = rows.length > 1 ? 'block' : 'none';
  }

  // ── Interaction ───────────────────────────────────────────────────────

  private attachInteraction() {
    const cv = this.canvas;

    cv.addEventListener('mousemove', (e) => {
      const r = cv.getBoundingClientRect();
      this.cursor = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.draw();
    });
    cv.addEventListener('mouseleave', () => {
      this.cursor = null;
      (this.host.querySelector('#pl-readout') as HTMLElement).style.display = 'none';
      this.draw();
    });

    // Wheel zooms about the pointer, keeping the value under it fixed.
    cv.addEventListener('wheel', (e) => {
      if (this.mode === 'fft' || !this.info) return;
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const anchor = this.invX(e.clientX - r.left);
      const k = e.deltaY < 0 ? 0.82 : 1 / 0.82;
      this.x0 = anchor - (anchor - this.x0) * k;
      this.x1 = anchor + (this.x1 - anchor) * k;
      const lo = this.info.tMin, hi = this.info.tMax;
      if (this.x0 < lo) this.x0 = lo;
      if (this.x1 > hi) this.x1 = hi;
      this.refresh();
    }, { passive: false });

    // Drag pans.
    cv.addEventListener('pointerdown', (e) => {
      if (this.mode === 'fft' || !this.info) return;
      const startX = e.clientX;
      const a = this.x0, b = this.x1;
      cv.setPointerCapture(e.pointerId);

      const move = (me: PointerEvent) => {
        const dx = (me.clientX - startX) / this.plotW() * (b - a);
        let nx0 = a - dx, nx1 = b - dx;
        const lo = this.info!.tMin, hi = this.info!.tMax;
        if (nx0 < lo) { nx1 += lo - nx0; nx0 = lo; }
        if (nx1 > hi) { nx0 -= nx1 - hi; nx1 = hi; }
        this.x0 = nx0; this.x1 = nx1;
        this.refresh();
      };
      const up = () => {
        cv.removeEventListener('pointermove', move);
        cv.removeEventListener('pointerup', up);
      };
      cv.addEventListener('pointermove', move);
      cv.addEventListener('pointerup', up);
    });

    cv.addEventListener('dblclick', () => this.fit());
  }

  // ── Right-hand menu ───────────────────────────────────────────────────

  private renderMenu() {
    const info = this.info;
    if (!info?.open) {
      this.menu.innerHTML = `
        <div class="plot-sec">
          <div class="insp-title">No results</div>
          <div class="empty-note">
            Run a simulation, or open a <code>simulation_output.csv</code> with the button above.
          </div>
        </div>`;
      return;
    }

    const sigRows = (info.signals ?? []).map((name) => {
      const s = this.sig.get(name)!;
      return `
        <div class="sigrow ${s.on ? 'on' : ''}" data-sig="${esc(name)}">
          <span class="swatch" style="background:${s.on ? s.color : 'transparent'};
                border-color:${s.color}"></span>
          <span class="signame" title="${esc(name)}">${esc(name)}</span>
          <select class="axis-sel" data-axis="${esc(name)}" title="Y axis">
            <option value="y1"${s.axis === 'y1' ? ' selected' : ''}>Y1</option>
            <option value="y2"${s.axis === 'y2' ? ' selected' : ''}>Y2</option>
          </select>
          ${info.computed?.includes(name)
            ? `<span class="del" data-del="${esc(name)}" title="Remove computed curve">×</span>` : ''}
        </div>`;
    }).join('');

    const sigOpts = (info.signals ?? [])
      .map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    const xOpts = (info.columns ?? [])
      .map((n) => `<option value="${esc(n)}"${n === info.xKey ? ' selected' : ''}>${esc(n)}</option>`).join('');

    this.menu.innerHTML = `
      <div class="plot-sec">
        <div class="insp-title">Signals</div>
        <div class="row"><label>X axis</label><select id="pl-x">${xOpts}</select></div>
        <div class="siglist">${sigRows || '<div class="empty-note">No signals.</div>'}</div>
        <div class="row" style="margin-top:8px">
          <button id="pl-none">Clear all</button>
          <button id="pl-all">Show all</button>
        </div>
      </div>

      <details class="plot-sec">
        <summary>Maths</summary>
        <div class="empty-note">Combine signals, e.g. <code>main.a - main.b</code>. Functions: abs, sqrt, sin, cos, exp, log, min, max, pow.</div>
        <div class="row"><label>name</label><input id="pl-mname" placeholder="v_diff"/></div>
        <div class="row"><label>expr</label><input id="pl-mexpr" placeholder="main.a - main.b"/></div>
        <div class="row">
          <select id="pl-macros" style="flex:1"><option value="">Saved macros…</option></select>
          <button id="pl-msave">Save</button>
          <button id="pl-mgo" class="primary">Add</button>
        </div>
      </details>

      <details class="plot-sec">
        <summary>Filter</summary>
        <div class="row"><label>signal</label><select id="pl-fsig">${sigOpts}</select></div>
        <div class="row"><label>type</label>
          <select id="pl-ftype">
            <option value="ma">Moving average</option>
            <option value="ideal_lp">Ideal low pass (FIR)</option>
            <option value="ideal_hp">Ideal high pass (FIR)</option>
            <option value="ideal_bp">Ideal band pass (FIR)</option>
            <option value="butter_lp">Butterworth LP (2nd order)</option>
            <option value="butter_hp">Butterworth HP (2nd order)</option>
          </select>
        </div>
        <div class="row" id="pl-frow-ma"><label>window</label><input id="pl-fpts" type="number" value="20"/></div>
        <div class="row" id="pl-frow-fc" style="display:none">
          <label>cutoff Hz</label><input id="pl-ffc1" type="number" placeholder="1000"/>
        </div>
        <div class="row" id="pl-frow-fc2" style="display:none">
          <label>upper Hz</label><input id="pl-ffc2" type="number" placeholder="5000"/>
        </div>
        <div class="empty-note">Nyquist is ${fmtEng(info.fs / 2)}Hz. FIR and Butterworth runs are zero-phase.</div>
        <div class="row"><button id="pl-fgo" class="primary">Apply filter</button></div>
      </details>

      <details class="plot-sec">
        <summary>Measure</summary>
        <div class="row"><label>signal</label><select id="pl-msig">${sigOpts}</select></div>
        <div class="row">
          <input id="pl-mt0" type="number" placeholder="t start"/>
          <input id="pl-mt1" type="number" placeholder="t end"/>
        </div>
        <div class="row">
          <button id="pl-mwin">Use view</button>
          <button id="pl-mgo2" class="primary">Measure</button>
        </div>
        <div id="pl-mout" class="meas-out"></div>
      </details>

      <details class="plot-sec">
        <summary>FFT &amp; THD</summary>
        <div class="row"><label>signal</label><select id="pl-asig">${sigOpts}</select></div>
        <div class="row">
          <input id="pl-at0" type="number" placeholder="t start"/>
          <input id="pl-at1" type="number" placeholder="t end"/>
        </div>
        <div class="row">
          <input id="pl-af0" type="number" placeholder="f min"/>
          <input id="pl-af1" type="number" placeholder="f max"/>
        </div>
        <div class="row">
          <select id="pl-awin">
            <option value="hanning">Hanning</option>
            <option value="hamming">Hamming</option>
            <option value="blackman">Blackman</option>
            <option value="none">Rectangular</option>
          </select>
          <select id="pl-apts">
            <option value="2048">2k</option>
            <option value="4096" selected>4k</option>
            <option value="8192">8k</option>
            <option value="16384">16k</option>
            <option value="32768">32k</option>
          </select>
        </div>
        <label class="chk"><input type="checkbox" id="pl-adc" checked/> remove DC</label>
        <div class="row">
          <button id="pl-fft" class="primary">Plot FFT</button>
          <button id="pl-thd">THD</button>
          <button id="pl-time">Back</button>
        </div>
        <div id="pl-aout" class="meas-out"></div>
      </details>`;

    this.wireMenu();
  }

  private wireMenu() {
    const q = <T extends HTMLElement>(sel: string) => this.menu.querySelector(sel) as T;

    // Signal toggles.
    this.menu.querySelectorAll('[data-sig]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('select,.del')) return;
        const name = (el as HTMLElement).dataset.sig!;
        const s = this.sig.get(name)!;
        s.on = !s.on;
        this.autoY = true;
        this.renderMenu();
        this.refresh();
      });
    });
    this.menu.querySelectorAll('[data-axis]').forEach((el) => {
      el.addEventListener('change', () => {
        const name = (el as HTMLElement).dataset.axis!;
        this.sig.get(name)!.axis = (el as HTMLSelectElement).value as 'y1' | 'y2';
        this.autoY = true;
        this.refresh();
      });
    });
    this.menu.querySelectorAll('[data-del]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const info = (await API.PlotRemoveColumn((el as HTMLElement).dataset.del!)) as unknown as PlotInfo;
          this.adopt(info);
        } catch (err) { this.err(err); }
      });
    });

    q('#pl-none')?.addEventListener('click', () => {
      this.sig.forEach((s) => (s.on = false));
      this.renderMenu(); this.refresh();
    });
    q('#pl-all')?.addEventListener('click', () => {
      this.sig.forEach((s) => (s.on = true));
      this.autoY = true;
      this.renderMenu(); this.refresh();
    });

    q<HTMLSelectElement>('#pl-x')?.addEventListener('change', async (e) => {
      try {
        const info = (await API.SetPlotX((e.target as HTMLSelectElement).value)) as unknown as PlotInfo;
        const keep = new Map(this.sig);
        this.adopt(info);
        keep.forEach((v, k) => { const s = this.sig.get(k); if (s) { s.on = v.on; s.axis = v.axis; } });
        this.renderMenu();
        this.refresh();
      } catch (err) { this.err(err); }
    });

    // Maths.
    this.loadMacros();
    q('#pl-mgo')?.addEventListener('click', async () => {
      const name = q<HTMLInputElement>('#pl-mname').value.trim() || 'calc';
      const expr = q<HTMLInputElement>('#pl-mexpr').value.trim();
      try {
        const info = (await API.PlotCompute(name, expr)) as unknown as PlotInfo;
        const keep = new Map(this.sig);
        this.adopt(info);
        keep.forEach((v, k) => { const s = this.sig.get(k); if (s) { s.on = v.on; s.axis = v.axis; } });
        const added = this.sig.get(name);
        if (added) added.on = true;
        this.log(`Computed ${name} = ${expr}`);
        this.renderMenu();
        this.refresh();
      } catch (e) { this.err(e); }
    });
    q('#pl-msave')?.addEventListener('click', () => {
      const name = q<HTMLInputElement>('#pl-mname').value.trim() || `macro_${Date.now()}`;
      const expr = q<HTMLInputElement>('#pl-mexpr').value.trim();
      if (!expr) return this.log('Nothing to save — the expression is empty.');
      const saved = JSON.parse(localStorage.getItem('hoverdeck.macros') || '{}');
      saved[name] = expr;
      localStorage.setItem('hoverdeck.macros', JSON.stringify(saved));
      this.loadMacros();
      this.log(`Saved macro ${name}`);
    });
    q<HTMLSelectElement>('#pl-macros')?.addEventListener('change', (e) => {
      const sel = e.target as HTMLSelectElement;
      if (!sel.value) return;
      q<HTMLInputElement>('#pl-mexpr').value = sel.value;
      q<HTMLInputElement>('#pl-mname').value = sel.options[sel.selectedIndex].text;
    });

    // Filter.
    const syncFilterRows = () => {
      const t = q<HTMLSelectElement>('#pl-ftype').value;
      q('#pl-frow-ma').style.display = t === 'ma' ? '' : 'none';
      q('#pl-frow-fc').style.display = t === 'ma' ? 'none' : '';
      q('#pl-frow-fc2').style.display = t === 'ideal_bp' ? '' : 'none';
    };
    q('#pl-ftype')?.addEventListener('change', syncFilterRows);
    syncFilterRows();

    q('#pl-fgo')?.addEventListener('click', async () => {
      try {
        const info = (await API.PlotFilter({
          column: q<HTMLSelectElement>('#pl-fsig').value,
          type: q<HTMLSelectElement>('#pl-ftype').value,
          points: parseInt(q<HTMLInputElement>('#pl-fpts').value || '0', 10),
          fc1: parseFloat(q<HTMLInputElement>('#pl-ffc1').value || '0'),
          fc2: parseFloat(q<HTMLInputElement>('#pl-ffc2').value || '0'),
          taps: 101,
        } as any)) as unknown as PlotInfo;

        const newName = info.name;
        const keep = new Map(this.sig);
        this.adopt(info);
        keep.forEach((v, k) => { const s = this.sig.get(k); if (s) { s.on = v.on; s.axis = v.axis; } });
        const added = this.sig.get(newName);
        if (added) added.on = true;
        this.log(`Filtered: ${newName}`);
        this.renderMenu();
        this.refresh();
      } catch (e) { this.err(e); }
    });

    // Measure.
    q('#pl-mwin')?.addEventListener('click', () => {
      q<HTMLInputElement>('#pl-mt0').value = String(this.x0);
      q<HTMLInputElement>('#pl-mt1').value = String(this.x1);
    });
    q('#pl-mgo2')?.addEventListener('click', async () => {
      try {
        const m = (await API.PlotMeasure(
          q<HTMLSelectElement>('#pl-msig').value,
          parseFloat(q<HTMLInputElement>('#pl-mt0').value || '0'),
          parseFloat(q<HTMLInputElement>('#pl-mt1').value || '0'),
        )) as unknown as Measurement;
        q('#pl-mout').innerHTML =
          `<div><b>${esc(m.column)}</b> · ${m.n.toLocaleString()} samples</div>` +
          `<div>${fmtEng(m.tStart)}s → ${fmtEng(m.tEnd)}s</div>` +
          `<div>max ${fmtEng(m.max)}</div><div>min ${fmtEng(m.min)}</div>` +
          `<div>pk-pk ${fmtEng(m.pkpk)}</div><div>avg ${fmtEng(m.avg)}</div>` +
          `<div>rms ${fmtEng(m.rms)}</div>`;
      } catch (e) { this.err(e); }
    });

    // FFT / THD.
    const fftOpts = () => ({
      column: q<HTMLSelectElement>('#pl-asig').value,
      tStart: parseFloat(q<HTMLInputElement>('#pl-at0').value || '0'),
      tEnd: parseFloat(q<HTMLInputElement>('#pl-at1').value || '0'),
      fMin: parseFloat(q<HTMLInputElement>('#pl-af0').value || '0'),
      fMax: parseFloat(q<HTMLInputElement>('#pl-af1').value || '0'),
      window: q<HTMLSelectElement>('#pl-awin').value,
      points: parseInt(q<HTMLSelectElement>('#pl-apts').value, 10),
      removeDC: q<HTMLInputElement>('#pl-adc').checked,
    });

    q('#pl-fft')?.addEventListener('click', async () => {
      try {
        const t0 = performance.now();
        const sp = (await API.PlotFFT(fftOpts() as any)) as unknown as Spectrum;
        this.spectrum = sp;
        this.mode = 'fft';
        this.y1Lo = 0;
        this.y1Hi = Math.max(...sp.mags) * 1.1 || 1;
        this.draw();
        this.log(`FFT: ${sp.n}-point, Fs ${fmtEng(sp.fs)}Hz, peak ${fmtEng(sp.peak)} at ` +
                 `${fmtEng(sp.peakF)}Hz (${(performance.now() - t0).toFixed(0)} ms)`);
      } catch (e) { this.err(e); }
    });

    q('#pl-thd')?.addEventListener('click', async () => {
      try {
        const r = (await API.PlotTHD(fftOpts() as any)) as unknown as THDResult;
        q('#pl-aout').innerHTML =
          `<div><b>THD ${r.thd.toFixed(3)}%</b></div>` +
          `<div>fundamental ${fmtEng(r.fundFreq)}Hz</div>` +
          `<div>fund RMS ${fmtEng(r.fundRMS)}</div>` +
          `<div>total RMS ${fmtEng(r.totalRMS)}</div>` +
          `<div>${fmtEng(r.tStart)}s → ${fmtEng(r.tEnd)}s</div>`;
        this.log(`THD ${r.thd.toFixed(3)}% on ${r.column}`);
      } catch (e) { this.err(e); }
    });

    q('#pl-time')?.addEventListener('click', () => {
      this.mode = 'time';
      this.spectrum = null;
      this.autoY = true;
      this.refresh();
    });
  }

  private loadMacros() {
    const sel = this.menu.querySelector('#pl-macros') as HTMLSelectElement | null;
    if (!sel) return;
    const saved = JSON.parse(localStorage.getItem('hoverdeck.macros') || '{}');
    sel.innerHTML = '<option value="">Saved macros…</option>' +
      Object.keys(saved).map((k) => `<option value="${esc(saved[k])}">${esc(k)}</option>`).join('');
  }

  private async exportData() {
    try {
      if (this.mode === 'fft') {
        const path = await API.PlotExportSpectrum({
          column: (this.menu.querySelector('#pl-asig') as HTMLSelectElement)?.value ?? '',
          tStart: 0, tEnd: 0, fMin: 0, fMax: 0,
          window: (this.menu.querySelector('#pl-awin') as HTMLSelectElement)?.value ?? 'hanning',
          points: 4096, removeDC: true,
        } as any);
        if (path) this.log(`Exported spectrum to ${path}`);
        return;
      }
      const names = this.selected();
      if (!names.length) return this.log('Select at least one signal to export.');
      const path = await API.PlotExport(names, this.x0, this.x1);
      if (path) this.log(`Exported ${names.length} signal(s) to ${path}`);
    } catch (e) { this.err(e); }
  }

  private err(e: unknown) {
    this.log('Error: ' + (e instanceof Error ? e.message : String(e)));
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

/** Chooses ~n round tick values spanning [a, b]. */
function ticks(a: number, b: number, n: number): number[] {
  if (!isFinite(a) || !isFinite(b) || a === b) return [a];
  const span = b - a;
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(a / step) * step; v <= b + step * 1e-9; v += step) out.push(v);
  return out;
}

/** Formats with engineering suffixes, matching how Hover writes literals. */
export function fmtEng(v: number): string {
  if (!isFinite(v)) return '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  const units: [number, string][] = [
    [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''],
    [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'],
  ];
  for (const [scale, suffix] of units) {
    if (a >= scale) {
      const s = v / scale;
      return (Math.abs(s) < 10 ? s.toFixed(3) : Math.abs(s) < 100 ? s.toFixed(2) : s.toFixed(1))
        .replace(/\.?0+$/, '') + suffix;
    }
  }
  return v.toExponential(2);
}

/** Binary search for the sample nearest a value in a sorted array. */
function nearestIndex(xs: number[], v: number): number {
  if (!xs.length) return -1;
  let lo = 0, hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < v) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(xs[lo - 1] - v) < Math.abs(xs[lo] - v)) return lo - 1;
  return lo;
}

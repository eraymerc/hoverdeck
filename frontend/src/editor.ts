/**
 * A small Hover code editor.
 *
 * A transparent <textarea> sits exactly on top of a syntax-highlighted <pre>.
 * The textarea owns editing, selection and the caret; the <pre> owns colour.
 * Both use identical font metrics and padding so the two layers stay aligned.
 *
 * This is deliberately a real editor rather than a read-only preview: the
 * point of hoverdeck is to help you read the wiring, not to take the code
 * away from you.
 */

import { esc } from './canvas';
import { ui } from './ui';

// `from` is in here even though the language does not reserve it — it starts
// an import only when a path follows, and stays a usable identifier
// otherwise. Highlighting it costs a false positive on a port named `from`,
// which is worth it: `from <math> import sin;` is the line a reader most
// needs to see as an import.
const KEYWORDS = new Set([
  'module', 'analog', 'digital', 'func', 'state', 'if', 'else', 'while',
  'return', 'input', 'output', 'import', 'from', 'importc', 'as', 'extern',
  'struct',
]);

const TYPES = new Set(['wire', 'double', 'float', 'int', 'unsigned', 'void']);

const PRIMS = new Set([
  'R', 'L', 'C', 'voltage_source', 'current_source',
  'VCVS', 'VCCS', 'CCVS', 'CCCS',
]);

const BUILTINS = new Set([
  'V', 'I', 'idt', 'ddt', 'nr_prev', 'time', 'dt', 'gnd',
  'sin', 'cos', 'tan', 'exp', 'log', 'sqrt', 'abs', 'pow', 'atan', 'asin', 'acos',
]);

/** Tokenises Hover source into coloured HTML. */
export function highlight(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;

  const wrap = (cls: string, s: string) => `<span class="${cls}">${esc(s)}</span>`;

  while (i < n) {
    const c = src[i];

    // Comments
    if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      out += wrap('t-com', src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j + 1 < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(j + 2, n);
      out += wrap('t-com', src.slice(i, j));
      i = j;
      continue;
    }

    // Strings
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') j++;
        j++;
      }
      j = Math.min(j + 1, n);
      out += wrap('t-str', src.slice(i, j));
      i = j;
      continue;
    }

    // Directives: `.tran`, `.save`, `.solver` at the start of a statement.
    if (c === '.' && /[a-zA-Z]/.test(src[i + 1] ?? '')) {
      const before = src.slice(0, i);
      const atStatementStart = /(^|[\n;{}])\s*$/.test(before);
      if (atStatementStart) {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
        out += wrap('t-dir', src.slice(i, j));
        i = j;
        continue;
      }
    }

    // Angle-bracket import paths, which name a directory: `import <math>;`
    // and `from <semiconductors> import Diode;`.
    if (c === '<' && /\b(import|from)\s*$/.test(src.slice(Math.max(0, i - 12), i))) {
      let j = i + 1;
      while (j < n && src[j] !== '>' && src[j] !== '\n') j++;
      j = Math.min(j + 1, n);
      out += wrap('t-str', src.slice(i, j));
      i = j;
      continue;
    }

    // Numbers, including engineering suffixes (10p, 20k, 1Meg) and exponents.
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      if (j < n && (src[j] === 'e' || src[j] === 'E') && /[0-9+\-]/.test(src[j + 1] ?? '')) {
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < n && /[0-9]/.test(src[j])) j++;
      }
      if (src.startsWith('Meg', j)) j += 3;
      else if (j < n && /[pnumkG]/.test(src[j])) j++;
      out += wrap('t-num', src.slice(i, j));
      i = j;
      continue;
    }

    // Identifiers
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);

      let k = j;
      while (k < n && /\s/.test(src[k])) k++;
      const followedByCall = src[k] === '(' || src[k] === '<';

      if (KEYWORDS.has(word)) out += wrap('t-kw', word);
      else if (TYPES.has(word)) out += wrap('t-ty', word);
      else if (PRIMS.has(word) && followedByCall) out += wrap('t-prim', word);
      else if (BUILTINS.has(word)) out += wrap('t-fn', word);
      else if (followedByCall && src[k] === '(') out += wrap('t-fn', word);
      else out += esc(word);
      i = j;
      continue;
    }

    out += esc(c);
    i++;
  }
  return out;
}

export interface EditorHandlers {
  onDirtyChange(dirty: boolean): void;
  onSave(path: string, text: string): void | Promise<void>;
  onCheck(path: string, text: string): void;
  /** Optional status message, e.g. the result of a replace-all. */
  onReport?(message: string): void;
}

export class Editor {
  private el: HTMLElement;
  private gutter!: HTMLElement;
  private scroll!: HTMLElement;
  private sizer!: HTMLElement;
  private pre!: HTMLElement;
  private ta!: HTMLTextAreaElement;
  private band!: HTMLElement;
  private foot!: HTMLElement;

  path = '';
  private original = '';
  private readOnly = false;
  private checkTimer: number | undefined;

  constructor(host: HTMLElement, private h: EditorHandlers) {
    this.el = host;
    this.el.innerHTML = `
      <div class="find-bar" id="find-bar" style="display:none">
        <input id="find-q" placeholder="Find"/>
        <span class="find-count" id="find-count">0/0</span>
        <button id="find-prev" title="Previous (Shift+Enter)">↑</button>
        <button id="find-next" title="Next (Enter)">↓</button>
        <button id="find-aa" title="Match case">Aa</button>
        <button id="find-rep-toggle" title="Replace">${ui('replace', 12)}</button>
        <button id="find-close" title="Close (Esc)">×</button>
      </div>
      <div class="find-bar replace" id="replace-bar" style="display:none">
        <input id="find-r" placeholder="Replace with"/>
        <button id="find-rep">Replace</button>
        <button id="find-repall">All</button>
      </div>
      <div class="editor">
        <div class="gutter"></div>
        <div class="code-scroll">
          <div class="code-sizer">
            <div class="hl-band" style="display:none"></div>
            <pre class="code-pre"></pre>
            <textarea class="code-ta" spellcheck="false" wrap="off"
                      autocomplete="off" autocapitalize="off"></textarea>
          </div>
        </div>
      </div>
      <div class="ed-foot">
        <span class="pos">—</span>
        <span class="grow"></span>
        <span class="ro" style="display:none">read-only</span>
        <button class="save-btn primary" disabled>Save</button>
      </div>`;

    this.gutter = this.el.querySelector('.gutter')!;
    this.scroll = this.el.querySelector('.code-scroll')!;
    this.sizer = this.el.querySelector('.code-sizer')!;
    this.pre = this.el.querySelector('.code-pre')!;
    this.ta = this.el.querySelector('.code-ta')!;
    this.band = this.el.querySelector('.hl-band')!;
    this.foot = this.el.querySelector('.ed-foot')!;

    this.ta.addEventListener('input', () => {
      this.repaint();
      this.h.onDirtyChange(this.dirty);
      this.scheduleCheck();
    });
    this.ta.addEventListener('scroll', () => this.syncScroll());
    this.scroll.addEventListener('scroll', () => this.syncScroll());
    this.ta.addEventListener('keydown', (e) => this.onKey(e));
    this.ta.addEventListener('click', () => this.updatePos());
    this.ta.addEventListener('keyup', () => this.updatePos());

    this.el.querySelector('.save-btn')!.addEventListener('click', () => this.save());
    this.wireFind();
  }

  // ── Find & replace ────────────────────────────────────────────────────

  private matches: number[] = [];
  private matchIdx = -1;
  private caseSensitive = false;

  private q<T extends HTMLElement>(sel: string): T {
    return this.el.querySelector(sel) as T;
  }

  private wireFind() {
    const bar = this.q('#find-bar');
    const input = this.q<HTMLInputElement>('#find-q');

    this.q('#find-close').addEventListener('click', () => this.closeFind());
    this.q('#find-next').addEventListener('click', () => this.step(1));
    this.q('#find-prev').addEventListener('click', () => this.step(-1));
    this.q('#find-aa').addEventListener('click', () => {
      this.caseSensitive = !this.caseSensitive;
      this.q('#find-aa').classList.toggle('on', this.caseSensitive);
      this.runFind(input.value);
    });
    this.q('#find-rep-toggle').addEventListener('click', () => {
      const rb = this.q('#replace-bar');
      rb.style.display = rb.style.display === 'none' ? 'flex' : 'none';
      if (rb.style.display === 'flex') this.q<HTMLInputElement>('#find-r').focus();
    });
    this.q('#find-rep').addEventListener('click', () => this.replaceCurrent());
    this.q('#find-repall').addEventListener('click', () => this.replaceAll());

    input.addEventListener('input', () => this.runFind(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); this.closeFind(); }
    });
    this.q<HTMLInputElement>('#find-r').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.replaceCurrent(); }
      if (e.key === 'Escape') { e.preventDefault(); this.closeFind(); }
    });
    void bar;
  }

  /** Opens the find bar, seeding it with the current selection if there is one. */
  openFind() {
    const bar = this.q('#find-bar');
    bar.style.display = 'flex';
    const input = this.q<HTMLInputElement>('#find-q');

    const sel = this.ta.value.slice(this.ta.selectionStart, this.ta.selectionEnd);
    if (sel && !sel.includes('\n')) input.value = sel;

    input.focus();
    input.select();
    this.runFind(input.value);
  }

  closeFind() {
    this.q('#find-bar').style.display = 'none';
    this.q('#replace-bar').style.display = 'none';
    this.matches = [];
    this.matchIdx = -1;
    this.ta.focus();
  }

  private get findOpen(): boolean {
    return this.q('#find-bar').style.display !== 'none';
  }

  /** Collects every match offset for the query. */
  private runFind(query: string) {
    this.matches = [];
    this.matchIdx = -1;
    if (query) {
      const hay = this.caseSensitive ? this.ta.value : this.ta.value.toLowerCase();
      const needle = this.caseSensitive ? query : query.toLowerCase();
      let at = hay.indexOf(needle);
      while (at !== -1) {
        this.matches.push(at);
        at = hay.indexOf(needle, at + Math.max(1, needle.length));
      }
      // Jump to the first match at or after the caret, so searching continues
      // from where you are rather than from the top of the file.
      const caret = this.ta.selectionStart;
      const ahead = this.matches.findIndex((m) => m >= caret);
      this.matchIdx = ahead >= 0 ? ahead : (this.matches.length ? 0 : -1);
    }
    this.showMatch(query.length);
  }

  private step(delta: number) {
    if (!this.matches.length) return;
    this.matchIdx = (this.matchIdx + delta + this.matches.length) % this.matches.length;
    this.showMatch(this.q<HTMLInputElement>('#find-q').value.length);
  }

  private showMatch(len: number) {
    const count = this.q('#find-count');
    count.textContent = this.matches.length
      ? `${this.matchIdx + 1}/${this.matches.length}`
      : '0/0';
    count.classList.toggle('none', this.matches.length === 0);
    if (this.matchIdx < 0 || !len) return;

    const at = this.matches[this.matchIdx];
    this.ta.setSelectionRange(at, at + len);
    // Scroll the hit into view without stealing focus from the query box.
    const line = this.ta.value.slice(0, at).split('\n').length;
    this.scroll.scrollTop = Math.max(0, (line - 1) * this.lineHeight - this.scroll.clientHeight / 2);
    this.syncScroll();
    const band = this.hlRange;
    this.hlRange = { startLine: line, endLine: line };
    this.applyBandGeometry();
    void band;
  }

  private replaceCurrent() {
    if (this.readOnly || this.matchIdx < 0) return;
    const q = this.q<HTMLInputElement>('#find-q').value;
    const r = this.q<HTMLInputElement>('#find-r').value;
    if (!q) return;

    const at = this.matches[this.matchIdx];
    this.ta.value = this.ta.value.slice(0, at) + r + this.ta.value.slice(at + q.length);
    this.ta.setSelectionRange(at + r.length, at + r.length);
    this.repaint();
    this.h.onDirtyChange(this.dirty);
    this.runFind(q);
  }

  private replaceAll() {
    if (this.readOnly) return;
    const q = this.q<HTMLInputElement>('#find-q').value;
    const r = this.q<HTMLInputElement>('#find-r').value;
    if (!q || !this.matches.length) return;

    // Applied back-to-front so each replacement cannot shift the offsets of
    // the ones still to come.
    let text = this.ta.value;
    const n = this.matches.length;
    for (let i = n - 1; i >= 0; i--) {
      const at = this.matches[i];
      text = text.slice(0, at) + r + text.slice(at + q.length);
    }
    this.ta.value = text;
    this.repaint();
    this.h.onDirtyChange(this.dirty);
    this.runFind(q);
    this.h.onReport?.(`Replaced ${n} occurrence${n === 1 ? '' : 's'}`);
  }

  /** Opens find from outside, e.g. a global Ctrl+F. */
  focusFind() {
    this.openFind();
  }

  get dirty(): boolean {
    return !this.readOnly && this.ta.value !== this.original;
  }

  get text(): string {
    return this.ta.value;
  }

  /** Loads a file, optionally scrolling to and highlighting a line range. */
  load(path: string, text: string, readOnly: boolean, hl?: { startLine: number; endLine: number }) {
    this.path = path;
    this.original = text;
    this.readOnly = readOnly;
    this.ta.value = text;
    this.ta.readOnly = readOnly;
    (this.el.querySelector('.ro') as HTMLElement).style.display = readOnly ? '' : 'none';
    this.repaint();
    this.h.onDirtyChange(false);
    this.matches = [];
    this.matchIdx = -1;
    if (hl) this.highlightRange(hl.startLine, hl.endLine);
    else this.clearHighlight();
    this.updatePos();
  }

  private lineHeight = 19;
  private padTop = 10;

  private repaint() {
    const text = this.ta.value;
    this.pre.innerHTML = highlight(text) + '\n';

    const lines = text.split('\n').length;
    // Sizer must be as tall as the content so the scroll container can scroll.
    const height = lines * this.lineHeight + this.padTop * 2;
    this.sizer.style.height = `${height}px`;

    // Widest line drives horizontal extent; monospace makes this a safe estimate.
    let maxLen = 0;
    for (const l of text.split('\n')) maxLen = Math.max(maxLen, l.length);
    this.sizer.style.minWidth = `${maxLen * 7.24 + 40}px`;

    let g = '';
    for (let i = 1; i <= lines; i++) g += `<div class="gl" data-l="${i}">${i}</div>`;
    this.gutter.innerHTML = g;
    this.applyBandGeometry();
    (this.el.querySelector('.save-btn') as HTMLButtonElement).disabled = !this.dirty;
  }

  private syncScroll() {
    this.gutter.scrollTop = this.scroll.scrollTop;
    this.gutter.style.transform = `translateY(${-this.scroll.scrollTop}px)`;
  }

  private hlRange: { startLine: number; endLine: number } | null = null;

  highlightRange(startLine: number, endLine: number) {
    this.hlRange = { startLine, endLine };
    this.applyBandGeometry();
    this.gutter.querySelectorAll('.gl').forEach((el) => {
      const l = Number((el as HTMLElement).dataset.l);
      el.classList.toggle('hl', l >= startLine && l <= endLine);
    });
    // Bring the range into view with a little context above it.
    const top = (startLine - 1) * this.lineHeight + this.padTop;
    this.scroll.scrollTop = Math.max(0, top - 60);
    this.syncScroll();
  }

  clearHighlight() {
    this.hlRange = null;
    this.band.style.display = 'none';
    this.gutter.querySelectorAll('.gl').forEach((el) => el.classList.remove('hl'));
  }

  private applyBandGeometry() {
    if (!this.hlRange) {
      this.band.style.display = 'none';
      return;
    }
    const { startLine, endLine } = this.hlRange;
    this.band.style.display = '';
    this.band.style.top = `${(startLine - 1) * this.lineHeight + this.padTop}px`;
    this.band.style.height = `${(endLine - startLine + 1) * this.lineHeight}px`;
  }

  /** Places the caret at a line and focuses the editor. */
  goToLine(line: number) {
    const lines = this.ta.value.split('\n');
    let off = 0;
    for (let i = 0; i < Math.min(line - 1, lines.length); i++) off += lines[i].length + 1;
    this.ta.focus();
    this.ta.setSelectionRange(off, off);
    this.scroll.scrollTop = Math.max(0, (line - 1) * this.lineHeight - 100);
    this.syncScroll();
    this.updatePos();
  }

  private onKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      this.save();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      this.openFind();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') {
      e.preventDefault();
      this.openFind();
      this.q('#replace-bar').style.display = 'flex';
      return;
    }
    if (e.key === 'F3') {
      e.preventDefault();
      if (this.findOpen) this.step(e.shiftKey ? -1 : 1);
      else this.openFind();
      return;
    }
    if (e.key === 'Escape' && this.findOpen) {
      e.preventDefault();
      this.closeFind();
      return;
    }
    // Tab inserts four spaces rather than moving focus out of the editor.
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = this.ta.selectionStart;
      const t = this.ta.value;
      this.ta.value = t.slice(0, s) + '    ' + t.slice(this.ta.selectionEnd);
      this.ta.selectionStart = this.ta.selectionEnd = s + 4;
      this.repaint();
      this.h.onDirtyChange(this.dirty);
    }
  }

  private updatePos() {
    const upto = this.ta.value.slice(0, this.ta.selectionStart);
    const line = upto.split('\n').length;
    const col = upto.length - upto.lastIndexOf('\n');
    (this.foot.querySelector('.pos') as HTMLElement).textContent = `Ln ${line}, Col ${col}`;
  }

  private scheduleCheck() {
    window.clearTimeout(this.checkTimer);
    this.checkTimer = window.setTimeout(() => {
      this.h.onCheck(this.path, this.ta.value);
    }, 400);
  }

  async save() {
    if (!this.dirty) return;
    await this.h.onSave(this.path, this.ta.value);
    this.original = this.ta.value;
    this.h.onDirtyChange(false);
    (this.el.querySelector('.save-btn') as HTMLButtonElement).disabled = true;
  }

  /** Replaces buffer contents after an external change, keeping the caret. */
  refresh(text: string) {
    const pos = this.ta.selectionStart;
    this.original = text;
    this.ta.value = text;
    this.repaint();
    this.ta.setSelectionRange(pos, pos);
    this.h.onDirtyChange(false);
  }
}

import './style.css';

import * as API from '../wailsjs/go/main/App';
import { EventsOn } from '../wailsjs/runtime/runtime';
import { Canvas, esc } from './canvas';
import { Editor } from './editor';
import { iconSvg, iconIds, setSymbols } from './icons';
import { Plotter } from './plotter';
import { ui } from './ui';
import logoLockupMark from './assets/logo-lockup-mark.svg';
import logoDisc from './assets/logo-disc.svg';
import type {
  Catalog, CatalogEntry, InsertRequest, Packages, PrimitiveDef,
  PlotInfo, ProjectInfo, RunStatus, SafeBlock as Block, SafeSheet, SettingsView,
  Sheet, Signal, SourceFile, TreeNode, Workspace,
} from './types';
import { normalizeSheet } from './types';

/**
 * hoverdeck shell.
 *
 * The .hvr files are the source of truth throughout: every action that changes
 * anything writes to disk and then reloads from disk, so what the canvas shows
 * is always what the compiler would read.
 */

type RightTab = 'inspect' | 'code';
type LeftTab = 'blocks' | 'files';

const state = {
  project: null as ProjectInfo | null,
  workspace: null as Workspace | null,
  expanded: new Set<string>(),
  catalog: null as Catalog | null,
  sheet: null as SafeSheet | null,
  stack: [] as string[],       // breadcrumb of sheet names
  leftTab: 'blocks' as LeftTab,
  rightTab: 'inspect' as RightTab,
  selBlock: null as string | null,
  selNet: null as string | null,
  selSignal: null as string | null,
  editorFile: '' as string,
  dirty: false,
  running: false,
  plotOpen: false,
  search: '',
  children: new Map<string, TreeNode[]>(),  // lazily loaded tree levels
};

let canvas: Canvas;
let editor: Editor;
let plotter: Plotter;

// ── Shell ────────────────────────────────────────────────────────────────

function shell() {
  document.querySelector('#app')!.innerHTML = `
    <div class="toolbar">
      <!-- The horizontal lockup, built the way the design system builds it:
           the mark artwork plus a live Archivo Black wordmark sheared -9deg,
           never an outlined SVG. Below a 40px mark the tagline drops. -->
      <div class="brand">
        <img src="${logoLockupMark}" alt="hoverdeck"/>
        <span class="wordmark">HOVER<span>DECK</span></span>
      </div>
      <span class="ver">v0.9.0</span>

      <button id="btn-open" class="inverse" title="Open a file or folder (Ctrl+O)">${ui('folder-open', 14)}Open</button>
      <button id="btn-main" class="inverse" title="Open the entry file in the editor">${ui('file-code', 14)}Entry</button>
      <button id="btn-reload" class="inverse" title="Re-read every file from disk">${ui('refresh-cw', 14)}Reload</button>
      <button id="btn-run" class="primary" title="Compile and simulate (Ctrl+R)">${ui('play', 14)}Run sim</button>
      <button id="btn-stop" class="inverse icon" title="Stop the run" disabled>${ui('stop', 14)}</button>
      <button id="btn-plot" class="inverse" title="Open the waveform viewer">${ui('waves', 14)}Scope</button>

      <div class="crumbs" id="crumbs"></div>
      <span class="file-name" id="entry-name"></span>
      <button id="btn-theme" class="inverse icon" title="Switch theme"></button>
      <button id="btn-settings" class="inverse icon" title="Settings">${ui('sliders-horizontal', 14)}</button>
    </div>

    <div class="main" id="main">
      <div class="pane left">
        <div class="tabs">
          <div class="tab" data-lt="blocks">Blocks</div>
          <div class="tab" data-lt="files">Files</div>
        </div>
        <div class="search-wrap"><input id="pal-search" placeholder="search blocks"/></div>
        <div class="pane-body" id="left-body"></div>
      </div>

      <div class="vsplit" data-split="left" title="Drag to resize"></div>

      <div class="pane center" id="center">
        <div id="canvas-host"></div>
        <div class="hsplit" id="con-split" title="Drag to resize" style="display:none"></div>
        <div class="console" id="console" style="display:none">
          <div class="console-head">
            <span class="run-dot" id="run-dot"></span>
            <span id="con-title">Output</span>
            <span class="grow"></span>
            <button id="con-clear" class="inverse">Clear</button>
            <button id="con-hide" class="inverse">Hide</button>
          </div>
          <div class="console-body" id="console-body"></div>
        </div>
        <div class="plot-overlay" id="plot-overlay" style="display:none"></div>
      </div>

      <div class="vsplit" data-split="right" title="Drag to resize"></div>

      <div class="pane right">
        <div class="tabs">
          <div class="tab" data-rt="inspect">Inspector</div>
          <div class="tab" data-rt="code">Source</div>
        </div>
        <div class="pane-body" id="insp-body" style="display:none"></div>
        <div id="code-body" style="display:none; flex:1; min-height:0; flex-direction:column;"></div>
      </div>
    </div>

    <div class="status" id="status"></div>
    <div class="toasts" id="toasts"></div>`;

  document.getElementById('btn-open')!.addEventListener('click', openAny);
  document.getElementById('btn-reload')!.addEventListener('click', () => reload(true));
  document.getElementById('btn-main')!.addEventListener('click', () => {
    if (state.project) openInEditor(state.project.entry);
  });

  document.querySelectorAll('[data-lt]').forEach((el) =>
    el.addEventListener('click', () => {
      state.leftTab = (el as HTMLElement).dataset.lt as LeftTab;
      renderLeft();
    }));
  document.querySelectorAll('[data-rt]').forEach((el) =>
    el.addEventListener('click', () => {
      state.rightTab = (el as HTMLElement).dataset.rt as RightTab;
      renderRight();
    }));

  const search = document.getElementById('pal-search') as HTMLInputElement;
  search.addEventListener('input', () => {
    state.search = search.value.toLowerCase();
    renderLeft();
  });

  canvas = new Canvas(document.getElementById('canvas-host')!, {
    onSelectBlock: (id) => { state.selBlock = id; if (id) previewBlockSource(id); renderRight(); },
    onSelectNet: (n) => { state.selNet = n; },
    onSelectSignal: (s) => { state.selSignal = s; },
    onOpenBlock: (b) => openBlock(b),
    onMoveBlock: (id, x, y) => {
      if (state.sheet) API.SetBlockPosition(state.sheet.qualified, id, x, y).catch(showErr);
    },
    onMoveSignal: (name, x, y) => {
      if (state.sheet) API.SetSignalPosition(state.sheet.qualified, name, x, y).catch(showErr);
    },
    onSetSignalWires: (signal, wires) => {
      if (!state.sheet) return;
      const q = state.sheet.qualified;
      const save = wires ? API.SetSignalWires(q, signal, wires as any) : API.ClearSignalWires(q, signal);
      save.then(() => { if (state.selSignal === signal) renderInspector(); }).catch(showErr);
    },
    onSetNetWires: (net, wires) => {
      if (!state.sheet) return;
      const q = state.sheet.qualified;
      const save = wires ? API.SetNetWires(q, net, wires as any) : API.ClearNetWires(q, net);
      // The inspector says whether a net is edited or automatic.
      save.then(() => { if (state.selNet === net) renderInspector(); }).catch(showErr);
    },
    onDropCatalog: (payload, x, y) => onDrop(payload, x, y),
  });

  editor = new Editor(document.getElementById('code-body')!, {
    onDirtyChange: (d) => { state.dirty = d; renderStatus(); renderEditorTabs(); },
    onSave: async (path, text) => {
      const info = (await API.SaveFile(path, text)) as unknown as ProjectInfo;
      state.project = info;
      await refreshSheet();
      toast('Saved ' + baseName(path), 'ok');
    },
    onCheck: (path, text) => {
      API.CheckSyntax(path, text).then((errs) => renderStatus(errs as string[]));
    },
    onReport: (msg) => toast(msg, 'ok'),
  });

  document.getElementById('btn-run')!.addEventListener('click', runProject);
  document.getElementById('btn-stop')!.addEventListener('click', stopRun);
  document.getElementById('btn-settings')!.addEventListener('click', openSettings);
  document.getElementById('btn-plot')!.addEventListener('click', () => togglePlot(true));

  plotter = new Plotter(
    document.getElementById('plot-overlay')!,
    () => togglePlot(false),
    (line) => { conLine(line); },
  );
  document.getElementById('con-clear')!.addEventListener('click', () => {
    document.getElementById('console-body')!.innerHTML = '';
  });
  document.getElementById('con-hide')!.addEventListener('click', () => showConsole(false));

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'o') { e.preventDefault(); openAny(); }
    if ((e.ctrlKey || e.metaKey) && k === 'r') { e.preventDefault(); runProject(); }
    // Ctrl+F reaches the editor even when focus is elsewhere in the pane.
    if ((e.ctrlKey || e.metaKey) && k === 'f' && !state.plotOpen) {
      if (state.editorFile) {
        e.preventDefault();
        state.rightTab = 'code';
        renderRight();
        editor.focusFind();
      }
      return;
    }

    // Single-key block transforms, ignored while typing into a field.
    const el = document.activeElement;
    const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ||
                   el instanceof HTMLSelectElement;
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!state.selBlock || !state.sheet || state.plotOpen) return;
    const blk = state.sheet.blocks.find((x) => x.id === state.selBlock);
    if (!blk) return;
    if (k === 'r') { e.preventDefault(); transformBlock(blk, 'rotate'); }
    if (k === 'h') { e.preventDefault(); transformBlock(blk, 'flipX'); }
    if (k === 'v') { e.preventDefault(); transformBlock(blk, 'flipY'); }
  });

  initTheme();
  initSplitters();
  initRunEvents();
  renderLeft();
  renderRight();
}

// ── Theme ────────────────────────────────────────────────────────────────

/**
 * Dark and light are the same brand with the surface roles swapped, so the
 * choice is purely about the room you are sitting in — a per-machine view
 * preference, like the pane widths, not project data.
 *
 * Dark is the default: this is an editor that gets stared at for hours.
 */
function initTheme() {
  const KEY = 'hoverdeck.theme';
  const btn = document.getElementById('btn-theme')!;

  const apply = (theme: 'dark' | 'light') => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(KEY, theme);
    // The icon names what a click gets you, not what you are looking at.
    btn.innerHTML = ui(theme === 'dark' ? 'sun' : 'moon', 14);
    btn.title = theme === 'dark' ? 'Switch to light' : 'Switch to dark';
    // The plotter draws into a bitmap and reads its colours from the tokens,
    // so it has to be told to repaint.
    plotter?.resize();
  };

  apply(localStorage.getItem(KEY) === 'light' ? 'light' : 'dark');
  btn.addEventListener('click', () =>
    apply(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
}

// ── Resizable panes ──────────────────────────────────────────────────────

/**
 * Pane widths and console height are dragged, then remembered in
 * localStorage — they are per-machine view preferences, not project data, so
 * they do not belong in the sidecar next to the circuit.
 */
function initSplitters() {
  const main = document.getElementById('main')!;
  const LEFT_KEY = 'hoverdeck.leftW';
  const RIGHT_KEY = 'hoverdeck.rightW';
  const CON_KEY = 'hoverdeck.conH';

  const apply = (which: 'left' | 'right', px: number) => {
    const clamped = Math.max(150, Math.min(760, px));
    main.style.setProperty(which === 'left' ? '--left-w' : '--right-w', `${clamped}px`);
    localStorage.setItem(which === 'left' ? LEFT_KEY : RIGHT_KEY, String(clamped));
  };

  const savedL = Number(localStorage.getItem(LEFT_KEY));
  const savedR = Number(localStorage.getItem(RIGHT_KEY));
  if (savedL) apply('left', savedL);
  if (savedR) apply('right', savedR);

  document.querySelectorAll<HTMLElement>('.vsplit').forEach((sp) => {
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const which = sp.dataset.split as 'left' | 'right';
      const rect = main.getBoundingClientRect();
      sp.classList.add('active');
      document.body.classList.add('resizing');

      const move = (me: PointerEvent) => {
        const px = which === 'left'
          ? me.clientX - rect.left
          : rect.right - me.clientX;
        apply(which, px);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        sp.classList.remove('active');
        document.body.classList.remove('resizing');
        canvas.fit();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  });

  // Console height.
  const con = document.getElementById('console')!;
  const conSplit = document.getElementById('con-split')!;
  const savedC = Number(localStorage.getItem(CON_KEY));
  con.style.height = `${savedC || 190}px`;

  conSplit.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const center = document.getElementById('center')!.getBoundingClientRect();
    conSplit.classList.add('active');
    document.body.classList.add('resizing-v');

    const move = (me: PointerEvent) => {
      const h = Math.max(80, Math.min(center.height - 120, center.bottom - me.clientY));
      con.style.height = `${h}px`;
      localStorage.setItem(CON_KEY, String(Math.round(h)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      conSplit.classList.remove('active');
      document.body.classList.remove('resizing-v');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

// ── Run ──────────────────────────────────────────────────────────────────

function showConsole(on: boolean) {
  document.getElementById('console')!.style.display = on ? 'flex' : 'none';
  document.getElementById('con-split')!.style.display = on ? '' : 'none';
  canvas.fit();
}

function conLine(text: string) {
  const body = document.getElementById('console-body')!;
  const div = document.createElement('div');
  div.className = classifyLine(text);
  div.textContent = text;
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
}

/** Colours compiler output by the [Stage] prefixes the hover CLI prints. */
function classifyLine(t: string): string {
  if (t.startsWith('$') || t.startsWith('  (')) return 'l-cmd';
  if (/error|failed|crash|undefined/i.test(t)) return 'l-err';
  if (/warning|note:/i.test(t)) return 'l-warn';
  if (/^\[[A-Za-z]+\]/.test(t)) return 'l-stage';
  return '';
}

/**
 * What the compiler is currently being used for.
 *
 * All three stream through the same console and the same run:line/run:done
 * events — they are one binary and only one may be in flight — but they end
 * differently: a simulation opens its results, while setup and hpm change
 * which packages exist and so have to invalidate the import table instead.
 */
type RunKind = 'run' | 'setup' | 'hpm';
let runKind: RunKind = 'run';

function setRunning(on: boolean) {
  state.running = on;
  (document.getElementById('btn-run') as HTMLButtonElement).disabled = on || !state.project;
  (document.getElementById('btn-stop') as HTMLButtonElement).disabled = !on;
  const dot = document.getElementById('run-dot')!;
  dot.className = 'run-dot' + (on ? ' busy' : '');
  const busy = { run: 'Compiling · running', setup: 'Setting up', hpm: 'Packages' }[runKind];
  document.getElementById('con-title')!.textContent = on ? busy : 'Output';
}

function initRunEvents() {
  EventsOn('run:line', (line: string) => conLine(line));
  EventsOn('run:done', async (st: RunStatus) => {
    const kind = runKind;
    setRunning(false);

    if (kind !== 'run') {
      const dot = document.getElementById('run-dot')!;
      dot.className = 'run-dot ' + (st.failed ? 'err' : 'ok');
      const label = kind === 'setup' ? 'SETUP' : 'HPM';
      conLine(st.failed ? `${label} FAILED — ${st.message}` : `${label} OK — ${st.message}`);
      document.getElementById('con-title')!.textContent = st.failed ? 'Failed' : 'Finished';
      if (!st.failed) {
        // The package table is what just changed, so the palette and every
        // unresolved import have to be rebuilt against it.
        try {
          const info = (await API.RefreshPackages()) as unknown as ProjectInfo;
          if (info?.open) state.project = info;
          await loadCatalog();
          await refreshSheet();
          renderAll();
        } catch (e) { showErr(e); }
      }
      toast(st.failed ? `${label} failed — ${st.message}` : `${label} finished`, st.failed ? 'err' : 'ok');
      return;
    }

    const dot = document.getElementById('run-dot')!;
    dot.className = 'run-dot ' + (st.failed ? 'err' : 'ok');
    // State what happened and where, in that order — no symbols, no apologies.
    const secs = st.seconds ? ` in ${st.seconds.toFixed(1)} s` : '';
    conLine(st.failed ? `RUN FAILED — ${st.message}${secs}` : `RUN OK — ${st.message}${secs}`);
    if (st.csvPath) conLine(`  results: ${st.csvPath}`);
    document.getElementById('con-title')!.textContent = st.failed ? 'Failed' : 'Finished';
    toast(st.failed ? `Run failed — ${st.message}` : `Run finished${secs}`, st.failed ? 'err' : 'ok');

    // A successful run opens its results straight away, which is the point of
    // running from here rather than a terminal.
    if (!st.failed && st.csvPath) togglePlot(true, st.csvPath);
  });
}

/** Shows or hides the waveform viewer over the canvas. */
async function togglePlot(on: boolean, path?: string) {
  const el = document.getElementById('plot-overlay')!;
  state.plotOpen = on;
  el.style.display = on ? 'flex' : 'none';
  if (!on) return;

  if (path) {
    await plotter.open(path);
  } else if (!plotter.info?.open) {
    // Nothing loaded yet: fall back to the newest results next to the compiler.
    const latest = await API.LatestResults();
    if (latest) await plotter.open(latest);
    else {
      const info = (await API.PlotInfoNow()) as unknown as PlotInfo;
      if (!info.open) toast('No results yet — run a simulation, or open a CSV', '');
    }
  }
  plotter.resize();
}

async function runProject() {
  if (!state.project) { toast('Open a .hvr file first', 'err'); return; }
  if (state.running) return;

  // Unsaved edits would be invisible to the compiler, which reads from disk.
  if (state.dirty) {
    await editor.save();
  }

  const s = (await API.GetSettings()) as unknown as SettingsView;
  if (!s.binOK) {
    toast('Set the hover compiler location first', 'err');
    openSettings();
    return;
  }
  // A compiler that has never been set up cannot link the runtime or resolve
  // `import <math>`. Saying so here beats letting the run fail three stages in
  // with a message about a missing archive.
  if (s.needsSetup) {
    toast('This install needs `hover --setup` first', 'err');
    openSettings();
    return;
  }

  showConsole(true);
  document.getElementById('console-body')!.innerHTML = '';
  runKind = 'run';
  setRunning(true);
  try {
    await API.Run();
  } catch (e) {
    setRunning(false);
    showErr(e);
  }
}

/**
 * Runs `hover --setup`: build the C++ runtime and download the standard
 * library into ~/.hover.
 *
 * Needed once per installation, and the only step hoverdeck cannot do itself —
 * it needs network access and writes into the install. Releases ship no
 * standard library, so until this has run, every `import <math>` fails.
 */
async function runSetup() {
  if (state.running) { toast('Something is already running', 'err'); return; }
  showConsole(true);
  document.getElementById('console-body')!.innerHTML = '';
  runKind = 'setup';
  setRunning(true);
  try {
    await API.RunSetup();
  } catch (e) {
    setRunning(false);
    showErr(e);
  }
}

/** Runs `hover hpm <args>` in the project folder. */
async function runHPM(args: string[]) {
  if (state.running) { toast('Something is already running', 'err'); return; }
  showConsole(true);
  runKind = 'hpm';
  setRunning(true);
  try {
    await API.RunHPM(args);
  } catch (e) {
    setRunning(false);
    showErr(e);
  }
}

async function stopRun() {
  try {
    await API.StopRun();
    conLine('— stopped by user —');
  } catch (e) { showErr(e); }
}

// ── Settings ─────────────────────────────────────────────────────────────

async function openSettings() {
  const s = (await API.GetSettings()) as unknown as SettingsView;

  const { root, close } = modal(`
    <h3>Settings</h3>
    <div class="hint">
      hoverdeck runs your existing <code>hover</code> compiler; it does not bundle one.
      Stored in <code>${esc(s.configPath)}</code>.
    </div>

    <div class="insp-title" style="margin:10px 0 6px">Compiler</div>
    <div class="row">
      <label>hover binary</label>
      <input id="s-bin" value="${esc(s.hoverBin)}" placeholder="/path/to/hover"/>
      <button id="s-bin-pick">…</button>
    </div>
    <div class="row">
      <label>working dir</label>
      <input id="s-work" value="${esc(s.workDir)}" placeholder="defaults to the project folder"/>
      <button id="s-work-pick">…</button>
    </div>
    <div class="hint" style="margin:6px 0 0">
      Leave this empty. Since 0.8 the compiler resolves <code>runtime/</code>,
      <code>toolchain/</code> and the standard library from its own location, so runs
      happen in your project folder and <code>sim.cpp</code>, <code>sim</code> and
      <code>simulation_output.csv</code> land beside the circuit.
    </div>

    <div class="insp-title" style="margin:14px 0 6px">Standard library</div>
    <div class="hint" style="margin:0 0 8px">
      ${s.stdlibOK
        ? `Installed — ${s.packages} package root${s.packages === 1 ? '' : 's'} visible.
           <code>hover hpm install</code> adds more.`
        : `Not installed. Releases do not bundle it, so
           <code>import &lt;math&gt;</code> cannot resolve until you run setup once.`}
    </div>
    <div class="row">
      <label></label>
      <button id="s-setup" ${s.binOK ? '' : 'disabled'}>Run hover --setup</button>
    </div>

    <div class="err-item" id="s-note" style="color:${s.binOK && s.runtimeOK && s.stdlibOK ? 'var(--status-ok)' : 'var(--text-link-hover)'}">
      ${esc(s.note)}
    </div>

    <div class="actions">
      <button data-x="no">Cancel</button>
      <button data-x="yes" class="primary">Save</button>
    </div>`);

  const bin = root.querySelector('#s-bin') as HTMLInputElement;
  const work = root.querySelector('#s-work') as HTMLInputElement;

  root.querySelector('#s-bin-pick')!.addEventListener('click', async () => {
    const v = (await API.PickHoverBinary()) as unknown as SettingsView;
    bin.value = v.hoverBin;
    work.value = v.workDir;
    (root.querySelector('#s-note') as HTMLElement).textContent = v.note;
  });
  root.querySelector('#s-work-pick')!.addEventListener('click', async () => {
    const v = (await API.PickWorkDir()) as unknown as SettingsView;
    work.value = v.workDir;
    (root.querySelector('#s-note') as HTMLElement).textContent = v.note;
  });
  // Setup downloads the standard library and builds the runtime, which takes
  // long enough to watch: the dialog closes so its output is visible in the
  // console, exactly as a run would be.
  root.querySelector('#s-setup')!.addEventListener('click', async () => {
    try {
      await API.SaveSettings(bin.value.trim(), work.value.trim());
      close();
      await runSetup();
    } catch (e) { showErr(e); }
  });

  root.querySelector('[data-x="no"]')!.addEventListener('click', close);
  root.querySelector('[data-x="yes"]')!.addEventListener('click', async () => {
    try {
      await API.SaveSettings(bin.value.trim(), work.value.trim());
      close();
      const info = (await API.Info()) as unknown as ProjectInfo;
      state.project = info;
      await loadCatalog();
      await refreshSheet();
      renderAll();
      setRunning(false);
      toast('Settings saved', 'ok');
    } catch (e) { showErr(e); }
  });
}

// ── Project lifecycle ────────────────────────────────────────────────────

async function openProject() {
  try {
    const info = (await API.PickProject()) as unknown as ProjectInfo;
    if (!info?.open) return;
    state.project = info;
    state.stack = [];
    await loadCatalog();
    await gotoSheet(pickInitialSheet(info));
    renderAll(true);
  } catch (e) { showErr(e); }
}

/**
 * Asks whether to open a single file or a whole folder, then does it.
 *
 * The two are genuinely different actions — one picks the circuit, the other
 * sets up a workspace to browse — so the choice is presented rather than
 * guessed at, but from a single entry point.
 */
function openAny(): Promise<void> {
  return new Promise((resolve) => {
    const { root, close } = modal(`
      <h3>Open</h3>
      <div class="hint">Choose what to open.</div>
      <div class="open-choice" data-pick="file">
        <div class="oc-icon">${ui('file-code', 22)}</div>
        <div>
          <div class="oc-title">Hover file</div>
          <div class="oc-sub">Load one <code>.hvr</code> as the circuit and draw it.</div>
        </div>
      </div>
      <div class="open-choice" data-pick="folder">
        <div class="oc-icon">${ui('folder', 22)}</div>
        <div>
          <div class="oc-title">Folder / workspace</div>
          <div class="oc-sub">Browse a project tree. A lone <code>main.hvr</code> loads automatically.</div>
        </div>
      </div>
      <div class="actions"><button data-x="no">Cancel</button></div>`);

    const done = async (kind: 'file' | 'folder') => {
      close();
      if (kind === 'file') await openProject();
      else await openFolder();
      resolve();
    };
    root.querySelectorAll('[data-pick]').forEach((el) =>
      el.addEventListener('click', () => done((el as HTMLElement).dataset.pick as 'file' | 'folder')));
    root.querySelector('[data-x="no"]')!.addEventListener('click', () => { close(); resolve(); });
  });
}

/**
 * Opens a folder as the workspace, the way an editor opens a project
 * directory. The folder and the active circuit are separate ideas: opening a
 * folder shows the tree, and a .hvr inside it becomes the circuit either
 * automatically (a lone main.hvr) or on double-click.
 */
async function openFolder() {
  try {
    const w = (await API.PickFolder()) as unknown as Workspace;
    if (!w?.open) return;
    state.workspace = w;
    state.leftTab = 'files';

    // OpenFolder may have adopted an entry file on the Go side.
    const info = (await API.Info()) as unknown as ProjectInfo;
    if (info.open && info.entry !== state.project?.entry) {
      state.project = info;
      state.stack = [];
      await loadCatalog();
      await gotoSheet(pickInitialSheet(info));
    }
    renderAll(true);
    toast(`Opened ${w.name}`, 'ok');
  } catch (e) { showErr(e); }
}

function pickInitialSheet(info: ProjectInfo): string {
  const sheets = info.sheets ?? [];
  const main = sheets.find((s) => s.isMain);
  return main?.qualified ?? sheets[0]?.qualified ?? '';
}

async function reload(notify = false) {
  if (!state.project) return;
  try {
    const info = (await API.Reload()) as unknown as ProjectInfo;
    state.project = info;
    await loadCatalog();
    await refreshSheet();
    if (state.editorFile) {
      const f = (await API.ReadFile(state.editorFile)) as unknown as SourceFile;
      if (!state.dirty) editor.refresh(f.text);
    }
    renderAll();
    if (notify) toast('Reloaded from disk', 'ok');
  } catch (e) { showErr(e); }
}

async function loadCatalog() {
  state.catalog = (await API.GetCatalog()) as unknown as Catalog;
  // Symbols come with the catalog; every icon and symbol drawn after this
  // uses them, so install them before anything re-renders.
  setSymbols(state.catalog?.symbols);
}

async function gotoSheet(qualified: string, push = true) {
  if (!qualified) { state.sheet = null; return; }
  try {
    state.sheet = normalizeSheet((await API.GetSheet(qualified)) as unknown as Sheet);
    if (push) {
      const at = state.stack.indexOf(qualified);
      if (at >= 0) state.stack = state.stack.slice(0, at + 1);
      else state.stack.push(qualified);
    }
    state.selBlock = state.selNet = state.selSignal = null;
    canvas.render(state.sheet, true);
  } catch (e) { showErr(e); }
}

async function refreshSheet() {
  if (!state.sheet) return;
  try {
    state.sheet = normalizeSheet((await API.GetSheet(state.sheet.qualified)) as unknown as Sheet);
    canvas.render(state.sheet);
  } catch {
    // The module may have been renamed or removed by an external edit.
    const first = pickInitialSheet(state.project!);
    state.stack = [];
    await gotoSheet(first);
  }
  renderRight();
}

function renderAll(fit = false) {
  renderCrumbs();
  renderLeft();
  renderRight();
  renderStatus();
  const en = document.getElementById('entry-name')!;
  en.textContent = state.project ? baseName(state.project.entry) : '';
  if (fit) canvas.fit();
}

// ── Breadcrumbs ──────────────────────────────────────────────────────────

function renderCrumbs() {
  const el = document.getElementById('crumbs')!;
  if (!state.project) { el.innerHTML = ''; return; }

  const sheets = state.project.sheets ?? [];
  const opts = sheets
    .map((s) => `<option value="${esc(s.qualified)}"${s.qualified === state.stack[0] ? ' selected' : ''}>${esc(s.qualified)}</option>`)
    .join('');

  const crumbs = state.stack.map((q, i) => {
    const last = i === state.stack.length - 1;
    return `<span class="crumb ${last ? 'active' : ''}" data-goto="${esc(q)}">${esc(q)}</span>` +
           (last ? '' : '<span class="crumb-sep">/</span>');
  }).join('');

  el.innerHTML =
    `<select id="sheet-sel" title="Jump to a module">${opts}</select>` +
    `<span class="crumb-sep">·</span>` + crumbs;

  el.querySelectorAll('[data-goto]').forEach((c) =>
    c.addEventListener('click', () => gotoSheet((c as HTMLElement).dataset.goto!)));

  const sel = document.getElementById('sheet-sel') as HTMLSelectElement | null;
  sel?.addEventListener('change', async () => {
    state.stack = [];
    await gotoSheet(sel.value);
    renderAll(true);
  });
}

// ── Left pane ────────────────────────────────────────────────────────────

function renderLeft() {
  document.querySelectorAll('[data-lt]').forEach((el) =>
    el.classList.toggle('active', (el as HTMLElement).dataset.lt === state.leftTab));
  (document.querySelector('.search-wrap') as HTMLElement).style.display =
    state.leftTab === 'blocks' ? '' : 'none';

  const body = document.getElementById('left-body')!;
  body.innerHTML = state.leftTab === 'blocks' ? paletteHtml() : filesHtml();

  if (state.leftTab === 'blocks') {
    body.querySelectorAll('.pal-item').forEach((el) => {
      el.setAttribute('draggable', 'true');
      el.addEventListener('dragstart', (e) => {
        (e as DragEvent).dataTransfer!.setData(
          'application/x-hoverdeck', (el as HTMLElement).dataset.payload!);
        (e as DragEvent).dataTransfer!.effectAllowed = 'copy';
      });
      el.addEventListener('dblclick', () => {
        onDrop((el as HTMLElement).dataset.payload!, 120, 120);
      });
    });
  } else {
    body.querySelectorAll('.file-item').forEach((el) =>
      el.addEventListener('click', () => openInEditor((el as HTMLElement).dataset.path!)));

    // One delegated listener for the whole tree instead of two per row: with
    // a few thousand files, attaching listeners individually is itself a
    // measurable cost every time the pane re-renders.
    if (!body.dataset.wired) {
      body.dataset.wired = '1';
      body.addEventListener('click', onTreeClick);
      body.addEventListener('dblclick', onTreeDblClick);
    }

    document.getElementById('ws-newfile')?.addEventListener('click', () => createItem('file'));
    document.getElementById('ws-newdir')?.addEventListener('click', () => createItem('folder'));
    document.getElementById('ws-close')?.addEventListener('click', async () => {
      state.workspace = (await API.CloseFolder()) as unknown as Workspace;
      renderLeft();
    });
  }
}

/** Expands/collapses a folder, fetching its contents the first time. */
async function onTreeClick(ev: Event) {
  const t = ev.target as HTMLElement;

  const dir = t.closest('.tree-row.dir') as HTMLElement | null;
  if (dir) {
    const path = dir.dataset.dir!;
    if (state.expanded.has(path)) {
      state.expanded.delete(path);
      renderLeft();
      return;
    }
    state.expanded.add(path);
    if (!state.children.has(path)) {
      renderLeft(); // show the placeholder while the listing loads
      try {
        const kids = (await API.ListDir(path)) as unknown as TreeNode[];
        state.children.set(path, kids ?? []);
      } catch (e) {
        state.expanded.delete(path);
        showErr(e);
      }
    }
    renderLeft();
    return;
  }

  const file = t.closest('.tree-row.file') as HTMLElement | null;
  if (file) {
    // CSVs are results, not source: opening one in a text editor is never
    // what is wanted, so a single click plots it.
    if (file.dataset.csv === 'true') {
      await togglePlot(true, file.dataset.file!);
      return;
    }
    openInEditor(file.dataset.file!);
  }
}

async function onTreeDblClick(ev: Event) {
  const file = (ev.target as HTMLElement).closest('.tree-row.file') as HTMLElement | null;
  if (!file) return;
  if (file.dataset.hvr === 'true') await loadAsCircuit(file.dataset.file!);
}

/** Makes a .hvr the active circuit: the sheet the canvas draws. */
async function loadAsCircuit(path: string) {
  try {
    const info = (await API.OpenProject(path)) as unknown as ProjectInfo;
    state.project = info;
    state.stack = [];
    await loadCatalog();
    await gotoSheet(pickInitialSheet(info));
    await refreshWorkspace();
    renderAll(true);
    toast(`Loaded ${baseName(path)} as the circuit`, 'ok');
  } catch (e) { showErr(e); }
}

async function refreshWorkspace() {
  try {
    state.workspace = (await API.WorkspaceTree()) as unknown as Workspace;
    // Re-fetch only the levels the user actually has open.
    const open = [...state.expanded];
    state.children.clear();
    await Promise.all(open.map(async (p) => {
      try {
        state.children.set(p, (await API.ListDir(p)) as unknown as TreeNode[]);
      } catch { state.expanded.delete(p); }
    }));
  } catch { /* no workspace open */ }
}

/** Creates a file or folder next to the current selection. */
async function createItem(kind: 'file' | 'folder') {
  const ws = state.workspace;
  const base = ws?.open ? ws.root : (state.project ? dirName(state.project.entry) : '');
  if (!base) { toast('Open a folder first', 'err'); return; }

  // Offer every directory in the workspace so the item can be placed anywhere
  // without hunting through a native dialog.
  const dirs = collectDirs(ws?.tree ?? [], base);
  const opts = dirs.map((d) =>
    `<option value="${esc(d.path)}">${esc(d.label)}</option>`).join('');

  const { root, close } = modal(`
    <h3>New ${kind}</h3>
    <div class="hint">${kind === 'file'
      ? 'A name with no extension gets <code>.hvr</code>. New .hvr files start from a small working skeleton.'
      : 'Creates an empty folder inside the workspace.'}</div>
    <div class="row">
      <label>in</label>
      <select id="ci-dir">${opts}</select>
    </div>
    <div class="row">
      <label>name</label>
      <input id="ci-name" placeholder="${kind === 'file' ? 'filter.hvr' : 'components'}"/>
    </div>
    <div class="err-item" id="ci-err" style="display:none"></div>
    <div class="actions">
      <button data-x="no">Cancel</button>
      <button data-x="yes" class="primary">Create</button>
    </div>`);

  const nameInput = root.querySelector('#ci-name') as HTMLInputElement;
  const err = root.querySelector('#ci-err') as HTMLElement;
  nameInput.focus();

  const submit = async () => {
    const dir = (root.querySelector('#ci-dir') as HTMLSelectElement).value;
    const name = nameInput.value.trim();
    if (!name) { err.style.display = ''; err.textContent = 'Enter a name.'; return; }
    try {
      const path = kind === 'file'
        ? await API.CreateFile(dir, name)
        : await API.CreateFolder(dir, name);
      close();
      await refreshWorkspace();
      renderLeft();
      if (kind === 'file') {
        await openInEditor(path);
        toast(`Created ${baseName(path)}`, 'ok');
      } else {
        toast(`Created folder ${name}`, 'ok');
      }
    } catch (e) {
      err.style.display = '';
      err.textContent = e instanceof Error ? e.message : String(e);
    }
  };

  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  root.querySelector('[data-x="no"]')!.addEventListener('click', close);
  root.querySelector('[data-x="yes"]')!.addEventListener('click', submit);
}

/** Flattens the tree into a list of directories for the destination picker. */
function collectDirs(nodes: TreeNode[], root: string): { path: string; label: string }[] {
  const out = [{ path: root, label: baseName(root) + '/' }];
  const walk = (ns: TreeNode[], prefix: string) => {
    for (const n of ns) {
      if (!n.isDir) continue;
      const label = prefix + n.name + '/';
      out.push({ path: n.path, label });
      walk(n.children ?? [], label);
    }
  };
  walk(nodes, baseName(root) + '/');
  return out;
}

function dirName(p: string): string {
  const parts = p.split(/[\\/]/);
  parts.pop();
  return parts.join('/');
}

function matches(name: string, desc: string): boolean {
  if (!state.search) return true;
  return (name + ' ' + desc).toLowerCase().includes(state.search);
}

function paletteHtml(): string {
  const c = state.catalog;
  if (!c) return `<div class="group-label">Open a file to load blocks</div>`;

  const out: string[] = [];

  const prims = (c.primitives ?? []).filter((p) => matches(p.name, p.desc));
  if (prims.length) {
    out.push(`<div class="group-label">Primitives</div>`);
    for (const p of prims) out.push(primItem(p));
  }

  const groups = new Map<string, CatalogEntry[]>();
  for (const e of c.stdlib ?? []) {
    if (!matches(e.name, e.desc)) continue;
    if (!groups.has(e.group)) groups.set(e.group, []);
    groups.get(e.group)!.push(e);
  }
  for (const [g, items] of groups) {
    out.push(`<div class="group-label">${esc(g)}</div>`);
    for (const e of items) out.push(modItem(e));
  }

  const local = (c.local ?? []).filter((e) => matches(e.name, e.desc));
  if (local.length) {
    out.push(`<div class="group-label">This project</div>`);
    for (const e of local) out.push(modItem(e));
  }

  if (!out.length) out.push(`<div class="group-label">No matches</div>`);
  return out.join('');
}

function primItem(p: PrimitiveDef): string {
  const payload = JSON.stringify({ kind: 'primitive', name: p.name });
  const note = p.ready ? `${p.param}${p.unit ? ' · ' + p.unit : ''}` : 'not implemented yet';
  return `
    <div class="pal-item" data-payload='${esc(payload)}' title="${esc(p.desc)}">
      ${iconSvg(p.icon)}
      <div class="pal-text">
        <div class="pal-name">${esc(p.name)}</div>
        <div class="pal-sub">${esc(note)}</div>
      </div>
      <span class="dom-dot dom-primitive"></span>
    </div>`;
}

function modItem(e: CatalogEntry): string {
  const payload = JSON.stringify({
    kind: 'module', name: e.name, importPath: e.importPath,
    qualifier: e.qualifier, alias: e.suggestAlias, group: e.group,
  });
  const ports = (e.physPorts ?? []).length;
  return `
    <div class="pal-item" data-payload='${esc(payload)}' title="${esc(e.desc || e.name)}">
      ${iconSvg(e.icon)}
      <div class="pal-text">
        <div class="pal-name">${esc(e.name)}</div>
        <div class="pal-sub">${esc(e.domain)} · ${ports} port${ports === 1 ? '' : 's'}</div>
      </div>
      <span class="dom-dot dom-${esc(e.domain)}"></span>
    </div>`;
}

function filesHtml(): string {
  const p = state.project;
  const ws = state.workspace;
  let html = '';

  // A workspace folder, when one is open, browsed as a tree.
  if (ws?.open) {
    html += `
      <div class="ws-head">
        <span class="ws-name" title="${esc(ws.root)}">${esc(ws.name)}</span>
        <span class="grow"></span>
        <button class="mini" id="ws-newfile" title="New file">${ui('plus', 11)}file</button>
        <button class="mini" id="ws-newdir" title="New folder">${ui('plus', 11)}dir</button>
        <button class="mini" id="ws-close" title="Close folder">${ui('x', 11)}</button>
      </div>`;
    html += treeHtml(ws.tree ?? [], 0);
  }

  // The files the compiler actually reaches from the open circuit. This is a
  // different question from "what is in the folder", so both are shown.
  if (p) {
    const files = p.files ?? [];
    const own = files.filter((f) => !f.package);
    const row = (f: typeof own[number]) => `
      <div class="file-item ${f.path === state.editorFile ? 'active' : ''}" data-path="${esc(f.path)}">
        <span>${esc(f.name)}</span>
        <span class="badge ${f.errors ? 'err' : ''}">${f.errors ? f.errors + ' err' : f.lines + 'L'}</span>
      </div>`;
    html += `<div class="group-label">In this circuit</div>` + own.map(row).join('');

    // Package sources are grouped by the package they came from, not lumped
    // together as "standard library": since 0.8 an import resolves through one
    // table, and which package a file arrived in is what a reader needs.
    const byPkg = new Map<string, typeof own>();
    for (const f of files) {
      if (!f.package) continue;
      const list = byPkg.get(f.package) ?? [];
      list.push(f);
      byPkg.set(f.package, list);
    }
    for (const name of [...byPkg.keys()].sort()) {
      html += `<div class="group-label">${esc(name)}</div>` + byPkg.get(name)!.map(row).join('');
    }
  }

  if (!html) {
    html = `<div class="group-label">Nothing open</div>
      <div class="empty-note" style="padding:0 12px">
        Open a folder to browse it, or open a single .hvr file.
      </div>`;
  }
  return html;
}

/**
 * Renders the tree.
 *
 * Only directories the user has actually expanded contribute rows, and their
 * contents are fetched on demand. Rendering the whole tree eagerly is what
 * made a large folder feel frozen — thousands of DOM nodes, each with its own
 * listeners, for folders nobody had opened.
 */
function treeHtml(nodes: TreeNode[], depth: number): string {
  const out: string[] = [];
  for (const n of nodes) {
    const pad = 10 + depth * 12;
    if (n.isDir) {
      const open = state.expanded.has(n.path);
      out.push(
        `<div class="tree-row dir" data-dir="${esc(n.path)}" style="padding-left:${pad}px">` +
        `<span class="tw">${n.hasChildren ? ui(open ? 'chevron-down' : 'chevron-right', 11) : ''}</span>` +
        `<span class="tname">${esc(n.name)}</span></div>`);
      if (open) {
        const kids = state.children.get(n.path);
        if (kids) out.push(treeHtml(kids, depth + 1));
        else out.push(`<div class="tree-row" style="padding-left:${pad + 22}px;color:var(--text-faint)">loading…</div>`);
      }
      continue;
    }
    const cls = [
      'tree-row', 'file',
      n.isHVR ? 'hvr' : '',
      n.isCSV ? 'csv' : '',
      n.path === state.editorFile ? 'active' : '',
      n.isEntry ? 'entry' : '',
    ].filter(Boolean).join(' ');
    const hint = n.isHVR ? 'Click to edit · double-click to load as the circuit'
               : n.isCSV ? 'Double-click to plot'
               : '';
    out.push(
      `<div class="${cls}" data-file="${esc(n.path)}" data-hvr="${n.isHVR}" data-csv="${n.isCSV}" ` +
      `style="padding-left:${pad + 12}px" title="${hint}">` +
      `<span class="tname">${esc(n.name)}</span>` +
      (n.isEntry ? '<span class="badge-entry">circuit</span>' : '') +
      `</div>`);
  }
  return out.join('');
}

// ── Right pane ───────────────────────────────────────────────────────────

function renderRight() {
  document.querySelectorAll('[data-rt]').forEach((el) =>
    el.classList.toggle('active', (el as HTMLElement).dataset.rt === state.rightTab));

  const insp = document.getElementById('insp-body')!;
  const code = document.getElementById('code-body')!;
  insp.style.display = state.rightTab === 'inspect' ? '' : 'none';
  code.style.display = state.rightTab === 'code' ? 'flex' : 'none';

  if (state.rightTab === 'inspect') renderInspector();
  else renderEditorTabs();
}

function renderEditorTabs() {
  // The editor owns its own footer; the tab strip lives above it.
  let strip = document.getElementById('ed-tabs');
  if (!strip) {
    strip = document.createElement('div');
    strip.id = 'ed-tabs';
    strip.className = 'ed-tabs';
    document.getElementById('code-body')!.prepend(strip);
  }
  if (!state.editorFile) { strip.innerHTML = ''; return; }
  strip.innerHTML =
    `<div class="ed-tab active">` +
    (state.dirty ? `<span class="dot"></span>` : '') +
    `<span>${esc(baseName(state.editorFile))}</span></div>`;
}

function renderInspector() {
  const el = document.getElementById('insp-body')!;
  if (!state.sheet) {
    el.innerHTML = `<div class="insp-section"><div class="empty-note">
      Open a .hvr file to see its blocks and wiring.</div></div>`;
    return;
  }
  if (state.selBlock) { renderBlockInspector(el); return; }
  if (state.selNet) { renderNetInspector(el); return; }
  if (state.selSignal) { renderSignalInspector(el); return; }
  renderSheetInspector(el);
}

function renderSheetInspector(el: HTMLElement) {
  const sh = state.sheet!;
  const states = sh.signals.filter((s) => s.isState);
  const errs = sh.errors ?? [];

  el.innerHTML = `
    <div class="insp-head">
      ${iconSvg(sh.domain === 'analog' ? 'analog' : 'structural')}
      <div>
        <div class="insp-name">${esc(sh.qualified)}</div>
        <div class="insp-sub">${esc(sh.domain)} module · ${esc(baseName(sh.file))}:${sh.span.startLine}</div>
      </div>
    </div>

    ${errs.length ? `<div class="insp-section">
      <div class="insp-title">Problems</div>
      ${errs.map((e) => `<div class="err-item">${esc(e)}</div>`).join('')}
    </div>` : ''}

    <div class="insp-section">
      <div class="insp-title">Contents</div>
      <div class="row"><label>blocks</label><span>${sh.blocks.length}</span></div>
      <div class="row"><label>nets</label><span>${sh.nets.length}</span></div>
      <div class="row"><label>signals</label><span>${sh.signals.length}</span></div>
      <div class="row"><label>state vars</label><span>${states.length}</span></div>
    </div>

    ${(sh.physPorts ?? []).length ? `<div class="insp-section">
      <div class="insp-title">Physical ports</div>
      <div>${(sh.physPorts ?? []).map((p) => `<span class="pill">${esc(p)}</span> `).join('')}</div>
    </div>` : ''}

    ${sh.signals.length ? `<div class="insp-section">
      <div class="insp-title">Signals &amp; state</div>
      ${sh.signals.map(signalRow).join('')}
    </div>` : ''}

    <div class="insp-section">
      <div class="insp-title">Source</div>
      <button id="i-edit">Edit this module</button>
    </div>`;

  document.getElementById('i-edit')?.addEventListener('click', () =>
    openInEditor(sh.file, sh.span.startLine, sh.span.endLine));
  wireSignalRows(el);
}

function signalRow(s: Signal): string {
  return `<div class="conn-item" data-signal="${esc(s.name)}">
    <span class="pill ${s.isState ? 'state' : ''}">${s.isState ? 'state' : esc(s.type)}</span>
    <span>${esc(s.name)}</span>
    ${s.init ? `<span class="arrow">= ${esc(s.init)}</span>` : ''}
  </div>`;
}

function wireSignalRows(el: HTMLElement) {
  el.querySelectorAll('[data-signal]').forEach((r) =>
    r.addEventListener('click', () => {
      state.selBlock = state.selNet = null;
      state.selSignal = (r as HTMLElement).dataset.signal!;
      canvas.select(null, null, state.selSignal);
      renderInspector();
    }));
}

function renderBlockInspector(el: HTMLElement) {
  const sh = state.sheet!;
  const b = sh.blocks.find((x) => x.id === state.selBlock);
  if (!b) { state.selBlock = null; renderInspector(); return; }

  const prim = (state.catalog?.primitives ?? []).find((p) => p.name === b.typeName);
  const defOk = b.def?.found;

  el.innerHTML = `
    <div class="insp-head">
      ${iconSvg(b.icon)}
      <div>
        <div class="insp-name">${esc(b.label)}</div>
        <div class="insp-sub">${esc(b.typeName)} · line ${b.line}</div>
      </div>
    </div>

    ${!defOk && b.kind === 'instance' ? `<div class="insp-section">
      <div class="err-item">Module “${esc(b.typeName)}” is not visible here — its import may be missing.</div>
    </div>` : ''}

    ${b.def?.doc ? `<div class="insp-section"><div class="doc">${esc(b.def.doc)}</div></div>` : ''}

    ${b.params.length ? `<div class="insp-section">
      <div class="insp-title">Parameters &lt;…&gt;</div>
      ${b.params.map((p, i) => `
        <div class="row">
          <label>${esc(paramName(b, i, prim))}</label>
          <input data-param="${i}" value="${esc(p.text)}"/>
          <span class="unit">${esc(prim?.unit ?? '')}</span>
        </div>`).join('')}
    </div>` : ''}

    ${b.logic.length ? `<div class="insp-section">
      <div class="insp-title">Logic ports (…)</div>
      ${b.logic.map((a, i) => `
        <div class="row">
          <label>${esc(b.logicPorts?.[i]?.name ?? 'signal')}</label>
          <input data-logic="${i}" value="${esc(a.text)}"/>
        </div>`).join('')}
    </div>` : ''}

    ${b.pins.length ? `<div class="insp-section">
      <div class="insp-title">Physical ports [ … ]</div>
      ${b.pins.map((p) => `
        <div class="row">
          <label>${esc(p.name)}</label>
          <input data-pin="${p.index}" value="${esc(p.net)}" list="netlist"/>
        </div>`).join('')}
      <datalist id="netlist">
        ${sh.nets.map((n) => `<option value="${esc(n.name)}"></option>`).join('')}
      </datalist>
    </div>` : ''}

    <div class="insp-section">
      <div class="insp-title">Actions</div>
      <div class="row" style="gap:8px">
        ${b.navigable ? `<button id="b-enter" class="primary">${ui('log-in', 13)}Enter module</button>` : ''}
        ${defOk ? `<button id="b-src">Edit model</button>` : ''}
      </div>
      <div class="row" style="gap:8px; margin-top:8px">
        <button id="b-rot" title="Rotate 90° (R)">${ui('rotate-cw', 13)}${b.rot}°</button>
        <button id="b-fx" class="${b.flipX ? 'primary' : ''}" title="Mirror across the pin axis (H)">${ui('flip-horizontal', 13)}</button>
        <button id="b-fy" class="${b.flipY ? 'primary' : ''}" title="Reverse pin order (V)">${ui('flip-vertical', 13)}</button>
        <button id="b-icon" title="Choose the schematic symbol">${ui('shapes', 13)}</button>
      </div>
      <div class="row" style="gap:8px; margin-top:8px">
        <button id="b-line">Go to line</button>
        <button id="b-del" class="danger">${ui('trash-2', 13)}Delete</button>
      </div>
    </div>`;

  // Parameter / logic / port edits commit on Enter or blur.
  el.querySelectorAll<HTMLInputElement>('input[data-param]').forEach((inp) =>
    commitOn(inp, () => {
      const i = Number(inp.dataset.param);
      return applySpan(sh.file, b.params[i].span, inp.value.trim(), b.params[i].text);
    }));
  el.querySelectorAll<HTMLInputElement>('input[data-logic]').forEach((inp) =>
    commitOn(inp, () => {
      const i = Number(inp.dataset.logic);
      return applySpan(sh.file, b.logic[i].span, inp.value.trim(), b.logic[i].text);
    }));
  el.querySelectorAll<HTMLInputElement>('input[data-pin]').forEach((inp) =>
    commitOn(inp, () => {
      const i = Number(inp.dataset.pin);
      const pin = b.pins.find((p) => p.index === i)!;
      return applyPort(sh.file, pin.span, inp.value.trim(), pin.net);
    }));

  document.getElementById('b-enter')?.addEventListener('click', () => enterModule(b));
  document.getElementById('b-src')?.addEventListener('click', () =>
    openInEditor(b.def!.file, b.def!.span.startLine, b.def!.span.endLine));
  document.getElementById('b-line')?.addEventListener('click', () =>
    openInEditor(sh.file, b.line, b.stmt.endLine));
  document.getElementById('b-icon')?.addEventListener('click', () => pickIcon(b));
  document.getElementById('b-rot')?.addEventListener('click', () => transformBlock(b, 'rotate'));
  document.getElementById('b-fx')?.addEventListener('click', () => transformBlock(b, 'flipX'));
  document.getElementById('b-fy')?.addEventListener('click', () => transformBlock(b, 'flipY'));
  document.getElementById('b-del')?.addEventListener('click', () => deleteBlock(b));
}

/**
 * Rotates or mirrors a block. This is layout only — the sidecar records it and
 * the .hvr is untouched, because orientation says nothing about the netlist.
 */
async function transformBlock(b: Block, what: 'rotate' | 'flipX' | 'flipY') {
  if (!state.sheet) return;
  const rot = what === 'rotate' ? (b.rot + 90) % 360 : b.rot;
  const fx = what === 'flipX' ? !b.flipX : b.flipX;
  const fy = what === 'flipY' ? !b.flipY : b.flipY;
  try {
    await API.SetBlockTransform(state.sheet.qualified, b.id, rot, fx, fy);
    await refreshSheet();
    renderRight();
  } catch (e) { showErr(e); }
}

function paramName(b: Block, i: number, prim?: PrimitiveDef): string {
  if (b.kind === 'primitive') return prim?.param ?? `arg${i + 1}`;
  return `arg${i + 1}`;
}

function renderNetInspector(el: HTMLElement) {
  const sh = state.sheet!;
  const net = sh.nets.find((n) => n.name === state.selNet);
  if (!net) { state.selNet = null; renderInspector(); return; }

  const conns: string[] = [];
  for (const b of sh.blocks) {
    for (const p of b.pins) {
      if (p.net !== net.name) continue;
      conns.push(`<div class="conn-item" data-block="${esc(b.id)}">
        <span class="arrow">${esc(p.name)}</span>
        <span>${esc(b.label)}</span>
        <span class="arrow">(${esc(b.typeName)})</span>
      </div>`);
    }
  }

  el.innerHTML = `
    <div class="insp-head">
      ${iconSvg('structural')}
      <div>
        <div class="insp-name">${esc(net.name)}</div>
        <div class="insp-sub">${net.isGround ? 'ground reference' : 'net'} · ${conns.length} connection${conns.length === 1 ? '' : 's'}</div>
      </div>
    </div>

    <div class="insp-section">
      <div class="insp-title">Properties</div>
      <div class="row"><label>declared</label><span>${net.declared ? 'line ' + net.declLine : 'implicit'}</span></div>
      <div class="row"><label>boundary</label><span>${net.isBoundary ? 'yes — module port' : 'no'}</span></div>
    </div>

    <div class="insp-section">
      <div class="insp-title">Connected to</div>
      ${conns.join('') || '<div class="empty-note">Nothing attached.</div>'}
    </div>

    <div class="insp-section">
      <div class="insp-title">Routing</div>
      <div class="row">
        <span>${net.wires ? 'edited by hand' : 'automatic'}</span>
        <span class="spacer" style="flex:1"></span>
        <button id="net-auto" ${net.wires ? '' : 'disabled'}>Reset to automatic</button>
      </div>
      <div class="empty-note" style="margin-top:6px">
        Drag any segment of a wire to move it, or a bend to move it both ways.
        Double-click a segment to add a bend, a bend to remove it. The first
        edit fixes the wire's shape; moving a block stretches it to follow.
      </div>
    </div>

    ${!net.isGround ? `<div class="insp-section">
      <div class="insp-title">Rename</div>
      <div class="row">
        <input id="net-new" value="${esc(net.name)}"/>
        <button id="net-go" class="primary">Apply</button>
      </div>
      <div class="empty-note" style="margin-top:6px">
        Renames every use in this module, and its wire declaration.
      </div>
    </div>` : ''}`;

  el.querySelectorAll('[data-block]').forEach((r) =>
    r.addEventListener('click', () => {
      state.selNet = state.selSignal = null;
      state.selBlock = (r as HTMLElement).dataset.block!;
      canvas.select(state.selBlock, null, null);
      renderInspector();
    }));

  document.getElementById('net-auto')?.addEventListener('click', async () => {
    try {
      await API.ClearNetWires(sh.qualified, net.name);
      await refreshSheet();
      renderInspector();
    } catch (e) { showErr(e); }
  });

  document.getElementById('net-go')?.addEventListener('click', async () => {
    const v = (document.getElementById('net-new') as HTMLInputElement).value.trim();
    if (!v || v === net.name) return;
    try {
      const n = await API.RenameNet(sh.qualified, net.name, v);
      await afterMutation();
      state.selNet = v;
      canvas.select(null, v, null);
      renderInspector();
      toast(`Renamed to ${v} in ${n} place${n === 1 ? '' : 's'}`, 'ok');
    } catch (e) { showErr(e); }
  });
}

function renderSignalInspector(el: HTMLElement) {
  const sh = state.sheet!;
  const sig = sh.signals.find((s) => s.name === state.selSignal);
  if (!sig) { state.selSignal = null; renderInspector(); return; }

  const readers: string[] = [];
  for (const b of sh.blocks) {
    b.logic.forEach((a, i) => {
      if (a.text.trim() !== sig.name) return;
      const dir = b.logicPorts?.[i]?.direction || 'in';
      readers.push(`<div class="conn-item" data-block="${esc(b.id)}">
        <span class="arrow">${dir === 'output' ? '←' : '→'}</span>
        <span>${esc(b.label)}</span>
        <span class="arrow">${esc(b.logicPorts?.[i]?.name ?? '')}</span>
      </div>`);
    });
  }

  el.innerHTML = `
    <div class="insp-head">
      ${iconSvg(sig.isState ? 'digital' : 'analog')}
      <div>
        <div class="insp-name">${esc(sig.name)}</div>
        <div class="insp-sub">${sig.isState ? 'state ' : ''}${esc(sig.type)} · line ${sig.line}</div>
      </div>
    </div>

    ${sig.isState ? `<div class="insp-section"><div class="doc">
      A <b>state</b> variable is initialised once at t = 0 and keeps its value
      across timesteps — the equivalent of a register.
    </div></div>` : ''}

    <div class="insp-section">
      <div class="insp-title">Declaration</div>
      <div class="row"><label>type</label><span>${esc(sig.type)}</span></div>
      <div class="row"><label>initial</label><span>${esc(sig.init || '—')}</span></div>
    </div>

    <div class="insp-section">
      <div class="insp-title">Used by</div>
      ${readers.join('') || '<div class="empty-note">Not passed to any logic port in this module.</div>'}
    </div>

    ${readers.length ? `<div class="insp-section">
      <div class="insp-title">Routing</div>
      <div class="row">
        <span>${sig.wires ? 'edited by hand' : 'automatic'}</span>
        <span class="spacer" style="flex:1"></span>
        <button id="s-auto" ${sig.wires ? '' : 'disabled'}>Reset to automatic</button>
      </div>
      <div class="empty-note" style="margin-top:6px">
        The dashed links edit like wires: drag a segment or a bend, double-click
        to add or remove a bend.
      </div>
    </div>` : ''}

    <div class="insp-section">
      <button id="s-src">Show declaration</button>
    </div>`;

  el.querySelectorAll('[data-block]').forEach((r) =>
    r.addEventListener('click', () => {
      state.selSignal = null;
      state.selBlock = (r as HTMLElement).dataset.block!;
      canvas.select(state.selBlock, null, null);
      renderInspector();
    }));
  document.getElementById('s-src')?.addEventListener('click', () =>
    openInEditor(sh.file, sig.line, sig.line));
  document.getElementById('s-auto')?.addEventListener('click', async () => {
    try {
      await API.ClearSignalWires(sh.qualified, sig.name);
      await refreshSheet();
      renderInspector();
    } catch (e) { showErr(e); }
  });
}

// ── Actions ──────────────────────────────────────────────────────────────

function commitOn(inp: HTMLInputElement, run: () => Promise<void>) {
  let busy = false;
  const go = async () => {
    if (busy) return;
    busy = true;
    try { await run(); } finally { busy = false; }
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  inp.addEventListener('blur', go);
}

async function applySpan(file: string, span: any, value: string, prev: string) {
  if (!value || value === prev) return;
  try {
    await API.SetSpanText(file, span, value);
    await afterMutation();
  } catch (e) { showErr(e); }
}

async function applyPort(file: string, span: any, value: string, prev: string) {
  if (!value || value === prev) return;
  try {
    await API.SetPortNet(file, span, value);
    await afterMutation();
  } catch (e) { showErr(e); }
}

/** Every mutation ends here: reload from disk, then repaint. */
async function afterMutation() {
  const info = (await API.Info()) as unknown as ProjectInfo;
  state.project = info;
  await refreshSheet();
  await loadCatalog();
  renderAll();
  if (state.editorFile && !state.dirty) {
    const f = (await API.ReadFile(state.editorFile)) as unknown as SourceFile;
    editor.refresh(f.text);
  }
}

async function enterModule(b: Block) {
  if (!b.def?.found) return;
  await gotoSheet(b.typeName);
  renderAll(true);
}

async function openBlock(b: Block) {
  if (b.navigable) { await enterModule(b); return; }
  if (b.def?.found) openInEditor(b.def.file, b.def.span.startLine, b.def.span.endLine);
  else if (state.sheet) openInEditor(state.sheet.file, b.line, b.stmt.endLine);
}

/** Loads the block's defining source into the code tab without switching to it. */
async function previewBlockSource(id: string) {
  const b = state.sheet?.blocks.find((x) => x.id === id);
  if (!b?.def?.found) return;
  if (state.dirty) return;
  if (state.editorFile === b.def.file) {
    editor.highlightRange(b.def.span.startLine, b.def.span.endLine);
    return;
  }
  await loadIntoEditor(b.def.file, b.def.span.startLine, b.def.span.endLine);
}

async function openInEditor(path: string, startLine?: number, endLine?: number) {
  state.rightTab = 'code';
  await loadIntoEditor(path, startLine, endLine);
  renderRight();
}

async function loadIntoEditor(path: string, startLine?: number, endLine?: number) {
  try {
    const f = (await API.ReadFile(path)) as unknown as SourceFile;
    state.editorFile = path;
    editor.load(path, f.text, f.readOnly,
      startLine ? { startLine, endLine: endLine ?? startLine } : undefined);
    renderEditorTabs();
    renderLeft();
  } catch (e) { showErr(e); }
}

async function deleteBlock(b: Block) {
  if (!state.sheet) return;
  const ok = await confirmModal(
    `Delete ${b.label}?`,
    `This removes the statement on line ${b.line} of ${baseName(state.sheet.file)}. ` +
    `Nets left with no connections simply disappear from the diagram.`);
  if (!ok) return;
  try {
    await API.DeleteBlock(state.sheet.file, b.stmt as any);
    state.selBlock = null;
    await afterMutation();
    toast(`Deleted ${b.label}`, 'ok');
  } catch (e) { showErr(e); }
}

// ── Drop from palette ────────────────────────────────────────────────────

async function onDrop(payload: string, x: number, y: number) {
  if (!state.sheet) { toast('Open a file first', 'err'); return; }
  let p: any;
  try { p = JSON.parse(payload); } catch { return; }

  const sh = state.sheet;
  const entry = p.kind === 'primitive'
    ? (state.catalog?.primitives ?? []).find((e) => e.name === p.name)
    : [...(state.catalog?.stdlib ?? []), ...(state.catalog?.local ?? [])]
        .find((e) => e.name === p.name && (e.importPath ?? '') === (p.importPath ?? ''));
  if (!entry) return;

  const cfg = await insertModal(p, entry, sh);
  if (!cfg) return;

  try {
    const req: InsertRequest = {
      file: sh.file,
      module: sh.qualified,
      kind: p.kind,
      typeName: p.name,
      alias: p.kind === 'module' ? (cfg.alias ?? '') : '',
      importPath: p.kind === 'module' ? (p.importPath ?? '') : '',
      // Only consulted when no import is added: a local module reached through
      // an import that already exists is still only visible behind it.
      qualifier: p.kind === 'module' ? (p.qualifier ?? '') : '',
      instance: cfg.instance ?? '',
      static: cfg.static ?? '',
      logic: cfg.logic ?? '',
      ports: cfg.ports ?? [],
    };
    const res = (await API.InsertBlock(req as any)) as unknown as { instanceName: string; importAdded: boolean; line: number };

    await afterMutation();

    // Place the new block where it was dropped.
    const id = p.kind === 'primitive' ? newestPrimitiveId(p.name) : res.instanceName;
    if (id) {
      await API.SetBlockPosition(sh.qualified, id, Math.round(x / 8) * 8, Math.round(y / 8) * 8);
      await refreshSheet();
      state.selBlock = id;
      canvas.select(id, null, null);
      renderRight();
    }
    toast(res.importAdded ? `Added ${p.name} and its import` : `Added ${p.name}`, 'ok');
  } catch (e) { showErr(e); }
}

/** The freshly inserted primitive is the last one of its type on the sheet. */
function newestPrimitiveId(typeName: string): string | null {
  const ids = (state.sheet?.blocks ?? [])
    .filter((b) => b.kind === 'primitive' && b.typeName === typeName)
    .map((b) => b.id);
  return ids.length ? ids[ids.length - 1] : null;
}

// ── Modals ───────────────────────────────────────────────────────────────

function modal(html: string): { root: HTMLElement; close: () => void } {
  const root = document.createElement('div');
  root.className = 'modal-back';
  root.innerHTML = `<div class="modal">${html}</div>`;
  document.body.appendChild(root);
  const close = () => root.remove();
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
  return { root, close };
}

function confirmModal(title: string, hint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { root, close } = modal(`
      <h3>${esc(title)}</h3>
      <div class="hint">${esc(hint)}</div>
      <div class="actions">
        <button data-x="no">Cancel</button>
        <button data-x="yes" class="danger">Delete</button>
      </div>`);
    root.querySelector('[data-x="no"]')!.addEventListener('click', () => { close(); resolve(false); });
    root.querySelector('[data-x="yes"]')!.addEventListener('click', () => { close(); resolve(true); });
  });
}

interface InsertCfg { instance?: string; alias?: string; static?: string; logic?: string; ports?: string[]; }

/** Asks for the arguments a new block needs before writing it into the file. */
function insertModal(p: any, entry: PrimitiveDef | CatalogEntry, sh: SafeSheet): Promise<InsertCfg | null> {
  const isPrim = p.kind === 'primitive';
  const prim = entry as PrimitiveDef;
  const mod = entry as CatalogEntry;

  const ports = isPrim ? prim.ports : (mod.physPorts ?? []);
  const params = isPrim
    ? [{ name: prim.param, type: '', default: defaultForPrim(prim.name) }]
    : (mod.staticParams ?? []);
  const logicPorts = isPrim
    ? (prim.driveable ? [{ name: 'control signal (optional)', type: '', direction: 'input' }] : [])
    : (mod.logicPorts ?? []);

  const netOpts = sh.nets.map((n) => `<option value="${esc(n.name)}"></option>`).join('');

  const html = `
    <h3>Add ${esc(p.name)}</h3>
    <div class="hint">
      ${isPrim ? esc(prim.desc) : esc(mod.desc || `${mod.domain} module`)}
      <br>Writes one statement into <b>${esc(sh.qualified)}</b>${
        !isPrim && mod.importPath ? `, adding <code>import &lt;${esc(mod.importPath)}&gt;</code> if needed` : ''}${
        !isPrim && mod.qualifier ? `, as <code>${esc(mod.qualifier)}.${esc(mod.name)}</code>` : ''}.
    </div>

    ${!isPrim ? `
      <div class="row"><label>instance</label>
        <input id="m-inst" placeholder="auto" value=""/></div>
      ${mod.importPath ? `<div class="row"><label>import as</label>
        <input id="m-alias" value="${esc(mod.suggestAlias ?? '')}"
               placeholder="${esc(mod.qualifier ?? '')}"/></div>
        <div class="hint" style="margin:2px 0 0">
          An import binds one name for the whole directory; leave this empty to
          use <code>${esc(mod.qualifier ?? '')}</code>.
        </div>` : ''}
    ` : ''}

    ${params.length ? `<div class="insp-title" style="margin:12px 0 6px">Parameters &lt;…&gt;</div>
      ${params.map((sp, i) => `<div class="row">
        <label>${esc(sp.name || 'value')}</label>
        <input data-sp="${i}" value="${esc(sp.default ?? '')}"/>
      </div>`).join('')}` : ''}

    ${logicPorts.length ? `<div class="insp-title" style="margin:12px 0 6px">Logic ports (…)</div>
      ${logicPorts.map((lp, i) => `<div class="row">
        <label>${esc(lp.name)}</label>
        <input data-lp="${i}" placeholder="${lp.direction === 'output' ? 'signal to write' : 'signal to read'}"/>
      </div>`).join('')}` : ''}

    ${ports.length ? `<div class="insp-title" style="margin:12px 0 6px">Physical ports [ … ]</div>
      ${ports.map((pn, i) => `<div class="row">
        <label>${esc(pn)}</label>
        <input data-pp="${i}" list="ins-nets" value="${i === ports.length - 1 && ports.length <= 2 ? 'gnd' : ''}"
               placeholder="net name"/>
      </div>`).join('')}
      <datalist id="ins-nets">${netOpts}</datalist>` : ''}

    <div class="err-item" id="m-err" style="display:none"></div>
    <div class="actions">
      <button data-x="no">Cancel</button>
      <button data-x="yes" class="primary">Add block</button>
    </div>`;

  return new Promise((resolve) => {
    const { root, close } = modal(html);
    const err = root.querySelector('#m-err') as HTMLElement;

    root.querySelector('[data-x="no"]')!.addEventListener('click', () => { close(); resolve(null); });
    root.querySelector('[data-x="yes"]')!.addEventListener('click', () => {
      const portVals = ports.map((_, i) =>
        (root.querySelector(`[data-pp="${i}"]`) as HTMLInputElement)?.value.trim() ?? '');
      const missing = portVals.some((v) => !v);
      if (missing) {
        err.style.display = '';
        err.textContent = 'Every physical port needs a net name.';
        return;
      }
      const bad = portVals.find((v) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v));
      if (bad) {
        err.style.display = '';
        err.textContent = `“${bad}” is not a valid identifier.`;
        return;
      }
      const statics = params
        .map((_, i) => (root.querySelector(`[data-sp="${i}"]`) as HTMLInputElement)?.value.trim() ?? '')
        .filter((v) => v !== '');
      const logics = logicPorts
        .map((_, i) => (root.querySelector(`[data-lp="${i}"]`) as HTMLInputElement)?.value.trim() ?? '')
        .filter((v) => v !== '');

      close();
      resolve({
        instance: (root.querySelector('#m-inst') as HTMLInputElement)?.value.trim(),
        alias: (root.querySelector('#m-alias') as HTMLInputElement)?.value.trim(),
        static: statics.join(', '),
        logic: logics.join(', '),
        ports: portVals,
      });
    });

    (root.querySelector('input') as HTMLInputElement)?.focus();
  });
}

function defaultForPrim(name: string): string {
  switch (name) {
    case 'R': return '1k';
    case 'C': return '100n';
    case 'L': return '10u';
    case 'voltage_source': return '5';
    case 'current_source': return '1m';
    default: return '1';
  }
}

function pickIcon(b: Block) {
  const cells = iconIds().map((id) =>
    `<div class="icon-cell ${id === b.icon ? 'sel' : ''}" data-icon="${esc(id)}" title="${esc(id)}">
       ${iconSvg(id)}
     </div>`).join('');
  const { root, close } = modal(`
    <h3>Symbol for ${esc(b.label)}</h3>
    <div class="hint">Saved in the sidecar file, not in your .hvr source. A symbol whose
      pins don't match this block's ports is shown as the block's header icon instead.</div>
    <div class="icon-grid">${cells}</div>
    <div class="actions"><button data-x="no">Close</button></div>`);

  root.querySelector('[data-x="no"]')!.addEventListener('click', close);
  root.querySelectorAll('[data-icon]').forEach((c) =>
    c.addEventListener('click', async () => {
      const icon = (c as HTMLElement).dataset.icon!;
      try {
        await API.SetBlockIcon(state.sheet!.qualified, b.id, icon);
        close();
        await refreshSheet();
        renderRight();
      } catch (e) { showErr(e); }
    }));
}

// ── Status + toasts ──────────────────────────────────────────────────────

function renderStatus(liveErrors?: string[]) {
  const el = document.getElementById('status')!;
  if (!state.project) {
    el.innerHTML = `<span class="seg"><span class="dot"></span>no circuit open</span>`;
    return;
  }
  const errs = liveErrors ?? state.project.errors ?? [];
  const pkgs = state.project.packages;
  const roots = Object.keys(pkgs?.roots ?? {}).length;
  const sh = state.sheet;

  // Every count is a number in the code family, tabular, paired with its noun.
  el.innerHTML =
    `<span class="seg ${errs.length ? 'err' : 'ok'}" id="st-err">` +
    `<span class="dot ${errs.length ? 'err' : 'ok'}"></span>` +
    (errs.length ? `<span class="num">${errs.length}</span> problem${errs.length === 1 ? '' : 's'}`
                 : 'no problems') +
    `</span>` +
    (sh ? `<span class="seg">${esc(sh.qualified)}</span>` +
          `<span class="seg">blocks <span class="num">${sh.blocks.length}</span></span>` +
          `<span class="seg">nets <span class="num">${sh.nets.length}</span></span>` +
          `<span class="seg">signals <span class="num">${sh.signals.length}</span></span>`
        : '') +
    (state.dirty ? `<span class="seg warn">unsaved changes</span>` : '') +
    `<span class="spacer" style="flex:1"></span>` +
    `<span class="seg" id="st-pkg" title="Click to re-read the lockfiles">packages ` +
    (pkgs?.stdlibInstalled
      ? `<span class="num">${roots}</span>`
      : `<span class="warn">no stdlib — run setup</span>`) + `</span>`;

  document.getElementById('st-err')?.addEventListener('click', () => {
    if (errs.length) toast(errs.join('\n'), 'err', 9000);
  });
  // Clicking opens the package table rather than a directory picker: since 0.8
  // there is nothing to pick. Where the packages are is the lockfile's answer,
  // and it changes when `hover hpm install` runs — here or in a terminal.
  document.getElementById('st-pkg')?.addEventListener('click', () => {
    if (!pkgs?.stdlibInstalled) { openSettings(); return; }
    openPackages();
  });
}

/**
 * The package table, and the commands that change it.
 *
 * Deliberately a thin front end for `hover hpm`: it is the same binary and the
 * same lockfiles either way, so anything hoverdeck resolved differently from
 * the CLI would be a bug rather than a feature. What the window adds is seeing
 * which roots an import actually resolves through, which the CLI cannot show
 * for the file you happen to have open.
 */
async function openPackages() {
  const pkgs = (await API.GetPackages()) as unknown as Packages;
  const roots = pkgs?.roots ?? {};
  const names = Object.keys(roots).sort();

  const { root, close } = modal(`
    <h3>Packages</h3>
    <div class="hint">
      What <code>import &lt;…&gt;</code> resolves through for the open file. Inside a project
      that is its <code>hover.lock</code> plus the machine's standard library; outside one,
      everything installed in <code>~/.hover</code>.
    </div>

    ${pkgs?.note ? `<div class="err-item">${esc(pkgs.note)}</div>` : ''}

    <div class="insp-title" style="margin:12px 0 6px">Roots <span class="num">${names.length}</span></div>
    <div class="pkg-list">
      ${names.length
        ? names.map((n) => `<div class="file-item"><span>${esc(n)}</span>
            <span class="badge" title="${esc(roots[n])}">${esc(shorten(roots[n]))}</span></div>`).join('')
        : `<div class="empty-note" style="padding:0 2px">Nothing installed.</div>`}
    </div>
    ${pkgs?.bundled ? `<div class="hint" style="margin:6px 0 0">
      Falling back to the copy bundled beside the compiler: <code>${esc(shorten(pkgs.bundled))}</code>.
      An installed package of the same name wins over it.
    </div>` : ''}

    <div class="insp-title" style="margin:14px 0 6px">hpm</div>
    <div class="row">
      <label>install</label>
      <input id="p-name" placeholder="package name"/>
      <button id="p-install" class="primary">Install</button>
    </div>
    <div class="row">
      <label></label>
      <button id="p-list">List</button>
      <button id="p-update">Update</button>
      <button id="p-verify">Verify</button>
    </div>
    <div class="hint" style="margin:6px 0 0">
      Runs in the project folder, writing its <code>hover.toml</code> and
      <code>hover.lock</code>. Output goes to the console.
    </div>

    <div class="actions">
      <button data-x="no">Close</button>
      <button data-x="refresh" class="primary">Re-read lockfiles</button>
    </div>`);

  const hpm = async (args: string[]) => { close(); await runHPM(args); };
  const name = root.querySelector('#p-name') as HTMLInputElement;

  root.querySelector('#p-install')!.addEventListener('click', () => {
    const v = name.value.trim();
    if (!v) { toast('Name a package to install', 'err'); return; }
    void hpm(['install', v]);
  });
  root.querySelector('#p-list')!.addEventListener('click', () => void hpm(['list']));
  root.querySelector('#p-update')!.addEventListener('click', () => void hpm(['update']));
  root.querySelector('#p-verify')!.addEventListener('click', () => void hpm(['verify']));

  root.querySelector('[data-x="no"]')!.addEventListener('click', close);
  root.querySelector('[data-x="refresh"]')!.addEventListener('click', async () => {
    close();
    try {
      const info = (await API.RefreshPackages()) as unknown as ProjectInfo;
      if (info?.open) state.project = info;
      await loadCatalog();
      await refreshSheet();
      renderAll();
      toast(`${Object.keys(info?.packages?.roots ?? {}).length} package roots`, 'ok');
    } catch (e) { showErr(e); }
  });
}

function toast(msg: string, kind: 'ok' | 'err' | '' = '', ms = 3200) {
  const host = document.getElementById('toasts')!;
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  host.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function showErr(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  toast(msg, 'err', 6000);
}

// ── utils ────────────────────────────────────────────────────────────────

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function shorten(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.length <= 3 ? p : '…/' + parts.slice(-2).join('/');
}

// ── boot ─────────────────────────────────────────────────────────────────

shell();

// The Go side may already have opened a file passed on the command line.
API.WorkspaceTree().then((w) => {
  state.workspace = w as unknown as Workspace;
  renderLeft();
}).catch(() => { /* no workspace */ });

API.Info().then(async (info) => {
  const pi = info as unknown as ProjectInfo;
  if (!pi?.open) { renderStatus(); showWelcome(); return; }
  state.project = pi;
  await loadCatalog();
  await gotoSheet(pickInitialSheet(pi));
  renderAll(true);
}).catch(() => { renderStatus(); showWelcome(); });

function showWelcome() {
  const c = document.getElementById('center')!;
  const overlay = document.createElement('div');
  overlay.className = 'canvas-empty';
  // The empty canvas is the app's one hero, so it gets the one drift: the
  // saucer never sits still. Reduced motion stops it.
  overlay.innerHTML = `
    <img class="hv-drift" src="${logoDisc}" alt="" width="132" height="132"/>
    <h2>No circuit open</h2>
    <p>Open a <code>.hvr</code> file to see its modules as blocks and its wires as
       connections. hoverdeck reads and writes the same source the compiler does —
       it visualises your code, it doesn't replace it.</p>
    <button class="primary" id="w-open">${ui('folder-open', 15)}Open a .hvr file</button>`;
  c.appendChild(overlay);
  document.getElementById('w-open')!.addEventListener('click', async () => {
    await openProject();
    if (state.project?.open) overlay.remove();
  });
}

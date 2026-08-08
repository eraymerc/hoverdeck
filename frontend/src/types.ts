/** Mirrors the JSON shapes emitted by internal/hvr and app.go. */

export interface Span {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}

export interface Arg {
  text: string;
  span: Span;
}

export interface Pin {
  index: number;
  name: string;
  net: string;
  span: Span;
  // True when `net` is a dotted reference to another element's branch
  // (CCCS/CCVS's "sense" port) rather than an actual net — no wire should
  // be drawn for it.
  ref: boolean;
}

export interface DefRef {
  name: string;
  file: string;
  span: Span;
  domain: string;
  doc: string;
  found: boolean;
}

export interface LogicPort {
  name: string;
  type: string;
  direction: string;
}

export interface StaticParam {
  name: string;
  type: string;
  default: string;
}

export interface Block {
  id: string;
  label: string;
  kind: 'instance' | 'primitive';
  typeName: string;
  bareType: string;
  domain: string;
  icon: string;
  ready: boolean;
  params: Arg[] | null;
  logic: Arg[] | null;
  pins: Pin[] | null;
  logicPorts: LogicPort[] | null;
  def: DefRef | null;
  stmt: Span;
  staticSpan: Span;
  logicSpan: Span;
  physSpan: Span;
  line: number;
  navigable: boolean;
  x: number;
  y: number;
  rot: number;
  flipX: boolean;
  flipY: boolean;
}

export interface NetPin {
  blockId: string;
  pinIndex: number;
  pinName: string;
}

export interface Net {
  name: string;
  isGround: boolean;
  declared: boolean;
  declLine: number;
  isBoundary: boolean;
  pins: NetPin[] | null;
  trunkX: number;
  trunkDY: number;
  hasTrunk: boolean;
  color?: string;
  // Per-leg vertical offset, keyed by "blockID:pinIndex" (see hvr.LegKey),
  // added on top of trunkDY so one connection can move independently of
  // the net's other legs. Nullable per the same nil-map-marshals-to-null
  // rule as the slice fields elsewhere in this file — normalizeSheet fills
  // in {} for the null case, same treatment as everything else here.
  legDY: Record<string, number> | null;
}

export interface Signal {
  name: string;
  type: string;
  isState: boolean;
  init: string;
  line: number;
  span: Span;
  x: number;
  y: number;
}

/**
 * Note on nullability: Go marshals a nil slice as `null`, not `[]`. The
 * backend now normalises these to empty collections, but they stay typed as
 * nullable here so any new consumer is forced to handle the null case rather
 * than trusting the shape.
 */
export interface Sheet {
  module: string;
  qualified: string;
  domain: string;
  file: string;
  span: Span;
  bodySpan: Span;
  blocks: Block[] | null;
  nets: Net[] | null;
  signals: Signal[] | null;
  physPorts: string[] | null;
  logicPorts: LogicPort[] | null;
  errors: string[] | null;
}

/**
 * SafeSheet is a Sheet whose collections are guaranteed present.
 *
 * Everything in the app works with this rather than the raw wire type, so a
 * `null` coming off the bridge can only be mishandled in exactly one place —
 * normalizeSheet — instead of at every use site.
 */
export type SafeBlock = Omit<Block, 'params' | 'logic' | 'pins' | 'logicPorts'> & {
  params: Arg[];
  logic: Arg[];
  pins: Pin[];
  logicPorts: LogicPort[];
};

export type SafeNet = Omit<Net, 'pins' | 'legDY'> & { pins: NetPin[]; legDY: Record<string, number> };

export type SafeSheet = Omit<Sheet,
  'blocks' | 'nets' | 'signals' | 'physPorts' | 'logicPorts' | 'errors'> & {
  blocks: SafeBlock[];
  nets: SafeNet[];
  signals: Signal[];
  physPorts: string[];
  logicPorts: LogicPort[];
  errors: string[];
};

/** Fills in every collection a nil Go slice may have left as null. */
export function normalizeSheet(s: Sheet): SafeSheet {
  return {
    ...s,
    blocks: (s.blocks ?? []).map((b) => ({
      ...b,
      params: b.params ?? [],
      logic: b.logic ?? [],
      pins: b.pins ?? [],
      logicPorts: b.logicPorts ?? [],
    })),
    nets: (s.nets ?? []).map((n) => ({ ...n, pins: n.pins ?? [], legDY: n.legDY ?? {} })),
    signals: s.signals ?? [],
    physPorts: s.physPorts ?? [],
    logicPorts: s.logicPorts ?? [],
    errors: s.errors ?? [],
  };
}

export interface ModuleDef {
  name: string;
  qualifiedAs: string;
  domain: string;
  file: string;
  span: Span;
  physPorts: string[] | null;
  staticParams: StaticParam[] | null;
  logicPorts: LogicPort[] | null;
  doc: string;
}

export interface FileInfo {
  path: string;
  name: string;
  isEntry: boolean;
  /** The installed package this file came from, "" for the user's own source. */
  package: string;
  lines: number;
  errors: number;
}

/** The import table a project resolves `import <...>` against. */
export interface Packages {
  roots: Record<string, string> | null;
  bundled: string;
  stdlibInstalled: boolean;
  note: string;
}

export interface SheetRef {
  qualified: string;
  name: string;
  domain: string;
  file: string;
  blocks: number;
  isMain: boolean;
}

export interface ProjectInfo {
  entry: string;
  root: string;
  packages: Packages | null;
  layoutPath: string;
  files: FileInfo[] | null;
  modules: ModuleDef[] | null;
  sheets: SheetRef[] | null;
  errors: string[] | null;
  open: boolean;
}

export interface SourceFile {
  path: string;
  name: string;
  text: string;
  errors: string[] | null;
  readOnly: boolean;
}

export interface PrimitiveDef {
  name: string;
  icon: string;
  ports: string[];
  param: string;
  unit: string;
  desc: string;
  driveable: boolean;
  ready: boolean;
}

export interface CatalogEntry {
  kind: string;
  name: string;
  icon: string;
  domain: string;
  desc: string;
  group: string;
  /** The directory to import, e.g. "semiconductors" or "stdlib/math". */
  importPath: string;
  /** The name that import binds, and the prefix an instantiation writes. */
  qualifier: string;
  suggestAlias: string;
  package: string;
  physPorts: string[] | null;
  staticParams: StaticParam[] | null;
  logicPorts: LogicPort[] | null;
  file: string;
  snippet: string;
}

export interface Catalog {
  primitives: PrimitiveDef[] | null;
  stdlib: CatalogEntry[] | null;
  local: CatalogEntry[] | null;
}

export interface InsertRequest {
  file: string;
  module: string;
  kind: string;
  typeName: string;
  alias: string;
  importPath: string;
  /** An existing binding to write the type behind, when no import is added. */
  qualifier: string;
  instance: string;
  static: string;
  logic: string;
  ports: string[];
}

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  isHVR: boolean;
  isCSV: boolean;
  isEntry: boolean;
  hasChildren: boolean;
  children: TreeNode[] | null;
}

export interface PlotInfo {
  path: string;
  name: string;
  open: boolean;
  columns: string[] | null;
  signals: string[] | null;
  xKey: string;
  rows: number;
  tMin: number;
  tMax: number;
  fs: number;
  computed: string[] | null;
}

export interface Trace {
  name: string;
  x: number[];
  y: number[];
  min: number;
  max: number;
  n: number;
}

export interface Spectrum {
  freqs: number[];
  mags: number[];
  fs: number;
  n: number;
  peak: number;
  peakF: number;
}

export interface Measurement {
  column: string;
  max: number;
  min: number;
  pkpk: number;
  avg: number;
  rms: number;
  tStart: number;
  tEnd: number;
  n: number;
}

export interface THDResult {
  column: string;
  thd: number;
  fundFreq: number;
  fundRMS: number;
  totalRMS: number;
  tStart: number;
  tEnd: number;
}

export interface Workspace {
  root: string;
  name: string;
  tree: TreeNode[] | null;
  open: boolean;
}

export interface SettingsView {
  hoverBin: string;
  workDir: string;
  configPath: string;
  binOK: boolean;
  runtimeOK: boolean;
  stdlibOK: boolean;
  needsSetup: boolean;
  effectiveBin: string;
  effectiveWork: string;
  detected: string;
  packages: number;
  note: string;
}

export interface RunStatus {
  exitCode: number;
  failed: boolean;
  message: string;
  csvPath: string;
  seconds: number;
}

export interface InsertResult {
  line: number;
  text: string;
  importAdded: boolean;
  instanceName: string;
  /** The prefix the inserted statement wrote, "" when the type was bare. */
  qualifier: string;
}

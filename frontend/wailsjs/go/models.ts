export namespace hvr {
	
	export class Span {
	    start: number;
	    end: number;
	    startLine: number;
	    endLine: number;
	
	    static createFrom(source: any = {}) {
	        return new Span(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.start = source["start"];
	        this.end = source["end"];
	        this.startLine = source["startLine"];
	        this.endLine = source["endLine"];
	    }
	}
	export class Arg {
	    text: string;
	    span: Span;
	
	    static createFrom(source: any = {}) {
	        return new Arg(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.text = source["text"];
	        this.span = this.convertValues(source["span"], Span);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class DefRef {
	    name: string;
	    file: string;
	    span: Span;
	    domain: string;
	    doc: string;
	    found: boolean;
	
	    static createFrom(source: any = {}) {
	        return new DefRef(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.file = source["file"];
	        this.span = this.convertValues(source["span"], Span);
	        this.domain = source["domain"];
	        this.doc = source["doc"];
	        this.found = source["found"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class LogicPort {
	    name: string;
	    type: string;
	    direction: string;
	
	    static createFrom(source: any = {}) {
	        return new LogicPort(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.type = source["type"];
	        this.direction = source["direction"];
	    }
	}
	export class Pin {
	    index: number;
	    name: string;
	    net: string;
	    span: Span;
	    ref: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Pin(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.index = source["index"];
	        this.name = source["name"];
	        this.net = source["net"];
	        this.span = this.convertValues(source["span"], Span);
	        this.ref = source["ref"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Block {
	    id: string;
	    label: string;
	    kind: string;
	    typeName: string;
	    bareType: string;
	    domain: string;
	    icon: string;
	    ready: boolean;
	    params: Arg[];
	    logic: Arg[];
	    pins: Pin[];
	    logicPorts: LogicPort[];
	    def?: DefRef;
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
	    symPins: number[];
	
	    static createFrom(source: any = {}) {
	        return new Block(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	        this.kind = source["kind"];
	        this.typeName = source["typeName"];
	        this.bareType = source["bareType"];
	        this.domain = source["domain"];
	        this.icon = source["icon"];
	        this.ready = source["ready"];
	        this.params = this.convertValues(source["params"], Arg);
	        this.logic = this.convertValues(source["logic"], Arg);
	        this.pins = this.convertValues(source["pins"], Pin);
	        this.logicPorts = this.convertValues(source["logicPorts"], LogicPort);
	        this.def = this.convertValues(source["def"], DefRef);
	        this.stmt = this.convertValues(source["stmt"], Span);
	        this.staticSpan = this.convertValues(source["staticSpan"], Span);
	        this.logicSpan = this.convertValues(source["logicSpan"], Span);
	        this.physSpan = this.convertValues(source["physSpan"], Span);
	        this.line = source["line"];
	        this.navigable = source["navigable"];
	        this.x = source["x"];
	        this.y = source["y"];
	        this.rot = source["rot"];
	        this.flipX = source["flipX"];
	        this.flipY = source["flipY"];
	        this.symPins = source["symPins"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class StaticParam {
	    name: string;
	    type: string;
	    default: string;
	
	    static createFrom(source: any = {}) {
	        return new StaticParam(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.type = source["type"];
	        this.default = source["default"];
	    }
	}
	export class CatalogEntry {
	    kind: string;
	    name: string;
	    icon: string;
	    domain: string;
	    desc: string;
	    group: string;
	    importPath: string;
	    qualifier: string;
	    suggestAlias: string;
	    package: string;
	    physPorts: string[];
	    staticParams: StaticParam[];
	    logicPorts: LogicPort[];
	    file: string;
	    snippet: string;
	
	    static createFrom(source: any = {}) {
	        return new CatalogEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.name = source["name"];
	        this.icon = source["icon"];
	        this.domain = source["domain"];
	        this.desc = source["desc"];
	        this.group = source["group"];
	        this.importPath = source["importPath"];
	        this.qualifier = source["qualifier"];
	        this.suggestAlias = source["suggestAlias"];
	        this.package = source["package"];
	        this.physPorts = source["physPorts"];
	        this.staticParams = this.convertValues(source["staticParams"], StaticParam);
	        this.logicPorts = this.convertValues(source["logicPorts"], LogicPort);
	        this.file = source["file"];
	        this.snippet = source["snippet"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class InsertRequest {
	    file: string;
	    module: string;
	    kind: string;
	    typeName: string;
	    alias: string;
	    importPath: string;
	    qualifier: string;
	    instance: string;
	    static: string;
	    logic: string;
	    ports: string[];
	
	    static createFrom(source: any = {}) {
	        return new InsertRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.file = source["file"];
	        this.module = source["module"];
	        this.kind = source["kind"];
	        this.typeName = source["typeName"];
	        this.alias = source["alias"];
	        this.importPath = source["importPath"];
	        this.qualifier = source["qualifier"];
	        this.instance = source["instance"];
	        this.static = source["static"];
	        this.logic = source["logic"];
	        this.ports = source["ports"];
	    }
	}
	export class InsertResult {
	    line: number;
	    text: string;
	    importAdded: boolean;
	    instanceName: string;
	    qualifier: string;
	
	    static createFrom(source: any = {}) {
	        return new InsertResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.line = source["line"];
	        this.text = source["text"];
	        this.importAdded = source["importAdded"];
	        this.instanceName = source["instanceName"];
	        this.qualifier = source["qualifier"];
	    }
	}
	
	export class ModuleDef {
	    name: string;
	    qualifiedAs: string;
	    domain: string;
	    file: string;
	    span: Span;
	    physPorts: string[];
	    staticParams: StaticParam[];
	    logicPorts: LogicPort[];
	    doc: string;
	
	    static createFrom(source: any = {}) {
	        return new ModuleDef(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.qualifiedAs = source["qualifiedAs"];
	        this.domain = source["domain"];
	        this.file = source["file"];
	        this.span = this.convertValues(source["span"], Span);
	        this.physPorts = source["physPorts"];
	        this.staticParams = this.convertValues(source["staticParams"], StaticParam);
	        this.logicPorts = this.convertValues(source["logicPorts"], LogicPort);
	        this.doc = source["doc"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class NetPin {
	    blockId: string;
	    pinIndex: number;
	    pinName: string;
	
	    static createFrom(source: any = {}) {
	        return new NetPin(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.blockId = source["blockId"];
	        this.pinIndex = source["pinIndex"];
	        this.pinName = source["pinName"];
	    }
	}
	export class Net {
	    name: string;
	    isGround: boolean;
	    declared: boolean;
	    declLine: number;
	    isBoundary: boolean;
	    pins: NetPin[];
	    color?: string;
	    wires: number[][];
	
	    static createFrom(source: any = {}) {
	        return new Net(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.isGround = source["isGround"];
	        this.declared = source["declared"];
	        this.declLine = source["declLine"];
	        this.isBoundary = source["isBoundary"];
	        this.pins = this.convertValues(source["pins"], NetPin);
	        this.color = source["color"];
	        this.wires = source["wires"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class Packages {
	    roots: Record<string, string>;
	    bundled: string;
	    stdlibInstalled: boolean;
	    note: string;
	
	    static createFrom(source: any = {}) {
	        return new Packages(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.roots = source["roots"];
	        this.bundled = source["bundled"];
	        this.stdlibInstalled = source["stdlibInstalled"];
	        this.note = source["note"];
	    }
	}
	
	export class PrimitiveDef {
	    name: string;
	    icon: string;
	    ports: string[];
	    param: string;
	    unit: string;
	    desc: string;
	    driveable: boolean;
	    ready: boolean;
	
	    static createFrom(source: any = {}) {
	        return new PrimitiveDef(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.icon = source["icon"];
	        this.ports = source["ports"];
	        this.param = source["param"];
	        this.unit = source["unit"];
	        this.desc = source["desc"];
	        this.driveable = source["driveable"];
	        this.ready = source["ready"];
	    }
	}
	export class Signal {
	    name: string;
	    type: string;
	    isState: boolean;
	    init: string;
	    line: number;
	    span: Span;
	    x: number;
	    y: number;
	    wires: number[][];
	
	    static createFrom(source: any = {}) {
	        return new Signal(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.type = source["type"];
	        this.isState = source["isState"];
	        this.init = source["init"];
	        this.line = source["line"];
	        this.span = this.convertValues(source["span"], Span);
	        this.x = source["x"];
	        this.y = source["y"];
	        this.wires = source["wires"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Sheet {
	    module: string;
	    qualified: string;
	    domain: string;
	    file: string;
	    span: Span;
	    bodySpan: Span;
	    blocks: Block[];
	    nets: Net[];
	    signals: Signal[];
	    physPorts: string[];
	    logicPorts: LogicPort[];
	    errors: string[];
	
	    static createFrom(source: any = {}) {
	        return new Sheet(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.module = source["module"];
	        this.qualified = source["qualified"];
	        this.domain = source["domain"];
	        this.file = source["file"];
	        this.span = this.convertValues(source["span"], Span);
	        this.bodySpan = this.convertValues(source["bodySpan"], Span);
	        this.blocks = this.convertValues(source["blocks"], Block);
	        this.nets = this.convertValues(source["nets"], Net);
	        this.signals = this.convertValues(source["signals"], Signal);
	        this.physPorts = source["physPorts"];
	        this.logicPorts = this.convertValues(source["logicPorts"], LogicPort);
	        this.errors = source["errors"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	
	export class SymbolLogic {
	    name: string;
	    aliases: string[];
	    flow: string;
	    x: number;
	    y: number;
	    dir: string;
	
	    static createFrom(source: any = {}) {
	        return new SymbolLogic(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.aliases = source["aliases"];
	        this.flow = source["flow"];
	        this.x = source["x"];
	        this.y = source["y"];
	        this.dir = source["dir"];
	    }
	}
	export class SymbolPin {
	    name: string;
	    aliases: string[];
	    x: number;
	    y: number;
	    dir: string;
	    optional: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SymbolPin(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.aliases = source["aliases"];
	        this.x = source["x"];
	        this.y = source["y"];
	        this.dir = source["dir"];
	        this.optional = source["optional"];
	    }
	}
	export class SymbolPart {
	    markup: string;
	    ifPin?: string;
	
	    static createFrom(source: any = {}) {
	        return new SymbolPart(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.markup = source["markup"];
	        this.ifPin = source["ifPin"];
	    }
	}
	export class Symbol {
	    id: string;
	    title: string;
	    viewBox: number[];
	    parts: SymbolPart[];
	    pins: SymbolPin[];
	    logic: SymbolLogic[];
	
	    static createFrom(source: any = {}) {
	        return new Symbol(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.viewBox = source["viewBox"];
	        this.parts = this.convertValues(source["parts"], SymbolPart);
	        this.pins = this.convertValues(source["pins"], SymbolPin);
	        this.logic = this.convertValues(source["logic"], SymbolLogic);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	

}

export namespace main {
	
	export class Catalog {
	    primitives: hvr.PrimitiveDef[];
	    stdlib: hvr.CatalogEntry[];
	    local: hvr.CatalogEntry[];
	    symbols: hvr.Symbol[];
	
	    static createFrom(source: any = {}) {
	        return new Catalog(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.primitives = this.convertValues(source["primitives"], hvr.PrimitiveDef);
	        this.stdlib = this.convertValues(source["stdlib"], hvr.CatalogEntry);
	        this.local = this.convertValues(source["local"], hvr.CatalogEntry);
	        this.symbols = this.convertValues(source["symbols"], hvr.Symbol);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class FileInfo {
	    path: string;
	    name: string;
	    isEntry: boolean;
	    package: string;
	    lines: number;
	    errors: number;
	
	    static createFrom(source: any = {}) {
	        return new FileInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.name = source["name"];
	        this.isEntry = source["isEntry"];
	        this.package = source["package"];
	        this.lines = source["lines"];
	        this.errors = source["errors"];
	    }
	}
	export class PlotInfo {
	    path: string;
	    name: string;
	    open: boolean;
	    columns: string[];
	    signals: string[];
	    xKey: string;
	    rows: number;
	    tMin: number;
	    tMax: number;
	    fs: number;
	    computed: string[];
	
	    static createFrom(source: any = {}) {
	        return new PlotInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.name = source["name"];
	        this.open = source["open"];
	        this.columns = source["columns"];
	        this.signals = source["signals"];
	        this.xKey = source["xKey"];
	        this.rows = source["rows"];
	        this.tMin = source["tMin"];
	        this.tMax = source["tMax"];
	        this.fs = source["fs"];
	        this.computed = source["computed"];
	    }
	}
	export class SheetRef {
	    qualified: string;
	    name: string;
	    domain: string;
	    file: string;
	    blocks: number;
	    isMain: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SheetRef(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.qualified = source["qualified"];
	        this.name = source["name"];
	        this.domain = source["domain"];
	        this.file = source["file"];
	        this.blocks = source["blocks"];
	        this.isMain = source["isMain"];
	    }
	}
	export class ProjectInfo {
	    entry: string;
	    root: string;
	    packages?: hvr.Packages;
	    layoutPath: string;
	    files: FileInfo[];
	    modules: hvr.ModuleDef[];
	    sheets: SheetRef[];
	    errors: string[];
	    open: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ProjectInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.entry = source["entry"];
	        this.root = source["root"];
	        this.packages = this.convertValues(source["packages"], hvr.Packages);
	        this.layoutPath = source["layoutPath"];
	        this.files = this.convertValues(source["files"], FileInfo);
	        this.modules = this.convertValues(source["modules"], hvr.ModuleDef);
	        this.sheets = this.convertValues(source["sheets"], SheetRef);
	        this.errors = source["errors"];
	        this.open = source["open"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SettingsView {
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
	
	    static createFrom(source: any = {}) {
	        return new SettingsView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.hoverBin = source["hoverBin"];
	        this.workDir = source["workDir"];
	        this.configPath = source["configPath"];
	        this.binOK = source["binOK"];
	        this.runtimeOK = source["runtimeOK"];
	        this.stdlibOK = source["stdlibOK"];
	        this.needsSetup = source["needsSetup"];
	        this.effectiveBin = source["effectiveBin"];
	        this.effectiveWork = source["effectiveWork"];
	        this.detected = source["detected"];
	        this.packages = source["packages"];
	        this.note = source["note"];
	    }
	}
	
	export class SourceFile {
	    path: string;
	    name: string;
	    text: string;
	    errors: string[];
	    readOnly: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SourceFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.name = source["name"];
	        this.text = source["text"];
	        this.errors = source["errors"];
	        this.readOnly = source["readOnly"];
	    }
	}
	export class TreeNode {
	    name: string;
	    path: string;
	    isDir: boolean;
	    isHVR: boolean;
	    isCSV: boolean;
	    isEntry: boolean;
	    hasChildren: boolean;
	    children: TreeNode[];
	
	    static createFrom(source: any = {}) {
	        return new TreeNode(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.isDir = source["isDir"];
	        this.isHVR = source["isHVR"];
	        this.isCSV = source["isCSV"];
	        this.isEntry = source["isEntry"];
	        this.hasChildren = source["hasChildren"];
	        this.children = this.convertValues(source["children"], TreeNode);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Workspace {
	    root: string;
	    name: string;
	    tree: TreeNode[];
	    open: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Workspace(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.root = source["root"];
	        this.name = source["name"];
	        this.tree = this.convertValues(source["tree"], TreeNode);
	        this.open = source["open"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace plot {
	
	export class FFTOptions {
	    column: string;
	    tStart: number;
	    tEnd: number;
	    fMin: number;
	    fMax: number;
	    window: string;
	    points: number;
	    removeDC: boolean;
	
	    static createFrom(source: any = {}) {
	        return new FFTOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.column = source["column"];
	        this.tStart = source["tStart"];
	        this.tEnd = source["tEnd"];
	        this.fMin = source["fMin"];
	        this.fMax = source["fMax"];
	        this.window = source["window"];
	        this.points = source["points"];
	        this.removeDC = source["removeDC"];
	    }
	}
	export class FilterOptions {
	    column: string;
	    type: string;
	    points: number;
	    fc1: number;
	    fc2: number;
	    taps: number;
	
	    static createFrom(source: any = {}) {
	        return new FilterOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.column = source["column"];
	        this.type = source["type"];
	        this.points = source["points"];
	        this.fc1 = source["fc1"];
	        this.fc2 = source["fc2"];
	        this.taps = source["taps"];
	    }
	}
	export class Measurement {
	    column: string;
	    max: number;
	    min: number;
	    pkpk: number;
	    avg: number;
	    rms: number;
	    tStart: number;
	    tEnd: number;
	    n: number;
	
	    static createFrom(source: any = {}) {
	        return new Measurement(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.column = source["column"];
	        this.max = source["max"];
	        this.min = source["min"];
	        this.pkpk = source["pkpk"];
	        this.avg = source["avg"];
	        this.rms = source["rms"];
	        this.tStart = source["tStart"];
	        this.tEnd = source["tEnd"];
	        this.n = source["n"];
	    }
	}
	export class Spectrum {
	    freqs: number[];
	    mags: number[];
	    fs: number;
	    n: number;
	    peak: number;
	    peakF: number;
	
	    static createFrom(source: any = {}) {
	        return new Spectrum(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.freqs = source["freqs"];
	        this.mags = source["mags"];
	        this.fs = source["fs"];
	        this.n = source["n"];
	        this.peak = source["peak"];
	        this.peakF = source["peakF"];
	    }
	}
	export class THDResult {
	    column: string;
	    thd: number;
	    fundFreq: number;
	    fundRMS: number;
	    totalRMS: number;
	    tStart: number;
	    tEnd: number;
	
	    static createFrom(source: any = {}) {
	        return new THDResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.column = source["column"];
	        this.thd = source["thd"];
	        this.fundFreq = source["fundFreq"];
	        this.fundRMS = source["fundRMS"];
	        this.totalRMS = source["totalRMS"];
	        this.tStart = source["tStart"];
	        this.tEnd = source["tEnd"];
	    }
	}
	export class Trace {
	    name: string;
	    x: number[];
	    y: number[];
	    min: number;
	    max: number;
	    n: number;
	
	    static createFrom(source: any = {}) {
	        return new Trace(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.x = source["x"];
	        this.y = source["y"];
	        this.min = source["min"];
	        this.max = source["max"];
	        this.n = source["n"];
	    }
	}

}


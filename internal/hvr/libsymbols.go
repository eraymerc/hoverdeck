package hvr

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// ─────────────────────────────────────────────────────────────────────────────
// LIBRARY SYMBOLS
//
// A library ships the schematic symbols of its own modules. Every directory of
// .hvr files may carry a `symbols/` folder beside them:
//
//	semiconductors/bjt/npn.hvr                 declares NPN, PNP
//	semiconductors/bjt/symbols/npn.svg         NPN's symbol (by name)
//	semiconductors/bjt/symbols/pnp.svg         PNP's symbol
//	parts/bjt/npn/2N2222.hvr                   declares Q2N2222
//	parts/bjt/npn/symbols/default.svg          every part card in the folder
//
// A module wears `<its directory>/symbols/<its name, lower-cased>.svg`, or,
// failing that, `<its directory>/symbols/default.svg` — which is how a folder
// of part cards, named after real devices, all get their family's symbol.
// Anything else falls back to IconFor's built-in shapes.
//
// The file format is the built-in symbols' (internal/hvr/symbols/README.md).
// A library symbol's id is the directory's import path plus the file name —
// "semiconductors/bjt/npn", "parts/bjt/npn/default" — so ids from different
// packages cannot collide, and a sidecar icon override written on one machine
// means the same symbol on another. Symbols beside the project's own sources
// (not in any package) are "./<path from the project root>/<name>".
//
// Primitives and the generic domain shapes stay built into hoverdeck: they
// belong to the language, not to a library.
// ─────────────────────────────────────────────────────────────────────────────

// symbolDirName is the folder, beside a directory's .hvr files, that holds its
// symbols.
const symbolDirName = "symbols"

// libIndex is the per-directory part of a SymbolLib: for each directory of
// .hvr files (absolute, cleaned), the symbols its symbols/ folder provides,
// by file name.
type libIndex struct {
	mu    sync.Mutex
	byDir map[string]map[string]string // dir -> name -> symbol id
	pkgs  *Packages
	root  string // project root, for ids of symbols outside any package
}

// NewSymbolLib returns the built-in symbols plus every symbol shipped by the
// packages in pkgs. Symbols beside the project's own sources (under root) are
// loaded when a module there first asks for one.
func NewSymbolLib(pkgs *Packages, root string) *SymbolLib {
	base := BuiltinSymbols()
	lib := &SymbolLib{byID: make(map[string]*Symbol, len(base.byID)), Errors: append([]string(nil), base.Errors...)}
	for id, s := range base.byID {
		lib.byID[id] = s
	}
	lib.index = &libIndex{byDir: map[string]map[string]string{}, pkgs: pkgs, root: root}

	if pkgs != nil {
		seen := map[string]bool{}
		for _, pkgRoot := range pkgs.Roots {
			_ = filepath.WalkDir(pkgRoot, func(path string, d os.DirEntry, err error) error {
				if err != nil || !d.IsDir() {
					return nil
				}
				if strings.HasPrefix(d.Name(), ".") {
					return filepath.SkipDir
				}
				if d.Name() == symbolDirName {
					// The symbols themselves are loaded for their parent directory.
					return filepath.SkipDir
				}
				dir := filepath.Clean(path)
				if !seen[dir] {
					seen[dir] = true
					lib.loadDir(dir)
				}
				return nil
			})
		}
	}
	return lib
}

// For picks the symbol for a module: bare is its unqualified name, domain its
// declared domain, file the path of the file that declares it ("" when the
// definition was not found). Safe on a nil lib, which knows only IconFor.
func (l *SymbolLib) For(bare, domain, file string) string {
	if l != nil && l.index != nil && file != "" {
		syms := l.dirSymbols(filepath.Clean(filepath.Dir(file)))
		if id, ok := syms[strings.ToLower(bare)]; ok {
			return id
		}
		if id, ok := syms["default"]; ok {
			return id
		}
	}
	return IconFor(bare, domain)
}

// dirSymbols returns a directory's symbols by name, loading its symbols/
// folder the first time — package directories are loaded up front, so this
// only ever reads the project's own folders.
func (l *SymbolLib) dirSymbols(dir string) map[string]string {
	l.index.mu.Lock()
	syms, ok := l.index.byDir[dir]
	l.index.mu.Unlock()
	if ok {
		return syms
	}
	return l.loadDir(dir)
}

// loadDir reads dir/symbols/*.svg into the library and indexes them for dir.
// A directory without a symbols/ folder is indexed as empty.
func (l *SymbolLib) loadDir(dir string) map[string]string {
	idx := l.index
	syms := map[string]string{}
	entries, err := os.ReadDir(filepath.Join(dir, symbolDirName))
	if err == nil {
		prefix := idx.idPrefix(dir)
		for _, e := range entries {
			if e.IsDir() || filepath.Ext(e.Name()) != ".svg" {
				continue
			}
			name := strings.TrimSuffix(e.Name(), ".svg")
			file := filepath.Join(dir, symbolDirName, e.Name())
			src, readErr := os.ReadFile(file)
			if readErr != nil {
				l.addError(readErr.Error())
				continue
			}
			sym, parseErr := ParseSymbol(name, src)
			if parseErr != nil {
				l.addError(file + ": " + parseErr.Error())
				continue
			}
			sym.ID = prefix + "/" + name
			idx.mu.Lock()
			l.byID[sym.ID] = sym
			idx.mu.Unlock()
			syms[name] = sym.ID
		}
	}
	idx.mu.Lock()
	idx.byDir[dir] = syms
	idx.mu.Unlock()
	return syms
}

func (l *SymbolLib) addError(msg string) {
	l.index.mu.Lock()
	l.Errors = append(l.Errors, msg)
	l.index.mu.Unlock()
}

// idPrefix names a directory in symbol ids: its import path inside a package
// ("semiconductors/bjt"), "./<relative path>" inside the project, or the
// absolute path as a last resort.
func (idx *libIndex) idPrefix(dir string) string {
	if idx.pkgs != nil {
		if pkg := idx.pkgs.PackageOf(dir); pkg != "" {
			importPath := pkg
			if rel, err := filepath.Rel(idx.pkgs.Roots[pkg], dir); err == nil && rel != "." {
				importPath = pkg + "/" + filepath.ToSlash(rel)
			}
			return importPath
		}
	}
	if idx.root != "" {
		if rel, err := filepath.Rel(idx.root, dir); err == nil && !strings.HasPrefix(rel, "..") {
			if rel == "." {
				return "."
			}
			return "./" + filepath.ToSlash(rel)
		}
	}
	return filepath.ToSlash(dir)
}

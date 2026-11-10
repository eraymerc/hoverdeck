package hvr

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"hover/compiler/ast"
	"hover/compiler/lexer"
	"hover/compiler/loader"
	"hover/compiler/parser"
	"hover/compiler/token"
	"hover/hpm"
)

// Domain names as exposed to the UI.
const (
	DomainStructural = "structural"
	DomainAnalog     = "analog"
	DomainDigital    = "digital"
)

func domainOf(t token.Type) string {
	switch t {
	case token.ANALOG:
		return DomainAnalog
	case token.DIGITAL:
		return DomainDigital
	default:
		return DomainStructural
	}
}

// File is one parsed .hvr source.
type File struct {
	Path    string
	Src     *Source
	Program *ast.Program
	Errors  []string
	Imports []ResolvedImport
}

// SelectedName is one entry in a `from <dir> import a, b as c;` list.
type SelectedName struct {
	Name  string `json:"name"`
	Alias string `json:"alias"`
}

// Local is the name this symbol is reachable as in the importing file.
func (s SelectedName) Local() string {
	if s.Alias != "" {
		return s.Alias
	}
	return s.Name
}

// ResolvedImport is one `import` statement with its target resolved.
//
// Since 0.8 the target is a DIRECTORY, not a file: every .hvr directly inside
// it is imported together and shares one namespace. Dir is that directory and
// Files are its contents.
type ResolvedImport struct {
	// Qualifier is the name this import binds. A whole-directory import is
	// always qualified — its names are reachable only as Qualifier.Name — and
	// the default is the last path segment, so `import <semiconductors/bjt>`
	// binds `bjt`. Empty for a selective import, which binds nothing.
	Qualifier string
	Alias     string // the explicit `as` name, "" when the default was used
	Raw       string
	IsSystem  bool
	Dir       string
	Files     []string
	Package   string // the package it resolved through, "" for a relative import
	Line      int
	Resolved  bool

	Selective bool
	Selected  []SelectedName
}

// StaticParam is one `<...>` declaration parameter of a module.
type StaticParam struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	Default string `json:"default"`
}

// LogicPort is one `(...)` declaration port of a module.
type LogicPort struct {
	Name      string `json:"name"`
	Type      string `json:"type"`
	Direction string `json:"direction"`
}

// ModuleDef is a module declaration, wherever it was found.
type ModuleDef struct {
	Name         string        `json:"name"`
	QualifiedAs  string        `json:"qualifiedAs"`
	Domain       string        `json:"domain"`
	File         string        `json:"file"`
	Span         Span          `json:"span"`
	PhysPorts    []string      `json:"physPorts"`
	StaticParams []StaticParam `json:"staticParams"`
	LogicPorts   []LogicPort   `json:"logicPorts"`
	Doc          string        `json:"doc"`

	decl *ast.ModuleDeclStatement
}

// Project is an entry .hvr plus every file reachable from its imports.
//
// "Reachable" is wider than it was: an import names a directory, so it pulls
// in every .hvr inside it rather than one file. It is NOT wider at the entry,
// though — the entry file's own siblings are not loaded and are not visible to
// it unless something imports them. That asymmetry is the compiler's, verified
// against it: `Widget` declared in a sibling of main.hvr elaborates as
// "undeclared module 'Widget' — modules visible: main". Reproducing it exactly
// is the whole job here; being more generous would show a block on the canvas
// that the compiler then refuses to build.
type Project struct {
	Entry string
	Root  string

	// Packages is the import table this project resolved against.
	Packages *Packages

	// Symbols is the schematic symbol set for this project: built-ins plus
	// what its packages and its own folders ship (libsymbols.go). The app sets
	// it; nil draws library modules with the generic shapes only.
	Symbols *SymbolLib

	Files map[string]*File
	Order []string

	// dirModules is the per-directory namespace the elaborator builds: every
	// module declared by any LOADED file in a directory, merged, keyed by
	// name. Only loaded files count, exactly as in the compiler — which is why
	// the entry's directory usually contains nothing but the entry itself.
	dirModules map[string]map[string]*ModuleDef

	// modules is what the ENTRY FILE can see, keyed by the name an
	// instantiation would write: its own directory's declarations bare,
	// selectively imported names bare, and whole-directory imports as
	// "Qualifier.Name" — never bare, since 0.8 qualifies them all.
	modules map[string]*ModuleDef

	LoadErrors []string
}

// LoadProject parses entryPath and every directory its imports reach.
//
// pkgs resolves `import <...>`. The compiler builds that table from lockfiles
// and falls back to a stdlib beside its own executable; hoverdeck is a
// different executable, so the table is supplied explicitly rather than
// letting the fallback point at hoverdeck's own directory.
func LoadProject(entryPath string, pkgs *Packages) (*Project, error) {
	abs, err := filepath.Abs(entryPath)
	if err != nil {
		return nil, fmt.Errorf("resolve entry path: %w", err)
	}
	abs = filepath.Clean(abs)

	if pkgs == nil {
		pkgs = &Packages{Roots: map[string]string{}}
	}
	pkgs.install()

	p := &Project{
		Entry:      abs,
		Root:       filepath.Dir(abs),
		Packages:   pkgs,
		Files:      map[string]*File{},
		dirModules: map[string]map[string]*ModuleDef{},
		modules:    map[string]*ModuleDef{},
	}

	// The entry file is read first and on its own, so a missing or unreadable
	// entry is a hard error rather than one line in a list of warnings.
	if err := p.loadOne(abs); err != nil {
		return nil, err
	}

	visiting := map[string]bool{}
	p.followImports(abs, visiting)
	p.groupByDirectory()
	p.buildNamespace()
	return p, nil
}

// loadOne reads and parses a single file.
func (p *Project) loadOne(path string) error {
	if _, done := p.Files[path]; done {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	p.Files[path] = ParseSource(path, string(raw))
	p.Order = append(p.Order, path)
	return nil
}

// followImports resolves one file's imports and loads every .hvr in each
// directory they name, recursing into those files' own imports.
//
// Unlike the compiler's loader this never gives up on the first bad import:
// hoverdeck is an editor, and a file being edited is unresolvable most of the
// time. Each failure becomes a LoadError and the rest of the tree still loads.
func (p *Project) followImports(path string, visiting map[string]bool) {
	if visiting[path] {
		return // cycle — the compiler reports it; here we just stop descending
	}
	visiting[path] = true
	defer delete(visiting, path)

	f := p.Files[path]
	if f == nil {
		return
	}
	for i := range f.Imports {
		imp := &f.Imports[i]
		p.resolveImport(path, imp)
		if !imp.Resolved {
			continue
		}
		// An import names a directory, so all of its files come in together
		// and share one namespace.
		for _, target := range imp.Files {
			if err := p.loadOne(target); err != nil {
				p.LoadErrors = append(p.LoadErrors, err.Error())
				continue
			}
			p.followImports(target, visiting)
		}
	}
}

// groupByDirectory folds the loaded files into per-directory namespaces, which
// is what a directory is since 0.8.
func (p *Project) groupByDirectory() {
	byDir := map[string][]string{}
	for _, path := range p.Order {
		dir := filepath.Dir(path)
		byDir[dir] = append(byDir[dir], path)
	}
	for dir, files := range byDir {
		p.dirModules[dir] = p.mergeDir(dir, files)
	}
}

// resolveImport turns one import statement into the directory it names, using
// exactly the compiler's resolution rules so the two can never disagree.
func (p *Project) resolveImport(from string, imp *ResolvedImport) {
	fail := func(format string, args ...any) {
		imp.Resolved = false
		p.LoadErrors = append(p.LoadErrors,
			fmt.Sprintf("%s:%d: %s", filepath.Base(from), imp.Line, fmt.Sprintf(format, args...)))
	}

	// The 0.7 file-based spelling gets its own message rather than a confusing
	// "not a directory", because naming the replacement makes the fix
	// mechanical — this is the single most likely error in a file written
	// against the previous release.
	if strings.HasSuffix(imp.Raw, ".hvr") {
		fail("an import names a directory, not a file — write %s instead of %s "+
			"(every .hvr file in that directory is imported together)",
			bracket(dirOfImport(imp.Raw), imp.IsSystem), bracket(imp.Raw, imp.IsSystem))
		return
	}

	fromDir := filepath.Dir(from)
	dir := loader.ResolveImportPath(fromDir, imp.Raw, imp.IsSystem)
	imp.Dir = dir
	imp.Package = loader.PackageOf(imp.Raw, imp.IsSystem)
	imp.Qualifier = loader.QualifierFor(imp.Raw, imp.Alias)

	if sameDir(dir, fromDir) {
		fail("%q is this file's own directory — files in the same directory "+
			"already share a namespace, so remove the import", imp.Raw)
		return
	}

	files, err := loader.HvrFilesIn(dir)
	if err != nil {
		if hint := missingPackageHint(p.Packages, imp.Raw, imp.IsSystem); hint != "" {
			fail("%s", hint)
			return
		}
		fail("could not read imported directory %q (looked in %s)", imp.Raw, dir)
		return
	}
	if len(files) == 0 {
		fail("%q contains no .hvr files (%s)", imp.Raw, dir)
		return
	}

	imp.Files = files
	imp.Resolved = true
}

// missingPackageHint mirrors the compiler's diagnostic for an import whose
// package is not installed. It is reproduced here rather than called because
// the compiler's version consults a stdlib beside the running executable,
// which for hoverdeck is the wrong directory.
func missingPackageHint(pkgs *Packages, importPath string, isSystem bool) string {
	if !isSystem {
		return ""
	}
	name := importPath
	if i := strings.IndexByte(strings.Trim(name, "/"), '/'); i >= 0 {
		name = strings.Trim(name, "/")[:i]
	}
	if name == "" {
		return ""
	}
	if _, installed := pkgs.Roots[name]; installed {
		return "" // installed, so the missing thing is a directory inside it
	}
	for _, std := range hpm.StdlibImportNames() {
		if name == std {
			return fmt.Sprintf("the standard library is not installed, so %q cannot be found — "+
				"run `hover --setup` (it downloads the standard library; this needs network access)", name)
		}
	}
	return fmt.Sprintf("package %q is not installed — run `hover hpm install %s` "+
		"(or check the path, if you meant a standard library directory)", name, name)
}

// dirOfImport strips the final segment of an import path, turning the 0.7
// file spelling into the directory that replaces it. Import paths are always
// slash-separated, whatever the platform.
func dirOfImport(importPath string) string {
	if i := strings.LastIndexByte(importPath, '/'); i >= 0 {
		return importPath[:i]
	}
	return "."
}

func bracket(path string, isSystem bool) string {
	if isSystem {
		return "<" + path + ">"
	}
	return `"` + path + `"`
}

func sameDir(a, b string) bool {
	ra, err1 := filepath.EvalSymlinks(a)
	rb, err2 := filepath.EvalSymlinks(b)
	if err1 == nil && err2 == nil {
		return filepath.Clean(ra) == filepath.Clean(rb)
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

// ParseSource lexes and parses one file's text into a File.
func ParseSource(path, text string) *File {
	f := &File{Path: path, Src: NewSource(path, text)}

	l := lexer.New(text)
	var toks []token.Token
	for {
		t := l.NextToken()
		toks = append(toks, t)
		if t.Type == token.EOF {
			break
		}
	}

	prog, errs := parser.Parse(toks)
	f.Program = prog
	f.Errors = errs

	if prog != nil {
		for _, st := range prog.Statements {
			if imp, ok := st.(*ast.ImportStatement); ok {
				ri := ResolvedImport{
					Alias:     imp.Alias,
					Raw:       imp.Path,
					IsSystem:  imp.IsSystem,
					Line:      imp.Token.Line,
					Selective: imp.Selective,
				}
				for _, n := range imp.Names {
					ri.Selected = append(ri.Selected, SelectedName{Name: n.Name, Alias: n.Alias})
				}
				f.Imports = append(f.Imports, ri)
			}
		}
	}
	return f
}

// mergeDir folds every module declared by the files in one directory into a
// single namespace, which is what a directory is since 0.8. A name declared
// twice in one directory used to be legal in two different files and is now
// an error — they share a namespace, so nothing could say which one a
// reference meant.
func (p *Project) mergeDir(dir string, files []string) map[string]*ModuleDef {
	out := map[string]*ModuleDef{}
	for _, path := range files {
		f := p.Files[path]
		if f == nil {
			continue
		}
		for _, def := range p.modulesIn(f) {
			if prev, dup := out[def.Name]; dup {
				p.LoadErrors = append(p.LoadErrors, fmt.Sprintf(
					"module '%s' is declared twice in %s — %s and %s. Files in one "+
						"directory share a namespace, so the two names have to differ",
					def.Name, dir, filepath.Base(prev.File), filepath.Base(def.File)))
				continue
			}
			out[def.Name] = def
		}
	}
	return out
}

// buildNamespace reproduces the elaborator's name resolution for the entry
// file, as 0.8 defines it:
//
//   - its own DIRECTORY's declarations, bare — siblings share a namespace,
//     so no import is involved;
//   - `from <d> import X as Y;` — only the listed names, bare, under their
//     local spelling;
//   - `import <d>;` / `import <d> as N;` — everything behind the qualifier
//     and NOTHING bare. This is the change that matters most from 0.7, where
//     an unaliased import merged flat: `Diode` alone no longer resolves,
//     `semiconductors.Diode` does.
//
// Imports stay non-transitive, so only the entry file's own list is consulted.
func (p *Project) buildNamespace() {
	entry := p.Files[p.Entry]
	if entry == nil {
		return
	}

	for name, def := range p.dirModules[filepath.Dir(p.Entry)] {
		p.modules[name] = def
	}

	for _, imp := range entry.Imports {
		if !imp.Resolved {
			continue
		}
		imported := p.dirModules[filepath.Clean(imp.Dir)]
		if imported == nil {
			continue
		}

		if imp.Selective {
			for _, sym := range imp.Selected {
				def, found := imported[sym.Name]
				if !found {
					continue // may be a function; the compiler decides
				}
				local := sym.Local()
				if _, clash := p.modules[local]; clash {
					continue // the compiler reports the collision
				}
				def.QualifiedAs = local
				p.modules[local] = def
			}
			continue
		}

		for _, def := range imported {
			q := imp.Qualifier + "." + def.Name
			if _, own := p.modules[def.Name]; !own {
				// Only rename a definition the entry's own directory has no
				// claim on, so a module keeps the bare name it is declared
				// under when it is also visible unqualified somewhere.
				def.QualifiedAs = q
			}
			p.modules[q] = def
		}
	}
}

// modulesIn extracts every module declaration in one file, recovering the
// full source span of each (the AST records only the start).
func (p *Project) modulesIn(f *File) []*ModuleDef {
	if f.Program == nil {
		return nil
	}
	var out []*ModuleDef
	for _, st := range f.Program.Statements {
		md, ok := st.(*ast.ModuleDeclStatement)
		if !ok {
			continue
		}
		start := f.Src.Offset(md.Token.Line, md.Token.Column)
		end := start
		if blk, ok := f.Src.matchBraceBlock(start); ok {
			end = blk.End
		} else {
			end = f.Src.findSemicolon(start)
		}

		def := &ModuleDef{
			Name:        md.Name,
			QualifiedAs: md.Name,
			Domain:      domainOf(md.Token.Type),
			File:        f.Path,
			Span:        f.Src.span(start, end),
			PhysPorts:   append([]string(nil), md.PhysPorts...),
			Doc:         leadingComment(f.Src, md.Token.Line),
			decl:        md,
		}
		for _, sa := range md.StaticArgs {
			sp := StaticParam{Name: sa.Name, Type: sa.Type.String()}
			if sa.Value != nil {
				sp.Default = sa.Value.String()
			}
			def.StaticParams = append(def.StaticParams, sp)
		}
		for _, la := range md.LogicArgs {
			def.LogicPorts = append(def.LogicPorts, LogicPort{
				Name: la.Name, Type: la.Type.String(), Direction: la.Direction,
			})
		}
		out = append(out, def)
	}
	return out
}

// leadingComment collects the contiguous `//` comment block immediately above
// a declaration, so the palette and inspector can show a module's own words
// rather than a generated description.
func leadingComment(src *Source, declLine int) string {
	var lines []string
	for l := declLine - 1; l >= 1; l-- {
		t := strings.TrimSpace(src.LineText(l))
		if t == "" && len(lines) == 0 {
			continue
		}
		if !strings.HasPrefix(t, "//") {
			break
		}
		body := strings.TrimSpace(strings.TrimPrefix(t, "//"))
		// Drop pure box-drawing / separator rules.
		if isRule(body) {
			if len(lines) > 0 {
				break
			}
			continue
		}
		lines = append([]string{body}, lines...)
	}
	return strings.TrimSpace(strings.Join(lines, " "))
}

func isRule(s string) bool {
	if s == "" {
		return true
	}
	for _, r := range s {
		switch r {
		case '─', '═', '-', '=', '━', '_', '*', '#', ' ':
		default:
			return false
		}
	}
	return true
}

// Module looks up a module by the name written at an instantiation site,
// which may be bare ("PMSM") or alias-qualified ("Motor.PMSM").
func (p *Project) Module(name string) (*ModuleDef, bool) {
	d, ok := p.modules[name]
	return d, ok
}

// Modules returns every visible module definition, sorted by name.
func (p *Project) Modules() []*ModuleDef {
	seen := map[*ModuleDef]bool{}
	var out []*ModuleDef
	for _, d := range p.modules {
		if !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].QualifiedAs < out[j].QualifiedAs })
	return out
}

// StructuralModules returns the modules the canvas can display as a sheet:
// structural harnesses and analog composites, which are the ones that
// actually wire sub-blocks together.
func (p *Project) StructuralModules() []*ModuleDef {
	var out []*ModuleDef
	for _, d := range p.Modules() {
		if d.Domain != DomainDigital {
			out = append(out, d)
		}
	}
	return out
}

// AllErrors merges load and per-file parse errors for display.
func (p *Project) AllErrors() []string {
	out := append([]string(nil), p.LoadErrors...)
	for _, path := range p.Order {
		f := p.Files[path]
		for _, e := range f.Errors {
			out = append(out, fmt.Sprintf("%s: %s", filepath.Base(path), e))
		}
	}
	return out
}

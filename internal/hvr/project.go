package hvr

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"hover/compiler/ast"
	"hover/compiler/lexer"
	"hover/compiler/parser"
	"hover/compiler/token"
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

// ResolvedImport is one `import` statement with its target resolved to a path.
type ResolvedImport struct {
	Alias    string
	Raw      string
	IsSystem bool
	Path     string
	Line     int
	Resolved bool
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
type Project struct {
	Entry      string
	Root       string
	StdlibRoot string

	Files map[string]*File
	Order []string

	// modules is the flat namespace the elaborator would build: the entry
	// file's own declarations plus every bare import's, keyed by name;
	// aliased imports are additionally keyed as "Alias.Name".
	modules map[string]*ModuleDef

	LoadErrors []string
}

// LoadProject parses entryPath and every file its imports reach.
//
// stdlibRoot resolves `import <...>`. The compiler locates it next to the
// hover binary via os.Executable(); hoverdeck is a different binary, so the
// caller supplies the path explicitly instead of inheriting a wrong default.
func LoadProject(entryPath, stdlibRoot string) (*Project, error) {
	abs, err := filepath.Abs(entryPath)
	if err != nil {
		return nil, fmt.Errorf("resolve entry path: %w", err)
	}
	abs = filepath.Clean(abs)

	p := &Project{
		Entry:      abs,
		Root:       filepath.Dir(abs),
		StdlibRoot: stdlibRoot,
		Files:      map[string]*File{},
		modules:    map[string]*ModuleDef{},
	}

	visiting := map[string]bool{}
	if err := p.loadFile(abs, visiting); err != nil {
		return nil, err
	}
	p.buildNamespace()
	return p, nil
}

func (p *Project) loadFile(path string, visiting map[string]bool) error {
	if visiting[path] {
		return nil // cycle — the compiler reports it; here we just stop descending
	}
	if _, done := p.Files[path]; done {
		return nil
	}
	visiting[path] = true
	defer delete(visiting, path)

	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}

	f := ParseSource(path, string(raw))
	p.Files[path] = f
	p.Order = append(p.Order, path)

	dir := filepath.Dir(path)
	for i := range f.Imports {
		imp := &f.Imports[i]
		imp.Path = p.resolveImport(dir, imp.Raw, imp.IsSystem)
		if _, statErr := os.Stat(imp.Path); statErr != nil {
			imp.Resolved = false
			p.LoadErrors = append(p.LoadErrors,
				fmt.Sprintf("%s:%d: cannot resolve import %q (looked for %s)",
					filepath.Base(path), imp.Line, imp.Raw, imp.Path))
			continue
		}
		imp.Resolved = true
		if err := p.loadFile(imp.Path, visiting); err != nil {
			p.LoadErrors = append(p.LoadErrors, err.Error())
		}
	}
	return nil
}

// resolveImport mirrors compiler/loader.resolveImportPath, with the stdlib
// root injected rather than derived from the running executable.
func (p *Project) resolveImport(currentDir, importPath string, isSystem bool) string {
	if isSystem && p.StdlibRoot != "" {
		rel := filepath.FromSlash(strings.TrimLeft(importPath, "/"))
		return filepath.Clean(filepath.Join(p.StdlibRoot, rel))
	}
	return filepath.Clean(filepath.Join(currentDir, importPath))
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
				f.Imports = append(f.Imports, ResolvedImport{
					Alias:    imp.Alias,
					Raw:      imp.Path,
					IsSystem: imp.IsSystem,
					Line:     imp.Token.Line,
				})
			}
		}
	}
	return f
}

// buildNamespace reproduces the elaborator's name resolution: the entry
// file's declarations, plus bare imports merged flat, plus aliased imports
// reachable only as "Alias.Name". Imports are non-transitive, so only the
// entry file's own import list is consulted.
func (p *Project) buildNamespace() {
	entry := p.Files[p.Entry]
	if entry == nil {
		return
	}

	for _, def := range p.modulesIn(entry) {
		p.modules[def.Name] = def
	}

	for _, imp := range entry.Imports {
		if !imp.Resolved {
			continue
		}
		f := p.Files[imp.Path]
		if f == nil {
			continue
		}
		for _, def := range p.modulesIn(f) {
			if imp.Alias != "" {
				q := imp.Alias + "." + def.Name
				def.QualifiedAs = q
				p.modules[q] = def
			} else if _, clash := p.modules[def.Name]; !clash {
				p.modules[def.Name] = def
			}
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

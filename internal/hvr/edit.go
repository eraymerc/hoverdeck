package hvr

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"hover/compiler/ast"
)

// Edits are deliberately narrow. hoverdeck never regenerates a .hvr from the
// AST — the compiler's Expression.String() is a normalising pretty-printer
// that would rewrite `-15` as `(-15)` and drop every comment in the file.
// Instead each edit replaces one exact byte span recovered from the source,
// so everything the user wrote outside that span survives untouched.

// ReplaceSpan swaps the text covered by span for newText and writes the file.
func ReplaceSpan(path string, span Span, newText string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	text := string(raw)
	if span.Start < 0 || span.End > len(text) || span.Start > span.End {
		return fmt.Errorf("edit span %d..%d is outside %s (%d bytes) — the file changed on disk; reload and retry",
			span.Start, span.End, filepath.Base(path), len(text))
	}
	out := text[:span.Start] + newText + text[span.End:]
	return WriteFile(path, out)
}

// WriteFile writes a file's full contents.
func WriteFile(path, text string) error {
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

var identRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// ValidateIdent checks a user-supplied net or instance name before it is
// written into source, so the GUI cannot produce a file that fails to lex.
func ValidateIdent(name string) error {
	if !identRe.MatchString(name) {
		return fmt.Errorf("%q is not a valid Hover identifier (letters, digits and _ only, not starting with a digit)", name)
	}
	if reservedWords[name] {
		return fmt.Errorf("%q is a reserved keyword", name)
	}
	return nil
}

var reservedWords = map[string]bool{
	"module": true, "analog": true, "digital": true, "func": true, "state": true,
	"if": true, "else": true, "while": true, "return": true, "input": true,
	"output": true, "import": true, "importc": true, "as": true, "extern": true,
	"wire": true, "double": true, "int": true, "float": true, "unsigned": true,
	"time": true, "dt": true,
}

// InsertRequest describes a block being dropped onto a sheet.
type InsertRequest struct {
	File       string `json:"file"`       // file holding the target module
	Module     string `json:"module"`     // qualified name of the sheet
	Kind       string `json:"kind"`       // "primitive" | "module"
	TypeName   string `json:"typeName"`   // "R" or "Diode"
	Alias      string `json:"alias"`      // import alias to use, "" for bare
	ImportPath string `json:"importPath"` // stdlib path, "" if none needed
	Instance   string `json:"instance"`   // desired instance name, "" to autogenerate
	Static     string `json:"static"`     // raw text for <...>
	Logic      string `json:"logic"`      // raw text for (...)
	Ports      []string `json:"ports"`    // net names for [...]
}

// InsertResult reports what changed.
type InsertResult struct {
	Line          int    `json:"line"`
	Text          string `json:"text"`
	ImportAdded   bool   `json:"importAdded"`
	InstanceName  string `json:"instanceName"`
}

// InsertBlock writes a new instantiation as the last statement of a module's
// body, adding the stdlib import first if the module's file does not already
// have one that makes the type visible.
func (p *Project) InsertBlock(req InsertRequest) (*InsertResult, error) {
	def, ok := p.Module(req.Module)
	if !ok {
		return nil, fmt.Errorf("module %q not found", req.Module)
	}
	f := p.Files[def.File]
	if f == nil {
		return nil, fmt.Errorf("source for %q not loaded", req.Module)
	}

	res := &InsertResult{}
	text := f.Src.Text

	// 1. Add the import first, if one is needed and not already present.
	//    Imports are resolved against the ENTRY file (they are non-transitive),
	//    so that is where a new one has to go — not necessarily the file the
	//    block is being inserted into.
	importTargetPath := p.Entry
	if req.Kind == "module" && req.ImportPath != "" {
		added, newEntryText, err := p.ensureImport(req.ImportPath, req.Alias)
		if err != nil {
			return nil, err
		}
		if added {
			res.ImportAdded = true
			if importTargetPath == def.File {
				// Same file: keep editing the updated text so the offsets
				// below are computed against what will actually be on disk.
				text = newEntryText
			} else {
				if err := WriteFile(importTargetPath, newEntryText); err != nil {
					return nil, err
				}
			}
		}
	}

	// 2. Re-derive the body span against the (possibly updated) text.
	src := NewSource(def.File, text)
	declStart := findModuleDecl(src, def.Name)
	if declStart < 0 {
		return nil, fmt.Errorf("could not locate module %s in %s after edit", def.Name, filepath.Base(def.File))
	}
	body, ok := src.matchBraceBlock(declStart)
	if !ok {
		return nil, fmt.Errorf("module %s has no body", def.Name)
	}

	// 3. Pick a non-colliding instance name.
	name := req.Instance
	if req.Kind == "module" {
		if name == "" {
			name = defaultInstanceName(req.TypeName)
		}
		if err := ValidateIdent(name); err != nil {
			return nil, err
		}
		name = uniqueName(name, p.usedNames(def))
		res.InstanceName = name
	}

	// 4. Build the statement.
	typeRef := req.TypeName
	if req.Alias != "" {
		typeRef = req.Alias + "." + req.TypeName
	}
	ports := strings.Join(req.Ports, ", ")

	var stmt string
	if req.Kind == "primitive" {
		stmt = fmt.Sprintf("%s<%s>(%s)[%s];", req.TypeName, req.Static, req.Logic, ports)
	} else {
		stmt = fmt.Sprintf("module %s = %s<%s>(%s)[%s];", name, typeRef, req.Static, req.Logic, ports)
	}

	// 5. Insert just before the body's closing brace, matching the
	//    indentation of the statements already in the body.
	indent := bodyIndent(src, body)
	insertAt := body.End - 1 // just before '}'

	prefix := ""
	if k := lastNonSpace(text, insertAt); k >= 0 && text[k] != '\n' {
		prefix = "\n"
	}
	// Trim the blank run before '}' so the new statement lands after the last
	// real statement rather than after the trailing blank line.
	trimFrom := insertAt
	for trimFrom > 0 && (text[trimFrom-1] == ' ' || text[trimFrom-1] == '\t') {
		trimFrom--
	}

	insertion := prefix + indent + stmt + "\n"
	out := text[:trimFrom] + insertion + text[trimFrom:]

	if err := WriteFile(def.File, out); err != nil {
		return nil, err
	}

	res.Text = stmt
	res.Line = NewSource(def.File, out).LineOf(trimFrom + len(prefix))
	return res, nil
}

// findModuleDecl locates the byte offset of a module declaration by name,
// used to re-anchor after the file text has been modified in the same call.
func findModuleDecl(src *Source, name string) int {
	re := regexp.MustCompile(`(?m)^[ \t]*(?:analog[ \t]+|digital[ \t]+)?module[ \t]+` + regexp.QuoteMeta(name) + `\b`)
	loc := re.FindStringIndex(src.Text)
	if loc == nil {
		return -1
	}
	return loc[0]
}

// bodyIndent guesses the indentation used inside a module body by copying
// the leading whitespace of its first non-blank line, falling back to four
// spaces for an empty body.
func bodyIndent(src *Source, body Span) string {
	startLine := src.LineOf(body.Start)
	endLine := src.LineOf(body.End - 1)
	for l := startLine + 1; l < endLine; l++ {
		t := src.LineText(l)
		if strings.TrimSpace(t) == "" {
			continue
		}
		return t[:len(t)-len(strings.TrimLeft(t, " \t"))]
	}
	return "    "
}

func lastNonSpace(text string, before int) int {
	for i := before - 1; i >= 0; i-- {
		if text[i] != ' ' && text[i] != '\t' {
			return i
		}
	}
	return -1
}

// usedNames collects every identifier already bound inside a module, so a
// generated instance name cannot shadow a net, signal or sibling instance.
func (p *Project) usedNames(def *ModuleDef) map[string]bool {
	used := map[string]bool{}
	for _, port := range def.PhysPorts {
		used[port] = true
	}
	for _, lp := range def.LogicPorts {
		used[lp.Name] = true
	}
	for _, sp := range def.StaticParams {
		used[sp.Name] = true
	}
	if def.decl == nil || def.decl.Body == nil {
		return used
	}
	for _, st := range def.decl.Body.Body {
		switch n := st.(type) {
		case *ast.ModuleInstStatement:
			used[n.InstanceName] = true
		case *ast.LocalDeclStatement:
			for _, d := range n.Decls {
				used[d.Name] = true
			}
		}
	}
	return used
}

func defaultInstanceName(typeName string) string {
	if typeName == "" {
		return "u1"
	}
	s := strings.ToLower(typeName)
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'a' && c <= 'z') || c == '_' || (c >= '0' && c <= '9' && b.Len() > 0) {
			b.WriteByte(c)
		}
	}
	out := b.String()
	if out == "" {
		return "u1"
	}
	return out
}

func uniqueName(base string, used map[string]bool) string {
	if !used[base] {
		return base
	}
	for i := 1; ; i++ {
		c := fmt.Sprintf("%s%d", base, i)
		if !used[c] {
			return c
		}
	}
}

// ensureImport makes importPath visible in the entry file, returning the
// updated entry text. It is a no-op when an equivalent import already exists.
func (p *Project) ensureImport(importPath, alias string) (added bool, text string, err error) {
	entry := p.Files[p.Entry]
	if entry == nil {
		return false, "", fmt.Errorf("entry file not loaded")
	}
	text = entry.Src.Text

	want := filepath.ToSlash(importPath)
	for _, imp := range entry.Imports {
		if filepath.ToSlash(imp.Raw) != want {
			continue
		}
		// Already imported. Only reuse it when the alias matches, otherwise
		// the type would not actually be reachable under the name we emit.
		if imp.Alias == alias {
			return false, text, nil
		}
	}

	stmt := fmt.Sprintf("import <%s>;", want)
	if alias != "" {
		stmt = fmt.Sprintf("import <%s> as %s;", want, alias)
	}

	insertAt := importInsertPoint(entry)
	out := text[:insertAt] + stmt + "\n" + text[insertAt:]
	return true, out, nil
}

// importInsertPoint returns the offset where a new import should go: right
// after the last existing import, else after the last top-level directive,
// else at the very top of the file.
func importInsertPoint(f *File) int {
	src := f.Src
	best := 0
	if f.Program != nil {
		for _, st := range f.Program.Statements {
			var line int
			switch n := st.(type) {
			case *ast.ImportStatement:
				line = n.Token.Line
			case *ast.ImportCStatement:
				line = n.Token.Line
			case *ast.DirectiveStatement:
				line = n.Token.Line
			default:
				continue
			}
			end := src.findSemicolon(src.Offset(line, 1))
			// advance past the rest of that line (trailing comment included)
			for end < len(src.Text) && src.Text[end] != '\n' {
				end++
			}
			if end < len(src.Text) {
				end++
			}
			if end > best {
				best = end
			}
		}
	}
	return best
}

// RenameNet replaces a net name across every port position it occupies in one
// module, plus its `wire` declaration. Spans are applied back-to-front so the
// earlier offsets stay valid as the text shifts.
func (p *Project) RenameNet(moduleQualified, oldName, newName string) (int, error) {
	if err := ValidateIdent(newName); err != nil {
		return 0, err
	}
	if oldName == "gnd" {
		return 0, fmt.Errorf("gnd is the built-in ground reference and cannot be renamed")
	}
	sheet, err := p.BuildSheet(moduleQualified)
	if err != nil {
		return 0, err
	}
	for _, n := range sheet.Nets {
		if n.Name == newName {
			return 0, fmt.Errorf("net %q already exists in this module", newName)
		}
	}

	var spans []Span
	for _, b := range sheet.Blocks {
		for _, pin := range b.Pins {
			if pin.Net == oldName {
				spans = append(spans, pin.Span)
			}
		}
	}
	if len(spans) == 0 {
		return 0, fmt.Errorf("net %q is not connected to anything in %s", oldName, moduleQualified)
	}

	f := p.Files[sheet.File]
	text := f.Src.Text

	// Rename the wire declaration too, if there is one.
	if declSpan, ok := findWireDeclIdent(f, sheet, oldName); ok {
		spans = append(spans, declSpan)
	}

	sortSpansDesc(spans)
	for _, sp := range spans {
		text = text[:sp.Start] + newName + text[sp.End:]
	}
	if err := WriteFile(sheet.File, text); err != nil {
		return 0, err
	}
	return len(spans), nil
}

// findWireDeclIdent locates the exact identifier inside a `wire a, b, c;`
// declaration so a rename updates the declaration as well as the uses.
func findWireDeclIdent(f *File, sheet *Sheet, name string) (Span, bool) {
	src := f.Src
	re := regexp.MustCompile(`\b` + regexp.QuoteMeta(name) + `\b`)
	for _, n := range sheet.Nets {
		if n.Name != name || !n.Declared {
			continue
		}
		start := src.Offset(n.DeclLine, 1)
		end := src.findSemicolon(start)
		loc := re.FindStringIndex(src.Text[start:end])
		if loc == nil {
			return Span{}, false
		}
		return src.span(start+loc[0], start+loc[1]), true
	}
	return Span{}, false
}

func sortSpansDesc(s []Span) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j].Start > s[j-1].Start; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// DeleteStatement removes one block's statement, including the whole line when
// nothing else shares it.
func DeleteStatement(path string, stmt Span) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	text := string(raw)
	if stmt.End > len(text) {
		return fmt.Errorf("stale span — reload and retry")
	}
	start, end := stmt.Start, stmt.End

	lineStart := start
	for lineStart > 0 && text[lineStart-1] != '\n' {
		lineStart--
	}
	if strings.TrimSpace(text[lineStart:start]) == "" {
		start = lineStart
	}
	for end < len(text) && text[end] != '\n' {
		if !isSpace(text[end]) {
			break
		}
		end++
	}
	if end < len(text) && text[end] == '\n' {
		end++
	}
	return WriteFile(path, text[:start]+text[end:])
}

func isSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\r' }

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"hoverdeck/internal/hvr"
	"hoverdeck/internal/plot"
)

// App is the bound API surface the frontend calls.
//
// The design rule throughout: the .hvr files on disk are the single source of
// truth. Every query re-reads and re-parses them, and every mutation is a
// narrow span replacement written straight back. There is no in-memory model
// that can drift from the file the compiler will actually read.
type App struct {
	ctx context.Context

	entry      string
	stdlibRoot string

	workspace   string
	project     *hvr.Project
	layout      *hvr.Layout
	settings    *Settings
	dataset     *plot.Dataset
	detectedBin string
	runner      Runner
}

// effectiveBin is the compiler to run: the configured one, or an auto-detected
// installation when the user has not chosen explicitly.
func (a *App) effectiveBin() string {
	if a.settings.HoverBin != "" {
		return a.settings.HoverBin
	}
	return a.detectedBin
}

func NewApp() *App { return &App{settings: &Settings{}} }

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.settings = LoadSettings()
	a.detectedBin = DetectHoverInstall(a.settings.EffectiveWorkDir(), os.Getenv("HOVER_HOME"))

	// Precedence: an explicit setting, then $HOVER_HOME, then the compiler's
	// own layout conventions relative to this binary.
	hint := a.settings.StdlibRoot
	if hint == "" {
		hint = os.Getenv("HOVER_HOME")
	}
	if hint == "" {
		hint = a.settings.EffectiveWorkDir()
	}
	a.stdlibRoot = hvr.FindStdlib(hint)

	// Opening a file passed on the command line makes `hoverdeck main.hvr`
	// behave like any other editor launch.
	opened := false
	for _, arg := range os.Args[1:] {
		if strings.HasSuffix(strings.ToLower(arg), ".hvr") {
			if _, err := a.OpenProject(arg); err == nil {
				opened = true
				break
			}
		}
	}
	if !opened && a.settings.LastFile != "" {
		_, _ = a.OpenProject(a.settings.LastFile)
	}
	if a.settings.LastFolder != "" {
		if st, e := os.Stat(a.settings.LastFolder); e == nil && st.IsDir() {
			a.workspace = a.settings.LastFolder
		}
	}
}

// ── Project state ────────────────────────────────────────────────────────────

// ProjectInfo is the top-level state the UI renders around.
type ProjectInfo struct {
	Entry      string             `json:"entry"`
	Root       string             `json:"root"`
	StdlibRoot string             `json:"stdlibRoot"`
	LayoutPath string             `json:"layoutPath"`
	Files      []FileInfo         `json:"files"`
	Modules    []*hvr.ModuleDef   `json:"modules"`
	Sheets     []SheetRef         `json:"sheets"`
	Errors     []string           `json:"errors"`
	Open       bool               `json:"open"`
}

// FileInfo is one source file in the project tree.
type FileInfo struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	IsEntry bool   `json:"isEntry"`
	IsStdlib bool  `json:"isStdlib"`
	Lines   int    `json:"lines"`
	Errors  int    `json:"errors"`
}

// SheetRef names a module that can be shown on the canvas.
type SheetRef struct {
	Qualified string `json:"qualified"`
	Name      string `json:"name"`
	Domain    string `json:"domain"`
	File      string `json:"file"`
	Blocks    int    `json:"blocks"`
	IsMain    bool   `json:"isMain"`
}

// OpenProject loads an entry .hvr and everything it imports.
func (a *App) OpenProject(path string) (*ProjectInfo, error) {
	if path == "" {
		return nil, fmt.Errorf("no file selected")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if a.stdlibRoot == "" {
		a.stdlibRoot = hvr.FindStdlib(filepath.Dir(abs))
	}
	p, err := hvr.LoadProject(abs, a.stdlibRoot)
	if err != nil {
		return nil, err
	}
	a.entry = abs
	a.project = p
	a.layout = hvr.LoadLayout(abs)

	if a.settings.LastFile != abs {
		a.settings.LastFile = abs
		_ = a.settings.Save()
	}
	return a.info(), nil
}

// Reload re-reads every file from disk, picking up external edits.
func (a *App) Reload() (*ProjectInfo, error) {
	if a.entry == "" {
		return &ProjectInfo{Open: false}, nil
	}
	p, err := hvr.LoadProject(a.entry, a.stdlibRoot)
	if err != nil {
		return nil, err
	}
	a.project = p
	return a.info(), nil
}

// Info returns current project state without re-reading.
func (a *App) Info() *ProjectInfo { return a.info() }

func (a *App) info() *ProjectInfo {
	if a.project == nil {
		return &ProjectInfo{Open: false, StdlibRoot: a.stdlibRoot}
	}
	p := a.project
	pi := &ProjectInfo{
		Entry:      p.Entry,
		Root:       p.Root,
		StdlibRoot: p.StdlibRoot,
		LayoutPath: hvr.LayoutPath(p.Entry),
		Errors:     p.AllErrors(),
		Modules:    p.Modules(),
		Open:       true,
	}

	for _, path := range p.Order {
		f := p.Files[path]
		pi.Files = append(pi.Files, FileInfo{
			Path:     path,
			Name:     filepath.Base(path),
			IsEntry:  path == p.Entry,
			IsStdlib: p.StdlibRoot != "" && strings.HasPrefix(path, p.StdlibRoot),
			Lines:    f.Src.LineCount(),
			Errors:   len(f.Errors),
		})
	}

	for _, d := range p.StructuralModules() {
		n := 0
		if sh, err := p.BuildSheet(d.QualifiedAs); err == nil {
			n = len(sh.Blocks)
		}
		pi.Sheets = append(pi.Sheets, SheetRef{
			Qualified: d.QualifiedAs,
			Name:      d.Name,
			Domain:    d.Domain,
			File:      d.File,
			Blocks:    n,
			IsMain:    d.Name == "main",
		})
	}
	sort.SliceStable(pi.Sheets, func(i, j int) bool {
		if pi.Sheets[i].IsMain != pi.Sheets[j].IsMain {
			return pi.Sheets[i].IsMain
		}
		return pi.Sheets[i].Qualified < pi.Sheets[j].Qualified
	})
	return pi
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

// PickProject opens a native file dialog and loads the chosen .hvr.
func (a *App) PickProject() (*ProjectInfo, error) {
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Open a Hover source file",
		Filters: []runtime.FileFilter{
			{DisplayName: "Hover source (*.hvr)", Pattern: "*.hvr"},
		},
	})
	if err != nil {
		return nil, err
	}
	if path == "" {
		return a.info(), nil
	}
	return a.OpenProject(path)
}

// ── Sheets ───────────────────────────────────────────────────────────────────

// GetSheet builds the diagram for one module, with saved layout applied.
func (a *App) GetSheet(qualified string) (*hvr.Sheet, error) {
	if a.project == nil {
		return nil, fmt.Errorf("no project open")
	}
	sh, err := a.project.BuildSheet(qualified)
	if err != nil {
		return nil, err
	}
	a.layout.Apply(sh)
	return sh, nil
}

// SetBlockPosition saves a block's position after a drag.
func (a *App) SetBlockPosition(module, blockID string, x, y float64) error {
	if a.layout == nil {
		return fmt.Errorf("no project open")
	}
	a.layout.SetBlockPos(module, blockID, x, y)
	return a.layout.Save(a.entry)
}

// SetSignalPosition saves a signal / state-variable chip's position.
func (a *App) SetSignalPosition(module, name string, x, y float64) error {
	if a.layout == nil {
		return fmt.Errorf("no project open")
	}
	a.layout.SetChipPos(module, name, x, y)
	return a.layout.Save(a.entry)
}

// SetBlockIcon overrides the symbol drawn for a block.
func (a *App) SetBlockIcon(module, blockID, icon string) error {
	if a.layout == nil {
		return fmt.Errorf("no project open")
	}
	a.layout.SetBlockIcon(module, blockID, icon)
	return a.layout.Save(a.entry)
}

// SetNetColor assigns a highlight colour to a net.
func (a *App) SetNetColor(module, net, color string) error {
	if a.layout == nil {
		return fmt.Errorf("no project open")
	}
	a.layout.SetNetColor(module, net, color)
	return a.layout.Save(a.entry)
}

// ── Source access ────────────────────────────────────────────────────────────

// SourceFile is a file's text plus its parse diagnostics.
type SourceFile struct {
	Path   string   `json:"path"`
	Name   string   `json:"name"`
	Text   string   `json:"text"`
	Errors []string `json:"errors"`
	ReadOnly bool   `json:"readOnly"`
}

// ReadFile returns one source file's current text.
func (a *App) ReadFile(path string) (*SourceFile, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	sf := &SourceFile{Path: path, Name: filepath.Base(path), Text: string(raw)}
	if a.project != nil {
		if f, ok := a.project.Files[path]; ok {
			sf.Errors = f.Errors
		}
		// Standard-library files open read-only by default: editing the shared
		// library from a circuit window is almost always a mistake.
		sf.ReadOnly = a.project.StdlibRoot != "" && strings.HasPrefix(path, a.project.StdlibRoot)
	}
	return sf, nil
}

// SaveFile writes a file's full text back and re-parses the project.
func (a *App) SaveFile(path, text string) (*ProjectInfo, error) {
	if err := hvr.WriteFile(path, text); err != nil {
		return nil, err
	}
	return a.Reload()
}

// CheckSyntax parses text without writing it, for live diagnostics while typing.
func (a *App) CheckSyntax(path, text string) []string {
	f := hvr.ParseSource(path, text)
	return f.Errors
}

// ── Catalog ──────────────────────────────────────────────────────────────────

// Catalog is everything droppable onto a sheet.
type Catalog struct {
	Primitives []hvr.PrimitiveDef  `json:"primitives"`
	Stdlib     []hvr.CatalogEntry  `json:"stdlib"`
	Local      []hvr.CatalogEntry  `json:"local"`
}

// GetCatalog returns the built-in primitives, the standard library, and the
// modules declared in the open project itself.
func (a *App) GetCatalog() *Catalog {
	c := &Catalog{Primitives: hvr.Primitives()}
	c.Stdlib = hvr.ScanStdlib(a.stdlibRoot)

	if a.project != nil {
		for _, d := range a.project.Modules() {
			if a.project.StdlibRoot != "" && strings.HasPrefix(d.File, a.project.StdlibRoot) {
				continue
			}
			c.Local = append(c.Local, hvr.CatalogEntry{
				Kind:         "module",
				Name:         d.Name,
				Icon:         hvr.IconFor(d.Name, d.Domain),
				Domain:       d.Domain,
				Desc:         d.Doc,
				Group:        filepath.Base(d.File),
				PhysPorts:    d.PhysPorts,
				StaticParams: d.StaticParams,
				LogicPorts:   d.LogicPorts,
				File:         d.File,
			})
		}
	}
	return c
}

// ── Mutations ────────────────────────────────────────────────────────────────

// InsertBlock adds an instantiation to a module and returns the new project state.
func (a *App) InsertBlock(req hvr.InsertRequest) (*hvr.InsertResult, error) {
	if a.project == nil {
		return nil, fmt.Errorf("no project open")
	}
	res, err := a.project.InsertBlock(req)
	if err != nil {
		return nil, err
	}
	if _, err := a.Reload(); err != nil {
		return nil, err
	}
	return res, nil
}

// SetSpanText replaces one exact span — used for editing a port's net, a
// parameter value or a driven source's control signal in place.
func (a *App) SetSpanText(path string, span hvr.Span, text string) error {
	if strings.TrimSpace(text) == "" {
		return fmt.Errorf("value cannot be empty")
	}
	if err := hvr.ReplaceSpan(path, span, text); err != nil {
		return err
	}
	_, err := a.Reload()
	return err
}

// SetPortNet points one port of one block at a different net.
func (a *App) SetPortNet(path string, span hvr.Span, net string) error {
	if err := hvr.ValidateIdent(net); err != nil {
		return err
	}
	return a.SetSpanText(path, span, net)
}

// RenameNet renames a net everywhere it appears within one module.
func (a *App) RenameNet(module, oldName, newName string) (int, error) {
	if a.project == nil {
		return 0, fmt.Errorf("no project open")
	}
	n, err := a.project.RenameNet(module, oldName, newName)
	if err != nil {
		return 0, err
	}
	if _, err := a.Reload(); err != nil {
		return n, err
	}
	return n, nil
}

// DeleteBlock removes a block's statement from its file.
func (a *App) DeleteBlock(path string, stmt hvr.Span) error {
	if err := hvr.DeleteStatement(path, stmt); err != nil {
		return err
	}
	_, err := a.Reload()
	return err
}

// ── Compiler ─────────────────────────────────────────────────────────────────

// GetSettings returns the stored settings plus derived health checks.
func (a *App) GetSettings() *SettingsView {
	return a.settings.view(a.detectedBin)
}

// SaveSettings stores the compiler location and reloads the project so a new
// standard library takes effect immediately.
func (a *App) SaveSettings(hoverBin, workDir, stdlibRoot string) (*SettingsView, error) {
	a.settings.HoverBin = strings.TrimSpace(hoverBin)
	a.settings.WorkDir = strings.TrimSpace(workDir)
	a.settings.StdlibRoot = strings.TrimSpace(stdlibRoot)
	if err := a.settings.Save(); err != nil {
		return nil, err
	}

	hint := a.settings.StdlibRoot
	if hint == "" {
		hint = a.settings.EffectiveWorkDir()
	}
	if found := hvr.FindStdlib(hint); found != "" {
		a.stdlibRoot = found
	}
	if a.entry != "" {
		if _, err := a.Reload(); err != nil {
			return a.settings.view(a.detectedBin), err
		}
	}
	return a.settings.view(a.detectedBin), nil
}

// PickHoverBinary opens a file dialog for the compiler executable.
func (a *App) PickHoverBinary() (*SettingsView, error) {
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Locate the hover compiler executable",
	})
	if err != nil {
		return nil, err
	}
	if path == "" {
		return a.settings.view(a.detectedBin), nil
	}
	if !looksLikeHoverBinary(path) {
		// Not fatal — the binary may legitimately be renamed — but worth saying.
		defer func() {
			runtime.EventsEmit(a.ctx, "run:line",
				"note: selected file is not named 'hover'; make sure it is the compiler")
		}()
	}
	return a.SaveSettings(path, a.settings.WorkDir, a.settings.StdlibRoot)
}

// PickWorkDir chooses the directory the compiler runs in.
func (a *App) PickWorkDir() (*SettingsView, error) {
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Working directory for the compiler (the hover checkout root)",
	})
	if err != nil {
		return nil, err
	}
	if dir == "" {
		return a.settings.view(a.detectedBin), nil
	}
	return a.SaveSettings(a.settings.HoverBin, dir, a.settings.StdlibRoot)
}

// Run compiles and simulates the open project with the configured compiler.
// Output is streamed to the frontend as `run:line` events.
func (a *App) Run() error {
	if a.entry == "" {
		return fmt.Errorf("no project open")
	}
	return a.runner.Start(a, a.entry)
}

// StopRun terminates the current run and everything it spawned.
func (a *App) StopRun() error { return a.runner.Stop() }

// IsRunning reports whether a compile/simulation is in flight.
func (a *App) IsRunning() bool { return a.runner.Running() }

// SetNetTrunk pins the vertical routing channel of a net to an x position,
// letting the user pull a wire clear of whatever it was overlapping.
func (a *App) SetNetTrunk(module, net string, x, dy float64) error {
	if a.layout == nil {
		return fmt.Errorf("no project open")
	}
	a.layout.SetNetTrunk(module, net, x, dy)
	return a.layout.Save(a.entry)
}

// SetBlockTransform rotates and/or mirrors a block on the canvas. This is
// presentation only — the netlist is unchanged.
func (a *App) SetBlockTransform(module, blockID string, rot int, flipX, flipY bool) error {
	if a.layout == nil {
		return fmt.Errorf("no project open")
	}
	a.layout.SetBlockTransform(module, blockID, rot, flipX, flipY)
	return a.layout.Save(a.entry)
}

// ClearNetTrunk returns a net to automatic routing.
func (a *App) ClearNetTrunk(module, net string) error {
	if a.layout == nil {
		return fmt.Errorf("no project open")
	}
	a.layout.ClearNetTrunk(module, net)
	return a.layout.Save(a.entry)
}

// SetStdlibRoot points hoverdeck at a different standard library.
func (a *App) SetStdlibRoot(path string) (*ProjectInfo, error) {
	resolved := hvr.FindStdlib(path)
	if resolved == "" {
		return nil, fmt.Errorf("no standard_library found under %s", path)
	}
	a.stdlibRoot = resolved
	if a.entry == "" {
		return a.info(), nil
	}
	return a.Reload()
}

// PickStdlibRoot asks for a hover checkout or standard_library directory.
func (a *App) PickStdlibRoot() (*ProjectInfo, error) {
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Locate the Hover standard_library directory",
	})
	if err != nil {
		return nil, err
	}
	if dir == "" {
		return a.info(), nil
	}
	return a.SetStdlibRoot(dir)
}

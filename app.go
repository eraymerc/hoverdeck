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

	entry string

	// packages is the import table the open project resolves against. It is
	// rebuilt whenever the entry file changes, because which packages a file
	// can see depends on whether it sits inside a project with its own
	// hover.lock — see hvr.ResolvePackages.
	packages *hvr.Packages

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
	a.refreshPackages()

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

// refreshPackages rebuilds the import table for whatever is currently open.
//
// It is not cached across files on purpose: since 0.8 the answer to "what can
// this file import?" depends on where the file is. Inside a project it is that
// project's hover.lock plus the machine's standard library; outside one it is
// everything installed machine-wide. Opening a file in a different project has
// to change the answer, or the palette offers modules the compiler will refuse.
func (a *App) refreshPackages() {
	a.packages = hvr.ResolvePackages(a.entry, a.effectiveBin())
}

// ── Project state ────────────────────────────────────────────────────────────

// ProjectInfo is the top-level state the UI renders around.
type ProjectInfo struct {
	Entry      string           `json:"entry"`
	Root       string           `json:"root"`
	Packages   *hvr.Packages    `json:"packages"`
	LayoutPath string           `json:"layoutPath"`
	Files      []FileInfo       `json:"files"`
	Modules    []*hvr.ModuleDef `json:"modules"`
	Sheets     []SheetRef       `json:"sheets"`
	Errors     []string         `json:"errors"`
	Open       bool             `json:"open"`
}

// FileInfo is one source file in the project tree.
type FileInfo struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	IsEntry bool   `json:"isEntry"`

	// Package names the installed package a file came from, "" for the
	// user's own source. Library files open read-only: an installed package
	// lives in a content-addressed cache shared by every project on the
	// machine that resolved to the same hash.
	Package string `json:"package"`

	Lines  int `json:"lines"`
	Errors int `json:"errors"`
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
	pkgs := hvr.ResolvePackages(abs, a.effectiveBin())
	p, err := hvr.LoadProject(abs, pkgs)
	if err != nil {
		return nil, err
	}
	a.entry = abs
	a.packages = pkgs
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
	// The lockfile is re-read too: `hover hpm install` in a terminal alongside
	// hoverdeck is the normal way to add a package, and Reload is how that
	// becomes visible here.
	a.refreshPackages()
	p, err := hvr.LoadProject(a.entry, a.packages)
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
		return &ProjectInfo{Open: false, Packages: a.packages}
	}
	p := a.project
	pi := &ProjectInfo{
		Entry:      p.Entry,
		Root:       p.Root,
		Packages:   p.Packages,
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
			IsEntry: path == p.Entry,
			Package: p.Packages.PackageOf(path),
			Lines:   f.Src.LineCount(),
			Errors:  len(f.Errors),
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
	// After Apply: the sidecar may override a block's icon, and the symbol
	// that has to fit is the one that will actually be drawn.
	hvr.FitSymbols(sh, hvr.BuiltinSymbols())
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
		// Package sources open read-only: they live in a content-addressed
		// cache shared by every project on this machine that resolved to the
		// same hash, so editing one from a circuit window would silently
		// change other people's builds as well as this one.
		sf.ReadOnly = a.project.Packages.Owns(path)
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
	Primitives []hvr.PrimitiveDef `json:"primitives"`

	// Stdlib holds every installed package's modules, not only the standard
	// library's — since 0.8 they arrive through one package table and are
	// dropped onto a sheet the same way. The name is kept because it is what
	// the palette section is called.
	Stdlib []hvr.CatalogEntry `json:"stdlib"`
	Local  []hvr.CatalogEntry `json:"local"`

	// Symbols is every schematic symbol the canvas can draw, by id. It rides
	// along with the catalog because it is reloaded at the same moments, and
	// symbols shipped by packages will arrive through the same package table.
	Symbols []*hvr.Symbol `json:"symbols"`
}

// GetCatalog returns the built-in primitives, every installed package, and the
// modules declared in the open project itself.
func (a *App) GetCatalog() *Catalog {
	c := &Catalog{Primitives: hvr.Primitives(), Symbols: hvr.BuiltinSymbols().All()}
	c.Stdlib = hvr.ScanPackages(a.packages)

	if a.project != nil {
		for _, d := range a.project.Modules() {
			if a.project.Packages.Owns(d.File) {
				continue
			}
			// A local module reached through a relative import is only visible
			// behind that import's qualifier, so the palette carries it and
			// the inserted statement writes `parts.Widget`. One declared in
			// the entry file's own directory has no qualifier at all — since
			// 0.8, siblings share a namespace with no import involved.
			qualifier := ""
			if i := strings.LastIndex(d.QualifiedAs, "."); i >= 0 {
				qualifier = d.QualifiedAs[:i]
			}
			c.Local = append(c.Local, hvr.CatalogEntry{
				Kind:         "module",
				Name:         d.Name,
				Icon:         hvr.IconFor(d.Name, d.Domain, d.File),
				Domain:       d.Domain,
				Desc:         d.Doc,
				Group:        filepath.Base(d.File),
				Qualifier:    qualifier,
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

// runDir is the directory a compile happens in.
//
// The project's own directory, unless overridden. Until 0.8 this had to be the
// hover install root — the CLI resolved ./runtime and ./toolchain/zig from the
// working directory, so running anywhere else failed at the link step. 0.8
// anchors those to the compiler executable instead, which frees the working
// directory to be the one the user means: sim.cpp, sim and
// simulation_output.csv now land beside the circuit that produced them.
func (a *App) runDir() string {
	if a.settings != nil && a.settings.WorkDir != "" {
		return a.settings.WorkDir
	}
	if a.entry != "" {
		return filepath.Dir(a.entry)
	}
	if a.settings != nil {
		return a.settings.EffectiveWorkDir()
	}
	return ""
}

// GetSettings returns the stored settings plus derived health checks.
func (a *App) GetSettings() *SettingsView {
	return a.settings.view(a.detectedBin, a.runDir(), a.packages)
}

// SaveSettings stores the compiler location and reloads the project, so a
// different installation's standard library takes effect immediately.
func (a *App) SaveSettings(hoverBin, workDir string) (*SettingsView, error) {
	a.settings.HoverBin = strings.TrimSpace(hoverBin)
	a.settings.WorkDir = strings.TrimSpace(workDir)
	if err := a.settings.Save(); err != nil {
		return nil, err
	}

	a.refreshPackages()
	if a.entry != "" {
		if _, err := a.Reload(); err != nil {
			return a.GetSettings(), err
		}
	}
	return a.GetSettings(), nil
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
		return a.GetSettings(), nil
	}
	if !looksLikeHoverBinary(path) {
		// Not fatal — the binary may legitimately be renamed — but worth saying.
		defer func() {
			runtime.EventsEmit(a.ctx, "run:line",
				"note: selected file is not named 'hover'; make sure it is the compiler")
		}()
	}
	return a.SaveSettings(path, a.settings.WorkDir)
}

// PickWorkDir overrides the directory the compiler runs in. Leaving it unset
// is normal — the project's own directory is the default.
func (a *App) PickWorkDir() (*SettingsView, error) {
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Working directory for the compiler (leave unset to use the project folder)",
	})
	if err != nil {
		return nil, err
	}
	if dir == "" {
		return a.GetSettings(), nil
	}
	return a.SaveSettings(a.settings.HoverBin, dir)
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

// SetLegOffset moves one leg of a net vertically, independent of its other
// legs. legKey identifies the leg as "blockID:pinIndex" (see hvr.LegKey).
func (a *App) SetLegOffset(module, net, legKey string, dy float64) error {
	if a.layout == nil {
		return fmt.Errorf("no project open")
	}
	a.layout.SetLegDY(module, net, legKey, dy)
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

// ── Packages ─────────────────────────────────────────────────────────────────
//
// There is no "point hoverdeck at a standard library" any more, and that is
// the point: 0.8 made the standard library an ordinary installed package, so
// where it lives is `hover --setup`'s answer and hoverdeck reads the same
// lockfiles the compiler does. What replaces the old picker is the ability to
// run the two commands that change that answer.

// GetPackages returns the import table the open project resolves against.
func (a *App) GetPackages() *hvr.Packages {
	if a.packages == nil {
		a.refreshPackages()
	}
	return a.packages
}

// RunSetup runs `hover --setup`, which builds the C++ runtime and downloads
// the standard library into ~/.hover. Output streams to the console like a
// run; the project reloads when it finishes.
func (a *App) RunSetup() error { return a.runner.Setup(a) }

// RunHPM runs `hover hpm <args...>` in the project directory — install,
// update, remove, list, verify, index, clean.
func (a *App) RunHPM(args []string) error { return a.runner.HPM(a, args) }

// RefreshPackages re-reads the lockfiles and reloads the project. Called after
// a setup or hpm command finishes, and by the UI's refresh action, since a
// package may equally have been installed from a terminal alongside hoverdeck.
func (a *App) RefreshPackages() (*ProjectInfo, error) {
	a.refreshPackages()
	if a.entry == "" {
		return a.info(), nil
	}
	return a.Reload()
}

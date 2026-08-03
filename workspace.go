package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// A workspace is a folder opened as a tree, the way an editor opens a project
// directory. It is independent of the *entry* file that drives the diagram:
// you can browse a whole folder and then pick which .hvr is the circuit.

// TreeNode is one entry in the workspace tree.
//
// Children is left empty for directories: the tree is expanded lazily through
// ListDir. HasChildren says whether an expand arrow is worth drawing.
type TreeNode struct {
	Name        string     `json:"name"`
	Path        string     `json:"path"`
	IsDir       bool       `json:"isDir"`
	IsHVR       bool       `json:"isHVR"`
	IsCSV       bool       `json:"isCSV"`
	IsEntry     bool       `json:"isEntry"`
	HasChildren bool       `json:"hasChildren"`
	Children    []TreeNode `json:"children"`
}

// Workspace is the opened folder and its tree.
type Workspace struct {
	Root string     `json:"root"`
	Name string     `json:"name"`
	Tree []TreeNode `json:"tree"`
	Open bool       `json:"open"`
}

// skipDir lists directories never worth showing in a circuit workspace.
var skipDir = map[string]bool{
	".git": true, "node_modules": true, ".idea": true, ".vscode": true,
	"__pycache__": true, ".cache": true,
}

// OpenFolder opens a directory as the workspace.
//
// If the folder contains a main.hvr (at the top level, else anywhere) and no
// circuit is open yet, it is loaded as the entry so the canvas has something
// to show immediately.
func (a *App) OpenFolder(path string) (*Workspace, error) {
	if path == "" {
		return nil, fmt.Errorf("no folder selected")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(abs)
	if err != nil || !st.IsDir() {
		return nil, fmt.Errorf("%s is not a folder", abs)
	}

	a.workspace = abs
	if a.settings.LastFolder != abs {
		a.settings.LastFolder = abs
		_ = a.settings.Save()
	}

	// Auto-open a circuit so the window is not empty on first launch.
	if a.entry == "" || !strings.HasPrefix(a.entry, abs) {
		if entry := findEntryCandidate(abs); entry != "" {
			_, _ = a.OpenProject(entry)
		}
	}
	return a.WorkspaceTree(), nil
}

// PickFolder opens a directory chooser and opens the result as the workspace.
func (a *App) PickFolder() (*Workspace, error) {
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Open a folder",
	})
	if err != nil {
		return nil, err
	}
	if dir == "" {
		return a.WorkspaceTree(), nil
	}
	return a.OpenFolder(dir)
}

// WorkspaceTree returns the workspace with only its top level listed.
//
// Directories are listed lazily, one level at a time via ListDir. Reading the
// whole tree up front is what made a large folder feel frozen: a deep project
// meant thousands of stat calls before anything appeared, and every one of
// those entries then became a DOM node the browser had to lay out, even though
// almost all of them were inside folders the user never opened.
func (a *App) WorkspaceTree() *Workspace {
	if a.workspace == "" {
		return &Workspace{Open: false}
	}
	return &Workspace{
		Root: a.workspace,
		Name: filepath.Base(a.workspace),
		Open: true,
		Tree: a.readDir(a.workspace),
	}
}

// ListDir returns the immediate children of one directory, for expanding a
// node in the tree.
func (a *App) ListDir(dir string) ([]TreeNode, error) {
	if dir == "" {
		return nil, fmt.Errorf("no directory given")
	}
	st, err := os.Stat(dir)
	if err != nil || !st.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", dir)
	}
	return a.readDir(dir), nil
}

// readDir lists one directory without recursing. HasChildren tells the UI
// whether to draw an expand arrow, which costs one cheap read per subdirectory
// instead of a full recursive walk.
func (a *App) readDir(dir string) []TreeNode {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	var dirs, files []TreeNode
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") || skipDir[name] {
			continue
		}
		full := filepath.Join(dir, name)

		if e.IsDir() {
			dirs = append(dirs, TreeNode{
				Name:        name,
				Path:        full,
				IsDir:       true,
				HasChildren: dirHasEntries(full),
			})
			continue
		}
		files = append(files, TreeNode{
			Name:    name,
			Path:    full,
			IsHVR:   strings.EqualFold(filepath.Ext(name), ".hvr"),
			IsCSV:   strings.EqualFold(filepath.Ext(name), ".csv"),
			IsEntry: full == a.entry,
		})
	}

	sort.Slice(dirs, func(i, j int) bool { return strings.ToLower(dirs[i].Name) < strings.ToLower(dirs[j].Name) })
	sort.Slice(files, func(i, j int) bool { return strings.ToLower(files[i].Name) < strings.ToLower(files[j].Name) })
	return append(dirs, files...)
}

// dirHasEntries reports whether a directory holds anything the tree would
// show, reading at most a handful of entries rather than the whole listing.
func dirHasEntries(dir string) bool {
	f, err := os.Open(dir)
	if err != nil {
		return false
	}
	defer f.Close()
	for {
		names, err := f.Readdirnames(32)
		if len(names) == 0 || err != nil {
			return false
		}
		for _, n := range names {
			if !strings.HasPrefix(n, ".") && !skipDir[n] {
				return true
			}
		}
	}
}

// CloseFolder forgets the workspace without touching the open circuit.
func (a *App) CloseFolder() *Workspace {
	a.workspace = ""
	a.settings.LastFolder = ""
	_ = a.settings.Save()
	return &Workspace{Open: false}
}

// findEntryCandidate picks the most likely circuit file in a folder: a
// top-level main.hvr, else any main.hvr, else the only .hvr present.
func findEntryCandidate(root string) string {
	if p := filepath.Join(root, "main.hvr"); fileExists(p) {
		return p
	}
	var hvrs []string
	var nestedMain string
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if strings.HasPrefix(d.Name(), ".") || skipDir[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.EqualFold(filepath.Ext(d.Name()), ".hvr") {
			hvrs = append(hvrs, p)
			if strings.EqualFold(d.Name(), "main.hvr") && nestedMain == "" {
				nestedMain = p
			}
		}
		return nil
	})
	if nestedMain != "" {
		return nestedMain
	}
	if len(hvrs) == 1 {
		return hvrs[0]
	}
	return ""
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// ── Creating things ──────────────────────────────────────────────────────────

// validEntryName rejects names that would escape the target directory or
// collide with path syntax.
func validEntryName(name string) error {
	n := strings.TrimSpace(name)
	if n == "" {
		return fmt.Errorf("name cannot be empty")
	}
	if n == "." || n == ".." {
		return fmt.Errorf("%q is not a usable name", n)
	}
	if strings.ContainsAny(n, `/\`) {
		return fmt.Errorf("name cannot contain a path separator")
	}
	if strings.ContainsAny(n, `:*?"<>|`) {
		return fmt.Errorf(`name cannot contain : * ? " < > |`)
	}
	return nil
}

// CreateFile makes a new file inside dir and returns its path.
//
// A new .hvr is seeded with a small skeleton so it parses immediately rather
// than opening as an empty buffer that the compiler would reject.
func (a *App) CreateFile(dir, name string) (string, error) {
	if err := validEntryName(name); err != nil {
		return "", err
	}
	if dir == "" {
		dir = a.defaultDir()
	}
	if dir == "" {
		return "", fmt.Errorf("no folder open — use Open Folder first")
	}

	n := strings.TrimSpace(name)
	// Typing "filter" in a circuit workspace almost certainly means filter.hvr.
	if filepath.Ext(n) == "" {
		n += ".hvr"
	}
	full := filepath.Join(dir, n)
	if _, err := os.Stat(full); err == nil {
		return "", fmt.Errorf("%s already exists", n)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(full, []byte(newFileTemplate(n)), 0o644); err != nil {
		return "", err
	}
	return full, nil
}

// CreateFolder makes a new directory inside dir.
func (a *App) CreateFolder(dir, name string) (string, error) {
	if err := validEntryName(name); err != nil {
		return "", err
	}
	if dir == "" {
		dir = a.defaultDir()
	}
	if dir == "" {
		return "", fmt.Errorf("no folder open — use Open Folder first")
	}
	full := filepath.Join(dir, strings.TrimSpace(name))
	if _, err := os.Stat(full); err == nil {
		return "", fmt.Errorf("%s already exists", name)
	}
	if err := os.MkdirAll(full, 0o755); err != nil {
		return "", err
	}
	return full, nil
}

// defaultDir is where new items go when no folder is selected: the workspace
// root, else the directory of the open circuit.
func (a *App) defaultDir() string {
	if a.workspace != "" {
		return a.workspace
	}
	if a.entry != "" {
		return filepath.Dir(a.entry)
	}
	return ""
}

// newFileTemplate returns starter content for a newly created file.
func newFileTemplate(name string) string {
	if !strings.EqualFold(filepath.Ext(name), ".hvr") {
		return ""
	}
	base := strings.TrimSuffix(filepath.Base(name), filepath.Ext(name))

	// Only a file actually named main.hvr gets the top-level module and the
	// simulation directives; anything else is a component file, where a
	// second `main` would collide at elaboration.
	if strings.EqualFold(base, "main") {
		return `.tran(0, 10m, 1u);
.solver(bdf2);
.save(main.out);

module main<>() []
{
    wire in, out;

    voltage_source<5>()[in, gnd];
    R<1k>()[in, out];
    C<1u>()[out, gnd];
}
`
	}
	return fmt.Sprintf(`// %s

analog module %s<double gain>() [wire in, wire out]
{
    R<gain>()[in, out];
}
`, filepath.Base(name), sanitizeModuleName(base))
}

// sanitizeModuleName turns a file name into a usable Hover identifier.
func sanitizeModuleName(s string) string {
	var b strings.Builder
	for i, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r == '_':
			b.WriteRune(r)
		case r >= '0' && r <= '9' && i > 0:
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	out := b.String()
	if out == "" {
		return "Component"
	}
	return out
}
